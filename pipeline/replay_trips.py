"""
Spill av reiseforslag mot faktiske forsinkelser — finner søk der vi (eller
Entur) gikk glipp av et bedre forslag.

Hvorfor (2026-11-18): Lyderhornsveien → Øvsttun, fremme 20:15. Med Enturs
standard overgangsmargin (120 s) kom bare 20-bussen 19:27 med 2 min bytte til
70 (ryker ~9 av 10) og reiser fremme 19:11, og vi anbefalte å dra 18:14. Med
5–10 min margin kom 450/40-bussen fra Lyngbø → Bybanen → 70 kl. 20:00, som er
den man faktisk tar. Slike feil er usynlige så lenge vi bare ser på forslagene
vi fikk. Dette skriptet ser på forslagene vi KUNNE fått.

For hvert søk i korpuset:
  1. Hent forslag fra Entur med flere overgangsmarginer (standard, 300, 600 s).
  2. Spill av hvert forslag på hver av de siste N dagene av samme dagtype i
     parquet-dataene: faktisk avgang/ankomst per legg, og mister du et bytte,
     tar du det som først når neste stopp: neste avgang av samme linje, eller
     (fra 2026-11-23) en annen linje fra samme plattform som også stopper der.
     REPLAY_PLAN_B=line gir bare samme linje (strengere).
  3. Andel dager fremme før fristen, per forslag.
  4. «Beste» forslag ved 80 % og 95 %: det som drar SENEST og likevel er fremme
     i tide minst så ofte. Sammenlign: bare standardsøket mot alle søkene.

Flagg:
  MARGIN_HJELPER   — med ekstra margin finnes et forslag som drar ≥ 10 min
                     senere og holder like ofte. (Feilen over.)
  STANDARD_HOLDER  — ingen gevinst; standardsøket var nok.
  INGEN_HOLDER     — ingen forslag holder; ofte fordi tidspunktet er dårlig valgt.

Appens egne valg sammenlignes ved å lime inn `window.__reiseDebug` fra
nettleseren (se --app); da flagges også:
  APP_FOR_TIDLIG   — appen anbefaler å dra ≥ 10 min før beste 80 %-forslag.
  APP_FOR_SENT     — appens forslag holder < 70 % i avspillingen.

Begrensninger (vit om dem før du stoler på et flagg):
  - Bybanen (SKY:Line:1/2) har ingen ekte data. Den regnes som i rute, og
    mister du den, kommer neste etter BYBANE_HEADWAY_MIN.
  - Mangler en rad for en buss en dag, telles ikke dagen for det forslaget.
  - Entur-søket gjelder én dato (--date); rutetiden antas lik de dagene vi
    spiller av (samme linje + stopp + klokkeslett).

Kjør (fra repo-roten, data fra hovedmappa):
  PARQUET_DIR=../Bussforsinkelser/data/reise-parquet \\
    python pipeline/replay_trips.py --date 2026-11-19
  python pipeline/replay_trips.py --only lyderhorn-ovsttun -v
"""
from __future__ import annotations

import argparse
import bisect
from sys import intern
import glob
import json
import os
import sys
import time
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

import duckdb

ENTUR = "https://api.entur.io/journey-planner/v3/graphql"
CLIENT = "emiliemoldestad-sentur"
SLACKS = [None, 300, 600]           # None = Enturs standard (120 s)
DAYS = int(os.environ.get("REPLAY_DAYS", "20"))
REFERENCE_LINES = {"SKY:Line:1", "SKY:Line:2"}
BYBANE_HEADWAY_MIN = 10
# Plan B når et bytte ryker: neste avgang av samme linje, eller (ANY_LINE_PLAN_B)
# hvilken som helst avgang fra samme plattform som når samme stopp først.
# REPLAY_PLAN_B=line gir den gamle, strengere varianten.
ANY_LINE_PLAN_B = os.environ.get("REPLAY_PLAN_B", "any") != "line"
PLAN_B_WINDOW_MIN = 90
NEAR_MAX_MIN = 20   # se Observed.arr_near
ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "pipeline" / "replay_corpus.json"


# ---------------------------------------------------------------------------
# Entur
# ---------------------------------------------------------------------------

QUERY = """{ trip(from:{place:"%s"}, to:{place:"%s"}, dateTime:"%s", arriveBy:%s,
  numTripPatterns:%d %s) { tripPatterns { expectedStartTime expectedEndTime
  legs { mode aimedStartTime aimedEndTime expectedStartTime expectedEndTime
    line { id publicCode } fromPlace { name quay { id } } toPlace { name quay { id } } } } } }"""


def entur_trip(frm: str, to: str, when: str, arrive: bool, slack: int | None, n: int = 10) -> list[dict]:
    opt = f"transferSlack: {slack}" if slack is not None else ""
    q = QUERY % (frm, to, when, str(arrive).lower(), n, opt)
    req = urllib.request.Request(ENTUR, data=json.dumps({"query": q}).encode(),
                                 headers={"Content-Type": "application/json", "ET-Client-Name": CLIENT})
    for attempt in range(3):
        try:
            d = json.load(urllib.request.urlopen(req, timeout=30))
            if "errors" in d:
                raise RuntimeError(d["errors"])
            return d["data"]["trip"]["tripPatterns"]
        except Exception as e:  # noqa: BLE001 — nettverk/429: prøv igjen
            if attempt == 2:
                print(f"  ! Entur feilet ({slack}): {e}", file=sys.stderr)
                return []
            time.sleep(5 * (attempt + 1))
    return []


# ---------------------------------------------------------------------------
# Forslag
# ---------------------------------------------------------------------------

def hm(iso: str) -> str:
    return iso[11:16]


def to_min(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def fmt(m: float | None) -> str:
    if m is None:
        return "  –  "
    m = int(round(m))
    return f"{(m // 60) % 24:02d}:{m % 60:02d}"


@dataclass
class Leg:
    line: str
    code: str
    from_quay: str
    to_quay: str
    dep: int          # planlagt avgang, minutter etter midnatt
    arr: int
    walk_before: float  # minutter gange før dette legget (etter forrige)


@dataclass
class Candidate:
    key: str
    dep: int          # planlagt avreise (inkl. gange først)
    arr: int          # planlagt fremme
    legs: list[Leg]
    walk_after: float
    slacks: set = field(default_factory=set)

    def label(self) -> str:
        return " → ".join(l.code for l in self.legs) or "gå"

    def margins(self) -> list[float]:
        return [b.dep - a.arr - b.walk_before for a, b in zip(self.legs, self.legs[1:])]


def to_candidate(p: dict) -> Candidate | None:
    legs: list[Leg] = []
    walk = 0.0
    for l in p["legs"]:
        s = datetime.fromisoformat(l["expectedStartTime"])
        e = datetime.fromisoformat(l["expectedEndTime"])
        if l["mode"] == "foot":
            walk += (e - s).total_seconds() / 60
            continue
        if not l.get("line") or not l["fromPlace"].get("quay") or not l["toPlace"].get("quay"):
            return None
        legs.append(Leg(l["line"]["id"], l["line"]["publicCode"] or l["line"]["id"],
                        l["fromPlace"]["quay"]["id"], l["toPlace"]["quay"]["id"],
                        to_min(hm(l["aimedStartTime"])), to_min(hm(l["aimedEndTime"])), walk))
        walk = 0.0
    if not legs:
        return None
    start = datetime.fromisoformat(p["expectedStartTime"])
    end = datetime.fromisoformat(p["expectedEndTime"])
    key = "|".join(f"{l.line}@{l.dep}" for l in legs)
    return Candidate(key, to_min(start.strftime("%H:%M")), to_min(end.strftime("%H:%M")), legs, walk)


# ---------------------------------------------------------------------------
# Avspilling
# ---------------------------------------------------------------------------

def iter_rows(cur, size: int = 200_000):
    while True:
        chunk = cur.fetchmany(size)
        if not chunk:
            return
        yield from chunk


class Observed:
    """Faktiske tider per dato for de (linje, stopp)-parene forslagene bruker."""

    def __init__(self, parquet_dir: str, pairs: set[tuple[str, str]], day_type: str,
                 any_line: bool = ANY_LINE_PLAN_B):
        files = sorted(glob.glob(os.path.join(parquet_dir, "*-by-stop.parquet")))
        if not files:
            sys.exit(f"Fant ingen *-by-stop.parquet i {parquet_dir}")
        lines = sorted({l for l, _ in pairs})
        stops = sorted({s for _, s in pairs})
        self.any_line = any_line
        self.rides = 0      # legg avspilt med planlagt avgang
        self.imputed = 0    # ... der ankomstraden manglet og ble anslått (se ride())
        con = duckdb.connect()
        # Med any_line trengs ALLE linjer ved stoppene (plan B kan være en annen linje).
        line_filter = "" if any_line else "AND line_ref IN (SELECT unnest(?))"
        params = [day_type, stops] if any_line else [day_type, stops, lines]
        where = f"WHERE day_type = ? AND stop_ref IN (SELECT unnest(?)) {line_filter}"
        dates = [r[0] for r in con.execute(
            f"SELECT DISTINCT date FROM read_parquet({files!r}) {where} ORDER BY 1", params).fetchall()]
        self.dates = dates[-DAYS:]
        keep = set(self.dates)
        # Radene leses i biter: fetchall() + ordbøkene samtidig ga MemoryError på
        # hverdagene med alle linjer ved stoppene (2026-11-24, ~5 GB ledig).
        cur = con.execute(f"""
            SELECT date, service_journey_id, line_ref, stop_ref, aimed_arrival, aimed_departure,
                   delay_arrival_min, delay_departure_min
            FROM read_parquet({files!r})
            {where} AND date >= ?
        """, params + [self.dates[0] if self.dates else ""])
        # (dato, linje, stopp) -> liste av (planlagt avgang, faktisk avgang, sj)
        self.deps: dict[tuple, list] = defaultdict(list)
        # (dato, sj, stopp) -> faktiske ankomster, sortert. En LISTE fordi samme sj kan
        # passere samme plattform to ganger: T-banens linje 5 snur på Sognsvann og
        # kommer tilbake forbi Blindern med samme id (2026-11-24: 08:17-ankomsten ble
        # lest som 08:43, og avspillingen sa 0 % der appen sa 72 %).
        self.arrs: dict[tuple, list] = defaultdict(list)
        # (dato, stopp) -> liste av (faktisk avgang, sj), alle linjer (plan B med annen linje)
        self.at_stop: dict[tuple, list] = defaultdict(list)
        for d, sj, line, stop, aa, ad, da, dd in iter_rows(cur):
            if d not in keep:
                continue
            # Samme id-er gjentas på hvert stopp; intern() deler én streng (minne).
            d, sj, line, stop = intern(d), intern(sj), intern(line), intern(stop)
            if ad:
                delay = dd if dd is not None else da
                if delay is not None:
                    self.deps[(d, line, stop)].append((to_min(ad), to_min(ad) + delay, sj))
                    if any_line and line not in REFERENCE_LINES:  # Bybane-radene er falske 0,0
                        self.at_stop[(d, stop)].append((to_min(ad) + delay, sj))
            if aa or ad:
                delay = da if da is not None else dd
                if delay is not None:
                    self.arrs[(d, sj, stop)].append(to_min(aa or ad) + delay)
        for v in self.deps.values():
            v.sort()
        for v in self.arrs.values():
            v.sort()
        for v in self.at_stop.values():
            v.sort()

    def arr_near(self, d: str, sj: str, stop: str, after: float, expected: float) -> float | None:
        """Faktisk ankomst nærmest `expected` (planlagt ankomst + avgangsforsinkelsen).
        Ikke «første etter avgang»: mangler raden for første passering, er den første
        vi har returen forbi samme plattform (linje 5 08:09 Jernbanetorget → Blindern:
        08:17 manglet, 08:4x ble brukt, avspilt 0 % på dager byttet holdt). Mer enn
        NEAR_MAX_MIN fra forventet = feil passering → None (anslås av kalleren)."""
        best = None
        for a in self.arrs.get((d, sj, stop), ()):
            if a > after and (best is None or abs(a - expected) < abs(best - expected)):
                best = a
        return best if best is not None and abs(best - expected) <= NEAR_MAX_MIN else None

    def arr_after(self, d: str, sj: str, stop: str, after: float) -> float | None:
        """Første faktiske ankomst til `stop` med `sj` etter tidspunktet `after` (avgangen)."""
        for a in self.arrs.get((d, sj, stop), ()):
            if a > after:
                return a
        return None

    def first_arrival(self, d: str, from_quay: str, to_quay: str, ready: float) -> float | None:
        """Tidligste faktiske ankomst til to_quay med NOEN avgang fra from_quay etter `ready`
        (innen PLAN_B_WINDOW_MIN). None = ingen."""
        deps = self.at_stop.get((d, from_quay))
        if not deps:
            return None
        best = None
        for adep, sj in deps[bisect.bisect_left(deps, (ready, "")):]:
            if adep > ready + PLAN_B_WINDOW_MIN or (best is not None and adep >= best):
                break
            a = self.arr_after(d, sj, to_quay, adep)
            if a is not None and (best is None or a < best):
                best = a
        return best

    def ride(self, d: str, leg: Leg, ready: float) -> tuple[float, bool, float] | None:
        """Faktisk ankomst for legget når du står klar `ready`:
        (ankomst, mistet planlagt avgang, faktisk margin i min = planlagt avgangs faktiske
        avgangstid − når du står klar; < 0 = mistet). None = mangler data den dagen."""
        if leg.line in REFERENCE_LINES:
            missed = ready > leg.dep
            shift = 0 if not missed else BYBANE_HEADWAY_MIN * -(-(ready - leg.dep) // BYBANE_HEADWAY_MIN)
            return leg.arr + shift, missed, leg.dep - ready
        deps = self.deps.get((d, leg.line, leg.from_quay))
        if not deps:
            return None
        planned = next((x for x in deps if x[0] == leg.dep), None)
        if planned is None:
            return None
        missed = planned[1] < ready
        margin = planned[1] - ready
        sj = planned[2]
        # Manglende ankomstrad anslås som planlagt ankomst + forsinkelsen ved avgang.
        # Ruter rapporterer ikke alle stopp (linje 5 08:05 fra Jernbanetorget har rader
        # på sekvens 28, 31, 34, 37 — Blindern mangler mange dager). Å droppe dagen var
        # skjevt: holdt byttet, falt dagen bort; ble det mistet, fant plan B en annen
        # avgang MED data og dagen ble talt. Bare de dårlige dagene overlevde
        # (oslo-010 74 → 5: avspilt 0 % på 4 dager, 2026-11-24).
        self.rides += 1
        if missed:
            nxt = next((x for x in deps if x[0] > leg.dep and x[1] >= ready), None)
            same = None
            if nxt:
                guess = leg.arr + (nxt[1] - leg.dep)
                same = self.arr_near(d, nxt[2], leg.to_quay, nxt[1], guess)
                if same is None:
                    same = guess
            other = self.first_arrival(d, leg.from_quay, leg.to_quay, ready) if self.any_line else None
            alts = [a for a in (same, other) if a is not None]
            if alts:
                return min(alts), True, margin
            return float("inf"), True, margin
        guess = leg.arr + (planned[1] - planned[0])
        arr = self.arr_near(d, sj, leg.to_quay, planned[1], guess)
        if arr is None:
            self.imputed += 1
            arr = guess
        return arr, missed, margin

    def replay(self, c: Candidate) -> list[tuple[float, bool]]:
        """(fremme, mistet et bytte) per dag med komplette data."""
        return [(a, m) for a, m, _ in self.replay_detail(c)]

    def replay_detail(self, c: Candidate) -> list[tuple[float, bool, list[float]]]:
        """(fremme, mistet et bytte, faktisk margin per bytte i min) per dag med komplette data.
        Marginen gjelder det PLANLAGTE byttet; etter et tapt bytte er resten av reisen
        en annen plan, så marginene etter det første tapte bytte tas ikke med."""
        out = []
        for d in self.dates:
            margins: list[float] = []
            t = c.legs[0].dep           # står på første stopp i rute
            any_miss = False
            ok = True
            for i, leg in enumerate(c.legs):
                # Første stopp: du står der 2 min før rutetid (bussen kan gå litt tidlig).
                ready = t + leg.walk_before if i > 0 else leg.dep - 2
                r = self.ride(d, leg, ready)
                if r is None:
                    ok = False
                    break
                t, missed, margin = r
                if i > 0 and not any_miss:
                    margins.append(margin)
                any_miss = any_miss or (missed and i > 0)
            if ok:
                out.append((t + c.walk_after, any_miss, margins))
        return out


# ---------------------------------------------------------------------------
# Rapport
# ---------------------------------------------------------------------------

def pick(rows: list[dict], thr: float, base_only: bool) -> dict | None:
    ok = [r for r in rows if r["n"] >= 5 and r["on_time"] >= thr and (not base_only or None in r["slacks"])]
    return max(ok, key=lambda r: (r["dep"], r["on_time"])) if ok else None


def run_case(case: dict, target: date, parquet_dir: str, app: dict | None, verbose: bool) -> dict:
    when = f"{target.isoformat()}T{case['time']}:00+01:00"
    deadline = to_min(case["time"])
    cands: dict[str, Candidate] = {}
    for slack in SLACKS:
        for p in entur_trip(case["from"], case["to"], when, True, slack):
            c = to_candidate(p)
            if c is None:
                continue
            cands.setdefault(c.key, c).slacks.add(slack)
        time.sleep(1.5)  # snill mot Entur (~30 kall/min uregistrert)

    pairs = {(l.line, l.from_quay) for c in cands.values() for l in c.legs} | \
            {(l.line, l.to_quay) for c in cands.values() for l in c.legs}
    obs = Observed(parquet_dir, pairs, case.get("dayType", "weekday"))

    rows = []
    for c in sorted(cands.values(), key=lambda c: (c.dep, c.arr)):
        res = obs.replay(c)
        n = len(res)
        on = sum(1 for a, _ in res if a <= deadline) / n if n else 0.0
        miss = sum(1 for _, m in res if m) / n if n else 0.0
        late = sorted(a - deadline for a, _ in res)
        rows.append({"key": c.key, "label": c.label(), "dep": c.dep, "arr": c.arr, "n": n,
                     "on_time": on, "miss": miss, "p80_late": late[int(0.8 * (n - 1))] if n else None,
                     "slacks": c.slacks, "margins": c.margins()})

    out = {"case": case["name"], "rows": rows, "flags": []}
    for thr in (0.8, 0.95):
        b, a = pick(rows, thr, True), pick(rows, thr, False)
        out[f"pick{int(thr*100)}"] = (b, a)
        if a and (not b or a["dep"] - b["dep"] >= 10):
            out["flags"].append(f"MARGIN_HJELPER@{int(thr*100)}: {fmt(b['dep']) if b else 'ingen'} → {fmt(a['dep'])} ({a['label']})")
    if not out["pick80"][1]:
        out["flags"].append("INGEN_HOLDER@80")
    if app and app.get("depHHMM"):
        dep = to_min(app["depHHMM"])
        best = out["pick80"][1]
        mine = next((r for r in rows if r["dep"] == dep), None)
        if best and best["dep"] - dep >= 10:
            out["flags"].append(f"APP_FOR_TIDLIG: appen {fmt(dep)}, avspilling {fmt(best['dep'])}")
        if mine and mine["n"] >= 5 and mine["on_time"] < 0.7:
            out["flags"].append(f"APP_FOR_SENT: appens {fmt(dep)} holdt {mine['on_time']:.0%}")
    if not out["flags"]:
        out["flags"].append("STANDARD_HOLDER")

    print(f"\n=== {case['name']}: fremme {case['time']} ({target}, {len(obs.dates)} {case.get('dayType','weekday')}-dager spilt av)")
    if verbose:
        print(f"  {'drar':>5} {'fremme':>6}  {'dager':>5} {'i tide':>6} {'bytte ryker':>11}  marg.  søk         reise")
        for r in rows:
            src = ",".join("std" if s is None else str(s) for s in sorted(r["slacks"], key=lambda s: s or 0))
            mg = ",".join(f"{m:.0f}" for m in r["margins"]) or "-"
            print(f"  {fmt(r['dep'])}  {fmt(r['arr'])}  {r['n']:>5} {r['on_time']:>6.0%} {r['miss']:>11.0%}  {mg:>5}  {src:<11} {r['label']}")
    for thr in (80, 95):
        b, a = out[f"pick{thr}"]
        print(f"  beste {thr} %: standard {fmt(b['dep']) if b else 'ingen':>5} · alle søk {fmt(a['dep']) if a else 'ingen':>5}"
              + (f"  ({a['label']})" if a else ""))
    for f in out["flags"]:
        print(f"  ⚑ {f}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", help="dato for Entur-søket (default: neste hverdag)")
    ap.add_argument("--only", help="kjør bare søk med dette navnet")
    ap.add_argument("--app", help="JSON-fil {navn: {depHHMM}} med appens valg (fra window.__reiseDebug)")
    ap.add_argument("-v", "--verbose", action="store_true", help="vis alle forslag")
    args = ap.parse_args()
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")

    parquet_dir = os.environ.get("PARQUET_DIR", str(ROOT / "data" / "reise-parquet"))
    if args.date:
        target = date.fromisoformat(args.date)
    else:
        target = date.today() + timedelta(days=1)
        while target.weekday() >= 5:
            target += timedelta(days=1)
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    apps = json.loads(Path(args.app).read_text(encoding="utf-8")) if args.app else {}

    results = []
    for case in corpus:
        if args.only and case["name"] != args.only:
            continue
        results.append(run_case(case, target, parquet_dir, apps.get(case["name"]), args.verbose))

    print("\n=== Oppsummering")
    for r in results:
        print(f"  {r['case']:<28} {'; '.join(r['flags'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
