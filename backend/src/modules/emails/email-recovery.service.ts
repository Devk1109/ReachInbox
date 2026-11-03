import { EmailStatus, Prisma } from "@prisma/client";
import { prisma } from "../../config/database";

export const EMAIL_PROCESSING_LEASE_MS = 5 * 60 * 1000;

export interface StaleEmail {
  id: string;
  scheduleVersion: number;
  scheduledAt: Date;
  sendAttemptStarted: boolean;
}

export interface EmailRecoveryRepository {
  findStaleProcessing(cutoff: Date, limit: number): Promise<StaleEmail[]>;
  recoverStale(email: StaleEmail, cutoff: Date, recoveredAt: Date): Promise<"UNKNOWN" | "RESCHEDULED" | "SKIPPED">;
}

export class PrismaEmailRecoveryRepository implements EmailRecoveryRepository {
  async findStaleProcessing(cutoff: Date, limit: number): Promise<StaleEmail[]> {
    const records = await prisma.email.findMany({
      where: { status: EmailStatus.PROCESSING, processingLeaseAt: { lt: cutoff } },
      select: {
        id: true,
        scheduleVersion: true,
        scheduledAt: true,
        events: {
          where: { eventType: "SEND_ATTEMPT_STARTED" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true },
        },
      },
      orderBy: { processingLeaseAt: "asc" },
      take: limit,
    });
    return records.map((record) => ({
      id: record.id,
      scheduleVersion: record.scheduleVersion,
      scheduledAt: record.scheduledAt,
      sendAttemptStarted: record.events.length > 0,
    }));
  }

  async recoverStale(email: StaleEmail, cutoff: Date, recoveredAt: Date): Promise<"UNKNOWN" | "RESCHEDULED" | "SKIPPED"> {
    return prisma.$transaction(async (tx) => {
      const nextStatus = email.sendAttemptStarted ? EmailStatus.DELIVERY_UNKNOWN : EmailStatus.SCHEDULED;
      const nextScheduleVersion = email.sendAttemptStarted ? email.scheduleVersion : email.scheduleVersion + 1;
      const updated = await tx.email.updateMany({
        where: {
          id: email.id,
          status: EmailStatus.PROCESSING,
          processingLeaseAt: { lt: cutoff },
        },
        data: {
          status: nextStatus,
          processingLeaseAt: null,
          ...(email.sendAttemptStarted ? {
            errorMessage: "Worker stopped during an SMTP attempt; delivery outcome must be reconciled",
          } : {
            errorMessage: null,
            scheduledAt: recoveredAt,
            scheduleVersion: nextScheduleVersion,
          }),
        },
      });
      if (updated.count === 0) return "SKIPPED";

      if (email.sendAttemptStarted) {
        await tx.emailEvent.create({
          data: {
            emailId: email.id,
            eventType: EmailStatus.DELIVERY_UNKNOWN,
            details: { reason: "WORKER_CRASH_DURING_SEND", recoveredAt: recoveredAt.toISOString() } satisfies Prisma.InputJsonObject,
          },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: email.id,
            eventType: "EMAIL_INDEX_REQUIRED",
            payload: { emailId: email.id } satisfies Prisma.InputJsonObject,
          },
        });
        return "UNKNOWN";
      }

      await tx.emailEvent.create({
        data: {
          emailId: email.id,
          eventType: "RECOVERED_BEFORE_SEND",
          details: { recoveredAt: recoveredAt.toISOString() } satisfies Prisma.InputJsonObject,
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: email.id,
          eventType: "EMAIL_SCHEDULED",
          payload: {
            emailId: email.id,
            scheduledAt: recoveredAt.toISOString(),
            jobId: `email-${email.id}-s${nextScheduleVersion}`,
          } satisfies Prisma.InputJsonObject,
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: email.id,
          eventType: "EMAIL_INDEX_REQUIRED",
          payload: { emailId: email.id } satisfies Prisma.InputJsonObject,
        },
      });
      return "RESCHEDULED";
    });
  }
}

export class EmailRecoveryService {
  constructor(private readonly repository: EmailRecoveryRepository = new PrismaEmailRecoveryRepository()) {}

  async reconcileStaleProcessing(now = new Date(), limit = 100): Promise<{ unknown: number; rescheduled: number; skipped: number }> {
    const cutoff = new Date(now.getTime() - EMAIL_PROCESSING_LEASE_MS);
    const staleEmails = await this.repository.findStaleProcessing(cutoff, limit);
    const result = { unknown: 0, rescheduled: 0, skipped: 0 };
    for (const email of staleEmails) {
      const status = await this.repository.recoverStale(email, cutoff, now);
      if (status === "UNKNOWN") result.unknown += 1;
      else if (status === "RESCHEDULED") result.rescheduled += 1;
      else result.skipped += 1;
    }
    return result;
  }
}
