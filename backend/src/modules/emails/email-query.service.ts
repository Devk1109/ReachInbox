import { EmailStatus, Prisma } from "@prisma/client";
import { prisma } from "../../config/database";

export type EmailStatusGroup = "scheduled" | "sent" | "failed" | "unknown";

export interface EmailListItem {
  id: string;
  campaignId: string;
  senderId: string;
  senderEmail: string;
  recipient: string;
  subject: string;
  scheduledAt: Date;
  sentAt: Date | null;
  status: EmailStatus;
  isStarred: boolean;
  archivedAt: Date | null;
  trashedAt: Date | null;
  retryCount: number;
  errorMessage: string | null;
}

export interface EmailDetail extends EmailListItem {
  body: string;
  events: Array<{ id: string; eventType: string; details: Prisma.JsonValue | null; createdAt: Date }>;
}

export interface EmailQueryRepository {
  list(userId: string, group: EmailStatusGroup, skip: number, take: number): Promise<{ total: number; emails: EmailListItem[] }>;
  findById(userId: string, emailId: string): Promise<EmailDetail | null>;
  updateMailboxState(userId: string, emailId: string, data: EmailMailboxStateUpdate): Promise<EmailDetail | null>;
}

export interface EmailMailboxStateUpdate {
  isStarred?: boolean;
  archivedAt?: Date | null;
  trashedAt?: Date | null;
}

const listSelect = {
  id: true,
  campaignId: true,
  senderId: true,
  recipient: true,
  subject: true,
  scheduledAt: true,
  sentAt: true,
  status: true,
  isStarred: true,
  archivedAt: true,
  trashedAt: true,
  retryCount: true,
  errorMessage: true,
  sender: { select: { email: true } },
} satisfies Prisma.EmailSelect;

const statuses: Record<EmailStatusGroup, EmailStatus[]> = {
  scheduled: [EmailStatus.SCHEDULED, EmailStatus.PROCESSING],
  sent: [EmailStatus.SENT],
  failed: [EmailStatus.FAILED],
  unknown: [EmailStatus.DELIVERY_UNKNOWN],
};

export class PrismaEmailQueryRepository implements EmailQueryRepository {
  async list(userId: string, group: EmailStatusGroup, skip: number, take: number): Promise<{ total: number; emails: EmailListItem[] }> {
    const where: Prisma.EmailWhereInput = { status: { in: statuses[group] }, archivedAt: null, trashedAt: null, campaign: { userId } };
    const [total, records] = await prisma.$transaction([
      prisma.email.count({ where }),
      prisma.email.findMany({
        where,
        select: listSelect,
        orderBy: { scheduledAt: "desc" },
        skip,
        take,
      }),
    ]);
    return { total, emails: records.map(({ sender, ...email }) => ({ ...email, senderEmail: sender.email })) };
  }

  async findById(userId: string, emailId: string): Promise<EmailDetail | null> {
    const email = await prisma.email.findFirst({
      where: { id: emailId, campaign: { userId } },
      include: {
        sender: { select: { email: true } },
        events: { orderBy: { createdAt: "asc" }, select: { id: true, eventType: true, details: true, createdAt: true } },
      },
    });
    if (!email) return null;
    const { sender, ...detail } = email;
    return { ...detail, senderEmail: sender.email };
  }

  async updateMailboxState(userId: string, emailId: string, data: EmailMailboxStateUpdate): Promise<EmailDetail | null> {
    const updated = await prisma.email.updateMany({
      where: { id: emailId, campaign: { userId } },
      data,
    });
    return updated.count ? this.findById(userId, emailId) : null;
  }
}

export class EmailQueryService {
  constructor(private readonly repository: EmailQueryRepository = new PrismaEmailQueryRepository()) {}

  list(userId: string, group: EmailStatusGroup, page: number, pageSize: number) {
    return this.repository.list(userId, group, (page - 1) * pageSize, pageSize);
  }

  find(userId: string, emailId: string) {
    return this.repository.findById(userId, emailId);
  }

  updateMailboxState(userId: string, emailId: string, data: EmailMailboxStateUpdate) {
    return this.repository.updateMailboxState(userId, emailId, data);
  }
}
