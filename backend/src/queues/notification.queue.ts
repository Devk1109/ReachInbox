import { Queue } from "bullmq";
import { createRedisConnection } from "../config/redis";

export const NOTIFICATION_QUEUE_NAME = "reachinbox-notifications";

export interface RateLimitNotificationJobData {
  rateLimitEventId: string;
}

export function createNotificationQueue(): Queue<RateLimitNotificationJobData> {
  return new Queue<RateLimitNotificationJobData>(NOTIFICATION_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
}
