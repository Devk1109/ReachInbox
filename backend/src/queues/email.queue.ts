import { Queue } from "bullmq";
import { createRedisConnection } from "../config/redis";

export const EMAIL_QUEUE_NAME = "reachinbox-email";

export interface EmailJobData {
  emailId: string;
}

export function createEmailQueue(): Queue<EmailJobData> {
  return new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
}
