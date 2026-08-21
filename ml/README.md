# Learned sleeve-corner detector (`corner_model.onnx`)

A small MobileNetV3-small corner-regressor that predicts a record sleeve's four corners from
a capture. It replaces the hand-tuned segmentation detector (`crates/sleeve-detect`) as the
primary detector: the segmentation approach bails on ~14% of captures (dark/pale sleeves that
fill the frame, busy artwork) where there's no separable background, and this model covers
that tail. Inference runs in the Worker via `crates/sleeve-corner-net` (tract → wasm); this
directory is the offline pipeline that produces the ONNX the crate embeds.

## Why (offline validation)

Scored against the admin's manual crops (the ground truth is the **midline** of the stored
inner/outer corner band), using the same per-corner-error metric the segmentation detector is
tuned on (`metric.py`). The learned model was evaluated **5-fold out-of-fold** (every record
predicted by a model that never trained on it), so it's a fair comparison to the training-free
baselines:

| method | tail (43 bails) median err | tail <5% | tail <10% | all median | all <5% | all p90 |
|---|---|---|---|---|---|---|
| segmentation, forced quad on bail | 40.9% | 16% | 23% | 2.51% | 77% | 25.0% |
| constant "mean quad" (floor) | 3.81% | 74% | 100% | 2.89% | 85% | 5.6% |
| classical Hough rectangle | 6.29% | 42% | 67% | 4.19% | 57% | 11.3% |
| learned MobileNetV3 (SmoothL1, 224) | 1.77% | 98% | 100% | 1.67% | 98% | 2.9% |
| **learned MobileNetV3 (hetero + hue-aug, 384)** | —\* | —\* | —\* | **0.86%** | **98%** | **1.73%** |

The learned model dominates everywhere — including the segmentation detector's own easy
"accepts". Error is % of the frame. Adding hue/saturation augmentation and the heteroscedastic
head (below) roughly **halved** the median (1.67% → 0.86%) and dropped p90 (2.9% → 1.73%) — the
augmentation pulls saturated/neon sleeves in-distribution (they used to regress toward a
frame-filling mean, e.g. record 310, a fluorescent-pink cover). The classical Hough rectangle
baseline underperformed even a constant guess, so it was dropped. Full write-up:
`plans/backlog/learned-sleeve-corner-detection.md`.

\* Tail (segmentation-bail) columns weren't rescored in the latest run — it needs
`data/bail_ids.txt` (produced separately by the segmentation harness) present during
validation; the prior row's tail figures are the last measured.

Known limits: the model is trained on this capture rig (table, lighting, framing) — a new setup
is unproven and would want a retrain (cheap: a few min on MPS, and labels keep accruing). The
model now has a **heteroscedastic uncertainty head** (per-corner sigma), so it can flag its own
low-confidence guesses — but detections still seed the corner editor for the admin to review
rather than auto-committing.

## The model

- Backbone: `mobilenet_v3_small` (ImageNet-pretrained). Heteroscedastic head → **two** outputs:
  `corners` (8 = 4 corners `(x,y)` in `[0,1]`, order **TL, TR, BR, BL**, sigmoid-bounded) and
  `log_var` (8 = per-coordinate log-variance, the model's own uncertainty; `sigma =
  exp(0.5·log_var)` in frame units). The Rust crate reads both by index and is backward-
  compatible with a legacy single-output model. `sigma` feeds the reconciliation/confidence in
  `src/lib/sleeve-detect-wasm.ts`.
- Input: `1×3×384×384` float in `[0,1]`, RGB, NCHW. ImageNet mean/std normalisation is **baked
  into the exported graph**, so the caller (the Rust crate / JS) only resizes to 384×384 and
  divides by 255 — no per-channel normalisation needed downstream. See `corner_model.meta.json`.
- Trained with geometric augmentation (±12° rotation, scale, translation — matching the tilt
  gate), **hue/saturation + brightness/contrast** jitter, Gaussian NLL loss (spelled out in
  native ops so it runs on MPS), ~120 epochs. The onnxruntime reference for the crate's
  inference test is regenerated with `gen_ref.py` after each retrain.

## Reproduce

```sh
python -m venv .venv && . .venv/bin/activate      # Python 3.12; 3.14 lacks torch/opencv wheels
pip install -r requirements.txt
python export_dataset.py                          # pulls captures (R2) + labels (D1) -> data/
python metric.py                                  # sanity: reproduces the segmentation baseline
python train.py                                   # trains on all records, writes corner_model.onnx
# then: cp corner_model.onnx ../crates/sleeve-corner-net/model/ && npm run build:wasm
```

`export_dataset.py` needs `wrangler` auth (D1 `records` + R2 `records-photos`). The dataset
itself is not committed (private, ~300 captures). `train.py` also 5-fold-validates and prints
the learned model's row of the table above (pass `--no-val` to skip straight to export).

## Edge-refinement (the detector isn't just the model)

The model gets the sleeve *region* right but the raw prediction is off by ~1–3% of the frame
(~20–60px on a 2048px capture — visibly "needs a nudge"). So `detectSleeveCornersBest`
(`src/lib/sleeve-detect-wasm.ts`) doesn't return the raw prediction: it **de-shrinks** it
(cancelling a measured ~0.5% inward regression bias) and then **snaps each edge to the true
sleeve boundary** with `refineQuadEdgesDetailed` — the same colour-gradient edge search the
matte runs at Apply time, brought forward to detect. It reverts low-confidence edges back to
the model's line so an ambiguous edge is never made worse; the 4% search band was tuned
offline (best over 6–8%).

Offline over the labelled set, end to end (384 model → de-shrink → refine): median corner
error **1.16%**, with only **15%** of records off by >2% (the "needs a nudge" threshold) —
down from a raw-224-model baseline of 1.67% median / 32%. The two levers stack: the 384 input
(vs 224) buys most of the median (1.67% → 1.36% raw), and the edge-refine buys the rest and
tightens the whole distribution (1.36% → 1.16%).

## Keeping it sharp over time (the flywheel)

The training labels *are* the admin's saved crops (`sleeveCornersJson`), so **every manual
nudge-and-save is a new label**. To fold accumulated corrections + new records back in:

```sh
python export_dataset.py   # re-pulls the current labels (now includes your fixes)
python train.py            # re-validates 5-fold, retrains, re-exports the ONNX
cp corner_model.onnx ../crates/sleeve-corner-net/model/ && npm run build:wasm
```

Worth doing once a meaningful batch of corrections has accrued (it's ~3 min), or when captures
move to a new rig/lighting. Re-run the offline edge-refine check after a retrain if you want to
re-tune the search band. There's little value retraining when the label set hasn't grown.

**Where's the pain? `python nudge_report.py`** ranks records by how far the shipped model lands
from the saved band — i.e. how much a human had to nudge — after an `export_dataset.py`. The
saved crop *is* the corrected label, so this is the offline equivalent of instrumenting the
editor, and the worst records are the best hard examples to prioritise in the next retrain.
(It's in-sample-optimistic on records the current model trained on; most honest on new records.)

**You don't have to watch for it.** `train.py` also writes `ml/labels_manifest.json` — a
per-record hash of every band it trained on. A weekly Worker cron (`src/lib/flywheel-alert.ts`,
wired in `src/server.ts`) compares live D1 to that manifest and **emails when ≥10 labels have
changed** since the last train, so you get a nudge to run the flywheel when it's actually worth
it. Committing a fresh model + manifest resets the counter — no state to manage.
