import { prisma } from "./config/database";
import { env } from "./config/env";
import { createRedisConnection } from "./config/redis";
import { createEmailQueue, EMAIL_QUEUE_NAME, type EmailJobData } from "./queues/email.queue";
import { createNotificationQueue, NOTIFICATION_QUEUE_NAME, type RateLimitNotificationJobData } from "./queues/notification.queue";
import { createSearchQueue, SEARCH_QUEUE_NAME, type EmailIndexJobData } from "./queues/search.queue";
import {
  BullMqEmailJobPublisher,
  BullMqNotificationJobPublisher,
  BullMqSearchJobPublisher,
  OutboxDispatcher,
  PrismaOutboxRepository,
} from "./modules/outbox/outbox-dispatcher";
import { Worker } from "bullmq";
import { AesGcmSecretCipher } from "./utils/secret-cipher";
import { EmailProcessingService, PrismaEmailProcessingRepository } from "./modules/emails/email-processing.service";
import { EmailRecoveryService } from "./modules/emails/email-recovery.service";
import { PrismaScheduledEmailQueueRepository, ScheduledEmailQueueReconciliationService } from "./modules/emails/email-queue-reconciliation.service";
import { SmtpEmailProvider } from "./modules/emails/email-provider";
import { RedisRateLimiter } from "./modules/rate-limiter/redis-rate-limiter";
import { SlackNotificationService } from "./modules/notifications/slack-notification.service";
import { EmailSearchService } from "./modules/search/email-search.service";

const emailQueue = createEmailQueue();
const emailPublisher = new BullMqEmailJobPublisher(emailQueue);
const notificationQueue = createNotificationQueue();
const searchQueue = createSearchQueue();
const dispatcher = new OutboxDispatcher(
  emailPublisher,
  new PrismaOutboxRepository(),
  new BullMqNotificationJobPublisher(notificationQueue),
  new BullMqSearchJobPublisher(searchQueue),
);
const recoveryService = new EmailRecoveryService();
const scheduledQueueReconciliation = new ScheduledEmailQueueReconciliationService(
  new PrismaScheduledEmailQueueRepository(),
  emailPublisher,
  emailQueue,
);
const processingService = new EmailProcessingService(
  new PrismaEmailProcessingRepository(),
  new SmtpEmailProvider(new AesGcmSecretCipher(env.ENCRYPTION_KEY)),
  new RedisRateLimiter(createRedisConnection()),
);
const emailWorker = new Worker<EmailJobData>(
  EMAIL_QUEUE_NAME,
  async (job) => processingService.process(job.data.emailId, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)),
  { connection: createRedisConnection(), concurrency: env.WORKER_CONCURRENCY },
);
const slackNotificationService = new SlackNotificationService();
const notificationWorker = new Worker<RateLimitNotificationJobData>(
  NOTIFICATION_QUEUE_NAME,
  async (job) => slackNotificationService.notifyRateLimitReached(job.data.rateLimitEventId),
  { connection: createRedisConnection(), concurrency: 2 },
);
const emailSearchService = new EmailSearchService();
const searchWorker = new Worker<EmailIndexJobData>(
  SEARCH_QUEUE_NAME,
  async (job) => emailSearchService.indexEmail(job.data.emailId),
  { connection: createRedisConnection(), concurrency: 4 },
);
let stopping = false;
let lastRecoveryAt = 0;
let lastQueueReconciliationAt = 0;

emailWorker.on("failed", (job, error) => {
  console.error("Email job failed", { jobId: job?.id, emailId: job?.data.emailId, message: error.message });
});
emailWorker.on("error", (error) => console.error("Email worker error", error));
notificationWorker.on("failed", (job, error) => {
  console.error("Slack notification job failed", { jobId: job?.id, message: error.message });
});
notificationWorker.on("error", (error) => console.error("Notification worker error", error));
searchWorker.on("failed", (job, error) => {
  console.error("Email search indexing job failed", { jobId: job?.id, emailId: job?.data.emailId, message: error.message });
});
searchWorker.on("error", (error) => console.error("Search worker error", error));

async function main(): Promise<void> {
  await prisma.$connect();
  console.info("ReachInbox worker process started");
  while (!stopping) {
    if (Date.now() - lastQueueReconciliationAt >= 60_000) {
      try {
        const result = await scheduledQueueReconciliation.reconcile();
        if (result.published > 0) console.info("Scheduled email queue reconciled", result);
      } catch (error) {
        console.error("Scheduled email queue reconciliation failed", error);
      } finally {
        lastQueueReconciliationAt = Date.now();
      }
    }
    if (Date.now() - lastRecoveryAt >= 60_000) {
      try {
        const recovered = await recoveryService.reconcileStaleProcessing();
        if (recovered.unknown > 0 || recovered.rescheduled > 0) console.warn("Stale email work reconciled", recovered);
        lastRecoveryAt = Date.now();
      } catch (error) {
        console.error("Email recovery failed", error);
      }
    }
    try {
      const result = await dispatcher.dispatchBatch();
      if (result.published > 0 || result.failed > 0) console.info("Outbox batch processed", result);
    } catch (error) {
      console.error("Outbox dispatcher failed", error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function shutdown(signal: string): Promise<void> {
  console.info(`${signal} received; shutting down worker`);
  stopping = true;
  await Promise.all([
    emailWorker.close(),
    notificationWorker.close(),
    searchWorker.close(),
    emailQueue.close(),
    notificationQueue.close(),
    searchQueue.close(),
  ]);
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

void main().catch((error: unknown) => {
  console.error("Worker failed to start", error);
  process.exitCode = 1;
});
