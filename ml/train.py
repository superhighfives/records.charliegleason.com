"""Train the corner-regressor and export corner_model.onnx.

Runs 5-fold out-of-fold validation (prints the comparison table from the README), then trains
one model on all records and exports ONNX with ImageNet normalisation baked into the graph
(input: 1x3x224x224 float [0,1] RGB NCHW; output: 1x8 = TL,TR,BR,BL in [0,1]).

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
WS = 224
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
    """Rotation ±12° / scale / translation about centre + colour jitter; labels follow."""
    M = cv2.getRotationMatrix2D((WS / 2, WS / 2), np.random.uniform(-12, 12), np.random.uniform(0.88, 1.12))
    M[0, 2] += np.random.uniform(-0.05, 0.05) * WS
    M[1, 2] += np.random.uniform(-0.05, 0.05) * WS
    img = cv2.warpAffine(img, M, (WS, WS), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    pts = (M @ np.hstack([pts, np.ones((4, 1))]).T).T
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


def make_model():
    m = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.IMAGENET1K_V1)
    m.classifier[-1] = nn.Sequential(nn.Linear(m.classifier[-1].in_features, 8), nn.Sigmoid())
    return m.to(DEVICE)


def train_model(ids, labels, imgs):
    model = make_model()
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, EPOCHS)
    lossf = nn.SmoothL1Loss()
    dl = DataLoader(CornerSet(ids, labels, imgs, True), batch_size=BATCH, shuffle=True)
    for _ in range(EPOCHS):
        model.train()
        for x, y in dl:
            opt.zero_grad()
            lossf(model(x.to(DEVICE)), y.to(DEVICE)).backward()
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
            out[ids[k]] = model(x.unsqueeze(0).to(DEVICE)).cpu().numpy().reshape(4, 2).tolist()
    return out


class Wrapped(nn.Module):
    """Input [0,1] NCHW RGB -> normalise -> backbone. Bakes normalisation into the export."""

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
    torch.onnx.export(wrapped, torch.zeros(1, 3, WS, WS), out, input_names=["input"],
                      output_names=["corners"], opset_version=17, dynamo=False)
    json.dump({"input": "1x3x224x224 float [0,1] RGB NCHW (resize 224, /255)",
               "output": "1x8 = TL,TR,BR,BL (x,y) in [0,1]"},
              open(os.path.join(HERE, "corner_model.meta.json"), "w"), indent=2)
    print(f"exported {out} ({os.path.getsize(out) / 1e6:.2f} MB)")


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

    print("\ntraining on all records for export...")
    export(train_model(ids, labels, imgs))


if __name__ == "__main__":
    main()
