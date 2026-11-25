"""
Enturs egne forsinkelsesanslag mot våre målinger.

Entur Journey Planner v3 gir per stoppbesøk (EstimatedCall):
  - empiricalDelay { p50 p90 }  «typisk forsinkelse for denne avgangen på denne
    dagen ved dette stoppet, basert på historikk» (samferdselsdata.no,
    «Empiriske forsinkelser», 2026-02: siste 3 mnd, minst 10 like avganger;
    appen viser det bare over 5 min og for reiser med ett transportmiddel).
  - expectedDepartureTime  sanntidsprognosen akkurat nå.
  - predictionInaccurate  Enturs eget flagg for usikker prognose.

Tre steg:
  empirical  Hent avgangstavler (dato, tidsvindu) for et utvalg plattformer fra
             labbens reiser, og sammenlign Enturs p50/p90 med våre egne for samme
             (linje, plattform, planlagt HH:MM, dagtype) i parquet.
  snapshot   Ta øyeblikksbilder av sanntidsprognosen (0–60 min fram) for et
             utvalg plattformer, gjentatt hvert --every minutt i --rounds runder.
  evaluate   Når nattjobben har hentet dagen: sammenlign med faktisk avgang.
             - empirisk: treffer Enturs p90 90 % av gangene? Våre?
             - sanntid: feil i prognosen etter hvor lang tid før avgang den ble gitt.

Alt lagres i data/triplab/entur/. Kall: ~1 per plattform per runde, ~2,1 s mellom.

  PARQUET_DIR=../Bussforsinkelser/data/reise-parquet \\
    python pipeline/triplab/entur_estimates.py empirical --date 2026-11-25
  python pipeline/triplab/entur_estimates.py snapshot --rounds 12 --every 10
  python pipeline/triplab/entur_estimates.py evaluate
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import random
import statistics
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import replay_trips as R  # noqa: E402

ROOT = HERE.parents[1]
OUT = ROOT / "data" / "triplab" / "entur"
CALL_GAP_S = float(os.environ.get("TRIPLAB_CALL_GAP", "2.1"))
HIST_DAYS = 65          # våre egne tall: siste N dager av samme dagtype (~3 mnd hverdager, som Entur)

BOARD = """{ quay(id:"%s") { id estimatedCalls(startTime:"%s", timeRange:%d, numberOfDepartures:%d,
  arrivalDeparture:departures) { aimedDepartureTime expectedDepartureTime realtime predictionInaccurate
  cancellation empiricalDelay { p50 p90 } serviceJourney { id line { id publicCode transportMode } } } } }"""

_last = 0.0


def gql(q: str) -> dict | None:
    global _last
    for attempt in range(4):
        wait = CALL_GAP_S - (time.time() - _last)
        if wait > 0:
            time.sleep(wait)
        _last = time.time()
        try:
            req = urllib.request.Request(R.ENTUR, data=json.dumps({"query": q}).encode(),
                                         headers={"Content-Type": "application/json", "ET-Client-Name": R.CLIENT})
            d = json.load(urllib.request.urlopen(req, timeout=40))
            if "errors" in d:
                raise RuntimeError(str(d["errors"])[:200])
            return d["data"]
        except Exception as e:  # noqa: BLE001
            print(f"  ! {e}", file=sys.stderr)
            time.sleep(10 * (attempt + 1))
    return None


def iso_dur_min(s: str | None) -> float | None:
    """PT1M30S → 1.5; -PT30S → -0.5."""
    if not s:
        return None
    neg = s.startswith("-")
    s = s.lstrip("-").removeprefix("PT")
    total, num = 0.0, ""
    for ch in s:
        if ch.isdigit() or ch == ".":
            num += ch
        else:
            total += float(num) * {"H": 60, "M": 1, "S": 1 / 60}[ch]
            num = ""
    return -total if neg else total


def hhmm(iso: str) -> str:
    return iso[11:16]


def lab_quays(n: int, seed: int) -> list[str]:
    """Fra-plattformer i labbens forslag, jevnt fordelt på regionene."""
    by_region = defaultdict(set)
    for f in sorted((ROOT / "data" / "triplab").glob("results_*.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            for x in r["rows"]:
                for leg in x["legs"]:
                    if leg["line"] not in R.REFERENCE_LINES:
                        by_region[r["region"]].add(leg["from"])
    rng = random.Random(seed)
    per = max(1, n // max(1, len(by_region)))
    out = []
    for region in sorted(by_region):
        q = sorted(by_region[region])
        out += rng.sample(q, min(per, len(q)))
    return out


def board(quay: str, start: str, range_s: int, n: int) -> list[dict]:
    d = gql(BOARD % (quay, start, range_s, n))
    calls = ((d or {}).get("quay") or {}).get("estimatedCalls") or []
    out = []
    for c in calls:
        sj = c.get("serviceJourney") or {}
        line = (sj.get("line") or {})
        ed = c.get("empiricalDelay") or {}
        out.append({"quay": quay, "line": line.get("id"), "code": line.get("publicCode"),
                    "mode": line.get("transportMode"), "sj": sj.get("id"),
                    "aimed": c["aimedDepartureTime"], "expected": c.get("expectedDepartureTime"),
                    "realtime": c.get("realtime"), "inaccurate": c.get("predictionInaccurate"),
                    "cancelled": c.get("cancellation"),
                    "p50": iso_dur_min(ed.get("p50")), "p90": iso_dur_min(ed.get("p90"))})
    return out


# ---------------------------------------------------------------------------
# Våre egne tall
# ---------------------------------------------------------------------------

def our_history(parquet_dir: str, keys: set[tuple[str, str]], day_type: str, before: str | None = None):
    """(linje, plattform) → {HH:MM: [forsinkelse ved avgang per dag]} for dagtypen."""
    import duckdb
    files = sorted(glob.glob(os.path.join(parquet_dir, "*-by-stop.parquet")))
    lines = sorted({k[0] for k in keys})
    stops = sorted({k[1] for k in keys})
    con = duckdb.connect()
    con.execute("SET enable_progress_bar = false")
    where = "AND date < ?" if before else ""
    params = [day_type, lines, stops] + ([before] if before else [])
    rows = con.execute(f"""
        SELECT date, line_ref, stop_ref, aimed_departure, COALESCE(delay_departure_min, delay_arrival_min)
        FROM read_parquet({files!r})
        WHERE day_type = ? AND line_ref IN (SELECT unnest(?)) AND stop_ref IN (SELECT unnest(?))
          AND aimed_departure IS NOT NULL {where}
    """, params).fetchall()
    dates = sorted({r[0] for r in rows})[-HIST_DAYS:]
    keep = set(dates)
    hist: dict = defaultdict(lambda: defaultdict(list))
    for d, line, stop, ad, delay in rows:
        if d in keep and delay is not None:
            hist[(line, stop)][ad].append(delay)
    return hist, dates


def pct(xs: list[float], q: float) -> float:
    xs = sorted(xs)
    if len(xs) == 1:
        return xs[0]
    k = (len(xs) - 1) * q
    lo = int(k)
    return xs[lo] + (xs[min(lo + 1, len(xs) - 1)] - xs[lo]) * (k - lo)


def day_type_of(d: date) -> str:
    return "saturday" if d.weekday() == 5 else "sunday" if d.weekday() == 6 else "weekday"


# ---------------------------------------------------------------------------
# Steg
# ---------------------------------------------------------------------------

def cmd_empirical(args) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    target = date.fromisoformat(args.date)
    quays = lab_quays(args.quays, args.seed)
    print(f"{len(quays)} plattformer, {target} ({day_type_of(target)})", flush=True)
    calls = []
    for i, q in enumerate(quays):
        for start, rng in (("07:00", 7200), ("15:00", 7200)):
            calls += board(q, f"{target.isoformat()}T{start}:00+01:00", rng, 60)
        if (i + 1) % 25 == 0:
            print(f"  {i + 1}/{len(quays)}", flush=True)
    f = OUT / f"empirical_{target.isoformat()}.json"
    f.write_text(json.dumps(calls), encoding="utf-8")
    print(f"{len(calls)} avganger → {f}")
    compare_empirical(calls, day_type_of(target), args.parquet_dir)
    return 0


def compare_empirical(calls: list[dict], day_type: str, parquet_dir: str) -> None:
    keys = {(c["line"], c["quay"]) for c in calls if c["line"]}
    hist, dates = our_history(parquet_dir, keys, day_type)
    pairs = []
    for c in calls:
        xs = hist.get((c["line"], c["quay"]), {}).get(hhmm(c["aimed"]))
        if c["p50"] is None or not xs or len(xs) < 5:
            continue
        pairs.append({**c, "our_p50": pct(xs, 0.5), "our_p90": pct(xs, 0.9), "n": len(xs)})
    with_emp = sum(1 for c in calls if c["p50"] is not None)
    print(f"\nEmpirisk: {with_emp}/{len(calls)} avganger har Enturs anslag; {len(pairs)} kan sammenlignes "
          f"(våre data: {len(dates)} {day_type}-dager {dates[0] if dates else '–'}–{dates[-1] if dates else '–'})")
    if not pairs:
        return
    d50 = [p["p50"] - p["our_p50"] for p in pairs]
    d90 = [p["p90"] - p["our_p90"] for p in pairs]
    print(f"  p50: Entur − vår, median {statistics.median(d50):+.1f} min, "
          f"|avvik| > 1 min i {sum(1 for x in d50 if abs(x) > 1) / len(d50):.0%}")
    print(f"  p90: Entur − vår, median {statistics.median(d90):+.1f} min, "
          f"|avvik| > 2 min i {sum(1 for x in d90 if abs(x) > 2) / len(d90):.0%}")
    # Funn 2026-11-24: Entur samler per (linje, plattform, KLOKKETIME) og KUTTER til hele
    # minutter (1,9 → PT1M). 1110 av 1129 timegrupper hadde identisk p50/p90 for alle
    # avganger. Samme oppskrift på våre data treffer p50 med 0,47 min snittavvik.
    same_hour = defaultdict(set)
    for c in calls:
        if c["p50"] is not None:
            same_hour[(c["line"], c["quay"], hhmm(c["aimed"])[:2])].add((c["p50"], c["p90"]))
    multi = sum(1 for v in same_hour.values() if len(v) == 1)
    print(f"  Enturs tall er like for alle avganger i samme klokketime: {multi}/{len(same_hour)} grupper")
    e50, e90, off = [], [], 0
    for p in pairs:
        hour = [x for hm, xs in hist[(p["line"], p["quay"])].items() if hm[:2] == hhmm(p["aimed"])[:2] for x in xs]
        if len(hour) < 10:
            continue
        e50.append(p["p50"] - math.trunc(pct(hour, 0.5)))
        e90.append(p["p90"] - math.trunc(pct(hour, 0.9)))
        off += abs(p["our_p50"] - pct(hour, 0.5)) > 3
    if e50:
        print(f"  Vår timepool, kuttet til hele min: p50 snittavvik {statistics.mean(map(abs, e50)):.2f} min, "
              f"p90 {statistics.mean(map(abs, e90)):.2f} min (n={len(e50)})")
        print(f"  Avganger der egen median er > 3 min fra timens: {off} ({off / len(e50):.1%}) "
              f"— det Enturs tall ikke kan se")
    # Entur viser det bare over 5 min: hvor mange ville vi flagget som ikke Entur gjør?
    ours5 = sum(1 for p in pairs if p["our_p50"] > 5)
    ent5 = sum(1 for p in pairs if p["p50"] > 5)
    both = sum(1 for p in pairs if p["our_p50"] > 5 and p["p50"] > 5)
    print(f"  median > 5 min (det Entur-appen viser): Entur {ent5}, vi {ours5}, begge {both}")
    # Granularitet: Entur runder til hele minutter?
    frac = sum(1 for p in pairs if p["p90"] is not None and abs(p["p90"] - round(p["p90"])) > 1e-6)
    print(f"  Entur p90 som ikke er hele minutter: {frac}/{len(pairs)}")
    by_mode = defaultdict(list)
    for p in pairs:
        by_mode[p["mode"]].append(p["p90"] - p["our_p90"])
    for m, xs in sorted(by_mode.items(), key=lambda t: -len(t[1])):
        print(f"    {m or '?':<8} {len(xs):>5} avganger, p90-avvik median {statistics.median(xs):+.1f} min")
    worst = sorted(pairs, key=lambda p: p["our_p90"] - p["p90"], reverse=True)[:10]
    print("  Størst undervurdert av Entur (vår p90 − Enturs p90):")
    for p in worst:
        print(f"    {p['line']:<18} {p['quay']:<16} {hhmm(p['aimed'])}  Entur p50/p90 {p['p50']:.0f}/{p['p90']:.0f}"
              f"  vår {p['our_p50']:.1f}/{p['our_p90']:.1f} (n={p['n']})")


def cmd_snapshot(args) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    quays = lab_quays(args.quays, args.seed + 1)
    f = OUT / f"snapshots_{date.today().isoformat()}.jsonl"
    print(f"{len(quays)} plattformer × {args.rounds} runder hvert {args.every}. min → {f}", flush=True)
    for rnd in range(args.rounds):
        t0 = time.time()
        now = datetime.now().astimezone()
        with f.open("a", encoding="utf-8") as fh:
            for q in quays:
                for c in board(q, now.isoformat(timespec="seconds"), 3600, 40):
                    fh.write(json.dumps({**c, "taken": now.isoformat(timespec="seconds")}) + "\n")
        print(f"  runde {rnd + 1}/{args.rounds} ({time.time() - t0:.0f}s)", flush=True)
        if rnd + 1 < args.rounds:
            time.sleep(max(0, args.every * 60 - (time.time() - t0)))
    return 0


def cmd_evaluate(args) -> int:
    """Mot faktisk avgang (krever at nattjobben har hentet dagene)."""
    import duckdb
    files = sorted(glob.glob(os.path.join(args.parquet_dir, "*-by-stop.parquet")))
    con = duckdb.connect()
    con.execute("SET enable_progress_bar = false")

    def actual(day: str, keys: set) -> dict:
        lines = sorted({k[0] for k in keys})
        stops = sorted({k[1] for k in keys})
        rows = con.execute(f"""
            SELECT line_ref, stop_ref, aimed_departure, COALESCE(delay_departure_min, delay_arrival_min)
            FROM read_parquet({files!r})
            WHERE date = ? AND line_ref IN (SELECT unnest(?)) AND stop_ref IN (SELECT unnest(?))
        """, [day, lines, stops]).fetchall()
        return {(l, s, a): d for l, s, a, d in rows if d is not None and a}

    # 1. Sanntidsprognosen etter horisont
    pooled = defaultdict(list)   # alle dager, bare realtime=true → PROGNOSIS_ERROR
    days_used = []
    for f in sorted(OUT.glob("snapshots_*.jsonl")):
        snaps = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
        day = f.stem.split("_", 1)[1]
        act = actual(day, {(s["line"], s["quay"]) for s in snaps if s["line"]})
        if not act:
            print(f"{f.name}: ingen faktiske data for {day} ennå (har nattjobben kjørt?)")
            continue
        buckets = [(0, 5), (5, 15), (15, 30), (30, 61)]
        err = defaultdict(list)
        flagged = defaultdict(list)
        for s in snaps:
            a = act.get((s["line"], s["quay"], hhmm(s["aimed"])))
            if a is None or not s["expected"] or s["cancelled"]:
                continue
            taken = datetime.fromisoformat(s["taken"])
            exp = datetime.fromisoformat(s["expected"])
            aimed = datetime.fromisoformat(s["aimed"])
            horizon = (exp - taken).total_seconds() / 60
            if horizon < 0:
                continue
            predicted = (exp - aimed).total_seconds() / 60
            b = next((x for x in buckets if x[0] <= horizon < x[1]), None)
            if b:
                err[b].append(a - predicted)   # > 0: gikk senere enn Entur sa
                flagged[(b, bool(s["inaccurate"]))].append(a - predicted)
                if s.get("realtime"):
                    pooled[b].append(a - predicted)
        days_used.append(day)
        print(f"\nSanntid {day}: faktisk − prognose (min), etter tid før avgang")
        for b in buckets:
            xs = err[b]
            if xs:
                print(f"  {b[0]:>2}–{b[1] - 1:<2} min: {len(xs):>6} prognoser, median {statistics.median(xs):+.1f}, "
                      f"|feil| ≤ 1 min {sum(1 for x in xs if abs(x) <= 1) / len(xs):.0%}, "
                      f"> 3 min for sen {sum(1 for x in xs if x > 3) / len(xs):.0%}, "
                      f"gikk > 1 min FØR prognosen {sum(1 for x in xs if x < -1) / len(xs):.0%}")
        for b in buckets:
            for fl in (True, False):
                xs = flagged[(b, fl)]
                if fl and xs:
                    print(f"  predictionInaccurate=true {b[0]}–{b[1] - 1} min: {len(xs)}, "
                          f"|feil| ≤ 1 min {sum(1 for x in xs if abs(x) <= 1) / len(xs):.0%}")

    if getattr(args, "quantiles", False) and pooled:
        # Samme format som PROGNOSIS_ERROR i client/src/lib/live-model.ts
        print(f"\n// PROGNOSIS_ERROR — {len(days_used)} dager ({', '.join(days_used)}), realtime = true")
        for b in [(0, 5), (5, 15), (15, 30), (30, 61)]:
            xs = sorted(pooled[b])
            if len(xs) < 40:
                print(f"// {b}: for få ({len(xs)})")
                continue
            q = [pct(xs, 0.025 + 0.05 * i) for i in range(20)]
            print(f"  {{ maxMin: {b[1] - 1}, n: {len(xs)}, q: [{', '.join(f'{v:.1f}' for v in q)}] }},")

    # 2. Empirisk p90: dekning mot faktisk dag
    for f in sorted(OUT.glob("empirical_*.json")):
        day = f.stem.split("_", 1)[1]
        calls = json.loads(f.read_text(encoding="utf-8"))
        keys = {(c["line"], c["quay"]) for c in calls if c["line"]}
        act = actual(day, keys)
        if not act:
            print(f"{f.name}: ingen faktiske data for {day} ennå")
            continue
        hist, _ = our_history(args.parquet_dir, keys, day_type_of(date.fromisoformat(day)), before=day)
        rows = []
        for c in calls:
            a = act.get((c["line"], c["quay"], hhmm(c["aimed"])))
            xs = hist.get((c["line"], c["quay"]), {}).get(hhmm(c["aimed"]))
            if a is None or c["p90"] is None or not xs or len(xs) < 5:
                continue
            rows.append((a, c["p50"], c["p90"], pct(xs, 0.5), pct(xs, 0.9)))
        if rows:
            n = len(rows)
            print(f"\nEmpirisk {day}: {n} avganger med faktisk tid, Enturs og våre anslag")
            print(f"  innenfor p90 (skal være ~90 %): Entur {sum(1 for r in rows if r[0] <= r[2]) / n:.0%}, "
                  f"vår {sum(1 for r in rows if r[0] <= r[4]) / n:.0%}")
            print(f"  |faktisk − p50| median: Entur {statistics.median(abs(r[0] - r[1]) for r in rows):.2f}, "
                  f"vår {statistics.median(abs(r[0] - r[3]) for r in rows):.2f} min")
    return 0


def main() -> int:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    pd = os.environ.get("PARQUET_DIR", str(ROOT / "data" / "reise-parquet"))
    e = sub.add_parser("empirical")
    e.add_argument("--date", default=(date.today() + timedelta(days=1)).isoformat())
    e.add_argument("--quays", type=int, default=150)
    e.add_argument("--seed", type=int, default=1)
    s = sub.add_parser("snapshot")
    s.add_argument("--quays", type=int, default=60)
    s.add_argument("--rounds", type=int, default=12)
    s.add_argument("--every", type=int, default=10, help="minutter mellom runder")
    s.add_argument("--seed", type=int, default=1)
    ev = sub.add_parser("evaluate")
    ev.add_argument("--quantiles", action="store_true",
                    help="skriv PROGNOSIS_ERROR for live-model.ts (alle dager samlet)")
    c = sub.add_parser("compare", help="sammenlign en lagret empirical_<dato>.json uten nye kall")
    c.add_argument("--date", required=True)
    args = ap.parse_args()
    args.parquet_dir = pd
    return {"empirical": cmd_empirical, "snapshot": cmd_snapshot, "evaluate": cmd_evaluate,
            "compare": cmd_compare}[args.cmd](args)


def cmd_compare(args) -> int:
    calls = json.loads((OUT / f"empirical_{args.date}.json").read_text(encoding="utf-8"))
    compare_empirical(calls, day_type_of(date.fromisoformat(args.date)), args.parquet_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
