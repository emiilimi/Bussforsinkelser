"""
Hent grunnlaget for å trekke realistiske reiser:

  - hvor folk bor: SSB «Befolkning på rutenett 250 m» (2025), via SSBs åpne
    WFS-tjeneste (NLOD). Én rad per bebodd rute: midtpunkt + antall bosatte.
  - hvor folk skal: den kuraterte lista i regions.py (sykehus, studiesteder,
    arbeidsplassområder, kjøpesentre, sentrum), slått opp til holdeplass med
    Enturs geokoder.

Skriver data/triplab/places_<region>.json. Kjøres sjelden (data endres årlig).

  python pipeline/triplab/fetch_places.py            # alle regioner
  python pipeline/triplab/fetch_places.py bergen
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from regions import REGIONS  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "triplab"
WFS = "https://kart.ssb.no/api/mapserver/v1/wfs/befolkning_paa_rutenett"
LAYER = "ms:befolkning_250m_2025"
UA = {"User-Agent": "sentur-triplab/1.0 (reiseplanlegger-revisjon)"}

MEMBER = re.compile(r"<wfs:member>(.*?)</wfs:member>", re.S)
LOWER = re.compile(r"<gml:lowerCorner>([\d.]+) ([\d.]+)</gml:lowerCorner>")
UPPER = re.compile(r"<gml:upperCorner>([\d.]+) ([\d.]+)</gml:upperCorner>")
POP = re.compile(r"<ms:pop_tot>(\d+)</ms:pop_tot>")


def get(url: str, data: bytes | None = None, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, data=data, headers=UA)
    for attempt in range(4):
        try:
            return urllib.request.urlopen(req, timeout=timeout).read()
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                raise
            print(f"  ! {e} — prøver igjen", file=sys.stderr)
            time.sleep(10 * (attempt + 1))
    raise RuntimeError("unreachable")


def fetch_population(bbox) -> list[dict]:
    s, w, n, e = bbox
    cells, start, page = [], 0, 1000  # tjenesten gir maks 1000 per side
    while True:
        q = urllib.parse.urlencode({
            "service": "WFS", "version": "2.0.0", "request": "GetFeature",
            "typeNames": LAYER, "count": page, "startIndex": start,
            "bbox": f"{s},{w},{n},{e},urn:ogc:def:crs:EPSG::4326",
        })
        xml = get(f"{WFS}?{q}").decode("utf-8")
        members = MEMBER.findall(xml)
        for m in members:
            lo, up, pop = LOWER.search(m), UPPER.search(m), POP.search(m)
            if not (lo and up and pop):
                continue
            cells.append({
                "lat": round((float(lo[1]) + float(up[1])) / 2, 6),
                "lon": round((float(lo[2]) + float(up[2])) / 2, 6),
                "pop": int(pop[1]),
            })
        # En side kan ha FÆRRE enn `count` selv om det finnes flere (målt:
        # 927, så 888 av 1000 for Bergen) — stopp først på en tom side.
        if not members:
            return cells
        start += page


GEOCODER = "https://api.entur.io/geocoder/v1/autocomplete"


def resolve(text: str, bbox) -> dict | None:
    """Holdeplassen geokoderen gir for teksten, innenfor regionen."""
    s, w, n, e = bbox
    q = urllib.parse.urlencode({"text": text, "size": 10, "lang": "no", "layers": "venue",
                                "focus.point.lat": (s + n) / 2, "focus.point.lon": (w + e) / 2})
    req = urllib.request.Request(f"{GEOCODER}?{q}", headers={"ET-Client-Name": "emiliemoldestad-sentur"})
    d = json.load(urllib.request.urlopen(req, timeout=30))
    for f in d.get("features", []):
        lon, lat = f["geometry"]["coordinates"]
        if s <= lat <= n and w <= lon <= e and str(f["properties"].get("id", "")).startswith("NSR:StopPlace:"):
            return {"stopPlace": f["properties"]["id"], "stopName": f["properties"]["name"],
                    "lat": round(lat, 6), "lon": round(lon, 6)}
    return None


def fetch_destinations(region: dict) -> list[dict]:
    out = []
    for text, kind in region["destinations"]:
        hit = resolve(text, region["bbox"])
        if hit is None:
            print(f"  ! fant ikke «{text}»", file=sys.stderr)
            continue
        out.append({"name": text, "kind": kind, **hit})
        time.sleep(0.3)
    return out


def main() -> int:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    names = sys.argv[1:] or list(REGIONS)
    for name in names:
        r = REGIONS[name]
        t0 = time.time()
        cells = fetch_population(r["bbox"])
        dests = fetch_destinations(r)
        (OUT / f"places_{name}.json").write_text(
            json.dumps({"region": name, "population": cells, "destinations": dests}, ensure_ascii=False),
            encoding="utf-8")
        by_kind = {}
        for d in dests:
            by_kind[d["kind"]] = by_kind.get(d["kind"], 0) + 1
        print(f"{name}: {len(cells)} ruter, {sum(c['pop'] for c in cells):,} bosatte; "
              f"reisemål {by_kind} ({time.time() - t0:.0f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
