import { Queue } from "bullmq";
import { createRedisConnection } from "../config/redis";

export const SEARCH_QUEUE_NAME = "reachinbox-search-index";

export interface EmailIndexJobData {
  emailId: string;
  outboxEventId: string;
}

export function createSearchQueue(): Queue<EmailIndexJobData> {
  return new Queue<EmailIndexJobData>(SEARCH_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 8,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
}
