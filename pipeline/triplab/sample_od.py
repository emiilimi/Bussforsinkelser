"""
Trekk hypotetiske reiser: hvem reiser hvor, og når må de være fremme?

  - Bosted: en tilfeldig 250 m-rute, vektet med antall bosatte (SSB 2025),
    og et tilfeldig punkt i ruta (Entur får koordinater, som for en adresse).
  - Reisemål: fra regions.py, vektet etter type (KIND_WEIGHT).
  - Frist («fremme kl.»): typisk for reisemålet (DEADLINES), rundet til 5 min.
  - Dagtype: hverdag 85 %, lørdag 15 %.
  - Avstand i luftlinje 1,5–30 km (kortere går man; lengre er regionreiser).

Samme --seed gir samme reiser, så en kjøring kan gjentas etter en
modellendring og sammenlignes rad for rad.

  python pipeline/triplab/sample_od.py --per-region 40 --seed 1 --out data/triplab/od_s1.json
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "triplab"

KIND_WEIGHT = {"arbeid": 0.30, "sentrum": 0.20, "studiested": 0.15, "sykehus": 0.12,
               "kjøpesenter": 0.10, "knutepunkt": 0.08, "flyplass": 0.05}

# (vekt, fra, til) i minutter etter midnatt — fristen trekkes jevnt i vinduet.
H = 60
DEADLINES = {
    "arbeid":      [(0.80, 7 * H + 15, 9 * H), (0.20, 9 * H, 16 * H)],
    "sentrum":     [(0.45, 7 * H + 30, 9 * H), (0.30, 10 * H, 16 * H), (0.25, 17 * H, 22 * H)],
    "studiested":  [(0.60, 8 * H, 8 * H + 30), (0.40, 10 * H, 14 * H + 30)],
    "sykehus":     [(0.35, 6 * H + 45, 7 * H + 45), (0.65, 8 * H, 15 * H)],
    "kjøpesenter": [(1.00, 10 * H, 19 * H)],
    "knutepunkt":  [(1.00, 6 * H + 30, 22 * H)],
    "flyplass":    [(1.00, 5 * H + 30, 20 * H)],
}
SATURDAY_DEADLINES = [(1.00, 9 * H, 20 * H)]


def km(a_lat, a_lon, b_lat, b_lon) -> float:
    dy = (a_lat - b_lat) * 111.2
    dx = (a_lon - b_lon) * 111.2 * math.cos(math.radians((a_lat + b_lat) / 2))
    return math.hypot(dx, dy)


def pick_window(rng: random.Random, windows) -> int:
    w = rng.choices(windows, weights=[x[0] for x in windows])[0]
    return int(rng.uniform(w[1], w[2]) // 5 * 5)


def sample_region(rng: random.Random, places: dict, n: int) -> list[dict]:
    pop = places["population"]
    dests = places["destinations"]
    kinds = [d["kind"] for d in dests]
    dweights = [KIND_WEIGHT.get(k, 0.05) / kinds.count(k) for k in kinds]
    out, tries = [], 0
    while len(out) < n and tries < n * 50:
        tries += 1
        cell = rng.choices(pop, weights=[c["pop"] for c in pop])[0]
        # Tilfeldig punkt i ruta (±125 m).
        lat = cell["lat"] + rng.uniform(-0.00112, 0.00112)
        lon = cell["lon"] + rng.uniform(-0.00112, 0.00112) / math.cos(math.radians(lat))
        d = rng.choices(dests, weights=dweights)[0]
        dist = km(lat, lon, d["lat"], d["lon"])
        if not 1.5 <= dist <= 30:
            continue
        saturday = rng.random() < 0.15
        t = pick_window(rng, SATURDAY_DEADLINES if saturday else DEADLINES[d["kind"]])
        out.append({
            "id": f"{places['region']}-{len(out):03d}",
            "region": places["region"],
            "from": {"lat": round(lat, 6), "lon": round(lon, 6), "name": f"Bosted {len(out):03d}"},
            "to": {"stopPlace": d["stopPlace"], "name": d["stopName"], "kind": d["kind"]},
            "time": f"{t // 60:02d}:{t % 60:02d}",
            "dayType": "saturday" if saturday else "weekday",
            "km": round(dist, 1),
        })
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-region", type=int, default=40)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--regions", default="")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")
    rng = random.Random(args.seed)
    files = sorted(DATA.glob("places_*.json"))
    want = set(filter(None, args.regions.split(",")))
    ods = []
    for f in files:
        places = json.loads(f.read_text(encoding="utf-8"))
        if want and places["region"] not in want:
            continue
        ods += sample_region(rng, places, args.per_region)
    out = Path(args.out) if args.out else DATA / f"od_s{args.seed}.json"
    out.write_text(json.dumps(ods, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(ods)} reiser → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
