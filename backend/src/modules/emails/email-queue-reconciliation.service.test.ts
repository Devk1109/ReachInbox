import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmailJobPublisher } from "../outbox/outbox-dispatcher";
import { ScheduledEmailQueueReconciliationService, type ScheduledEmailQueueRecord } from "./email-queue-reconciliation.service";

test("scheduled email reconciliation republishes every page with stable versioned IDs", async () => {
  const records: ScheduledEmailQueueRecord[] = [
    { id: "email-a", scheduleVersion: 0, scheduledAt: new Date("2026-11-03T10:00:00.000Z") },
    { id: "email-b", scheduleVersion: 2, scheduledAt: new Date("2026-11-03T11:00:00.000Z") },
    { id: "email-c", scheduleVersion: 0, scheduledAt: new Date("2026-11-03T12:00:00.000Z") },
  ];
  const calls: Array<{ id: string; scheduledAt: Date; jobId?: string }> = [];
  const publisher: EmailJobPublisher = {
    async publish(id, scheduledAt, jobId) { calls.push({ id, scheduledAt, jobId }); },
  };
  const repository = {
    async findNextScheduled(afterId: string | undefined, limit: number) {
      return records.filter((email) => !afterId || email.id > afterId).slice(0, limit);
    },
  };
  const existingJobIds = new Set(["email-email-a-s0"]);
  const queue = { async getJob(jobId: string) { return existingJobIds.has(jobId) ? { id: jobId } : undefined; } };
  const service = new ScheduledEmailQueueReconciliationService(repository, publisher, queue, 2);

  assert.deepEqual(await service.reconcile(), { checked: 3, published: 2 });
  assert.deepEqual(calls.map((call) => call.jobId), ["email-email-b-s2", "email-email-c-s0"]);
});
