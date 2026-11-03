import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../../config/env";

export function isValidQueueDashboardAuthorization(authorization: string | undefined, expectedToken: string | undefined): boolean {
  if (!authorization || !expectedToken) return false;
  let providedValue: string;
  if (authorization.startsWith("Bearer ")) {
    providedValue = authorization.slice(7);
  } else if (authorization.startsWith("Basic ")) {
    try {
      const credentials = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = credentials.indexOf(":");
      if (separator < 0 || credentials.slice(0, separator) !== "admin") return false;
      providedValue = credentials.slice(separator + 1);
    } catch {
      return false;
    }
  } else {
    return false;
  }
  const provided = Buffer.from(providedValue);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function createQueueDashboardAuth(token = env.BULL_BOARD_TOKEN): RequestHandler {
  return (request, response, next) => {
    if (!token) {
      response.status(503).json({ error: { code: "QUEUE_DASHBOARD_DISABLED", message: "Queue dashboard access is not configured" } });
      return;
    }
    if (!isValidQueueDashboardAuthorization(request.header("authorization"), token)) {
      response.status(401).set("WWW-Authenticate", 'Basic realm="Bull Board", Bearer').json({ error: { code: "UNAUTHORIZED", message: "Queue dashboard token required" } });
      return;
    }
    next();
  };
}
