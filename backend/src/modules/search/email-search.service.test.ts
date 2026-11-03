import assert from "node:assert/strict";
import { EmailStatus } from "@prisma/client";
import { test } from "node:test";
import {
  buildEmailSearchQuery,
  EmailSearchService,
  EMAIL_SEARCH_INDEX,
  type EmailSearchDocument,
  type EmailSearchProjectionRepository,
} from "./email-search.service";

const document: EmailSearchDocument = {
  id: "email-1",
  userId: "user-1",
  campaignId: "campaign-1",
  senderId: "sender-1",
  recipient: "recipient@example.com",
  subject: "Welcome",
  body: "Hello there",
  status: EmailStatus.SENT,
  scheduledAt: "2026-11-02T10:00:00.000Z",
  sentAt: "2026-11-02T10:00:03.000Z",
  updatedAt: "2026-11-02T10:00:03.000Z",
};

class InMemoryProjectionRepository implements EmailSearchProjectionRepository {
  async findDocument(emailId: string) { return emailId === document.id ? document : null; }
}

test("email search always scopes results to the authenticated user", () => {
  const query = buildEmailSearchQuery("user-1", {
    q: "welcome",
    recipient: "Recipient@Example.com",
    campaignId: "campaign-1",
    status: EmailStatus.SENT,
    scheduledFrom: "2026-11-01T00:00:00.000Z",
  }) as { bool: { filter: Array<Record<string, unknown>>; must: Array<Record<string, unknown>> } };

  assert.deepEqual(query.bool.filter[0], { term: { userId: "user-1" } });
  assert.deepEqual(query.bool.filter[1], { term: { recipient: "recipient@example.com" } });
  assert.deepEqual(query.bool.filter[2], { term: { campaignId: "campaign-1" } });
  assert.deepEqual(query.bool.filter[3], { term: { status: EmailStatus.SENT } });
  assert.deepEqual(query.bool.filter[4], { range: { scheduledAt: { gte: "2026-11-01T00:00:00.000Z" } } });
  assert.deepEqual(query.bool.must, [{ multi_match: { query: "welcome", fields: ["subject^2", "recipient", "body"] } }]);
});

test("email indexer creates an explicit mapping and uses external versioning", async () => {
  let indexExists = false;
  let createdIndex: Record<string, unknown> | undefined;
  let indexed: Record<string, unknown> | undefined;
  const fakeClient = {
    indices: {
      async exists() { return indexExists; },
      async create(params: Record<string, unknown>) { createdIndex = params; indexExists = true; return {}; },
    },
    async index(params: Record<string, unknown>) { indexed = params; return {}; },
    async search() { return { hits: { total: 0, hits: [] } }; },
  };
  const service = new EmailSearchService(new InMemoryProjectionRepository(), fakeClient);
  await service.indexEmail(document.id);

  assert.equal(createdIndex?.index, EMAIL_SEARCH_INDEX);
  assert.ok(createdIndex?.mappings);
  assert.equal(indexed?.index, EMAIL_SEARCH_INDEX);
  assert.equal(indexed?.id, document.id);
  assert.equal(indexed?.version_type, "external_gte");
  assert.equal(indexed?.version, new Date(document.updatedAt).getTime());
});

test("email search returns paginated source documents and total hits", async () => {
  const fakeClient = {
    indices: { async exists() { return true; }, async create() { return {}; } },
    async index() { return {}; },
    async search<T>(params: { from: number; size: number; query: Record<string, unknown> }) {
      return { hits: { total: { value: 1 }, hits: [{ _source: document as unknown as T }] } };
    },
  };
  const service = new EmailSearchService(new InMemoryProjectionRepository(), fakeClient);
  const result = await service.search("user-1", { status: EmailStatus.SENT }, 2, 10);
  assert.equal(result.total, 1);
  assert.deepEqual(result.emails, [document]);
});
