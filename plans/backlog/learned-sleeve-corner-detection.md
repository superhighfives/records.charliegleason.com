---
title: Learned sleeve-silhouette model (corners + mattes from one dataset)
status: Backlog
created: 2026-08-18
updated: 2026-08-20
---

## Shipped (2026-08-20) — branch `learned-corner-detector`

The learned model is now the primary detector. New crate `crates/sleeve-corner-net` runs the
exported ONNX via **tract** (pure-Rust) compiled to wasm, called from `detectSleeveCornersBest`
ahead of the segmentation detector (which stays as a fallback). Reproducible training pipeline
in `ml/` (`ml/README.md`). Verified: tract matches onnxruntime to 2.7e-7 (native crate test);
app builds with the model bundled at **8.2 MB gzipped** (under the 10 MB Worker limit); tsc +
biome clean. Inference host chosen: Rust/tract-in-Worker (self-hosted, no per-call cost, covers
both the button and the on-capture seed). fp16 was rejected — tract mis-handles the mixed-
precision graph; fp32 fits, so no quantisation. Follow-ups: a confidence head before *auto*-
accepting, and revisit size (fp16-full-graph or R2-hosting) only if the bundle gets tight.

## Prototype results (2026-08-20) — the learned model wins decisively

Built and compared two prototypes against the CV baseline and a trivial floor, scored with the
CV harness's metric (per-corner error vs the human midline, as % of frame), evaluated fairly on
every id (CV untrained, A training-free, B 5-fold out-of-fold). Artifacts in scratchpad:
`common.py` (metric/split), `approach_a.py`, `approach_b.py`, `compare.py`, `bpred_*.png`.

| method | tail (43 bails) median | tail <5% | tail <10% | ALL median | ALL <5% | ALL p90 |
|---|---|---|---|---|---|---|
| CV baseline (forced quad on bail) | 40.9% | 16% | 23% | 2.51% | 77% | 24.97% |
| CONST floor (predict mean quad) | 3.81% | 74% | 100% | 2.89% | 85% | 5.58% |
| **A — classical Hough rectangle** | **6.29%** | **42%** | **67%** | 4.19% | 57% | 11.26% |
| **B — learned MobileNetV3 regressor** | **1.77%** | **98%** | **100%** | **1.67%** | **98%** | **2.94%** |

Findings:
- **B (learned) solves it.** Out-of-fold, it doesn't just backstop the tail — it *dominates CV
  everywhere*, including CV's own accepts (1.64% vs 2.17% median, 98% vs 87% within 5%), with no
  fat tail (p90 2.94%). Visual overlay (`bpred_*.png`) confirms genuine localisation on every
  hard case (Daft Punk RAM, Nebraska, Boxer, Iron & Wine, No Age) — not metric-gaming.
- **The metric is generous because the target is low-variance** (corner std ~2.5–3.5% of frame;
  every sleeve ≈ a rectangle inset ~4–5% from the frame). Hence the **CONST floor**: predicting
  one average quad for *every* image already lands 74% of the tail within 5%, free. B beats this
  floor ~2×, so it is learning real per-image refinement, not exploiting leniency.
- **A (classical) underperformed even CONST** — the Hough logic adds error vs just guessing a
  big rectangle. Not worth shipping as-is; a better classical method might, but ROI is low given
  B and the CONST floor.
- **Implication:** replace CV with B (or CV-fast-path + B on bail); the 14% tail vanishes. B is a
  ~2–4 MB MobileNet → **ONNX-exportable → onnxruntime-web keeps inference in-browser** (preserves
  the "local button", no server hop) — resolves the plan's main open question favourably.

Caveats before shipping: (1) trained on *this* capture rig/table/lighting — generalisation to a
new setup is unproven (but labels accrue, so retraining is cheap: a single model is ~3 min). (2)
No confidence head yet; add one before *auto*-accepting (p90 2.94% suggests rare blow-ups, but a
wrong crop is worse than a bail). (3) The whole framing shifts: this is corner-regression, not
the mask/silhouette target the plan built toward — the approved-matte per-pixel labels turned out
unnecessary for corners (the coarse quad suffices), though they'd still help if we later want the
matte trimap refined.


# Learned sleeve-silhouette model (corners + mattes from one dataset)

## Goal

Auto-detect sleeve corners on the ~14% of captures the hand-tuned CV detector can't, by
learning from the admin's own labels instead of writing more heuristics. Target: push
auto-detect meaningfully past the current ~86% while keeping false accepts near zero — and,
because corners drive the matte, lift matte quality on the same hard tail for free.

## Context

### Corners and mattes are one pipeline, not two

The Apply-matte step is **downstream of corners**, and the coupling is the whole point of
this plan (see `src/lib/matte.ts:71-74`):

```
corners (band) → trimap → ViTMatte → alpha → refit edges
```

The admin's corner **band** (inner quad = certified foreground, outer quad = certified
background boundary, the band between = unknown) *is* the trimap handed to ViTMatte. ViTMatte
only ever searches inside that band. Two consequences drive the whole approach:

1. **Better corners = better mattes, for free.** Anything that improves the band on the hard
   tail automatically lifts matte quality there, because the band is the matte's input. One
   problem, not two.
2. **The matte cannot be a corner backstop.** With no band there is nothing to feed the
   trimap, so "run the matte on a CV bail and read off corners" is a dead end. The learned
   model has to produce the **band/mask**; the matte stays downstream of it.

### The CV detector and its tail

The "Detect corners" wasm (`crates/sleeve-detect`) is a segmentation detector: median
pre-filter → YCbCr whitened diagonal-Mahalanobis distance from a border-ring background
model → ~4σ threshold → largest blob → hole-fill → convex hull → min-area rotated rectangle,
gated by area / rectangularity / tilt. See the `sleeve-detect-segmentation` memory.

Measured against the admin's **308 manual `sleeveCornersJson` crops** (the true edge is the
**midline** of the stored inner/outer band), via the offline harness
`crates/sleeve-detect/examples/tune.rs` (feature `debug-harness`, never shipped — emits a
machine-readable `RESULT` line with the fitted quad):

- ~86% auto-detected, median corner error ~2.7% of the frame, ~76% of accepts within 5% of
  the manual edge, ~95% within 10%, ~2 false accepts, ~42 safe bails.

**The remaining tail is out of reach for global background segmentation**, and this is now
well characterised (don't re-try these):

- **Dark sleeve filling the frame on plank wood** (Daft Punk RAM, Belafonte, National Boxer):
  the sleeve reaches every edge, so there's no clean background anywhere on the border, and
  the wood has high intrinsic variance. No separable signal.
- **Pale sleeve filling the frame with only a vivid element segmenting** (picture discs on
  white sleeves): the border ring is dominated by the pale sleeve, only the disc separates.
- Tried and rejected: corner-only background sampling (accepts collapsed 266→122);
  lower-percentile spread estimation (neutral-to-worse).

## The data we already have

Two labelled datasets are accruing for free, and they converge on **one target: predict the
sleeve silhouette (a mask).** From a predicted mask you get corners (the existing hull →
min-area-rect tail) *and* a trimap for ViTMatte.

| Source | Where | Label quality | Volume (prod, 2026-08-19) |
|---|---|---|---|
| Manual corners | `records.sleeveCornersJson` (D1), norm `[[x,y]×4]` TL,TR,BR,BL | coarse quad | 308 of 313 records |
| **Approved mattes** | `professionalStatus='approved'` + `professionalAlphaCutoutKey` (R2) | **per-pixel silhouette** | 294 of 313 |
| ViTMatte pseudo-labels | run the pinned model over *any* `capturePhotoKey` | teacher labels at scale | effectively unlimited |

**Inventory finding (Probe A, part 1).** The two human sets are almost the *same records*:
294 of the 308 corner-labelled records also carry an approved matte (near-total overlap), and
every approved matte has both a corner label and a capture. So the approved mattes do **not**
expand record coverage — they are **dense per-pixel re-labels of nearly the same ~300
records**. That is still a real upgrade (a per-pixel silhouette trains a segmentation net far
better than a 4-point quad), but the immediate lever is *label fidelity*, not volume. Volume
comes only from ViTMatte distillation over new/un-approved captures.

The approved mattes are the ingredient the original version of this plan under-weighted: an
approved matte's alpha boundary is the actual sleeve silhouette — a far richer corner label
than the 4-point quad. ViTMatte is then the **teacher**: distil it across the wider capture
set to scale volume, anchor/validate on the approved mattes + manual corners as gold, and
train one small **student** that runs cheap/local and emits a mask.

### On sampling bias (revised by the inventory)

An earlier draft claimed approved mattes "systematically exclude the hard tail." The
inventory says otherwise: the tail is CV *auto-detect* failure, but the admin then **manually
corners those records and mattes them anyway**, so tail records carry both a human band and an
approved silhouette. The tail is *in* the labelled set, human-verified. The real constraint is
therefore simpler and blunter: **total volume is ~300**, densely labelled both ways.
Realistic recipe:

- **Manual corners + approved alphas** → the ~300-record gold core, tail included.
- **ViTMatte pseudo-labels + augmentation** → the only source of *new* volume and
  regularisation; carries the weight the small human set can't.

Before pooling the two human label types, confirm they live in the same geometry: the manual
label is the band **midline**; the matte alpha is the **true edge**. They should agree — the
geometry-consistency probe (below) checks this, and its known circularity (the matte is
derived from the band, so its alpha is constrained to lie within it) is exactly why the probe
measures *where inside the band the accepted edge sits* rather than treating agreement as
proof.

## Approach

The headroom read (part 2b) reorders this: since every bail's target is a **large near-frame
rectangle** and the failure is low-contrast edges or busy interiors — not missing signal —
the cheapest thing that exploits "find the big rectangle" should be tried *before* a mask net:

- **0. Non-ML rectangle/edge detector or better default seed (try first).** A Hough-line /
  gradient pass for the four long, near-frame sleeve edges would likely recover most
  low-contrast bails; the straight edges survive even when the region contrast doesn't. Even a
  pure-product fallback — seed a near-full-frame quad for the admin to nudge instead of showing
  "couldn't find" — captures real headroom given how tightly the target hugs the frame. No
  training, no inference host. Establishes the bar the ML options must beat.

If (0) leaves a meaningful tail, then a small learned model predicting a **sleeve mask** (or
corners directly); corners fall out of the existing hull → min-area-rect tail, and the same
mask seeds a trimap for ViTMatte. Candidate shapes, roughly increasing cost:

1. **Classical ML on the existing features.** Feed the segmentation's per-axis σ-distance
   maps (+ simple stats) into a small regressor/classifier for the four corners or an
   accept-confidence. Cheapest; may only shave the tail modestly.
2. **Tiny corner-regression CNN.** Downscaled RGB → 8 outputs (4 normalised corners) or a
   4-channel corner-heatmap.
3. **Lightweight segmentation net (U-Net-ish) — lead candidate.** Predict a sleeve mask, then
   reuse the existing hull → min-area-rect tail. Most robust on the hard cases; the approved
   mattes give it dense per-pixel labels the corner-only plan never had.

Cross-cutting decisions:

- **Where inference runs.** (a) compile/export into the existing wasm path (tight budget —
  current wasm ~84 KB; a CNN likely blows that); (b) **Workers AI** (`env.AI`, already bound
  — re-introduces a server dependency/cost); (c) an ONNX runtime in the worker. Decide on
  model size and the latency the "Detect corners" button can tolerate. Note the button is
  already a deliberate manual action, so a modest server hop on the *tail only* may be fine.
- **Labels = the band midline** for the corner metric, so results stay comparable to the CV
  detector; treat matte alphas per the geometry probe's finding.
- **Data pipeline.** Pull captures from R2 (`/api/photos/<capturePhotoKey>`), corners +
  matte keys from D1; hold out a test split; augment (rotation within the ±12° tilt gate,
  lighting/background swaps). Small human set → augmentation + ViTMatte distillation required.
- **Fallback, not replacement.** Keep the CV detector as the fast path; the model runs only
  when CV bails (or disagrees). A wrong crop is worse than a bail, so gate on a confidence
  head.

## Tasks

- [x] **Probe A part 1 — dataset inventory (done 2026-08-19).** Prod D1: 313 records, 308
      with corners, 294 with an approved matte, 294 with *both* (near-total overlap). Finding:
      approved mattes densely re-label ~the same ~300 records, not a new set — the lever is
      label *fidelity*, not volume. See "Inventory finding" above.
- [x] **Probe A part 2a — tail coverage (done 2026-08-20).** Downloaded all 313 captures
      from R2, ran the production detector via `tune.rs` over 310 (3 are undecodable
      odd/small webps: ids 217, 275, 321), cross-referenced bails against D1 labels:
      - **266 auto-accept (85.8%) / 44 bail (14.2%)** — matches the documented ~86/~14.
      - Label coverage is near-identical for accepts and bails (~94–95% have both corners and
        an approved matte), so **the approved-matte set is NOT biased toward easy cases** —
        this kills the last of the sampling-bias worry.
      - **Of the 44 CV bails, 42 have BOTH a manual corner band and an approved matte** (only
        ids 299, 301 lack a matte). The hard tail is **densely, gold-labelled both ways.**
      - Sobering flip side: the tail is only **44 records**. That ~42-example hard set is the
        entire hard-case training signal — small and heterogeneous. The bottleneck is now
        clearly **hard-case volume**, not label quality or poolability.
- [x] **Probe A part 2b — headroom read (done 2026-08-20).** Built contact sheets of all 44
      bails (photo + human target quad | segmentation mask; `montage.mjs` + `sheet_*.png` in
      scratchpad). **Finding: none of the 44 are hopeless — every one has a clear, recoverable
      target.** In all 44 the sleeve fills nearly the whole frame with a thin wood margin, so
      the target is always *a large rectangle hugging the frame edges*. The CV detector bails
      for exactly two reasons, never absent signal:
      - **Low border contrast** (sleeve tone ≈ wood): dark sleeves (Belafonte, Boxer, Nebraska,
        RAM, Dune) and pale/tan sleeves (Graceland, Iron & Wine, Fleetwood, No Age). Mask empty
        or a sliver.
      - **Busy interior** breaking the largest-uniform-blob assumption (Robyn, Fiona Apple,
        lips, Taylor, roses). Mask grabs an interior fragment, not the rectangle.
      Implication: the failure is 100% the *method's* assumptions (uniform background ring +
      largest uniform blob), not missing information — precisely the profile a learned or
      edge-based detector handles better. And because the target is a **simple near-frame
      rectangle** (not a complex silhouette), the ~42-example volume worry softens: a rectangle
      is far more learnable from few examples than an arbitrary mask.
- [ ] **Probe A part 2c — geometry consistency (still optional).** Warp approved alphas back,
      refit min-area-rect, measure signed offset from the manual **midline**. Only needed if we
      commit to a per-pixel mask target; the headroom read suggests a coarser rectangle target
      may suffice, which would make this moot.
- [ ] Baseline: quantify headroom — how many of the ~42 bails + worst accepts must a model
      fix to be worth shipping.
- [ ] Script the dataset export (captures + midline labels + approved-alpha masks +
      train/test split); add ViTMatte pseudo-label generation over the wider capture set.
- [ ] Prototype (3) (lead), fall back to (1)/(2) if size/latency forces it; score on the
      held-out split with the same median-corner-error / within-5% / false-accept metrics,
      *and* re-render mattes on the tail to confirm the band improvement carries through.
- [ ] Decide the inference target (wasm-embedded vs Workers AI vs ONNX) against model size,
      button latency budget, and the local-vs-server preference.
- [ ] Wire as a fallback behind the CV detector with a confidence gate; re-validate end to end
      against the full manual-crop set and the matte output; watch false accepts.

## Open questions

- Is the pooled human set (308 corners + approved mattes, growing), plus ViTMatte
  distillation and augmentation, enough — or does this need a pretrained backbone?
- Can a model that helps the hard tail fit the worker's wasm size/latency budget, or does it
  force Workers AI / a server hop — and is that acceptable for a manual button?
- Does the sampling bias (no approved mattes on the tail) leave the student under-taught
  exactly where it's needed, even with pseudo-labels?
- Is the ROI real? The tail is ~14%, all currently bailing *safely* to manual cropping. The
  matte-quality lift on the same tail is the extra prize that may tip it.
