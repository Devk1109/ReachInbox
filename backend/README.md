# ReachInbox scheduler

ReachInbox is a TypeScript/Express email scheduler with a React dashboard. PostgreSQL stores the source records, Redis and BullMQ persist delayed jobs, and Elasticsearch serves owner-scoped email search. Use Ethereal for fake SMTP testing so scheduled messages are captured for review instead of delivered to real inboxes.

## Run locally

1. Install Node.js 20+ and Docker Desktop with its Linux engine running.
2. Copy `.env.example` to `.env`. Set a strong `SESSION_SECRET`, generate a 32-byte hex `ENCRYPTION_KEY`, and choose a private `BULL_BOARD_TOKEN`. Configure Google and Slack OAuth when using those integrations.
3. Create an Ethereal test account at [ethereal.email/create](https://ethereal.email/create). Copy the account username and password into `ETHEREAL_USER` and `ETHEREAL_PASS` in `.env`. The defaults are `ETHEREAL_HOST=smtp.ethereal.email` and `ETHEREAL_PORT=587` (STARTTLS).
4. From this directory, run `docker compose up -d`, `npm install`, `npm run db:generate`, and `npm run db:deploy`.
5. Run `npm run dev` for the API and `npm run dev:worker` in another terminal.
6. In the sibling `../frontend` directory, run `npm install` and `npm run dev`; open `http://localhost:5173`.
7. In the dashboard, open **Senders → Add Ethereal test sender**, enter the From email and rate settings, then create a campaign. Ethereal stores the captured message in its web inbox for inspection.

ReachInbox maps its data services to PostgreSQL `15432`, Redis `16379`, and Elasticsearch `19200` on the host to avoid conflicts with other local projects. The API health endpoint is `http://localhost:4000/health`; Bull Board is at `http://localhost:4000/admin/queues`. The queue dashboard uses Basic Auth username `admin` and the `BULL_BOARD_TOKEN` value as its password.

## Environment settings

`backend/.env.example` lists the settings. Important values:

| Setting | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | BullMQ and distributed rate limiting |
| `ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY` | Email search projection |
| `WORKER_CONCURRENCY` | Number of concurrent jobs per worker process; defaults to 10 |
| `MIN_EMAIL_DELAY_SECONDS` | Minimum spacing between send attempts for each sender; defaults to 2 seconds |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | Global per-sender hourly ceiling; defaults to 200 emails |
| `ETHEREAL_HOST`, `ETHEREAL_PORT`, `ETHEREAL_USER`, `ETHEREAL_PASS` | Fake SMTP account used by the Ethereal sender option |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Google OAuth |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_CALLBACK_URL` | Slack OAuth |
| `SESSION_SECRET`, `ENCRYPTION_KEY`, `BULL_BOARD_TOKEN` | Session, encrypted SMTP/Slack credentials, and queue dashboard access |

Never commit `.env` or real provider credentials. Set Google’s callback URL to `http://localhost:4000/auth/google/callback` and Slack’s to `http://localhost:4000/api/slack/callback` for local development. The `FRONTEND_URL` defaults to `http://localhost:5173`.

## Scheduling and delivery

When a campaign is accepted, one PostgreSQL transaction writes the campaign, its recipient email rows, and one outbox event per queue action. A worker-side dispatcher polls the durable outbox and publishes BullMQ delayed jobs with stable IDs and delay derived from each email’s scheduled time. This is a one-second worker loop, not a cron job. Redis runs with append-only persistence in the local Compose setup. On worker startup and every minute, a reconciler scans PostgreSQL `SCHEDULED` emails and checks for each versioned BullMQ job ID; only missing jobs are republished, restoring jobs if Redis lost them. Pending outbox entries are retried and stale in-progress email leases are reconciled. A job whose SMTP result is ambiguous is marked `DELIVERY_UNKNOWN` rather than blindly sent again.

### No-cron scheduling and idempotency guarantees

The application does not use OS cron, `node-cron`, Agenda, or BullMQ repeatable/cron jobs. Scheduling uses one-shot BullMQ delayed jobs; the worker’s in-process polling loop only publishes/reconciles persisted work. BullMQ includes `cron-parser` transitively for its optional repeatable-job feature, but this project does not configure or invoke that feature.

Each recipient row has a unique database idempotency key, and each queue job uses a deterministic email-and-schedule-version ID. Before SMTP, a conditional PostgreSQL state update atomically changes `SCHEDULED` to `PROCESSING`, so duplicate or parallel queue deliveries cannot both claim and send the same row. A transient SMTP rejection may retry the same job; ambiguous SMTP outcomes become `DELIVERY_UNKNOWN` and are never automatically resent. SMTP itself cannot promise exactly-once delivery if the provider accepted a message but its response was lost; the system chooses a visible unknown state over a potentially duplicated email.

### Sender throttling and hourly limits

The worker applies the strictest hourly cap from the campaign, sender, and `MAX_EMAILS_PER_HOUR_PER_SENDER` (default 200). It enforces at least `MIN_EMAIL_DELAY_SECONDS` (default 2 seconds) between attempts for the same sender; a sender can request a stricter cap or longer delay. BullMQ concurrency is controlled by `WORKER_CONCURRENCY` (default 10). A conditional PostgreSQL status update claims each email before sending, preventing parallel or duplicate jobs from processing the same email.

Each worker calls one atomic Redis Lua script to reserve a sender’s slot. The script uses Redis server time and a fixed UTC hour window, checks that window’s counter and the sender’s last reservation, then increments the counter and records the reservation. All worker instances share the same sender keys, so their concurrent reservations cannot exceed the hourly cap or minimum spacing. The counter is reserved before SMTP; a failed or ambiguous SMTP attempt still consumes that slot until the UTC hour changes. This favors a safe upper bound over reclaiming quota after uncertain delivery.

When the hourly cap is reached, Redis returns the start of the next UTC hour. The worker does not fail or discard the email: in one PostgreSQL transaction it changes the email back to `SCHEDULED`, updates `scheduled_at`, increments its schedule version, and writes a durable outbox event. The dispatcher republishes it as a BullMQ delayed job with a versioned stable ID. If Redis itself is unavailable, the worker fails closed and schedules a short retry instead of sending without a limit. A rate-limit event is also recorded once per sender and hour for Slack notification.

The original recipient list is scheduled in CSV order with each email’s due time derived from its position and the campaign delay. That order is retained while jobs are initially queued. If several jobs hit the same sender’s hourly cap concurrently, they become eligible at the same next-hour boundary and worker timing determines which reserves the next slots first. Therefore ordering is best effort among simultaneous jobs and across campaigns, while the per-sender cap and delay remain strict.

BullMQ workers use the configurable `WORKER_CONCURRENCY` value. SMTP temporary errors can be retried; permanent errors are marked failed. Rate limiting is reservation-based, so a failed delivery can consume a reserved slot until the hourly window expires. The system treats PostgreSQL as the source of truth. Elasticsearch indexing is asynchronous through the outbox, so search results can lag a recent state change briefly.

## Features mapped to the assignment

| Area | Implementation |
|---|---|
| Backend scheduler | Authenticated campaign API, CSV/text parsing and validation, per-email delayed BullMQ jobs, transactional outbox, deterministic job IDs, recovery, retry classification |
| Backend delivery | Multiple encrypted sender accounts, Ethereal fake SMTP option, configurable worker concurrency, Redis-backed sender delay and hourly caps |
| Backend integrations | Google OAuth, Slack OAuth and rate-limit direct messages, Elasticsearch indexing/search, protected Bull Board |
| Frontend login | Google sign-in entry, authenticated profile with name/email/avatar, logout |
| Frontend dashboard | Compose and schedule campaigns, preview recipient counts, view scheduled/sent/failed emails, loading and empty states, basic search |
| Frontend setup | Add Ethereal test sender or configure SMTP sender accounts |

## Verification and limits

Run `npm run build`, `npm test`, and `npm audit --offline` in this directory. Run the same scripts from `../frontend` for the dashboard. The automated suite covers a 1,000-recipient schedule generation case without attempting to send 1,000 messages; the rate-limit, provider, retry, restart-recovery and indexing paths also have focused tests. Provider calls require credentials and are not replaced by mocked tests in a live demo.

Assumptions and trade-offs: Ethereal is used for safe test capture, not real delivery. SMTP cannot provide exactly-once delivery after an ambiguous network outcome, so the scheduler surfaces that case for review instead of risking a duplicate. Search is eventually consistent because indexing is asynchronous. Google sign-in, Slack delivery, and Ethereal SMTP delivery must be demonstrated with credentials from their respective providers.

The assignment also requests a private GitHub repository with access for `Mitrajit` and `Yadav036` and a demo video up to five minutes. Those are external submission steps and are not performed by this local project setup.

### Slack rate-limit alerts and burst behavior

After `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` are configured, a signed-in user can open the profile menu and choose **Connect Slack**. The app starts Slack OAuth with the `chat:write` and `im:write` scopes, validates the returned state, encrypts and stores the installation token against that user, and exposes **Disconnect Slack** in the same menu. Notification workers read the current connection from PostgreSQL for every rate-limit event. A missing or disconnected integration is a successful skip; disconnecting and reconnecting changes behavior without a worker redeploy. Hits skipped before a connection are not replayed; a later rate-limit event in a new sender/hour window notifies the newly connected account. Slack API errors retry on the notification queue and do not block email delivery. A connected user receives one direct message per sender per UTC hour window when that sender first reaches its cap.

For a burst of 1,000 or more recipients with similar start times, the API writes one email and durable outbox event per recipient. The dispatcher publishes events in created order in batches of 100; BullMQ holds delayed jobs persistently, and email workers process up to `WORKER_CONCURRENCY` jobs per worker instance. The shared Redis reservation remains the final gate: with the default 200 per-sender hourly ceiling, a sender with no stricter campaign/sender setting can send at most 200 in a UTC hour. Remaining jobs return to `SCHEDULED` and are requeued at the next UTC hour boundary, then proceed in recipient order as much as queue timing permits. Under the default cap, 1,000 due emails therefore take at least five hourly windows for one sender (assuming no other traffic); additional senders have independent counters. The design is tested with a 1,000-recipient schedule-generation case and Redis parallel-reservation checks; it does not send a thousand messages to Ethereal as part of tests.
