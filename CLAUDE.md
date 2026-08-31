# Bussforsinkelser — Prosjektnotater for Claude

Denne filen lastes automatisk inn i kontekst ved oppstart. Hold den oppdatert.
Se også: `STATUS.md` (endringslogg, funksjonsstatus), `ARCHITECTURE.md` (detaljert skjema, sideinfo).

---

## Prosjektoversikt

Nettsted for historisk forsinkelsesstatistikk for bussruter i Norge.
**Stack**: React 19 + Recharts + Leaflet (frontend), Express 5 + better-sqlite3 + Drizzle ORM (backend), Python pipeline (BigQuery → SQLite).
**Routing**: wouter (ikke React Router).
**Styling**: Tailwind CSS 4 + shadcn/ui (Radix-basert).
**Datahenting**: React Query med `staleTime: Infinity`, `refetchOnWindowFocus: false`, `retry: false`.

---

## Filstruktur — komplett

```
client/src/
  pages/
    dashboard.tsx          /            Daglige nøkkeltall, trend, linje-leaderboard
    journey-details.tsx    /journey     Linjeanalyse: stat-kort, dagstrend, timesprofil, stopp-profil, reiseprofil
    stop-analysis.tsx      /stops       Stoppanalyse: søk, trend, timesprofil, linjer ved stopp
    worst-lists.tsx        /worst       Topplister: dager, stopp, pålitelighet
    delay-map.tsx          /map         Leaflet-kart med fargede stoppmarkører
    trip-planner.tsx       /reise       Reiseplanlegger: Entur JP v3, DuckDB-WASM persentiler (P50/P80/P95-avkryssing), reiseanalyse-popup m/ "Vis data"-historikk, plan-tre m/ forsinkelsesgrafer, metodeboks
    not-found.tsx          *            404-side
  components/
    layout.tsx             Sidebar, nav, regionvelger, NLOD-attribusjon
    data-quality-banner.tsx  Outlier/missing-time varsler
    scrollable-chart.tsx   Horisontal-scrollbar + draggable Y-akse for grafer
    delay-percentiles.tsx  DuckDB-WASM P50/P80/P95 persentilkort
    plan-delay-chart.tsx   Forsinkelse-langs-ruten-graf per plan-node (reiseplanlegger plan-tre)
    ui/                    shadcn/ui (60+ filer)
  lib/
    trip-shared.ts         Delte trip-typer + overgangs-gap-SQL (specific/fallback UNION), legStops(), probFromGaps()
    queryClient.ts         React Query config + apiRequest() wrapper
    RegionContext.tsx       Region/operator state (localStorage-persist)
    regionCoords.ts        Kartsentrum + zoom per region
    date-utils.ts          Norske datoformat (formatDateNO, lineNumber, etc.)
    utils.ts               cn() (tailwind merge), formatStopName()
    mockData.ts            Testdata for utvikling
  hooks/
    use-mobile.tsx         Media query (<768px)
    use-toast.ts           Toast-notifikasjoner
    use-duckdb.ts          Singleton DuckDB-WASM initialisering
    use-parquet-query.ts   Parquet manifest + registrering + SQL query-funksjon

server/
  index.ts         Express bootstrap, logging, error handler
  routes.ts        38+ API-endepunkter inkl. trip, geocoder, parquet (se STATUS.md)
  storage.ts       37 DB-funksjoner (Drizzle + raw better-sqlite3)
  vite.ts          Vite dev-server middleware (HMR via /vite-hmr)
  static.ts        Produksjons-serving av dist/public

shared/
  schema.ts        14 Drizzle ORM-tabelldefinisjoner

pipeline/          (Python)
  db_setup.py              Skjema-opprettelse (WAL mode)
  ingest.py                Daglig BQ → SQLite (alle upserts + profil/leaderboard rebuild)
  backfill.py              Historisk måned-for-måned ingest (importerer fra ingest.py)
  populate_stops.py        NSR quay-koord + stop_place_ref + platform_code fra BQ (kanonisk, alle operatører)
  populate_stop_places.py  Skyss GTFS stops.txt — kun NULL-felter (fallback for SKY-spesifikke gaps)
  populate_line_names.py   NeTEx XML (SKY) eller DB-derivert (andre) → line_name
  export_parquet.py        journey_stop_daily → ukentlige .parquet (ZSTD)
  check_data.py            Manuell BigQuery/SQLite-inspeksjon

data/
  bussforsinkelser.db    Hovedbase (SQLite, WAL mode)
  stop_coords.json       BQ-cache for populate_stops.py (30d auto-stale)
  diagnostics/           Per-dag realtime-coverage JSON
  parquet/               Ukentlige Parquet-filer (YYYY-WXX.parquet)

netex/sky/             NeTEx XML for Skyss (linjenavn)
gtfs-legacy/sky/       GTFS stops.txt (stopp-plattformer)
```

---

## Pipeline — kjørerekkefølge

### DB-recreate (full)
```powershell
del data\bussforsinkelser.db
python pipeline/db_setup.py
python pipeline/populate_stops.py                # leser fra cache (ingen BQ)
python pipeline/populate_stop_places.py          # leser GTFS → stop_place_ref/platform_code
# Eksplisitt liste av dager:
foreach ($d in @("2026-03-07","2026-03-08","2026-03-09")) {
    Write-Host "=== $d ===" -ForegroundColor Cyan
    python pipeline/ingest.py $d
}
python pipeline/populate_line_names.py --operator SKY --apply   # NeTEx-basert
python pipeline/populate_line_names.py --apply                  # DB-derivert for resten
```

### Ingest flere dager (datointervall)
```powershell
# Backfill et intervall (fra→til, inklusiv). Stopper ved første feil.
$from = [datetime]"2026-05-15"
$to   = [datetime]"2026-05-21"
for ($d = $from; $d -le $to; $d = $d.AddDays(1)) {
    $s = $d.ToString("yyyy-MM-dd")
    Write-Host "=== $s ===" -ForegroundColor Cyan
    python pipeline/ingest.py $s
    if ($LASTEXITCODE -ne 0) { Write-Host "FEIL på $s" -ForegroundColor Red; break }
}
```
For lange perioder (>2 uker), bruk heller `pipeline/backfill.py` som batcher mot BigQuery måned-for-måned (billigere BQ-scan).

### Daglig nightly-jobb
```powershell
python pipeline/ingest.py                # default: gårsdagens dato
python pipeline/export_parquet.py        # eksporter nye/ufullstendige uker
```

### Populering av stoppdata (sjelden)
```powershell
python pipeline/populate_stops.py --refresh      # BQ-kall, oppdater cache + DB
python pipeline/populate_stop_places.py          # GTFS → plattform-metadata
```

---

## Pipeline-skript detaljer

### `ingest.py`
**Kjøres daglig**. Henter én dag fra BigQuery, beregner forsinkelse, skriver til 8+ tabeller.

**Hovedfunksjoner**:
- `fetch_day(client, date)` — BQ-spørring for én dato
- `compute_delays(df)` — Beregner delay_min, delay_arrival_min, delay_departure_min, dwell_time_sec. Normaliserer vehicleMode (NULL→"bus"), filtrerer non-NSR stopp.
- `upsert_daily_summary()` — Buss-only daglig oversikt
- `upsert_line_daily()` — Per linje/retning/modus
- `upsert_stop_daily()` — Per stopp/retning/modus
- `upsert_line_hourly_raw()` / `upsert_stop_hourly_raw()` — Time-buckets
- `upsert_journey_stop_weekly()` — 13-ukers rullende, vektet snitt (ON CONFLICT merge)
- `upsert_journey_stop_daily()` — 90-dagers rullende, rå observasjoner
- `upsert_data_quality_log()` — Outliers (>±120 min), missing times
- `refresh_line_hourly_profile()` / `refresh_stop_hourly_profile()` — 30d rullende snitt
- `refresh_leaderboards()` — All-time leaderboard + worst 100 days
- `log_realtime_coverage()` — JSON til `data/diagnostics/`

**Env-variabler**: `BQ_TABLE`, `BQ_OPERATOR` (default "SKY"), `DATABASE_PATH`, `LOG_LEVEL`

### `populate_stops.py`
Henter fra BQ (`quays_last_version` × `stop_places_last_version`). Cache i `data/stop_coords.json` (30d).
Lagrer nå **6 felter** per quay: `stop_ref`, `stop_name`, `lat`, `lng`, `stop_place_ref`, `stop_place_name`.
`stop_place_ref` (NSR:StopPlace:X) hentes direkte fra BQ `q.stopPlaceRef` — dekker alle quays.
- Uten `--refresh`: leser kun cache → DB (ingen BQ-kall)
- Med `--refresh`: BQ → cache → DB
- **VIKTIG**: Etter kodeendring må `--refresh` kjøres én gang for å oppdatere cachen med nye felter.

### `populate_stop_places.py`
Skyss GTFS-fallback. Leser `gtfs-legacy/sky/stops.txt`.
**Kanonisk kilde er nå `populate_stops.py` (NSR via BQ)** — dette skriptet er valgfritt og
oppdaterer kun `stop_place_ref` / `platform_code` / `stop_place_name` der NSR-data
er NULL (bruker `COALESCE` slik at NSR-data aldri overskrives).
**Krever** at `populate_stops.py` har kjørt først.

### `populate_line_names.py`
To strategier:
- **SKY**: Parser NeTEx XML fra `netex/sky/`
- **Andre** (SOF, FIR, etc.): Deriverer fra `journey_stop_weekly` (vektet terminus)

Oppdaterer `line_name` i: `line_daily`, `line_hourly_raw`, `line_hourly_profile`, `leaderboard_lines`.

### `backfill_operator.py`
Etterfyller ÉN eller flere `dataSource`-koder over et datointervall, uten å røre
rader som allerede ligger der (`upsert_journey_stop_daily` er ren
INSERT … ON CONFLICT DO UPDATE — en flyrad og en bussrad kan ikke kollidere).

Bruk denne, ikke `ingest_lite.py <dato>` med `BQ_OPERATOR`, fordi den siste
avbryter på `MIN_EXPECTED_ROWS` (300 000; én dag fly er ~1 100 rader) og kjører
prune + VACUUM per dag (minutter hver gang på en 6 GB base).

```powershell
$env:DATABASE_PATH = "data/reise.db"
$env:PARQUET_DIR   = "data/reise-parquet"
$env:R2_ENV_FILE   = "r2.reise.env"

# 1. Sjekk først (henter, men skriver ikke):
python pipeline/backfill_operator.py --operator AVI --from 2026-07-31 --to 2026-08-13 --dry-run
# 2. Kjør:
python pipeline/backfill_operator.py --operator AVI --from 2026-07-31 --to 2026-08-13
# 3. Bygg ukefilene på nytt for BERØRTE uker, kjør aggregatene, og last opp:
python pipeline/export_parquet.py --week 2026-W32
python pipeline/aggregate_stats.py       # ELLERS blir Oversikt/Topplister uendret
python pipeline/upload_to_r2.py --prune
```

**⚠️ FELLE 2 — `aggregate_stats.py` MÅ kjøres på nytt.** Parquet driver
Linjeanalyse og kart (DuckDB leser filene direkte), men Oversikt, Topplister
OG Stoppanalyse leser ferdigaggregerte artefakter. Hopper du over steget,
dukker de etterfylte radene opp noen steder og ikke andre — og `upload_to_r2`
laster villig opp de GAMLE JSON-filene uten å klage.

`aggregate_stats.py` skriver (2026-08-27):
`stats_summary.json`, `stats_stops_map.json`, `stats_line_names.json` og
`stops/<shard>.json` — sistnevnte er Stoppanalysens datagrunnlag, 2000
shardfiler à ~180 KB. Uten dem faller Stoppanalyse tilbake til DuckDB i
nettleseren, som er korrekt men tar ~40 s kaldt (se STATUS.md 2026-08-27).
Shardnøkkelen er `crc32(stopPlaceRef) % 2000` og MÅ være identisk i
`pipeline/aggregate_stats.py` (`shard_of`) og `client/src/lib/stop-detail.ts`
(`shardOf`) — endrer du `STATS_STOP_SHARDS` må begge følge med, og gamle
shardfiler ryddes av `upload_to_r2.py --prune`.

**Kun ÉN parquet-familie leses.** `export_parquet` skriver hver uke to ganger
(`-by-line` og `-by-stop`, samme rader ulikt sortert). Et blankt `*.parquet`
leste alt dobbelt — dobbelt minne (OOM på 11 uker) og dobbel `COUNT(*)`.

**⚠️ FELLE i steg 3**: `export_parquet` nekter å overskrive en ukefil med en
versjon som dekker FÆRRE dager (vern mot datatap). Basen har bare 14 dagers
vindu, så for den ELDSTE uka i intervallet har den typisk 2–3 av ukas 7 dager,
og eksporten hopper stille over den uka («Exported 0 rows»). Da må de nye
radene FLETTES inn i den eksisterende fila i stedet — se STATUS.md 2026-08-14
for hvordan det ble gjort for W31 (les fila med pyarrow, `concat_tables` med de
nye radene, skriv tilbake med `write_sorted_family` fra `export_parquet`).

**Ikke etterfylt ennå: `BFO` og `TEL`** (to små fergekilder lagt til i
operatørlista 2026-08-14, virker bare framover). Samme oppskrift:
`--operator BFO,TEL --from ... --to ...`

### `export_parquet.py`
Eksporterer `journey_stop_daily` til `data/parquet/YYYY-WXX.parquet` (ZSTD).
- Uten args: eksporter alle nye + nåværende (ufullstendig) uke
- `--all`: re-eksporter alt
- `--week 2026-W15`: én spesifikk uke

### `backfill.py`
Måned-for-måned historisk import. Importerer alle funksjoner fra `ingest.py`.
**OBS**: Hver måned ≈ 1-5 GB BQ-scan. Maks 5-10 mnd per kalendermåned (free tier 1 TB/mnd).

---

## Day type (april 2026)

Hver ingest-dag får en `day_type` av `pipeline/day_type.py`:
- `may17` (17. mai — egen pga. parade og kraftig avvikende rutemønster)
- `holiday` (norsk helligdag, fra `holidays`-pakken)
- `sunday` / `saturday` / `weekday`

Prioritetsrekkefølge: may17 > holiday > sunday > saturday > weekday.

Lagres som kolonne på `journey_stop_daily`, `worst_days`, og som del av PK på `line_hourly_profile` + `stop_hourly_profile` (5x rader, men mer presise snitt). Profile-tabellene må re-bygges per day_type.

Backend filtrerer via `?dayType=weekday`, `?dayType=weekday,saturday`, eller `?dayType=all` (default = ingen filter) på `/api/line/:ref`, `/api/journey`, `/api/stop/:ref`, `/api/worst-days`. `getJourneyProfile()` faller tilbake til `journey_stop_daily` når filter er satt (siden `journey_stop_weekly` ikke har day_type). Frontend bruker det ikke ennå.

## Multimodal (oppdatert 2026-08-09 mot faktiske data)

`INCLUDED_MODES = {bus, coach, tram, metro, rail, water}` (definert både i `pipeline/ingest.py` og `server/storage.ts`). Bus-only-filtre er fjernet fra alle aggregeringer. `client/src/components/mode-icon.tsx` har `<ModeIcon>` og `MODES_WITH_DELAY_DATA`.

**Vi henter ALLE operatører, ikke bare Skyss.** Målt på R2 for uke 31–32 2026:
23 operatør-prefikser, der RUT (5,0 mill. rader) er større enn SKY (1,9 mill.).
Så ikke bruk Skyss som utgangspunkt når du beskriver datagrunnlaget.

Faktisk `vehicle_mode`-fordeling samme periode:

| mode | rader | linjer |
|---|---|---|
| `bus` | 14 422 117 | 1445 |
| `rail` | 150 793 | 34 |
| `ferry` | 98 741 | 141 |
| `tram` | 14 940 | 1 |

Altså: **tog, båt og trikk HAR observasjoner** — påstanden om at de «er
forberedt men har ingen rader ennå» var feil og ble gjentatt i flere dokumenter.

**Navnefelle — `ferry` vs `water`**: SIRI ET-feeden (og dermed vår parquet)
bruker `ferry`, mens Entur Journey Planner returnerer `water` for de samme
båtrutene. Sammenlikner du Entur-legg mot vår `MODES_WITH_DELAY_DATA` må
BEGGE med, ellers ser båt ut som «ingen data» selv om dataene finnes.

**`coach`**: finnes ikke som egen verdi i dataene våre (ekspressbusser ligger
under `bus`), men Entur bruker `coach` i reiseforslag. `mode-icon.tsx` merker
den «Flybuss» — misvisende, `coach` er ekspress-/langdistansebuss generelt.

**Fly (`AVI`) — lagt til 2026-08-14.** Avinors sanntidsdata har ligget i samme
SIRI ET-feed hele tiden, men `AVI` manglet i `_ALL_OPERATORS` og ble derfor
kastet. Målt 2026-08-11: 1 134 rader, 511 avganger, 46 flyplasser, alle på
`NSR:`-quays; 623 rader med både planlagt og faktisk avgang (resten er
naturlig — startflyplassen har ingen ankomst, endeflyplassen ingen avgang).

To ting å vite:
- `vehicleMode` er ALLTID NULL for AVI. Fly settes derfor eksplisitt fra
  `dataSource == "AVI"` FØR den generelle `fillna("bus")`. En generell
  fillna til fly ville stemplet >1 mill. bussrader per dag som fly — RUT og
  SKY lar også feltet stå tomt for buss.
- Mode-verdien er `air` (`AIR_MODE` i `ingest.py`) — samme verdi som SIRI og
  Entur Journey Planner bruker. Bevisst valg: da slipper vi et alias-par til
  ved siden av `ferry`/`water`.

I motsetning til Skyss er avgangs-IDen STABIL over dager: siste ledd av
`AVI:ServiceJourney:DX568-03-1284178164` var uendret for alle kontrollerte
avganger 9.–11. august, så `stableSjId()` virker og per-avgang-historikk
(«hvor ofte er akkurat mitt fly forsinket?») er mulig.

`vehicleMode = NULL` → `fillna("bus")` i `compute_delays()` (`ingest.py`, som
`ingest_lite.py` gjenbruker). Det gjelder generelt, ikke bare Skyss.

---

## Datakilde og operatør-quirks

### BigQuery-tabell
`ent-data-sharing-ext-prd.realtime_siri_et.realtime_siri_et_last_recorded`

**BQ-kolonner** (bekreftet i bruk):
- `serviceJourneyId` — stabil NeTEx-ID per rutet avgang
- `sequenceNr` — stopperekkefølge langs ruten
- `stopPointRef` — `NSR:Quay:12345`
- `lineRef` — `SKY:Line:6` (operatørkode embedded)
- `dataSource` — `SKY`, `SOF`, `FIR`, etc.
- `vehicleMode`, `aimedDepartureTime`, `departureTime`, `aimedArrivalTime`, `arrivalTime`
- `journeyCancellation`, `dayOfTheWeek`, `operatingDate`, `directionRef`

### Skyss (SKY) quirks
- **`serviceJourneyId` er IKKE stabil over dager.** Formatet er
  `SKY:ServiceJourney:{linje}-{datasettversjon}-{avgang}`, og det MIDTERSTE
  leddet endres nesten daglig når ruteplanen republiseres. Samme 10:00-avgang
  på linje 20 hadde 23 ulike id-er på 35 dager; 38,9 % av alle id-er finnes på
  kun én dato. **Skal du matche "samme faktiske avgang" på tvers av dager, bruk
  SISTE ledd** (`stableSjId()` i `lib/trip-shared.ts`) — det bytter kun ved ekte
  ruteendring. Å matche på hele id-en gir ~1 dag og feiler stille. Se STATUS.md
  2026-07-23 for hvordan dette gjorde all overgangsstatistikk pool-basert.
- `vehicleMode = NULL` → buss (`fillna("bus")`). Dette er GENERELL kode, ikke
  Skyss-spesifikt. Se «Multimodal» over for faktisk mode-fordeling — påstanden
  om at «kun ferge er eksplisitt tagget» stemte ikke: også `rail` og `tram`
  kommer tagget.
- `stopPointName` alltid NULL → navn fra `stop_coords` via BQ + GTFS
- Ghost-linjer (1200, 3260) har numeriske Rutebanken-IDs → filtreres av `NSR:`-sjekken
- Dwell time filtrert: [0, 600] sek (rejects negative + >10min)

### Operatør-kolonne strategi
| Tabeller | Strategi |
|---|---|
| `line_daily`, `line_hourly_*`, `leaderboard_lines`, `journey_stop_weekly/daily` | Operator embedded i `line_ref` prefix (`SKY:`, `SOF:`) |
| `stop_daily`, `stop_hourly_*`, `worst_days`, `daily_summary` | Egen `operator`-kolonne i PK |

---

## Database (SQLite)

### Tabellformål

| Tabell | PK | Historikk | Brukes til |
|---|---|---|---|
| `daily_summary` | (date, operator) | Ubegrenset | Dashboard-kort, trend |
| `line_daily` | (date, line_ref, direction_ref, vehicle_mode) | Ubegrenset | Linje-leaderboard, linjeanalyse |
| `stop_daily` | (date, stop_ref, direction_ref, vehicle_mode, operator) | Ubegrenset | Stopp-leaderboard, dagsvis trend |
| `line_hourly_raw` | (date, line_ref, direction_ref, hour) | Ubegrenset | Mellomdata for profil |
| `line_hourly_profile` | (line_ref, direction_ref, hour) | 30d rullende | Timesgraf linjeanalyse |
| `stop_hourly_raw` | (date, stop_ref, hour, direction_ref, operator) | Ubegrenset | Mellomdata for profil |
| `stop_hourly_profile` | (stop_ref, hour, direction_ref, operator) | 30d rullende | Timesgraf stoppanalyse |
| `journey_stop_weekly` | (week_start, service_journey_id, stop_ref) | 13 uker | Reiseprofil, verste stopp, linjer per stopp, trip stats |
| `journey_stop_daily` | (date, service_journey_id, stop_ref) | 90 dager | Parquet-eksport, persentiler, scatter-plots |
| `leaderboard_lines` | (line_ref) | Materialisert | All-time toppliste |
| `worst_days` | (date, operator) | Materialisert | Topp 100 verste dager |
| `stop_coords` | (stop_ref) | Manuelt | Kart, stoppenavn, `stop_place_ref` for Entur API |
| `data_quality_log` | (id auto) | Per ingest | Outlier-varsler |

### Forskjell: `stop_daily` vs `journey_stop_weekly` vs `journey_stop_daily`

- **`stop_daily`**: Alle linjer samlet, ubegrenset historikk → stopp-leaderboard, dagsvis trend
- **`journey_stop_weekly`**: Per-avgang granularitet + linjeinfo, 13 uker → reiseprofil, linjer ved stopp, trip delay overlay
- **`journey_stop_daily`**: Rå uaggregert, 90 dager → Parquet-eksport → DuckDB-WASM persentiler

### SQLite-begrensning
SQLite støtter **ikke** `ALTER TABLE` for å endre PK. Endring krever full DB-recreate.

---

## Entur Journey Planner API v3

- **Endepunkt**: `https://api.entur.io/journey-planner/v3/graphql`
- **Header**: `ET-Client-Name: emiliemoldestad-sentur` (PÅKREVD av Entur)
- **Lisens**: NLOD 2.0 — attribusjon i sidebar (`layout.tsx`)
- **Rate limit**: ~30 trip-requests/min (uregistrert). Server-cache 5 min TTL, max 200 entries.
- **Input**: `Location!` — enten `{ place: "NSR:StopPlace:X" }` eller `{ coordinates: { latitude, longitude }, name: "..." }`
- **Output**: `line.id` = `SKY:Line:6` (matcher line_ref), `quay.id` = `NSR:Quay:X` (matcher stop_ref)
- **`mode: "foot"`**: Gangavstander mellom stopp ved overgang — har `line: null`
- **`accessMode`/`egressMode`**: MÅ settes eksplisitt (default: `foot`) når `modes`-blokken brukes — ellers feiler koordinat-baserte søk
- **GraphQL Explorer**: `https://api.entur.io/graphql-explorer/journey-planner-v3`

### Entur Geocoder API
- **Endepunkt**: `GET https://api.entur.io/geocoder/v1/autocomplete?text=...&size=8&lang=no`
- **Returnerer**: Stoppesteder (`layer: "venue"`, ID = `NSR:StopPlace:X`) OG adresser (`layer: "address"`, med koordinater)
- **Proxy**: `GET /api/geocoder/autocomplete?text=...&size=8` (server-side, med ET-Client-Name header)

### Trip-query parametre (bekreftet via introspection 2026-04-12)

**Hovedparametre**:
| Parameter | Type | Beskrivelse |
|---|---|---|
| `from`, `to` | `Location!` | `{ place: "NSR:StopPlace:X" }` |
| `dateTime` | `DateTime` | ISO datetime for avgang/ankomst |
| `arriveBy` | `Boolean` | `true` = ankomst-tid, `false` = avgangs-tid (default) |
| `numTripPatterns` | `Int` | Antall reiseforslag (default 5) |
| `searchWindow` | `Int` | Søkevindu i **minutter** (maks 2880 = 48t). Utelat → dynamisk beregning (anbefalt for store områder). Krev høy `numTripPatterns` for korrekt dynamisk beregning. |

**Modes-objekt**:
```graphql
modes: {
  accessMode: StreetMode    # Til første holdeplass (foot, bicycle, car_park, ...)
  egressMode: StreetMode    # Fra siste holdeplass
  directMode: StreetMode    # Direkte uten kollektiv (null = deaktivér)
  transportModes: [{ transportMode: TransportMode }]
}
```

**TransportMode enum**: `bus`, `tram`, `rail`, `metro`, `water`, `coach`, `air`, `cableway`, `funicular`, `lift`, `trolleybus`, `monorail`
**StreetMode enum**: `foot`, `bicycle`, `bike_park`, `bike_rental`, `scooter_rental`, `car`, `car_park`, `car_pickup`, `car_rental`, `carpool`, `flexible`

**Ganghastighet og overgang**:
| Parameter | Type | Beskrivelse |
|---|---|---|
| `walkSpeed` | `Float` | m/s (default ~1.33 = 4.8 km/h) |
| `walkReluctance` | `Float` | Motvilje mot gange (høyere = unngå) |
| `transferSlack` | `Int` | Ekstra sekunder buffer ved overgang (default 120) |
| `transferPenalty` | `Int` | Kostnad per overgang (styrer antall overganger) |
| `maximumTransfers` | `Int` | Maks antall overganger |
| `wheelchairAccessible` | `Boolean` | Universell utforming |

**Forsinkelsesdata-begrensning**: Vi har kun delay-statistikk for **buss** (Skyss). Trikk, T-bane, tog, båt har ingen data i vår DB. UI-et må markere legs der vi mangler data.

### Kjente Bergen-stoppesteder (for testing)
> ⚠️ NSR StopPlace-IDer slås jevnlig sammen/reassignes. Tabellen under er
> verifisert via Entur geocoder 2026-07-26. De GAMLE IDene i denne tabellen
> (30848/30867/30272/30946/58366) er STALE — 58366 resolver nå til «Oslo S»,
> og 30272/30946 gir langdistanse-/båtruter, ikke Bergen. Slå alltid opp
> ferske IDer via `/api/geocoder/autocomplete?text=...` før testing.

| StopPlace | Navn | Merknad |
|---|---|---|
| `NSR:StopPlace:59849` | Lagunen terminal | Sør for sentrum, populært knutepunkt |
| `NSR:StopPlace:31024` | Åsane terminal | Nord for sentrum |
| `NSR:StopPlace:62356` | Bergen busstasjon | Hovedknutepunkt |

### Test-query (for GraphQL Explorer)
```graphql
query testTrip {
  trip(
    from: { place: "NSR:StopPlace:30848" }
    to: { place: "NSR:StopPlace:30272" }
    modes: { transportModes: [{ transportMode: bus }] }
    numTripPatterns: 3
  ) {
    tripPatterns {
      expectedStartTime expectedEndTime duration
      legs {
        mode
        fromPlace { name quay { id name } }
        toPlace { name quay { id name } }
        line { id publicCode name }
        expectedStartTime expectedEndTime
        intermediateQuays { id name }
        serviceJourney { id }
      }
    }
  }
}
```

### Bekreftet output-format (testet 2026-04-12)
- `line.id` = `SKY:Line:16E`, `SKY:Line:600` ✅ matcher `line_ref`
- `quay.id` = `NSR:Quay:53106` ✅ matcher `stop_ref`
- `serviceJourney.id` = `SKY:ServiceJourney:16E-198134-19357808` ✅
- `mode: "foot"` for gangavstander, `line: null` ✅

---

## Teknisk arkitektur — DuckDB-WASM + Parquet (implementert)

**Formål**: Klient-side persentil-beregning (P50/P80/P95) og scatter-plots uten server-roundtrip.

**Dataflyt**:
```
ingest.py → journey_stop_daily (SQLite 90d)
    → export_parquet.py → data/parquet/YYYY-WXX-by-line.parquet + YYYY-WXX-by-stop.parquet (ZSTD)
        → upload_to_r2.py → Cloudflare R2 (via custom-domenet parquet.sentur.no)
            → DuckDB-WASM i nettleser (~6MB, jsDelivr CDN)
                → PERCENTILE_CONT queries via delays_by_line / delays_by_stop views
```

> **Hver uke skrives som TO filer** (samme rader, ulik fysisk sortering — se
> `pipeline/export_parquet.py`). Det finnes ikke lenger noen generisk
> `delays`-view; SQL må referere `delays_by_line` (line_ref-filtre) eller
> `delays_by_stop` (stop_ref-filtre) via `useParquetQuery().query(sql, params, { family: "by-line"|"by-stop" })`.
> Se STATUS.md 2026-07-20 for hvorfor og hvor mye det betyr for ytelsen.
>
> **⚠️ Deploy-rekkefølge ved endring av Parquet-filnavnformat**: `reise`-
> branchen har automatisk deploy til Cloudflare på push (ingen synlig GitHub
> Actions-workflow — sannsynligvis en Cloudflare-side git-integrasjon).
> Frontend-koden hopper STILLE over filnavn i manifestet den ikke kjenner
> igjen (`parseFileName()` i `use-parquet-query.ts` returnerer `null`), så
> hvis filnavnformatet endres, MÅ R2 oppdateres (`python
> pipeline/upload_to_r2.py --prune` med `R2_ENV_FILE=r2.reise.env`) FØR
> koden pushes — ikke etter. Motsatt rekkefølge gir total nedetid for
> reise-siten (alle DuckDB-avhengige sider) helt til R2 følger etter. Skjedde
> faktisk 2026-07-20, se STATUS.md.

**Klient-filer**:
- `hooks/use-duckdb.ts` — Singleton DuckDB-WASM initialisering (EH bundle fra jsDelivr), 20s init-timeout
- `hooks/use-parquet-query.ts` — Henter manifest, registrerer begge filfamilier, eksponerer `query(sql, params?, { family, fromDate?, toDate? })` og `standaloneDuckQuery()` (samme, brukt utenfor React av `stats-adapter.ts`). Fil-registrering har automatisk retry med backoff (`registerFilesWithRetry`) — se deploy-varselet over for hvorfor det finnes.
- `components/delay-percentiles.tsx` — `<DelayPercentiles lineRef="SKY:Line:6" stopRef?="..." />`
- `pages/trip-planner.tsx` — `useTripDelayDistribution()` hook henter P50/P80/P95 per (line, stop) par

**Server-endepunkter (kun full-bygget, ikke reise)**:
- `GET /api/parquet/manifest` — JSON-array av tilgjengelige ukefiler
- `GET /api/parquet/:file` — Statisk serving med Accept-Ranges (for DuckDB HTTP range requests)
- Reise-bygget henter i stedet direkte fra R2 via `VITE_PARQUET_BASE_URL`.

> **⚠️ Bruk ALLTID custom-domenet `https://parquet.sentur.no` — aldri bøttas
> `https://pub-<id>.r2.dev`.** Hele `.r2.dev`-domenet er svartelistet av en
> del sikkerhets-DNS fordi det misbrukes til malware-hosting. Målt 2026-08-27
> på UiO-nett: `pub-…r2.dev` resolver via CNAME til `cert-rpz01.uio.no`
> (UiO CERT sin RPZ-sinkhole) og TCP-oppkoblingen feiler — altså *før* trafikken
> når Cloudflare. Symptomet er `HTTP 000` / «connection refused» på ALLE
> R2-kall, mens resten av internett virker, så det ser lett ut som en
> Cloudflare-nedetid. Custom-domenet er upåvirket og støtter range requests
> (verifisert: `206 Partial Content`, `Accept-Ranges: bytes`).
> Se STATUS.md 2026-08-27.

**Bruk i komponenter**:
- `<DelayPercentiles lineRef="SKY:Line:6" />` — viser P50/P80/P95 kort
- Trip planner: `useTripDelayDistribution()` henter persentiler for alle (line_ref, stop_ref) par i trip. Brukes til:
  - Empirisk overgangs-sannsynlighet (`transferProbabilityFromDist()` — interpolerer mellom P50/P80/P95)
  - Estimert avgangs-/ankomsttid (median-basert, vist i oransje)
  - P80-punktlighets-badge per leg
  - Observasjonstall for transparens

**SQL-mønster**: Queries kjøres mot `delays_by_line` eller `delays_by_stop` — velg familie ut fra spørringens primære `WHERE`-kolonne (line_ref → by-line, stop_ref → by-stop). Full-scan-spørringer (topplister, kart) kan bruke hvilken som helst.

### ⚠️ Kostnadsmodell — les denne før du legger til en DuckDB-spørring

Målt 2026-08-08 (dev mot R2, `by-stop`-ukefiler på 35–71 MB):

| Måling | Tid |
|---|---|
| Første spørring etter sidelast (leser footere for 8 ukefiler) | 45,7 s |
| Samme spørring varm | ~5 s |
| `SELECT COUNT(*)` over 53,9 mill. rader | 1,7 s |
| Ett enkelt `stop_ref` | 1,3 s |
| 38 ulike `stop_ref` i én spørring | 23 s |

Tre konsekvenser som styrer design:

1. **Kostnaden er tilnærmet lineær i antall ulike `stop_ref`**, ikke i antall
   rader. Hvert stopp krever egne HTTP range-kall mot hver ukefil. Spør derfor
   kun om stoppene brukeren faktisk ser (jf. `duckPairs` i `trip-planner.tsx`,
   som henter mellomstopp bare for UTVIDEDE kort).
2. **Det er ett worker-tråd og én spørring om gangen.** Flere spørringer i kø
   sulter hverandre — en `SELECT 1` ble målt liggende >17 s bak en kø på 12
   overgangs-spørringer. Rekkefølgen betyr noe: det brukeren ser på skjermen
   må kjøre først. Ikke fyr av spørringer for alt «i bakgrunnen» uten å tenke
   på hva som da må vente.
3. **Ikke blokker rendering på en DuckDB-spørring.** Vis det du har (f.eks.
   Entur-svaret) og la statistikken fylles inn etterpå.

**Avkreftet som årsak** (ikke prøv på nytt uten nye målinger): manglende row
group-pruning — å legge `stop_ref IN (...)` foran OR-kjeden endret ingenting
(23,8 s vs 25,1 s) — og DuckDBs `enable_object_cache` (5,0 s vs 4,9–5,2 s).

**Kjent, uløst**: full statistikk i reiseplanleggeren bruker ~30 s (varm) til
~83 s (kald sidelast). Trolig ikke løsbart med flere frontend-triks; se
NOTES.md-punktet om forhåndsaggregerte persentiler.

**npm-pakke**: `@duckdb/duckdb-wasm@1.33.1-dev42.0`
**Python-avhengigheter**: `pip install pyarrow duckdb boto3` (for export_parquet.py / migrate_parquet_sort.py / upload_to_r2.py)
**Status**: Implementert, inkl. R2-opplasting (reise-bygget bruker denne i produksjon; lokal serving fra `data/parquet/` er kun for full-bygget/dev).

**Oppstart (lokal, full-bygget)**:
```powershell
python pipeline/export_parquet.py --all   # genererer -by-line.parquet + -by-stop.parquet per uke
# Server serverer automatisk fra data/parquet/
```

**Opplasting til R2 (reise-bygget)** — se deploy-rekkefølge-varselet over:
```powershell
$env:R2_ENV_FILE = "r2.reise.env"
python pipeline/upload_to_r2.py --prune
```

---

## Env-variabler

| Variabel | Brukes av | Default |
|---|---|---|
| `DATABASE_PATH` | Alle Python-skript + Drizzle | `data/bussforsinkelser.db` |
| `BQ_TABLE` | ingest, backfill, check_data | `ent-data-sharing-ext-prd.realtime_siri_et.realtime_siri_et_last_recorded` |
| `BQ_OPERATOR` | ingest, backfill, check_data | `SKY` |
| `LOG_LEVEL` | ingest, backfill, export_parquet | `INFO` |
| `PARQUET_DIR` | export_parquet | `data/parquet/` |
| `PORT` | server/index.ts | `5000` |

---

## Frontend-patterns

### API-kall
Alle via React Query med queryKey = URL-string. `apiRequest(method, url, data)` wrapper i `queryClient.ts`.
POST-endepunkter bruker `useMutation`.

### Debouncing
Stoppsøk: 300ms debounce via `useEffect + setTimeout` pattern.
```tsx
useEffect(() => {
  const t = setTimeout(() => setDebouncedQuery(query), 300);
  return () => clearTimeout(t);
}, [query]);
```

### Region/operator
`useRegion()` hook → `{ region, operator }`. `operator` = `REGION_OPERATOR[region]` (SKY, RUT, etc.).
Persisteres i `localStorage("bussforsinkelser_region")`.

### NSR:StopPlace vs NSR:Quay
- **Entur API**: Tar NSR:StopPlace som input, returnerer NSR:Quay i output
- **Vår DB**: `stop_coords` har `stop_ref` (Quay) + `stop_place_ref` (StopPlace)
- **Stoppsøk**: `searchStops()` grupperer per StopPlace, returnerer quay-detaljer
- **corridor-search**: Returnerer `stopPlaceRef` for Entur API-bruk
- **Andre funksjoner** (getStopStats, etc.): Håndterer begge via `isStopPlace`-sjekk → subquery
