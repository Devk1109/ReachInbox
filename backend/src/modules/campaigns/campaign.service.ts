import { randomUUID } from "node:crypto";
import { CampaignStatus, EmailStatus, OutboxStatus, Prisma } from "@prisma/client";
import { prisma } from "../../config/database";
import { parseRecipientCsv, type RecipientParseResult } from "./recipient-parser";

export interface CampaignCreateInput {
  senderId: string;
  subject: string;
  body: string;
  startTime: Date;
  delayBetweenEmails: number;
  hourlyLimit: number;
}

export interface ScheduledEmailRecord {
  id: string;
  campaignId: string;
  senderId: string;
  recipient: string;
  subject: string;
  body: string;
  scheduledAt: Date;
  status: EmailStatus;
  idempotencyKey: string;
}

export interface CampaignSummary {
  id: string;
  userId: string;
  senderId: string;
  subject: string;
  startTime: Date;
  delayBetweenEmails: number;
  hourlyLimit: number;
  status: CampaignStatus;
  createdAt: Date;
  emailCount: number;
}

export interface CampaignDetail extends CampaignSummary {
  emails: Array<{
    id: string;
    recipient: string;
    scheduledAt: Date;
    sentAt: Date | null;
    status: EmailStatus;
    retryCount: number;
    errorMessage: string | null;
  }>;
}

export interface CampaignRepository {
  createScheduledCampaign(userId: string, input: CampaignCreateInput, campaignId: string, emails: ScheduledEmailRecord[]): Promise<CampaignSummary>;
  listByUser(userId: string): Promise<CampaignSummary[]>;
  findByUser(userId: string, campaignId: string): Promise<CampaignDetail | null>;
  cancel(userId: string, campaignId: string): Promise<CampaignSummary | null>;
}

export class SenderUnavailableError extends Error {}

const TERMINAL_CAMPAIGN_STATUSES = new Set<CampaignStatus>([
  CampaignStatus.COMPLETED,
  CampaignStatus.PARTIALLY_FAILED,
  CampaignStatus.FAILED,
  CampaignStatus.CANCELLED,
]);

export function buildEmailSchedule(
  campaignId: string,
  input: CampaignCreateInput,
  recipients: string[],
): ScheduledEmailRecord[] {
  return recipients.map((recipient, index) => ({
    id: randomUUID(),
    campaignId,
    senderId: input.senderId,
    recipient,
    subject: input.subject,
    body: input.body,
    scheduledAt: new Date(input.startTime.getTime() + index * input.delayBetweenEmails * 1000),
    status: EmailStatus.SCHEDULED,
    idempotencyKey: `${campaignId}:${index}`,
  }));
}

export class PrismaCampaignRepository implements CampaignRepository {
  async createScheduledCampaign(
    userId: string,
    input: CampaignCreateInput,
    campaignId: string,
    emails: ScheduledEmailRecord[],
  ): Promise<CampaignSummary> {
    return prisma.$transaction(async (tx) => {
      const sender = await tx.sender.findFirst({
        where: { id: input.senderId, userId, isActive: true },
        select: { id: true },
      });
      if (!sender) throw new SenderUnavailableError("Sender not found or inactive");

      const campaign = await tx.campaign.create({
        data: {
          id: campaignId,
          userId,
          senderId: input.senderId,
          subject: input.subject,
          body: input.body,
          startTime: input.startTime,
          delayBetweenEmails: input.delayBetweenEmails,
          hourlyLimit: input.hourlyLimit,
          status: CampaignStatus.SCHEDULED,
        },
      });

      await tx.email.createMany({ data: emails });
      await tx.outboxEvent.createMany({
        data: emails.flatMap((email) => [
          {
            aggregateId: email.id,
            eventType: "EMAIL_SCHEDULED",
            payload: {
              emailId: email.id,
              scheduledAt: email.scheduledAt.toISOString(),
              jobId: `email-${email.id}-s0`,
            } satisfies Prisma.InputJsonObject,
            status: OutboxStatus.PENDING,
          },
          {
            aggregateId: email.id,
            eventType: "EMAIL_INDEX_REQUIRED",
            payload: { emailId: email.id } satisfies Prisma.InputJsonObject,
            status: OutboxStatus.PENDING,
          },
        ]),
      });

      return {
        id: campaign.id,
        userId: campaign.userId,
        senderId: campaign.senderId,
        subject: campaign.subject,
        startTime: campaign.startTime,
        delayBetweenEmails: campaign.delayBetweenEmails,
        hourlyLimit: campaign.hourlyLimit,
        status: campaign.status,
        createdAt: campaign.createdAt,
        emailCount: emails.length,
      };
    });
  }

  async listByUser(userId: string): Promise<CampaignSummary[]> {
    const campaigns = await prisma.campaign.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { emails: true } } },
    });
    return campaigns.map(({ _count, ...campaign }) => ({ ...campaign, emailCount: _count.emails }));
  }

  async findByUser(userId: string, campaignId: string): Promise<CampaignDetail | null> {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, userId },
      include: {
        emails: {
          select: { id: true, recipient: true, scheduledAt: true, sentAt: true, status: true, retryCount: true, errorMessage: true },
          orderBy: { scheduledAt: "asc" },
        },
      },
    });
    if (!campaign) return null;
    const { emails, ...summary } = campaign;
    return { ...summary, emailCount: emails.length, emails };
  }

  async cancel(userId: string, campaignId: string): Promise<CampaignSummary | null> {
    return prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.findFirst({ where: { id: campaignId, userId } });
      if (!campaign) return null;
      if (TERMINAL_CAMPAIGN_STATUSES.has(campaign.status)) {
        return {
          id: campaign.id,
          userId: campaign.userId,
          senderId: campaign.senderId,
          subject: campaign.subject,
          startTime: campaign.startTime,
          delayBetweenEmails: campaign.delayBetweenEmails,
          hourlyLimit: campaign.hourlyLimit,
          status: campaign.status,
          createdAt: campaign.createdAt,
          emailCount: await tx.email.count({ where: { campaignId } }),
        };
      }
      await tx.campaign.update({ where: { id: campaignId }, data: { status: CampaignStatus.CANCELLED } });
      const scheduledEmails = await tx.email.findMany({
        where: { campaignId, status: EmailStatus.SCHEDULED },
        select: { id: true },
      });
      await tx.email.updateMany({ where: { campaignId, status: EmailStatus.SCHEDULED }, data: { status: EmailStatus.CANCELLED } });
      if (scheduledEmails.length > 0) {
        await tx.outboxEvent.createMany({
          data: scheduledEmails.map((email) => ({
            aggregateId: email.id,
            eventType: "EMAIL_INDEX_REQUIRED",
            payload: { emailId: email.id } satisfies Prisma.InputJsonObject,
          })),
        });
      }
      const emailCount = await tx.email.count({ where: { campaignId } });
      return {
        id: campaign.id,
        userId: campaign.userId,
        senderId: campaign.senderId,
        subject: campaign.subject,
        startTime: campaign.startTime,
        delayBetweenEmails: campaign.delayBetweenEmails,
        hourlyLimit: campaign.hourlyLimit,
        status: CampaignStatus.CANCELLED,
        createdAt: campaign.createdAt,
        emailCount,
      };
    });
  }
}

export class CampaignService {
  constructor(private readonly repository: CampaignRepository = new PrismaCampaignRepository()) {}

  parseRecipients(csv: string): RecipientParseResult {
    return parseRecipientCsv(csv);
  }

  async create(userId: string, input: CampaignCreateInput, csv: string): Promise<{ campaign: CampaignSummary; recipientResult: RecipientParseResult }> {
    const recipientResult = parseRecipientCsv(csv);
    if (recipientResult.recipients.length === 0) {
      throw new EmptyRecipientListError("At least one valid recipient is required");
    }
    if (recipientResult.invalidRecipients.length > 0) {
      throw new InvalidRecipientListError(recipientResult);
    }

    const campaignId = randomUUID();
    const emails = buildEmailSchedule(campaignId, input, recipientResult.recipients);
    const campaign = await this.repository.createScheduledCampaign(userId, input, campaignId, emails);
    return { campaign, recipientResult };
  }

  list(userId: string): Promise<CampaignSummary[]> {
    return this.repository.listByUser(userId);
  }

  find(userId: string, campaignId: string): Promise<CampaignDetail | null> {
    return this.repository.findByUser(userId, campaignId);
  }

  cancel(userId: string, campaignId: string): Promise<CampaignSummary | null> {
    return this.repository.cancel(userId, campaignId);
  }
}

export class InvalidRecipientListError extends Error {
  constructor(readonly result: RecipientParseResult) {
    super("One or more recipient addresses are invalid");
  }
}

export class EmptyRecipientListError extends Error {}
