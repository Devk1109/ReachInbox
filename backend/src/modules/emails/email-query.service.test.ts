import assert from "node:assert/strict";
import { EmailStatus } from "@prisma/client";
import { test } from "node:test";
import {
  EmailQueryService,
  type EmailDetail,
  type EmailListItem,
  type EmailQueryRepository,
  type EmailStatusGroup,
} from "./email-query.service";

const item: EmailListItem = {
  id: "email-1",
  campaignId: "campaign-1",
  senderId: "sender-1",
  senderEmail: "sender@example.com",
  recipient: "recipient@example.com",
  subject: "Welcome",
  scheduledAt: new Date("2026-11-02T10:00:00.000Z"),
  sentAt: null,
  status: EmailStatus.SCHEDULED,
  isStarred: false,
  archivedAt: null,
  trashedAt: null,
  retryCount: 0,
  errorMessage: null,
};

class InMemoryEmailQueryRepository implements EmailQueryRepository {
  lastList: { userId: string; group: EmailStatusGroup; skip: number; take: number } | undefined;
  record: EmailListItem = { ...item };
  async list(userId: string, group: EmailStatusGroup, skip: number, take: number) {
    this.lastList = { userId, group, skip, take };
    return { total: 1, emails: [this.record] };
  }
  async findById(userId: string, emailId: string): Promise<EmailDetail | null> {
    return userId === "user-1" && emailId === item.id ? { ...this.record, body: "Private body", events: [] } : null;
  }
  async updateMailboxState(userId: string, emailId: string, data: Partial<Pick<EmailListItem, "isStarred" | "archivedAt" | "trashedAt">>): Promise<EmailDetail | null> {
    if (userId !== "user-1" || emailId !== item.id) return null;
    this.record = { ...this.record, ...data };
    return { ...this.record, body: "Private body", events: [] };
  }
}

test("email list service maps pages to bounded record offsets and passes owner scope", async () => {
  const repository = new InMemoryEmailQueryRepository();
  const result = await new EmailQueryService(repository).list("user-1", "scheduled", 3, 25);
  assert.deepEqual(repository.lastList, { userId: "user-1", group: "scheduled", skip: 50, take: 25 });
  assert.deepEqual(result, { total: 1, emails: [item] });
});

test("email details are only available within the requesting user's scope", async () => {
  const service = new EmailQueryService(new InMemoryEmailQueryRepository());
  assert.equal((await service.find("user-1", "email-1"))?.body, "Private body");
  assert.equal(await service.find("another-user", "email-1"), null);
});

test("mailbox actions persist star/archive/trash state and remain owner-scoped", async () => {
  const repository = new InMemoryEmailQueryRepository();
  const service = new EmailQueryService(repository);
  assert.equal((await service.updateMailboxState("user-1", "email-1", { isStarred: true }))?.isStarred, true);
  const archivedAt = new Date("2026-11-02T12:00:00.000Z");
  assert.equal((await service.updateMailboxState("user-1", "email-1", { archivedAt }))?.archivedAt?.toISOString(), archivedAt.toISOString());
  assert.equal(await service.updateMailboxState("another-user", "email-1", { trashedAt: new Date() }), null);
  const restored = await service.updateMailboxState("user-1", "email-1", { archivedAt: null, trashedAt: null });
  assert.equal(restored?.archivedAt, null);
  assert.equal(restored?.trashedAt, null);
  assert.equal(restored?.isStarred, true);
});
