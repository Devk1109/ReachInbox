import assert from "node:assert/strict";
import { CampaignStatus } from "@prisma/client";
import { createServer, type Server } from "node:http";
import { afterEach, test } from "node:test";
import express from "express";
import session from "express-session";
import { requireAuth } from "../auth/auth.middleware";
import { createCampaignRouter } from "./campaign.routes";
import {
  CampaignService,
  type CampaignCreateInput,
  type CampaignDetail,
  type CampaignRepository,
  type CampaignSummary,
  type ScheduledEmailRecord,
  buildEmailSchedule,
} from "./campaign.service";

const servers: Server[] = [];

class InMemoryCampaignRepository implements CampaignRepository {
  created: CampaignSummary | null = null;
  scheduledEmails: ScheduledEmailRecord[] = [];

  async createScheduledCampaign(userId: string, input: CampaignCreateInput, campaignId: string, emails: ScheduledEmailRecord[]): Promise<CampaignSummary> {
    this.scheduledEmails = emails;
    this.created = {
      id: campaignId,
      userId,
      senderId: input.senderId,
      subject: input.subject,
      startTime: input.startTime,
      delayBetweenEmails: input.delayBetweenEmails,
      hourlyLimit: input.hourlyLimit,
      status: CampaignStatus.SCHEDULED,
      createdAt: new Date(),
      emailCount: emails.length,
    };
    return this.created;
  }

  async listByUser(_userId: string): Promise<CampaignSummary[]> {
    return this.created ? [this.created] : [];
  }

  async findByUser(_userId: string, _campaignId: string): Promise<CampaignDetail | null> {
    if (!this.created) return null;
    return { ...this.created, emails: [] };
  }

  async cancel(_userId: string, _campaignId: string): Promise<CampaignSummary | null> {
    if (!this.created) return null;
    this.created = { ...this.created, status: CampaignStatus.CANCELLED };
    return this.created;
  }
}

async function startServer(repository = new InMemoryCampaignRepository()) {
  const service = new CampaignService(repository);
  const app = express();
  app.use(express.json({ limit: "3mb" }));
  app.use(session({ secret: "campaign-test-session-secret-long-enough", resave: false, saveUninitialized: false }));
  app.get("/test-login", (request, response) => {
    request.session.userId = "user-1";
    response.status(204).end();
  });
  app.use("/api/campaigns", createCampaignRouter(service, requireAuth(async (id) => ({ id }))));

  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}`, repository };
}

async function login(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/test-login`);
  assert.equal(response.status, 204);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie);
  return cookie.split(";", 1)[0]!;
}

const campaignBody = {
  senderId: "4bd93fa8-2091-44f5-aa00-ff4770c92501",
  subject: "Hello",
  body: "Hello there",
  startTime: "2026-11-02T10:00:00.000Z",
  delayBetweenEmails: 30,
  hourlyLimit: 100,
  recipientCsv: "Email\nAda@example.com\nBob@example.com\nada@EXAMPLE.com",
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

test("campaign creation schedules unique recipients at the configured delay", async () => {
  const { baseUrl, repository } = await startServer();
  const cookie = await login(baseUrl);
  const response = await fetch(`${baseUrl}/api/campaigns`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(campaignBody),
  });

  assert.equal(response.status, 201);
  const result = await response.json() as { campaign: CampaignSummary; recipientCount: number; duplicateCount: number };
  assert.equal(result.recipientCount, 2);
  assert.equal(result.duplicateCount, 1);
  assert.equal(repository.created?.emailCount, 2);
  assert.deepEqual(repository.scheduledEmails.map((email) => email.recipient), ["ada@example.com", "bob@example.com"]);
  assert.equal(repository.scheduledEmails[0]?.scheduledAt.toISOString(), "2026-11-02T10:00:00.000Z");
  assert.equal(repository.scheduledEmails[1]?.scheduledAt.toISOString(), "2026-11-02T10:00:30.000Z");
  assert.equal(new Set(repository.scheduledEmails.map((email) => email.idempotencyKey)).size, 2);
});

test("campaign creation returns invalid recipients and persists nothing", async () => {
  const { baseUrl, repository } = await startServer();
  const cookie = await login(baseUrl);
  const response = await fetch(`${baseUrl}/api/campaigns`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ ...campaignBody, recipientCsv: "email\nvalid@example.com\nnot-valid" }),
  });

  assert.equal(response.status, 422);
  assert.equal(repository.created, null);
  const result = await response.json() as { validCount: number; invalidRecipients: unknown[] };
  assert.equal(result.validCount, 1);
  assert.equal(result.invalidRecipients.length, 1);
});

test("campaign recipient preview returns valid, duplicate, and invalid counts", async () => {
  const { baseUrl } = await startServer();
  const cookie = await login(baseUrl);
  const response = await fetch(`${baseUrl}/api/campaigns/validate-recipients`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ recipientCsv: "email\nvalid@example.com\nVALID@example.com\nbad" }),
  });

  assert.equal(response.status, 200);
  const result = await response.json() as { validCount: number; duplicateCount: number; invalidCount: number };
  assert.deepEqual(result, {
    totalRows: 3,
    validCount: 1,
    invalidCount: 1,
    duplicateCount: 1,
    recipients: ["valid@example.com"],
    invalidRecipients: [{ row: 4, value: "bad", reason: "INVALID_FORMAT" }],
    duplicates: ["valid@example.com"],
  });
});

test("a 1000-recipient schedule preserves order and the configured spacing", () => {
  const startTime = new Date("2026-11-02T10:00:00.000Z");
  const emails = buildEmailSchedule("campaign-load-probe", {
    senderId: "sender-load-probe",
    subject: "Load probe",
    body: "Not sent by this test",
    startTime,
    delayBetweenEmails: 2,
    hourlyLimit: 200,
  }, Array.from({ length: 1000 }, (_, index) => `recipient${index}@example.test`));

  assert.equal(emails.length, 1000);
  assert.equal(emails[0]?.recipient, "recipient0@example.test");
  assert.equal(emails[999]?.recipient, "recipient999@example.test");
  assert.equal(emails[0]?.scheduledAt.toISOString(), startTime.toISOString());
  assert.equal(emails[999]?.scheduledAt.toISOString(), new Date(startTime.getTime() + 1998_000).toISOString());
  assert.equal(new Set(emails.map((email) => email.idempotencyKey)).size, 1000);
});
