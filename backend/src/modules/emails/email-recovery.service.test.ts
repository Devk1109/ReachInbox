import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMAIL_PROCESSING_LEASE_MS,
  EmailRecoveryService,
  type EmailRecoveryRepository,
  type StaleEmail,
} from "./email-recovery.service";

class InMemoryEmailRecoveryRepository implements EmailRecoveryRepository {
  recovered: Array<{ id: string; cutoff: Date; at: Date; result: "UNKNOWN" | "RESCHEDULED" | "SKIPPED" }> = [];

  constructor(readonly stale: StaleEmail[]) {}

  async findStaleProcessing(cutoff: Date, _limit: number): Promise<StaleEmail[]> {
    this.cutoff = cutoff;
    return this.stale;
  }

  cutoff = new Date(0);

  async recoverStale(email: StaleEmail, cutoff: Date, recoveredAt: Date): Promise<"UNKNOWN" | "RESCHEDULED" | "SKIPPED"> {
    const result = email.id === "raced-email" ? "SKIPPED" : email.sendAttemptStarted ? "UNKNOWN" : "RESCHEDULED";
    this.recovered.push({ id: email.id, cutoff, at: recoveredAt, result });
    return result;
  }
}

test("recovery marks stale SMTP attempts unknown and reschedules work not yet sent", async () => {
  const now = new Date("2026-11-02T12:00:00.000Z");
  const repository = new InMemoryEmailRecoveryRepository([
    { id: "sent-attempt", scheduleVersion: 0, scheduledAt: now, sendAttemptStarted: true },
    { id: "not-started", scheduleVersion: 2, scheduledAt: now, sendAttemptStarted: false },
    { id: "raced-email", scheduleVersion: 0, scheduledAt: now, sendAttemptStarted: false },
  ]);
  const result = await new EmailRecoveryService(repository).reconcileStaleProcessing(now);

  assert.deepEqual(result, { unknown: 1, rescheduled: 1, skipped: 1 });
  assert.equal(repository.cutoff.getTime(), now.getTime() - EMAIL_PROCESSING_LEASE_MS);
  assert.deepEqual(repository.recovered.map((item) => item.result), ["UNKNOWN", "RESCHEDULED", "SKIPPED"]);
});

test("recovery honors the batch limit and returns zeros when there is no stale work", async () => {
  const repository = new InMemoryEmailRecoveryRepository([]);
  const result = await new EmailRecoveryService(repository).reconcileStaleProcessing(new Date(), 25);
  assert.deepEqual(result, { unknown: 0, rescheduled: 0, skipped: 0 });
});
