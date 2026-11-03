import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { RequestHandler } from "express";
import express from "express";
import { afterEach, test } from "node:test";
import type { EmailDetail } from "./email-query.service";
import { createEmailQueryRouter } from "./email-query.routes";

const servers: Server[] = [];

async function serve(app: express.Express) {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

test("star, archive, recycle-bin, and restore endpoints update owner-scoped email state", async () => {
  let email: EmailDetail = {
    id: "email-1",
    campaignId: "campaign-1",
    senderId: "sender-1",
    senderEmail: "sender@example.com",
    recipient: "recipient@example.com",
    subject: "Hello",
    scheduledAt: new Date("2026-11-02T10:00:00.000Z"),
    sentAt: null,
    status: "SCHEDULED" as EmailDetail["status"],
    isStarred: false,
    archivedAt: null,
    trashedAt: null,
    retryCount: 0,
    errorMessage: null,
    body: "Message body",
    events: [],
  };
  const service = {
    list: async () => ({ total: 0, emails: [] }),
    find: async (userId: string, id: string) => userId === "user-1" && id === email.id ? email : null,
    updateMailboxState: async (userId: string, id: string, data: Partial<Pick<EmailDetail, "isStarred" | "archivedAt" | "trashedAt">>) => {
      if (userId !== "user-1" || id !== email.id) return null;
      email = { ...email, ...data };
      return email;
    },
  };
  const authenticate: RequestHandler = (request, _response, next) => { request.auth = { userId: "user-1" }; next(); };
  const app = express();
  app.use(express.json());
  app.use("/api/emails", createEmailQueryRouter(service, authenticate, async () => undefined));
  const baseUrl = await serve(app);

  const star = await fetch(`${baseUrl}/api/emails/email-1/star`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isStarred: true }) });
  assert.equal(star.status, 200);
  assert.equal((await star.json() as { email: EmailDetail }).email.isStarred, true);

  const archive = await fetch(`${baseUrl}/api/emails/email-1/archive`, { method: "POST" });
  assert.equal(archive.status, 200);
  assert.ok(email.archivedAt instanceof Date);

  const trash = await fetch(`${baseUrl}/api/emails/email-1/trash`, { method: "POST" });
  assert.equal(trash.status, 200);
  assert.ok(email.trashedAt instanceof Date);
  assert.equal(email.archivedAt, null);

  const restore = await fetch(`${baseUrl}/api/emails/email-1/restore`, { method: "POST" });
  assert.equal(restore.status, 200);
  assert.equal(email.archivedAt, null);
  assert.equal(email.trashedAt, null);
  assert.equal(email.isStarred, true);
});

test("star endpoint rejects invalid state and does not update an unknown email", async () => {
  const service = {
    list: async () => ({ total: 0, emails: [] }),
    find: async () => null,
    updateMailboxState: async () => null,
  };
  const authenticate: RequestHandler = (request, _response, next) => { request.auth = { userId: "user-1" }; next(); };
  const app = express();
  app.use(express.json());
  app.use("/api/emails", createEmailQueryRouter(service, authenticate, async () => undefined));
  const baseUrl = await serve(app);

  const invalid = await fetch(`${baseUrl}/api/emails/missing/star`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isStarred: "yes" }) });
  assert.equal(invalid.status, 400);
  const missing = await fetch(`${baseUrl}/api/emails/missing/archive`, { method: "POST" });
  assert.equal(missing.status, 404);
});
