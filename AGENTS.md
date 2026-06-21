<!-- intent-skills:start -->
## Skill Loading

Before substantial work:
- Skill check: run `npx @tanstack/intent@latest list`, or use skills already listed in context.
- Skill guidance: if one local skill clearly matches the task, run `npx @tanstack/intent@latest load <package>#<skill>` and follow the returned `SKILL.md`.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

# records.charliegleason.com

A React dashboard that catalogs a personal vinyl collection, deployed on Cloudflare
at **records.charliegleason.com**, with an admin interface behind Clerk at **/admin**.

## Scaffolding provenance

Scaffolded with the TanStack CLI (Create TanStack App). The canonical command for the
chosen stack is:

```bash
npx @tanstack/cli@latest create records --agent --deployment cloudflare \
  --add-ons form,shadcn,table,tanstack-query,sentry,clerk,prisma,neon,ai,store
```

Deliberate deviation from the literal command: **`prisma` and `neon` were dropped in
favour of `drizzle` + `db`**, because the deployment target is Cloudflare D1, and
Drizzle (not Prisma) is the ORM with first-class D1 support. The realised add-on set
(see `.cta.json`) is: `biome, cloudflare, clerk, sentry, ai, db, drizzle, form, mcp,
shadcn, table, store, storybook, tanstack-query`.

### Follow-up TanStack Intent commands

```bash
npx @tanstack/intent@latest install   # created the intent-skills block above
npx @tanstack/intent@latest list      # 13 intent-enabled packages, 51 skills
```

Always run `intent list` / `intent load <pkg>#<skill>` before making library-specific
changes (TanStack AI, DB, Start, Router all ship skills) instead of guessing patterns.

## Stack & integrations

| Concern            | Choice                                                            |
| ------------------ | ---------------------------------------------------------------- |
| Framework          | TanStack Start (SSR) + TanStack Router (file-based routes)       |
| Data fetching      | TanStack Query + Router loaders; TanStack DB collections         |
| Tables / filters   | TanStack Table                                                   |
| Forms              | TanStack Form                                                    |
| State              | TanStack Store                                                   |
| AI                 | TanStack AI (`@tanstack/ai*`) → Cloudflare Workers AI / AI Gateway |
| Auth               | Clerk (`@clerk/clerk-react`), admin gated at `/admin`           |
| Error monitoring   | Sentry (`@sentry/tanstackstart-react`)                          |
| Database           | Drizzle ORM → Cloudflare **D1** (SQLite)                         |
| Photo storage      | Cloudflare **R2**                                                |
| Deployment / host  | Cloudflare Workers (`@cloudflare/vite-plugin`, `wrangler.jsonc`) |
| Package manager    | **bun**                                                          |
| Toolchain          | **biome** (lint/format/check)                                    |
| MCP                | `@modelcontextprotocol/sdk` server at `/mcp` (bonus API surface) |

### Required TanStack libraries (brief)

Present: Start, Router, CLI, Intent (via npx), Query, Table, Form, Store, DB, AI.
**Still to add & demonstrate: TanStack Hotkeys, TanStack Pacer, TanStack Virtual.**

### External data sources

- **Pitchfork scores** via The Fork — `https://the-fork.vercel.app`
- **Discogs** — release metadata (artist, title, year, label, tracklist)
- **Last.fm** — listening data, to suggest records to buy / find US deals

## Architecture decisions

- **Cloudflare + TanStack end-to-end.** Prefer Workers-native primitives (D1, R2,
  Workers AI, Email, Cron Triggers) over third-party services.
- **Drizzle over Prisma** specifically for D1 support (see scaffolding note).
- **AI photo flow:** take a photo on iPhone in the web app → Workers AI (vision) /
  AI Gateway extracts artist/title/year → enrich via Discogs + The Fork → store in D1,
  image in R2.
- **Public API** (`/api/*` route handlers) exposes the collection over HTTP so it can
  be consumed from `ssh charliegleason.com` and charliegleason.com. Read endpoints are
  public; writes require Clerk auth.
- **Admin (`/admin`)** is the only authenticated area (Clerk `SignedIn`/`SignedOut` +
  server-side `auth()` checks in loaders/server fns).
- **Environments:** localhost and production only — no staging.

## Environment variables

Public vars are prefixed `VITE_`. Secrets are set via `wrangler secret put <NAME>` in
production and live in `.env.local` for dev. See `.env.example`.

| Var                          | Scope        | Purpose                                  |
| ---------------------------- | ------------ | ---------------------------------------- |
| `VITE_CLERK_PUBLISHABLE_KEY` | public       | Clerk frontend                           |
| `CLERK_SECRET_KEY`           | secret       | Clerk server-side `auth()`               |
| `VITE_SENTRY_DSN`            | public       | Sentry (see `instrument.server.mjs`)     |
| `CLOUDFLARE_ACCOUNT_ID`      | dev          | Drizzle Kit `db:push`/`db:studio` (d1-http)|
| `CLOUDFLARE_DATABASE_ID`     | dev          | Drizzle Kit `db:push`/`db:studio`        |
| `CLOUDFLARE_D1_TOKEN`        | dev/secret   | Drizzle Kit `db:push`/`db:studio`        |
| D1 binding `DB`              | binding      | Database, dev + prod (`wrangler.jsonc`)  |
| `DISCOGS_TOKEN`              | secret       | Discogs API                              |
| `LASTFM_API_KEY`             | secret       | Last.fm API                              |
| Workers AI binding `AI`      | binding      | Workers AI / AI Gateway (`wrangler.jsonc`)|
| R2 binding `PHOTOS`          | binding      | Vinyl photo storage (`wrangler.jsonc`)   |

## Deployment notes

- `bun run build` then `wrangler deploy` (see `package.json` scripts).
- Bindings (D1 `DB`, R2 `PHOTOS`, Workers `AI`, Email, Cron) are declared in
  `wrangler.jsonc`; worker `name` is `records`. D1 `database_id` is provisioned
  (`records`, WNAM region).
- Custom domain `records.charliegleason.com` is attached via a Workers route /
  custom domain in the Cloudflare dashboard or `wrangler.jsonc` `routes`.
- Daily "records to buy" email uses the Cloudflare **Email** feature driven by a
  **Cron Trigger** (once/day).

## Known gotchas

- **Dev uses remote bindings — there is NO local DB.** `remoteBindings: true` in
  `vite.config.ts` + `remote: true` on each binding in `wrangler.jsonc` means
  localhost reads/writes the real Cloudflare D1/R2. Apply migrations with
  `--remote` only (`bunx wrangler d1 migrations apply records --remote`).
- **`better-sqlite3` is still in `dependencies`** but unused after the D1 move — safe
  to remove later.
- **Admin auth is currently client-side only** (`<SignedIn>`/`<SignedOut>` in
  `routes/admin/route.tsx`). Add server-side Clerk `auth()` (+ `CLERK_SECRET_KEY`)
  before treating `/admin` or write server fns as a real security boundary.
- **TanStack AI ships OpenAI/Anthropic/Gemini/Ollama adapters**, not a Workers-AI
  adapter — point the `openaiCompatible` adapter at an AI Gateway / Workers AI
  OpenAI-compatible endpoint.
- TanStack DB live-query collections are **client-only** (no SSR) — disable SSR on
  routes that preload collections (see `db#meta-framework` skill).
- Re-run `bunx wrangler types` after editing `wrangler.jsonc` (regenerates
  `worker-configuration.d.ts`).

## Next steps

See **PLAN.md** for the full phased build plan. Immediate items:

1. Apply the migration to D1: `bunx wrangler d1 migrations apply records --remote`.
2. Phase 1 — CRUD: `create/update/deleteRecord` server fns + TanStack Form pages.
3. Phase 1.5 — server-side Clerk auth on `/admin` and write server fns.
4. Phase 2 — AI photo capture → Workers AI extraction → R2 storage.
5. Phase 3+ — Discogs / The Fork / Last.fm enrichment, public API expansion, daily
   email via Cron + Cloudflare Email.
