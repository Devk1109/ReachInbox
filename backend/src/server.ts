import { app } from "./app";
import { prisma } from "./config/database";
import { env } from "./config/env";
import { queueDashboard } from "./modules/queues/queue-dashboard";

const server = app.listen(env.PORT, () => {
  console.info(`ReachInbox API listening on port ${env.PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  console.info(`${signal} received; shutting down API`);
  server.close(async () => {
    await queueDashboard.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
