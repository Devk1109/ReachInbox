export interface User {
  id: string;
  name: string;
  email: string;
  avatar: string | null;
  createdAt: string;
}

export interface Sender {
  id: string;
  userId: string;
  email: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  hourlyLimit: number;
  minDelaySeconds: number;
  isActive: boolean;
  createdAt: string;
}

export interface Campaign {
  id: string;
  userId: string;
  senderId: string;
  subject: string;
  startTime: string;
  delayBetweenEmails: number;
  hourlyLimit: number;
  status: string;
  createdAt: string;
  emailCount: number;
}

export interface Email {
  id: string;
  campaignId: string;
  senderId: string;
  senderEmail: string;
  recipient: string;
  subject: string;
  scheduledAt: string;
  sentAt: string | null;
  status: string;
  isStarred: boolean;
  archivedAt: string | null;
  trashedAt: string | null;
  retryCount: number;
  errorMessage: string | null;
  body?: string;
}

export interface RecipientPreview {
  totalRows: number;
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  recipients: string[];
  invalidRecipients: Array<{ row: number; value: string; reason: string }>;
  duplicates: string[];
}

export type PageKey = "scheduled" | "sent";
