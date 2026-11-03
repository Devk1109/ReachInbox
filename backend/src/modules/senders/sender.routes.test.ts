import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, test } from "node:test";
import express from "express";
import session from "express-session";
import { requireAuth } from "../auth/auth.middleware";
import { createSenderRouter } from "./sender.routes";
import {
  SenderService,
  type SafeSender,
  type SenderCreateFields,
  type SenderRepository,
  type SenderUpdateFields,
  type EtherealSmtpConfig,
} from "./sender.service";
import { AesGcmSecretCipher } from "../../utils/secret-cipher";

const servers: Server[] = [];
const cipher = new AesGcmSecretCipher("ab".repeat(32));

class InMemorySenderRepository implements SenderRepository {
  records: SafeSender[] = [];
  storedPassword = "";

  async listByUser(userId: string): Promise<SafeSender[]> {
    return this.records.filter((sender) => sender.userId === userId);
  }

  async create(userId: string, input: SenderCreateFields, encryptedPassword: string): Promise<SafeSender> {
    this.storedPassword = encryptedPassword;
    const now = new Date();
    const sender: SafeSender = {
      id: "sender-1",
      userId,
      ...input,
      isActive: input.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(sender);
    return sender;
  }

  async update(userId: string, senderId: string, input: SenderUpdateFields, encryptedPassword?: string): Promise<SafeSender | null> {
    const current = this.records.find((sender) => sender.id === senderId && sender.userId === userId);
    if (!current) return null;
    if (encryptedPassword) this.storedPassword = encryptedPassword;
    Object.assign(current, input, { updatedAt: new Date() });
    return current;
  }

  async delete(userId: string, senderId: string): Promise<boolean> {
    const before = this.records.length;
    this.records = this.records.filter((sender) => sender.id !== senderId || sender.userId !== userId);
    return this.records.length < before;
  }
}

async function startServer(repository = new InMemorySenderRepository(), ethereal: EtherealSmtpConfig = { host: "smtp.ethereal.email", port: 587 }) {
  const service = new SenderService(repository, cipher, ethereal);
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "sender-test-session-secret-long-enough", resave: false, saveUninitialized: false }));
  app.get("/test-login", (request, response) => {
    request.session.userId = "user-1";
    response.status(204).end();
  });
  app.use("/api/senders", createSenderRouter(service, requireAuth(async (id) => ({ id }))));

  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}`, repository };
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie);
  return cookie.split(";", 1)[0]!;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

test("sender endpoints require authentication", async () => {
  const { baseUrl } = await startServer();
  const response = await fetch(`${baseUrl}/api/senders`);
  assert.equal(response.status, 401);
});

test("sender credentials are encrypted and never returned", async () => {
  const { baseUrl, repository } = await startServer();
  const login = await fetch(`${baseUrl}/test-login`);
  const cookie = sessionCookie(login);
  const response = await fetch(`${baseUrl}/api/senders`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      email: "sender@example.com",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpUsername: "sender@example.com",
      smtpPassword: "plain-secret-password",
      hourlyLimit: 150,
      minDelaySeconds: 2,
    }),
  });

  assert.equal(response.status, 201);
  const body = await response.json() as { sender: Record<string, unknown> };
  assert.equal(body.sender.email, "sender@example.com");
  assert.equal("smtpPassword" in body.sender, false);
  assert.notEqual(repository.storedPassword, "plain-secret-password");
  assert.equal(cipher.decrypt(repository.storedPassword), "plain-secret-password");
});

test("sender input rejects an invalid SMTP port", async () => {
  const { baseUrl } = await startServer();
  const login = await fetch(`${baseUrl}/test-login`);
  const cookie = sessionCookie(login);
  const response = await fetch(`${baseUrl}/api/senders`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      email: "sender@example.com",
      smtpHost: "smtp.example.com",
      smtpPort: 70_000,
      smtpUsername: "sender@example.com",
      smtpPassword: "secret",
      hourlyLimit: 150,
      minDelaySeconds: 2,
    }),
  });
  assert.equal(response.status, 400);
});

test("Ethereal sender endpoint uses environment credentials and encrypts the password", async () => {
  const { baseUrl, repository } = await startServer(new InMemorySenderRepository(), {
    host: "smtp.ethereal.email", port: 587, username: "ethereal-user", password: "ethereal-password",
  });
  const cookie = sessionCookie(await fetch(`${baseUrl}/test-login`));
  const response = await fetch(`${baseUrl}/api/senders/ethereal`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ email: "outbox@example.test", hourlyLimit: 50, minDelaySeconds: 2 }),
  });

  assert.equal(response.status, 201);
  const body = await response.json() as { sender: Record<string, unknown> };
  assert.equal(body.sender.smtpHost, "smtp.ethereal.email");
  assert.equal(body.sender.smtpPort, 587);
  assert.equal("smtpPassword" in body.sender, false);
  assert.equal(cipher.decrypt(repository.storedPassword), "ethereal-password");
});

test("Ethereal sender endpoint clearly reports missing test-account credentials", async () => {
  const { baseUrl } = await startServer();
  const cookie = sessionCookie(await fetch(`${baseUrl}/test-login`));
  const response = await fetch(`${baseUrl}/api/senders/ethereal`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ email: "outbox@example.test", hourlyLimit: 50, minDelaySeconds: 2 }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "ETHEREAL_NOT_CONFIGURED");
});

test("encrypted secrets reject tampering", () => {
  const encoded = cipher.encrypt("smtp-password");
  const parts = encoded.split(".");
  const tag = parts[2]!;
  parts[2] = `${tag[0] === "A" ? "B" : "A"}${tag.slice(1)}`;
  const tampered = parts.join(".");
  assert.throws(() => cipher.decrypt(tampered));
});
