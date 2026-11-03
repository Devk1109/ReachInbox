import { prisma } from "../../config/database";
import { env } from "../../config/env";
import { AesGcmSecretCipher } from "../../utils/secret-cipher";
import type { SlackIdentity } from "./slack-oauth.service";

export interface ConnectedSlackAccount {
  teamId: string;
  slackUserId: string;
  encryptedAccessToken: string;
}

export interface SlackIntegrationRepository {
  connect(userId: string, identity: SlackIdentity): Promise<void>;
  disconnect(userId: string): Promise<void>;
  findConnectedByUserId(userId: string): Promise<ConnectedSlackAccount | null>;
}

export class PrismaSlackIntegrationRepository implements SlackIntegrationRepository {
  constructor(private readonly cipher = new AesGcmSecretCipher(env.ENCRYPTION_KEY)) {}

  async connect(userId: string, identity: SlackIdentity): Promise<void> {
    const accessToken = this.cipher.encrypt(identity.accessToken);
    await prisma.slackIntegration.upsert({
      where: { userId },
      create: { userId, accessToken, teamId: identity.teamId, slackUserId: identity.slackUserId, connected: true },
      update: { accessToken, teamId: identity.teamId, slackUserId: identity.slackUserId, connected: true },
    });
  }

  async disconnect(userId: string): Promise<void> {
    await prisma.slackIntegration.updateMany({ where: { userId }, data: { connected: false } });
  }

  async findConnectedByUserId(userId: string): Promise<ConnectedSlackAccount | null> {
    const integration = await prisma.slackIntegration.findFirst({
      where: { userId, connected: true },
      select: { teamId: true, slackUserId: true, accessToken: true },
    });
    if (!integration) return null;
    return {
      teamId: integration.teamId,
      slackUserId: integration.slackUserId,
      encryptedAccessToken: integration.accessToken,
    };
  }
}
