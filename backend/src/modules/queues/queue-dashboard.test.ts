import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidQueueDashboardAuthorization } from "./queue-dashboard-auth";

test("queue dashboard requires an exact bearer token", () => {
  assert.equal(isValidQueueDashboardAuthorization("Bearer secret-token", "secret-token"), true);
  assert.equal(isValidQueueDashboardAuthorization(`Basic ${Buffer.from("admin:secret-token").toString("base64")}`, "secret-token"), true);
  assert.equal(isValidQueueDashboardAuthorization(`Basic ${Buffer.from("other:secret-token").toString("base64")}`, "secret-token"), false);
  assert.equal(isValidQueueDashboardAuthorization("Bearer wrong-token", "secret-token"), false);
  assert.equal(isValidQueueDashboardAuthorization("secret-token", "secret-token"), false);
  assert.equal(isValidQueueDashboardAuthorization(undefined, "secret-token"), false);
  assert.equal(isValidQueueDashboardAuthorization("Bearer secret-token", undefined), false);
});
