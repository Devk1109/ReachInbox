# ReachInbox

ReachInbox is a full stack email scheduling app. The API, worker and PostgreSQL, Redis and Elasticsearch services live in `backend/`; the React dashboard lives in `frontend/`.

## Local development

1. Install Node.js 20+ and Docker Desktop with its Linux container engine running.
2. Copy `backend/.env.example` to `backend/.env` and fill in the settings you need. Ethereal credentials enable test email delivery; Google and Slack credentials enable those sign-in and notification integrations.
3. Install dependencies once with `npm install` in both `backend/` and `frontend/`.
4. From the project root, run `./start.ps1`. It starts PostgreSQL, Redis, and Elasticsearch, prepares the database, launches the API, worker, and frontend, and opens `http://localhost:5173`. The three app logs appear in this terminal. Press Ctrl+C to stop the app processes; Docker services remain running.

To leave the browser closed, run `./start.ps1 -NoBrowser`. Logs are also written under `.run-logs/`.

The Vite development server forwards API, OAuth and queue dashboard requests to `http://localhost:4000`. The API is at `/health`; the authenticated queue dashboard is at `/admin/queues`.

ReachInbox maps its local data services to PostgreSQL `15432`, Redis `16379`, and Elasticsearch `19200` on the host so they do not collide with other projects using the default ports.

## Checks

- Backend: from `backend/`, `npm run build`, `npm test`, `npm audit --offline`.
- Frontend: from `frontend/`, `npm run build`, `npm test`, `npm audit --offline`.

For architecture, rate-limit and delay behavior, Ethereal setup, and the assignment feature map, see [backend/README.md](backend/README.md). Never commit `backend/.env` or real credentials.

For a timed walkthrough and the final private-repository/video submission checklist, see [DEMO.md](DEMO.md).
