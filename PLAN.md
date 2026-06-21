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

### Phase 1.5 — Harden auth ✅

- [x] `authMiddleware` (`src/lib/auth.ts`, Clerk backend SDK) verifies the session
      **server-side** and is attached to `create`/`update`/`deleteRecord`. Client
      `<SignedIn>` gate stays for UX.
- [x] Public `/api/*` + reads stay unauthenticated; all writes require auth.
- [ ] Optional: `beforeLoad` redirect guard on `/admin` for a cleaner signed-out
      redirect (currently handled by `<RedirectToSignIn>`). See `router-core#auth-and-guards`.

---

## Phase 2 — AI photo capture & extraction ✅

Goal: photograph a record on iPhone → structured metadata. **Decision (researched):**
Claude vision (Sonnet 4.6) via **Cloudflare AI Gateway** as the single AI path —
Workers AI vision can't make web calls, and the gateway's `/anthropic` passthrough
lets Claude's server-side `web_search` tool run for hard identifications.

- [x] `/admin/capture` — iPhone camera input → preview → "Analyze".
- [x] `analyzePhoto` server fn (auth-gated): uploads the photo to **R2** (`PHOTOS`),
      reads the cover with Claude vision (forced tool call → `{artist,title,year,
      confidence}`), looks it up on **Discogs**, escalates to **Claude + web_search**
      when confidence is low / unmatched, then fetches the **Pitchfork** score.
- [x] Result pre-fills `RecordForm`; user confirms; `createRecord` saves with
      `source: 'photo'`, `coverImageKey`, and Discogs/Pitchfork links (via the
      `recordCreateSchema` enrichment fields, which the edit form can't null out).
- [x] `/api/photos/$` streams covers back from R2.
- [x] The Fork wired to its real data source (static `albums.json`, matched locally).
- [x] Discogs `candidates[]` pick-list + manual artist/title search in the capture flow
      (`searchDiscogs` server fn); picking a release re-prefills the form.
- [x] Display cover sourced from the chosen Discogs release, resized via the Cloudflare
      Images binding (webp ≤600px) → R2 at save time; iPhone capture kept admin-only
      (`capturePhotoKey`, omitted from `/api/records`). Thumbnail column in admin table.
- [ ] Follow-ups: re-run Pitchfork lookup when a different candidate is picked (keeps
      the first-pass score, editable); re-source the cover if the Discogs id changes on
      edit; lazy-load / cache thumbnails.

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

## Phase 5 — Daily suggestions email ✅

Goal: once-a-day "records to buy" digest.

- [x] **Last.fm** client (`src/lib/lastfm.ts`): top albums for `LASTFM_USER`.
- [x] Suggestion logic (`src/lib/digest.ts`): top albums minus the collection
      (normalized artist+title match), top 10.
- [x] **Cron Trigger** (`0 14 * * *`) → `scheduled` handler in `src/server.ts` (wraps
      the TanStack entry) → compose + send via the **Email** `EMAIL` binding. Also
      `POST /api/cron/digest` (guarded by `CRON_SECRET`) for manual runs/testing.
- [ ] Before it sends: onboard the sender domain for **Cloudflare Email Sending**
      (cf-bounce subdomain + SPF/DKIM/DMARC TXT — keeps the apex Gmail MX intact).
- [ ] Follow-ups: US deal-scanning; richer email (cover thumbs, Pitchfork scores);
      let the digest link straight into a pre-filled add flow.

---

## Phase 6 — Polish & ship

- [x] Sentry: Worker runtime instrumented via `withSentry` (`src/server.ts`) — fetch +
      scheduled + server-fn spans. Set `VITE_SENTRY_DSN` in prod and spot-check capture.
- [x] Sentry: **browser** error reporting via `Sentry.init` in `src/client.tsx`; the
      `sentryTanstackStart` Vite plugin uploads source maps when `SENTRY_AUTH_TOKEN` is
      set. (Follow-up: add `tanstackRouterBrowserTracingIntegration` for navigation spans.)
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
