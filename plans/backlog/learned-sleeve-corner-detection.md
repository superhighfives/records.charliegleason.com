---
title: Learned sleeve-corner detection for the hard tail
status: Backlog
created: 2026-08-18
updated: 2026-08-18
---

# Learned sleeve-corner detection for the hard tail

## Goal

Auto-detect sleeve corners on the ~14% of captures the hand-tuned CV detector can't,
by learning from the admin's own manual crops instead of writing more heuristics. Target:
push auto-detect meaningfully past the current ~86% while keeping false accepts near zero.

## Context

The "Detect corners" wasm (`crates/sleeve-detect`) is a segmentation detector: median
pre-filter → YCbCr whitened diagonal-Mahalanobis distance from a border-ring background
model → ~4σ threshold → largest blob → hole-fill → convex hull → min-area rotated
rectangle, gated by area / rectangularity / tilt. See the `sleeve-detect-segmentation`
memory for the full rationale.

Measured against the admin's **308 manual `sleeve_corners_json` crops** (the true edge is
the **midline** of the stored inner/outer band), via the offline harness
`crates/sleeve-detect/examples/tune.rs` (feature `debug-harness`, never shipped — it emits
a machine-readable `RESULT` line with the fitted quad):

- ~86% auto-detected, median corner error ~2.7% of the frame, ~76% of accepts within 5% of
  the manual edge, ~95% within 10%, ~2 false accepts, ~42 safe bails.

**The remaining tail is out of reach for global background segmentation**, and this is
now well characterised (don't re-try these):

- **Dark sleeve filling the frame on plank wood** (Daft Punk RAM, Belafonte, National
  Boxer): the sleeve reaches every edge, so there's no clean background anywhere on the
  border, and the wood has high intrinsic variance (seams, shadows). No separable signal.
- **Pale sleeve filling the frame with only a vivid element segmenting** (picture discs on
  white sleeves): the border ring is dominated by the pale sleeve, and only the disc
  separates.
- Tried and rejected: corner-only background sampling (covers fill to the corners →
  accepts collapsed 266→122); lower-percentile spread estimation (neutral-to-worse).

The key enabler: **we already have a labelled dataset** — 308 hand-placed crops today,
growing as the admin publishes records. That's supervised training data for free.

## Approach

Open at this stage; the plan is to prototype offline before committing to anything that
ships. Candidate model shapes, roughly increasing cost:

1. **Classical ML on the existing features.** Feed the segmentation's per-axis σ-distance
   maps (+ simple statistics) into a small regressor/classifier that predicts the four
   corners or a confidence to accept. Cheapest; may only shave the tail modestly.
2. **Tiny corner-regression CNN.** Downscaled RGB → 8 outputs (4 normalised corners), or a
   4-channel corner-heatmap. Small enough to run in the worker if exported to a compact
   runtime.
3. **Lightweight segmentation net (U-Net-ish).** Predict a sleeve mask, then reuse the
   existing hull → min-area-rect tail. Most robust on the hard cases, largest to run.

Cross-cutting decisions:

- **Where inference runs.** Options: (a) compile/export the model into the existing wasm
  path (tight size budget — current wasm ~84 KB; a CNN likely blows that); (b) call
  **Workers AI** (`env.AI`, already bound — but re-introduces a server dependency and cost,
  cutting against the "manual check should be cheap/local" instinct from the earlier
  client-side discussion); (c) an ONNX runtime in the worker. Decide based on model size
  and the latency/cost the "Detect corners" button can tolerate.
- **Labels = the band midline**, not the stored inner quad (inner sits inside the true
  edge). Reuse the exact metric the CV detector is scored on so results are comparable.
- **Data pipeline.** Pull captures from R2 (`/api/photos/<capturePhotoKey>`, public) and
  `sleeve_corners_json` from D1; hold out a test split; augment (rotation within the ±12°
  the tilt gate assumes, lighting/background swaps). 308 is small — augmentation and/or a
  pretrained backbone likely required.
- **Fallback, not replacement.** Keep the CV detector as the fast path; the model runs only
  when CV bails (or disagrees), so the common case stays cheap and the model only owns the
  tail. A wrong model crop is worse than a bail, so gate its output on a confidence head.

## Tasks

- [ ] Script the dataset export (captures + midline labels + train/test split) — reuse the
      `tune.rs` `RESULT` line and the midline metric from this round's offline harness.
- [ ] Baseline: quantify headroom — how many of the 42 bails + the worst accepts would a
      model realistically need to fix to be worth shipping.
- [ ] Prototype approach (1) then (2) offline; score on the held-out split with the same
      median-corner-error / within-5% / false-accept metrics.
- [ ] Decide the inference target (wasm-embedded vs Workers AI vs ONNX) against model size,
      button latency budget, and the local-vs-server preference.
- [ ] Wire as a fallback behind the CV detector with a confidence gate; re-validate end to
      end against the full manual-crop set; watch false accepts.

## Open questions

- Is 308 (growing) enough, even with augmentation, or does this need a pretrained backbone?
- Can a model that actually helps the hard tail fit the worker's wasm size/latency budget,
  or does it force Workers AI / a server hop — and is that acceptable for a manual button?
- Is the ROI real? The tail is ~14%, all currently bailing *safely* to manual cropping.
  Worth confirming with the admin how painful those manual crops actually are before
  investing in a model.
