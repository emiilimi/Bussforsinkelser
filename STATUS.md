# Bussforsinkelser — Statusoversikt

> **Hensikt**: Én levende kilde for prosjektets status, datakilder, API, kjente svakheter og endringslogg.
> Oppdateres for hver meningsfull endring. Hierarkisk strukturert per komponent slik at man enkelt kan se historikken til en gitt bit.

**Sist oppdatert**: 2026-05-06

## Endringslogg — 2026-05-06: Bugrensing — multi-operator-overgang + diverse opprydding

**Iterasjon A — kritiske funksjonsbugs**:
- `server/storage.ts` `getStopStats` / `getStopHourlyProfile` / `getStopDirections`: tar nå `operators: string[]` med dynamisk `IN (...)` i stedet for enkelt-`operator = "SKY"`. Stoppanalyse viser nå data ved "Alle regioner" og multi-region (ble før 404).
- `server/storage.ts` `getAllLines`: tar `operators[]` og bruker `operatorsLineFilter` for OR-prefix-LIKE. Linjepicker i journey-details + stop-analysis fungerer for "Alle" og kombinasjoner som SKY+RUT.
- `server/routes.ts` `/api/best-days`: tar nå `?dayType=` i symmetri med `/api/worst-days`. Ny `dayTypeDateFilter()` bruker SQLite strftime for `weekday/saturday/sunday/may17` (holiday krever day_type-kolonne på dailySummary, ikke støttet).
- `client/src/pages/dashboard.tsx`: URL-konstruksjon med `?` vs `&` (tidligere fix), DataQualityBanner får `operators[0]`.
- `client/src/pages/journey-details.tsx` + `stop-analysis.tsx`: bruker `operators[]` fra useRegion, sender `opStr` riktig formatert.

**Iterasjon B — robusthet**:
- `client/src/pages/worst-lists.tsx`: URL-konstruksjon refaktorert til `join()`-helper i stedet for `&`-prefix-streng — robust mot framtidige endepunkter.
- `pipeline/populate_stop_places.py`: `UPDATE` bruker nå `COALESCE(eksisterende, ny)` slik at NSR-data fra `populate_stops.py` ikke overskrives. NSR (BQ) er kanonisk; GTFS-fila fyller bare NULL-felter. Docstring + CLAUDE.md oppdatert.
- `server/routes.ts` trip cache-key: `?? null` på alle valgfrie felter i `filterFingerprint` slik at `undefined` ikke kolliderer med `null`.
- `pipeline/ingest.py:87`: stale `journey_stop_weekly`-kommentar oppdatert.

**Iterasjon C — opprydding**:
- `client/src/pages/trip-planner.tsx`: useEffect synkroniserer `sprintSpeedKmh` opp når `walkSpeedKmh` overstiger den. `transferProbabilityFromDist` returnerer nå 0.97 ved p50=p80=p95=0 (perfekt punktlighet) i stedet for 0.10.
- `client/src/pages/delay-map.tsx`: error overlay vises ved nettverksfeil mot `/api/stops/map`.
- `client/src/lib/utils.ts`: ny `RechartsTooltipProps<T>`-type. Fire navngitte tooltip-funksjoner (DailyTrendTooltip + HourlyTooltip på journey-details og stop-analysis) er typet i stedet for `any`.
- `server/routes.ts`: ny `parseIntQuery(raw, fallback)`-helper validerer `Number()`-resultat. Erstattet usikre `Number(req.query.X) || N` på fem steder (limit, hourMin/Max, windowDays, size).

**Bonus-fiks — linjer-per-stopp på plattform-løse stopp**:
- `client/src/hooks/use-journey-queries.ts` `useLinesAtStop` kalte `/api/stops/lookup?expand=stopplace`, men endepunktet støttet ikke `expand`-parameteren. Resultat: stopp med en `NSR:StopPlace`-ref men uten plattformbokstav (ikke terminaler) viste tom linjeliste.
- Ny `getStopsByRefsExpanded()` i `server/storage.ts`: splitter refs etter prefix og kjører to spørringer (`WHERE stop_ref IN (...)` for quays + `WHERE stop_place_ref IN (...)` for stop places). `/api/stops/lookup?expand=stopplace` aktiverer dette.

## Endringslogg — 2026-05-05: Multi-regionvelger + modus-filter + stop place-berikelse

**Regionvelger (multi-select)**:
- `client/src/lib/RegionContext.tsx`: endret fra enkelt `region: Region` til `regions: Region[]` + `operators: string[]`. Tom array = "Alle regioner". localStorage migreres automatisk fra gammelt streng-format.
- `client/src/components/layout.tsx`: `<Select>` erstattet med `<Popover>` + checkboxer. Knapp viser "Alle regioner", enkelt navn, eller "X +N" for flervalg. Alle 11 operatører tilgjengelige.

**Dashboard-fix (global stats bug)**:
- `client/src/pages/dashboard.tsx`: `queryKey` for `/api/summary` og `/api/summary/trend` mangler operator. Nå inkludert via `opParam`. Alle brukere ser korrekt regionfiltrert data.

**Kart-fix (viste kun Skyss)**:
- `client/src/pages/delay-map.tsx`: sender nå `operator=SKY,RUT,...` eller ingenting (alle) til `/api/stops/map`.

**Backend — multi-operator + modus**:
- `server/routes.ts`: ny `parseOperators()` (kommaseparert → `string[]`) og `parseMode()` helper. Alle summary-, kart- og leaderboard-endepunkter bruker dem.
- `server/storage.ts`: `getDailySummary/Range/Latest` bruker `inArray` + ny `aggregateSummaryRows()` (vektet avg på tvers av operatører). `getStopsForMap/Filtered`, `getLeaderboardLines/Stops/ByReliability/Period`, `getWorstDays`, `getBestDays` — alle støtter nå `operators: string[]` + `mode`-parameter.

**Topplister — modus-filter + språk**:
- `client/src/pages/worst-lists.tsx`: Tabs "Alle / Buss / Trikk / T-bane / Båt" for stopp- og linjeleaderboard. "Verste dager" → "Mest forsinkede dager", "Beste dager" → "Mest punktlige dager", tilsvarende for stopp.

**Favicon + domene**:
- `client/index.html`: fjernet alle `bussforsinkelser.no`-referanser og Replit OG-tags. Tittel: "Bussforsinkelser".
- `client/public/favicon.svg`: ny blå buss-favicon (SVG, laget fra scratch). Erstatter Replit-favicon.png.

**Stop place-berikelse (alle operatører)**:
- `pipeline/populate_stops.py`: BQ-spørringen henter nå også `q.publicCode AS platform_code`. Cache-format endret fra 6-tuple til 7-tuple med bakover-kompatibilitet. Alle operatørers quays får nå `platform_code` fra NSR direkte — uten å være avhengig av Skyss GTFS-fila.
- `populate_stop_places.py` kjøres fortsatt som valgfri Skyss-override, men er ikke lenger nødvendig for `stop_place_ref` eller `platform_code` hos andre operatører.
- Kjør: `del data\stop_coords.json && python pipeline/populate_stops.py --refresh` for å ta i bruk ny 7-kolonne-cache.

**Stoppsøk — Jernbanetorget-dedup**:
- `server/storage.ts` `searchStops()`: `GROUP BY` endret fra `COALESCE(stop_place_ref, stop_ref)` til `COALESCE(stop_place_name, stop_name)`. Store knutepunkter (f.eks. Jernbanetorget) med 7 distinkte `NSR:StopPlace`-IDer men samme navn kollapser nå til én søketreff. `MIN(stopRef)` velger én representativ stop-place ref.

## Endringslogg — 2026-05-03: DuckDB-WASM full migrering + R2 + stripped prod-DB

**Arkitektur**:
- `journey_stop_daily` fjernet fra prod-DB. Tabellen lever kun lokalt for Parquet-eksport og pipeline.
- 11 storage-funksjoner + server-endepunkter mot `journey_stop_daily` er fjernet fra server.
- Klienten kjører nå alle per-avgang-per-stopp queries direkte i DuckDB-WASM mot Parquet på R2.
- Ny arkitektur: Railway har kun aggregert DB (uten `journey_stop_daily`), R2 har Parquet-filer.

**Pipeline**:
- `pipeline/strip_for_prod.py` (ny): kopierer full DB, dropper `journey_stop_daily`, kjører VACUUM → liten Railway-DB.
- `pipeline/export_parquet.py`: bug-fiks — arrays-lista manglet `vehicle_mode` og `day_type` (kolonne 11 og 12), krasjet med "Schema and number of arrays unequal". Fikset.
- `pipeline/upload_to_r2.py` (ny): boto3-basert opplasting av Parquet-filer + `manifest.json` + `bussforsinkelser_prod.db` til Cloudflare R2. Skipper uendrede filer via ETag-sammenligning.

**Infrastruktur**:
- Cloudflare R2 bucket `bussforsinkelser-parquet` med public access og CORS for range requests.
- `scripts/download-db.mjs` (ny): Node.js startup-script som laster ned prod-DB fra R2 ved Railway-oppstart. Bruker `DB_DOWNLOAD_URL` + `DATABASE_PATH` env-variabler. Exits 0 hvis URL ikke satt.
- Railway start-kommando: `node scripts/download-db.mjs && npm start`
- Railway env-vars: `DB_DOWNLOAD_URL`, `DATABASE_PATH`, `VITE_PARQUET_BASE_URL`

**Klient**:
- `client/src/hooks/use-journey-queries.ts` (ny): 11 DuckDB-hooks som speiler de fjernede server-funksjonene. Stop-navn berikkes via `useStopLookup` → `/api/stops/lookup`.
- `client/src/pages/journey-details.tsx`: 7 React Query-kall byttet fra `/api/...` til DuckDB-hooks.
- `client/src/pages/stop-analysis.tsx`: `useLinesAtStop` + `useLineHourlyAtStop` erstatter server-kall.
- `client/src/pages/trip-planner.tsx`: `/api/trip/stats` POST erstattet med inline `duckQuery` i mutasjon. Wrapped i try/catch for graceful degradation (trip vises selv om DuckDB feiler).
- `server/routes.ts` + `server/storage.ts`: 11 endepunkter + funksjoner fjernet. Ny `GET /api/stops/lookup?refs=...` lagt til for stop-navn batch-oppslag.

**Topplister — stopp σ-kolonne**:
- `server/storage.ts` `getLeaderboardStops()`: `stddevDelayMin` lagt til i select (vektet snitt).
- `worst-lists.tsx`: `LeaderboardStop` type + σ-kolonne i både verste og beste stopp-tabell.

**Layout**:
- Entur-logo i sidebar: økt fra `h-4` til `h-10` (2.5x større).

**Brukeransvar for full oppsett**:
```powershell
python pipeline/export_parquet.py --all
python pipeline/upload_to_r2.py
python pipeline/strip_for_prod.py
# Sett DB_DOWNLOAD_URL, DATABASE_PATH, VITE_PARQUET_BASE_URL på Railway
# Start-kommando på Railway: node scripts/download-db.mjs && npm start
```

## Endringslogg — 2026-04-30: Multimodal + day_type-filter (backend)

**Pipeline + DB**:
- `pipeline/db_setup.py`: `vehicle_mode` lagt til på 7 tabeller (PK på `daily_summary`, `line_hourly_raw`, `line_hourly_profile`, `stop_hourly_raw`, `stop_hourly_profile`, `worst_days`; kolonne på `journey_stop_weekly`/`journey_stop_daily`/`leaderboard_lines`).
- `day_type` lagt til (i PK på `line_hourly_profile` + `stop_hourly_profile`; som kolonne på `journey_stop_daily`, `worst_days`, samt raw-tabellene som hjelpekolonne for profile-rebuild).
- Indekser `idx_jsd_day_type` + `idx_jsd_line_day_type` på `journey_stop_daily`.
- Ny modul `pipeline/day_type.py` — `compute_day_type(date) → 'weekday'|'saturday'|'sunday'|'holiday'|'may17'`. Bruker `holidays>=0.50` (lagt til i `requirements.txt`). Prioritetsrekkefølge: may17 > holiday > sunday > saturday > weekday.
- `pipeline/ingest.py` + `pipeline/backfill.py`: `INCLUDED_MODES = {bus, coach, tram, metro, rail, water}` brukt på tvers av alle upserts; bus-only-filtre fjernet; `compute_day_type` kalt én gang per ingest-dag og pushet ned til upsert-funksjonene.

**Backend**:
- `server/storage.ts`: `INCLUDED_MODES` + `INCLUDED_MODES_SQL` + `parseModes()` + `parseDayTypes()` hjelpere. 9 query-locations bruker nå `inArray(vehicleMode, INCLUDED_MODES)` / `vehicle_mode IN (...)`. Day_type-filter (`?dayType=weekday[,saturday]` eller `all`) på `getLineHourlyProfile`, `getStopHourlyProfile`, `getJourneyProfile` (faller tilbake til `journey_stop_daily` når filter er aktivt), `getWorstDays`.
- `server/routes.ts`: `?dayType=` parses på `/api/line/:lineref`, `/api/journey`, `/api/stop/:stopref`, `/api/worst-days`.

**Frontend**:
- `client/src/components/mode-icon.tsx` (ny) — `<ModeIcon mode>` + `MODES_WITH_DELAY_DATA = {bus, coach}`. Ennå ikke wired inn på sidene (krever at API-responser eksponerer `vehicleMode` — defererert).
- `trip-planner.tsx`: `MODES_WITH_DELAY_DATA` utvidet fra `["bus"]` til `["bus", "coach"]`.

**Brukeransvar**: `pip install -r pipeline/requirements.txt` + DB-recreate (slett `data/bussforsinkelser.db`, kjør `db_setup.py` + `populate_stops.py` + `populate_stop_places.py` + ingest siste 10 dager + `populate_line_names.py` + `export_parquet.py --all`).

## Endringslogg — 2026-04-30: Reisesjekk — tre overgangssannsynligheter

`client/src/pages/trip-planner.tsx`:
- Hver transit→[gange]→transit-overgang vises nå med tre separate sannsynligheter:
  - **Med 2 min margin** (gangtid + 2 min) — headline i kortlista
  - **Med brukervalgt margin** (ny slider «Overgangsmargin», 0–15 min, default 5)
  - **Spurt** — gangtid skalert med walkSpeed/sprintSpeed + 30 sek margin (ny slider «Spurt-tempo»; default = vanlig ganghastighet)
- Bug-fiks: tidligere logikk regnet ikke gangtid med i bufferet (foot-leg mellom transit ble hoppet over). Ny formel: `effektiv buffer = totalGap − walkTime − margin`, fed inn i `transferProbabilityFromDist`.
- Headline-prosenten i forslagslista bruker 2-min-scenariet. Ekspandert kort viser alle tre per overgang.

---

## 1. Funksjonsstatus

| Side / Komponent | Sti | Status | Notat |
|---|---|---|---|
| Dashboard | `/` | ✅ Live | Daglige nøkkeltall, trend, linje-leaderboard |
| Linjeanalyse | `/journey` | ✅ Live | Stat-kort, dagstrend, timesprofil, stopp-profil med 3 modi, reiseprofil, beste/verste avganger |
| Stoppanalyse | `/stops` | ✅ Live | Stop-stats, timesprofil, linjer ved stopp |
| Topplister | `/worst` | ✅ Live | Verste/beste dager + stopp + pålitelighet (linjer) |
| Forsinkelseskart | `/map` | ✅ Live | Geo-kart med filter |
| Reiseplanlegger | `/reise` | 🟡 Beta | Entur JP v3 + Geocoder + DuckDB-WASM. Adressesøk, multi-modal, filtre, empirisk delay overlay, overgangsanalyse, P80-badge, estimert tid, metodeboks |
| `journey_stop_daily` pipeline | — | ✅ Live | 1.2M rader. Tabell + ingest + 90d vindu. |
| Parquet-eksport | — | ✅ Live | `export_parquet.py` — 2 uker generert (1.2M rader). Krever `--all` for første gang. |
| DuckDB-WASM | klient | ✅ Live | P50/P80/P95 persentiler. Brukes i `<DelayPercentiles>` og trip planner (overgangsanalyse, estimert tid). |
| Entur Geocoder | server | ✅ Live | `/api/geocoder/autocomplete` — stoppesteder + adresser |

**Status-koder**: ✅ Live  ·  🟡 Delvis  ·  🐛 Bug  ·  📋 Planlagt  ·  ⚠️ Tekn.gjeld

---

## 2. API-katalog

### Sammendrag (`/api/summary*`)
| Endpoint | Storage-fn | Frontend | Notat |
|---|---|---|---|
| `GET /api/summary` | `getDailySummary` / `getLatestSummary` | dashboard | Siste dag eller `?date=` |
| `GET /api/summary/trend` | `getDailySummaryRange` | dashboard | 30-dagers trend |

### Linjer (`/api/lines*`, `/api/line/:ref*`)
| Endpoint | Storage-fn | Frontend | Notat |
|---|---|---|---|
| `GET /api/lines` | `getAllLines` | dashboard | Lines med data siste 30d |
| `GET /api/lines/all` | `getAllLines` | journey-details | Alle bus-linjer (operator-filter) |
| `GET /api/line/:ref` | `getLineStats` + `getLineHourlyProfile` | journey-details | Daily + hourly |
| `GET /api/line/:ref/journeys` | `getJourneysForLine` | journey-details | Velgbare avganger |
| `GET /api/line/:ref/stops` | `getWorstStopsForLine` | journey-details | Topp 5 verste stopp |
| `GET /api/line/:ref/worst-journeys` | `getWorstJourneysForLine` | journey-details | Top N verste enkeltavganger |
| `GET /api/line/:ref/best-journeys` | `getBestJourneysForLine` | journey-details | Top N beste enkeltavganger |
| `GET /api/line/:ref/route-variants` | `getRouteVariants` | journey-details | Linjer med >1 variant (linje 99 = 62) |
| `GET /api/line/:ref/stop-profile` | `getLineStopProfile` | journey-details | Stopp-for-stopp langs ruten |
| `GET /api/journey` | `getJourneyProfile` | journey-details | Reiseprofil for én avgang |

### Stopp (`/api/stop*`, `/api/stops*`)
| Endpoint | Storage-fn | Frontend | Notat |
|---|---|---|---|
| `GET /api/stop/:ref` | `getStopStats` + `getStopHourlyProfile` | stop-analysis | |
| `GET /api/stop/:ref/directions` | `getStopDirections` | stop-analysis | Tilgjengelige retninger |
| `GET /api/stop/:ref/lines` | `getLinesAtStop` | stop-analysis | Linjer som passerer |
| `GET /api/stop/:ref/lines/hourly` | `getLineHourlyAtStop` | stop-analysis | Heat-map data |
| `GET /api/stops/search` | `searchStops` | flere | Typeahead |
| `GET /api/stops/map` | `getStopsForMap` / `getStopsForMapFiltered` | delay-map | Geo + filter |
| `GET /api/stops/corridor-search` | `searchStopsForCorridor` | trip-planner | Returnerer StopPlace-gruppert, med `stopPlaceRef` |

### Topplister (`/api/leaderboard*`, `/api/worst-days`, `/api/best-days`)
| Endpoint | Storage-fn | Frontend | Notat |
|---|---|---|---|
| `GET /api/leaderboard/lines?type=worst\|best` | `getLeaderboardLines/Period` | worst-lists, dashboard | Sortert på snitt forsinkelse |
| `GET /api/leaderboard/lines?type=reliable\|unreliable` | `getLeaderboardLinesByReliability` | worst-lists | Sortert på stddev, min 500 avg. |
| `GET /api/leaderboard/stops?type=worst\|best` | `getLeaderboardStops` | worst-lists | |
| `GET /api/worst-days` | `getWorstDays` | worst-lists | |
| `GET /api/best-days` | `getBestDays` | worst-lists | |

### Reiseplanlegger (`/api/trip*`)
| Endpoint | Storage-fn | Frontend | Notat |
|---|---|---|---|
| `POST /api/trip` | — (Entur proxy) | trip-planner | Cachet 5 min, `ET-Client-Name: emiliemoldestad-bussprosjekt` |
| `POST /api/trip/stats` | `getTripStopStats` | trip-planner | Delay overlay per (stopRef, lineRef) fra `journey_stop_weekly` |

### Korridor & datakvalitet
| Endpoint | Storage-fn | Frontend | Notat |
|---|---|---|---|
| `POST /api/corridor` | `getCorridorComparison` | (planlagt /reise) | Multi-linje sammenligning |
| `GET /api/data-quality` | `getDataQuality` | data-quality-banner | Outliers, missing-time |

---

## 3. Datakilder

| Kilde | Type | Bruk | Oppdatering |
|---|---|---|---|
| `ent-data-sharing-ext-prd.realtime_siri_et.realtime_siri_et_last_recorded` | BigQuery | Sanntids ankomst/avgang fra Skyss SIRI ET | Daglig ingest |
| `netex/sky/` | NeTEx XML | Linjenavn (operatør=SKY) | Manuelt nedlastet, sjelden |
| `gtfs-legacy/sky/` | GTFS | Stopp-navn fallback | Sjelden |
| NSR via BQ | API | GPS-koordinater for stoppesteder | `populate_stops.py --refresh` |
| Entur Journey Planner v3 | GraphQL API | Reiseforslag for `/reise` | Sanntid, cachet 5 min server-side |

**Entur API-vilkår**: NLOD 2.0-lisens. `ET-Client-Name: emiliemoldestad-bussprosjekt`. ~30 req/min rate limit for trip-queries. Attribusjon lagt til i sidebar.

**Operatør-info**: `dataSource = "SKY"` filtrerer Skyss. Ghost-linjer (gamle Rutebanken-stopp) filtreres bort av `NSR:`-sjekken. `vehicleMode = NULL` betyr buss for Skyss (kun ferge er eksplisitt tagget).

---

## 4. Database-skjema (oversikt)

| Tabell | PK | Formål | Historikk |
|---|---|---|---|
| `daily_summary` | (date, operator) | Daglig oversikt for kort/trend | Ubegrenset |
| `line_daily` | (date, line_ref, direction_ref) | Per linje per dag per retning | Ubegrenset |
| `line_hourly_raw` | (date, line_ref, direction_ref, hour) | Time-bucket per dag | Ubegrenset |
| `line_hourly_profile` | (line_ref, direction_ref, hour) | 30-dagers rullende snitt | Roller |
| `stop_daily` | (date, stop_ref, operator) | Per stopp per dag | Ubegrenset |
| `stop_hourly_raw` | (date, stop_ref, hour, operator) | Time-bucket per dag | Ubegrenset |
| `stop_hourly_profile` | (stop_ref, hour, operator) | 30-dagers rullende snitt | Roller |
| `journey_stop_weekly` | (week_start, line_ref, direction_ref, service_journey_id, stop_ref) | Per avgang per stopp per uke | 13 uker |
| `journey_stop_daily` | (date, service_journey_id, stop_ref) | Rå per-avgang per-stopp per-dag | 90 dager |
| `leaderboard_lines` | (line_ref) | All-time linjerangering | Materialisert |
| `worst_days` | (date) | Topp 100 verste dager | Materialisert |
| `stop_coords` | (stop_ref) | GPS-koordinater | Manuelt refresh |
| `data_quality_log` | (id auto) | Outliers, missing-time | Per ingest |

Detaljert kolonnebeskrivelse: se `shared/schema.ts`.

---

## 5. Mappestruktur

```
client/src/
  pages/         dashboard, journey-details, stop-analysis, worst-lists, delay-map, trip-planner
  components/    layout (med NLOD-attribusjon), ui/, charts, data-quality-banner, delay-percentiles
  lib/           utils, date-utils
  hooks/         useRegion, useDuckDB, useParquetQuery

server/
  index.ts       Express bootstrap
  routes.ts      Alle API-endepunkter
  storage.ts     Alle DB-spørringer (Drizzle + raw sqlite)
  vite.ts        Dev-mode integrering

shared/
  schema.ts      Drizzle ORM-definisjoner

pipeline/        (Python)
  db_setup.py            Skjema-opprettelse
  ingest.py              Daglig BQ → SQLite
  populate_stops.py      NSR coords → stop_coords
  populate_stop_places.py
  populate_line_names.py NeTEx XML eller DB-derived
  backfill.py            Historisk ingest
  export_parquet.py      Ukentlig SQLite → Parquet (ZSTD)
  check_data.py          Sanity-sjekker

netex/sky/       NeTEx XML for Skyss
gtfs-legacy/sky/ Gammel GTFS (stopp-navn fallback)
data/
  bussforsinkelser.db    Hovedbase
  stop_coords.json       Cache for populate_stops.py
  diagnostics/           Logging-output
```

---

## 6. Audit 2026-04-21 — Omfattende gjennomgang

> Systematisk gjennomgang av alle sider + brukerønsker. Ingen kodeendringer gjort ennå.
> Brukerens liste: (1) Entur-logo, (2) tidsvindu/rush overalt, (3) toppliste-sortering + stddev, (4) stddev i flere sider, (5) scrollable y-akse bug, (6) avgangsanalyse visning, (7) labels, (7b) reiseplanlegger endestopp, (8) gangtid/overgang, (9) Plan B/avansert analyse.

### 6.1 Brukerens liste — funn per punkt

| # | Brukerpunkt | Funn | Kompleksitet | Avklaring trengs |
|---|---|---|---|---|
| 1 | Entur-logo "ikke riktig" | `layout.tsx:80` rendrer kun `<text>entur</text>` i systemfont — ikke offisiell logo. NLOD-attribusjon er korrekt. | Lav (last ned SVG fra brand.entur.no eller be bruker om fil) | Hvilken form vil du ha (SVG inline, PNG, fra CDN)? |
| 2 | Tidsvindu + rush på alle sider | `/map` har begge. `/journey` har nå tidsvindu (lagt inn i dag). `/stops` har tidsvindu (7/30/90/365) men *ingen rush-filter*. `/worst` har *ingen av delene*. Dashboard har kun periode-tabs (uke/mnd/år). | Middels | OK at vi bruker samme 4 alternativer (7/14/30/90 d) overalt? Dashboard har egne tabs i dag. |
| 2b | Rush-filter på `/stops` og `/worst` | Mulig: `stop_hourly_profile` og `line_hourly_profile` har per-time data. For `/worst` må vi aggregere `line_hourly_raw`/`stop_hourly_raw` i en ny storage-fn. | Middels–høy | Skal "Siste uke + rush" kombineres, eller enten/eller? |
| 3 | Toppliste — sortering på kanselleringer/punktlighet/stddev | `worst-lists.tsx`: Dager har sort delay/kanselleringer ✓. Stopp har delay/pct>2m. Pålitelighet (linjer) har *ingen sort-UI* (alltid etter stddev). `leaderboard_lines` har `pctOnTime`, `stddevDelayMin` — kan enkelt legges til. Kanselleringer pr linje: **finnes ikke i DB** (`line_daily` har ikke `num_cancellations`). | Middels. Kanselleringer pr linje krever ingest-endring. | Vil du ha kanselleringer pr linje? Det krever pipeline-endring + full DB-recreate. |
| 3b | Forbedre toppliste-siden | Savner: filtre (tidsvindu, region/operatør er allerede via sidebar, men ikke trådet til `/leaderboard/lines?type=reliable` — **bug**, linje mixes på tvers av operatør), delay distribution graf (nevnt i seksjon 6). Asymmetri: `getWorstDays()` bruker materialisert tabell, `getBestDays()` live daily_summary — kan gi ulik dekning. | — | — |
| 4 | Stddev i linje/stopp-analyse | Linjeanalyse har *"Pålitelighet (σ)"* kort ✓. Stoppanalyse mangler. `stop_daily` har `stddevDelayMin` allerede (schema.ts). | Lav | — |
| 5 | Scrollable y-akse "henger igjen" ved modus-bytte | **Bekreftet**: `journey-details.tsx:470-512`. `stopProfileDataMax` beregnes alltid fra `avgDelayMin`, men modi bruker ulike felter: `cumulative`→avgDelayMin (min), `derivative`→delayGain (min, kan være negativ), `dwell`→dwellTimeSec (sekunder!). Y-akse blir feil når man bytter. Ekstra: i dwell-modus er `setYMax={() => {}}` (no-op) — brukeren kan ikke dra. | Lav (beregn dataMax per modus) | — |
| 6 | Avgangsanalyse viser "enkelt avgang" selv om label sier snitt | **Usikker**. `getJourneyProfile` (storage.ts:485-529) velger én `bestJourney` (mest data) og aggregerer over ALLE uker for den SJID-en (`SUM(avg_delay * num_samples) / SUM(num_samples)`). Det ER snitt — men kun over én `service_journey_id`, ikke alle varianter med samme klokkeslett. Med stale DB (kun 2 uker) blir `num_samples` lavt → ser ut som én observasjon. | — | Har du et konkret eksempel (linje + klokkeslett) der du ser dette? Mulig det er a) stale data, b) forvirrende label "snitt av X avganger". |
| 7 | "Målinger totalt" uklart | **Bekreftet ambiguøst**: `journey-details.tsx:884` "X stopp · Y målinger totalt" — Y = SUM av `num_samples` over stoppene, dvs. stoppbesøk, ikke avganger. Også `ProfileTooltip` linje 139 "målinger" uklart. Begrepet "observasjoner av stoppbesøk" ville vært klarere. | Lav | Foretrekker du "stoppbesøk", "observasjoner", eller "avganger × stopp"? |
| 7b | Reiseplanlegger: endestopp mangler avgangstid | `trip-planner.tsx:673-686` har allerede fallback `pt.departure ?? pt.arrival`. Men hvis *både* `departure` og `arrival` mangler for et intermediate stop, eller hvis `passingTimes` ikke inkluderer endestoppet i det hele tatt, faller den tilbake til `leg.expectedEndTime`. Må bekreftes om dette faktisk fungerer for endestopp — skjema-introspection i Entur viste at endestopp ofte bare har `arrival`. | Lav–middels | Har du et konkret reise-eksempel? Da kan jeg sjekke passingTimes-svaret. |
| 8 | Gangtid/overgangstid-logikk | `transferAnalysis` (trip-planner.tsx:459-476): `bufferMin = totalAvailMin - walkMinutes`. Hardkodete terskler (0.50, 0.80, 0.97) interpolerer mot P50/P80/P95. **Ingen forklaring i UI**. Terskler er ikke konfigurerbare. `transferSlack` (Entur-input) påvirker *bare* ruteplanleggingen, ikke sannsynligheten. | Middels | Vil du vise selve utregningen (bufferMin, walkTime, P50/P80/P95) i UI, eller bare dokumentere den? |
| 9 | Plan B / rekursjon / avansert analyse | Ingen scaffolding finnes — kun nevnt i TODO. "Avanserte filtre" (linje 1095) viser transport-modi/gange/maks overganger, ikke råtall. | Høy | OK at vi starter med en "avansert-panel" som viser råtall før vi bygger Plan B-rekursjonen? |

### 6.2 Tilsvarende forbedringspunkter / bugs funnet under gjennomgangen

| Sted | Funn | Severity |
|---|---|---|
| `worst-lists.tsx:47` | `/api/leaderboard/lines?type=reliable` sender *ikke* `operator`-param → pålitelighet-topplisten mikser regioner på tvers av sidebar-valg. | 🐛 Bug |
| `storage.ts:1007-1025` | `getWorstDays` (materialisert) vs `getBestDays` (live fra daily_summary) — inkonsistens kan gi "beste dag" fra ufullstendig dekningsperiode. | ⚠️ Design-smell |
| `journey-details.tsx:1069-1070` | Dwell-modus: `setYMax={() => {}}` (no-op) → brukeren kan ikke justere y-aksen. | 🐛 Bug |
| `journey-details.tsx` (nytt) | Time-window bruker både `days=` (lineStats) og `weeks=ceil(days/7)` (journey_stop_weekly-endepunkter). Fungerer, men asymmetrisk API-flate. | ⚠️ API-smell |
| `stop-analysis.tsx:212` | Sender `direction=all` når "begge" er valgt, selv om serveren håndterer det. Ren støy i URL/cache-key. | ⚠️ Støy |
| `dashboard.tsx:60-62` | `/api/summary/trend` har hardkodet 7/30/365 via period-tabs, men leaderboard under bruker `period=`-param. Inkonsistent mental modell. | ⚠️ UX |
| `trip-planner.tsx` | Ingen "show raw data" / calculation breakdown-panel. P80-badge viser bare tallet, ikke hvor det kommer fra. | 📋 Manglende feature |
| **Databasefriskhet** | Inneholder nå 18 april - 6. mai med alle tilgjengelige operatører.


`ingest.py` selv er oppdatert — **ikke drift mellom schema.ts, db_setup.py, ingest.py**. Problemet er bare at pipeline ikke har kjørt. | 🛈 Operasjonelt |
| `routes.ts` (fiks gjort i dag) | Default `weeks=4` på alle journey_stop_weekly-endepunkter → tom respons når data >28 d gammel. Endret til default 13. | ✅ Fikset 2026-04-21 |
| **Schema-gap** | `line_daily` har *ikke* `num_cancellations` (bare `daily_summary` og `worst_days` har det). Kan ikke sortere linjer på kanselleringer uten pipeline-endring. | 🛈 Info |
| **Schema-gap** | `stop_daily` har `stddevDelayMin` allerede — UI bruker det bare ikke ennå. | 📋 Kvikk-fiks |

### 6.3 Scope/prioritering — forslag til rekkefølge

1. **Kvikk-fikser (lav risiko, høy verdi)**: Y-akse-bug (punkt 5), operator-param på reliability-leaderboard, dwell-modus no-op setter, sortering på reliability-toppliste (pct/stddev).
2. **Tidsvindu overalt**: `/stops`, `/worst`, og vurdere om dashboard skal ha samme 4-opsjon (eller beholde uke/mnd/år).
3. **Entur-logo**: Last ned offisiell SVG fra brand.entur.no.
4. **Stddev på stoppanalyse** (DB har feltet).
5. **Label-klargjøring** ("målinger" → "observasjoner av stoppbesøk" eller tilsvarende).
6. **Rush-filter på /stops og /worst** (krever ny storage-fn for `/worst`).
7. **Reiseplanlegger — endestopp-timing** (krever konkret reise-eksempel å feilsøke mot).
8. **Avansert analyse-panel i reiseplanlegger** (råtall + utregning).
9. **Kanselleringer per linje** (pipeline-endring + full DB-recreate).
10. **Plan B-rekursjon**.

---

## 7. Kjente svakheter / forbedringspunkter

### UX-uklarheter ("hva betyr egentlig dette tallet?")
| Sted | Problem | Fiks-status |
|---|---|---|
| Verste/beste enkeltavganger | "Målinger" var SUM over alle stopp = misforståelig | ✅ Fikset → `observedDepartures` (MAX per stopp) |
| Rutevariant-velger (dropdown) | Viser "X målinger" som er samme sumeringsproblem | ⚠️ Til audit |
| "Verste stopp på linje" | Aggregeres over alle retninger uten at det er tydelig | ⚠️ Til audit |
| Direction picker | To uavhengige velgere på linjeanalyse — uklart for bruker hva hver styrer | ⚠️ Til audit |

### Tekniske svakheter
| Sted | Problem | Prio |
|---|---|---|
| `getWorstJourneysForLine`/`getBestJourneysForLine` | 3 korrelerte subqueries per rad (departureTime, firstStopName, lastStopName) | Medium — vurdere window-funksjon eller én join |
| `stop-analysis.tsx` søk | Manglet debounce — fyrte request per tastetrykk | ✅ Fikset 2026-04-12 — 300ms debounce |
| `populate_stops.py --refresh` | Henter fra BQ uten cache-bruk hvis cache eksisterer | Lav — fungerer men ikke ideelt |
| `vehicleMode = NULL → "bus"` | Hardkodet fallback for Skyss; bryter om annen operatør har samme NULL-mønster | Dokumentert i CLAUDE.md |
| SQLite kan ikke ALTER PK | Hver PK-endring krever full DB-recreate | Strukturell, ikke fiksbar i SQLite |
| Statistikk-tidsvindu i trip planner | UI for tidsvindu-filter finnes, men DuckDB-query filtrerer ennå ikke på valgt vindu | Medium — SQL WHERE-clause trenger dato/ukedag-filter |
| Plan B for tapte bytter | Hvis overgang < 90%: nytt søk fra byttestopp 1 min etter tapt buss. P80 i reisevisning bør inkorporere sannsynlighet for å miste bytte. | Høy — se TODO |

### Planlagte endringer

#### Reiseplanlegger (stegvis)
1. ✅ **`journey_stop_daily`** — rå pipeline-tabell (SQLite 90d) — live, 1.2M rader
2. ✅ **Parquet-eksport** — ukentlig ZSTD Parquet (~300KB/uke SKY). Lokal serving (R2 ikke satt opp)
3. ✅ **DuckDB-WASM** — klient-side SQL over Parquet (~6MB WASM, jsDelivr CDN)
4. ✅ **/reise frontend** — Entur JP v3, Geocoder, filtre, multi-modal, delay overlay
5. ✅ **Persentiler** — P50/P80/P95 per (line, stop) via DuckDB. Tidsvindu-UI finnes, men SQL-filter ikke koblet ennå
6. ✅ **Transfer-sannsynlighet** — empirisk fra DuckDB P50/P80/P95 med interpolering + heuristisk fallback
7. 📋 **Historisk enkeltreise** — oppslag på spesifikk dato + avgang
8. 📋 **Scatter-plot** i stoppanalyse — tid på dag vs forsinkelse, farge = linje
9. 📋 **PWA** — offline-støtte via cached Parquet

#### Andre forbedringer
- **Delay distribution graph** på Topplister
- **Stopp-plattform-sammenslåing** (NSR:Quay → NSR:StopPlace) for leaderboard og søk

---

## 8. Endringslogg (hierarkisk per komponent)

> Format: `| Dato | Endring | Filer | Begrunnelse |`
> Hver endring i kode/skjema skal legges inn under riktig seksjon.

### Database

#### Skjema
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-22 | `num_cancellations` på `line_daily`, `total_cancellations` på `leaderboard_lines` (**krever DB-recreate**) | `db_setup.py`, `schema.ts`, `ingest.py` | Kanselleringer per linje for toppliste-sortering |
| 2026-04-04 | Lagt til `aimed_arrival_time`, `aimed_departure_time`, `avg_delay_arrival_min`, `avg_delay_departure_min`, `avg_dwell_time_sec` på `journey_stop_weekly` | `db_setup.py`, `schema.ts`, `ingest.py` | Muliggjør derivat-graf, stopptid, transfer-analyse |
| 2026-03-30 | `stddev_delay_min` på `line_daily`, `stop_daily`, `leaderboard_lines` | `db_setup.py`, `schema.ts` | Variance/pålitelighet |
| 2026-03-30 | `pct_realtime_coverage` på `line_daily` | `db_setup.py`, `ingest.py` | GPS-dekning per dag |

### Pipeline (`pipeline/`)

#### `ingest.py`
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-12 | `upsert_journey_stop_daily()` lagt til — rå per-avgang-per-stopp-per-dag, 90d vindu | `ingest.py`, `db_setup.py`, `schema.ts` | Grunnlag for Parquet, persentiler, reiseplanlegger |
| 2026-04-04 | `compute_delays()` skiller ankomst- og avgangsforsinkelse, beregner dwell time | `ingest.py` | Forutsetning for nye DB-kolonner |

#### `populate_stops.py`
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-12 | BQ-query henter nå `stop_place_ref` og `stop_place_name` direkte. Cache utvidet til 6 felter. | `populate_stops.py` | StopPlace-ref for alle quays (ikke bare GTFS-dekning). Reiseplanlegger trenger StopPlace. |

### Backend (`server/`)

#### `storage.ts`
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-22 | `getWorstDays`/`getBestDays` støtter nå `fromDate`/`toDate` — bruker live aggregering fra `daily_summary` når tidsvindu er oppgitt (materialisert tabell ellers) | `storage.ts` | TimeWindowPicker på /worst |
| 2026-04-22 | `getLeaderboardStops` støtter `toDate` parameter | `storage.ts` | TimeWindowPicker på /worst |
| 2026-04-24 | `getJourneyProfile` SELECT utvidet med 4 nye kolonner: `avgDelayArrivalMin`, `avgDelayDepartureMin` (vektede snitt), `avgDwellTimeSec` (AVG), `stddevDelayMin` (SQLite population stddev via `SQRT(MAX(0, AVG(x²)-AVG(x)²))`) | `storage.ts` | Avgangsanalyse 3-modus + σ-bånd |
| 2026-04-22 | `getJourneyProfile` støtter `fromWeek` parameter (kapper til 13 uker) | `storage.ts` | TimeWindowPicker på /journey (avgangsanalyse) |
| 2026-04-12 | `getTripStopStats()` — delay-stats for array av (stopRef, lineRef) par | `storage.ts` | Delay overlay på reiseforslag |
| 2026-04-12 | `searchStopsForCorridor()` — filtrerer nå på `stop_place_ref IS NOT NULL`, grupperer per StopPlace | `storage.ts` | Unngå NSR:Quay i trip planner (Entur trenger StopPlace) |
| 2026-04-07 | `getWorstJourneysForLine` returnerer `observedDepartures` (MAX) i stedet for `totalSamples` (SUM). Dette matcher `numSamples` i reiseprofil og er det brukeren faktisk vil vite | `storage.ts`, `journey-details.tsx` | Bug — tallet stemte ikke med reiseprofilen |
| 2026-04-07 | `getBestJourneysForLine` lagt til (speilbilde av worst, ASC) | `storage.ts` | Topp 5 beste avganger på linjeanalyse |
| 2026-04-07 | `getLeaderboardLinesByReliability(type)` lagt til | `storage.ts` | Pålitelighet-toppliste |
| 2026-04-04 | `getRouteVariants` + `variant`-param til `getLineStopProfile` | `storage.ts` | Linjer med flere ruter (linje 99 = 62 varianter) |
| 2026-04-04 | `getJourneyProfile` velger nå én beste serviceJourneyId | `storage.ts` | Stoppene var feilsortert pga. mix av varianter |
| 2026-04-04 | `getCorridorComparison` + `searchStopsForCorridor` lagt til | `storage.ts` | Forberedelse for /reise |

#### `routes.ts`
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-12 | `GET /api/parquet/manifest` + statisk Parquet-serving med Accept-Ranges | `routes.ts` | DuckDB-WASM HTTP range requests |
| 2026-04-12 | `GET /api/geocoder/autocomplete` — Entur Geocoder proxy (stopp + adresser) | `routes.ts` | Adressesøk i reiseplanlegger |
| 2026-04-12 | `POST /api/trip` — multi-modal, filtre, koordinat-støtte, cache inkl. filtre | `routes.ts` | Reisesjekk, NLOD-compliant |
| 2026-04-12 | `POST /api/trip/stats` — delay overlay for trip-stopp | `routes.ts` | Historisk forsinkelse per stopp på reisen |
| 2026-04-12 | `accessMode: foot` / `egressMode: foot` som default i modes-blokk | `routes.ts` | Koordinat-baserte søk feilet uten eksplisitt accessMode |
| 2026-04-12 | `ET-Client-Name` satt til `emiliemoldestad-bussprosjekt` | `routes.ts` | Entur API-krav |
| 2026-04-22 | `parseTimeWindow()` og `parseWeeksWindow()` helpers — alle endepunkter støtter `?days=N` og `?from=YYYY-MM-DD&to=YYYY-MM-DD` | `routes.ts` | Gjenbrukbar tidsvindu-parsing |
| 2026-04-21 | Default `weeks=13` (ikke 4) på `/api/line/:ref/journeys`, `/stops`, `/route-variants`, `/stop-profile` | `routes.ts` | `journey_stop_weekly` har kun 13-ukers vindu; 4 ga tom respons når data >28d gammel |
| 2026-04-07 | `/api/line/:ref/best-journeys` + `?limit=` på worst-journeys | `routes.ts` | Speilbilde av worst-journeys |
| 2026-04-07 | `/api/leaderboard/lines?type=reliable\|unreliable` | `routes.ts` | Pålitelighet-toppliste |
| 2026-04-04 | `/api/line/:ref/route-variants` | `routes.ts` | Variantvelger |
| 2026-04-04 | `POST /api/corridor`, `GET /api/stops/corridor-search` | `routes.ts` | Korridor-backend |

### Frontend (`client/src/pages/`)

#### `journey-details.tsx` (Linjeanalyse)
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-27 | Avgangsanalyse kumulativ-modus: båndet er nå korrekt definert. Ytre bånd kappes til snitt ± 2σ (filtrerer outlier-uker både opp og ned). Indre bånd er symmetrisk snitt ± 1σ (≈ 68 % hvis normalfordelt). Faktiske min/max-uker tegnes som stiplet faint linje slik at ekstrem-uker (snø, streik) fortsatt er synlige. Inline forklaring under grafen: hva snittet er (vektet mean, ikke median), hva symmetrisk-i-verdi vs symmetrisk-i-prosentil betyr, og at høyreskeive forsinkelser gir litt skjev dekning | `journey-details.tsx` | Brukerønske: filtrere outliers begge veier + tydelig forklare statistikken + vise faktiske ekstremer |
| 2026-04-27 | `niceAxisTicks()` i `scrollable-chart.tsx`: Y-akse-ticks på fast steg (1/2/5/10×10ⁿ), 0 alltid med når range krysser. Slipper ujevne ticks som "8, 6, 4, 3, 1, -1" | `scrollable-chart.tsx` | Y-aksen viste rare avstander når range delt i 5 og rundet |
| 2026-04-27 | `padding={{ left: 20, right: 10 }}` på alle 6 XAxis-blokker — første datapunkt var presset opp mot 55px Y-akse-overlay | `journey-details.tsx` | Første stopp "krasjet" inn i Y-aksen |
| 2026-04-27 | `<TimeWindowPicker>` på /map (var siste side uten den) | `delay-map.tsx` | Konsekvent filter-UI |
| 2026-04-24 | Avgangsanalyse: 3-modus toggle (Forsinkelse / Forsinkelsesendring / Stopptid) lik stopp-profil-systemet. Kumulativ-modus: ytre min/max-bånd (fillOpacity 0.12) + indre avg±σ-bånd (fillOpacity 0.28). `ProfileTooltip` viser σ-verdi. Per-modus Y-akse-states (`profileDerYMax/Min`, `profileDwellYMax`) med auto-reset ved modusbytte | `journey-details.tsx`, `storage.ts` | Brukerønske: dwell/derivert i avgangsanalyse + P80-lignende bånd |
| 2026-04-24 | `getWorstJourneysForLine`/`getBestJourneysForLine`: `HAVING observedDepartures >= 3` → `HAVING numStops >= 3`. Daterte SJIDs har alltid `num_samples = 1` → alle avganger ble filtrert bort | `storage.ts` | Bug: tabellene viste alltid "Ingen data" |
| 2026-04-24 | Info-ikon (`InfoTip`) i `worst-lists.tsx` flyttet til modul-nivå. Komponent definert inne i render-funksjonen → ny type per render → Radix Tooltip unmountet før hover fullførte | `worst-lists.tsx` | Bug: tooltip-hover virket ikke |
| 2026-04-24 | Verste/beste enkeltavganger vises nå alltid når retning er satt (ikke bare ved ikke-tom respons). Viser "Ingen data i valgt tidsvindu" ved tom, med hint om å prøve lengre vindu | `journey-details.tsx` | UX: seksjonen forsvant stille ved gammel data |
| 2026-04-24 | Avgangsanalyse-header viser sanntidsdekning: "X av Y avganger" i ravfarge når X < Y, med "Z% dekning"-hint. Full dekning = dempet grå | `journey-details.tsx` | Brukerønske: synliggjøre sanntidsdekning per avgang |
| 2026-04-24 | `getJourneyProfile` aggregerer nå over ALLE matching service_journey_ids for avgangstiden (ikke bare LIMIT 1). numSamples stemmer nå med "snitt av X avganger" i headeren | `storage.ts` | Bug: SIRI ET lager ny SJID per dag — LIMIT 1 viste kun én dags data |
| 2026-04-24 | Dobbel Y-akse fjernet: Recharts `<YAxis>` satt til `hide width={0}` i alle 4 ScrollableChart-grafer. Kun sticky SVG-overlay vises | `journey-details.tsx` | Visuell duplikat (overlay + Recharts-akse stod side om side) |
| 2026-04-24 | Negative verdier i avgangsanalyse og forsinkelsesendring-modus vises nå korrekt: `profileYMin`/`stopProfileDerYMin` state + `yMin` prop til ScrollableChart | `journey-details.tsx`, `scrollable-chart.tsx` | Tidlig ankomst (negativ forsinkelse) ble klippet ved y=0 |
| 2026-04-24 | `margin.left` økt fra 35 til 60px i alle ScrollableChart-grafer — første stopp var skjult under 55px-bred Y-akse-overlay | `journey-details.tsx` | Første datapunkt uklikkbart/usynlig |
| 2026-04-24 | `ProfileTooltip` viser "X stoppbesøk (av Y)" i ravfarge når dekning er lavere enn numVariants | `journey-details.tsx` | Forklarer diskrepans mellom header-tall og tooltip-tall |
| 2026-04-21 | Tidsvindu-velger (7/14/30/90d, default 30) — gjenbrukt fra `/map`. Trås som `days=` (lineStats) og `weeks=ceil(days/7)` (journey_stop_weekly-endepunkter) | `journey-details.tsx` | Brukerønske — samme filter-UI på flere sider |
| 2026-04-21 | Fallback i `directionLabels`: retninger uten first/last-stopnavn får generisk "Retning X"-label | `journey-details.tsx` | Defensiv — sikrer at retningsvelger og stop-profil-graf vises selv ved manglende navn |
| 2026-04-07 | Click handler i verste/beste enkeltavganger overfører `firstStopName/lastStopName` til selectedJourney | `journey-details.tsx` | Bug — reiseprofil-velger viste "? → ?" |
| 2026-04-07 | "Beste enkeltavganger"-tabell side-om-side med verste, top 5 av hver | `journey-details.tsx` | Brukerønske |
| 2026-04-07 | Pålitelighet (σ)-kort lagt til i stat-rad (5 kort) | `journey-details.tsx` | Synliggjøre stddev fra DB |
| 2026-04-04 | 3-modus toggle på stopp-profil: forsinkelse / endring / stopptid | `journey-details.tsx` | Bruke nye DB-kolonner |
| 2026-04-04 | Rutevariant-velger (dropdown) | `journey-details.tsx` | Linjer med flere ruter |
| 2026-04-04 | Verste enkeltavganger-tabell med "Rute"-kolonne | `journey-details.tsx` | Identifisere avgang |

#### `worst-lists.tsx` (Topplister)
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-22 | `TimeWindowPicker` lagt til — alle dags/stopp-topplister filtreres på tidsvindu | `worst-lists.tsx` | Brukerønske |
| 2026-04-22 | Info-ikoner (Lucide `Info` + shadcn Tooltip) på alle toppliste-titler og sort-kontroller | `worst-lists.tsx` | Forklarer sortering og kolonner |
| 2026-04-22 | `lineSort`-state: pålitelighet-topplisten kan sorteres på σ / punktlighet / kanselleringer | `worst-lists.tsx` | Brukerønske |
| 2026-04-22 | `operator`-param lagt til på `reliableLines`/`unreliableLines` query — fikset at pålitelighet-topplisten mikset regioner | `worst-lists.tsx` | Bug |
| 2026-04-22 | Kansellerings-kolonne ("Kans.") i pålitelighet-tabellene | `worst-lists.tsx` | Del av Fase 3 (krever DB-recreate) |
| 2026-04-07 | Vis linjenummer + lineName i pålitelighet-tabellene | `worst-lists.tsx` | Bug — bare destinasjon var vist, ikke linjenummer |
| 2026-04-07 | Pålitelighet-seksjon (Mest/minst pålitelig) | `worst-lists.tsx` | Bruke stddev fra DB |

#### `dashboard.tsx`
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| _Ingen endringer i denne syklusen_ | | | |

#### `trip-planner.tsx` (Reiseplanlegger) — NY
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-24 | Endestopp viser nå oransje estimert ankomsttid: DuckDB-query endret fra `WHERE delay_departure_min IS NOT NULL` til `WHERE (delay_departure_min IS NOT NULL OR delay_arrival_min IS NOT NULL)`. Displaykoden bruker `p50_arr`/`p80_arr` for siste stopp | `trip-planner.tsx` | Siste stopp har aldri departure-data → null rader → ingen estimat |
| 2026-04-12 | Ny side: StopSearch (debounced), TripCard med expandable legs, delay badges, overgangsanalyse | `trip-planner.tsx`, `App.tsx`, `layout.tsx` | Statistisk reiseplanlegger |
| 2026-04-12 | Filtre: avgangstid, arriveBy, transportmodus-toggle, ganghastighet, maks overganger, overgangstid (inkl. negativ), rullestol | `trip-planner.tsx` | Entur-lignende filteropplevelse |
| 2026-04-12 | Multi-modal: bus, tram, rail, metro, water, coach. "ingen forsinkelsesdata"-badge for ikke-buss | `trip-planner.tsx` | Støtte for alle transportmidler |
| 2026-04-12 | Entur Geocoder-søk: stoppesteder + adresser, koordinat-baserte reiser | `trip-planner.tsx` | Adressesøk som entur.no |
| 2026-04-12 | Feilmeldinger fra Entur vises nå i UI (var stille `[]` før) | `trip-planner.tsx` | Feilsøking |
| 2026-04-13 | DuckDB-WASM koblet til: `useTripDelayDistribution()` henter P50/P80/P95 per (line, stop) | `trip-planner.tsx` | Empirisk data erstatter heuristikk |
| 2026-04-13 | Estimert avgangs-/ankomsttid (median-basert, oransje) per leg | `trip-planner.tsx` | Vise forventet reell tid |
| 2026-04-13 | Overgangs-sannsynlighet: empirisk fra DuckDB persentiler med interpolering | `trip-planner.tsx` | Pålitelig transfer-analyse |
| 2026-04-13 | P80-punktlighets-badge per buss-leg | `trip-planner.tsx` | Rask visuell pålitelighetsindikator |
| 2026-04-13 | Metodeboks: full transparens om beregningsmetoder (vises under reiseforslag + før søk) | `trip-planner.tsx` | Brukerønske om gjennomsiktighet |
| 2026-04-13 | Retningsbytte-knapp (swap fra/til) | `trip-planner.tsx` | UX-forbedring |
| 2026-04-13 | Filtre: flybuss-toggle, ganghastighet-slider (0-20 km/t), overgangstid-slack, statistikk-tidsvindu | `trip-planner.tsx` | Avanserte filtre |
| 2026-04-14 | DuckDB-init fikset: cross-origin Worker → Blob URL; relativ URL → absolut URL i registerFileURL | `use-duckdb.ts`, `use-parquet-query.ts` | Worker krasjet stille pga same-origin policy |
| 2026-04-14 | BigInt-feil fikset: DuckDB COUNT(*) returnerer BigInt → konvertert til Number i Arrow-parsing | `use-parquet-query.ts` | Krasj ved DuckDB-spørring |
| 2026-04-14 | "ingen forsinkelsesdata" → "mangler data for linje XX" med linjenummer | `trip-planner.tsx` | Tydeligere melding |
| 2026-04-14 | Overgangsanalyse for gange-i-mellom: walk-leg buffer trekkes fra, sannsynlighet vises for alle overgangstyper | `trip-planner.tsx` | Transfers med gange mellom hadde ingen sannsynlighet |
| 2026-04-14 | Overgang til transportmiddel uten data: antar foregående i rute, viser % med "antar foregående i rute" | `trip-planner.tsx` | Bybane/tog/etc. fikk ikke sannsynlighet |
| 2026-04-14 | Per-stopp tider: rutetid (grå) + P50 estimert (oransje) + P80 (rød) langs hele ruten | `trip-planner.tsx`, `routes.ts` | Brukerønske — synliggjøre forsinkelse per stopp |
| 2026-04-14 | Henter estimatedCalls (med aimedDepartureTime) fra Entur API for nøyaktige rutetider per stopp | `routes.ts` | Nødvendig for per-stopp timing |
| 2026-04-21 | H2-heading "Reisesjekk" → "Reiseplanlegger" | `trip-planner.tsx` | Riktig navn — siden er en reiseplanlegger, ikke en reisesjekk |

#### `stop-analysis.tsx`
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-22 | `TimeWindowPicker` erstatter hardkodet periode-velger | `stop-analysis.tsx` | Konsistens med andre sider |
| 2026-04-22 | Plattform-prioritering: terminaler der alle quays har platformCode viser kun plattform-picker, retning skjules | `stop-analysis.tsx` | Lagunen/Åsane: plattform A/B/C er mer meningsfylt enn retning |
| 2026-04-22 | σ-stat-kort (vektet snitt av daglig stddev) | `stop-analysis.tsx` | Bruke `stddev_delay_min` fra `stop_daily` |
| 2026-04-21 | Knapp "Reisesjekk" → "Avgangsanalyse" (navigerer til `/journey`, ikke `/reise`) | `stop-analysis.tsx` | Riktig navn — knappen åpner linjeanalysen, ikke reiseplanleggeren |
| 2026-04-12 | 300ms debounce på stoppesøk (`debouncedQuery` state + useEffect) | `stop-analysis.tsx` | Fyrte request per tastetrykk |

#### `layout.tsx`
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-21 | Nav-label for `/reise`: "Reisesjekk" → "Reiseplanlegger" | `layout.tsx` | Riktig navn |
| 2026-04-12 | NLOD 2.0-attribusjon + Entur-logo i sidebar. Nav-item for `/reise` | `layout.tsx` | Entur lisenskrav |

#### Nye komponenter og hooks
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-24 | `<TimeWindowPicker>` — gjenbrukbar tidsvindu-velger (5 presets + custom kalender-popover). Brukes på /journey, /stops, /worst, /map | `time-window-picker.tsx` | Konsekvent filter-UI på tvers av sider |
| 2026-04-24 | `ScrollableChart`: ny `yMin` prop (default 0) — støtter negative Y-verdier i overlay. Tick-generering og posisjonering oppdatert | `scrollable-chart.tsx` | Nødvendig for forsinkelsesendring-graf og tidlig-ankomst-visning |
| 2026-04-12 | `<DelayPercentiles>` — DuckDB-WASM P50/P80/P95 persentilkort | `delay-percentiles.tsx` | Klient-side persentiler uten server-roundtrip |
| 2026-04-12 | `useDuckDB()` — singleton DuckDB-WASM initialisering (EH bundle, jsDelivr CDN) | `use-duckdb.ts` | Delt instans for alle komponenter |
| 2026-04-12 | `useParquetQuery()` — manifest, fil-registrering, `query(sql)` funksjon | `use-parquet-query.ts` | Generisk SQL-grensesnitt mot Parquet-data |

#### `delay-map.tsx`
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| _Ingen endringer i denne syklusen_ | | | |

---

## 9. Refresh-/recreate-prosedyre

### Full recreate (etter skjema-endring)
```powershell
# 1. Slett og opprett
del data\bussforsinkelser.db
python pipeline/db_setup.py

# 2. Stoppesteder (fra cache — ingen BQ-kall)
python pipeline/populate_stops.py
python pipeline/populate_stop_places.py          # GTFS → stop_place_ref/platform_code

# 3. Ingest historiske dager
foreach ($d in @("2026-03-07","2026-03-08",...)) {
    Write-Host "Ingesting $d..."; python pipeline/ingest.py $d
}

# 4. Linjenavn (etter ingest, trenger journey_stop_weekly for DB-deriverte navn)
python pipeline/populate_line_names.py --operator SKY --apply  # NeTEx-basert
python pipeline/populate_line_names.py --apply                 # DB-derivert for resten

# 5. Parquet-eksport (etter ingest, trenger journey_stop_daily)
python pipeline/export_parquet.py
```

### Daglig nightly-jobb
```powershell
python pipeline/ingest.py                        # gårsdagens dato (default)
python pipeline/export_parquet.py                # nye/ufullstendige uker
```

### Kun stopp-oppdatering (sjelden)
```powershell
python pipeline/populate_stops.py --refresh      # BQ → cache → DB
python pipeline/populate_stop_places.py          # GTFS → plattform-metadata
```

**Merk**: PK-endringer i `shared/schema.ts` krever full recreate (SQLite mangler `ALTER TABLE … MODIFY PK`).
**Merk**: `populate_line_names.py` MÅ kjøres etter ingest pga. avhengighet til `journey_stop_weekly`.
**Merk**: `populate_stop_places.py` MÅ kjøres etter `populate_stops.py` pga. avhengighet til `stop_coords`.


## §10 — Framtidige forbedringer (TODO)

Flagget 2026-04-22 under audit-implementering:

1. **Konfigurerbare terskler i trip-planner**: Overgangs-sannsynlighets-tersklene (P50/P80/P95-interpolering i `transferProbabilityFromDist()`) er hardkodet. Bør eksponeres som bruker-justerbar slider eller via feature-flag. Relevant fil: `client/src/pages/trip-planner.tsx`.

2. **Plan B-rekursjon**: Trip-planner bør ha "avansert analyse"-panel som viser rådata, og automatisk generere alternative reiseforslag (Plan B) når sannsynlighet for missed transfer overstiger terskel.

3. **Entur-logo i NLOD-attribusjon**: Bruker vil legge til Entur-logo i sidebar-attribusjonen når filen er klar. Plass er reservert i `client/src/components/layout.tsx`.

4. **Rush-tidsfilter**: Utsatt — bruker vurderer en bedre løsning enn ren timefilter (nattbuss vs rushtid-stat passer ikke samme verktøy). Relevant for /stops, /worst, /map.

5. **DB-recreate kreves** etter Fase 3-endringer i denne sesjonen (`num_cancellations`-kolonne i `line_daily` og `leaderboard_lines`). Frontend viser "—" til recreate er kjørt.
