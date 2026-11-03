import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
import { test } from "node:test";
import {
  BullMqEmailJobPublisher,
  BullMqNotificationJobPublisher,
  BullMqSearchJobPublisher,
  OutboxDispatcher,
  type ClaimedOutboxEvent,
  type EmailJobPublisher,
  type OutboxRepository,
} from "./outbox-dispatcher";

class InMemoryOutboxRepository implements OutboxRepository {
  readonly published: string[] = [];
  readonly retries: Array<{ id: string; message: string; delayMs: number }> = [];
  readonly failed: Array<{ id: string; message: string }> = [];

  constructor(readonly events: ClaimedOutboxEvent[]) {}

  async claimBatch(_limit: number): Promise<ClaimedOutboxEvent[]> {
    return this.events;
  }

  async markPublished(id: string): Promise<void> {
    this.published.push(id);
  }

  async releaseForRetry(id: string, message: string, delayMs: number): Promise<void> {
    this.retries.push({ id, message, delayMs });
  }

  async markFailed(id: string, message: string): Promise<void> {
    this.failed.push({ id, message });
  }
}

function emailEvent(overrides: Partial<ClaimedOutboxEvent> = {}): ClaimedOutboxEvent {
  const payload: Prisma.JsonObject = {
    emailId: "email-1",
    scheduledAt: "2026-11-02T10:00:00.000Z",
  };
  return {
    id: "outbox-1",
    eventType: "EMAIL_SCHEDULED",
    payload,
    attempts: 1,
    ...overrides,
  };
}

test("outbox dispatcher publishes email jobs and marks the event published", async () => {
  const repository = new InMemoryOutboxRepository([emailEvent()]);
  const published: Array<{ emailId: string; scheduledAt: Date }> = [];
  const publisher: EmailJobPublisher = {
    async publish(emailId, scheduledAt) { published.push({ emailId, scheduledAt }); },
  };
  const dispatcher = new OutboxDispatcher(publisher, repository);

  const result = await dispatcher.dispatchBatch();
  assert.deepEqual(result, { claimed: 1, published: 1, retried: 0, failed: 0 });
  assert.deepEqual(repository.published, ["outbox-1"]);
  assert.equal(published[0]?.emailId, "email-1");
  assert.equal(published[0]?.scheduledAt.toISOString(), "2026-11-02T10:00:00.000Z");
});

test("outbox dispatcher retries transient queue errors with exponential backoff", async () => {
  const repository = new InMemoryOutboxRepository([emailEvent()]);
  const publisher: EmailJobPublisher = { async publish() { throw new Error("Redis unavailable"); } };
  const dispatcher = new OutboxDispatcher(publisher, repository);

  const result = await dispatcher.dispatchBatch();
  assert.equal(result.retried, 1);
  assert.deepEqual(repository.retries, [{ id: "outbox-1", message: "Redis unavailable", delayMs: 1000 }]);
});

test("outbox dispatcher stops retrying after the configured attempt limit", async () => {
  const repository = new InMemoryOutboxRepository([emailEvent({ attempts: 10 })]);
  const publisher: EmailJobPublisher = { async publish() { throw new Error("Queue error"); } };
  const dispatcher = new OutboxDispatcher(publisher, repository);

  const result = await dispatcher.dispatchBatch();
  assert.equal(result.failed, 1);
  assert.equal(repository.failed[0]?.id, "outbox-1");
});

test("BullMQ publisher uses a stable job id and retry settings", async () => {
  let recorded: { name: string; data: unknown; options: Record<string, unknown> } | undefined;
  const queue = {
    async add(name: string, data: { emailId: string }, options: Record<string, unknown>) {
      recorded = { name, data, options };
      return {};
    },
  };
  const publisher = new BullMqEmailJobPublisher(queue);
  await publisher.publish("email-42", new Date(Date.now() - 1000));

  assert.equal(recorded?.name, "send-email");
  assert.deepEqual(recorded?.data, { emailId: "email-42" });
  assert.equal(recorded?.options.jobId, "email-email-42-s0");
  assert.equal(recorded?.options.delay, 0);
  assert.equal(recorded?.options.attempts, 5);
});

test("outbox dispatcher publishes rate-limit notifications to their own queue", async () => {
  const repository = new InMemoryOutboxRepository([emailEvent({
    id: "notification-outbox",
    eventType: "RATE_LIMIT_REACHED",
    payload: { rateLimitEventId: "rate-event-1" },
  })]);
  let notificationId: string | undefined;
  const emailPublisher: EmailJobPublisher = { async publish() { assert.fail("email queue should not receive this event"); } };
  const notificationPublisher = {
    async publish(rateLimitEventId: string) { notificationId = rateLimitEventId; },
  };
  const dispatcher = new OutboxDispatcher(emailPublisher, repository, notificationPublisher);

  const result = await dispatcher.dispatchBatch();
  assert.equal(result.published, 1);
  assert.equal(notificationId, "rate-event-1");
  assert.deepEqual(repository.published, ["notification-outbox"]);
});

test("BullMQ notification publisher deduplicates by rate-limit event id", async () => {
  let recorded: { name: string; data: unknown; options: Record<string, unknown> } | undefined;
  const queue = {
    async add(name: string, data: { rateLimitEventId: string }, options: Record<string, unknown>) {
      recorded = { name, data, options };
      return {};
    },
  };
  await new BullMqNotificationJobPublisher(queue).publish("event-1");
  assert.equal(recorded?.name, "notify-rate-limit");
  assert.deepEqual(recorded?.data, { rateLimitEventId: "event-1" });
  assert.equal(recorded?.options.jobId, "rate-limit-event-1");
});

test("outbox dispatcher publishes email projection updates for asynchronous indexing", async () => {
  const repository = new InMemoryOutboxRepository([emailEvent({
    id: "index-outbox-1",
    eventType: "EMAIL_INDEX_REQUIRED",
    payload: { emailId: "email-1" },
  })]);
  let indexed: { emailId: string; outboxEventId: string } | undefined;
  const emailPublisher: EmailJobPublisher = { async publish() { assert.fail("email queue should not receive index events"); } };
  const searchPublisher = {
    async publish(emailId: string, outboxEventId: string) { indexed = { emailId, outboxEventId }; },
  };
  const dispatcher = new OutboxDispatcher(emailPublisher, repository, undefined, searchPublisher);

  const result = await dispatcher.dispatchBatch();
  assert.equal(result.published, 1);
  assert.deepEqual(indexed, { emailId: "email-1", outboxEventId: "index-outbox-1" });
});

test("BullMQ search publisher uses the outbox event for deterministic deduplication", async () => {
  let recorded: { name: string; data: unknown; options: Record<string, unknown> } | undefined;
  const queue = {
    async add(name: string, data: { emailId: string; outboxEventId: string }, options: Record<string, unknown>) {
      recorded = { name, data, options };
      return {};
    },
  };
  await new BullMqSearchJobPublisher(queue).publish("email-1", "outbox-1");
  assert.equal(recorded?.name, "index-email");
  assert.deepEqual(recorded?.data, { emailId: "email-1", outboxEventId: "outbox-1" });
  assert.equal(recorded?.options.jobId, "email-index-outbox-1");
});
