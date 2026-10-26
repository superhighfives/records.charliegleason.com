---
title: Simplify record creation to a standard square crop
status: In Progress
created: 2026-10-25
updated: 2026-10-25
---

# Simplify record creation to a standard square crop

## Goal

Drop the transparent sleeve cut-out (matte, alpha WebPs, ViTMatte, the matte container)
and go back to one opaque square cover per record. Any "object in space" feel comes from
CSS (a jagged or worn edge, a shadow) instead of AI models and per-record alpha files.
Result: a much smaller pipeline that's cheaper and easier to reason about.

## Context

The cut-out came in with `62a581d` (2026-07-14, "Alpha/matte sleeve render with
trimap-guided ViTMatte"). It aimed for a sleeve with true edges floating on the grid with a
contact shadow. Tuning commits followed (`95741e2`, `c321f20`, `98b97e9`, `23ab7ec`,
`1508968`). In practice it doesn't earn its complexity:

- A two-stage first pass (cover, then matte) that exists mostly because the matte OOMs a
  128 MB isolate.
- A Cloudflare Container (`containers/matte/`, `MatteContainer` DO) plus a custom Replicate
  model (`cog/vitmatte-trimap/`).
- A deterministic fallback matte, a matte audit sweep, three badges, and retry buttons all
  over the admin.
- An inner/outer **band** in the corner editor. It exists only as the ViTMatte trimap.
- `alpha/{uuid}.webp` and `alpha/{uuid}-cutout.webp` per record, and `.disc-mask` CSS to
  hide the resting vinyl behind ragged alpha edges.

**Important: corners don't go away.** The square cover is a perspective warp of an angled
phone photo (`professional.ts#reframeFromCorners`, `band.inner`). A plain centre crop
would be skewed and include the table. So "standard crop" means **one quad → homography →
square**, which is the non-AI part we keep. `professional.ts`'s header says the
deterministic warp was chosen *because* AI segmenters locked onto the artwork.

Unaffected: the rec board (`toLiteRecord` already uses the square), the mac app, Claude
identification (`analyze.ts`), colour textures, Discogs matching.

Related: `plans/backlog/learned-sleeve-corner-detection.md`. Its premise is "corners and
mattes are one pipeline". Once the matte is gone, that premise goes too (see Phase 5).

## Approach

Work in phases. Each one ships on its own, and the reversible ones go first.

### Phase 1: stop rendering the cut-out (reversible)

- `collection-grid.tsx` `RecordTile`, `tileCoverSrc`, preloader: always use
  `displayCoverKey`. Remove the `object-contain` matte branch.
- `record-panel.tsx#CoverZoom`: always the square treatment.
- Remove `.disc-mask` and the matte-margin notes in `styles.css`, unless the new edge
  treatment needs something similar (see below).
- `records.ts#toPublicRecord`: stop exposing `professionalAlpha*`.
- Add the CSS edge treatment (see "Edge treatment").

Nothing gets deleted yet, so this is easy to compare and roll back.

### Phase 2: remove the matte pipeline

- Delete `lib/matte.ts`, `matte-config.ts`, `matte-container.ts`, `matte-pixels.ts`,
  `matte-audit.ts` (+ test), and `matte-*-badge.tsx` (+ test).
- `capture-first-pass.ts`: drop stage 2 (`runCaptureFirstPassMatte`). The first pass
  becomes one step.
- `professional-pipeline.ts` / `queue.ts`: remove the `professional-matte`,
  `professional-matte-fallback`, `audit-mattes` and `capture-first-pass-matte` modes.
  Apply becomes reframe, then optionally enhance.
- `photo-processing.ts`: delete the matte, trimap, shadow and audit sections (roughly
  lines 824 to the end). Keep `warpToSquare`, `homography`, `autoTone`, `applyPolish`,
  `toPixelCorners`, `refineQuadEdges*` and `offsetQuad`. Trim the test file to match.
- `pro-preview.tsx`: remove matte mode. Remove `matteToneFromParams` from
  `reframe-params.ts`.
- Admin: remove the matte tabs, the checkerboard, the "Retry Magic matte", "Re-cut this
  matte" and "Re-apply matte" buttons, the matte-source and audit facets, "Audit covers",
  "Retry flagged mattes", and the matte step labels in `queue-menu.tsx`.
- Remove the matte server fns in `records.ts` (`retryProfessionalMatte`,
  `retryProfessionalMattes`, `retryFlaggedMattes`, `startMatteAuditSweep`) and the matte
  branches in the reaper, `clearProfessional` and `deleteRecord`.
- **Container:** ESRGAN currently goes through the matte container's `/enhance`. Switch
  Enhance to `enhanceCoverInWorker`, which preview already uses. Then delete
  `containers/matte/` and the container in `wrangler.jsonc`, and add a `deleted_classes`
  DO migration for `MatteContainer`. Simplify `preview.yml`.
- Delete `cog/vitmatte-trimap/` and archive the Replicate model.

### Phase 3: schema and storage cleanup (destructive)

- Drizzle migration (`bun run db:generate`) dropping:
  - the `professionalAlphaKey`, `professionalAlphaCutoutKey` and `professionalAlphaSource`
    columns
  - the `professionalMatteAuditCheckedAt` and `professionalMatteAuditReason` columns
  - the `matte_audit_state` table
  - the `professionalPredictionId` column (vestigial)
  - the `"matte"` value from the `professionalStage` enum and the `matte-*` `jobStep`
    values
- Delete the `alpha/` prefix in R2 (about 600 objects). Do this last, after Phase 1 has
  been live for a while. It can't be undone.

### Phase 4: band → single quad

- `sleeveCornersJson` stores `{inner, outer}`. Collapse it to one quad. The warp already
  uses `inner`. Either run a data migration (`inner` → the stored quad) or read both shapes
  for a while.
- `lib/sleeve-corners.ts` (`bandFromQuad` etc.) shrinks to quad helpers.
- `corner-editor.tsx` (810 lines) becomes a single-quad editor with magnifier, drag, Snap
  and Detect. This is the biggest UX win for day-to-day capture.

### ~~Phase 5: drop ML corner detection~~ (decided: keep it)

Keep the learned corner model and its retraining loop. Once the matte is gone, it does
crop-only work, and better corners still mean better squares, so it's worth improving.
After Phase 4 the training labels become the single quad, and the inner/outer band goes
from `ml/` and the export too.

### Enhance: replace upscaling with a bigger capture

Why Enhance exists: `image-resize.ts#squareDownscale` centre-crops **and downscales the
capture to 2048px** in the browser before upload. The sleeve fills about 90% of that, so
the warped square is about 1800px of real detail stretched to the 2000px cover. Real-ESRGAN
upscales and sharpens to make up for it.

An iPhone photo is about 4032×3024 (or more), so the square is about 3000px with the
sleeve at about 2700px. That's already above 2000px. So:

- Upload the capture at full resolution, or capped at around 3200px, with higher JPEG
  quality (0.92 → 0.95). Keep the square centre-crop if it helps upload size.
- Encode the professional square from that, with no upscale.
- Drop Real-ESRGAN, `esrgan-config.ts`, the "Enhance" step and `professionalEnhanced`.
  That also removes the last reason for the matte container.
- Check that Photon decode/warp of a ~3000px image fits the 128 MB isolate (about 36 MB
  RGBA per buffer, so watch for copies).
- Old records keep their existing (enhanced) squares. Only new captures change.

### Edge treatment (CSS, no per-record assets)

The options, cheapest first:

1. **`clip-path: polygon(...)` from a seeded generator.** Make a jagged or worn outline
   from the record id: a few dozen points along each edge with small random inset, plus
   occasional "nicks" and slightly soft corners. It's deterministic per record, so each
   sleeve looks different but stable. It's pure CSS at render time (inline style or a CSS
   variable), so there's no image work. Add `filter: drop-shadow(...)` on a wrapper,
   because `drop-shadow` follows the clip only when it's applied to the parent.
2. **SVG `<mask>` / `mask-image` with `feTurbulence` + `feDisplacementMap`.** This gives
   more organic, paper-like fraying. It costs more to paint, so watch scroll performance
   on iOS (see the will-change lesson in memory).
3. **A small set of shared edge masks** (e.g. 6 PNG/SVG masks, picked by id hash). This
   is a middle ground if 1 looks too geometric.

**Decided: option 1, subtle.** No tearing, just edges that are randomly a little
distinct. Prototype (2026-10-25) in `lib/sleeve-edge.ts`:
- 7 points per side, on a smoothed random walk up to 0.55% inward
- corners worn back 0.35–1.2%
- seeded from the record id

It's used on the grid tile (on a wrapper, so the active `scale-105` zoom stays inside the
outline) and on the panel's `CoverZoom`. The tile cover is inset 3% to bring back the
cut-out's breathing room. A two-layer `drop-shadow` on a `.sleeve-shadow` parent is
desktop only, so the touch loop's per-frame `scale` writes don't repaint a filtered
subtree. The prototype also removes the `.disc-mask` render. The opaque cover hides the
resting disc on its own, but the `.disc-mask` CSS still needs deleting. Check whether `.disc-mask` is still needed: if the nicks reveal the resting
VinylDisc, either keep a simplified mask or inset the disc.

## Tasks

PR 1 (branch `simplify-record-crop`): Phases 1 and 2, plus dropping ESRGAN.

- [x] Prototype edge treatment option 1 on the grid and panel.
- [x] Phase 1: grid tiles and the panel thumbnail render the square cover with the
      clip-path edge. Alpha keys are no longer exposed publicly. `.disc-mask` is removed.
- [x] Phase 2: delete the matte pipeline. That covers:
      - `matte*.ts` and the badges
      - the stage-2 first pass
      - the matte, matte-fallback and audit queue modes
      - the matte/trimap/shadow/audit sections of `photo-processing.ts`
      - the matte preview mode
      - the admin matte UI and server fns
      - `containers/matte`, `cog/vitmatte-trimap`, `@cloudflare/containers`
      - the container + DO in `wrangler.jsonc` (a `v2` `deleted_classes` migration)
- [x] Drop Real-ESRGAN. Apply is now a single free re-warp and commit
      (`applyProfessional`).
- [x] Queue messages still in flight at deploy (`professional-matte*`,
      `capture-first-pass-matte`, `audit-mattes`) are acked as no-ops.
- [ ] Review the prototype on iOS with `?perf`. Tune the inset, the edge amplitude and the
      shadow.
- [ ] After deploy: check the matte container application is gone from the Cloudflare
      dashboard. If it lingers, delete it with `wrangler containers delete`. Archive the
      `superhighfives/vitmatte-trimap` model on Replicate.
- [x] Cover load time. A cold `?w=500` resize of the old ESRGAN masters measured
      0.83 s median across all 310 covers, against 0.19 s once edge-cached. Scroll FPS
      matched production, and turning `?noclip` / `?noshadow` on made no consistent
      difference, so images were the bottleneck. The fix:
      - Apply writes pre-sized `@500` / `@800` / `@1600` webp copies next to each master
        (`photo-variants.ts`).
      - `/api/photos/$` serves a copy directly when one exists, and falls back to the
        on-the-fly resize when it doesn't.
      - The admin menu has a "Re-apply all" action that rebuilds every live cover
        (2000px master + copies).
      - Re-apply leaves the old `alpha/` files and keys alone.
- [ ] Run "Re-apply all" after deploy.
- [ ] Raise the capture upload size and quality (`image-resize.ts` `TARGET_SIZE`,
      `professional.ts` `CAPTURE_DECODE_MAX`). Verify the warp's memory at ~3000px first.

Later PRs:

- [ ] Phase 3: migration to drop the matte columns and the `matte_audit_state` table. Drop
      the legacy queue-mode no-ops at the same time.
- [ ] Phase 3: delete the `alpha/` R2 objects (after confirming).
- [ ] Phase 4: collapse the band to a single quad, with a data migration and a simplified
      corner editor.
- [ ] Rescope `learned-sleeve-corner-detection.md`: crop only, single quad, no matte
      premise.

## Open questions

- **Phase 4 data:** migrate `sleeveCornersJson` in place, or read both shapes and migrate
  lazily on the next edit?
- **The shape of the branch:** one big PR or one per phase? Phases 1–2 together make a
  natural first PR. Phase 3 should probably follow after a soak period.
- **Clear and plastic sleeves (future, separate plan):** transparency done right is the
  one thing the cut-out promised and never really delivered. Ideas, none of them
  AI-dependent:
  - a per-record "clear sleeve" flag rendered with CSS (`mix-blend-mode`, a frosted
    `backdrop-filter` frame, or the disc showing through at reduced opacity)
  - a two-shot capture (sleeve on a light board vs dark board) to derive real
    transmission
  - a hand-authored mask for the few records that need it

  Out of scope here. Write it up in `backlog/` once this ships.

## Decisions (2026-10-25)

- Keep ML corner detection and keep improving it. Phase 5 is dropped.
- Drop Real-ESRGAN Enhance in favour of a full-resolution, higher-quality capture.
- Edge: subtle per-record `clip-path`, not torn.
