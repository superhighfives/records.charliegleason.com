"""Regenerate the onnxruntime reference (EXPECTED) for the net crate's inference test.
Loads the 384x384 fixture, runs the freshly-exported ONNX, prints the corners output as a
Rust array literal to paste into crates/sleeve-corner-net/tests/inference.rs.
"""
import numpy as np
import onnxruntime as ort
from PIL import Image

FIX = "crates/sleeve-corner-net/tests/fixtures/capture_384.png"
ONNX = "crates/sleeve-corner-net/model/corner_model.onnx"

img = Image.open(FIX).convert("RGB").resize((384, 384))
arr = np.asarray(img, np.float32) / 255.0            # HWC RGB [0,1]
nchw = arr.transpose(2, 0, 1)[None, ...]             # 1x3x384x384
sess = ort.InferenceSession(ONNX, providers=["CPUExecutionProvider"])
outs = sess.run(None, {"input": nchw})
names = [o.name for o in sess.get_outputs()]
corners = outs[names.index("corners")].reshape(-1)
print("outputs:", names)
print("corners:", ", ".join(f"{v:.4f}" for v in corners))
if "log_var" in names:
    lv = outs[names.index("log_var")].reshape(-1)
    sig = np.exp(0.5 * lv)
    print("sigma  :", ", ".join(f"{v:.4f}" for v in sig))
