# ReachInbox submission demo (under 5 minutes)

## Before recording

- Start the app with `./start.ps1` and confirm the dashboard, API health endpoint, and Bull Board open.
- Configure Google OAuth, Slack OAuth (optional for this walkthrough), and an Ethereal test sender if you want to demonstrate those live integrations. Never show secret values in the recording.
- Use a test recipient address and make sure the Ethereal account is available at [ethereal.email](https://ethereal.email/).
- Set `MIN_EMAIL_DELAY_SECONDS` and `MAX_EMAILS_PER_HOUR_PER_SENDER` to small demo values only if you plan to show throttling; restart the worker after changing env settings.

## Recording outline (about 4 minutes)

1. **0:00–0:30 — Sign in and dashboard.** Show login, the mailbox, and the Scheduled/Sent sections.
2. **0:30–1:30 — Compose and schedule.** Choose the Ethereal sender, add two test recipients, write a subject/body, choose a future time, and schedule. Show validation and the resulting scheduled rows.
3. **1:30–2:00 — Queue visibility.** Open Bull Board and show the delayed email jobs. Mention that PostgreSQL is the source of truth and Redis/BullMQ holds one-shot delayed jobs.
4. **2:00–3:10 — Restart recovery.** Stop the API/worker using Ctrl+C, leave the Docker data services running, start the app again, and show the future email still present in Scheduled and the delayed job restored. Do not wait for a future send if it would exceed the recording time; the persistent state and remaining delay are the evidence in this segment.
5. **3:10–3:40 — Sent and Ethereal capture.** For a message that is already due, show it moving to Sent, then open Ethereal’s test inbox to show the captured message. Ethereal captures messages and does not deliver them to a real recipient.
6. **3:40–4:20 — Throttling and trade-offs.** Briefly point to the configured concurrency, minimum spacing, and per-sender hourly cap. If demonstrating, schedule a small burst and show jobs deferred to the next UTC hour. State that ordering among jobs that hit a cap simultaneously is best effort.
7. **4:20–4:40 — Close.** Mention asynchronous search indexing, Slack rate-limit notification setup (if configured), and that SMTP ambiguity is surfaced as `DELIVERY_UNKNOWN` to avoid automatic duplicate sends.

## Submission checklist

- [ ] Create a **private** GitHub repository and push the project without `.env`, credentials, generated build output, or `node_modules`.
- [ ] Invite GitHub accounts `Mitrajit` and `Yadav036`; confirm their usernames and access level in GitHub.
- [ ] Record and attach a video no longer than five minutes using the outline above.
- [ ] Recheck that `README.md` and `backend/README.md` match the submitted code and environment settings.

## Assumptions and trade-offs to disclose

- Ethereal is a safe SMTP sink for the demo; it captures test email rather than delivering it to recipients.
- PostgreSQL is the durable source of truth. Redis/BullMQ provides delayed execution, while an outbox and restart reconciler restore queue work.
- SMTP cannot guarantee exactly-once delivery when a provider accepted a message but its response was lost. ReachInbox marks that outcome `DELIVERY_UNKNOWN` instead of automatically risking a duplicate.
- Search is eventually consistent because Elasticsearch indexing is asynchronous.
- Hourly quotas use UTC hour windows; sender order is best effort when multiple jobs contend for a full window.
- Google/Slack OAuth and live provider calls need credentials from the submitting account. The app can be reviewed without configuring those optional integrations.
