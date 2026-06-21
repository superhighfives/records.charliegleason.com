# records.charliegleason.com — End-to-end plan

A React dashboard that catalogs a personal vinyl collection, hosted on Cloudflare at
**records.charliegleason.com**, admin behind Clerk at **/admin**, with an AI photo-capture
flow, metadata enrichment, a public API, and a daily "records to buy" email.

See [AGENTS.md](./AGENTS.md) for durable context (scaffolding command, stack, env vars,
gotchas). This file is the **build plan** — what's done and what's next, in order.

---

## Architecture at a glance

```
iPhone (web app, camera)
   │  photo
   ▼
TanStack Start route  ──►  R2 (PHOTOS)            ── original image bytes
   │                          ▲
   │ server fn                │ key
   ▼                          │
Workers AI (vision)  ──►  extract {artist,title,year}
   │
   ├─►  Discogs API   ── release metadata (label, tracklist, year)
   ├─►  The Fork      ── Pitchfork score (the-fork.vercel.app)
   ▼
D1 (DB, Drizzle)  ── records table
   │
   ├─►  /admin  (Clerk-gated)  ── table + filters + forms (TanStack Table/Form)
   └─►  /api/*  (public read)  ── charliegleason.com + `ssh charliegleason.com`

Cron Trigger (daily) ──► Last.fm suggestions ──► Email (Cloudflare) ──► hi@charliegleason.com
```

Principle: **Cloudflare + TanStack end-to-end.** Prefer Workers-native primitives (D1,
R2, Workers AI, Email, Cron) and TanStack libraries over third-party equivalents.

---

## Phase 0 — Foundation ✅ (done)

- [x] Scaffolded with the TanStack CLI (Create TanStack App). Add-ons realised:
      `biome, cloudflare, clerk, sentry, ai, db, drizzle, form, mcp, shadcn, table,
      store, storybook, tanstack-query`. (Dropped `prisma`/`neon` for `drizzle`/`db` —
      Drizzle has first-class D1 support.)
- [x] `npx @tanstack/intent@latest install` + `list` (13 packages, 51 skills).
- [x] AGENTS.md with full durable context.
- [x] Package manager migrated **npm → bun** (`bun.lock`, docs updated).
- [x] Added missing required TanStack libs: **Hotkeys, Pacer, Virtual**.
- [x] DB converted to **Cloudflare D1**: `drizzle-orm/d1` runtime (`getDb`), `d1-http`
      drizzle-kit driver, `records` schema, generated migration in `drizzle/`.
- [x] `wrangler.jsonc` bindings: `DB` (D1), `PHOTOS` (R2), `AI` (Workers AI),
      `EMAIL` (send), daily Cron Trigger; worker renamed to `records`.
- [x] `.env.example` expanded with every secret.
- [x] Scaffolded **/admin** (Clerk-gated shell + records table w/ Pacer-debounced
      filter + `/` Hotkey) and a public **/api/records** read endpoint.

**Before anything in Phase 1+ runs locally**, provision the Cloudflare resources and
fill the placeholders:

```bash
bunx wrangler d1 create records          # paste database_id into wrangler.jsonc
bunx wrangler r2 bucket create records-photos
bunx wrangler d1 migrations apply records --remote   # remote-only; no local DB
cp .env.example .env.local               # fill Clerk + secrets
bun run dev                              # connects to the remote D1/R2
```

> Dev uses **remote bindings** (`remoteBindings: true` in `vite.config.ts` +
> `remote: true` on each binding in `wrangler.jsonc`), so there is no local
> SQLite/R2 — localhost reads and writes the real Cloudflare resources.

---

## Phase 1 — CRUD on the collection

Goal: manage records by hand end-to-end before any AI.

- [ ] Write server functions: `createRecord`, `updateRecord`, `deleteRecord`
      (mirror `listRecords`/`getRecord` in `src/lib/records.ts`; wrap each in a Sentry
      span; gate behind Clerk server-side auth — see Phase 1.5).
- [ ] `/admin/records/new` and `/admin/records/$id/edit` using **TanStack Form** + Zod.
- [ ] Wire mutations through **TanStack Query** (or a TanStack DB collection backed by
      `queryCollectionOptions`) for optimistic updates + cache invalidation.
- [ ] Column sorting/visibility + faceted filters (artist, genre, year, score range) on
      the admin table via **TanStack Table**.
- [ ] Use **TanStack Virtual** for the row body once the collection is large.

### Phase 1.5 — Harden auth

- [ ] Add `CLERK_SECRET_KEY`; verify the session **server-side** in admin server fns /
      loaders (don't rely only on the client `<SignedIn>` gate). Load the Clerk skill:
      `router-core#auth-and-guards` for the `beforeLoad` redirect pattern.
- [ ] Public `/api/*` stays read-only and unauthenticated; all writes require auth.

---

## Phase 2 — AI photo capture & extraction

Goal: photograph a record on iPhone → structured metadata.

- [ ] `/admin/capture` route: `<input type="file" accept="image/*" capture>` for the
      iPhone camera; preview + confirm.
- [ ] Server fn `uploadPhoto`: stream the image into **R2** (`PHOTOS`), return the key.
- [ ] Server fn `analyzePhoto`: call **Workers AI** vision model with the image and a
      structured prompt → `{ artist, title, year }`. Use **TanStack AI** `structured-outputs`
      (Zod `outputSchema`) so the result is validated. For Workers AI / AI Gateway, point
      the `openaiCompatible` adapter at the gateway's OpenAI-compatible endpoint (TanStack
      AI ships OpenAI/Anthropic/Gemini/Ollama adapters, not a native Workers-AI one — see
      AGENTS.md gotchas).
- [ ] Pre-fill the create form with the extracted fields for human confirmation before
      writing to D1. Set `source: 'photo'` and `coverImageKey`.
- [ ] Load skills first: `@tanstack/ai#ai-core/structured-outputs`,
      `ai-core/media-generation` / `ai-core/chat-experience` as needed.

---

## Phase 3 — Metadata enrichment

Goal: augment a record with external data.

- [ ] **Discogs** client (`DISCOGS_TOKEN`): search by artist+title → release id, label,
      tracklist, accurate year; store `discogsId` / `discogsUrl`.
- [ ] **The Fork** (`https://the-fork.vercel.app`): fetch Pitchfork score → `pitchforkScore`
      / `pitchforkUrl`.
- [ ] Enrichment runs as a server fn after create, or as a re-runnable "enrich" action on
      a record. Cache responses; rate-limit with **TanStack Pacer** where calls are bursty.
- [ ] Surface score + links in the admin table and the public API payload.

---

## Phase 4 — Public API & consumers

Goal: read the collection from anywhere.

- [ ] Expand `/api/*`: `/api/records/$id`, query params (filter/sort/paginate), and a
      compact shape for the `ssh charliegleason.com` TUI.
- [ ] Confirm CORS for charliegleason.com; consider a cache header + Cloudflare cache.
- [ ] Document the API in README (it's the integration surface for the main site + SSH app).

---

## Phase 5 — Daily suggestions email

Goal: once-a-day "records to buy" digest.

- [ ] **Last.fm** client (`LASTFM_API_KEY`): pull recent/top artists & albums.
- [ ] Suggestion logic: albums not already in the collection; (optional) scan US deals.
- [ ] **Cron Trigger** (already declared, `0 14 * * *`) → Worker `scheduled` handler →
      compose + send via the Cloudflare **Email** `EMAIL` binding to hi@charliegleason.com.
- [ ] Verify the sender address in Cloudflare Email Routing first.

---

## Phase 6 — Polish & ship

- [ ] Sentry: confirm `VITE_SENTRY_DSN` set in prod; spot-check error + span capture.
- [ ] Storybook coverage for key UI (capture flow, record card, table).
- [ ] `bun run build && bunx wrangler deploy`; attach `records.charliegleason.com` as a
      Workers Custom Domain (or uncomment `routes` in `wrangler.jsonc`).
- [ ] Apply migrations to remote D1: `bunx wrangler d1 migrations apply records --remote`.
- [ ] Set production secrets: `bunx wrangler secret put <NAME>` for each in `.env.example`.
- [ ] Swap Clerk test keys for production keys + configure the production domain in Clerk.

---

## Open decisions / risks

- **Workers AI vision quality** for cover→metadata is the biggest unknown; structured
  outputs + human confirmation in Phase 2 de-risk it. May fall back to Anthropic/Gemini
  via AI Gateway if Workers AI models underperform.
- **The Fork / Discogs / Last.fm** are third-party and rate-limited — cache aggressively.
- **TanStack DB live queries are client-only** (no SSR) — disable SSR on any route that
  preloads a DB collection (`db#meta-framework` skill).
- **No staging** by design — test against `--local` D1/R2, then ship to prod.
