"""Count corner-label drift vs the trained baseline and decide whether a retrain is worth it.

Mirrors src/lib/flywheel-alert.ts (RETRAIN_THRESHOLD = 10, FNV-1a over the stored band JSON):
the baseline is ml/labels_manifest.json (per-record hash at last train); comparing it to live D1
counts added + changed labels. The retrain-corners workflow runs this first and skips the costly
CPU training when drift is below threshold.

Prints the counts; if $GITHUB_OUTPUT is set, writes `retrain=true|false` (+ drift/added/changed)
for later steps to gate on. Needs `wrangler` authenticated (CLOUDFLARE_API_TOKEN +
CLOUDFLARE_ACCOUNT_ID) for the remote D1 read.
"""
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
# Keep in sync with RETRAIN_THRESHOLD in src/lib/flywheel-alert.ts.
THRESHOLD = 10


def _fnv1a(s: str) -> int:
    """FNV-1a (32-bit) — byte-for-byte identical to train.py and flywheel-alert.ts on the ASCII
    JSON `sleeve_corners_json` always is."""
    h = 2166136261
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def d1(sql):
    out = subprocess.check_output(
        ["bunx", "wrangler", "d1", "execute", "records", "--remote", "--json", "--command", sql],
        cwd=os.path.dirname(HERE), text=True)
    return json.loads(out[out.index("["):])[0]["results"]


def main():
    base = json.load(open(os.path.join(HERE, "labels_manifest.json")))["labels"]
    rows = d1("SELECT id, sleeve_corners_json AS c FROM records "
              "WHERE sleeve_corners_json IS NOT NULL")
    added = changed = 0
    for r in rows:
        c = r.get("c")
        if not c:
            continue
        prev = base.get(str(r["id"]))
        if prev is None:
            added += 1
        elif prev != _fnv1a(c):
            changed += 1
    drift = added + changed
    retrain = drift >= THRESHOLD
    print(f"drift={drift} (added={added}, changed={changed})  threshold={THRESHOLD}  "
          f"-> retrain={retrain}")
    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a") as f:
            f.write(f"retrain={'true' if retrain else 'false'}\n")
            f.write(f"drift={drift}\nadded={added}\nchanged={changed}\n")


if __name__ == "__main__":
    main()
