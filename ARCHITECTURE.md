# Bussforsinkelser — Arkitektur og funksjonsoversikt

---

## Dataflyt (overordnet)

```
BigQuery (Entur SIRI ET)
    │   Rådata: én rad per stopp per avgang per dag
    │   Ca. 500 000 rader/dag for Skyss
    ▼
pipeline/ingest.py
    │   Beregner forsinkelse, aggregerer per linje/stopp/time
    │   Filtrerer: kun NSR-stopp, kun kjente vehicle_mode
    ▼
SQLite (bussforsinkelser.db)
    │   Ferdig aggregerte tabeller
    ▼
Express API (server/)
    │   REST-endepunkter
    ▼
React Frontend (client/)
    │   Interaktive grafer og kart
    ▼
Bruker
```

---

## Nåværende databaseskjema

### `daily_summary`
**Formål:** Daglig nettverksnivå-statistikk for dashboardet. Kun buss.

| Kolonne | Type | Beskrivelse |
|---|---|---|
| `date` | TEXT PK | ISO-dato |
| `avg_delay_min` | REAL | Snitt forsinkelse alle avganger |
| `pct_on_time` | REAL | Andel avganger < 2 min forsinkelse |
| `pct_delayed_10plus` | REAL | Andel avganger > 10 min forsinkelse |
| `total_journeys` | INTEGER | Totalt antall registrerte avganger |
| `total_cancellations` | INTEGER | Antall kansellerte avganger |

**Populeres av:** `upsert_daily_summary()` — én rad per dag, REPLACE ved re-ingest.

---

### `line_daily`
**Formål:** Per-linje-statistikk per dag per retning. Grunnlag for de fleste linjeanalyser.

| Kolonne | Type | Beskrivelse |
|---|---|---|
| `date` | TEXT | ISO-dato |
| `line_ref` | TEXT | NeTEx-ID, f.eks. `SKY:Line:6` |
| `direction_ref` | TEXT | `'0'` = utover, `'1'` = innover |
| `vehicle_mode` | TEXT | `'bus'`, `'ferry'`, etc. |
| `line_name` | TEXT | Generert: `'Linje 6'` |
| `avg_delay_min` | REAL | Vektet snitt forsinkelse |
| `median_delay_min` | REAL | Median forsinkelse |
| `pct_on_time` | REAL | % avganger < 2 min forsinkelse |
| `pct_delayed_2plus` | REAL | % avganger > 2 min forsinkelse |
| `pct_delayed_10plus` | REAL | % avganger > 10 min forsinkelse |
| `num_departures` | INTEGER | Antall avganger (ekskl. kansellerte) |

**PK:** `(date, line_ref, direction_ref)`
**Merknader:** Lagres per retning; API-lag aggregerer begge retninger til én linje-visning.

---

### `stop_daily`
**Formål:** Per-stoppested-statistikk per dag. Grunnlag for kart og stoppstedsanalyse.

| Kolonne | Type | Beskrivelse |
|---|---|---|
| `date` | TEXT | ISO-dato |
| `stop_ref` | TEXT | `NSR:Quay:xxxxx` |
| `vehicle_mode` | TEXT | `'bus'`, `'ferry'`, etc. |
| `stop_name` | TEXT | Fra SIRI ET (kan være NULL for Skyss) |
| `avg_delay_min` | REAL | |
| `pct_delayed_2plus` | REAL | |
| `num_departures` | INTEGER | |

**PK:** `(date, stop_ref, vehicle_mode)`
**Merknader:** `stop_name` er nesten alltid NULL for Skyss — navn hentes fra `stop_coords` via COALESCE ved spørring.

---

### `stop_coords`
**Formål:** Koordinater og navn for alle NSR-kvaier. Populeres av `populate_stops.py`, ikke av ingest.

| Kolonne | Type | Beskrivelse |
|---|---|---|
| `stop_ref` | TEXT PK | `NSR:Quay:xxxxx` |
| `stop_name` | TEXT | Navn fra parent StopPlace i NSR |
| `lat` | REAL | Breddegrad (fra quays-tabellen) |
| `lng` | REAL | Lengdegrad (fra quays-tabellen) |

**Kilde:** BigQuery JOIN: `quays_last_version` × `stop_places_last_version` på `stopPlaceRef`
**Cache:** `data/stop_coords.json` (fornybar med `--refresh`, automatisk etter 30 dager)

---

### `line_hourly_raw`
**Formål:** Rådata for timeprofil — mellomlagring for å kunne rebuilde profilen.

| Kolonne | Type | Beskrivelse |
|---|---|---|
| `date` | TEXT | |
| `line_ref` | TEXT | |
| `line_name` | TEXT | |
| `hour` | INTEGER | 0–23 (Oslo-tid) |
| `avg_delay_min` | REAL | |
| `num_samples` | INTEGER | |

**PK:** `(date, line_ref, hour)`

---

### `line_hourly_profile`
**Formål:** 30-dagers rullerende timeprofil per linje. Rebuildes nightly.

| Kolonne | Type | Beskrivelse |
|---|---|---|
| `line_ref` | TEXT | |
| `line_name` | TEXT | |
| `hour` | INTEGER | 0–23 |
| `avg_delay_min` | REAL | Vektet snitt siste 30 dager |
| `num_samples` | INTEGER | |

**PK:** `(line_ref, hour)`

---

### `leaderboard_lines`
**Formål:** All-time toppliste linjer. Rebuildes nightly fra `line_daily` (bus only).

| Kolonne | Type | Beskrivelse |
|---|---|---|
| `line_ref` | TEXT PK | |
| `line_name` | TEXT | |
| `avg_delay_min` | REAL | Vektet all-time snitt |
| `pct_on_time` | REAL | |
| `pct_delayed_10plus` | REAL | |
| `total_departures` | INTEGER | |

**Merknader:** Brukes for "all-time"-perioden på toppliste-linjer. Uke/måned beregnes live fra `line_daily`.

---

### `leaderboard_stops`
**Formål:** All-time toppliste stopp. Rebuildes nightly.
**Status:** Brukes ikke lenger av nettstedet — stopp-topplisten beregnes nå live fra `stop_daily` med ukesvindu. Kan fjernes.

---

### `worst_days`
**Formål:** De 100 historisk verste dagene. Rebuildes nightly fra `daily_summary`.

| Kolonne | Type | Beskrivelse |
|---|---|---|
| `date` | TEXT PK | |
| `avg_delay_min` | REAL | |
| `total_journeys` | INTEGER | |
| `total_cancellations` | INTEGER | |
| `pct_on_time` | REAL | |

---

## Implementerte tilleggstabeller (2026-04)

### `journey_stop_weekly` ✅
**Formål:** Kjernedatastruktur for reiseprofil-analyse (forsinkelse per stopp langs ruten) og linjer-per-stoppsted-analyse. Sliding window med ukentlige aggregat-buckets.

| Kolonne | Type | Beskrivelse |
|---|---|---|
| `week_start` | TEXT | ISO-dato for mandag i uken |
| `service_journey_id` | TEXT | Stabil NeTEx-ID for én spesifikk avgang (f.eks. "06:15-bussen") |
| `line_ref` | TEXT | |
| `direction_ref` | TEXT | |
| `stop_ref` | TEXT | `NSR:Quay:xxxxx` |
| `sequence_nr` | INTEGER | Rekkefølge langs ruten |
| `aimed_time` | TEXT | `"06:15"` — rutetid ved dette stoppestedet |
| `avg_delay_min` | REAL | Vektet snitt for alle kjøringer i uken |
| `max_delay_min` | REAL | Maks forsinkelse i uken |
| `min_delay_min` | REAL | Min forsinkelse i uken |
| `num_samples` | INTEGER | Antall kjøringer denne uken |

**PK:** `(week_start, service_journey_id, stop_ref)`
**Indekser:** `(line_ref, direction_ref)`, `(stop_ref)`, `(week_start)`

**Nightly update-logikk:**
```sql
INSERT INTO journey_stop_weekly (...) VALUES (...)
ON CONFLICT (week_start, service_journey_id, stop_ref) DO UPDATE SET
  avg_delay_min = (avg_delay_min * num_samples + excluded.avg_delay_min * excluded.num_samples)
                  / (num_samples + excluded.num_samples),
  max_delay_min = MAX(max_delay_min, excluded.max_delay_min),
  min_delay_min = MIN(min_delay_min, excluded.min_delay_min),
  num_samples   = num_samples + excluded.num_samples;

DELETE FROM journey_stop_weekly WHERE week_start < date('now', '-91 days');
```

**Datamengde Skyss:** ~75 000 rader/uke × 13 uker = ~975 000 rader ≈ 80 MB

---

### `journey_stop_daily` ✅
**Formål:** Rå per-avgang per-stopp per-dag data. Ikke aggregert. 90-dagers rullende vindu.
Grunnlag for Parquet-eksport og DuckDB-WASM klient-side analyse (persentiler, scatter plots).

| Kolonne | Type | Beskrivelse |
|---|---|---|
| `date` | TEXT | ISO-dato |
| `service_journey_id` | TEXT | NeTEx ServiceJourney ID |
| `line_ref` | TEXT | `SKY:Line:6` etc. |
| `direction_ref` | TEXT | `'0'`/`'1'` |
| `stop_ref` | TEXT | `NSR:Quay:xxxxx` |
| `stop_sequence` | INTEGER | Stopperekkefølge langs ruten |
| `aimed_arrival` | TEXT | Planlagt ankomsttid |
| `aimed_departure` | TEXT | Planlagt avgangstid |
| `delay_arrival_min` | REAL | Forsinkelse ankomst (minutter) |
| `delay_departure_min` | REAL | Forsinkelse avgang (minutter) |
| `dwell_time_sec` | REAL | Stopptid (sekunder) |

**PK:** `(date, service_journey_id, stop_ref)`
**Eksport:** `pipeline/export_parquet.py` → `data/parquet/2026-W15.parquet` (ZSTD)

---

### `operator_config` *(ikke implementert)*
**Formål:** Konfigurasjon per region/operatør. Nødvendig for multi-region-støtte.

| Kolonne | Type | Beskrivelse |
|---|---|---|
| `operator_id` | TEXT PK | `'SKY'`, `'RUT'`, `'ATB'`, etc. |
| `display_name` | TEXT | `'Skyss'`, `'Ruter'`, `'AtB'` |
| `bq_data_source` | TEXT | Verdien i `dataSource`-kolonnen i BigQuery |
| `stop_name_source` | TEXT | `'nsr'` eller `'siri'` (Ruter fyller inn navn i SIRI ET) |
| `active` | INTEGER | 0/1 |

---

## Nåværende nettsidesfunksjoner

### Dashboard (`/`)
**Status:** Implementert ✓

Viser nettverksnivå-statistikk for valgt region og periode.

- **4 nøkkeltall:** Snitt forsinkelse, Andel i rute, Dårligste linje, Totale avganger
- **Forsinkelse over tid:** Linjediagram med daglig snitt-forsinkelse for valgt periode (uke/måned/år)
- **Dårligste linjer:** Horisontalt stolpediagram med topp 5 verste linjer for perioden
- **Periodevalg:** Uke / Måned / År (toggle-tabs)

**API-kall:**
- `GET /api/summary` — siste tilgjengelige dag
- `GET /api/summary/trend?days=N` — daglig trend
- `GET /api/leaderboard/lines?type=worst&period=P&operator=O` — verste linjer

---

### Forsinkelseskart (`/map`)
**Status:** Implementert ✓

Interaktivt kart (Leaflet) der alle bussstopp er plottet som fargekodede sirkler basert på forsinkelsesnivå.

- Grønn → lav forsinkelse, gul → moderat, rød → høy
- Klikk på stopp → popup med navn, snitt forsinkelse, % forsinket > 2 min, antall avganger
- Fallback: viser siste tilgjengelige dato dersom gårsdagens data ikke finnes

**API-kall:**
- `GET /api/stops/map?date=YYYY-MM-DD`

---

### Stoppstedsanalyse (`/stops`)
**Status:** Implementert ✓

Søk etter et stoppested og se historisk forsinkelsesutvikling.

- **Søkefelt:** Typeahead-søk på stoppestedsnavn
- **3 nøkkeltall:** Snitt forsinkelse, Totale avganger, % forsinket > 2 min
- **Daglig trend:** Arealdiagram med forsinkelse per dag siste 30 dager

**Mangler (planlagt):**
- Hvilke linjer betjener dette stoppestedet og hvor punktlige er de? (krever `journey_stop_weekly`)

**API-kall:**
- `GET /api/stops/search?q=...`
- `GET /api/stop/:stopref?days=30`

---

### Topplister (`/worst`)
**Status:** Implementert ✓

Fire tabeller i 2×2-grid.

- **Verste dager:** Dager med høyest snitt forsinkelse (all-time, fra `worst_days`)
- **Beste dager:** Dager med lavest snitt forsinkelse (live fra `daily_summary`)
- **Verste stopp:** Topp 10 stoppesteder siste 7 dager (min. 100 avg/uke)
- **Beste stopp:** Bunn 10 stoppesteder siste 7 dager (min. 100 avg/uke)

**API-kall:**
- `GET /api/worst-days?limit=10`
- `GET /api/best-days?limit=10`
- `GET /api/leaderboard/stops?type=worst&days=7`
- `GET /api/leaderboard/stops?type=best&days=7`

---

### Linjeanalyse (`/journey`)
**Status:** Implementert (grunnversjon) ✓

Velg en linje og se historisk ytelse.

- **Velg linje:** Dropdown med alle kjente linjer for valgt region
- **3 nøkkeltall:** Snitt forsinkelse, Andel i rute, Kraftig forsinket (>10 min)
- **Forsinkelse etter time:** Stolpediagram — hvilken time på dagen er linjen mest forsinket?
- **Daglig trend:** Arealdiagram med snitt per dag siste 30 dager

**Planlagt utvidelse (se nedenfor):** Velg spesifikk avgang og se reiseprofil per stopp.

**API-kall:**
- `GET /api/lines/all?operator=O`
- `GET /api/line/:lineref?days=30`

---

### Reiseplanlegger (`/reise`)
**Status:** Alpha (2026-04-12) ✓

Statistisk reiseplanlegger: Søk fra→til, få Entur-reiseforslag med historisk forsinkelsesdata overlay.

- **Stoppsøk:** Debounced typeahead via `corridor-search` (gruppert per StopPlace)
- **Entur-proxy:** `POST /api/trip` → Entur JP v3 GraphQL, 5-min server-cache
- **Delay overlay:** `POST /api/trip/stats` → `journey_stop_weekly` aggregat per (stopRef, lineRef)
- **Overgangsanalyse:** Buffer-tid vs snitt ankomstforsinkelse → "Trygg"/"Sannsynlig"/"Usikker"/"Risikabel"
- **Gangavstander:** `mode: "foot"` legs vises i UI
- **NLOD-attribusjon:** Sidebar med Entur-logo og NLOD 2.0-referanse

**API-kall:**
- `GET /api/stops/corridor-search?q=...` — stoppsøk (returnerer `stopPlaceRef`)
- `POST /api/trip` — Entur proxy (cachet)
- `POST /api/trip/stats` — delay stats

**Planlagt utvidelse:**
- P50/P80/P95 persentiler (krever DuckDB-WASM + Parquet)
- Empirisk transfer-sannsynlighet fra rådata
- Historisk enkeltreise-oppslag (spesifikk dato + avgang)

---

## Planlagte / mulige fremtidige funksjoner

### Reiseprofil-analyse (`/journey` — utvidelse)
**Prioritet:** ✅ Implementert
**Krever:** `journey_stop_weekly`-tabellen

Utvid linjeanalysen med:

1. **Velg retning** (inn/ut)
2. **Velg avgang** — dropdown med alle `service_journey_id`-er for linjen, vist som avgangstider (f.eks. "06:15", "07:00", "07:30")
3. **Graf: Forsinkelse per stopp langs ruten** — x-akse = stopperekkefølge med navn og rutetid, y-akse = forsinkelse i minutter, tre linjer: snitt / maks / min
   - Dette er "Thomas-analysen": se nøyaktig hvor på ruten forsinkelsen bygger seg opp
   - Graf-prototype allerede designet (se Jupyter notebook)
4. **Enkeltdagsvisning** — velg en spesifikk dato og se nøyaktig hva som skjedde den dagen

**Nye API-kall:**
- `GET /api/journeys/:lineref?direction=1` — liste over tilgjengelige avganger
- `GET /api/journey/:journeyid?weeks=13` — full stopprofil

---

### Linjer per stoppested (stoppstedsanalyse — utvidelse)
**Prioritet:** Høy
**Krever:** `journey_stop_weekly`-tabellen

I stoppstedsanalysen, legg til:
- Tabell: hvilke linjer betjener dette stoppestedet?
- Per linje: snitt forsinkelse ved akkurat dette stoppestedet, % i rute, antall avganger/uke
- Svar på: "Er det linje 6 eller linje 5 som er verst akkurat her?"

**Ny API-kall:**
- `GET /api/stop/:stopref/lines?weeks=4` — aggregert fra `journey_stop_weekly`

---

### Daglig forsinkelsesvarsel
**Prioritet:** Lav / fremtidig
**Krever:** E-post eller push-infrastruktur

- Brukere kan abonnere på varsler for spesifikke linjer eller stoppesteder
- Daglig oppsummering: "Linje 6 hadde i dag 8 min snitt forsinkelse — 40% over normalt"
- Alerting ved ekstraordinære hendelser (snitt > 15 min)

---

### Sammenligningsvisning
**Prioritet:** Middels

- Sammenlign to linjer side ved side over samme periode
- Sammenlign en linje mot seg selv (denne måneden vs. forrige måned / samme måned i fjor)
- "Er linje 6 bedre nå enn for et år siden?"

---

### Regionvelger / multi-region
**Prioritet:** Høy (nødvendig for vekst)
**Status:** Frontend-stub finnes (RegionContext), backend ikke implementert

Støtte for flere operatører:

| Operatør | Kode | Merknad |
|---|---|---|
| Skyss (Hordaland) | `SKY` | Implementert |
| Ruter (Oslo) | `RUT` | `stopPointName` er fylt inn — trenger ikke NSR for navn |
| AtB (Trondheim) | `ATB` | |
| Agder Kollektivtrafikk | `AKT` | |
| Kolumbus (Stavanger) | `KOL` | |

**Arkitekturvalg:** Anbefalt løsning er én felles SQLite-database med `operator`-kolonne på alle tabeller, fremfor separate DB-filer per region.

---

### Historisk sammenligning (ukentlig / årssammenligning)
**Prioritet:** Lav / fremtidig
**Krever:** Backfill-data (2021–i dag)

- Ukesrapport: denne uken vs. forrige uke vs. samme uke i fjor
- Sesonganalyse: er bussene konsekvent senere om vinteren?
- Koronaeffekten: dramatisk nedgang i forsinkelser 2020–2021 (færre biler på veien)

---

### Eksport / API
**Prioritet:** Lav

- `GET /api/export/line/:lineref.csv` — last ned rådata for én linje
- Offentlig dokumentert API for journalister / forskere

---

## Indeksstrategi

**Eksisterende indekser:**
```sql
idx_line_daily_date, idx_line_daily_line_ref, idx_line_daily_vehicle_mode
idx_stop_daily_date, idx_stop_daily_stop_ref, idx_stop_daily_vehicle_mode
idx_line_hourly_raw_date
```

**Anbefalte tillegg ved implementering av `journey_stop_weekly`:**
```sql
CREATE INDEX idx_jsw_line_dir    ON journey_stop_weekly (line_ref, direction_ref);
CREATE INDEX idx_jsw_stop        ON journey_stop_weekly (stop_ref);
CREATE INDEX idx_jsw_week        ON journey_stop_weekly (week_start);
CREATE INDEX idx_jsw_journey     ON journey_stop_weekly (service_journey_id);
```

---

## Filstruktur

```
Bussforsinkelser/
├── pipeline/
│   ├── db_setup.py          Oppretter SQLite-skjema
│   ├── populate_stops.py    Henter NSR-koordinater (quays JOIN stop_places)
│   ├── ingest.py            Nightly BigQuery → SQLite (én dag av gangen)
│   ├── export_parquet.py    Ukentlig SQLite → Parquet (ZSTD)
│   ├── backfill.py          Masseimport av historiske data
│   ├── check_data.py        Manuelle DB-inspeksjoner og BigQuery-tester
│   └── requirements.txt
├── server/
│   ├── routes.ts            Express API-ruter
│   ├── storage.ts           Drizzle ORM-spørringer
│   └── index.ts
├── shared/
│   └── schema.ts            Drizzle-skjema (TypeScript-definisjon av DB)
├── client/src/
│   ├── pages/
│   │   ├── dashboard.tsx
│   │   ├── delay-map.tsx
│   │   ├── stop-analysis.tsx
│   │   ├── worst-lists.tsx
│   │   ├── journey-details.tsx
│   │   └── trip-planner.tsx
│   ├── lib/
│   │   ├── utils.ts         formatStopName og cn
│   │   ├── queryClient.ts
│   │   └── RegionContext.tsx
│   └── components/
│       └── layout.tsx       Navigasjon og sidestruktur
├── data/
│   ├── bussforsinkelser.db  SQLite-databasefil
│   └── stop_coords.json     NSR-koordinatcache
├── README.md
└── ARCHITECTURE.md          Dette dokumentet
```

---

## Kjente bugs og forbedringspunkter

Gjennomgang per 2026-03-16. Sortert etter alvorlighetsgrad.

### 🔴 Kritiske bugs (påvirker datakvalitet)

**1. ✅ FIKSET — `line_daily` PRIMARY KEY mangler `vehicle_mode`**
- PK endret til `(date, line_ref, direction_ref, vehicle_mode)` i `db_setup.py` og `schema.ts`
- **Krever re-opprettelse av DB** (dropp + `python pipeline/db_setup.py` + re-ingest)

**2. ✅ FIKSET — `daily_summary` mangler operator-kolonne**
- `operator TEXT NOT NULL DEFAULT 'SKY'` lagt til, PK endret til `(date, operator)`
- `ingest.py`, `storage.ts` og `routes.ts` oppdatert — alle summary-kall tar nå `operator`-parameter
- **Krever re-opprettelse av DB**

**3. ✅ FIKSET — `total_journeys`/`total_cancellations` feil**
- `total_journeys`: endret fra `len(df)` (alle modi + kansellerte) til `len(act)` (aktive busstopp-besøk)
- `total_cancellations`: endret til buss-only (`df[vehicleMode == 'bus']['is_cancelled'].sum()`)

**4. Søppeldata i stopp-leaderboard inntil re-ingest**
- `stop_name = "None"` (string) er skrevet til DB fra en tidligere bug (`str(None)`)
- `stop_daily` har fortsatt disse strengene for de 9 eksisterende dagene
- Fix: Re-ingest alle 9 dager med nåværende kode (+ kjør `populate_stops.py --refresh` først)

---

### 🟠 Funksjonelle mangler

**5. ✅ FIKSET — Linjevelger har ikke søkefunksjon og scroller dårlig**
- `<Select>` byttet ut med Combobox (Command + Popover) med søkefelt i `journey-details.tsx`
- Søker på linjenavn og lineRef, viser hakemerke på valgt linje

**6. Kartsenter hardkodet til Bergen**
- Fil: `client/src/pages/delay-map.tsx`
- `MAP_CENTER` er `[60.3913, 5.3221]` uavhengig av valgt region
- Konsekvens: Kartet viser Bergen når annen region er valgt, alle stopp-markører kan være utenfor skjermen
- Fix: Map-senteret og zoom-nivå bør styres av `region` fra `RegionContext`

**7. ✅ FIKSET — RegionContext lagres ikke på tvers av sideinnlastinger**
- `localStorage` lagt til i `RegionContext.tsx`: `setRegion` skriver til `bussforsinkelser_region`, initialisering leser fra localStorage med fallback til `vestland`

**8. ✅ DELVIS FIKSET — `null` vises som `0` i grafer**
- `journey-details.tsx`: `avgDelay: r.avgDelayMin` (uten `?? 0`) — Recharts viser hull der det ikke er data
- Gjenstår: `dashboard.tsx` og `stop-analysis.tsx` bruker fortsatt `?? 0`

**9. Ingen data-ferskhetindikator**
- Ingen side viser "Sist oppdatert: [dato]" eller advarer om at data mangler for de siste dagene
- Konsekvens: Brukeren vet ikke om dataene er fra i dag, i går eller en uke siden

**10. `/api/stops/map` synliggjør ikke hvilken dato som faktisk ble brukt**
- Fil: `server/routes.ts`
- API-et faller tilbake til nærmeste tilgjengelige dato, men svaret inkluderer ikke denne datoen
- Konsekvens: Klienten kan ikke vise "Viser data fra [dato]" til brukeren

---

### 🟡 Dødkode og teknisk gjeld

**11. ✅ FIKSET — `getLinesAtStop` er ødelagt og aldri i bruk**
- Slettet fra `server/storage.ts`

**12. ✅ FIKSET — `IStorage`-grensesnitt og `storage`-objekt er dødkode**
- Slettet fra `server/storage.ts`

**13. ✅ FIKSET — `leaderboard_stops`-tabellen er ikke lenger i bruk**
- Tabell fjernet fra `db_setup.py` og `shared/schema.ts`
- INSERT-blokk fjernet fra `refresh_leaderboards` i `ingest.py`
- `LeaderboardStop`-type fjernet fra schema-exports

**14. ✅ IKKE EN BUG — `backfill.py` leaderboard-rebuild**
- `refresh_leaderboards()` kalles allerede utenfor løkken, én gang til slutt

**15. ✅ FIKSET — `OPERATOR = "SKY"` hardkodet i ingest.py**
- Endret til `OPERATOR = os.environ.get("BQ_OPERATOR", "SKY")`
- `backfill.py` importerer `OPERATOR` fra `ingest.py` og plukker opp env-var automatisk

**16. ✅ FIKSET — `check_data.py` ryddet opp**
- Erstattet med strukturerte seksjoner og utkommenterte ad-hoc-queries

**17. Ingen loading/error-tilstander i `worst-lists.tsx`**
- Fil: `client/src/pages/worst-lists.tsx`
- Tabellene viser ingenting mens data lastes og ved API-feil
- Fix: Legg til skjelettlastere og feilmeldinger (pattern fra `stop-analysis.tsx`)

---

### 🔵 Fremtidige funksjoner (ikke implementert)

**18. Journey-profil-analyse**
- Velg linje → retning → avgang → se forsinkelse per stopp
- Krever `journey_stop_weekly`-tabell (se arkitekturforslag i README)
- Nye API-er: `GET /api/journeys/:lineref`, `GET /api/journey/:journeyid`

**19. Linjer per stoppested i stoppestedsanalysen**
- Hvilke linjer betjener dette stoppet, og hvor punktlige er de?
- Avhenger av journey-profil-data

**20. Multi-region støtte**
- Ruter, AtB, Skyss mfl. samtidig
- Avhenge av: felles DB med `operator`-kolonne i alle tabeller, eller separate DB-filer
- Merk: Ruter fyller inn `stopPointName` i SIRI ET; Skyss gjør ikke det

**21. Full historisk backfill**
- Vente til multi-region-strategi er avklart

**22. Persisting av tabellsortering og filtervalg**
- Brukeren mister valgt linje/stopp ved navigasjon

---

## Operatør-quirks

Operatørspesifikk oppførsel som påvirker parsing og datakvalitet. Må sjekkes for hver ny operatør som legges til.

### Skyss (SKY)

| Felt | Oppførsel |
|------|-----------|
| `vehicleMode` | **NULL for alle bussruter.** Skyss setter ikke vehicleMode for buss-avganger i SIRI ET. Kun ferje (og ev. andre modi) er eksplisitt merket. Pipeline bruker `fillna("bus")` — dette er riktig for SKY. |
| `stopPointName` | Alltid NULL. Stoppestedsnavn må hentes fra NSR-quay-tabellen i BigQuery via `populate_stops.py`. |
| `originName` / `destinationName` | NULL for de fleste avganger. Kan ikke brukes til å vise endepunkter. |
| `stopPointRef` | Bruker NSR:Quay:xxx for normale ruter. Noen eldre "ghost"-linjer (f.eks. 1200, 3260) bruker fremdeles gamle Rutebanken-numeriske ID-er (14xxxxxx). Disse filtreres ut av `stopPointRef LIKE 'NSR:%'`-sjekken i pipeline. |
| Ghost-linjer | Linjer som aldri ble migrert til NeTEx (trolig skolebuss-kontrakter). Kjennetegn: numeriske stopPointRef, alle navnefelt NULL, ca. 18–20 avganger/dag på hverdager. Filtreres automatisk. |

### Ruter (RUT) — ikke implementert ennå

| Felt | Forventet oppførsel |
|------|---------------------|
| `vehicleMode` | **Antas å settes eksplisitt** (buss, trikk, T-bane, ferje). Må verifiseres med BigQuery-spørring før `fillna`-logikk bestemmes. |
| `stopPointName` | Ruter fyller inn stoppestedsnavn direkte i SIRI ET. Kan brukes uten NSR-oppslag. |

> **Husk:** Sjekk alltid `vehicleMode`-fordeling med `check_data.py` før du legger til en ny operatør i pipelinen.
