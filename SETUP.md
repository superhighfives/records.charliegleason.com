# Setup

Everything you need to take this repo from clone → working dev → production. See
[AGENTS.md](./AGENTS.md) for architecture and [PLAN.md](./PLAN.md) for the build plan.

- **Package manager:** bun
- **Host:** Cloudflare Workers (records.charliegleason.com)
- **Dev model:** `bun run dev` connects to the **real** Cloudflare D1/R2 (remote
  bindings) — there is no local database, so a few cloud resources must exist first.

---

## 0. Prerequisites

| Tool | Why | Check |
| ---- | --- | ----- |
| [bun](https://bun.sh) ≥ 1.3 | package manager + scripts | `bun --version` |
| Cloudflare account | D1, R2, Workers, AI Gateway, deploy | — |
| Wrangler (via `bunx`) authed | provisioning + dev remote bindings | `bunx wrangler whoami` |

```bash
bun install
bunx wrangler login        # required — dev reads/writes the real D1/R2
```

---

## 1. Cloudflare resources

The D1 database and R2 bucket referenced in `wrangler.jsonc` already exist on the
project's account (`database_id` is committed). If you're setting up a **fresh**
account, recreate them and paste the new ids into `wrangler.jsonc`:

```bash
bunx wrangler d1 create records            # → paste database_id into wrangler.jsonc
bunx wrangler r2 bucket create records-photos
```

**AI Gateway + Unified Billing.** The app calls Claude via Cloudflare's **partner
models** on the `AI` binding (`env.AI.run('anthropic/claude-sonnet-4.6', …)`), so
**you don't need an Anthropic API key** — Cloudflare holds the credentials and bills
your account. Requirements:

1. **Workers Paid** plan + **add credits** to your Cloudflare account (dashboard → AI →
   billing) — Unified Billing draws from these.
2. An **AI Gateway**: dashboard → **AI → AI Gateway**, create one (e.g. `records`) and
   set `AI_GATEWAY_NAME` to its name. Leaving it blank uses `"default"` (auto-created).

**Image Transformations.** The app resizes sourced cover art with the Images binding
(`env.IMAGES`). Enable it once: dashboard → **Images → Transformations** → enable for
your zone/account. Cover sourcing fails closed (no cover) if it's off.

**Email (daily digest).** The cron sends a "records to buy" email via the `EMAIL`
binding using **Cloudflare Email Sending** (Email Service, beta). Onboard the sender
domain: dashboard → **Compute → Email Service → Email Sending → Onboard Domain** →
`charliegleason.com`. It adds a `cf-bounce` subdomain MX + SPF/DKIM/DMARC **TXT**
records — your **apex MX (Gmail/Workspace) is untouched**, and you can send to any
recipient (no destination to verify). The sender is `digest@charliegleason.com`
(must be on the onboarded domain — not the worker subdomain); recipient is
`hi@charliegleason.com` (`src/lib/digest.ts`). The cron (`triggers.crons`, `0 14 * * *`)
runs `scheduled` in `src/server.ts`. Test now:
`curl -X POST https://…/api/cron/digest -H "x-cron-secret: $CRON_SECRET"`.

After any edit to `wrangler.jsonc`, regenerate the binding types:

```bash
bunx wrangler types
```

---

## 2. Accounts & keys

| Service | Get | Used for |
| ------- | --- | -------- |
| **Clerk** | [dashboard.clerk.com](https://dashboard.clerk.com) → app → **API keys** | `/admin` auth |
| **Discogs** | [discogs.com/settings/developers](https://www.discogs.com/settings/developers) → **Generate token** | release metadata lookup |
| **Sentry** *(optional)* | [sentry.io](https://sentry.io) → project → **Client keys (DSN)** | error monitoring |
| **Last.fm** *(Phase 3, not yet wired)* | [last.fm/api](https://www.last.fm/api) | future buy-suggestions email |

---

## 3. Environment variables

Copy the template and fill it in. `.env.local` is gitignored; in production these
become Worker secrets (see §6). Bindings (`DB`, `PHOTOS`, `AI`, `EMAIL`) live in
`wrangler.jsonc`, **not** here.

```bash
cp .env.example .env.local
```

| Variable | Required? | Notes |
| -------- | --------- | ----- |
| `VITE_CLERK_PUBLISHABLE_KEY` | ✅ | Clerk **publishable** key (`pk_…`) — public |
| `CLERK_SECRET_KEY` | ✅ | Clerk **secret** key (`sk_…`) — server-side auth boundary |
| `AI_GATEWAY_NAME` | optional | AI Gateway to route Claude through; blank → `"default"` |
| `DISCOGS_TOKEN` | recommended | enrichment degrades gracefully without it |
| `VITE_SENTRY_DSN` | optional | error monitoring |
| `VITE_SENTRY_ORG` / `VITE_SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | optional | build-time source-map upload |
| `LASTFM_API_KEY` / `LASTFM_USER` | for digest | daily buy-suggestions email |
| `CRON_SECRET` | for digest | guards the manual `POST /api/cron/digest` trigger |

> After adding a **new** key to `.env.local`, run `bunx wrangler types` so it's typed
> on `env`. (Dev reads `.env.local` via the Cloudflare Vite plugin.)

---

## 4. Apply the database migration

The `records` table is created from the committed migration in `drizzle/`. Because
there's no local DB, apply it to the **remote** D1:

```bash
bunx wrangler d1 migrations apply records --remote
```

Changing the schema later: edit `src/db/schema.ts` → `bun run db:generate` → re-run the
apply command above.

---

## 5. Run it

```bash
bun run dev          # http://localhost:3000 — live against remote D1/R2
```

Smoke test:
- `/` — landing page
- `/admin` — redirects to Clerk sign-in; after signing in, the records table
- `/admin/capture` — take/choose a cover photo → **Analyze** → pick a Discogs match → save
- `/api/records` — public JSON (`{"records":[],"count":0}` until you add some)

**Minimum to boot the admin + capture flow:** Wrangler login, the migration applied,
Unified Billing credits + an AI Gateway, and `VITE_CLERK_PUBLISHABLE_KEY` +
`CLERK_SECRET_KEY` set. Discogs/Sentry are optional — the app degrades without them.

---

## 6. Deploy to production

**Production deploys run in CI** (`.github/workflows/deploy.yml`), not from your
laptop. The reason: `VITE_CLERK_PUBLISHABLE_KEY` / `VITE_SENTRY_DSN` are **build-time
inlined** by Vite, so a local `bun run deploy` bakes whatever is in your `.env.local`
into the bundle — and that's intentionally a Clerk **test** key (→ "Development mode"
banner). CI builds with the production keys from GitHub secrets instead. The workflow
runs on every push to `main` (and via **Actions → Deploy → Run workflow**).

**GitHub repo secrets** (Settings → Secrets and variables → Actions) consumed by the
workflow — all build-time/deploy, no runtime Worker secrets here:

| Secret | Value |
| ------ | ----- |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk **production** publishable key (`pk_live_…`) |
| `VITE_SENTRY_DSN` | Sentry DSN |
| `VITE_SENTRY_ORG` / `VITE_SENTRY_PROJECT` | Sentry slugs (source-map upload) |
| `SENTRY_AUTH_TOKEN` | Sentry auth token (source-map upload) |
| `CLOUDFLARE_API_TOKEN` | Cloudflare token, **Edit Cloudflare Workers** template, scoped to the account + the `charliegleason.com` zone (custom-domain route needs DNS) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id (`wrangler whoami`) |

> Keep `.env.local` on **test** keys. Don't run `bun run deploy` locally for a real
> ship — it would inline the test Clerk key and re-introduce the Development banner.

To deploy by hand in a pinch, mirror the workflow's env: export the `pk_live_…` key
and Cloudflare creds, then `bun run deploy`.

**Runtime secrets** — set **once** on the deployed Worker (NOT in CI, NOT in
`.env.local`); they persist across deploys:

```bash
bunx wrangler secret put CLERK_SECRET_KEY
bunx wrangler secret put DISCOGS_TOKEN
bunx wrangler secret put LASTFM_API_KEY
bunx wrangler secret put CRON_SECRET
# Non-secret runtime values → wrangler.jsonc `vars` (or secrets): AI_GATEWAY_NAME, LASTFM_USER.
# No ANTHROPIC_API_KEY — Claude is billed via Cloudflare Unified Billing.
```

**Build-time vars** (used by `bun run build`, NOT Wrangler) — set in `.env.local` / CI:
`VITE_CLERK_PUBLISHABLE_KEY` and `VITE_SENTRY_DSN` are inlined into the bundle by Vite
(both read via `import.meta.env`), and `VITE_SENTRY_ORG`/`VITE_SENTRY_PROJECT`/
`SENTRY_AUTH_TOKEN` drive the Sentry source-map upload. None of these go to Wrangler.

Apply migrations to prod D1 (same command — `--remote` is the production DB):

```bash
bunx wrangler d1 migrations apply records --remote
```

**Custom domain** — attach `records.charliegleason.com` as a Workers **Custom Domain**
in the dashboard, or uncomment the `routes` block in `wrangler.jsonc`.

**Clerk production** — swap the test keys for **production** keys from a dedicated
production Clerk instance, and add `records.charliegleason.com` under **Domains**.

---

## 7. PR previews

Each pull request gets a live preview at **`preview.records.charliegleason.com`**
on a standalone `records-preview` Worker (`.github/workflows/preview.yml`, runs
`wrangler deploy --env preview`). The preview reuses the production R2 bucket but
gets its **own** D1 database and queue, so reviewing — including captures — never
touches production data. On every run the workflow **clones the production DB
into the preview DB** (export → reset → import → apply this PR's migrations), so
the preview is current but isolated. There's one shared preview environment, so
the most recent PR build is what's live.

> `env.preview` overrides the inherited `routes` (so it takes
> `preview.records.charliegleason.com`, **not** the production domain) and the
> inherited `triggers` (empty crons — no digest in preview).

One-time provisioning (needs the Cloudflare account; CI fails until it's done):

```bash
bunx wrangler d1 create records-preview        # → paste id into wrangler.jsonc env.preview
bunx wrangler queues create records-analyze-preview
bunx wrangler queues create records-analyze-preview-dlq

# Runtime secrets are per-Worker — set them on the preview Worker too. Use the
# Clerk *development* keys here (sk_test_…) to match the build key below:
bunx wrangler secret put CLERK_SECRET_KEY --env preview
bunx wrangler secret put DISCOGS_TOKEN --env preview
```

Then paste the new `database_id` into the `env.preview.d1_databases` block in
`wrangler.jsonc` (it ships with a `REPLACE_WITH_…` placeholder). The custom
domain is provisioned automatically on first deploy.

**Clerk.** A production instance (`pk_live_…`) can't authorize the preview host —
extra domains on a production instance are *satellite domains* needing their own
DNS/code. Instead the preview build uses a Clerk **development** instance, which
works on any origin. Set repo secret **`VITE_CLERK_PUBLISHABLE_KEY_PREVIEW`** to
the dev `pk_test_…` key, and the preview Worker's `CLERK_SECRET_KEY` (above) to
the matching `sk_test_…`. (Dev instances show a "development mode" banner — fine
for review. To get `pk_live` parity instead, add `preview.records.charliegleason.com`
as a Clerk satellite domain and set `isSatellite`/`domain` on `ClerkProvider`.)

New migrations need no workflow changes: after cloning production (which carries
its `d1_migrations` table), the "Refresh preview database" step runs
`wrangler d1 migrations apply`, which applies only the migrations the PR adds on
top of production — a no-op when production is already current.

---

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `bun run dev` errors on D1/R2 | run `bunx wrangler login`; confirm `wrangler.jsonc` `database_id` is real |
| `no such table: records` | run the migration (§4) |
| `env.X` is `undefined` at runtime | add `X` to `.env.local`, then `bunx wrangler types`; restart dev |
| Clerk "Add your Publishable Key" crash | `VITE_CLERK_PUBLISHABLE_KEY` missing from `.env.local` |
| Capture analyze fails | confirm Workers Paid + Unified Billing credits and that the `AI` binding / gateway exist |
| Pitchfork score always blank | The Fork match is best-effort (`src/lib/the-fork.ts`); fine to ignore |
| Type errors after editing `wrangler.jsonc` | `bunx wrangler types` |
```
