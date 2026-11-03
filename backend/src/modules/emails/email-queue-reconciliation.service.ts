import { EmailStatus } from "@prisma/client";
import { prisma } from "../../config/database";
import type { EmailJobPublisher } from "../outbox/outbox-dispatcher";

export interface ScheduledEmailQueueRecord {
  id: string;
  scheduleVersion: number;
  scheduledAt: Date;
}

export interface ScheduledEmailQueueRepository {
  findNextScheduled(afterId: string | undefined, limit: number): Promise<ScheduledEmailQueueRecord[]>;
}

export class PrismaScheduledEmailQueueRepository implements ScheduledEmailQueueRepository {
  findNextScheduled(afterId: string | undefined, limit: number): Promise<ScheduledEmailQueueRecord[]> {
    return prisma.email.findMany({
      where: {
        status: EmailStatus.SCHEDULED,
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: { id: true, scheduleVersion: true, scheduledAt: true },
      orderBy: { id: "asc" },
      take: limit,
    });
  }
}

export class ScheduledEmailQueueReconciliationService {
  constructor(
    private readonly repository: ScheduledEmailQueueRepository,
    private readonly publisher: EmailJobPublisher,
    private readonly queue: { getJob(jobId: string): Promise<unknown> },
    private readonly batchSize = 500,
  ) {}

  async reconcile(): Promise<{ checked: number; published: number }> {
    let afterId: string | undefined;
    let checked = 0;
    let published = 0;
    while (true) {
      const emails = await this.repository.findNextScheduled(afterId, this.batchSize);
      if (emails.length === 0) break;
      for (const email of emails) {
        const jobId = `email-${email.id}-s${email.scheduleVersion}`;
        if (await this.queue.getJob(jobId)) continue;
        await this.publisher.publish(email.id, email.scheduledAt, jobId);
        published += 1;
      }
      checked += emails.length;
      afterId = emails[emails.length - 1]!.id;
    }
    return { checked, published };
  }
}
