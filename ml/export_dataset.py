"""Export the training dataset: captures from R2 + corner labels from D1.

Writes:
  ml/data/corners.json         id -> raw sleeveCornersJson
  ml/data/captures/<id>.webp   the capture for each labelled record

Needs `wrangler` authenticated for the `records` D1 database and `records-photos` R2 bucket.
The dataset is private and not committed. bail_ids.txt (which records the segmentation detector
bails on) is produced separately by the offline harness in crates/sleeve-detect — see its
examples/tune.rs; drop the resulting id list at ml/data/bail_ids.txt to get tail-only metrics.
"""
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CAPTURES = os.path.join(DATA, "captures")


def d1(sql):
    out = subprocess.check_output(
        ["bunx", "wrangler", "d1", "execute", "records", "--remote", "--json", "--command", sql],
        cwd=os.path.dirname(HERE), text=True)
    return json.loads(out[out.index("["):])[0]["results"]


def fetch_capture(row):
    dest = os.path.join(CAPTURES, f"{row['id']}.webp")
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    subprocess.run(["bunx", "wrangler", "r2", "object", "get", f"records-photos/{row['k']}",
                    "--remote", "--file", dest], cwd=os.path.dirname(HERE),
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    os.makedirs(CAPTURES, exist_ok=True)
    rows = d1("SELECT id, capture_photo_key AS k, sleeve_corners_json AS c "
              "FROM records WHERE sleeve_corners_json IS NOT NULL AND capture_photo_key IS NOT NULL")
    json.dump({str(r["id"]): r["c"] for r in rows}, open(os.path.join(DATA, "corners.json"), "w"))
    print(f"{len(rows)} labelled records; downloading captures...")
    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(fetch_capture, [{"id": r["id"], "k": r["k"]} for r in rows]))
    print(f"done -> {DATA}")


if __name__ == "__main__":
    main()
