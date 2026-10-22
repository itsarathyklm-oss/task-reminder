# Task Reminder

A personal task, reminder, and subscription-renewal tracker with web push notifications, built as an installable, offline-capable PWA.

## What it does

- **Daily tasks** — create tasks with a date and time, filter them (pending / overdue / completed), and mark them done.
- **Reminders** — standalone reminders with priority levels, shown on the dashboard for the next 7 days.
- **Software subscriptions** — track recurring software (launch date, renewal date, monthly/yearly cycle), upload contract/invoice documents, log payments against renewals, and activate/deactivate subscriptions.
- **Dashboard** — pending / overdue / completed / active-subscription stat cards, a monthly calendar with a schedule sidebar, and upcoming task/reminder lists.
- **Notifications** — in-app notification dropdown (polls every 30 s), browser notifications, and web push via a daily 08:00 server cron job.
- **Reports** — CSV export of renewals and payment history.
- **PWA** — service worker caches the shell and key API responses for offline use.

## Tech stack

- **Backend:** Node.js + Express 5, MySQL (Aiven), JWT auth (`jsonwebtoken` + `bcryptjs`), `helmet`, `cors`, `express-rate-limit`, `node-cron`, `web-push`.
- **Frontend:** Single-page vanilla JS (`public/index.html` + `public/app.js`), Tailwind (CDN), no build step.
- **Files:** Cloudinary in production (when `CLOUDINARY_*` is set), local `uploads/` disk in development.

## Project structure

```
server.js        Express app: middleware, all API routes, error handling, startup
scheduler.js     Cron job (daily 08:00) that sends push alerts for renewals & tasks
lib/push.js      Shared VAPID config + sendPushNotification() used by both server and scheduler
db.js            MySQL connection pool (mysql2), SSL toggle for cloud databases
migrate.sql      Schema upgrades (run statements one at a time in MySQL Workbench)
public/          Static SPA: index.html, app.js, sw.js (service worker), manifest, icons
uploads/         Locally stored uploaded documents (dev mode only; gitignored)
```

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   Then fill in the values (see the table below). Generate a JWT secret with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```

3. **Prepare the database**
   - Create the MySQL database and base tables (`users`, `daily_tasks`, `software_projects`, `payment_history`).
   - Run the statements in `migrate.sql` **one at a time** in MySQL Workbench. A `Duplicate column name` error means that column already exists — just continue to the next line.
   - `reminders` and `push_subscriptions` tables are also auto-created at server startup if missing.

4. **Run**
   ```bash
   npm run dev    # development (nodemon)
   npm start      # production
   ```
   The server prints `Server running on http://localhost:<PORT>` and starts the scheduler.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no (default 4000) | HTTP port |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | yes | MySQL connection (e.g. Aiven) |
| `DB_SSL` | no (`true` for cloud DBs) | Enables SSL; uses `rejectUnauthorized: false` |
| `JWT_SECRET` | **yes — server exits without it** | Signs auth tokens (24 h expiry) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | for push | Web push keys (`npx web-push generate-vapid-keys`) |
| `VAPID_EMAIL` | no | Contact email for VAPID (defaults to `mailto:admin@taskreminder.app`) |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | for prod uploads | Switches uploads from local disk to Cloudinary |
| `ALLOWED_ORIGIN` | for production | CORS origin (your deployed URL); defaults to `*` |

Never commit `.env` — it is gitignored and holds live credentials.

## Architecture & data flow

```
Browser SPA (public/app.js)
   │  apiFetch(): attaches "Authorization: Bearer <JWT>" (stored in localStorage)
   ▼
Express routes (server.js)  ── authenticateToken middleware verifies JWT (24 h)
   │  every query is parameterized and scoped: WHERE user_id = ?
   ▼
MySQL pool (db.js)
   │
   ▼
JSON response → client renders (user input is HTML-escaped before innerHTML)
```

**Notifications flow two ways:**

1. **Server push (cron):** `scheduler.js` runs daily at 08:00, queries all users' renewals within 30 days and tasks that are overdue/due today/due tomorrow, and sends web push through `lib/push.js` (invalid/expired subscriptions are deleted automatically).
2. **Client polling:** every 30 s the SPA fetches `/api/notifications`, `/api/tasks` and `/api/reminders`, then raises in-app toasts, browser notifications, and the bell badge.

**File uploads:** `POST /api/projects` and `PUT /api/projects/:id/renew` accept a document via multer. Local files are stored in `uploads/` with a timestamped name and served only through `GET /uploads/:filename`, which requires a valid JWT **and** verifies the file belongs to the requesting user. Cloudinary files are referenced by their URL. Documents can also be attached to payment records (`payment_history.file_*`).

**Overdue calculation:** the server computes counts in database time; the browser recomputes overdue status locally with `isOverdue()` so the stat cards and "Missed" badges always use the viewer's timezone and agree with each other.

## API overview

All routes except `POST /api/auth/register`, `POST /api/auth/login`, and `GET /api/push/vapid-key` require `Authorization: Bearer <token>`.

| Group | Routes |
|---|---|
| Auth | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/change-password` |
| Tasks | `GET/POST /api/tasks`, `PUT /api/tasks/:id/complete`, `DELETE /api/tasks/:id` |
| Subscriptions | `GET/POST /api/projects`, `PUT /api/projects/:id`, `PUT /api/projects/:id/status`, `PUT /api/projects/:id/renew`, `GET /api/projects/:id/payments` |
| Reminders | `GET/POST /api/reminders`, `PUT /api/reminders/:id/complete`, `DELETE /api/reminders/:id` |
| Metrics | `GET /api/analytics`, `GET /api/notifications` |
| Push | `GET /api/push/vapid-key`, `POST /api/push/subscribe`, `DELETE /api/push/unsubscribe` |
| Export | `GET /api/export/renewals`, `GET /api/export/payments` (CSV) |
| Files | `GET /uploads/:filename` (JWT + ownership required) |

Rate limits: 10 requests / 15 min on auth routes, 100 requests / min on the general API.

## Security notes

- Passwords hashed with bcrypt (10 rounds); JWTs expire after 24 h.
- All SQL uses `?` parameters; reads and writes are scoped by `user_id`.
- File downloads verify ownership; filenames are regex-restricted against path traversal.
- User input is HTML-escaped on the server (`sanitize`) and again on render (`escapeHtml`/`escapeAttr`).
- Errors return a generic message to clients; full stack traces are logged server-side only.
- `helmet` is enabled with CSP off (the frontend uses inline scripts).

## Known limitations / future work

- No automated tests (`npm test` is a stub).
- No external error monitoring yet (logs are console-only).
- JWTs are not revoked on password change (they remain valid up to 24 h).
- Cloudinary delivery is public-by-URL; switch to signed URLs before inviting outside users.
