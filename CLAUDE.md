# bussforsinkelser.no — Prosjektnotater for Claude

Denne filen lastes automatisk inn i kontekst ved oppstart. Hold den oppdatert.

---

## Datakilde og pipeline

### BigQuery-tabell
`ent-data-sharing-ext-prd.realtime_siri_et.realtime_siri_et_last_recorded`
- Operator-kode: `SKY` (Skyss, Vestland)
- Env-var override: `BQ_OPERATOR`, `BQ_TABLE`

### Skyss-spesifikk quirk: `vehicleMode = NULL` betyr buss
Skyss populerer **ikke** `vehicleMode` for bussavganger i SIRI ET. `NULL` = buss.
Kun ferge (og noen andre) er eksplisitt tagget. Koden bruker `fillna("bus")` — dette er korrekt og tilsiktet.
Ghost-linjer med gamle Rutebanken-stopp (f.eks. linje 1200, 3260) filtreres bort av `NSR:`-sjekken, ikke av vehicleMode.

### Kjente BQ-kolonnenavn (bekreftet i bruk)
- `serviceJourneyId` — stabil NeTEx-ID for én spesifikk rutet avgang (f.eks. "06:15 Linje 6")
- `sequenceNr` — stoppesteds-rekkefølge langs ruten
- `stopPointRef` — NSR-ref (f.eks. `NSR:Quay:12345`)
- `lineRef` — f.eks. `SKY:Line:6` (operatørkode er embedded i line_ref)
- `dataSource` — brukes for å filtrere på operatør (f.eks. `SKY`)

---

## Mappestruktur — data og NeTEx

```
netex/
  sky/          ← NeTEx XML for Skyss (tidligere rb_sky-aggregated-netex/)
  atb/          ← fremtidig (Trøndelag)
  rut/          ← fremtidig (Oslo/Viken)

gtfs-legacy/
  sky/          ← gammel GTFS-nedlastning (brukes av populate_stop_places.py)
```

### `populate_line_names.py` — to strategier, auto-valgt per operatør

| Operatør | Strategi | Betingelse |
|---|---|---|
| SKY | NeTEx XML-parsing | `netex/sky/` finnes |
| SOF, FIR, ATB, ... | DB-avledet (vektet terminus) | Ingen NeTEx-mappe |

```powershell
python pipeline/populate_line_names.py                       # dry-run, alle ikke-SKY
python pipeline/populate_line_names.py --operator SKY        # dry-run, SKY via NeTEx
python pipeline/populate_line_names.py --operator SOF        # dry-run, SOF via DB
python pipeline/populate_line_names.py --apply               # skriv til DB
python pipeline/populate_line_names.py --dump names.json     # lagre for manuell redigering
python pipeline/populate_line_names.py --from-file names.json --apply  # bruk redigert fil
```

---

## `populate_stops.py` — viktig!

**Henter fra BigQuery**, ikke NSR API. Bruker BQ-kvote.

| Kommando | Hva skjer |
|---|---|
| `python pipeline/populate_stops.py` | Leser fra `data/stop_coords.json` (ingen BQ-kall) |
| `python pipeline/populate_stops.py --refresh` | Henter fra BigQuery → lagrer cache → skriver til DB |

`--refresh` trengs bare når NSR-registeret har endret seg (sjelden, kanskje noen ganger per år).
Ved vanlig DB-recreate: bruk uten `--refresh` siden cachen allerede finnes.

---

## DB-recreate kommandoer

```powershell
del data\bussforsinkelser.db
python pipeline/db_setup.py
python pipeline/populate_stops.py          # leser fra cache, ingen BQ-kall
foreach ($d in @("2026-03-07","2026-03-08",...)) {
    Write-Host "Ingesting $d..."; python pipeline/ingest.py $d
}
```

---

## Operatør-kolonne strategi

| Tabell | Strategi | Begrunnelse |
|---|---|---|
| `line_daily`, `line_hourly_*`, `leaderboard_lines`, `journey_stop_weekly` | Operator embedded i `line_ref` prefix (f.eks. `SKY:`, `SOF:`) | Ikke-SKY linjer (SOF, FIR) er inkludert — filtreres kun av `dataSource` i BQ |
| `stop_daily`, `stop_hourly_raw/profile`, `worst_days`, `daily_summary` | Egen `operator` kolonne i PK | NSR-stoppref er operatøruavhengig |

---

## Tabellformål

| Tabell | Hva | Brukes til |
|---|---|---|
| `daily_summary` | Daglig oversikt (bus only) | Dashboard-kort, trend |
| `line_daily` | Per linje per dag | Linje-leaderboard, linjeanalyse |
| `stop_daily` | Per stopp per dag (alle linjer samlet) | Stopp-leaderboard, dagsvis trend |
| `stop_hourly_profile` | 30-dagers rullende snitt per time per stopp | Timesgraf på stoppstedsside |
| `line_hourly_profile` | 30-dagers rullende snitt per time per linje | Timesgraf på linjeanalyse |
| `journey_stop_weekly` | Per avgang per stopp per uke (13-ukers vindu) | Reiseprofil, verste stopp på ruten, linjer per stopp |
| `stop_coords` | GPS-koordinater fra NSR (via BQ) | Kart, stoppenavn |
| `leaderboard_lines` | All-time linjerangering | Topplister |
| `worst_days` | Topp 100 verste dager | Topplister |

---

## SQLite-begrensning: kan ikke endre PRIMARY KEY

SQLite støtter **ikke** `ALTER TABLE` for å endre PK. Hvis PK må endres:
1. `del data\bussforsinkelser.db`
2. `python pipeline/db_setup.py`
3. Re-ingest

---

## `journey_stop_weekly` — låser opp

- **Reiseprofil** (Thomas-analysen): forsinkelse stopp for stopp langs en avgang
- **Verste stopp på ruten**: `GROUP BY stop_ref WHERE line_ref = 'SKY:Line:6'`
- **Linjer per stopp**: `GROUP BY line_ref WHERE stop_ref = 'NSR:Quay:xxxxx'`
- **Stopp-leaderboard filtrert på linje**
- Data eldre enn 13 uker slettes automatisk av `upsert_journey_stop_weekly()`

---

## Forskjell: `stop_daily` vs `journey_stop_weekly`

`stop_daily` aggregerer **alle linjer** ved et stopp til én rad per dag. Kan ikke skille hvilken linje som forårsaket forsinkelse. Har **ubegrenset historikk**.

`journey_stop_weekly` har per-avgang-granularitet og linjeinfo, men **bare 13 ukers vindu**.

Bruk `stop_daily` til: stopp-leaderboard totalt, dagsvis trend tilbake i tid.
Bruk `journey_stop_weekly` til: linje-filtrert stoppsanalyse, reiseprofil.
