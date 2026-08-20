"""Labels, ordering, metric, and split for the corner detector — shared by train.py/compare.py.

Ground truth = the midline of the admin's stored band ((inner+outer)/2), normalised [0,1],
ordered TL,TR,BR,BL. Metric matches the segmentation detector's harness: per-corner euclidean
distance in normalised frame units, reported as % of frame (×100).

Data layout (produced by export_dataset.py):
  ml/data/corners.json         id -> raw sleeveCornersJson string
  ml/data/captures/<id>.webp   the capture
  ml/data/bail_ids.txt         ids the segmentation detector bails on (from crates/sleeve-detect)
"""
import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CAPTURES = os.path.join(DATA, "captures")
# A few captures are odd/undecodable webps; exclude so every split item is scorable end-to-end.
BAD = {"217", "275", "321"}


def order_quad(pts):
    """Canonical TL,TR,BR,BL for a near-axis-aligned quad."""
    p = np.asarray(pts, dtype=np.float64).reshape(4, 2)
    s = p[:, 0] + p[:, 1]
    d = p[:, 0] - p[:, 1]
    return np.array([p[np.argmin(s)], p[np.argmax(d)], p[np.argmax(s)], p[np.argmin(d)]])


def load_labels():
    """id(str) -> midline quad (4x2 float, ordered)."""
    raw = json.load(open(os.path.join(DATA, "corners.json")))
    out = {}
    for k, v in raw.items():
        p = json.loads(v)
        if isinstance(p, dict) and "inner" in p and "outer" in p:
            mid = (np.asarray(p["inner"], float).reshape(4, 2)
                   + np.asarray(p["outer"], float).reshape(4, 2)) / 2.0
        else:  # legacy single quad
            mid = np.asarray(p, float).reshape(4, 2)
        out[k] = order_quad(mid)
    return out


def corner_error(pred, gt):
    """Mean per-corner distance (normalised frame units) between two ordered quads."""
    d = np.linalg.norm(order_quad(pred) - order_quad(gt), axis=1)
    return float(d.mean()), d


def bail_ids():
    p = os.path.join(DATA, "bail_ids.txt")
    return set(open(p).read().split()) if os.path.exists(p) else set()


def usable_ids():
    labels = load_labels()
    have = {os.path.basename(p).split(".")[0] for p in _glob_captures()}
    return sorted((i for i in labels if i in have and i not in BAD), key=int)


def _glob_captures():
    import glob
    return glob.glob(os.path.join(CAPTURES, "*.webp"))


def split(seed=1234, test_frac=0.2):
    ids = usable_ids()
    perm = np.random.RandomState(seed).permutation(len(ids))
    n_test = int(round(len(ids) * test_frac))
    test = {ids[j] for j in perm[:n_test]}
    return [i for i in ids if i not in test], sorted(test, key=int)


def evaluate(pred_dict, ids, labels=None):
    labels = labels or load_labels()
    errs, missing = [], 0
    for i in ids:
        if i not in labels:
            continue
        q = pred_dict.get(i)
        if q is None:
            missing += 1
            continue
        errs.append(corner_error(q, labels[i])[0])
    errs = np.array(errs) * 100.0
    if len(errs) == 0:
        return dict(n=0, missing=missing)
    return dict(n=len(errs), missing=missing, median=float(np.median(errs)),
                mean=float(errs.mean()), p90=float(np.percentile(errs, 90)),
                within5=float((errs < 5).mean() * 100), within10=float((errs < 10).mean() * 100))


def fmt(name, m):
    if m.get("n", 0) == 0:
        return f"{name:<22} (no scorable items)"
    return (f"{name:<22} n={m['n']:<3} med={m['median']:5.2f}%  mean={m['mean']:5.2f}%  "
            f"p90={m['p90']:5.2f}%  <5%={m['within5']:4.0f}%  <10%={m['within10']:4.0f}%")
