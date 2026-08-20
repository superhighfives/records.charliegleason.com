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
| **learned MobileNetV3 (this)** | **1.77%** | **98%** | **100%** | **1.67%** | **98%** | **2.9%** |

The learned model dominates everywhere — including the segmentation detector's own easy
"accepts" (1.64% vs 2.17% median) — with no fat tail (p90 2.9% of the frame). Error is % of the
frame. The classical Hough rectangle baseline underperformed even a constant guess, so it was
dropped. Full write-up and method comparison: `plans/backlog/learned-sleeve-corner-detection.md`.

Known limits: the model is trained on this capture rig (table, lighting, framing) — a new setup
is unproven and would want a retrain (cheap: ~3 min, and labels keep accruing). It has **no
confidence head**, so every detection seeds the corner editor for the admin to review rather
than auto-committing.

## The model

- Backbone: `mobilenet_v3_small` (ImageNet-pretrained), classifier head → 8 = 4 corners
  `(x,y)` in `[0,1]`, order **TL, TR, BR, BL**, sigmoid-bounded.
- Input: `1×3×224×224` float in `[0,1]`, RGB, NCHW. ImageNet mean/std normalisation is **baked
  into the exported graph**, so the caller (the Rust crate / JS) only resizes to 224×224 and
  divides by 255 — no per-channel normalisation needed downstream. See `corner_model.meta.json`.
- Trained with geometric augmentation (±12° rotation, scale, translation — matching the tilt
  gate) + colour jitter, SmoothL1 loss, ~120 epochs.

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

The model gets the sleeve *region* right but is off by ~1–3% of the frame (~20–60px on a
2048px capture — visibly "needs a nudge"). So `detectSleeveCornersBest`
(`src/lib/sleeve-detect-wasm.ts`) doesn't return the raw prediction: it **de-shrinks** it
(cancelling a measured ~0.5% inward regression bias) and then **snaps each edge to the true
sleeve boundary** with `refineQuadEdgesDetailed` — the same colour-gradient edge search the
matte runs at Apply time, brought forward to detect. Offline over the labelled set this moved
median error 1.67% → 1.38% and cut the "needs a nudge" fraction (>2% error) from 32% → 19%,
reverting low-confidence edges back to the model's line so an ambiguous edge is never made
worse. The 4% search band was tuned offline (best over 6–8%).

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
