import { EmailStatus, Prisma } from "@prisma/client";
import { prisma } from "../../config/database";
import { env } from "../../config/env";
import type { RateLimitReason, RateLimitResult } from "../rate-limiter/redis-rate-limiter";
import type { EmailSendResult, OutgoingEmail, SmtpEmailProvider, SmtpSender } from "./email-provider";

export interface DeliverableEmail extends OutgoingEmail {
  status: EmailStatus;
  retryCount: number;
  campaignHourlyLimit: number;
  sender: SmtpSender & { isActive: boolean; hourlyLimit: number; minDelaySeconds: number };
}

export interface EmailProcessingRepository {
  findForProcessing(emailId: string): Promise<DeliverableEmail | null>;
  claimForProcessing(emailId: string): Promise<boolean>;
  recordStatus(emailId: string, status: EmailStatus, details: Prisma.InputJsonValue, errorMessage?: string): Promise<boolean>;
  scheduleRetry(emailId: string, details: Prisma.InputJsonValue, errorMessage: string): Promise<boolean>;
  rescheduleForRateLimit(emailId: string, retryAt: Date, reason: RateLimitReason | "RATE_LIMITER_UNAVAILABLE", message?: string): Promise<boolean>;
}

export class PrismaEmailProcessingRepository implements EmailProcessingRepository {
  async findForProcessing(emailId: string): Promise<DeliverableEmail | null> {
    const email = await prisma.email.findUnique({
      where: { id: emailId },
      include: {
        campaign: { select: { hourlyLimit: true } },
        sender: {
          select: {
            id: true,
            email: true,
            smtpHost: true,
            smtpPort: true,
            smtpUsername: true,
            smtpPassword: true,
            isActive: true,
            hourlyLimit: true,
            minDelaySeconds: true,
          },
        },
      },
    });
    if (!email) return null;
    return {
      id: email.id,
      recipient: email.recipient,
      subject: email.subject,
      body: email.body,
      status: email.status,
      retryCount: email.retryCount,
      campaignHourlyLimit: email.campaign.hourlyLimit,
      sender: {
        id: email.sender.id,
        email: email.sender.email,
        smtpHost: email.sender.smtpHost,
        smtpPort: email.sender.smtpPort,
        smtpUsername: email.sender.smtpUsername,
        encryptedSmtpPassword: email.sender.smtpPassword,
        isActive: email.sender.isActive,
        hourlyLimit: email.sender.hourlyLimit,
        minDelaySeconds: email.sender.minDelaySeconds,
      },
    };
  }

  async claimForProcessing(emailId: string): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const result = await tx.email.updateMany({
        where: { id: emailId, status: EmailStatus.SCHEDULED },
        data: { status: EmailStatus.PROCESSING, processingLeaseAt: new Date() },
      });
      if (result.count === 0) return false;
      await tx.emailEvent.create({
        data: { emailId, eventType: "SEND_ATTEMPT_STARTED", details: { startedAt: new Date().toISOString() } },
      });
      return true;
    });
  }

  async recordStatus(
    emailId: string,
    status: EmailStatus,
    details: Prisma.InputJsonValue,
    errorMessage?: string,
  ): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const result = await tx.email.updateMany({
        where: { id: emailId, status: EmailStatus.PROCESSING },
        data: {
          status,
          sentAt: status === EmailStatus.SENT ? new Date() : undefined,
          errorMessage,
          processingLeaseAt: null,
        },
      });
      if (result.count === 0) return false;
      await tx.emailEvent.create({ data: { emailId, eventType: status, details } });
      await tx.outboxEvent.create({
        data: {
          aggregateId: emailId,
          eventType: "EMAIL_INDEX_REQUIRED",
          payload: { emailId } satisfies Prisma.InputJsonObject,
        },
      });
      return true;
    });
  }

  async scheduleRetry(emailId: string, details: Prisma.InputJsonValue, errorMessage: string): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const result = await tx.email.updateMany({
        where: { id: emailId, status: EmailStatus.PROCESSING },
        data: {
          status: EmailStatus.SCHEDULED,
          retryCount: { increment: 1 },
          errorMessage,
          processingLeaseAt: null,
        },
      });
      if (result.count === 0) return false;
      await tx.emailEvent.create({ data: { emailId, eventType: "RETRY_SCHEDULED", details } });
      await tx.outboxEvent.create({
        data: {
          aggregateId: emailId,
          eventType: "EMAIL_INDEX_REQUIRED",
          payload: { emailId } satisfies Prisma.InputJsonObject,
        },
      });
      return true;
    });
  }

  async rescheduleForRateLimit(
    emailId: string,
    retryAt: Date,
    reason: RateLimitReason | "RATE_LIMITER_UNAVAILABLE",
    message?: string,
  ): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const email = await tx.email.findFirst({
        where: { id: emailId, status: EmailStatus.PROCESSING },
        select: { id: true, senderId: true, scheduleVersion: true },
      });
      if (!email) return false;

      const scheduleVersion = email.scheduleVersion + 1;
      const updated = await tx.email.updateMany({
        where: { id: emailId, status: EmailStatus.PROCESSING },
        data: {
          status: EmailStatus.SCHEDULED,
          scheduledAt: retryAt,
          processingLeaseAt: null,
          scheduleVersion,
          errorMessage: message,
        },
      });
      if (updated.count === 0) return false;
      const eventDetails = { reason, retryAt: retryAt.toISOString(), message: message ?? null } satisfies Prisma.InputJsonObject;
      await tx.emailEvent.create({ data: { emailId, eventType: reason, details: eventDetails } });
      await tx.outboxEvent.create({
        data: {
          aggregateId: emailId,
          eventType: "EMAIL_SCHEDULED",
          payload: {
            emailId,
            scheduledAt: retryAt.toISOString(),
            jobId: `email-${emailId}-s${scheduleVersion}`,
          } satisfies Prisma.InputJsonObject,
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: emailId,
          eventType: "EMAIL_INDEX_REQUIRED",
          payload: { emailId } satisfies Prisma.InputJsonObject,
        },
      });

      if (reason === "HOURLY_LIMIT") {
        const hourWindow = Math.floor((retryAt.getTime() - 1) / 3_600_000);
        const windowKey = `hour:${hourWindow}`;
        const inserted = await tx.rateLimitEvent.createMany({
          data: [{ senderId: email.senderId, windowKey, reason, retryAt }],
          skipDuplicates: true,
        });
        if (inserted.count === 1) {
          const rateLimitEvent = await tx.rateLimitEvent.findUnique({
            where: { senderId_windowKey_reason: { senderId: email.senderId, windowKey, reason } },
            select: { id: true },
          });
          if (rateLimitEvent) {
            await tx.outboxEvent.create({
              data: {
                aggregateId: rateLimitEvent.id,
                eventType: "RATE_LIMIT_REACHED",
                payload: { rateLimitEventId: rateLimitEvent.id } satisfies Prisma.InputJsonObject,
              },
            });
          }
        }
      }
      return true;
    });
  }
}

export class RetryableEmailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableEmailDeliveryError";
  }
}

export type EmailProcessResult = "SENT" | "FAILED" | "DELIVERY_UNKNOWN" | "RETRY_SCHEDULED" | "RATE_LIMITED" | "SKIPPED";

export interface EmailRateLimitPolicy {
  maxEmailsPerHourPerSender: number;
  minEmailDelaySeconds: number;
}

const defaultRateLimitPolicy: EmailRateLimitPolicy = {
  maxEmailsPerHourPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
  minEmailDelaySeconds: env.MIN_EMAIL_DELAY_SECONDS,
};

export class EmailProcessingService {
  constructor(
    private readonly repository: EmailProcessingRepository = new PrismaEmailProcessingRepository(),
    private readonly provider: Pick<SmtpEmailProvider, "send">,
    private readonly rateLimiter: {
      reserveSendSlot(senderId: string, hourlyLimit: number, minDelaySeconds: number): Promise<RateLimitResult>;
    } = { async reserveSendSlot() { return { allowed: true }; } },
    private readonly rateLimitPolicy: EmailRateLimitPolicy = defaultRateLimitPolicy,
  ) {}

  async process(emailId: string, isFinalAttempt = false): Promise<EmailProcessResult> {
    const email = await this.repository.findForProcessing(emailId);
    if (!email || email.status !== EmailStatus.SCHEDULED) return "SKIPPED";

    const claimed = await this.repository.claimForProcessing(emailId);
    if (!claimed) return "SKIPPED";

    if (!email.sender.isActive) {
      const recorded = await this.repository.recordStatus(emailId, EmailStatus.FAILED, { reason: "SENDER_INACTIVE" }, "Sender account is inactive");
      return recorded ? "FAILED" : "SKIPPED";
    }

    try {
      const limit = await this.rateLimiter.reserveSendSlot(
        email.sender.id,
        Math.min(email.campaignHourlyLimit, email.sender.hourlyLimit, this.rateLimitPolicy.maxEmailsPerHourPerSender),
        Math.max(email.sender.minDelaySeconds, this.rateLimitPolicy.minEmailDelaySeconds),
      );
      if (!limit.allowed) {
        const rescheduled = await this.repository.rescheduleForRateLimit(
          emailId,
          limit.retryAt ?? new Date(Date.now() + 1000),
          limit.reason ?? "MIN_DELAY",
        );
        return rescheduled ? "RATE_LIMITED" : "SKIPPED";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Rate limiter unavailable";
      const rescheduled = await this.repository.rescheduleForRateLimit(emailId, new Date(Date.now() + 5000), "RATE_LIMITER_UNAVAILABLE", message);
      return rescheduled ? "RETRY_SCHEDULED" : "SKIPPED";
    }

    let result: EmailSendResult;
    try {
      result = await this.provider.send(email, email.sender);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Email provider failed before sending";
      const recorded = await this.repository.recordStatus(emailId, EmailStatus.FAILED, { reason: "PROVIDER_CONFIGURATION_ERROR" }, message);
      return recorded ? "FAILED" : "SKIPPED";
    }

    if (result.accepted) {
      const recorded = await this.repository.recordStatus(emailId, EmailStatus.SENT, { messageId: result.messageId ?? null });
      return recorded ? "SENT" : "DELIVERY_UNKNOWN";
    }

    const deliveryError = result.error ?? {
      code: "SMTP_REJECTED",
      message: "Email provider rejected the message",
      retryable: false,
      outcomeUnknown: false,
    };
    const details = {
      code: deliveryError.code,
      retryable: deliveryError.retryable,
      outcomeUnknown: deliveryError.outcomeUnknown,
    } satisfies Prisma.InputJsonObject;

    if (deliveryError.outcomeUnknown) {
      const recorded = await this.repository.recordStatus(emailId, EmailStatus.DELIVERY_UNKNOWN, details, deliveryError.message);
      return recorded ? "DELIVERY_UNKNOWN" : "SKIPPED";
    }
    if (deliveryError.retryable && !isFinalAttempt) {
      const scheduled = await this.repository.scheduleRetry(emailId, details, deliveryError.message);
      if (!scheduled) return "SKIPPED";
      throw new RetryableEmailDeliveryError(deliveryError.message);
    }

    const recorded = await this.repository.recordStatus(emailId, EmailStatus.FAILED, details, deliveryError.message);
    return recorded ? "FAILED" : "SKIPPED";
  }
}
