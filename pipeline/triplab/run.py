"""
Kjør reiselaboratoriet: Entur-søk med flere overgangsmarginer for hver
hypotetiske reise, og avspilling av hvert forslag mot faktiske forsinkelser.

For hver reise (fra sample_od.py):
  1. Søk «fremme kl. X» hos Entur med hver margin i SLACKS. Svarene caches i
     data/triplab/cache/ — en ny kjøring med samme reiser koster ingen kall.
  2. Spill av hvert forslag de siste REPLAY_DAYS dagene av samme dagtype
     (pipeline/replay_trips.py: faktiske tider; mister du et bytte, det som
     først når neste stopp fra samme plattform — samme eller annen linje).
     `on_time_line` er samme avspilling med plan B bare på samme linje.
  3. For hver kombinasjon av søk (COMBOS): beste forslag ved 80 % og 95 % =
     det som drar SENEST og holder minst så ofte. Gevinst = hvor mye senere
     du kan dra enn med bare standardsøket.

Skriver data/triplab/results_<navn>.jsonl (én linje per reise) og en
oppsummering. Rapporten lages av report.py.

  PARQUET_DIR=../Bussforsinkelser/data/reise-parquet \\
    python pipeline/triplab/run.py data/triplab/od_s1.json
"""
from __future__ import annotations

import hashlib
import gc
import json
import os
import sys
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import replay_trips as R  # noqa: E402

ROOT = HERE.parents[1]
DATA = ROOT / "data" / "triplab"
CACHE = DATA / "cache"
SLACKS = [None, 0, 300, 600, 900]          # None = Enturs standard (120 s)
COMBOS = {
    "std": {None},
    "+0": {None, 0},
    "+300": {None, 300},
    "+600": {None, 600},
    "+900": {None, 900},
    "app": {None, 300, 600},               # EXTRA_TRANSFER_SLACKS i trip-planner.tsx
    "alle": set(SLACKS),
}
CALL_GAP_S = float(os.environ.get("TRIPLAB_CALL_GAP", "2.1"))  # ~28 kall/min (Entur uregistrert ~30)
MIN_DAYS = 5

QUERY = """{ trip(from:%s, to:%s, dateTime:"%s", arriveBy:true, numTripPatterns:10 %s
  modes:{accessMode:foot egressMode:foot directMode:foot}) { tripPatterns { expectedStartTime expectedEndTime
  legs { mode aimedStartTime aimedEndTime expectedStartTime expectedEndTime
    line { id publicCode } fromPlace { name quay { id } } toPlace { name quay { id } } } } } }"""


def loc(p: dict) -> str:
    if "stopPlace" in p:
        return '{place:"%s"}' % p["stopPlace"]
    return '{coordinates:{latitude:%s, longitude:%s}, name:"%s"}' % (p["lat"], p["lon"], p.get("name", "Bosted"))


_last_call = 0.0


def entur(od: dict, slack, when: str) -> list[dict]:
    global _last_call
    opt = f"transferSlack: {slack}" if slack is not None else ""
    q = QUERY % (loc(od["from"]), loc(od["to"]), when, opt)
    key = hashlib.sha1(q.encode()).hexdigest()
    f = CACHE / f"{key}.json"
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    for attempt in range(4):
        wait = CALL_GAP_S - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.time()
        try:
            req = urllib.request.Request(R.ENTUR, data=json.dumps({"query": q}).encode(),
                                         headers={"Content-Type": "application/json", "ET-Client-Name": R.CLIENT})
            d = json.load(urllib.request.urlopen(req, timeout=40))
            if "errors" in d:
                raise RuntimeError(str(d["errors"])[:200])
            pats = d["data"]["trip"]["tripPatterns"]
            f.write_text(json.dumps(pats), encoding="utf-8")
            return pats
        except Exception as e:  # noqa: BLE001
            print(f"  ! {od['id']} slack={slack}: {e}", file=sys.stderr)
            time.sleep(15 * (attempt + 1))
    return []


def next_day(day_type: str) -> date:
    d = date.today() + timedelta(days=1)
    while (d.weekday() >= 5) if day_type == "weekday" else (d.weekday() != 5):
        d += timedelta(days=1)
    return d


def walk_only(p: dict) -> bool:
    return all(l["mode"] == "foot" for l in p["legs"])


def best(rows: list[dict], combo: set, thr: float) -> dict | None:
    # Bare gange teller ikke: Entur gir av og til en 45 min gåtur i et marginsøk og ikke i
    # standardsøket, og det er ikke en kollektivgevinst.
    ok = [r for r in rows if r["legs"] and r["slacks"] & combo and r["n"] >= MIN_DAYS and r["on_time"] >= thr]
    return max(ok, key=lambda r: (r["dep"], r["on_time"])) if ok else None


def main() -> int:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")
    od_file = Path(sys.argv[1])
    ods = json.loads(od_file.read_text(encoding="utf-8"))
    parquet_dir = os.environ.get("PARQUET_DIR", str(ROOT / "data" / "reise-parquet"))
    CACHE.mkdir(parents=True, exist_ok=True)

    # 1. Entur
    t0 = time.time()
    per_od: dict[str, dict] = {}
    for i, od in enumerate(ods):
        when = f"{next_day(od['dayType']).isoformat()}T{od['time']}:00+01:00"
        cands: dict[str, dict] = {}
        for slack in SLACKS:
            for p in entur(od, slack, when):
                if walk_only(p):
                    key = "gå"
                    c = None
                else:
                    c = R.to_candidate(p)
                    if c is None:
                        continue
                    key = c.key
                e = cands.setdefault(key, {"cand": c, "pattern": p, "slacks": set()})
                e["slacks"].add(slack)
        per_od[od["id"]] = cands
        if (i + 1) % 10 == 0:
            print(f"  Entur: {i + 1}/{len(ods)} reiser ({time.time() - t0:.0f}s)", flush=True)

    # 2. Avspilling — én datalast per dagtype for alle reisene.
    results = []
    for day_type in sorted({od["dayType"] for od in ods}):
        group = [od for od in ods if od["dayType"] == day_type]
        pairs = set()
        for od in group:
            for e in per_od[od["id"]].values():
                if e["cand"]:
                    for l in e["cand"].legs:
                        pairs |= {(l.line, l.from_quay), (l.line, l.to_quay)}
        if not pairs:
            continue
        obs = None  # slipp forrige dagtypes data FØR neste lastes (MemoryError 2026-11-24)
        gc.collect()
        obs = R.Observed(parquet_dir, pairs, day_type)
        print(f"  Avspilling {day_type}: {len(group)} reiser, {len(obs.dates)} dager "
              f"({obs.dates[0]}–{obs.dates[-1]})", flush=True)
        for od in group:
            deadline = R.to_min(od["time"])
            rows = []
            for key, e in per_od[od["id"]].items():
                p = e["pattern"]
                start = R.to_min(p["expectedStartTime"][11:16])
                end = R.to_min(p["expectedEndTime"][11:16])
                if e["cand"] is None:   # bare gange: kjent ankomst
                    n, on, miss, legs = len(obs.dates), float(end <= deadline), 0.0, []
                    on_line, realized = on, []
                else:
                    c = e["cand"]
                    det = obs.replay_detail(c)
                    res = [(a, m) for a, m, _ in det]
                    # Faktisk margin per planlagt bytte og dag (min, < 0 = mistet).
                    realized = [[round(x, 1) for x in mg] for _, _, mg in det]
                    n = len(res)
                    on = sum(1 for a, _ in res if a <= deadline) / n if n else 0.0
                    miss = sum(1 for _, m in res if m) / n if n else 0.0
                    # Samme avspilling, men plan B bare med samme linje — viser hvor mye
                    # «ta en annen linje» betyr.
                    obs.any_line, keep = False, obs.any_line
                    res_l = obs.replay(c)
                    obs.any_line = keep
                    on_line = sum(1 for a, _ in res_l if a <= deadline) / len(res_l) if res_l else 0.0
                    legs = [{"line": l.line, "code": l.code, "from": l.from_quay, "dep": l.dep,
                             # Data = observert minst MIN_DAYS av dagene, ikke bare siste dag
                             # (T-banen var stengt 19.–22.11.2026; siste dag sa da «ingen data»).
                             "data": sum(1 for d in obs.dates if obs.deps.get((d, l.line, l.from_quay)))
                                     >= MIN_DAYS or l.line in R.REFERENCE_LINES}
                            for l in c.legs]
                margins = e["cand"].margins() if e["cand"] else []
                rows.append({"key": key, "dep": start, "arr": end, "n": n, "on_time": on, "on_time_line": on_line,
                             "miss": miss, "realized": realized,
                             "slacks": e["slacks"], "margins": margins, "legs": legs,
                             "label": e["cand"].label() if e["cand"] else "gå"})
            picks = {}
            for name, combo in COMBOS.items():
                for thr in (0.8, 0.95):
                    b = best(rows, combo, thr)
                    picks[f"{name}@{int(thr * 100)}"] = None if b is None else {
                        "dep": b["dep"], "label": b["label"], "on_time": b["on_time"], "lead": deadline - b["dep"]}
            results.append({**od, "rows": [{**r, "slacks": sorted("std" if s is None else str(s) for s in r["slacks"])}
                                            for r in rows],
                            "picks": picks})
        if obs.rides:
            print(f"    legg uten ankomstrad (anslått fra avgangsforsinkelsen): "
                  f"{obs.imputed}/{obs.rides} = {obs.imputed / obs.rides:.1%}", flush=True)

    out = DATA / f"results_{od_file.stem}.jsonl"
    with out.open("w", encoding="utf-8") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    # 3. Oppsummering
    print(f"\n{len(results)} reiser → {out}")
    for thr in (80, 95):
        print(f"\nVed {thr} %: hvor mye senere kan du dra enn med bare standardsøket?")
        base_ok = [r for r in results if r["picks"][f"std@{thr}"]]
        print(f"  standardsøket har et forslag som holder: {len(base_ok)}/{len(results)}")
        for name in COMBOS:
            if name == "std":
                continue
            gains, rescued = [], 0
            for r in results:
                b, a = r["picks"][f"std@{thr}"], r["picks"][f"{name}@{thr}"]
                if a and not b:
                    rescued += 1
                elif a and b:
                    gains.append(a["dep"] - b["dep"])
            g = sorted(gains)
            better = sum(1 for x in g if x >= 5)
            calls = len(COMBOS[name])
            print(f"  {name:<5} ({calls} kall): ≥5 min senere i {better:>3}/{len(g)} reiser, "
                  f"snitt {sum(g) / len(g) if g else 0:4.1f} min, maks {g[-1] if g else 0:>3} min; "
                  f"reddet {rescued} uten holdbart standardforslag")
    return 0


if __name__ == "__main__":
    sys.exit(main())
