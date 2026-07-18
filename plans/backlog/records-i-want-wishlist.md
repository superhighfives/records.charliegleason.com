---
title: "Records I want" wishlist (album-level)
status: Backlog
created: 2026-07-17
updated: 2026-07-17
---

# "Records I want" wishlist (album-level)

## Goal
A simple "records I want" list in admin — a wishlist of albums to hunt for.
The twist: it should be keyed to the **album itself**, not a specific pressing/release,
so a want isn't tied to one particular Discogs release.

## Depends on
**[[master-first-record-model]]** (in `ready/`) must ship first.

That refactor makes the Discogs **master** the primary identity of a record (with an
optional per-record release). Once it lands, "album-level" is the app's native grain —
the master client helpers, the search-picks-a-master UX, and the master metadata cache
all exist, and this wishlist just reuses them. Building "I want" before the refactor
would mean inventing master-handling twice.

## Context
Originally the collection was built entirely around Discogs **releases** (each `records`
row stored a specific release `discogsId`, no album grouping). The master-first refactor
fixes that. No wishlist/wants/favourites concept exists yet — this is net-new.

**Album-level is feasible** because Discogs models a "master" (the album as a work) above
individual releases; the refactor establishes how we resolve, store, and display masters,
and this feature sits on top of that.

Relevant existing code:
- `src/db/schema.ts` — `records` table (gains `masterId` in the refactor)
- `src/lib/discogs.ts` — Discogs client (gains master helpers in the refactor)
- `src/routes/admin/` — admin table + editor patterns to mirror

## Rough shape
- New lightweight `wants` (wishlist) table, keyed by Discogs **master id** (+ cached
  artist/title/year/cover for display). Kept separate from `records` — it's a different
  thing (don't-own vs own). Reuses the master cache/helpers from the refactor.
- Admin: a simple list view + add flow (search Discogs → pick the album/master). Reuses
  the master-first search UX built in the refactor.
- Nice-to-haves later: "mark as acquired" → seed the add-a-record flow; surface whether
  any owned record already matches a want (a `records.masterId == wants.masterId` join,
  trivial once the refactor lands).

## Open questions
- Store wants in a separate table, or a `type`/`wanted` flag on `records`? (Leaning
  separate table — different lifecycle, no photo/value pipeline needed.)
- Admin-only, or ever public? (Assume admin-only for v1.)
- How much display metadata to cache vs. re-fetch from Discogs on view? (Follow whatever
  the refactor settles for the master cache.)
