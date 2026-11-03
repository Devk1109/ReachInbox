import express from "express";
import helmet from "helmet";
import { sessionMiddleware } from "./config/session";
import { authRouter } from "./modules/auth/auth.routes";
import { campaignRouter } from "./modules/campaigns/campaign.routes";
import { healthRouter } from "./modules/health/health.routes";
import { senderRouter } from "./modules/senders/sender.routes";
import { slackRouter } from "./modules/notifications/slack.routes";
import { emailSearchRouter } from "./modules/search/email-search.routes";
import { emailQueryRouter } from "./modules/emails/email-query.routes";
import { queueDashboard } from "./modules/queues/queue-dashboard";
import { createQueueDashboardAuth } from "./modules/queues/queue-dashboard-auth";

export const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "3mb" }));
app.use(sessionMiddleware);
app.use("/auth", authRouter);
app.use("/api/auth", authRouter);
app.use("/health", healthRouter);
app.use("/api/senders", senderRouter);
app.use("/api/campaigns", campaignRouter);
app.use("/api/slack", slackRouter);
app.use("/api/emails/search", emailSearchRouter);
app.use("/api/emails", emailQueryRouter);
app.use("/admin/queues", createQueueDashboardAuth(), queueDashboard.router);

app.use((_request, response) => {
  response.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled request error", error);
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
});
