ALTER TABLE "outbox_events"
ADD COLUMN "locked_at" TIMESTAMP(3);
