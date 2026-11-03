import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, test } from "node:test";
import express from "express";
import session from "express-session";
import type { SlackIntegrationRepository } from "./slack-integration.repository";
import { createSlackRouter } from "./slack.routes";
import type { SlackIdentity } from "./slack-oauth.service";

const servers: Server[] = [];

class InMemorySlackRepository implements SlackIntegrationRepository {
  connectedUserId: string | null = null;
  identity: SlackIdentity | null = null;

  async connect(userId: string, identity: SlackIdentity): Promise<void> {
    this.connectedUserId = userId;
    this.identity = identity;
  }

  async disconnect(userId: string): Promise<void> {
    if (this.connectedUserId === userId) this.connectedUserId = null;
  }

  async findConnectedByUserId(userId: string) {
    return userId === this.connectedUserId && this.identity
      ? { teamId: this.identity.teamId, slackUserId: this.identity.slackUserId, encryptedAccessToken: "ciphertext" }
      : null;
  }
}

async function startServer(repository = new InMemorySlackRepository()) {
  const identity: SlackIdentity = { accessToken: "xoxb-test-token", teamId: "team-1", slackUserId: "slack-user-1" };
  const oauth = {
    createAuthorizationUrl: (state: string) => `https://slack.com/oauth/v2/authorize?state=${state}`,
    async exchangeCode(_code: string) { return identity; },
  };
  const requireTestUser: express.RequestHandler = (request, _response, next) => {
    request.auth = { userId: "user-1" };
    next();
  };
  const app = express();
  app.use(session({ secret: "slack-test-session-secret-long-enough", resave: false, saveUninitialized: false }));
  app.use("/api/slack", createSlackRouter(oauth, repository, requireTestUser));
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}`, repository };
}

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert.ok(value);
  return value.split(";", 1)[0]!;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

test("Slack connection validates OAuth state and stores the authenticated user's integration", async () => {
  const { baseUrl, repository } = await startServer();
  const connect = await fetch(`${baseUrl}/api/slack/connect`, { redirect: "manual" });
  assert.equal(connect.status, 302);
  const cookie = cookieFrom(connect);
  const state = new URL(connect.headers.get("location")!).searchParams.get("state");
  assert.ok(state);

  const invalid = await fetch(`${baseUrl}/api/slack/callback?code=code&state=wrong`, { headers: { cookie } });
  assert.equal(invalid.status, 400);
  assert.equal(repository.connectedUserId, null);

  const callback = await fetch(`${baseUrl}/api/slack/callback?code=code&state=${state}`, {
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(callback.status, 302);
  assert.equal(repository.connectedUserId, "user-1");
  assert.equal(repository.identity?.teamId, "team-1");
  assert.equal(repository.identity?.accessToken, "xoxb-test-token");
});

test("Slack disconnect only removes the current user's connection", async () => {
  const { baseUrl, repository } = await startServer();
  const statusBefore = await fetch(`${baseUrl}/api/slack/status`);
  assert.deepEqual(await statusBefore.json(), { connected: false, configured: false, teamId: null });

  repository.connectedUserId = "someone-else";
  const response = await fetch(`${baseUrl}/api/slack/disconnect`, { method: "DELETE" });
  assert.equal(response.status, 204);
  assert.equal(repository.connectedUserId, "someone-else");

  repository.connectedUserId = "user-1";
  repository.identity = { accessToken: "token", teamId: "team-1", slackUserId: "U1" };
  const statusAfter = await fetch(`${baseUrl}/api/slack/status`);
  assert.deepEqual(await statusAfter.json(), { connected: true, configured: false, teamId: "team-1" });
});
