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

**AI Gateway** (fronts Anthropic — caching, logging, rate limits). Create one in the
dashboard → **AI** → **AI Gateway**, give it a name (e.g. `records`), and use that as
`AI_GATEWAY_NAME` below. *Optional:* leave `AI_GATEWAY_NAME` blank to call
`api.anthropic.com` directly and skip the gateway.

After any edit to `wrangler.jsonc`, regenerate the binding types:

```bash
bunx wrangler types
```

---

## 2. Accounts & keys

| Service | Get | Used for |
| ------- | --- | -------- |
| **Clerk** | [dashboard.clerk.com](https://dashboard.clerk.com) → app → **API keys** | `/admin` auth |
| **Anthropic** | [console.anthropic.com](https://console.anthropic.com) → **API keys** | cover analysis + web-search ID (Sonnet 4.6) |
| **Discogs** | [discogs.com/settings/developers](https://www.discogs.com/settings/developers) → **Generate token** | release metadata lookup |
| **Sentry** *(optional)* | [sentry.io](https://sentry.io) → project → **Client keys (DSN)** | error monitoring |
| **Cloudflare API token** *(for `db:studio`/`db:push`)* | dashboard → **My Profile → API Tokens**, with **D1 edit** | Drizzle Kit over HTTP |
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
| `ANTHROPIC_API_KEY` | ✅ for capture | `sk-ant-…` |
| `AI_GATEWAY_NAME` | optional | your AI Gateway name; blank → direct to Anthropic |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | also builds the AI Gateway URL |
| `DISCOGS_TOKEN` | recommended | enrichment degrades gracefully without it |
| `VITE_SENTRY_DSN` | optional | error monitoring |
| `VITE_SENTRY_ORG` / `VITE_SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | optional | build-time source-map upload |
| `CLOUDFLARE_DATABASE_ID` / `CLOUDFLARE_D1_TOKEN` | only for `db:studio`/`db:push` | not needed for app runtime |
| `LASTFM_API_KEY` | not yet | Phase 3 |

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
and `VITE_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` + `ANTHROPIC_API_KEY` set.
Discogs/Sentry/AI-Gateway are all optional — the app degrades without them.

---

## 6. Deploy to production

```bash
bun run build
bunx wrangler deploy
```

Set each secret in the deployed Worker (these are NOT read from `.env.local` in prod):

```bash
bunx wrangler secret put CLERK_SECRET_KEY
bunx wrangler secret put ANTHROPIC_API_KEY
bunx wrangler secret put DISCOGS_TOKEN
bunx wrangler secret put VITE_SENTRY_DSN          # if using Sentry
# AI_GATEWAY_NAME + CLOUDFLARE_ACCOUNT_ID can also be set as plain vars in wrangler.jsonc
```

Apply migrations to prod D1 (same command — `--remote` is the production DB):

```bash
bunx wrangler d1 migrations apply records --remote
```

**Custom domain** — attach `records.charliegleason.com` as a Workers **Custom Domain**
in the dashboard, or uncomment the `routes` block in `wrangler.jsonc`.

**Clerk production** — swap the test keys for **production** keys from a dedicated
production Clerk instance, and add `records.charliegleason.com` under **Domains**.

---

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `bun run dev` errors on D1/R2 | run `bunx wrangler login`; confirm `wrangler.jsonc` `database_id` is real |
| `no such table: records` | run the migration (§4) |
| `env.X` is `undefined` at runtime | add `X` to `.env.local`, then `bunx wrangler types`; restart dev |
| Clerk "Add your Publishable Key" crash | `VITE_CLERK_PUBLISHABLE_KEY` missing from `.env.local` |
| Capture analyze fails | check `ANTHROPIC_API_KEY` (and `AI_GATEWAY_NAME` if set) |
| Pitchfork score always blank | The Fork match is best-effort (`src/lib/the-fork.ts`); fine to ignore |
| Type errors after editing `wrangler.jsonc` | `bunx wrangler types` |
```
