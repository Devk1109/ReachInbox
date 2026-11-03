import { EmailStatus } from "@prisma/client";
import { prisma } from "../../config/database";
import { elasticsearchClient } from "../../config/elasticsearch";

export const EMAIL_SEARCH_INDEX = "reachinbox-emails";

export interface EmailSearchDocument {
  id: string;
  userId: string;
  campaignId: string;
  senderId: string;
  recipient: string;
  subject: string;
  body: string;
  status: EmailStatus;
  isStarred?: boolean;
  archivedAt?: string | null;
  trashedAt?: string | null;
  scheduledAt: string;
  sentAt: string | null;
  updatedAt: string;
}

export interface EmailSearchFilters {
  q?: string;
  recipient?: string;
  subject?: string;
  campaignId?: string;
  senderId?: string;
  status?: EmailStatus;
  scheduledFrom?: string;
  scheduledTo?: string;
}

export interface EmailSearchProjectionRepository {
  findDocument(emailId: string): Promise<EmailSearchDocument | null>;
}

interface SearchHit<T> {
  _source?: T;
}

interface SearchClientLike {
  indices: {
    exists(params: { index: string }): Promise<boolean>;
    create(params: { index: string; mappings: Record<string, unknown> }): Promise<unknown>;
  };
  index(params: {
    index: string;
    id: string;
    document: EmailSearchDocument;
    version: number;
    version_type: "external_gte";
  }): Promise<unknown>;
  search<T>(params: {
    index: string;
    from: number;
    size: number;
    query: Record<string, unknown>;
    sort: Array<Record<string, unknown>>;
  }): Promise<{ hits: { total: number | { value: number }; hits: Array<SearchHit<T>> } }>;
}

export class PrismaEmailSearchProjectionRepository implements EmailSearchProjectionRepository {
  async findDocument(emailId: string): Promise<EmailSearchDocument | null> {
    const email = await prisma.email.findUnique({
      where: { id: emailId },
      include: { campaign: { select: { userId: true } } },
    });
    if (!email) return null;
    return {
      id: email.id,
      userId: email.campaign.userId,
      campaignId: email.campaignId,
      senderId: email.senderId,
      recipient: email.recipient,
      subject: email.subject,
      body: email.body,
      status: email.status,
      isStarred: email.isStarred,
      archivedAt: email.archivedAt?.toISOString() ?? null,
      trashedAt: email.trashedAt?.toISOString() ?? null,
      scheduledAt: email.scheduledAt.toISOString(),
      sentAt: email.sentAt?.toISOString() ?? null,
      updatedAt: email.updatedAt.toISOString(),
    };
  }
}

export function buildEmailSearchQuery(userId: string, filters: EmailSearchFilters): Record<string, unknown> {
  const filter: Array<Record<string, unknown>> = [{ term: { userId } }];
  const must: Array<Record<string, unknown>> = [];
  if (filters.recipient) filter.push({ term: { recipient: filters.recipient.trim().toLowerCase() } });
  if (filters.campaignId) filter.push({ term: { campaignId: filters.campaignId } });
  if (filters.senderId) filter.push({ term: { senderId: filters.senderId } });
  if (filters.status) filter.push({ term: { status: filters.status } });
  if (filters.scheduledFrom || filters.scheduledTo) {
    filter.push({ range: { scheduledAt: { ...(filters.scheduledFrom ? { gte: filters.scheduledFrom } : {}), ...(filters.scheduledTo ? { lte: filters.scheduledTo } : {}) } } });
  }
  if (filters.subject) must.push({ match_phrase: { subject: filters.subject } });
  if (filters.q) must.push({ multi_match: { query: filters.q, fields: ["subject^2", "recipient", "body"] } });
  return { bool: { filter, must_not: [{ exists: { field: "archivedAt" } }, { exists: { field: "trashedAt" } }], ...(must.length > 0 ? { must } : {}) } };
}

const EMAIL_MAPPINGS: Record<string, unknown> = {
  properties: {
    id: { type: "keyword" },
    userId: { type: "keyword" },
    campaignId: { type: "keyword" },
    senderId: { type: "keyword" },
    recipient: { type: "keyword" },
    subject: { type: "text" },
    body: { type: "text" },
    status: { type: "keyword" },
    isStarred: { type: "boolean" },
    archivedAt: { type: "date" },
    trashedAt: { type: "date" },
    scheduledAt: { type: "date" },
    sentAt: { type: "date" },
    updatedAt: { type: "date" },
  },
};

export class EmailSearchService {
  private indexReady = false;

  constructor(
    private readonly repository: EmailSearchProjectionRepository = new PrismaEmailSearchProjectionRepository(),
    private readonly client: SearchClientLike = elasticsearchClient as unknown as SearchClientLike,
  ) {}

  async indexEmail(emailId: string): Promise<void> {
    const document = await this.repository.findDocument(emailId);
    if (!document) return;
    await this.ensureIndex();
    await this.client.index({
      index: EMAIL_SEARCH_INDEX,
      id: document.id,
      document,
      version: Math.max(1, new Date(document.updatedAt).getTime()),
      version_type: "external_gte",
    });
  }

  async search(userId: string, filters: EmailSearchFilters, page = 1, pageSize = 25): Promise<{ total: number; emails: EmailSearchDocument[] }> {
    await this.ensureIndex();
    const result = await this.client.search<EmailSearchDocument>({
      index: EMAIL_SEARCH_INDEX,
      from: (page - 1) * pageSize,
      size: pageSize,
      query: buildEmailSearchQuery(userId, filters),
      sort: [{ scheduledAt: { order: "desc" } }],
    });
    const total = typeof result.hits.total === "number" ? result.hits.total : result.hits.total.value;
    return { total, emails: result.hits.hits.flatMap((hit) => hit._source ? [hit._source] : []) };
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexReady) return;
    if (!(await this.client.indices.exists({ index: EMAIL_SEARCH_INDEX }))) {
      try {
        await this.client.indices.create({ index: EMAIL_SEARCH_INDEX, mappings: EMAIL_MAPPINGS });
      } catch (error) {
        const details = error as { meta?: { body?: { error?: { type?: string } } } };
        if (details.meta?.body?.error?.type !== "resource_already_exists_exception") throw error;
      }
    }
    this.indexReady = true;
  }
}
