---
title: Fix preview cleanup's swallowed failures and add a scheduled backstop
status: Complete
created: 2026-08-07
updated: 2026-08-07
---

# Fix preview cleanup's swallowed failures and add a scheduled backstop

## Problem

Investigating a Cloudflare account-level quota issue on a sibling repo
(`nylon-impossible`) surfaced a shared pattern across all three repos using
this per-PR preview model: `continue-on-error: true` on every cleanup step
meant a real deletion failure (auth, rate limit, an actual bug) was
indistinguishable from a merged PR with nothing left to clean up — both just
silently succeeded from the workflow's perspective. `nylon-impossible` had
the ordering wrong too (Worker deleted before Queue, which always fails —
code 10064), so it accumulated ~100 orphaned Workers. This repo already had
the ordering right (see the existing comment in `preview.yml`'s `cleanup`
job), which is why it only had 2 orphans (`records-pr-99`, `records-pr-100`)
rather than 100+ — but a real failure here would still have gone unnoticed
the same way.

## Solution

- `cleanup` job: replaced the three `continue-on-error: true` steps with one
  step that runs all three deletions, classifies failures ("does not exist"
  is benign — the PR may have closed before deploy ever ran, or a previous
  cleanup run already got it — anything else fails the job so it's visible).
- `Ensure per-PR queue exists`: same fix — only tolerate "already taken",
  fail loudly on anything else, instead of blanket `|| true`.
- Added `preview-cleanup-sweep.yml`: a daily scheduled backstop, independent
  of the per-PR close event ever firing correctly. Lists every
  `records-pr-*` / `records-analyze-pr-*` resource account-wide (paginated),
  cross-checks against currently-open PRs via the GitHub API, deletes
  orphans using the same consumer → worker → queue order.

## Tasks

- [x] Fix `cleanup` job's failure classification.
- [x] Fix `Ensure per-PR queue exists`'s blanket `|| true`.
- [x] Add `preview-cleanup-sweep.yml`.
- [x] Delete the 2 existing orphans (`records-pr-99`/`records-analyze-pr-99`,
      `records-pr-100`/`records-analyze-pr-100`) by hand as part of the
      cross-repo cleanup.

## Overview

Same root-cause class as `nylon-impossible`'s incident, much smaller blast
radius here since the deletion ordering was already correct. Brought this
repo's error handling and backstop coverage in line with the fix applied
there.
