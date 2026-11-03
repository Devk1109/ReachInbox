import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { createBullBoard } from "@bull-board/api";
import { ExpressAdapter } from "@bull-board/express";
import { createEmailQueue } from "../../queues/email.queue";
import { createNotificationQueue } from "../../queues/notification.queue";
import { createSearchQueue } from "../../queues/search.queue";

export function createQueueDashboard() {
  const emailQueue = createEmailQueue();
  const notificationQueue = createNotificationQueue();
  const searchQueue = createSearchQueue();
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");
  createBullBoard({
    queues: [
      new BullMQAdapter(emailQueue, { readOnlyMode: true }),
      new BullMQAdapter(notificationQueue, { readOnlyMode: true }),
      new BullMQAdapter(searchQueue, { readOnlyMode: true }),
    ],
    serverAdapter,
  });
  return {
    router: serverAdapter.getRouter(),
    async close() {
      await Promise.all([emailQueue.close(), notificationQueue.close(), searchQueue.close()]);
    },
  };
}

export const queueDashboard = createQueueDashboard();
