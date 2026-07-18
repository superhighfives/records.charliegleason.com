---
title: Collections (smart + manual groupings of records I own)
status: Backlog
created: 2026-07-18
updated: 2026-07-18
---

# Collections (smart + manual groupings of records I own)

## Goal
Group records I **own** into named collections — e.g. "Sunday morning", "Late-night
jazz", "Bought in 2019", "Blue Note originals". Collections can be built two ways:
**manually** (hand-pick records) and/or with **AI** (suggest smart groupings from the
collection's metadata), and either way stay fully **editable** — rename, add, remove,
reorder, delete.

## Context
Records are the owned collection (`records` table). There's no grouping concept today —
records are a flat list filtered by facets in admin. This is net-new and orthogonal to
the [[records-i-want-wishlist]] idea (that's don't-own; this is grouping the owned).

Each record now carries rich metadata to group on: `artist`, `year`, `label`, `genre`,
`format`/`size`, `pitchforkScore`, `masterId`, plus `createdAt` (when it entered the
collection). That's the raw material both the manual picker and the AI grouper work from.

Relevant existing code:
- `src/db/schema.ts` — `records` table (the members being grouped)
- `src/routes/admin/` — admin table + editor + Discogs search UX to mirror
- `@tanstack/ai-anthropic` is already a dependency — AI grouping can reuse it, no new SDK
- CI excludes biome; SerpApi / CF Images notes in memory aren't relevant here

## Rough shape
- **Data:** a `collections` table (id, name, optional description/emoji/cover, `origin`
  = `manual | ai`, timestamps) + a `collection_records` join table (collectionId,
  recordId, optional `position` for ordering). Many-to-many — a record can live in
  several collections.
- **Manual flow:** admin creates a collection, then adds records via a picker (reuse the
  existing admin record search/filter). Remove + reorder. Nothing surprising.
- **AI flow:** feed the collection's records' metadata to Claude (`@tanstack/ai-anthropic`)
  and ask it to propose N themed groupings ("moody late-night", "upbeat 80s", "same
  label", "same era") with a name + member record ids + a one-line rationale. Present as
  *suggestions* — the admin accepts/edits/rejects before anything is saved. An accepted
  AI grouping becomes an ordinary editable collection (origin `ai`, but no longer
  special once saved).
- **Editing is the point:** both origins land in the same collection object and share one
  editor — the AI path is just a different way to seed members, not a separate feature.

## Open questions
- Public or admin-only? Wishlist assumed admin-only for v1 — likely same here, but
  collections feel more "showable" (curated playlists of vinyl). Decide before `ready/`.
- AI grouping cost/latency: run on demand ("suggest groupings") vs. cache suggestions?
  Lean on-demand, admin-triggered, results shown transiently until accepted.
- Should a record's cover / a collection cover represent the group visually, or auto-
  build a 2×2 mosaic from members?
- Ordering: freeform drag (needs `position`) or just sort by a chosen field? Start simple
  (sort), add `position` only if manual ordering is wanted.
- Overlap with existing admin facet filters — is a "collection" just a saved filter, or a
  genuine hand-curated set? (This plan assumes genuine curated sets; saved filters are a
  lighter, separate idea.)
