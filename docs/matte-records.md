# The record "matte" — current state

_A working summary of how the alpha/matte sleeve image is generated, what we
store, where it breaks, and the approaches we tried and dropped. Companion to the
original brainstorm in [`alpha-matte-sleeves.md`](./alpha-matte-sleeves.md),
which is the design rationale; this file is the "as-built"._

---

## What it is

Every record has two renders built from the same admin-picked sleeve corners:

1. **Square cover** (`professional/{uuid}.webp`) — the sleeve perspective-warped
   edge-to-edge to fill a square. Clean grid/hero tile. This one is reliable.
2. **Matte** — a transparent, true-edged sleeve floating on a small margin with a
   soft contact shadow: the sleeve as an _object in space_. Two variants:
   - **shadow** (`alpha/{uuid}.webp`) — the floating sleeve + baked contact
     shadow. Used on the homepage grid tile.
   - **cutout** (`alpha/{uuid}-cutout.webp`) — the shadowless pure cutout, for
     compositing onto any background.

The detail drawer shows the full square; the grid tile prefers the matte and
falls back to the square (`displayMatteKey` → `displayCoverKey` in `lib/cover.ts`).

---

## The pipeline, end to end

### Trigger & queueing

"Apply" in the editor (`reframeRecord`) is now **non-blocking**:

1. Persists the picked corners (`sleeveCornersJson`) and tone knobs
   (`professionalParamsJson`), sets `professionalJobStatus = "queued"`, and
   enqueues a `{recordId, mode:"professional"}` message. Returns immediately;
   the editor closes and the header queue menu tracks it.
2. The queue consumer (`lib/queue.ts` → `processMessage`, `mode === "professional"`)
   sets `professionalJobStatus = "processing"` and runs
   `generateProfessionalPhoto` (`lib/professional-pipeline.ts`).
3. That reframes the square, then **in parallel** (both paid, both best-effort):
   Real-ESRGAN enhance of the square + `generateMatteFromCapture({useAi:true})`.
   On success it atomically writes the new keys, sets
   `professionalStatus = "approved"` and `professionalJobStatus = "idle"`, and
   bins the superseded R2 objects. A matte failure degrades to no matte rather
   than failing the whole job; retries use the queue's backoff (15/30/60s).

Crucially `professionalStatus` (display/approval state) is **not** touched while a
job runs — an already-approved cover stays live until the new one swaps in.

### The AI matte (`matteAI` in `lib/matte.ts`)

This is the primary path. Given the capture + normalised corners:

1. **Deskew** the sleeve upright into a `MODEL_SIZE = 2048` frame with a
   `MODEL_PAD = 0.2` (20%) margin of surrounding capture (`deskewContentPadded`).
   The picked corners map into this frame as `inset`.
2. **Refine** the quad to the sleeve's true edges (`refineQuadEdges`): slide each
   edge along its normal to the strongest summed luminance gradient, searching
   `TRIMAP_REFINE_SEARCH = 5%·MODEL_SIZE` outward / half that inward. The search
   is **proximity-weighted** (falloff 0.7) so a stronger gradient far outside the
   sleeve — e.g. a wood-plank seam in the floor — can't out-score the true edge
   near the pick.
3. **Build a trimap** (`buildTrimap`) around the refined quad: interior eroded by
   `TRIMAP_BAND = 2.5%·MODEL_SIZE` is locked **foreground**, everything past the
   quad dilated by the same is locked **background**, and only the thin band
   between is left **unknown** for the model to decide.
4. **Run ViTMatte** (our own cog, see below) with `image` + `trimap`,
   `max_size = MATTE_MODEL_MAX_SIZE = 2048`. Read its grayscale alpha.
5. **Clamp** the model's alpha to the **intersection of the refined edge and the
   picked quad** (`rasterizePolygon(refined) ∩ rasterizePolygon(inset)`): refine
   may pull the cut _tighter_, but it can never push it _outward_ past where the
   admin drew. Then keep only the largest blob and feather by `FEATHER = 2`.
6. **Super-resolve** the opaque sleeve content through Real-ESRGAN
   (`MATTE_ESRGAN_MAX = 2800`), re-attach the (upscaled) alpha, so the RGB is
   ESRGAN-sharp over a model-quality edge.
7. **Warp + frame** (`warpMatteToSquare` → `frameCutout`): perspective-warp the
   cutout upright by the refined quad with `MATTE_STRAIGHTEN = 0.5` (half-way to a
   perfect rectangle — upright-ish but keeping some real tilt), bleed the sleeve
   colour `MATTE_BLEED = 10 px` into the margin so the soft edge blends
   sleeve-into-sleeve (not wood), then **tight-crop to the alpha bounds** and
   centre at `CONTENT_SIZE` on a `CANVAS_SIZE = 2400` square (`MARGIN = 0.02`, so
   the sleeve fills **96%**). Foreground-only auto-tone + polish, then synthesise
   the contact shadow (`SHADOW`, tight/dark/down-right).

### The deterministic matte (`matteFromCorners` in `lib/photo-processing.ts`)

The free fallback, used when `useAi` is off **or** any AI step throws (unconfigured
model, Replicate down, fetch error). Same deskew + `refineQuadEdges`, but instead
of a model it rasterises the refined quad directly (inset a hair by
`MATTE_EDGE_INSET = 0.6%` to keep the paper edge out), feathers, and runs the same
`warpMatteToSquare` framing tail. Predictable, straight-edged, no paid call — and
the exact math the editor's live client-side preview runs.

`generateMatte` picks the path and records which one produced the result.

### The model (cog)

`cog/vitmatte-trimap/` — a ViTMatte cog deployed to Replicate as
`superhighfives/vitmatte-trimap`, pinned by version hash
(`MATTE_MODEL_VERSION`). It takes `image` + `trimap` → grayscale alpha. We built
our own precisely so we could **feed it a trimap** (see "discarded" below).

---

## What we store

On the `records` row (`db/schema.ts`):

| Column | Meaning |
| --- | --- |
| `sleeveCornersJson` | Normalised `[[x,y]×4]` picked corners (TL,TR,BR,BL). Admin-only. |
| `professionalParamsJson` | Reframe/tone knob settings (`skipTone`, white balance, saturation, contrast, gamma). Admin-only. |
| `professionalImageKey` | R2 key of the square cover (`professional/…`). Public once approved. |
| `professionalAlphaKey` | R2 key of the **shadow** matte (`alpha/…`). Public once approved. |
| `professionalAlphaCutoutKey` | R2 key of the **cutout** matte. Public once approved. |
| `professionalAlphaSource` | `"ai"` or `"deterministic"` — which path cut it. Admin-only. |
| `professionalEnhanced` | Whether the square went through Real-ESRGAN. |
| `professionalStatus` | Display/approval state: `idle`/`ready`/`approved`/`failed`. Gates public visibility. |
| `professionalJobStatus` | Background job lifecycle: `idle`/`queued`/`processing`/`failed`. Powers the header queue + editor "Generating…". Independent of `professionalStatus`. |
| `professionalError` | Last generation error, surfaced in the editor. |
| `professionalPredictionId` | Vestigial (no longer written); kept nullable so prod code that still selects it doesn't break. Drop in a later migration. |

Both matte variants live under `alpha/` and are served by the existing
`/api/photos/$` passthrough (no dedicated route). Public serialisation
(`toPublicRecord`) nulls the image/matte keys unless `professionalStatus ===
"approved"`, so unreviewed renders are never publicly fetchable.

Key constants (`lib/matte.ts`): `CANVAS_SIZE 2400`, `MARGIN 0.02`,
`FEATHER 2`, `MODEL_SIZE 2048`, `MODEL_PAD 0.2`, `TRIMAP_REFINE_SEARCH 5%`,
`TRIMAP_BAND 2.5%`, `MATTE_BLEED 10`, `MATTE_STRAIGHTEN 0.5`,
`MATTE_MODEL_MAX_SIZE 2048`, `MATTE_ESRGAN_MAX 2800`.

---

## Limitations (known, current)

- **Low-contrast dark-on-dark is the failure case.** A dark charcoal mat on dark,
  shadowed wood is close to a worst case: the sleeve/floor edge is a weak
  gradient, and at the **corners** — where picked points often sit right on the
  mat/wood boundary — the shadowed wood is nearly the same value as the mat. Both
  `refineQuadEdges` and the ViTMatte model struggle there, and a wedge of floor
  can survive into the matte. Mitigations (proximity-weighted refine,
  refined∩picked clamp) help but don't fully solve it; the practical workaround is
  to nudge those corner picks a hair _inside_ the mat before Apply.
- **The cut can't currently exceed the picked quad.** By design (to keep wood
  out), so if you pick _inside_ the sleeve the matte stops there rather than
  finding the true outer edge. Pick on the real edge.
- **Cost & latency.** Each Apply is two paid Replicate calls (ESRGAN + ViTMatte)
  running in the queue (~a minute). Best-effort, so a hiccup degrades gracefully.
- **Worker budget drove the caps.** 128 MB memory / CPU limits are why ESRGAN is
  capped at 2800, the canvas at 2400, and the model at 2048 — the pure-JS re-cut
  allocates full RGBA buffers.
- **`straighten = 0.5` keeps a slight tilt.** Intentional (reads as a physical
  object, not a flat swatch), but on a visibly tilted capture the tight square
  crop frames the tilt. Bump toward 1.0 for a dead-square fill.

---

## What we tried and discarded

- **Generic background removal (BiRefNet / RMBG-class).** The segmenter locks
  onto the _depicted artwork_ (the photo printed inside the mat) rather than the
  physical sleeve/mat, and can't be told where the object is. → Built our own
  **trimap** ViTMatte cog so the picked corners hard-constrain foreground vs
  background and the model only resolves a thin edge band.
- **Perfect-rectangle warp (`straighten = 1`).** Read as a flat dead-square
  swatch, losing the "object" feel. → Settled on `0.5`.
- **Hard inward choke to kill the wood fringe** (eroding the cut ~24 px inward).
  It ate the rounded/worn corners and organic edge. → Replaced with
  `bleedEdgeColor`, which floods sleeve colour _outward_ into the transparent
  margin so the bilinear warp never samples wood — killing the fringe **without**
  choking the alpha.
- **Refine taking the global-max gradient.** A brighter wood-plank seam in the
  floor beyond the sleeve out-scored the true edge and dragged the quad out into
  the floor (which the trimap then locked as foreground). → **Proximity-weighted**
  the gradient score toward the picked edge.
- **Clamping the alpha to the refined quad alone.** Still let refine's overshoot
  through. → **Intersect with the picked quad** so the cut can tighten but never
  exceed where the admin drew.
- **Expanding the clamp ~4 px outward** (to give the feather "room"). It
  re-introduced wood at the bottom corners, where the picks sit on the mat/wood
  line — outward slack there is pure floor. → Reverted to a **tight** cut; the
  feather blends against the mat _inside_ the cut and the colour-bleed covers the
  transparent side, so no outward room is needed.
- **Synchronous Apply** (generate inline in the request). Blocked the request for
  ~a minute. → Moved to the **queue** with a header "in flight" menu.

---

## Open direction (not yet decided)

For sleeves the model can't handle (dark-on-dark corners), the categorical fix is
to stop trusting the model's outline there and **cut to the picked quad as a
crisp rectangle** (inset a hair) — guaranteed no wood, at the cost of the organic
ragged edge and with corners slightly clipped. This could be a per-record toggle
(AI edge vs clean rectangle) rather than a global switch. Left open pending a call
on whether the organic edge is worth the occasional wood fight.
