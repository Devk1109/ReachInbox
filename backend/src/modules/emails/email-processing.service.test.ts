import assert from "node:assert/strict";
import { EmailStatus, Prisma } from "@prisma/client";
import { test } from "node:test";
import {
  EmailProcessingService,
  RetryableEmailDeliveryError,
  type DeliverableEmail,
  type EmailProcessingRepository,
} from "./email-processing.service";
import type { EmailSendResult, SmtpEmailProvider } from "./email-provider";

const baseEmail: DeliverableEmail = {
  id: "email-1",
  recipient: "recipient@example.com",
  subject: "Hello",
  body: "Welcome",
  status: EmailStatus.SCHEDULED,
  retryCount: 0,
  campaignHourlyLimit: 100,
  sender: {
    id: "sender-1",
    email: "sender@example.com",
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpUsername: "sender@example.com",
    encryptedSmtpPassword: "encrypted",
    isActive: true,
    hourlyLimit: 150,
    minDelaySeconds: 2,
  },
};

class InMemoryEmailRepository implements EmailProcessingRepository {
  email: DeliverableEmail = structuredClone(baseEmail);
  events: Array<{ type: string; details: Prisma.InputJsonValue }> = [];
  reschedules: Array<{ retryAt: Date; reason: string; message?: string }> = [];

  async findForProcessing(_emailId: string): Promise<DeliverableEmail | null> {
    return this.email;
  }

  async claimForProcessing(_emailId: string): Promise<boolean> {
    if (this.email.status !== EmailStatus.SCHEDULED) return false;
    this.email.status = EmailStatus.PROCESSING;
    this.events.push({ type: "SEND_ATTEMPT_STARTED", details: {} });
    return true;
  }

  async recordStatus(_emailId: string, status: EmailStatus, details: Prisma.InputJsonValue): Promise<boolean> {
    if (this.email.status !== EmailStatus.PROCESSING) return false;
    this.email.status = status;
    this.events.push({ type: status, details });
    return true;
  }

  async scheduleRetry(_emailId: string, details: Prisma.InputJsonValue): Promise<boolean> {
    if (this.email.status !== EmailStatus.PROCESSING) return false;
    this.email.status = EmailStatus.SCHEDULED;
    this.email.retryCount += 1;
    this.events.push({ type: "RETRY_SCHEDULED", details });
    return true;
  }

  async rescheduleForRateLimit(_emailId: string, retryAt: Date, reason: string, message?: string): Promise<boolean> {
    if (this.email.status !== EmailStatus.PROCESSING) return false;
    this.email.status = EmailStatus.SCHEDULED;
    this.reschedules.push({ retryAt, reason, message });
    this.events.push({ type: reason, details: { retryAt: retryAt.toISOString() } });
    return true;
  }
}

function serviceWith(result: EmailSendResult, repository = new InMemoryEmailRepository()) {
  let sendCount = 0;
  const provider: Pick<SmtpEmailProvider, "send"> = {
    async send() { sendCount += 1; return result; },
  };
  return { service: new EmailProcessingService(repository, provider), repository, getSendCount: () => sendCount };
}

test("email processing marks accepted delivery SENT", async () => {
  const { service, repository } = serviceWith({ accepted: true, messageId: "message-1" });
  assert.equal(await service.process("email-1"), "SENT");
  assert.equal(repository.email.status, EmailStatus.SENT);
  assert.deepEqual(repository.events.map((event) => event.type), ["SEND_ATTEMPT_STARTED", EmailStatus.SENT]);
});

test("email processing retries temporary errors and fails on the final attempt", async () => {
  const repository = new InMemoryEmailRepository();
  const { service } = serviceWith({
    accepted: false,
    error: { code: "ETIMEDOUT", message: "temporary timeout", retryable: true, outcomeUnknown: false },
  }, repository);

  await assert.rejects(service.process("email-1"), RetryableEmailDeliveryError);
  assert.equal(repository.email.status, EmailStatus.SCHEDULED);
  assert.equal(repository.email.retryCount, 1);
  assert.equal(await service.process("email-1", true), "FAILED");
  assert.equal(repository.email.status, EmailStatus.FAILED);
});

test("email processing does not retry permanent or ambiguous SMTP outcomes", async () => {
  const permanent = serviceWith({
    accepted: false,
    error: { code: "550", message: "rejected", retryable: false, outcomeUnknown: false },
  });
  assert.equal(await permanent.service.process("email-1"), "FAILED");
  assert.equal(permanent.repository.email.status, EmailStatus.FAILED);
  assert.equal(permanent.repository.email.retryCount, 0);

  const unknown = serviceWith({
    accepted: false,
    error: { code: "ETIMEDOUT", message: "ambiguous", retryable: false, outcomeUnknown: true },
  });
  assert.equal(await unknown.service.process("email-1"), "DELIVERY_UNKNOWN");
  assert.equal(unknown.repository.email.status, EmailStatus.DELIVERY_UNKNOWN);
});

test("email processing skips duplicate jobs for an email that is already completed", async () => {
  const repository = new InMemoryEmailRepository();
  repository.email.status = EmailStatus.SENT;
  const { service, getSendCount } = serviceWith({ accepted: true }, repository);
  assert.equal(await service.process("email-1"), "SKIPPED");
  assert.equal(getSendCount(), 0);
});

test("parallel duplicate jobs can claim and send one email only once", async () => {
  const repository = new InMemoryEmailRepository();
  const { service, getSendCount } = serviceWith({ accepted: true }, repository);
  const results = await Promise.all([service.process("email-1"), service.process("email-1")]);

  assert.equal(results.filter((result) => result === "SENT").length, 1);
  assert.equal(results.filter((result) => result === "SKIPPED").length, 1);
  assert.equal(getSendCount(), 1);
});

test("email processing fails inactive sender accounts without calling SMTP", async () => {
  const repository = new InMemoryEmailRepository();
  repository.email.sender.isActive = false;
  const { service, getSendCount } = serviceWith({ accepted: true }, repository);
  assert.equal(await service.process("email-1"), "FAILED");
  assert.equal(repository.email.status, EmailStatus.FAILED);
  assert.equal(getSendCount(), 0);
});

test("email processing reserves the lower campaign and sender limit and reschedules blocked jobs", async () => {
  const repository = new InMemoryEmailRepository();
  let observedLimits: number[] = [];
  let sendCount = 0;
  const provider: Pick<SmtpEmailProvider, "send"> = {
    async send() { sendCount += 1; return { accepted: true }; },
  };
  const service = new EmailProcessingService(repository, provider, {
    async reserveSendSlot(_senderId, hourlyLimit, minDelaySeconds) {
      observedLimits = [hourlyLimit, minDelaySeconds];
      return { allowed: false, retryAt: new Date("2026-11-02T12:00:00.000Z"), reason: "HOURLY_LIMIT" };
    },
  });

  assert.equal(await service.process("email-1"), "RATE_LIMITED");
  assert.deepEqual(observedLimits, [100, 2]);
  assert.equal(repository.email.status, EmailStatus.SCHEDULED);
  assert.equal(repository.reschedules[0]?.reason, "HOURLY_LIMIT");
  assert.equal(sendCount, 0);
});

test("email processing applies the environment policy cap and minimum delay", async () => {
  const repository = new InMemoryEmailRepository();
  let observedLimits: number[] = [];
  const service = new EmailProcessingService(repository, {
    async send() { return { accepted: true }; },
  }, {
    async reserveSendSlot(_senderId, hourlyLimit, minDelaySeconds) {
      observedLimits = [hourlyLimit, minDelaySeconds];
      return { allowed: true };
    },
  }, { maxEmailsPerHourPerSender: 40, minEmailDelaySeconds: 5 });

  assert.equal(await service.process("email-1"), "SENT");
  assert.deepEqual(observedLimits, [40, 5]);
});

test("email processing fails closed and schedules another job when Redis is unavailable", async () => {
  const repository = new InMemoryEmailRepository();
  let sendCount = 0;
  const failingService = new EmailProcessingService(repository, {
    async send() { sendCount += 1; return { accepted: true }; },
  }, {
    async reserveSendSlot() { throw new Error("Redis unavailable"); },
  });

  assert.equal(await failingService.process("email-1"), "RETRY_SCHEDULED");
  assert.equal(repository.email.status, EmailStatus.SCHEDULED);
  assert.equal(repository.reschedules[0]?.reason, "RATE_LIMITER_UNAVAILABLE");
  assert.equal(sendCount, 0);
});
