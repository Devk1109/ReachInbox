import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, test } from "node:test";
import express from "express";
import session from "express-session";
import { createAuthRouter } from "./auth.routes";
import { requireAuth } from "./auth.middleware";
import type { GoogleProfile, PublicUser } from "./auth.types";

const servers: Server[] = [];
const profile: GoogleProfile = {
  googleId: "google-user-1",
  email: "person@example.com",
  name: "Example Person",
  avatar: "https://example.com/avatar.png",
};
const publicUser: PublicUser = {
  id: "user-1",
  email: profile.email,
  name: profile.name,
  avatar: profile.avatar ?? null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function createApp() {
  const oauth = {
    createAuthorizationUrl: (state: string) => `https://accounts.google.com/auth?state=${state}`,
    authenticateCode: async (_code: string) => profile,
  };
  const users = {
    upsertGoogleUser: async (_profile: GoogleProfile) => publicUser,
    findPublicUser: async (_userId: string) => publicUser,
  };
  const app = express();
  app.use(session({ secret: "test-session-secret-that-is-long-enough", resave: false, saveUninitialized: false }));
  app.use("/api/auth", createAuthRouter(oauth, users, requireAuth(async (id) => ({ id }))));
  return app;
}

async function serve(app: express.Express) {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
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

test("auth endpoints require a signed-in user for /me", async () => {
  const baseUrl = await serve(createApp());
  const response = await fetch(`${baseUrl}/api/auth/me`);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: { code: "UNAUTHENTICATED", message: "Sign in required" },
  });
});

test("Google OAuth validates state, creates a user session, and returns the current user", async () => {
  const baseUrl = await serve(createApp());
  const authorization = await fetch(`${baseUrl}/api/auth/google`, { redirect: "manual" });
  assert.equal(authorization.status, 302);
  const initialCookie = sessionCookie(authorization);
  const authorizationUrl = new URL(authorization.headers.get("location")!);
  const state = authorizationUrl.searchParams.get("state");
  assert.ok(state);

  const mismatch = await fetch(`${baseUrl}/api/auth/google/callback?code=abc&state=wrong`, {
    headers: { cookie: initialCookie },
  });
  assert.equal(mismatch.status, 400);
  assert.deepEqual(await mismatch.json(), {
    error: { code: "INVALID_OAUTH_STATE", message: "Google sign-in state did not match" },
  });

  const callback = await fetch(`${baseUrl}/api/auth/google/callback?code=abc&state=${state}`, {
    headers: { cookie: initialCookie },
    redirect: "manual",
  });
  assert.equal(callback.status, 302);
  const authenticatedCookie = sessionCookie(callback);

  const currentUser = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: authenticatedCookie },
  });
  assert.equal(currentUser.status, 200);
  const result = await currentUser.json() as { user: Record<string, unknown> };
  assert.equal(result.user.id, publicUser.id);
  assert.equal(result.user.email, publicUser.email);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { cookie: authenticatedCookie },
  });
  assert.equal(logout.status, 204);
  const afterLogout = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: authenticatedCookie },
  });
  assert.equal(afterLogout.status, 401);
});
