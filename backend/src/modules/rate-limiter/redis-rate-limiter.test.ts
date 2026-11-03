import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRateLimitReply, RedisRateLimiter, RESERVE_SEND_SLOT_SCRIPT } from "./redis-rate-limiter";

test("rate-limit reply parser returns an allowed result", () => {
  assert.deepEqual(parseRateLimitReply([1, 1_800_000_000_000, ""]), { allowed: true });
});

test("rate-limit reply parser returns retry times and block reasons", () => {
  assert.deepEqual(parseRateLimitReply([0, 1_800_000_003_000, "MIN_DELAY"]), {
    allowed: false,
    retryAt: new Date(1_800_000_003_000),
    reason: "MIN_DELAY",
  });
  assert.equal(parseRateLimitReply([0, 1_800_003_600_000, "HOURLY_LIMIT"]).reason, "HOURLY_LIMIT");
});

test("rate limiter uses one atomic Lua reservation for hourly and delay constraints", async () => {
  let call: { script: string; keys: string[]; args: string[] } | undefined;
  const redis = {
    async eval(script: string, numberOfKeys: number, ...values: Array<string | number>) {
      call = {
        script,
        keys: values.slice(0, numberOfKeys).map(String),
        args: values.slice(numberOfKeys).map(String),
      };
      return [0, 1_800_000_000_000, "HOURLY_LIMIT"];
    },
  };
  const result = await new RedisRateLimiter(redis).reserveSendSlot("sender-1", 200, 2);

  assert.equal(result.reason, "HOURLY_LIMIT");
  assert.deepEqual(call?.keys, ["rate_limit:{sender-1}", "last_send:{sender-1}"]);
  assert.deepEqual(call?.args, ["200", "2"]);
  assert.equal(call?.script, RESERVE_SEND_SLOT_SCRIPT);
});

test("rate limiter rejects invalid configuration and malformed Redis replies", async () => {
  const limiter = new RedisRateLimiter({ async eval() { return "bad"; } });
  await assert.rejects(limiter.reserveSendSlot("", 10, 1), /Invalid sender/);
  await assert.rejects(limiter.reserveSendSlot("sender", 0, 1), /Invalid sender/);
  await assert.rejects(limiter.reserveSendSlot("sender", 10, -1), /Invalid sender/);
  assert.throws(() => parseRateLimitReply("bad"), /invalid response/);
});
