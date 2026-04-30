# bussforsinkelser.no — Statusoversikt

> **Hensikt**: Én levende kilde for prosjektets status, datakilder, API, kjente svakheter og endringslogg.
> Oppdateres for hver meningsfull endring. Hierarkisk strukturert per komponent slik at man enkelt kan se historikken til en gitt bit.

**Sist oppdatert**: 2026-04-30

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


---

## 1. Funksjonsstatus

| Side / Komponent | Sti | Status | Notat |
|---|---|---|---|
| Dashboard | `/` | ✅ Live | Daglige nøkkeltall, trend, linje-leaderboard |
| Linjeanalyse | `/journey` | ✅ Live | Stat-kort, dagstrend, timesprofil, stopp-profil med 3 modi, reiseprofil, beste/verste avganger |
| Stoppanalyse | `/stops` | ✅ Live | Stop-stats, timesprofil, linjer ved stopp |
| Topplister | `/worst` | ✅ Live | Verste/beste dager + stopp + pålitelighet (linjer) |
| Forsinkelseskart | `/map` | ✅ Live | Geo-kart med filter |
| Reisesjekk | `/reise` | 🟡 Beta | Entur JP v3 + Geocoder + DuckDB-WASM. Adressesøk, multi-modal, filtre, empirisk delay overlay, overgangsanalyse, P80-badge, estimert tid, metodeboks |
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

### Reisesjekk (`/api/trip*`)
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

## 6. Kjente svakheter / forbedringspunkter

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

## 7. Endringslogg (hierarkisk per komponent)

> Format: `| Dato | Endring | Filer | Begrunnelse |`
> Hver endring i kode/skjema skal legges inn under riktig seksjon.

### Database

#### Skjema
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
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
| 2026-04-07 | `/api/line/:ref/best-journeys` + `?limit=` på worst-journeys | `routes.ts` | Speilbilde av worst-journeys |
| 2026-04-07 | `/api/leaderboard/lines?type=reliable\|unreliable` | `routes.ts` | Pålitelighet-toppliste |
| 2026-04-04 | `/api/line/:ref/route-variants` | `routes.ts` | Variantvelger |
| 2026-04-04 | `POST /api/corridor`, `GET /api/stops/corridor-search` | `routes.ts` | Korridor-backend |

### Frontend (`client/src/pages/`)

#### `journey-details.tsx` (Linjeanalyse)
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-07 | Click handler i verste/beste enkeltavganger overfører `firstStopName/lastStopName` til selectedJourney | `journey-details.tsx` | Bug — reiseprofil-velger viste "? → ?" |
| 2026-04-07 | "Beste enkeltavganger"-tabell side-om-side med verste, top 5 av hver | `journey-details.tsx` | Brukerønske |
| 2026-04-07 | Pålitelighet (σ)-kort lagt til i stat-rad (5 kort) | `journey-details.tsx` | Synliggjøre stddev fra DB |
| 2026-04-04 | 3-modus toggle på stopp-profil: forsinkelse / endring / stopptid | `journey-details.tsx` | Bruke nye DB-kolonner |
| 2026-04-04 | Rutevariant-velger (dropdown) | `journey-details.tsx` | Linjer med flere ruter |
| 2026-04-04 | Verste enkeltavganger-tabell med "Rute"-kolonne | `journey-details.tsx` | Identifisere avgang |

#### `worst-lists.tsx` (Topplister)
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-07 | Vis linjenummer + lineName i pålitelighet-tabellene | `worst-lists.tsx` | Bug — bare destinasjon var vist, ikke linjenummer |
| 2026-04-07 | Pålitelighet-seksjon (Mest/minst pålitelig) | `worst-lists.tsx` | Bruke stddev fra DB |

#### `dashboard.tsx`
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| _Ingen endringer i denne syklusen_ | | | |

#### `trip-planner.tsx` (Reisesjekk) — NY
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
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

#### `stop-analysis.tsx`
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-12 | 300ms debounce på stoppesøk (`debouncedQuery` state + useEffect) | `stop-analysis.tsx` | Fyrte request per tastetrykk |

#### `layout.tsx`
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-12 | NLOD 2.0-attribusjon + Entur-logo i sidebar. Nav-item for `/reise` | `layout.tsx` | Entur lisenskrav |

#### Nye komponenter og hooks
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| 2026-04-12 | `<DelayPercentiles>` — DuckDB-WASM P50/P80/P95 persentilkort | `delay-percentiles.tsx` | Klient-side persentiler uten server-roundtrip |
| 2026-04-12 | `useDuckDB()` — singleton DuckDB-WASM initialisering (EH bundle, jsDelivr CDN) | `use-duckdb.ts` | Delt instans for alle komponenter |
| 2026-04-12 | `useParquetQuery()` — manifest, fil-registrering, `query(sql)` funksjon | `use-parquet-query.ts` | Generisk SQL-grensesnitt mot Parquet-data |

#### `delay-map.tsx`
| Dato | Endring | Filer | Begrunnelse |
|---|---|---|---|
| _Ingen endringer i denne syklusen_ | | | |

---

## 8. Refresh-/recreate-prosedyre

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
