# Vercel environment variables

The app deploys with **none** of these set. Each feature whose variables are missing
answers `503 NOT_CONFIGURED` until you add them in Vercel (Settings, Environment
Variables, Production) and **redeploy**. `GET /healthz` lists the names still missing.

| Variable | What it unlocks | Until it is set |
|---|---|---|
| `DATABASE_URL` | Everything under `/api` (extranet, availability, checkout). Neon from Storage sets it, plus `DATABASE_URL_UNPOOLED`. | All `/api` routes answer 503. The next deploy after you add it runs the migrations. |
| `CRON_SECRET` | `/api/cron/*` (Vercel Cron, cron-job.org). 16+ random characters, e.g. `openssl rand -hex 24`. | Cron calls are refused (401); background jobs don't run. |
| `RAZORPAY_KEY_ID` | Online payment at checkout. | Checkout answers 503 and frees the room it held. |
| `RAZORPAY_KEY_SECRET` | Same. All three Razorpay keys are needed. | Same. |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay payment webhooks. | Same. |

Optional, set when you use them:

| Variable | Purpose |
|---|---|
| `EXTRANET_ADMIN_TOKEN` | 24+ characters; admin access to the extranet setup API. |
| `CHANNEX_API_KEY`, `CHANNEX_WEBHOOK_SECRET`, `CHANNEX_BASE_URL` | Channex OTA distribution. |
| `SUPPLIER_BASE_URL`, `SUPPLIER_API_KEY` | External B2B supplier inventory. |
| `CRON_TICK_BUDGET_MS` | `25000` if cron-job.org calls `/api/cron/tick` (it stops waiting after 30 s). |

`PAYMENT_PROVIDER` is `razorpay` in production by default. `mock` is refused in
production because it confirms bookings without taking payment.
