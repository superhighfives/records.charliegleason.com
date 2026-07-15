# The record "matte" — current state

_A working summary of how the alpha/matte sleeve image is generated, what we
store, where it breaks, and the approaches we tried and dropped. Companion to the
original brainstorm in [`alpha-matte-sleeves.md`](./alpha-matte-sleeves.md),
which is the design rationale; this file is the "as-built"._

---

## What it is

Every record has two renders built from the same admin-picked **corner band** — two
nested quads: an **outer** quad drawn wholly on the background (everything beyond it
is certified background) and an **inner** quad drawn wholly on the sleeve (everything
within it is certified sleeve). The true physical edge lies in the band between —
which is exactly a matting trimap's unknown region, drawn by hand instead of inferred
from a single ambiguous pick line:

1. **Square cover** (`professional/{uuid}.webp`) — the sleeve perspective-warped
   edge-to-edge to fill a square, straight from the band's **inner** quad (certified
   sleeve-only, so no background sliver can enter the border). Clean grid/hero tile.
   This one is reliable.
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

1. Persists the picked corner band (`sleeveCornersJson`) and tone knobs
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
   bins the superseded R2 objects. A matte failure (both the AI path _and_ its
   deterministic fallback dying — almost always a transient R2/Images blip like
   "Network connection lost.") does **not** wipe the matte we already had: the
   fresh cover still commits, the existing matte keys are **preserved**, and the
   job is flagged `professionalJobStatus = "failed"` with the error on
   `professionalError`. The editor surfaces that and the primary button becomes
   **Retry** (a manual re-Apply) rather than a dead-end Close. The enhance is
   still soft best-effort (degrades to a plain reframe). Whole-job retries use
   the queue's backoff (15/30/60s).

Crucially `professionalStatus` (display/approval state) is **not** touched while a
job runs — an already-approved cover stays live until the new one swaps in.

### The AI matte (`matteAI` in `lib/matte.ts`)

This is the primary path. Given the capture + the normalised corner band:

1. **Deskew** the sleeve upright into a `MODEL_SIZE = 2048` frame with a
   `MODEL_PAD = 0.2` (20%) margin of surrounding capture (`deskewBandPadded`),
   using the **outer** quad as the reference; the inner quad maps through the same
   homography, so both quads land in the frame's pixel space.
2. **Find the edge inside the band** (`refineQuadEdgesDetailed` from the band
   **midline**, bounded per edge by the inner/outer quads): slide each edge along
   its normal to the strongest summed **per-channel colour gradient**
   (`|ΔR|+|ΔG|+|ΔB|` — not luminance, so a dark neutral mat against dark warm wood
   still reads as a strong edge). The search **cannot leave the band**, so a
   stronger gradient out in the floor — a wood-plank seam, say — is simply never a
   candidate. Each edge also gets a **confidence** (peak-to-median ratio of the
   raw scores); an edge below `EDGE_CONFIDENCE_MIN = 3` found no real boundary and
   **reverts to the band midline** instead of snapping to noise. This straight-line
   edge drives the final warp and the low-confidence clamp — the model itself gets
   the whole band.
3. **The trimap IS the band** (`buildTrimapFromBand`): inside the inner quad is
   locked **foreground** (certified sleeve), outside the outer quad is locked
   **background** (certified floor/paper), and the band between is the only region
   the model decides. No erode/dilate inference — the admin drew the ground truth.
4. **Run ViTMatte** (our own cog, see below) with `image` + `trimap`,
   `max_size = MATTE_MODEL_MAX_SIZE = 2048`. Read its grayscale alpha.
5. **Clamp** the model's alpha per edge: a **confident** edge lets the alpha roam
   the whole band up to the **outer quad** — the true edge is certified to lie
   inside it, so worn corners, dips and bows anywhere in the band survive (the old
   "never past the pick" rule is gone; the outer quad is the human-certified hard
   wall). A **low-confidence** edge instead clamps `CLAMP_LOWCONF_INSET = 0.4%`
   inside the band midline: with no discernible boundary there, a crisp straight
   cut at the admin's best guess beats trusting the model in the dark. Then the
   **background-colour veto** (`vetoBackgroundAlpha`): sample the colour
   distribution of the ring just *outside the outer quad* (certified background)
   and just *inside the inner quad* (certified mat border) — both rings now on
   ground truth, immune to pick error — and zero any near-edge alpha whose colour
   is decisively background-like. Per-capture and backdrop-agnostic (wood, white
   or grey paper); a silent no-op when the two distributions are inseparable.
   Finally keep only the largest blob and feather by `FEATHER = 2`.
6. **Super-resolve** the opaque sleeve content through Real-ESRGAN
   (`MATTE_ESRGAN_MAX = 2800`), re-attach the (upscaled) alpha, so the RGB is
   ESRGAN-sharp over a model-quality edge.
7. **Warp + frame** (`warpMatteToSquare` → `frameCutout`): perspective-warp the
   cutout upright by the found edge quad with `MATTE_STRAIGHTEN = 0.5` (half-way
   to a perfect rectangle — upright-ish but keeping some real tilt), bleed the
   sleeve colour `MATTE_BLEED = 10 px` into the margin so the soft edge blends
   sleeve-into-sleeve (not wood), then **tight-crop to the alpha bounds** and
   centre at `CONTENT_SIZE` on a `CANVAS_SIZE = 2400` square (`MARGIN = 0.02`, so
   the sleeve fills **96%**). Foreground-only auto-tone + polish, then synthesise
   the contact shadow (`SHADOW`, tight/dark/down-right).

### The deterministic matte (`matteFromBand` in `lib/photo-processing.ts`)

The free fallback, used when `useAi` is off **or** any AI step throws (unconfigured
model, Replicate down, fetch error). Same band deskew + band-bounded,
confidence-gated edge search, but instead of a model it rasterises the found edge
quad directly (inset a hair by `MATTE_EDGE_INSET = 0.6%` to keep the paper edge
out), runs the same certified-ring background-colour veto, feathers, and runs the
same `warpMatteToSquare` framing tail. Predictable, straight-edged, no paid call —
and the exact math the editor's live client-side preview runs.

### The cover and the inner quad

The square cover is opaque edge-to-edge, so it must never sample background.
`warpEncodeStore` (and the live preview, identically) warps straight from the
band's **inner** quad — certified wholly on the sleeve. This retired the old
`insetQuadForCover` hack (a fixed 0.5% inset guessing at the same thing).

### The editor overlay

`CornerEditor` shows both quads — the outer (brand-coloured) to be placed wholly on
the background, the inner (sky-coloured) wholly on the sleeve — and runs the same
band-bounded edge search client-side (on a ≤800px decode), overlaying a dashed line
where the cut will actually land, per edge: **green** = clear boundary found in the
band, **amber** = no boundary (that edge will cut straight along the band midline).
Disagreement is visible while dragging, before a paid Apply. A band whose inner
corners escape the outer quad turns red and blocks Apply (a crossed band would make
the trimap self-contradictory). "Detect corners" seeds the band from the single
detected quad via `bandFromQuad` (−1.2% / +1.8% of the mean side); legacy stored
single-quad rows are synthesised into a band the same way at parse time, so nothing
needs re-picking.

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
| `sleeveCornersJson` | Normalised corner band `{inner: [[x,y]×4], outer: [[x,y]×4]}` (TL,TR,BR,BL). Legacy rows hold a plain `[[x,y]×4]` quad, synthesised into a band at parse time. Admin-only. |
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
`FEATHER 2`, `MODEL_SIZE 2048`, `MODEL_PAD 0.2`, `CLAMP_LOWCONF_INSET 0.4%`,
`VETO_DEPTH 2%`, `VETO_RING 2%`, `VETO_FG_INSET 0.5%`, `MATTE_BLEED 10`,
`MATTE_STRAIGHTEN 0.5`, `MATTE_MODEL_MAX_SIZE 2048`, `MATTE_ESRGAN_MAX 2800`;
(`lib/photo-processing.ts`): `EDGE_CONFIDENCE_MIN 3`;
(`lib/sleeve-corners.ts`): `BAND_IN_FRAC 1.2%`, `BAND_OUT_FRAC 1.8%` (the
synthesised-band seed offsets).

---

## Limitations (known, current)

- **Dark-on-dark is now attacked on four fronts** (the hand-certified band, the
  chroma-aware band-bounded edge search, the confidence-gated straight-cut
  fallback, and the background-colour veto with certified sample rings). The old
  worst case — refine dragging an edge into the floor and the trimap locking floor
  as foreground — is impossible by construction: the outer quad certifies
  everything beyond it as background. The residual gap: a background that matches
  the mat in **both** colour and brightness (grey mat on grey concrete, say) makes
  the veto stand down and the edge search low-confidence — those edges cut
  straight at the band midline, which is safe (the cut stays inside a band the
  admin certified) but loses the organic edge there.
- **The cut can't exceed the outer quad** — but that's now a human-certified
  boundary on the background, not a guess, so a "pick inside the sleeve chokes the
  matte" failure no longer exists: the alpha is free to find worn corners and bows
  anywhere in the band.
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
- **A single pick line with inferred trimap bands.** The whole middle of the old
  pipeline — asymmetric erode/dilate bands, proximity-weighted refine, the
  clamp-to-pick intersection, `CLAMP_LOWCONF_INSET`, the `insetQuadForCover`
  cover hack — existed to *infer* where the certified foreground/background were
  from one ambiguous line. → Replaced with the **corner band**: two picked quads
  that state it outright. The trimap, the clamp wall, the veto's sample rings and
  the cover quad all became plain readings of the band; the touchiest heuristics
  vanished, and the complexity moved to the editor, where a human can see and fix
  it.

---

## Open direction

The former "cut as a crisp rectangle" toggle is now built in as an **automatic,
per-edge** fallback: any edge whose gradient search finds no real boundary in the
band (confidence < `EDGE_CONFIDENCE_MIN`) reverts to the band midline and clamps a
hair inside it — so only the genuinely ambiguous edge goes straight, and the other
three keep the organic AI edge anywhere in the band. Remaining ideas, none urgent:

- Reshoot problem sleeves on **grey paper** — the veto and refine adapt to any
  backdrop automatically (nothing is wood-specific), and mid-grey avoids both
  white blowout and the dark-on-dark trap.
- Surface the per-edge confidence in the queue/editor after Apply (which path,
  which edges went straight, how many pixels the veto stripped).
