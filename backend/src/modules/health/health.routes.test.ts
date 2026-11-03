import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, test } from "node:test";
import express from "express";
import { createHealthRouter } from "./health.routes";

const servers: Server[] = [];

async function requestHealth(checkDatabase: () => Promise<unknown>) {
  const app = express();
  app.use("/health", createHealthRouter(checkDatabase));
  const server = createServer(app);
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  return { response, body: await response.json() as Record<string, unknown> };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

test("health endpoint reports success when the database check succeeds", async () => {
  const { response, body } = await requestHealth(async () => undefined);

  assert.equal(response.status, 200);
  assert.deepEqual(body, { status: "ok", checks: { database: "ok" } });
});

test("health endpoint reports unavailable when the database check fails", async () => {
  const { response, body } = await requestHealth(async () => {
    throw new Error("database unavailable");
  });

  assert.equal(response.status, 503);
  assert.deepEqual(body, { status: "unavailable", checks: { database: "error" } });
});
