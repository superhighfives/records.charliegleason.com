"""Where does the detector still miss? Rank records by how far the shipped model lands from
the admin's saved band — i.e. how much a human had to nudge. This is the offline equivalent of
instrumenting the editor: the saved `sleeveCornersJson` *is* the corrected label, so
(model output vs saved midline) is the nudge magnitude, per record.

Use it to (a) see the live nudge-rate, and (b) get the worst records — the best hard examples
to feed the next flywheel retrain. Run after `export_dataset.py` (needs data/ populated):
    python nudge_report.py [N]      # N = how many worst records to list (default 25)

Measures the raw model only (no edge-refine — that runs in the app); the raw miss is what a
retrain can actually reduce.
"""
import os
import sys

import cv2
import numpy as np
import onnxruntime as ort

import metric

HERE = os.path.dirname(os.path.abspath(__file__))
# The shipped model (committed, embedded in the wasm). Falls back to a local export.
MODEL = os.path.join(HERE, "..", "crates", "sleeve-corner-net", "model", "corner_model.onnx")
if not os.path.exists(MODEL):
    MODEL = os.path.join(HERE, "corner_model.onnx")
WS = 384


def main():
    top_n = int(sys.argv[1]) if len(sys.argv) > 1 else 25
    labels = metric.load_labels()
    ids = metric.usable_ids()
    sess = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])

    rows = []
    for i in ids:
        img = cv2.cvtColor(cv2.imread(os.path.join(metric.CAPTURES, f"{i}.webp")), cv2.COLOR_BGR2RGB)
        x = np.transpose(cv2.resize(img, (WS, WS), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0, (2, 0, 1))[None]
        pred = sess.run(None, {"input": x})[0].reshape(4, 2)
        rows.append((i, metric.corner_error(pred, labels[i])[0] * 100))

    errs = np.array([e for _, e in rows])
    print(f"model {os.path.relpath(MODEL, HERE)}  |  {len(rows)} records")
    print("NOTE: optimistic (in-sample) on records this model trained on; most honest on "
          "records added since the last retrain.")
    print("nudge magnitude (model vs saved band), % of frame:")
    print(f"  median={np.median(errs):.2f}  mean={errs.mean():.2f}  "
          f">2%={ (errs>2).mean()*100:.0f}%  >4%={ (errs>4).mean()*100:.0f}%")
    print(f"\nworst {top_n} records (biggest nudge — prime retrain targets):")
    for i, e in sorted(rows, key=lambda r: -r[1])[:top_n]:
        print(f"  record {i:>4}   {e:5.1f}% of frame")


if __name__ == "__main__":
    main()
