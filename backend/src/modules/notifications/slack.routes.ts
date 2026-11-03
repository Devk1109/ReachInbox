import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { env } from "../../config/env";
import { requireAuth } from "../auth/auth.middleware";
import { PrismaSlackIntegrationRepository, type SlackIntegrationRepository } from "./slack-integration.repository";
import { SlackOAuthService, type SlackIdentity } from "./slack-oauth.service";

interface SlackOAuthProvider {
  createAuthorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<SlackIdentity>;
}

function matchesState(received: unknown, expected: string | undefined): boolean {
  if (typeof received !== "string" || !expected) return false;
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

export function createSlackRouter(
  oauth: SlackOAuthProvider = new SlackOAuthService(),
  repository: SlackIntegrationRepository = new PrismaSlackIntegrationRepository(),
  ensureAuthenticated: RequestHandler = requireAuth(),
): Router {
  const router = Router();
  router.use(ensureAuthenticated);

  router.get("/connect", (request, response, next) => {
    try {
      const state = randomBytes(32).toString("hex");
      request.session.slackOAuthState = state;
      response.redirect(oauth.createAuthorizationUrl(state));
    } catch (error) {
      next(error);
    }
  });

  router.get("/callback", async (request, response, next) => {
    const { code, state, error } = request.query;
    if (error) {
      response.status(400).json({ error: { code: "SLACK_OAUTH_DENIED", message: "Slack connection was cancelled" } });
      return;
    }
    if (!matchesState(state, request.session.slackOAuthState)) {
      response.status(400).json({ error: { code: "INVALID_OAUTH_STATE", message: "Slack connection state did not match" } });
      return;
    }
    delete request.session.slackOAuthState;
    if (typeof code !== "string" || !code) {
      response.status(400).json({ error: { code: "MISSING_OAUTH_CODE", message: "Slack did not return an authorization code" } });
      return;
    }

    try {
      const identity = await oauth.exchangeCode(code);
      await repository.connect(request.auth!.userId, identity);
      const redirectUrl = new URL("/", env.FRONTEND_URL);
      redirectUrl.searchParams.set("slack", "connected");
      response.redirect(redirectUrl.toString());
    } catch (error) {
      next(error);
    }
  });

  router.delete("/disconnect", async (request, response, next) => {
    try {
      await repository.disconnect(request.auth!.userId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/status", async (request, response, next) => {
    try {
      const integration = await repository.findConnectedByUserId(request.auth!.userId);
      response.json({
        connected: Boolean(integration),
        configured: Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET),
        teamId: integration?.teamId ?? null,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const slackRouter = createSlackRouter();
