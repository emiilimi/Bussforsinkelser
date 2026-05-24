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
    trip-planner.tsx       /reise       Reiseplanlegger: Entur JP v3, DuckDB-WASM persentiler, overgangsanalyse, metodeboks
    not-found.tsx          *            404-side
  components/
    layout.tsx             Sidebar, nav, regionvelger, NLOD-attribusjon
    data-quality-banner.tsx  Outlier/missing-time varsler
    scrollable-chart.tsx   Horisontal-scrollbar + draggable Y-akse for grafer
    delay-percentiles.tsx  DuckDB-WASM P50/P80/P95 persentilkort
    ui/                    shadcn/ui (60+ filer)
  lib/
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

## Multimodal (april 2026)

`INCLUDED_MODES = {bus, coach, tram, metro, rail, water}` (definert både i `pipeline/ingest.py` og `server/storage.ts`). Bus-only-filtre er fjernet fra alle aggregeringer. `client/src/components/mode-icon.tsx` har `<ModeIcon>`-komponent og `MODES_WITH_DELAY_DATA = {bus, coach}` — Skyss SIRI ET feed dekker buss + flybuss; tram/metro/rail/water er forberedt men har ingen rader ennå.

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
- `vehicleMode = NULL` → buss. Koden bruker `fillna("bus")`. Kun ferge er eksplisitt tagget.
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
- **Header**: `ET-Client-Name: emiliemoldestad-bussprosjekt` (PÅKREVD av Entur)
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
| StopPlace | Navn | Merknad |
|---|---|---|
| `NSR:StopPlace:30848` | Småstrandgaten | Sentrum (IKKE Festplassen!) |
| `NSR:StopPlace:30867` | Nygård | (IKKE Byparken!) |
| `NSR:StopPlace:30272` | Lagunen terminal | Sør for sentrum, populært knutepunkt |
| `NSR:StopPlace:30946` | Åsane terminal | Nord for sentrum |
| `NSR:StopPlace:58366` | Bergen busstasjon | Hovedknutepunkt |

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
    → export_parquet.py → data/parquet/YYYY-WXX.parquet (ZSTD)
        → Server: GET /api/parquet/{file} (Accept-Ranges for HTTP range requests)
            → DuckDB-WASM i nettleser (~6MB, jsDelivr CDN)
                → PERCENTILE_CONT queries via `delays` view (union av alle uker)
```

**Klient-filer**:
- `hooks/use-duckdb.ts` — Singleton DuckDB-WASM initialisering (EH bundle fra jsDelivr)
- `hooks/use-parquet-query.ts` — Henter manifest, registrerer Parquet-filer, eksponerer `query(sql)`
- `components/delay-percentiles.tsx` — `<DelayPercentiles lineRef="SKY:Line:6" stopRef?="..." />`
- `pages/trip-planner.tsx` — `useTripDelayDistribution()` hook henter P50/P80/P95 per (line, stop) par

**Server-endepunkter**:
- `GET /api/parquet/manifest` — JSON-array av tilgjengelige ukefiler
- `GET /api/parquet/:file` — Statisk serving med Accept-Ranges (for DuckDB HTTP range requests)

**Bruk i komponenter**:
- `<DelayPercentiles lineRef="SKY:Line:6" />` — viser P50/P80/P95 kort
- Trip planner: `useTripDelayDistribution()` henter persentiler for alle (line_ref, stop_ref) par i trip. Brukes til:
  - Empirisk overgangs-sannsynlighet (`transferProbabilityFromDist()` — interpolerer mellom P50/P80/P95)
  - Estimert avgangs-/ankomsttid (median-basert, vist i oransje)
  - P80-punktlighets-badge per leg
  - Observasjonstall for transparens

**SQL-mønster**: Queries kjøres mot `delays`-view som er union av alle registrerte Parquet-filer.

**npm-pakke**: `@duckdb/duckdb-wasm@1.33.1-dev42.0`
**Python-avhengigheter**: `pip install pyarrow` (for export_parquet.py)
**Status**: Implementert. Krever `python pipeline/export_parquet.py --all` for å generere Parquet-filer. R2-opplasting ikke satt opp (bruker lokal serving).

**Oppstart**:
```powershell
python pipeline/export_parquet.py --all   # generer Parquet-filer fra journey_stop_daily
# Server serverer automatisk fra data/parquet/
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
