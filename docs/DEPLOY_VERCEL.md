# Deploying to Vercel

The whole API (checkout, extranet, channel webhooks, QloApps CM API) runs as **one
Vercel Function** using Vercel's zero-config Express support. The hotelier web app in
`public/extranet` is served from Vercel's CDN. Background work runs from **Vercel Cron**
instead of long-running loops.

## What is already set up in the repo

| Piece | Where | What it does |
|---|---|---|
| Entry point | `src/index.ts` | Default-exports the Express app. Vercel picks it up automatically. No `listen()`, no loops. |
| Build | `vercel.json` `buildCommand` = `npm run vercel-build` | Type-checks, then runs database migrations, **on production deployments only**. |
| Cron | `vercel.json` `crons` | `/api/cron/tick`, `/api/cron/hourly`, `/api/cron/daily` (daily by default for Hobby; see below). |
| Web app | `vercel.json` `redirects`, `rewrites`, `headers` | `/` and `/extranet` go to `/extranet/`, with the same strict security headers as before. |
| Database pool | `src/db/pool.ts` | Small pool (5) per instance, closed cleanly when Vercel suspends an instance. |
| Migrations | `src/db/migrate.ts` | Uses `DATABASE_URL_UNPOOLED` (direct connection) when set. |
| Webhook follow-up | `src/http/routes/channexWebhook.ts` | Uses `waitUntil`, so the booking pull still finishes after the reply. |

The same code still runs as a normal server (`npm run dev`, `npm start`, `npm run start:worker`).

### How the background jobs work on Vercel

A normal server runs the jobs in loops every few seconds. Vercel has no always-on
process, so:

- **`/api/cron/tick`** (every minute) runs outbox delivery and the Channex push every 2 s,
  the hold sweeper every 15 s, and the Channex booking feed once. It keeps going for
  `CRON_TICK_BUDGET_MS` (50 s by default) and then returns. That covers almost the whole
  minute, so updates still reach Channex and other channels within a few seconds.
- **`/api/cron/hourly`** keeps hotels open for sale far enough ahead (horizon roll).
- **`/api/cron/daily`** cleans up old Channex snapshots.

All jobs are safe to run twice at the same time, so a slow tick overlapping the next one
does no harm. Channex booking webhooks still trigger an immediate pull, as before.

## Before you start

1. **Cron frequency and plan.** `vercel.json` ships with every cron set to **once a day**
   so it deploys on the Hobby plan (Hobby rejects anything more frequent). That is only a
   safety net: `/api/cron/tick` should run every minute (outbox, Channex push, hold
   sweeper) and `/api/cron/hourly` every hour. Either upgrade to Pro and set them back to
   `* * * * *` and `7 * * * *`, or have an outside scheduler call those URLs with the
   header `Authorization: Bearer <CRON_SECRET>`.

   **Hobby + cron-job.org (free):** create three jobs at https://cron-job.org, each a
   `GET` with the request header `Authorization: Bearer <CRON_SECRET>`:

   | URL | Schedule |
   |---|---|
   | `https://<your-domain>/api/cron/tick` | every minute |
   | `https://<your-domain>/api/cron/hourly` | every hour |
   | `https://<your-domain>/api/cron/daily` | once a day |

   cron-job.org gives up on a request after 30 s, so set `CRON_TICK_BUDGET_MS=25000` in
   Vercel. The daily Vercel crons in `vercel.json` can stay as a fallback; running a job
   twice is safe.
2. **A Postgres database.** Neon from the Vercel Marketplace is the easiest choice:
   in the Vercel project go to **Storage**, pick **Neon**, and connect it. It sets
   `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct) for you. Any Postgres 15+
   works if you set those two variables yourself.
3. **Same region for the function and the database.** In Project Settings, open
   **Functions** and set the region to the one closest to your database (for example
   Singapore `sin1` or Mumbai `bom1` for a database in Asia). Every booking makes
   several database round trips, so this matters.

## Step by step

1. **Import the repo** at vercel.com/new (GitHub `aribanigar/hotel-inventorysystem`).
   The framework is detected as **Express**. Leave build and output settings as they are.
2. **Connect the database** (see above).
3. **Add environment variables** (Project Settings, Environment Variables, Production):

   | Variable | Value |
   |---|---|
   | `CRON_SECRET` | A random string of 16+ characters. Vercel sends it to the cron URLs. Required. |
   | `PAYMENT_PROVIDER` | `razorpay` (required in production) |
   | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | From the Razorpay dashboard |
   | `EXTRANET_ADMIN_TOKEN` | Optional, 24+ characters, for ops scripts |
   | `CHANNEX_BASE_URL` | `https://staging.channex.io` until certification, then the production host |
   | `CHANNEX_API_KEY` | From Channex |
   | `CHANNEX_WEBHOOK_SECRET` (24+) and/or `CHANNEX_WEBHOOK_HMAC_SECRET` (16+) | Same values you put on the Channex webhook |
   | `SUPPLIER_BASE_URL`, `SUPPLIER_API_KEY` | The B2B supplier, when you have one |

   `NODE_ENV` is set to `production` by Vercel. `RUN_JOBS_IN_PROCESS` and `DB_POOL_MAX`
   already have the right defaults on Vercel. Leave them unset.
4. **Deploy.** The production build runs the migrations. The build log shows
   `applied: ...` the first time and `already up to date` after that. If an environment
   variable is missing or invalid, the build fails and names it.
5. **Check it:** `https://<your-domain>/healthz` should return `{"ok":true}`. Under
   Project Settings, **Cron Jobs**, the three jobs should be listed. Their runs appear in the logs.
6. **Create the first hotel and its owner login.** There is no admin screen for creating
   hotels yet (see the README). From your own machine:

   ```bash
   vercel link
   vercel env pull .env.production.local
   ```

   Then run the SQL or seed for the real hotel against `DATABASE_URL_UNPOOLED` from that
   file, and create the owner login with `src/dev/createHotelUser.ts` (README, Quick start).
   Delete the pulled file afterwards. It holds production secrets.
7. **Point the outside services at your domain:**
   - Razorpay webhook: `https://<your-domain>/api/v1/payments/razorpay/webhook`
   - Channex webhook: `https://<your-domain>/api/v1/channex/webhook` (README, Channex section)
   - QloApps Channel Manager, if used: `https://<your-domain>/api/cm_api`
8. **Rate limits.** The built-in limiter counts per instance, and Vercel runs many.
   Add Vercel Firewall rate-limit rules for `POST /api/v1/hotelier/session` (sign-in) and
   `POST /api/v1/checkout/live-ping` (checkout), for example 20 and 30 per minute per IP.

## Preview deployments

- Cron jobs **do not run** on previews (Vercel runs crons on production only).
- Migrations are **skipped** on preview builds, so a branch can never change the live
  schema before it ships.
- A preview uses whatever database its environment variables point to. Safest: turn on
  Neon's option to **create a database branch for each preview**, and set
  `MIGRATE_ON_BUILD=true` for the Preview environment so each branch database is migrated.
  Do not point previews at the production database.

## Things to know

- **Cost:** the tick keeps one function running for about 50 s of every minute. With
  Fluid compute you pay CPU only while it is working, but memory is billed for the whole
  time, so this is a small, steady background cost. A lower `CRON_TICK_BUDGET_MS` costs
  less but leaves gaps each minute in which updates wait for the next tick.
- **Rollbacks:** Vercel's Instant Rollback switches code, not the database. Migrations here
  only add tables and columns, so older code keeps working after a rollback.
- **Logs:** pino writes JSON to stdout, which shows up in Vercel's Runtime Logs. Set a log
  alert (or a log drain) on `ALERT:` lines, as in the production checklist.
- **TypeScript is pinned to 6.0.3.** TypeScript 7 removed the JavaScript API that Vercel's
  builder uses to compile the function, and the build fails with it. Stay on 6.x until
  Vercel supports 7.
