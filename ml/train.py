"""Train the corner-regressor and export corner_model.onnx.

Runs 5-fold out-of-fold validation (prints the comparison table from the README), then trains
one model on all records and exports ONNX with ImageNet normalisation baked into the graph
(input: 1x3x384x384 float [0,1] RGB NCHW; outputs: corners 1x8 = TL,TR,BR,BL in [0,1], and
log_var 1x8 = the model's own per-coordinate uncertainty, so a caller can tell a confident fit
from an out-of-distribution guess — see the heteroscedastic head below and sleeve-detect-wasm.ts).

Usage: python train.py            (validate + train-all + export)
       python train.py --no-val   (skip the 5-fold validation, just train + export)
"""
import json
import os
import sys
import time

import cv2
import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Dataset
from torchvision import models

import metric

HERE = os.path.dirname(os.path.abspath(__file__))
WS = 384
DEVICE = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
EPOCHS = 120
BATCH = 16
FOLDS = 5
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def load_image(i):
    img = cv2.cvtColor(cv2.imread(os.path.join(metric.CAPTURES, f"{i}.webp")), cv2.COLOR_BGR2RGB)
    return cv2.resize(img, (WS, WS), interpolation=cv2.INTER_AREA)


def augment(img, pts):
    """Rotation ±12° / scale / translation about centre + hue/sat + brightness/contrast jitter;
    labels follow the geometric part."""
    M = cv2.getRotationMatrix2D((WS / 2, WS / 2), np.random.uniform(-12, 12), np.random.uniform(0.88, 1.12))
    M[0, 2] += np.random.uniform(-0.05, 0.05) * WS
    M[1, 2] += np.random.uniform(-0.05, 0.05) * WS
    img = cv2.warpAffine(img, M, (WS, WS), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    pts = (M @ np.hstack([pts, np.ones((4, 1))]).T).T
    # Hue/saturation jitter. The dataset is small (~300) and skewed to conventional artwork, so a
    # vivid/neon sleeve is out-of-distribution and the net regresses it toward a frame-filling
    # mean (a real miss — see record 310, a fluorescent-pink Madonna sleeve). Randomising hue and
    # saturation teaches colour-invariance, so a neon sleeve is localised like any other. Wider
    # hue swing than a typical ±10° jitter precisely to reach those saturated corners of colour
    # space the captures don't cover.
    hsv = cv2.cvtColor(img, cv2.COLOR_RGB2HSV).astype(np.float32)
    hsv[..., 0] = (hsv[..., 0] + np.random.uniform(-25, 25)) % 180  # OpenCV hue is 0..179
    hsv[..., 1] = np.clip(hsv[..., 1] * np.random.uniform(0.6, 1.4), 0, 255)
    img = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2RGB)
    img = img.astype(np.float32) * np.random.uniform(0.8, 1.2)
    m = img.mean()
    img = np.clip((img - m) * np.random.uniform(0.8, 1.2) + m, 0, 255)
    return img, pts


class CornerSet(Dataset):
    def __init__(self, ids, labels, imgs, train):
        self.ids, self.labels, self.imgs, self.train = ids, labels, imgs, train

    def __len__(self):
        return len(self.ids)

    def __getitem__(self, k):
        i = self.ids[k]
        img = self.imgs[i].copy()
        pts = metric.order_quad(self.labels[i]) * WS
        if self.train:
            img, pts = augment(img, pts)
        img = ((img.astype(np.float32) / 255.0) - MEAN) / STD
        return (torch.from_numpy(img.transpose(2, 0, 1)).float(),
                torch.from_numpy((pts / WS).reshape(-1).astype(np.float32)))


class HeteroHead(nn.Module):
    """Replaces MobileNetV3's final classifier layer with a *heteroscedastic* head: 8 corner
    means (sigmoid-bounded to [0,1]) plus 8 per-coordinate log-variances (unbounded). The
    log-variance is the model's own uncertainty about each coordinate, learned via Gaussian NLL
    (see {@link train_model}). It exists so the net can say "I don't know" on out-of-distribution
    input — a neon sleeve it has never seen — by predicting a large variance, instead of emitting
    a confident frame-filling guess indistinguishable from a good fit. The corner editor reads it
    as a confidence signal (`sleeve-detect-wasm.ts`); the mean is byte-for-byte the same
    prediction the old 8-output head produced, so accuracy is unchanged."""

    def __init__(self, in_features):
        super().__init__()
        self.fc = nn.Linear(in_features, 16)

    def forward(self, x):
        out = self.fc(x)
        return torch.sigmoid(out[:, :8]), out[:, 8:]


def make_model():
    m = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.IMAGENET1K_V1)
    m.classifier[-1] = HeteroHead(m.classifier[-1].in_features)
    return m.to(DEVICE)


def train_model(ids, labels, imgs):
    model = make_model()
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, EPOCHS)
    dl = DataLoader(CornerSet(ids, labels, imgs, True), batch_size=BATCH, shuffle=True)
    for _ in range(EPOCHS):
        model.train()
        for x, y in dl:
            opt.zero_grad()
            mean, log_var = model(x.to(DEVICE))
            # Gaussian NLL, spelled out in native ops: 0.5·(exp(-log_var)·(mean-target)² +
            # log_var). Equivalent to nn.GaussianNLLLoss(full=False) with var=exp(log_var), but
            # that op has no MPS kernel and silently falls back to CPU every batch (≈10× slower);
            # these primitives all run on-device. The mean is still fit by the squared-error term,
            # down-weighted per coordinate by its predicted variance — so the net minimises loss
            # on a genuinely ambiguous corner by admitting uncertainty (raising log_var) rather
            # than forcing a wrong-but-confident point. log_var is clamped for a stable exp.
            log_var = log_var.clamp(-10.0, 10.0)
            nll = 0.5 * (torch.exp(-log_var) * (mean - y.to(DEVICE)) ** 2 + log_var)
            nll.mean().backward()
            opt.step()
        sched.step()
    return model


def predict(model, ids, labels, imgs):
    model.eval()
    out = {}
    with torch.no_grad():
        ds = CornerSet(ids, labels, imgs, False)
        for k in range(len(ds)):
            x, _ = ds[k]
            mean, _ = model(x.unsqueeze(0).to(DEVICE))
            out[ids[k]] = mean.cpu().numpy().reshape(4, 2).tolist()
    return out


class Wrapped(nn.Module):
    """Input [0,1] NCHW RGB -> normalise -> backbone. Bakes normalisation into the export.
    Returns the head's (corners, log_var) tuple as two ONNX outputs."""

    def __init__(self, backbone):
        super().__init__()
        self.backbone = backbone
        self.register_buffer("mean", torch.tensor(MEAN).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor(STD).view(1, 3, 1, 1))

    def forward(self, x):
        return self.backbone((x - self.mean) / self.std)


def export(model):
    wrapped = Wrapped(make_model())
    wrapped.backbone.load_state_dict(model.state_dict())
    wrapped.eval().cpu()
    out = os.path.join(HERE, "corner_model.onnx")
    # Two outputs: corners (means) first, log_var second — the Rust net crate reads them by
    # index in that order (out[0], out[1]) and is backward-compatible with a single-output model.
    torch.onnx.export(wrapped, torch.zeros(1, 3, WS, WS), out, input_names=["input"],
                      output_names=["corners", "log_var"], opset_version=17, dynamo=False)
    json.dump({"input": "1x3x384x384 float [0,1] RGB NCHW (resize 384, /255)",
               "outputs": {"corners": "1x8 = TL,TR,BR,BL (x,y) in [0,1]",
                           "log_var": "1x8 = per-coordinate log-variance (uncertainty); "
                           "sigma = exp(0.5·log_var) in frame units"}},
              open(os.path.join(HERE, "corner_model.meta.json"), "w"), indent=2)
    print(f"exported {out} ({os.path.getsize(out) / 1e6:.2f} MB)")


def _fnv1a(s: str) -> int:
    h = 2166136261
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def write_manifest():
    """Snapshot the labels this model trained on, as a per-record hash of the raw stored band.
    The Worker's weekly flywheel-alert cron counts drift (added/changed) vs this to email a
    "time to retrain" nudge; committing a fresh manifest with the new model resets the baseline.
    """
    raw = json.load(open(os.path.join(metric.DATA, "corners.json")))
    manifest = {"note": "FNV-1a hash of each records.sleeveCornersJson at last corner-model "
                "train; the flywheel-alert cron counts drift vs this. Regenerated by train.py.",
                "labels": {str(k): _fnv1a(v) for k, v in raw.items()}}
    out = os.path.join(HERE, "labels_manifest.json")
    json.dump(manifest, open(out, "w"), indent=0)
    print(f"wrote {out} ({len(manifest['labels'])} labels)")


def main():
    torch.manual_seed(0)
    np.random.seed(0)
    labels = metric.load_labels()
    ids = metric.usable_ids()
    imgs = {i: load_image(i) for i in ids}
    print(f"device={DEVICE}  records={len(ids)}")

    if "--no-val" not in sys.argv:
        bails = metric.bail_ids()
        b = [i for i in ids if i in bails]
        nb = [i for i in ids if i not in bails]
        rng = np.random.RandomState(0)
        rng.shuffle(b)
        rng.shuffle(nb)
        fold = {i: k % FOLDS for k, i in enumerate(b)}
        fold.update({i: k % FOLDS for k, i in enumerate(nb)})
        oof, t0 = {}, time.time()
        for f in range(FOLDS):
            val = [i for i in ids if fold[i] == f]
            model = train_model([i for i in ids if fold[i] != f], labels, imgs)
            oof.update(predict(model, val, labels, imgs))
            print(f"  fold {f + 1}/{FOLDS} done ({time.time() - t0:.0f}s)")
        tail = [i for i in ids if i in bails]
        print("\n5-fold out-of-fold:")
        print("  " + metric.fmt("all", metric.evaluate(oof, ids, labels)))
        print("  " + metric.fmt("tail (bails)", metric.evaluate(oof, tail, labels)))

        # Dump the raw out-of-fold corner predictions so the end-to-end harness
        # (ml/e2e_metric.ts) can apply the app's de-shrink + edge-refine on top and report the
        # number the admin actually experiences — without re-running the model. Written whenever
        # validating; the harness and #3's CI both read it.
        oof_path = os.path.join(metric.DATA, "oof_corners.json")
        json.dump(oof, open(oof_path, "w"))
        print(f"wrote {oof_path} ({len(oof)} out-of-fold predictions)")

    print("\ntraining on all records for export...")
    export(train_model(ids, labels, imgs))
    write_manifest()


if __name__ == "__main__":
    main()
