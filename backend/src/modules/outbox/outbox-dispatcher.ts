import { Prisma } from "@prisma/client";
import { prisma } from "../../config/database";
import type { EmailJobData } from "../../queues/email.queue";
import type { RateLimitNotificationJobData } from "../../queues/notification.queue";
import type { EmailIndexJobData } from "../../queues/search.queue";

export interface ClaimedOutboxEvent {
  id: string;
  eventType: string;
  payload: Prisma.JsonValue;
  attempts: number;
}

export interface OutboxRepository {
  claimBatch(limit: number): Promise<ClaimedOutboxEvent[]>;
  markPublished(id: string): Promise<void>;
  releaseForRetry(id: string, message: string, delayMs: number): Promise<void>;
  markFailed(id: string, message: string): Promise<void>;
}

export interface EmailJobPublisher {
  publish(emailId: string, scheduledAt: Date, jobId?: string): Promise<void>;
}

export interface NotificationJobPublisher {
  publish(rateLimitEventId: string): Promise<void>;
}

export interface SearchJobPublisher {
  publish(emailId: string, outboxEventId: string): Promise<void>;
}

export class PrismaOutboxRepository implements OutboxRepository {
  async claimBatch(limit: number): Promise<ClaimedOutboxEvent[]> {
    return prisma.$transaction((tx) => tx.$queryRaw<ClaimedOutboxEvent[]>(Prisma.sql`
      WITH claimable AS (
        SELECT id
        FROM outbox_events
        WHERE (
          (status = 'PENDING'::"OutboxStatus" AND available_at <= NOW())
          OR
          (status = 'PROCESSING'::"OutboxStatus" AND locked_at <= NOW() - INTERVAL '5 minutes')
        )
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE outbox_events AS event
      SET status = 'PROCESSING'::"OutboxStatus",
          locked_at = NOW(),
          attempts = event.attempts + 1
      FROM claimable
      WHERE event.id = claimable.id
      RETURNING event.id, event.event_type AS "eventType", event.payload, event.attempts
    `));
  }

  async markPublished(id: string): Promise<void> {
    await prisma.outboxEvent.update({
      where: { id },
      data: { status: "PUBLISHED", publishedAt: new Date(), lockedAt: null, lastError: null },
    });
  }

  async releaseForRetry(id: string, message: string, delayMs: number): Promise<void> {
    await prisma.outboxEvent.update({
      where: { id },
      data: { status: "PENDING", availableAt: new Date(Date.now() + delayMs), lockedAt: null, lastError: message },
    });
  }

  async markFailed(id: string, message: string): Promise<void> {
    await prisma.outboxEvent.update({
      where: { id },
      data: { status: "FAILED", lockedAt: null, lastError: message },
    });
  }
}

export class BullMqEmailJobPublisher implements EmailJobPublisher {
  constructor(private readonly queue: { add(name: string, data: EmailJobData, options: Record<string, unknown>): Promise<unknown> }) {}

  async publish(emailId: string, scheduledAt: Date, jobId?: string): Promise<void> {
    const delay = Math.max(0, scheduledAt.getTime() - Date.now());
    await this.queue.add("send-email", { emailId }, {
      jobId: jobId ?? `email-${emailId}-s0`,
      delay,
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }
}

export class BullMqNotificationJobPublisher implements NotificationJobPublisher {
  constructor(private readonly queue: {
    add(name: string, data: RateLimitNotificationJobData, options: Record<string, unknown>): Promise<unknown>;
  }) {}

  async publish(rateLimitEventId: string): Promise<void> {
    await this.queue.add("notify-rate-limit", { rateLimitEventId }, {
      jobId: `rate-limit-${rateLimitEventId}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }
}

export class BullMqSearchJobPublisher implements SearchJobPublisher {
  constructor(private readonly queue: {
    add(name: string, data: EmailIndexJobData, options: Record<string, unknown>): Promise<unknown>;
  }) {}

  async publish(emailId: string, outboxEventId: string): Promise<void> {
    await this.queue.add("index-email", { emailId, outboxEventId }, {
      jobId: `email-index-${outboxEventId}`,
      attempts: 8,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }
}

function payloadForEmail(payload: Prisma.JsonValue): { emailId: string; scheduledAt: Date; jobId?: string } | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.emailId !== "string" || typeof value.scheduledAt !== "string") return null;
  const scheduledAt = new Date(value.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) return null;
  return {
    emailId: value.emailId,
    scheduledAt,
    jobId: typeof value.jobId === "string" ? value.jobId : undefined,
  };
}

export class OutboxDispatcher {
  constructor(
    private readonly emailPublisher: EmailJobPublisher,
    private readonly repository: OutboxRepository = new PrismaOutboxRepository(),
    private readonly notificationPublisher?: NotificationJobPublisher,
    private readonly searchPublisher?: SearchJobPublisher,
    private readonly batchSize = 100,
    private readonly maxAttempts = 10,
  ) {}

  async dispatchBatch(): Promise<{ claimed: number; published: number; retried: number; failed: number }> {
    const events: ClaimedOutboxEvent[] = await this.repository.claimBatch(this.batchSize);
    let published = 0;
    let retried = 0;
    let failed = 0;

    for (const event of events) {
      let publish: (() => Promise<void>) | undefined;
      if (event.eventType === "EMAIL_SCHEDULED") {
        const payload = payloadForEmail(event.payload);
        if (!payload) {
          await this.repository.markFailed(event.id, "Outbox event payload is invalid");
          failed += 1;
          continue;
        }
        publish = () => this.emailPublisher.publish(payload.emailId, payload.scheduledAt, payload.jobId);
      } else if (event.eventType === "RATE_LIMIT_REACHED" && this.notificationPublisher) {
        const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? event.payload as Record<string, unknown>
          : {};
        const rateLimitEventId = typeof payload.rateLimitEventId === "string" ? payload.rateLimitEventId : undefined;
        if (!rateLimitEventId) {
          await this.repository.markFailed(event.id, "Rate-limit notification event payload is invalid");
          failed += 1;
          continue;
        }
        publish = () => this.notificationPublisher!.publish(rateLimitEventId);
      } else if (event.eventType === "EMAIL_INDEX_REQUIRED" && this.searchPublisher) {
        const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? event.payload as Record<string, unknown>
          : {};
        const emailId = typeof payload.emailId === "string" ? payload.emailId : undefined;
        if (!emailId) {
          await this.repository.markFailed(event.id, "Email index event payload is invalid");
          failed += 1;
          continue;
        }
        publish = () => this.searchPublisher!.publish(emailId, event.id);
      } else {
        await this.repository.markFailed(event.id, `Unsupported outbox event type: ${event.eventType}`);
        failed += 1;
        continue;
      }

      try {
        await publish();
        await this.repository.markPublished(event.id);
        published += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Queue publish failed";
        if (event.attempts >= this.maxAttempts) {
          await this.repository.markFailed(event.id, message);
          failed += 1;
        } else {
          const delayMs = Math.min(2 ** Math.max(0, event.attempts - 1) * 1000, 60_000);
          await this.repository.releaseForRetry(event.id, message, delayMs);
          retried += 1;
        }
      }
    }

    return { claimed: events.length, published, retried, failed };
  }
}
