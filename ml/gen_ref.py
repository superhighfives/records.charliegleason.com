"""Regenerate the onnxruntime reference (EXPECTED) for the net crate's inference test.

Loads the 384x384 fixture, runs the freshly-exported ONNX, and prints the corners output as a
Rust array literal. With `--write`, patches the EXPECTED array in
crates/sleeve-corner-net/tests/inference.rs in place (used by the retrain-corners workflow so the
reference test tracks the new model automatically). Paths resolve from the repo root, so it runs
from anywhere.
"""
import os
import re
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(REPO, "crates/sleeve-corner-net/tests/fixtures/capture_384.png")
ONNX = os.path.join(REPO, "crates/sleeve-corner-net/model/corner_model.onnx")
TEST = os.path.join(REPO, "crates/sleeve-corner-net/tests/inference.rs")

img = Image.open(FIX).convert("RGB").resize((384, 384))
arr = np.asarray(img, np.float32) / 255.0  # HWC RGB [0,1]
nchw = arr.transpose(2, 0, 1)[None, ...]  # 1x3x384x384
sess = ort.InferenceSession(ONNX, providers=["CPUExecutionProvider"])
outs = sess.run(None, {"input": nchw})
names = [o.name for o in sess.get_outputs()]
corners = outs[names.index("corners")].reshape(-1)
vals = ", ".join(f"{v:.4f}" for v in corners)
print("outputs:", names)
print("corners:", vals)
if "log_var" in names:
    lv = outs[names.index("log_var")].reshape(-1)
    print("sigma  :", ", ".join(f"{v:.4f}" for v in np.exp(0.5 * lv)))

if "--write" in sys.argv:
    src = open(TEST).read()
    # subn's count distinguishes "no match" (a real failure) from "matched but the values are
    # unchanged" (a no-op when the model didn't move) — comparing text alone would conflate them.
    patched, n = re.subn(
        r"(const EXPECTED: \[f64; 8\] = \[)[^\]]*(\];)",
        lambda m: f"{m.group(1)}\n    {vals},\n{m.group(2)}",
        src,
        flags=re.S,
    )
    if n == 0:
        raise SystemExit("gen_ref: couldn't find the EXPECTED array to patch in inference.rs")
    open(TEST, "w").write(patched)
    print(f"patched {TEST}" if patched != src else f"{TEST} already current")
