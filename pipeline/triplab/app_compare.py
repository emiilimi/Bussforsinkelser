"""
Appen i løkka: sammenlign appens valg og sannsynligheter med avspillingen.

Inndata:
  - results_<navn>.jsonl fra run.py (avspilt andel i tide per forslag)
  - app_<navn>.jsonl: én linje per reise, {"id": ..., "debug": window.__reiseDebug}
    samlet fra reiseplanleggeren i nettleseren (/reise?from=coords:…&arriveBy=1).

Måler:
  - Kalibrering: appens pOnTime mot avspilt andel i tide, i bøtter.
  - Appens valg: holder det (avspilt)? Hvor mye tidligere drar det enn beste
    80 %-forslag fra de samme søkene (`app@80` i run.py)?
  - Flagg per reise: APP_FOR_TIDLIG (≥ 10 min før beste), APP_FOR_SENT (< 70 %).

  python pipeline/triplab/app_compare.py data/triplab/results_od_s1.jsonl data/triplab/app_od_s1.jsonl
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def to_min(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def hhmm(m: int) -> str:
    return f"{m // 60 % 24:02d}:{m % 60:02d}"


def parse_line(line: str) -> dict:
    """Én reise. JSON-linje {"id", "debug"} eller den kompakte formen fra
    nettleserinnsamlingen: `id<TAB>dep,arr,linjer#dep,arr,linjer,pN[,pH],pMake[,mangler]|...`."""
    if line.lstrip().startswith("{"):
        return json.loads(line)
    rid, rest = line.split("	", 1)
    head, _, body = rest.partition("#")
    dep, arr, lines = (head.split(",", 2) + ["", ""])[:3]
    cands = []
    for c in filter(None, body.split("|")):
        f = c.split(",")
        if len(f) == 7:
            d, a, l, pn, _ph, pm, _miss = f
        else:
            d, a, l, pn, pm = f
        cands.append({"dep": d, "arr": a, "lines": l, "pOnTime": float(pn) if pn else None,
                      "pMake": float(pm) if pm else None})
    return {"id": rid, "debug": {"depHHMM": None if dep == "-" else dep,
                                 "pick": {"arr": arr, "lines": lines} if dep != "-" else None,
                                 "candidates": cands}}


def label(lines: str) -> str:
    return lines or "gå"


def main() -> int:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")
    res = {r["id"]: r for r in map(json.loads, Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()) if r}
    apps = [parse_line(l) for l in Path(sys.argv[2]).read_text(encoding="utf-8").splitlines() if l.strip()]

    pairs, flags, picks = [], [], []
    unmatched = 0
    for a in apps:
        r = res.get(a["id"])
        dbg = a.get("debug") or {}
        if not r or not dbg.get("candidates"):
            continue
        by = {(x["dep"], x["arr"], x["label"]): x for x in r["rows"]}
        for c in dbg["candidates"]:
            p = c.get("pOnTime")
            if isinstance(p, dict):
                c["pOnTime"] = p.get(dbg.get("certainty", "normal"))
            x = by.get((to_min(c["dep"]), to_min(c["arr"]), label(c["lines"])))
            if x is None:
                unmatched += 1
                continue
            if c.get("pOnTime") is not None and x["n"] >= 5:
                pairs.append((c["pOnTime"], x["on_time"], a["id"], c["dep"], c["lines"]))
        if dbg.get("depHHMM"):
            dep = to_min(dbg["depHHMM"])
            pk = dbg.get("pick") or {}
            mine = by.get((dep, to_min(pk["arr"]), label(pk.get("lines", "")))) if pk.get("arr") else                 next((x for x in r["rows"] if x["dep"] == dep), None)
            best = r["picks"].get("app@80")
            lag = (best["dep"] - dep) if best else None
            picks.append({"id": a["id"], "dep": dep, "on": mine["on_time"] if mine and mine["n"] >= 5 else None,
                          "lag": lag, "in_lab": mine is not None,
                          "walk": not (pk.get("lines") or "")})
            if lag is not None and lag >= 10:
                flags.append(f"APP_FOR_TIDLIG {a['id']}: appen {hhmm(dep)}, avspilling {hhmm(best['dep'])} "
                             f"({best['label']}, {best['on_time']:.0%})")
            if mine and mine["n"] >= 5 and mine["on_time"] < 0.7:
                flags.append(f"APP_FOR_SENT {a['id']}: appens {hhmm(dep)} holdt {mine['on_time']:.0%}")

    print(f"{len(apps)} reiser fra appen, {len(pairs)} forslag med både modell og avspilling "
          f"({unmatched} forslag uten match i labben)")
    print("\nKalibrering (appens pOnTime → avspilt andel i tide):")
    edges = [0, 0.5, 0.7, 0.8, 0.9, 0.95, 1.01]
    for lo, hi in zip(edges, edges[1:]):
        b = [p for p in pairs if lo <= p[0] < hi]
        if b:
            print(f"  {lo:4.0%}–{min(hi, 1):4.0%}: {len(b):>4} forslag, modell {sum(p[0] for p in b) / len(b):5.1%}, "
                  f"avspilt {sum(p[1] for p in b) / len(b):5.1%}")
    if pairs:
        brier = sum((p[0] - p[1]) ** 2 for p in pairs) / len(pairs)
        print(f"  Brier-lignende avvik: {brier:.3f}")
        worst = sorted(pairs, key=lambda p: -(p[0] - p[1]))[:8]
        print("  Mest overoptimistisk:")
        for p in worst:
            print(f"    {p[2]:<16} {p[3]} {p[4]:<22} modell {p[0]:.0%}, avspilt {p[1]:.0%}")
    if picks:
        held = [p for p in picks if p["on"] is not None]
        print(f"\nAppens valg: {len(picks)} reiser; målt {len(held)}; "
              f"holder ≥80 %: {sum(1 for p in held if p['on'] >= 0.8)}, "
              f"snitt i tide {sum(p['on'] for p in held) / len(held):.0%}" if held else "")
        print(f"  appens valg finnes ikke blant labbens forslag (andre søkeparametre): "
              f"{sum(1 for p in picks if not p['in_lab'])}; bare gange: {sum(1 for p in picks if p['walk'])}")
        lags = sorted(p["lag"] for p in picks if p["lag"] is not None)
        if lags:
            print(f"  drar før beste 80 %-forslag: median {lags[len(lags) // 2]} min, "
                  f"≥10 min i {sum(1 for x in lags if x >= 10)}/{len(lags)}")
    for f in flags:
        print("  ⚑", f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
