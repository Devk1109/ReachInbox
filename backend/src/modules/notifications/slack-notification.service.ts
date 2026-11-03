import { prisma } from "../../config/database";
import { env } from "../../config/env";
import { AesGcmSecretCipher } from "../../utils/secret-cipher";

export interface RateLimitNotification {
  id: string;
  notifiedAt: Date | null;
  retryAt: Date;
  senderEmail: string;
  slackUserId: string;
  accessToken: string;
}

export interface RateLimitNotificationRepository {
  findById(eventId: string): Promise<RateLimitNotification | null>;
  markNotified(eventId: string): Promise<boolean>;
}

export class PrismaRateLimitNotificationRepository implements RateLimitNotificationRepository {
  constructor(private readonly cipher = new AesGcmSecretCipher(env.ENCRYPTION_KEY)) {}

  async findById(eventId: string): Promise<RateLimitNotification | null> {
    const event = await prisma.rateLimitEvent.findUnique({
      where: { id: eventId },
      include: {
        sender: {
          select: {
            email: true,
            user: { select: { slackIntegration: { select: { connected: true, accessToken: true, slackUserId: true } } } },
          },
        },
      },
    });
    const integration = event?.sender.user.slackIntegration;
    if (!event || !integration?.connected) return null;
    return {
      id: event.id,
      notifiedAt: event.notifiedAt,
      retryAt: event.retryAt,
      senderEmail: event.sender.email,
      slackUserId: integration.slackUserId,
      accessToken: this.cipher.decrypt(integration.accessToken),
    };
  }

  async markNotified(eventId: string): Promise<boolean> {
    const result = await prisma.rateLimitEvent.updateMany({
      where: { id: eventId, notifiedAt: null },
      data: { notifiedAt: new Date() },
    });
    return result.count > 0;
  }
}

export class SlackWebApiClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async sendDirectMessage(accessToken: string, slackUserId: string, clientMessageId: string, text: string): Promise<void> {
    const openResponse = await this.request(accessToken, "conversations.open", { users: slackUserId });
    const channelId = openResponse.channel?.id;
    if (!channelId) throw new Error("Slack did not return a direct-message channel");
    await this.request(accessToken, "chat.postMessage", {
      channel: channelId,
      text,
      client_msg_id: clientMessageId,
    });
  }

  private async request(accessToken: string, method: string, body: Record<string, string>): Promise<{ channel?: { id?: string } }> {
    const response = await this.fetcher(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Slack ${method} failed with HTTP ${response.status}`);
    const result = await response.json() as { ok?: boolean; error?: string; channel?: { id?: string } };
    if (!result.ok) throw new Error(`Slack ${method} failed${result.error ? `: ${result.error}` : ""}`);
    return result;
  }
}

export class SlackNotificationService {
  constructor(
    private readonly repository: RateLimitNotificationRepository = new PrismaRateLimitNotificationRepository(),
    private readonly client: Pick<SlackWebApiClient, "sendDirectMessage"> = new SlackWebApiClient(),
  ) {}

  async notifyRateLimitReached(eventId: string): Promise<"SENT" | "SKIPPED"> {
    const event = await this.repository.findById(eventId);
    if (!event || event.notifiedAt) return "SKIPPED";
    const retryTime = event.retryAt.toISOString().replace("T", " ").replace(".000Z", " UTC");
    const message = `The hourly sending limit for ${event.senderEmail} has been reached. Scheduled emails will resume after ${retryTime}.`;
    await this.client.sendDirectMessage(event.accessToken, event.slackUserId, event.id, message);
    await this.repository.markNotified(event.id);
    return "SENT";
  }
}
