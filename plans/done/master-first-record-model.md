---
title: Master-first record model (release optional)
status: Complete
created: 2026-07-17
updated: 2026-07-18
---

## Overview
**Shipped.** The Discogs **master** (the album as a work) is now the primary identity of a
record; the specific **release** (pressing) is an optional per-record pin. In the editor you
**search and pick a master first**, and a record is **publishable only when it has a
`masterId`** — the old `confirmedRelease` checkbox is gone entirely, and "unmatched / needs
review" now keys on a missing master rather than a missing release. Pinning a release is a
later, optional step that sets the exact pressing and unlocks per-pressing Discogs valuation.

For a future reader: "a record" means "an album" here. Everything album-level (artist, title,
year, label, genre, cover, Pitchfork score) is sourced from the master; everything
pressing-specific (catno, country, size, format, marketplace value) only exists once a release
is pinned. Master-only records intentionally show **no** Discogs value ("pick a release to
value").

The operational rollout is complete: deployed, migrations `0013`/`0014` applied, the
one-time identity reset run, and the collection re-curated (a master picked per record to
republish). This unblocks **[[records-i-want-wishlist]]**, which reuses the master client
helpers, the search-picks-a-master UX, and the master metadata handling established here.

## Architecture
How the pieces fit:

- **Schema (`src/db/schema.ts`)** — added nullable `masterId` / `masterUrl` (the new primary
  Discogs identity). `discogsId` / `discogsUrl` were **kept by name** but re-interpreted as
  the *optional pinned release* (`discogsId != null` ⇒ a pressing is pinned — the state
  `confirmedRelease` used to imply). `confirmedRelease` was dropped column-and-all. Keeping
  the `discogsId` name (vs. renaming to `releaseId`) was deliberate to minimise churn across
  `records.ts`, the public API, and the admin UI.
- **Discogs client (`src/lib/discogs.ts`)** — candidate/detail types carry `masterId` /
  `masterUrl`; added `getMasterDetail()`, `searchMasters()` + `getMasterCandidate()` /
  `parseMasterId()` (paste path), and `getMasterVersions()` (a master's vinyl pressings).
  `getReleaseValue()` stays release-scoped by design.
- **Data flow** — capture (`analyzeCapture`) searches **masters**, sets album + cover from the
  master's main release, and pins **no** pressing. Refresh (`refreshRecordById`) has three
  branches: pinned release → release detail + value; master-only → album fields, no value;
  neither → best-guess a master by cover-derived artist/title (gap-fill, never publish). The
  editor sources its release pick-list from the linked master's versions.
- **Publish gate** — `publishRecord` and bulk `publishRecords` require `masterId`; the
  "unmatched" facet/badges re-key to a missing master.
- **Admin UI** — the Confirmed/Unconfirmed facet, table badge, and detail-panel line became
  Release-pinned/Album-only; the `confirmedRelease` checkbox was replaced by the
  `MasterPicker` (primary) + optional release picker.
- **Validation & public API** — `confirmedRelease` removed from the schemas and
  `ADMIN_ONLY_FIELDS`; `masterId` is exposed publicly (harmless, enables album grouping
  later), pinned-release value stays admin-only.

**Honest deviations from the original approach:**
- The plan started as "master *derived from* a release," then **pivoted (2026-07-17)** to
  "master-first with a hard publish gate" — you curate the master directly and it gates
  publishing. That pulled `searchMasters()` back into scope (it had been dropped as dead code
  when the only reachable album-only state was un-pinning a release that already carried its
  master) because the editor now needs to search masters from scratch.
- **D1 (existing data on migration): non-destructive.** The considered "unpin never-vouched
  rows + clear caches to preserve the review signal" path was rejected. Instead all existing
  pins were kept and `confirmedRelease` simply retired. Note this differs from the separate
  **one-time reset SQL** (`scripts/reset-discogs-identity.sql`) that *was* run to give the
  collection a clean master-first slate — the reset is a deliberate curation restart, not the
  migration's automatic behaviour.
- The masterId backfill ended up needing **no bespoke script** — the existing throttled,
  queue-backed refresh path fans a Discogs re-pull over the collection, so "select all →
  Refresh" does it, rate-limit-respecting and resumable.

## Goal
Make the Discogs **master** (the album as a work) the primary identity of a record, with
the specific **release** (pressing) becoming an *optional* per-record choice. Choosing a
release becomes the act of pinning a record to an exact pressing — and **replaces the
`confirmedRelease` checkbox** entirely.

This is a foundational data-model correction: the app was built around releases, but the
natural grain of "a record in a collection" is the album. It's worth doing on its own
merits, and it unblocks **[[records-i-want-wishlist]]** (an album-level wishlist).

## Pivot — master-first with a hard gate (2026-07-17)
Partway through, the direction firmed up beyond "master derived from a release." The model
Charlie wants:
- **The master is what you curate first.** You **search and pick a master (album)** directly
  in the editor. A record is **publishable only when it has a `masterId`**; publish and
  bulk-publish block without one, and "unmatched / needs review" now keys on a **missing
  master**, not a missing release.
- **The release is a later, optional pin** — for the exact pressing + per-pressing value.
- **Reset existing data ("full fresh start"):** unlink every release, clear the now-orphaned
  release caches, and unpublish everything, so the whole collection flows back through the
  new "pick a master to publish" curation. See the Reset section.

Consequences vs. the original plan: `searchMasters()` is **back in scope** (it's how you
pick a master with no release to derive from — this was the wishlist's consumer, but the
editor now needs it too), and the auto-derive-master-from-release path is demoted to a
convenience on the release pick, not the primary flow.

## Context

### Current state
Each `records` row is anchored to a specific Discogs **release**:
- `discogsId` / `discogsUrl` (`src/db/schema.ts:28-29`) — the release.
- `confirmedRelease` (`schema.ts:39-41`) — boolean "I've vouched this match is right."
- Release-specific caches: `catno` (30), `country` (31), `size` (22), `format` (20),
  and `discogsValue` / `discogsValueCurrency` / `discogsValueJson` / `discogsValueFetchedAt`
  (43-47).
- There is **no** `masterId` field anywhere (confirmed).

`confirmedRelease` today is **purely an annotation** — it drives a "Confirmed" filter
facet (`src/routes/admin/index.tsx:131-143`) and a table column badge (`index.tsx:691-704`),
and shows a badge in the detail panel (`src/components/record-panel.tsx:236-241`). It gates
**nothing** — not publishing, not value, not the public API (it's stripped as an
admin-only field, `src/lib/records.ts:65,90`). That makes it safe to retire.

### The enabling facts (why this is feasible)
- Discogs `/releases/{id}` responses **already include `master_id` and `master_url`** — the
  client (`src/lib/discogs.ts`) simply doesn't read them today.
- Discogs `/database/search` supports `type=master`, and there's a `/masters/{id}` endpoint
  returning `main_release`, `title`, `year`, `genres`, `images`, etc.
- So we can (a) derive a master from any release we already have, and (b) search masters
  directly for new adds.

### What's release-specific vs album-level
- **Release-specific** (only meaningful once a pressing is chosen): `catno`, `country`,
  `size`, `format`, and all `discogsValue*` (marketplace pricing is per-pressing —
  `getReleaseValue()` requires a release id, `discogs.ts:392-446`).
- **Album-level** (safe to source from the master): artist, title, year, label, genre,
  cover image, `pitchforkScore`.

## Approach

### 1. Schema (`src/db/schema.ts`)
- **Add** `masterId` = `text("master_id")` (nullable) and `masterUrl` = `text("master_url")`
  (nullable). This is the new primary Discogs identity when present.
- **Keep** `discogsId` / `discogsUrl` but re-interpret them as the *optional chosen release*.
  `discogsId != null` now means "a specific pressing has been pinned" — this is the state
  that `confirmedRelease` used to express.
- **Drop `confirmedRelease` entirely** — column and all. (Charlie: "I never used it.")
- Both `masterId` and `discogsId` stay nullable: manual/unmatched records may have neither,
  exactly as today.

Retaining the `discogsId` column name (rather than renaming to `releaseId`) is deliberate —
it minimises churn across `records.ts`, the public API, and the admin UI. Note the semantic
shift in a schema comment.

> **Deploy-ordering note (2026-07-17):** dropping the column reintroduces the hazard the
> repo's `professionalPredictionId` convention avoids — `db:migrate` runs separately from
> `wrangler deploy`, and Drizzle emits an explicit column list, so there's a brief release
> window where either the old worker selects a dropped column or the new worker selects a
> not-yet-added one. For this single-user admin tool it's negligible: run `wrangler deploy`
> and `db:migrate` back-to-back and don't touch the admin in between. Migrations: `0013`
> adds `master_id`/`master_url`; `0014` drops `confirmed_release`.

### 2. Discogs client (`src/lib/discogs.ts`)
- Extend `DiscogsCandidate` (`discogs.ts:15-29`) with `masterId: string | null` and
  `masterUrl: string | null`; populate from the release payload's `master_id`/`master_url`
  in `searchReleases()` and `getReleaseCandidate()`.
- Extend `DiscogsReleaseDetail` (`discogs.ts:142-158`) to surface `masterId`/`masterUrl`.
- Add `getMasterDetail(masterId)` → `/masters/{id}`, returning album-level fields
  (title, year, genres/styles, canonical image, `mainReleaseId`).
- Leave `getReleaseValue()` unchanged — it stays release-scoped by design.

> **Deviation (2026-07-17):** dropped `searchMasters()` from this plan. Nothing here
> consumes it — the "album only" state is reached by *un-pinning* a release that already
> carries its master (not by searching masters from scratch), so adding it now would be
> dead code. The wishlist ([[records-i-want-wishlist]]) is where master search has a real
> consumer; it can add it then.

### 3. Data flow
- **Analysis** (`src/lib/analyze.ts:280-369`): still searches releases (vision gives us a
  concrete cover), but now records `masterId`/`masterUrl` from the chosen candidate. The
  master becomes the anchor; the matched release is offered as the suggested pressing but
  isn't auto-pinned unless we choose to (see decision D2).
- **Queue persistence** (`src/lib/queue.ts:276-300`): write `masterId`/`masterUrl`
  alongside the existing fields.
- **Refresh** (`src/lib/queue.ts:74-106`): if a release is pinned (`discogsId`), refresh
  release detail + value as today. If only a master is set, refresh album-level fields from
  `getMasterDetail()` and skip valuation.
- **Editor swap flow** (`src/routes/admin/records.$id.tsx`): picking a candidate pins that
  release (sets `discogsId`) and back-fills its master; a "clear release / keep album only"
  action unpins (`discogsId = null`, album fields sourced from master).

### 4. Valuation semantics
Value is inherently per-pressing. New rule: **a record shows a Discogs value only when a
release is pinned.** Master-only records display no value (UI copy: "pick a release to
value"). This is a behavioural change but an honest one — it also gives the release-picker a
clear purpose. Existing valued records keep their value via the migration (below).

### 5. Admin UI
- **Facet** (`index.tsx:131-143`): replace the "Confirmed / Unconfirmed" facet with
  "Release pinned / Album only" (`test: r => r.discogsId != null` / `== null`).
- **Table column** (`index.tsx:691-704`): swap the "confirmed" badge for a "release pinned"
  indicator.
- **Detail panel** (`record-panel.tsx:236-241`): replace "Confirmed release" badge with a
  "Pinned to <catno/country>" line when a release is set.
- **Edit form** (`src/components/record-form.tsx:91-115`): remove the `confirmedRelease`
  checkbox; the release-picker (candidate list / paste-release-URL, already present in
  `records.$id.tsx`) becomes the mechanism. Add an explicit "album only (no specific
  pressing)" state.

### 6. Validation & public API
- `src/lib/record-schema.ts`: drop `confirmedRelease` from `recordInputSchema`,
  `RecordFormValues`, `recordFormSchema`, `emptyRecordForm`, `formValuesToInput()`,
  `recordToFormValues()` (lines 22-25, 63, 87, 103, 130, 148). Add `masterId`/`masterUrl`.
- `src/lib/records.ts`: remove `confirmedRelease` from `ADMIN_ONLY_FIELDS` (65) and
  `toPublicRecord()` (90). Decide master exposure — expose `masterId` publicly (harmless,
  enables album grouping later); keep pinned-release value admin-only as today.

### 7. Migration & backfill
Migrations use drizzle-kit → `wrangler d1 migrations apply` (`package.json:18-21`); latest
is `drizzle/0012_professional_job_status.sql`, so this is `0013`.

1. **Schema migrations** — **DONE** (applied local): `0013_robust_hellcat.sql` adds
   `master_id`/`master_url`; `0014_quick_sunspot.sql` drops `confirmed_release`.
2. **Backfill `masterId`** — *no new script needed.* `refreshRecordById` now backfills
   `masterId`/`masterUrl` on the pinned path, and the existing throttled, queue-backed
   `refreshRecords` (`records.ts`) already fans a Discogs re-pull over every record with a
   `discogsId`. So post-deploy: select the whole collection in admin → **Refresh** → every
   pinned row gains its master, rate-limit-respecting and resumable. No bespoke script.
3. **Reconcile chosen release from old `confirmedRelease`** (D1) — **none.** Per D1
   (resolved: keep all pins), there is no destructive reconcile. `confirmedRelease` is left
   as a vestigial column and ignored.

## Decisions (resolved)

- **D1 — What happens to existing release pointers on migration.**
  **RESOLVED (Charlie, 2026-07-17): keep all pins, drop the distinction.** Every
  currently-matched record stays pinned to its release — nothing is unpinned, no caches
  cleared. `masterId` is backfilled for all of them (via the refresh path, step 2 above).
  The old `confirmedRelease` flag is simply retired/ignored; its confirmed-vs-unconfirmed
  review signal is intentionally dropped. This is the **non-destructive** path — no bespoke
  reconcile script, nothing to run against prod beyond the (idempotent, resumable) master
  backfill.
  *(The alternative considered — unpin the never-vouched rows and clear their release caches
  to preserve the review signal — was rejected as unnecessarily destructive.)*

- **D2 — Does analysis auto-pin the matched release for new captures?**
  Yes — vision produces a concrete cover from a real pressing, so auto-pin the top candidate
  (keeps today's behaviour and valuation on capture). The new "album only" control lets
  Charlie unpin when he wants the record to be pressing-agnostic.

- **D3 — Column naming.** Keep `discogsId`/`discogsUrl` for the chosen release (low churn);
  add `masterId`/`masterUrl`. Document the semantic shift in the schema comment.

- **D4 — Master-only records show no Discogs value.** Accepted (value is per-pressing).

## Risks
- **Backfill accuracy**: a master derived from a *wrong* auto-matched release inherits that
  error. Pre-existing data-quality issue; mitigate by spot-checking after backfill.
- **Releases without a master**: some Discogs releases have no `master_id` (standalone
  releases). Fallback: leave `masterId` null and treat the pinned release as the identity
  (the record still works, just isn't album-grouped).
- **Rate limits**: backfill must throttle to 60 req/min; run it as a batched/resumable
  script, not inline.

## Tasks

Increment 1 — master alongside release (shipped):
- [x] Schema: add `masterId`/`masterUrl`; retire then fully drop `confirmedRelease`
      (migrations `0013` + `0014`).
- [x] Discogs client: master fields on candidate/detail types; `getMasterDetail()`.
- [x] Analysis + queue: persist master; auto-pin top candidate (D2).
- [x] Refresh: master-only path (album fields, no value) vs pinned path.
- [x] Editor: release-picker as pin mechanism; "album only" / unpin; remove confirmed checkbox.
- [x] Admin table + facet + detail panel: swap confirmed → release-pinned.
- [x] Validation schema + public API: drop `confirmedRelease`, add master fields, expose `masterId`.
- [x] Valuation UI: value fetch gated on a pinned release.

Increment 2 — master-first with a hard gate (the pivot, shipped):
- [x] `searchMasters()` + `DiscogsMasterCandidate` in the client; `getMasterCandidate()` +
      `parseMasterId()` for the paste path.
- [x] Server fns: `searchDiscogsMasters`, `lookupDiscogsMaster`.
- [x] Publish gate: `publishRecord` + bulk `publishRecords` require `masterId`;
      "unmatched" facet + badges re-keyed to a missing master.
- [x] Editor `MasterPicker`: search/paste a master (primary, publish gate), release picker
      demoted to optional pressing pin; save uses the effective master; submit label +
      draft toast reflect the gate.
- [x] One-time reset SQL (`scripts/reset-discogs-identity.sql`): unlink releases, clear
      release caches, unpublish. Ran local (empty dev DB); **remote is Charlie's call.**
- [x] Refresh guesses a master: `refreshRecordById` gains a third branch — a record with
      neither release nor master searches Discogs masters by its (cover-derived) artist/title
      and attaches the best hit (gap-fills year/genre, never publishes). `refreshRecords` now
      enqueues all selected rows, so "select all → Refresh" seeds best-guess masters for
      review. Turns the reset's blank slate into a one-click first pass.

Increment 3 — album identifies, releases follow (shipped):
- [x] `getMasterVersions(masterId)` — a master's vinyl pressings as `DiscogsCandidate[]`;
      server fn `getDiscogsMasterVersions`.
- [x] Editor release pick-list is sourced from the linked album's versions (manual
      search/URL still overrides; stored `candidatesJson` is the fallback) — pick the album,
      then pick one of its pressings.
- [x] Capture flow (`analyzeCapture`) searches **masters**, not releases: sets the album +
      cover (from the master's main release), pins **no** pressing, stores no release
      candidates. Existing rows are untouched (their vision isn't re-run) — future captures
      only, per Charlie. Duplicate detection now matches master → release → name.

Operational rollout (complete):
- [x] **Deploy**, then run migrations `0013`/`0014`, then run the reset SQL `--remote`.
- [x] Re-curate: pick a master per record to republish. (No auto-backfill — masters are
      chosen by hand now, per the pivot.)
- [x] Verify in-app: master search/pick, publish gate, capture flow still pins+publishes.
