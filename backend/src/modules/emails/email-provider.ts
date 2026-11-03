import nodemailer from "nodemailer";
import { AesGcmSecretCipher } from "../../utils/secret-cipher";

export interface OutgoingEmail {
  id: string;
  recipient: string;
  subject: string;
  body: string;
}

export interface SmtpSender {
  id: string;
  email: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  encryptedSmtpPassword: string;
}

export interface EmailSendResult {
  accepted: boolean;
  messageId?: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    outcomeUnknown: boolean;
  };
}

export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  tls: { rejectUnauthorized: true };
  disableFileAccess: true;
  disableUrlAccess: true;
}

export interface SmtpTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<{
    accepted: Array<string | { address: string }>;
    messageId?: string;
  }>;
}

export type SmtpTransportFactory = (options: SmtpTransportOptions) => SmtpTransport;

const NETWORK_RETRY_CODES = new Set(["ECONNECTION", "ECONNRESET", "ETIMEDOUT", "ESOCKET", "EDNS"]);

export function classifySmtpError(error: unknown): NonNullable<EmailSendResult["error"]> {
  const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof details.code === "string" ? details.code : "SMTP_ERROR";
  const message = typeof details.message === "string" ? details.message : "SMTP delivery failed";
  const responseCode = typeof details.responseCode === "number" ? details.responseCode : undefined;
  const command = typeof details.command === "string" ? details.command.toUpperCase() : "";

  if (responseCode !== undefined && responseCode >= 500) {
    return { code, message, retryable: false, outcomeUnknown: false };
  }
  if (responseCode !== undefined && responseCode >= 400) {
    return { code, message, retryable: true, outcomeUnknown: false };
  }
  if (command === "DATA" || command === "END") {
    return { code, message, retryable: false, outcomeUnknown: true };
  }
  if (NETWORK_RETRY_CODES.has(code)) {
    return { code, message, retryable: true, outcomeUnknown: false };
  }
  return { code, message, retryable: false, outcomeUnknown: false };
}

const nodemailerTransportFactory: SmtpTransportFactory = (options) =>
  nodemailer.createTransport(options) as unknown as SmtpTransport;

export class SmtpEmailProvider {
  constructor(
    private readonly cipher: AesGcmSecretCipher,
    private readonly transportFactory: SmtpTransportFactory = nodemailerTransportFactory,
  ) {}

  async send(email: OutgoingEmail, sender: SmtpSender): Promise<EmailSendResult> {
    const transport = this.transportFactory({
      host: sender.smtpHost,
      port: sender.smtpPort,
      secure: sender.smtpPort === 465,
      auth: {
        user: sender.smtpUsername,
        pass: this.cipher.decrypt(sender.encryptedSmtpPassword),
      },
      tls: { rejectUnauthorized: true },
      disableFileAccess: true,
      disableUrlAccess: true,
    });

    try {
      const info = await transport.sendMail({
        from: sender.email,
        to: email.recipient,
        subject: email.subject,
        text: email.body,
      });
      const wasAccepted = info.accepted.some((entry) =>
        (typeof entry === "string" ? entry : entry.address).toLowerCase() === email.recipient.toLowerCase());
      if (!wasAccepted) {
        return {
          accepted: false,
          error: {
            code: "RECIPIENT_NOT_ACCEPTED",
            message: "SMTP did not accept the recipient",
            retryable: false,
            outcomeUnknown: false,
          },
        };
      }
      return { accepted: true, messageId: info.messageId };
    } catch (error) {
      return { accepted: false, error: classifySmtpError(error) };
    }
  }
}
