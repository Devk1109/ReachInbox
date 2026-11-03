import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { env } from "../../config/env";
import { prisma } from "../../config/database";
import { requireAuth } from "./auth.middleware";
import type { GoogleProfile, PublicUser } from "./auth.types";
import { GoogleOAuthService } from "./google-oauth.service";

interface OAuthProvider {
  createAuthorizationUrl(state: string): string;
  authenticateCode(code: string): Promise<GoogleProfile>;
}

interface UserRepository {
  upsertGoogleUser(profile: GoogleProfile): Promise<PublicUser>;
  findPublicUser(userId: string): Promise<PublicUser | null>;
}

const userRepository: UserRepository = {
  async upsertGoogleUser(profile) {
    const user = await prisma.user.upsert({
      where: { googleId: profile.googleId },
      create: {
        googleId: profile.googleId,
        email: profile.email,
        name: profile.name,
        avatar: profile.avatar,
      },
      update: {
        email: profile.email,
        name: profile.name,
        avatar: profile.avatar,
      },
      select: { id: true, name: true, email: true, avatar: true, createdAt: true },
    });
    return user;
  },
  findPublicUser(userId) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, avatar: true, createdAt: true },
    });
  },
};

function matchesState(received: unknown, expected: string | undefined): boolean {
  if (typeof received !== "string" || !expected) return false;
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

function regenerateSession(request: Express.Request): Promise<void> {
  return new Promise((resolve, reject) => {
    request.session.regenerate((error) => error ? reject(error) : resolve());
  });
}

function saveSession(request: Express.Request): Promise<void> {
  return new Promise((resolve, reject) => {
    request.session.save((error) => error ? reject(error) : resolve());
  });
}

export function createAuthRouter(
  oauth: OAuthProvider = new GoogleOAuthService(),
  users: UserRepository = userRepository,
  ensureAuthenticated: ReturnType<typeof requireAuth> = requireAuth(),
): Router {
  const router = Router();

  router.get("/google", (request, response, next) => {
    try {
      const state = randomBytes(32).toString("hex");
      request.session.oauthState = state;
      response.redirect(oauth.createAuthorizationUrl(state));
    } catch (error) {
      next(error);
    }
  });

  router.get("/google/callback", async (request, response, next) => {
    const { code, state, error } = request.query;
    if (error) {
      response.status(400).json({ error: { code: "OAUTH_DENIED", message: "Google sign-in was cancelled" } });
      return;
    }
    if (!matchesState(state, request.session.oauthState)) {
      response.status(400).json({ error: { code: "INVALID_OAUTH_STATE", message: "Google sign-in state did not match" } });
      return;
    }
    delete request.session.oauthState;
    if (typeof code !== "string" || !code) {
      response.status(400).json({ error: { code: "MISSING_OAUTH_CODE", message: "Google did not return an authorization code" } });
      return;
    }

    try {
      const profile = await oauth.authenticateCode(code);
      const user = await users.upsertGoogleUser(profile);
      await regenerateSession(request);
      request.session.userId = user.id;
      await saveSession(request);
      response.redirect(env.FRONTEND_URL);
    } catch (requestError) {
      next(requestError);
    }
  });

  router.get("/me", ensureAuthenticated, async (request, response, next) => {
    try {
      const user = await users.findPublicUser(request.auth!.userId);
      if (!user) {
        response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in required" } });
        return;
      }
      response.json({ user });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", ensureAuthenticated, async (request, response, next) => {
    request.session.destroy((error) => {
      if (error) {
        next(error);
        return;
      }
      response.clearCookie("reachinbox.sid", { httpOnly: true, sameSite: "lax", secure: env.NODE_ENV === "production" });
      response.status(204).end();
    });
  });

  return router;
}

export const authRouter = createAuthRouter();
