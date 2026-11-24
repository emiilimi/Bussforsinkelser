"""
Rapport fra reiselaboratoriet: les results_<navn>.jsonl fra run.py og skriv
en oppsummering (tekst) + en HTML-side (data/triplab/report_<navn>.html).

Spørsmålene rapporten svarer på:
  1. Følger du Enturs seneste forslag, hvor ofte kommer du for sent?
  2. Hvor mye senere kan du dra (og fortsatt holde 80/95 %) når søket også
     ber om ekstra overgangsmargin — og hva koster hver kombinasjon i kall?
  3. Hvor mangler vi data (per operatør), og hvilke reiser har INGEN
     holdbare forslag?

  python pipeline/triplab/report.py data/triplab/results_od_s1.jsonl
"""
from __future__ import annotations

import html
import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from run import COMBOS, MIN_DAYS  # noqa: E402

THRESHOLDS = (80, 95)


def hhmm(m: int | float) -> str:
    m = int(m)
    return f"{m // 60 % 24:02d}:{m % 60:02d}"


def to_min(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def naive_entur(r: dict) -> dict | None:
    """Enturs eget svar: standardsøket, seneste avgang som er planlagt fremme i tide."""
    deadline = to_min(r["time"])
    ok = [x for x in r["rows"] if "std" in x["slacks"] and x["arr"] <= deadline]
    return max(ok, key=lambda x: (x["dep"], -x["arr"])) if ok else None


def operator(line_ref: str) -> str:
    return line_ref.split(":", 1)[0] if ":" in line_ref else line_ref


def analyse(results: list[dict]) -> dict:
    out: dict = {"n": len(results), "regions": Counter(r["region"] for r in results)}

    # 1. Enturs seneste forslag
    naive = []
    for r in results:
        x = naive_entur(r)
        naive.append({"id": r["id"], "region": r["region"], "row": x,
                      "measured": bool(x and x["n"] >= MIN_DAYS)})
    measured = [x for x in naive if x["measured"]]
    out["naive"] = {
        "with_answer": sum(1 for x in naive if x["row"]),
        "measured": len(measured),
        "late_any": sum(1 for x in measured if x["row"]["on_time"] < 1.0),
        "below80": sum(1 for x in measured if x["row"]["on_time"] < 0.8),
        "below50": sum(1 for x in measured if x["row"]["on_time"] < 0.5),
        "median_on_time": statistics.median(x["row"]["on_time"] for x in measured) if measured else None,
        "hist": Counter(min(9, int(x["row"]["on_time"] * 10)) for x in measured),
    }

    # 2. Kombinasjoner
    combos = {}
    for thr in THRESHOLDS:
        for name, slacks in COMBOS.items():
            gains, rescued, have = [], 0, 0
            for r in results:
                b, a = r["picks"][f"std@{thr}"], r["picks"][f"{name}@{thr}"]
                have += a is not None
                if a and not b:
                    rescued += 1
                elif a and b:
                    gains.append(a["dep"] - b["dep"])
            g = sorted(gains)
            combos[(name, thr)] = {
                "calls": len(slacks), "have": have, "rescued": rescued, "compared": len(g),
                "ge5": sum(1 for x in g if x >= 5), "ge15": sum(1 for x in g if x >= 15),
                "mean": sum(g) / len(g) if g else 0.0, "max": g[-1] if g else 0,
                "sum": sum(g),
            }
    out["combos"] = combos

    # Hver enkelt margin: hvor ofte er det DEN som gir den beste avgangen
    # (blant "alle") — og er den alene om det?
    sole = Counter()
    for r in results:
        a = r["picks"]["alle@80"]
        if not a or not r["picks"]["std@80"] or a["dep"] - r["picks"]["std@80"]["dep"] < 5:
            continue
        winners = [x for x in r["rows"] if x["dep"] == a["dep"] and x["label"] == a["label"]]
        s = set().union(*(set(x["slacks"]) for x in winners)) if winners else set()
        sole[",".join(sorted(s))] += 1
    out["winner_slacks"] = sole

    # Plan B med annen linje: hvor mye endrer det avspillingen?
    diffs = [x["on_time"] - x["on_time_line"] for r in results for x in r["rows"]
             if x["legs"] and x["n"] >= MIN_DAYS and "on_time_line" in x]
    out["planb"] = {"rows": len(diffs), "changed": sum(1 for d in diffs if d > 1e-9),
                    "mean_pp": 100 * sum(diffs) / len(diffs) if diffs else 0.0,
                    "max_pp": 100 * max(diffs) if diffs else 0.0}

    # 3a. Datadekning per operatør (unike legg per reise)
    cov = defaultdict(lambda: [0, 0])
    for r in results:
        seen = set()
        for x in r["rows"]:
            for l in x["legs"]:
                k = (l["line"], l["from"], l["dep"])
                if k in seen:
                    continue
                seen.add(k)
                c = cov[operator(l["line"])]
                c[0] += 1
                c[1] += bool(l["data"])
    out["coverage"] = sorted(((op, n, d) for op, (n, d) in cov.items()), key=lambda t: -t[1])

    # 3b. Reiser uten holdbart forslag
    stuck = []
    for r in results:
        if r["picks"]["alle@80"]:
            continue
        transit = [x for x in r["rows"] if x["legs"]]
        measured_rows = [x for x in transit if x["n"] >= MIN_DAYS]
        if not transit:
            why = "bare gange / ingen forslag"
        elif not measured_rows:
            missing = Counter(operator(l["line"]) for x in transit for l in x["legs"] if not l["data"])
            why = "mangler data (" + ", ".join(f"{k}" for k, _ in missing.most_common(3)) + ")"
        else:
            bestx = max(measured_rows, key=lambda x: x["on_time"])
            why = f"beste målte: {bestx['label']} {hhmm(bestx['dep'])}, {bestx['on_time']:.0%}"
        stuck.append({"id": r["id"], "region": r["region"], "to": r["to"]["name"], "time": r["time"],
                      "dayType": r["dayType"], "why": why})
    out["stuck"] = stuck

    # Største gevinster (alle vs std, 80 %)
    top = []
    for r in results:
        b, a = r["picks"]["std@80"], r["picks"]["alle@80"]
        if a and b and a["dep"] - b["dep"] >= 5:
            app = r["picks"]["app@80"]
            top.append({"id": r["id"], "region": r["region"], "to": r["to"]["name"], "time": r["time"],
                        "dayType": r["dayType"], "std": b, "alle": a, "app": app,
                        "gain": a["dep"] - b["dep"],
                        "app_gain": (app["dep"] - b["dep"]) if app else 0})
    out["top"] = sorted(top, key=lambda t: -t["gain"])

    # Per region
    reg = {}
    for region in sorted(out["regions"]):
        rs = [r for r in results if r["region"] == region]
        nv = [x for x in naive if x["region"] == region and x["measured"]]
        legs = defaultdict(lambda: [0, 0])
        for r in rs:
            for x in r["rows"]:
                for l in x["legs"]:
                    legs[(r["id"], l["line"], l["from"], l["dep"])] = [1, int(l["data"])]
        n_legs = len(legs)
        reg[region] = {
            "n": len(rs),
            "naive_below80": sum(1 for x in nv if x["row"]["on_time"] < 0.8),
            "naive_measured": len(nv),
            "gain_app": sum(1 for r in rs if r["picks"]["std@80"] and r["picks"]["app@80"]
                            and r["picks"]["app@80"]["dep"] - r["picks"]["std@80"]["dep"] >= 5),
            "gain_alle": sum(1 for r in rs if r["picks"]["std@80"] and r["picks"]["alle@80"]
                             and r["picks"]["alle@80"]["dep"] - r["picks"]["std@80"]["dep"] >= 5),
            "stuck": sum(1 for s in stuck if s["region"] == region),
            "coverage": (sum(v[1] for v in legs.values()) / n_legs) if n_legs else 0.0,
        }
    out["by_region"] = reg
    out["margins"] = margin_table(results, picked_only=False)
    out["margins_picked"] = margin_table(results, picked_only=True)
    return out


PLANNED_BUCKETS = [(-99, 1, "under 1 min"), (1, 2, "1–2 min"), (2, 5, "2–5 min"), (5, 10, "5–10 min"),
                   (10, 999, "10 min +")]
REAL_BUCKETS = [(-999, 0, "mistet"), (0, 1, "0–1 min"), (1, 2, "1–2 min"), (2, 5, "2–5 min"), (5, 9999, "5 min +")]


def _bucket(v: float, buckets) -> int:
    return next(i for i, (lo, hi, _) in enumerate(buckets) if lo <= v < hi)


def margin_table(results: list[dict], picked_only: bool) -> dict:
    """Planlagt margin (Entur) mot faktisk margin, talt i bytte-dager.

    Faktisk margin = når den planlagte neste avgangen faktisk gikk − når du faktisk
    sto klar. Bare «mistet» (< 0) er en feil; 0–1 min er rekket på hengende håret.
    Hvert unike bytte (samme to avganger) telles én gang per reise.
    picked_only: bare byttene i forslaget vi ville anbefalt (beste 80 %, alle søk)."""
    grid = [[0] * len(REAL_BUCKETS) for _ in PLANNED_BUCKETS]
    for r in results:
        rows = r["rows"]
        if picked_only:
            pk = r["picks"].get("alle@80")
            rows = [x for x in rows if pk and x["dep"] == pk["dep"] and x["label"] == pk["label"]][:1]
        seen = set()
        for x in rows:
            legs = x["legs"]
            for i, planned in enumerate(x.get("margins") or []):
                if i + 1 >= len(legs):
                    break
                key = (legs[i]["line"], legs[i]["dep"], legs[i + 1]["line"], legs[i + 1]["dep"])
                if key in seen:
                    continue
                seen.add(key)
                for day in x.get("realized") or []:
                    if i < len(day):
                        grid[_bucket(planned, PLANNED_BUCKETS)][_bucket(day[i], REAL_BUCKETS)] += 1
    return {"grid": grid}


def print_text(a: dict) -> None:
    nv = a["naive"]
    print(f"{a['n']} reiser: " + ", ".join(f"{k} {v}" for k, v in sorted(a["regions"].items())))
    print(f"\n1. Enturs seneste forslag (standardsøket): {nv['measured']} med data")
    if nv["measured"]:
        print(f"   holder ikke alltid: {nv['late_any']}, under 80 %: {nv['below80']}, "
              f"under 50 %: {nv['below50']}, median {nv['median_on_time']:.0%}")
    for thr in THRESHOLDS:
        print(f"\n2. Ved {thr} % — senere avgang enn standardsøket:")
        for name in COMBOS:
            c = a["combos"][(name, thr)]
            print(f"   {name:<5} {c['calls']} kall  har svar {c['have']:>3}  ≥5 min {c['ge5']:>3}  "
                  f"≥15 min {c['ge15']:>3}  snitt {c['mean']:4.1f}  maks {c['max']:>3}  reddet {c['rescued']}")
    print("\n   Hvilke marginer gir den beste avgangen (≥5 min gevinst, 80 %):")
    for k, v in a["winner_slacks"].most_common():
        print(f"     {k:<24} {v}")
    pb = a["planb"]
    print(f"\n   Plan B med annen linje: endrer {pb['changed']}/{pb['rows']} målte forslag, "
          f"snitt +{pb['mean_pp']:.1f} pp, maks +{pb['max_pp']:.0f} pp")
    for title, key in (("alle forslag", "margins"), ("forslaget vi ville anbefalt (80 %)", "margins_picked")):
        g = a[key]["grid"]
        print(f"\n   Planlagt → faktisk margin ved bytte, {title} (bytte-dager, andel per rad):")
        print("   " + " " * 12 + "".join(f"{lab:>10}" for _, _, lab in REAL_BUCKETS) + "      sum")
        for (_, _, lab), row in zip(PLANNED_BUCKETS, g):
            n = sum(row)
            if n:
                print(f"   {lab:<12}" + "".join(f"{v / n:>10.0%}" for v in row) + f"{n:>9}")
    print("\n3. Datadekning per operatør (unike legg):")
    for op, n, d in a["coverage"][:15]:
        print(f"   {op:<5} {d:>5}/{n:<5} {d / n:5.0%}")
    print(f"\n   Uten holdbart forslag ved 80 %: {len(a['stuck'])}")
    for s in a["stuck"][:20]:
        print(f"     {s['id']:<16} → {s['to']} {s['time']} ({s['dayType']}): {s['why']}")


# ---------------------------------------------------------------- HTML

CSS = """
:root{--bg:#f6f5f1;--panel:#fffefa;--fg:#1d2328;--muted:#5d666e;--line:#dfdcd3;--accent:#c2410c;
--good:#15803d;--bad:#b91c1c;--warn:#a16207;--bar:#c2410c;--bar2:#94a3b8;--chip:#efece4}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15181b;--panel:#1c2024;--fg:#e8e6e1;
--muted:#9aa3ab;--line:#2d3338;--accent:#fb923c;--good:#4ade80;--bad:#f87171;--warn:#facc15;--bar:#fb923c;--bar2:#64748b;--chip:#252a2f;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#15181b;--panel:#1c2024;--fg:#e8e6e1;--muted:#9aa3ab;--line:#2d3338;--accent:#fb923c;
--good:#4ade80;--bad:#f87171;--warn:#facc15;--bar:#fb923c;--bar2:#64748b;--chip:#252a2f;color-scheme:dark}
body{background:var(--bg);color:var(--fg);font:15px/1.55 "IBM Plex Sans",system-ui,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding-block:32px 64px;padding-left:max(16px,env(safe-area-inset-left,0px));
padding-right:max(16px,env(safe-area-inset-right,0px));display:flex;flex-direction:column;gap:28px}
h1{font:600 30px/1.2 "IBM Plex Sans",system-ui,sans-serif;margin:0;text-wrap:balance}
h2{font:600 19px/1.3 "IBM Plex Sans",system-ui,sans-serif;margin:0 0 4px;text-wrap:balance}
p{margin:0;max-width:68ch}.muted{color:var(--muted)}
.kicker{font:500 12px/1 "IBM Plex Mono",monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px;display:flex;flex-direction:column;gap:12px;min-width:0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.kpi b{display:block;font:600 28px/1.1 "IBM Plex Mono",monospace}.kpi span{color:var(--muted);font-size:13px}
.tbl{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-weight:500;color:var(--muted);font-size:12px;letter-spacing:.04em;text-transform:uppercase}
td.n,th.n{text-align:right;font-family:"IBM Plex Mono",monospace}
tr.hl td{background:var(--chip)}
.bar{display:inline-block;height:8px;border-radius:2px;background:var(--bar);vertical-align:middle}
.bar.alt{background:var(--bar2)}
.hist{display:flex;align-items:flex-end;gap:4px;height:120px}
.hist div{flex:1;background:var(--bar);border-radius:3px 3px 0 0;position:relative;min-width:0}
.hist div.ok{background:var(--good)}
.hlab{display:flex;gap:4px;font:12px "IBM Plex Mono",monospace;color:var(--muted)}.hlab span{flex:1;text-align:center}
code,.mono{font-family:"IBM Plex Mono",monospace;font-size:13px}
.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}
"""


def bar(v: float, mx: float, alt: bool = False) -> str:
    w = 0 if mx <= 0 else max(2, round(120 * v / mx))
    return f'<span class="bar{" alt" if alt else ""}" style="width:{w}px"></span>'


def render_html(a: dict, name: str) -> str:
    e = html.escape
    nv = a["naive"]
    app80, all80 = a["combos"][("app", 80)], a["combos"][("alle", 80)]
    parts = [f"""<title>Reiselaboratoriet {e(name)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>{CSS}</style><div class="wrap">
<header style="display:flex;flex-direction:column;gap:10px">
<div class="kicker">Sentur · reiselaboratoriet · {e(name)}</div>
<h1>{a['n']} hypotetiske reiser, spilt av mot faktiske forsinkelser</h1>
<p class="muted">Bosted trukket fra SSBs befolkningsrutenett (250 m, 2025), reisemål fra en kuratert liste
(sykehus, studiesteder, arbeidsplasser, sentrum). Hver reise er søkt hos Entur med «fremme kl.» og
fem overgangsmarginer, og hvert forslag er spilt av mot de siste ~20 dagene av samme dagtype:
faktiske avgangs- og ankomsttider, og mister du et bytte, neste avgang av samme linje.
{" · ".join(f"{e(k)} {v}" for k, v in sorted(a["regions"].items()))}</p></header>
<div class="kpis">
<div class="kpi"><b class="bad">{nv['below80']}/{nv['measured']}</b><span>ganger Enturs seneste forslag holder under 80&nbsp;% av dagene</span></div>
<div class="kpi"><b>{all80['ge5']}</b><span>reiser der ekstra margin i søket lar deg dra ≥5 min senere og fortsatt holde 80&nbsp;%</span></div>
<div class="kpi"><b>{app80['ge5']}/{all80['ge5']}</b><span>av dem fanger appens tre søk (standard, +300, +600 s)</span></div>
<div class="kpi"><b>{len(a['stuck'])}</b><span>reiser uten noe forslag som holder 80&nbsp;%</span></div>
</div>"""]

    # Histogram
    h = nv["hist"]
    mx = max(h.values()) if h else 1
    cols = "".join(f'<div class="{"ok" if i >= 8 else ""}" style="height:{100 * h.get(i, 0) / mx:.0f}%" '
                   f'title="{h.get(i, 0)} reiser"></div>' for i in range(10))
    labs = "".join(f"<span>{i * 10}</span>" for i in range(10))
    parts.append(f"""<section><div class="kicker">1 · Enturs eget svar</div>
<h2>Hvor ofte holder den seneste avgangen Entur foreslår?</h2>
<p class="muted">Standardsøket, seneste avgang som etter ruten er fremme i tide. Andel dager den faktisk var fremme
(målt for {nv['measured']} av {nv['with_answer']} reiser; resten mangler data på minst ett legg).
Median {nv['median_on_time']:.0%}. Grønt = minst 80&nbsp;%.</p>
<div class="hist">{cols}</div><div class="hlab">{labs}</div>
<p class="muted" style="font-size:13px">Prosent av dagene fremme i tide (søyle = 10-prosentpoengs bøtte).</p></section>""")

    # Combos
    rows = []
    for thr in THRESHOLDS:
        mxg = max(a["combos"][(n, thr)]["ge5"] for n in COMBOS) or 1
        for name_ in COMBOS:
            c = a["combos"][(name_, thr)]
            cls = ' class="hl"' if name_ == "app" else ""
            label = {"std": "bare standard", "app": "appen i dag", "alle": "alle fem"}.get(name_, name_ + " s")
            rows.append(f"<tr{cls}><td>{thr}&nbsp;%</td><td>{e(label)}</td><td class=n>{c['calls']}</td>"
                        f"<td class=n>{c['have']}</td><td class=n>{c['ge5']}</td><td>{bar(c['ge5'], mxg)}</td>"
                        f"<td class=n>{c['ge15']}</td><td class=n>{c['mean']:.1f}</td><td class=n>{c['max']}</td>"
                        f"<td class=n>{c['rescued']}</td></tr>")
    win = "".join(f"<tr><td class=mono>{e(k)}</td><td class=n>{v}</td></tr>"
                  for k, v in a["winner_slacks"].most_common())
    parts.append(f"""<section><div class="kicker">2 · Overgangsmargin i søket</div>
<h2>Hvor mye senere kan du dra når vi også ber om ekstra margin?</h2>
<p class="muted">Beste forslag = det som drar senest og holder minst så ofte (minst {MIN_DAYS} målte dager).
Gevinst måles mot bare standardsøket. «Reddet» = reiser der standardsøket ikke har noe som holder, men kombinasjonen har.
Kall = Entur-søk per reise.</p>
<div class="tbl"><table><tr><th>Krav</th><th>Søk</th><th class=n>Kall</th><th class=n>Har svar</th><th class=n>≥5 min</th><th></th>
<th class=n>≥15 min</th><th class=n>Snitt</th><th class=n>Maks</th><th class=n>Reddet</th></tr>{"".join(rows)}</table></div>
<h2 style="margin-top:8px">Hvilken margin fant den beste avgangen?</h2>
<p class="muted">Blant reisene med ≥5 min gevinst ved 80&nbsp;%: hvilke søk returnerte vinneren (std = 120 s).</p>
<div class="tbl"><table><tr><th>Søk som fant den</th><th class=n>Reiser</th></tr>{win}</table></div>
<p class="muted">Plan B i avspillingen: mister du et bytte, tar du det som først når neste stopp fra samme plattform,
også en annen linje. Det endrer {a['planb']['changed']} av {a['planb']['rows']} målte forslag
(snitt +{a['planb']['mean_pp']:.1f}, maks +{a['planb']['max_pp']:.0f} prosentpoeng i tide) mot bare samme linje.</p></section>""")

    # Top cases
    trs = []
    for t in a["top"][:25]:
        appc = (f'{hhmm(t["app"]["dep"])}' if t["app"] else "–")
        ok = "good" if t["app_gain"] >= t["gain"] else "bad"
        trs.append(f"<tr><td class=mono>{e(t['id'])}</td><td>{e(t['to'])}</td><td class=n>{t['time']}</td>"
                   f"<td class=n>{hhmm(t['std']['dep'])}</td><td class=mono>{e(t['std']['label'])}</td>"
                   f"<td class=n>{hhmm(t['alle']['dep'])}</td><td class=mono>{e(t['alle']['label'])}</td>"
                   f"<td class=n>+{t['gain']}</td><td class='n {ok}'>{appc}</td></tr>")
    parts.append(f"""<section><div class="kicker">Eksempler</div>
<h2>Største gevinster ved 80&nbsp;%</h2>
<p class="muted">Standard = beste fra bare standardsøket; alle = beste fra alle fem. App = hva appens tre søk ville funnet
(grønt når det er like godt som alle fem).</p>
<div class="tbl"><table><tr><th>Reise</th><th>Til</th><th class=n>Fremme</th><th class=n>Std</th><th>Linjer</th>
<th class=n>Alle</th><th>Linjer</th><th class=n>Min</th><th class=n>App</th></tr>{"".join(trs)}</table></div></section>""")

    # Regions
    trs = []
    for region, r in a["by_region"].items():
        trs.append(f"<tr><td>{e(region)}</td><td class=n>{r['n']}</td>"
                   f"<td class=n>{r['naive_below80']}/{r['naive_measured']}</td>"
                   f"<td class=n>{r['gain_app']}</td><td class=n>{r['gain_alle']}</td><td class=n>{r['stuck']}</td>"
                   f"<td class=n>{r['coverage']:.0%}</td><td>{bar(r['coverage'], 1, True)}</td></tr>")
    def mtable(g):
        head = "".join(f"<th class=n>{e(lab)}</th>" for _, _, lab in REAL_BUCKETS)
        trs = []
        for (_, _, lab), row in zip(PLANNED_BUCKETS, g):
            n = sum(row)
            if not n:
                continue
            cells = []
            for j, v in enumerate(row):
                cls = " bad" if j == 0 and v else (" warn" if j == 1 and v else "")
                cells.append(f"<td class='n{cls}'>{v / n:.0%}</td>")
            trs.append(f"<tr><td>{e(lab)}</td>{''.join(cells)}<td class=n>{n}</td></tr>")
        return (f"<div class='tbl'><table><tr><th>Planlagt</th>{head}<th class=n>Bytte-dager</th></tr>"
                f"{''.join(trs)}</table></div>")
    parts.append(f"""<section><div class="kicker">Bytter i virkeligheten</div>
<h2>Hvor mye margin har du igjen når du står på holdeplassen?</h2>
<p class="muted">Planlagt margin = Entur sin (rutetid neste avgang − ankomst − gange). Faktisk = når den planlagte neste
avgangen faktisk gikk − når du faktisk sto klar, per dag i avspillingen. <b>Bare «mistet» er en feil.</b> At en 5-minutters
overgang blir 2 min fordi bussen var sen, er normalt og greit; <span class="warn">0–1 min</span> er rekket, men på hengende
håret.</p>
<h2 style="font-size:16px">Forslaget vi ville anbefalt (beste ved 80&nbsp;%)</h2>{mtable(a['margins_picked']['grid'])}
<h2 style="font-size:16px">Alle forslag Entur ga</h2>{mtable(a['margins']['grid'])}
</section>""")
    parts.append(f"""<section><div class="kicker">Per region</div><h2>Hvor treffer det?</h2>
<div class="tbl"><table><tr><th>Region</th><th class=n>Reiser</th><th class=n>Entur &lt;80&nbsp;%</th>
<th class=n>Gevinst app</th><th class=n>Gevinst alle</th><th class=n>Uten svar</th><th class=n>Legg m/data</th><th></th></tr>
{"".join(trs)}</table></div></section>""")

    # Coverage
    mxn = max((n for _, n, _ in a["coverage"]), default=1)
    trs = "".join(f"<tr><td class=mono>{e(op)}</td><td class=n>{n}</td><td>{bar(n, mxn, True)}</td>"
                  f"<td class=n>{d / n:.0%}</td><td>{bar(d / n, 1)}</td></tr>"
                  for op, n, d in a["coverage"])
    st = "".join(f"<tr><td class=mono>{e(s['id'])}</td><td>{e(s['to'])}</td><td class=n>{s['time']}</td>"
                 f"<td>{e(s['dayType'])}</td><td>{e(s['why'])}</td></tr>" for s in a["stuck"])
    parts.append(f"""<section><div class="kicker">3 · Datagrunnlag</div>
<h2>Datadekning per operatør</h2>
<p class="muted">Unike legg (linje, fra-plattform, avgang) i forslagene; «med data» = vi har observasjoner for linjen ved
fra-plattformen minst {MIN_DAYS} av de avspilte dagene. Bybanen telles som dekket (kildebelagte tall).</p>
<div class="tbl"><table><tr><th>Operatør</th><th class=n>Legg</th><th></th><th class=n>Med data</th><th></th></tr>{trs}</table></div>
<h2 style="margin-top:8px">Reiser uten noe forslag som holder 80&nbsp;%</h2>
<div class="tbl"><table><tr><th>Reise</th><th>Til</th><th class=n>Fremme</th><th>Dag</th><th>Hvorfor</th></tr>{st}</table></div>
</section>
<p class="muted" style="font-size:13px">Generert av <code>pipeline/triplab/report.py</code>. Avspillingen er en modell:
du står på første stopp 2 min før rutetid, Bybanen går som rutet (vi har ingen ekte målinger), og et tapt bytte gir det
som først når neste stopp fra samme plattform. Den ser ikke omveier (annen plattform, gå til et annet stopp), så et tapt
bytte straffes fortsatt litt hardere enn i virkeligheten.</p></div>""")
    return "\n".join(parts)


def main() -> int:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")
    f = Path(sys.argv[1])
    results = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
    a = analyse(results)
    print_text(a)
    stem = f.stem.removeprefix("results_")
    out = f.parent / f"report_{stem}.html"
    out.write_text(render_html(a, stem), encoding="utf-8")
    print(f"\n→ {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
