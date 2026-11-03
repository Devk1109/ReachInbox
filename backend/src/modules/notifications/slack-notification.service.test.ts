import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SlackNotificationService,
  SlackWebApiClient,
  type RateLimitNotification,
  type RateLimitNotificationRepository,
} from "./slack-notification.service";

class InMemoryNotificationRepository implements RateLimitNotificationRepository {
  notified = false;
  constructor(readonly event: RateLimitNotification | null) {}
  async findById(_eventId: string) { return this.event; }
  async markNotified(_eventId: string) { this.notified = true; return true; }
}

const event: RateLimitNotification = {
  id: "event-123",
  notifiedAt: null,
  retryAt: new Date("2026-11-02T13:00:00.000Z"),
  senderEmail: "sender@example.com",
  slackUserId: "U123",
  accessToken: "xoxb-token",
};

test("Slack client opens a DM and sends an idempotent rate-limit notice", async () => {
  const calls: Array<{ url: string; headers: HeadersInit; body: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), headers: init?.headers ?? {}, body: String(init?.body) });
    return new Response(calls.length === 1
      ? JSON.stringify({ ok: true, channel: { id: "D123" } })
      : JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = new SlackWebApiClient(fetcher);
  await client.sendDirectMessage("xoxb-token", "U123", event.id, "Rate limit reached");

  assert.deepEqual(calls.map((call) => call.url), [
    "https://slack.com/api/conversations.open",
    "https://slack.com/api/chat.postMessage",
  ]);
  assert.equal(JSON.parse(calls[0]!.body).users, "U123");
  assert.equal(JSON.parse(calls[1]!.body).channel, "D123");
  assert.equal(JSON.parse(calls[1]!.body).client_msg_id, event.id);
  assert.equal(new Headers(calls[0]!.headers).get("authorization"), "Bearer xoxb-token");
});

test("Slack notification is marked only after successful API delivery", async () => {
  const repository = new InMemoryNotificationRepository(event);
  let sentMessage = "";
  const service = new SlackNotificationService(repository, {
    async sendDirectMessage(_token, _userId, _clientId, text) { sentMessage = text; },
  });

  assert.equal(await service.notifyRateLimitReached(event.id), "SENT");
  assert.equal(repository.notified, true);
  assert.match(sentMessage, /sender@example.com/);
  assert.match(sentMessage, /2026-11-02 13:00:00 UTC/);
});

test("Slack notification skips absent or already-notified events", async () => {
  const absent = new SlackNotificationService(new InMemoryNotificationRepository(null), {
    async sendDirectMessage() { assert.fail("should not send"); },
  });
  assert.equal(await absent.notifyRateLimitReached(event.id), "SKIPPED");

  const alreadyNotified = new SlackNotificationService(
    new InMemoryNotificationRepository({ ...event, notifiedAt: new Date() }),
    { async sendDirectMessage() { assert.fail("should not send"); } },
  );
  assert.equal(await alreadyNotified.notifyRateLimitReached(event.id), "SKIPPED");
});

test("notifications start working after the account reconnects without rebuilding the service", async () => {
  let connected = false;
  const repository: RateLimitNotificationRepository = {
    async findById() { return connected ? event : null; },
    async markNotified() { return true; },
  };
  let sendCount = 0;
  const service = new SlackNotificationService(repository, {
    async sendDirectMessage() { sendCount += 1; },
  });

  assert.equal(await service.notifyRateLimitReached(event.id), "SKIPPED");
  connected = true;
  assert.equal(await service.notifyRateLimitReached(event.id), "SENT");
  assert.equal(sendCount, 1);
});

test("Slack API errors are surfaced so the notification job can retry", async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 200 });
  const client = new SlackWebApiClient(fetcher);
  await assert.rejects(client.sendDirectMessage("token", "U123", event.id, "message"), /ratelimited/);
});
