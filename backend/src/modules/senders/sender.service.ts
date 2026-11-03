import type { Prisma, Sender } from "@prisma/client";
import { prisma } from "../../config/database";
import { env } from "../../config/env";
import { AesGcmSecretCipher } from "../../utils/secret-cipher";

const senderSelect = {
  id: true,
  userId: true,
  email: true,
  smtpHost: true,
  smtpPort: true,
  smtpUsername: true,
  hourlyLimit: true,
  minDelaySeconds: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SenderSelect;

export type SafeSender = Omit<Sender, "smtpPassword">;
export type SenderCreateInput = {
  email: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string;
  hourlyLimit: number;
  minDelaySeconds: number;
  isActive?: boolean;
};
export type SenderUpdateInput = Partial<SenderCreateInput>;
export type SenderCreateFields = Omit<SenderCreateInput, "smtpPassword">;
export type SenderUpdateFields = Partial<SenderCreateFields>;

export interface EtherealSenderInput {
  email: string;
  hourlyLimit: number;
  minDelaySeconds: number;
}

export interface EtherealSmtpConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export class EtherealSenderNotConfiguredError extends Error {
  constructor() {
    super("Configure ETHEREAL_USER and ETHEREAL_PASS in the backend environment first");
  }
}

export interface SenderRepository {
  listByUser(userId: string): Promise<SafeSender[]>;
  create(userId: string, input: SenderCreateFields, encryptedPassword: string): Promise<SafeSender>;
  update(userId: string, senderId: string, input: SenderUpdateFields, encryptedPassword?: string): Promise<SafeSender | null>;
  delete(userId: string, senderId: string): Promise<boolean>;
}

export class PrismaSenderRepository implements SenderRepository {
  listByUser(userId: string): Promise<SafeSender[]> {
    return prisma.sender.findMany({ where: { userId }, select: senderSelect, orderBy: { createdAt: "desc" } });
  }

  create(userId: string, input: SenderCreateFields, encryptedPassword: string): Promise<SafeSender> {
    return prisma.sender.create({
      data: {
        userId,
        email: input.email,
        smtpHost: input.smtpHost,
        smtpPort: input.smtpPort,
        smtpUsername: input.smtpUsername,
        smtpPassword: encryptedPassword,
        hourlyLimit: input.hourlyLimit,
        minDelaySeconds: input.minDelaySeconds,
        isActive: input.isActive ?? true,
      },
      select: senderSelect,
    });
  }

  async update(userId: string, senderId: string, input: SenderUpdateFields, encryptedPassword?: string): Promise<SafeSender | null> {
    const result = await prisma.sender.updateMany({
      where: { id: senderId, userId },
      data: { ...input, ...(encryptedPassword ? { smtpPassword: encryptedPassword } : {}) },
    });
    if (result.count === 0) return null;
    return prisma.sender.findFirst({ where: { id: senderId, userId }, select: senderSelect });
  }

  async delete(userId: string, senderId: string): Promise<boolean> {
    const result = await prisma.sender.deleteMany({ where: { id: senderId, userId } });
    return result.count > 0;
  }
}

export class SenderService {
  constructor(
    private readonly repository: SenderRepository = new PrismaSenderRepository(),
    private readonly cipher: AesGcmSecretCipher = new AesGcmSecretCipher(env.ENCRYPTION_KEY),
    private readonly ethereal: EtherealSmtpConfig = {
      host: env.ETHEREAL_HOST,
      port: env.ETHEREAL_PORT,
      username: env.ETHEREAL_USER,
      password: env.ETHEREAL_PASS,
    },
  ) {}

  list(userId: string): Promise<SafeSender[]> {
    return this.repository.listByUser(userId);
  }

  async create(userId: string, input: SenderCreateInput): Promise<SafeSender> {
    const { smtpPassword, ...fields } = input;
    return this.repository.create(userId, fields, this.cipher.encrypt(smtpPassword));
  }

  createEthereal(userId: string, input: EtherealSenderInput): Promise<SafeSender> {
    if (!this.ethereal.username || !this.ethereal.password) throw new EtherealSenderNotConfiguredError();
    return this.create(userId, {
      ...input,
      smtpHost: this.ethereal.host,
      smtpPort: this.ethereal.port,
      smtpUsername: this.ethereal.username,
      smtpPassword: this.ethereal.password,
    });
  }

  async update(userId: string, senderId: string, input: SenderUpdateInput): Promise<SafeSender | null> {
    const { smtpPassword, ...fields } = input;
    const encryptedPassword = smtpPassword ? this.cipher.encrypt(smtpPassword) : undefined;
    return this.repository.update(userId, senderId, fields, encryptedPassword);
  }

  delete(userId: string, senderId: string): Promise<boolean> {
    return this.repository.delete(userId, senderId);
  }
}
