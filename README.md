# Bussforsinkelser

Historisk og sanntids-statistikk over forsinkelser i offentlig transport i Norge, region for region. Dekker 19 operatører (Skyss, Ruter, AtB, Kolumbus, Brakar m.fl.) og alle ruteslag SIRI ET-feeden inkluderer (per nå primært buss + flybuss).

**Datakilde**: Entur SIRI ET (BigQuery) + NSR (National Stop Registry). NLOD 2.0.

Se [STATUS.md](STATUS.md) for full endringslogg, [ARCHITECTURE.md](ARCHITECTURE.md) for detaljert skjema og [CLAUDE.md](CLAUDE.md) for prosjektnotater.

---

## Stack

| Lag | Teknologi |
|---|---|
| Frontend | React 19 + Vite + Tailwind 4 + shadcn/ui + Recharts + Leaflet (wouter for routing) |
| Backend | Node.js + Express 5 + Drizzle ORM |
| Database | SQLite (better-sqlite3, WAL mode) |
| Klient-analyse | DuckDB-WASM mot ukentlige Parquet-filer (P50/P80/P95 i nettleser) |
| Pipeline | Python 3.14, pandas, google-cloud-bigquery |
| Hosting | Railway (full-bygget, ikke promotert offentlig enda) + Cloudflare Worker (reise-bygget/Sen Tur, se [Deploy](#deploy-reise-bygget--sen-tur)) + Cloudflare R2 (Parquet + prod-DB) |

**Sen Tur (reise-bygget)**: [sentur.no](https://sentur.no) i produksjon.

---

## Sider

| Rute | Beskrivelse |
|---|---|
| `/` | Dashboard — daglig snitt, trend, linje-toppliste |
| `/map` | Forsinkelseskart — Leaflet med fargede stoppmarkører |
| `/stops` | Stoppanalyse — søk, dagstrend, timesprofil, linjer ved stopp |
| `/worst` | Topplister — verste/beste dager, stopp og linjer |
| `/journey` | Linjeanalyse — stat-kort, dagstrend, time- og stopprofil |
| `/reise` | Reiseplanlegger — Entur JP v3 + DuckDB-persentiler + empirisk overgangssannsynlighet |
| `/avganger` | Sanntidsavganger fra valgt stoppested + historisk delay-overlay |
| `/metode` | Dokumentasjon i tre nivåer (alle / lett teknisk / detaljert metodikk) |

---

## Kjøre lokalt

```powershell
# 1. Sett miljøvariabler (én gang, persistent via setx — krever ny terminal)
setx GOOGLE_APPLICATION_CREDENTIALS "C:\Users\<bruker>\sti\til\gcp-credentials.json"
# Valgfritt: $env:DATABASE_PATH = ".\data\bussforsinkelser.db"

# 2. Sett opp database og stoppdata
python pipeline/db_setup.py
python pipeline/populate_stops.py        # leser cache; --refresh tvinger BigQuery
python pipeline/populate_stop_places.py  # GTFS-fallback for Skyss-plattformer

# 3. Hent data (én dag eller intervall — se CLAUDE.md for fler-dags loop)
python pipeline/ingest.py                # default: gårsdagen, alle 19 operatører
python pipeline/ingest.py 2026-05-20     # spesifikk dato
python pipeline/ingest.py --operator SKY,RUT   # subset av operatører

# 4. Eksporter Parquet for klient-side persentiler
python pipeline/export_parquet.py

# 5. Start utviklingsserver (frontend + backend)
npm install
npm run dev          # http://localhost:5000
```

For nightly cron-jobb og R2-opplasting, se [CLAUDE.md](CLAUDE.md).

For reise-bygget (Sen Tur) trengs ingen Python/database-oppsett — bare
`npm install && npm run dev:reise` (se Deploy-seksjonen under for detaljer om
hvordan reise-bygget faktisk kjører i prod/preview).

---

## Deploy (reise-bygget / Sen Tur)

Repoet inneholder **to separate frontend-bygg** fra samme kodebase, styrt av
`VITE_APP`:

| | Full-bygget («Bussforsinkelser») | Reise-bygget («Sen Tur») |
|---|---|---|
| Bygg-kommando | `npm run build` | `npm run build:reise` |
| Server | Express (`server/index.ts`), egen SQLite-DB | Ingen — statisk SPA + Cloudflare Worker som API-proxy |
| Hosting | Railway | Cloudflare Workers (static assets + Worker-script) |
| API-implementasjon | `server/routes.ts` (Express) | `functions/api/**/*.ts`, koblet sammen i `src/worker.ts` |

### Cloudflare Workers Build — reise-bygget

Konfigurert i Cloudflare-dashbordet (git-integrasjon, "Workers Builds") — **ikke** en synlig GitHub Actions-workflow i repoet:

| Innstilling | Verdi |
|---|---|
| Build-kommando | `npm run build:reise` |
| Deploy-kommando | `npx wrangler deploy` |
| Version-kommando | `npx wrangler versions upload` |
| Rot-katalog | `/` |

`npm run build:reise` bygger frontend til `dist/reise/` (Vite, `VITE_APP=reise`). `wrangler deploy` bundler deretter `src/worker.ts` og laster opp `dist/reise/` som statiske assets (se `wrangler.jsonc`: worker-navn `reiseplanlegger`, `assets.directory: ./dist/reise`, SPA-fallback via `not_found_handling`).

**`reise` er produksjonsgrenen** — push dit kjører Deploy-kommandoen (`npx wrangler deploy`) rett til [sentur.no](https://sentur.no).

**Alle andre grener** (f.eks. `reise-preview`) kjører i stedet Version-kommandoen (`npx wrangler versions upload`) og får hver sin egen preview-URL automatisk, etter mønsteret `<grennavn>-reiseplanlegger.emiliemoldestad.workers.dev` — ikke en separat, fast konfigurert "preview worker". F.eks. blir `reise-preview` til [reise-preview-reiseplanlegger.emiliemoldestad.workers.dev](https://reise-preview-reiseplanlegger.emiliemoldestad.workers.dev/reise).

**Build-environment-variabler** (satt i Cloudflare-dashbordet, ikke i repoet):
- `VITE_PARQUET_BASE_URL=https://parquet.sentur.no` — samme verdi i alle miljøer (produksjon og alle branch-previews peker på samme R2-custom-domene).
- `ET_CLIENT_NAME` — ingen override konfigurert; alle miljøer bruker kode-defaulten (`emiliemoldestad-sentur` i `functions/api/_entur.ts`).
- Ingen andre bindings (R2, KV, osv.) på selve Worker-en — R2-dataene (Parquet + stats-JSON) hentes utelukkende client-side via den offentlige `parquet.sentur.no`-URL-en, ikke via en server-side binding.

> ⚠️ **Viktig fallgruve**: `src/worker.ts` er en **håndrutet** Cloudflare
> Worker, ikke Cloudflare Pages Functions med automatisk filsystem-routing.
> Et nytt endepunkt i `functions/api/**/*.ts` blir IKKE automatisk tilgjengelig
> — det må eksplisitt importeres og kobles til en path i `src/worker.ts`s
> `fetch()`-handler, ellers treffer kallet catch-all-en for ukjente
> `/api/`-stier og får 404. (Skjedde med `/api/geocoder/reverse` 2026-08-01 —
> filen fantes og deployet gikk fint, men endepunktet svarte 404 helt til
> routeren ble oppdatert.)

---

## Pipeline-oversikt

```
BigQuery (Entur SIRI ET, 19 operatører)
    └── pipeline/ingest.py            Henter én dag, beregner forsinkelser, skriver til SQLite
         ├── daily_summary              Daglig snitt per operatør (ubegrenset historikk)
         ├── line_daily                 Per linje × retning × modus
         ├── stop_daily                 Per stopp × retning × modus × operatør
         ├── line_hourly_raw/profile    Time-bucket → 30d rullerende snitt
         ├── stop_hourly_raw/profile    Time-bucket → 30d rullerende snitt
         ├── journey_stop_weekly        13-ukers vektet snitt per (avgang × stopp)
         ├── journey_stop_daily         90 dagers rå observasjon per (avgang × stopp)
         ├── leaderboard_lines          All-time toppliste (rebuild nightly)
         ├── worst_days                 De 100 verste dagene (rebuild nightly)
         └── data_quality_log           Outliers >±120 min + manglende tider
         └── data/diagnostics/*.json    Per-operatør coverage-rapport + advarsler

NSR BigQuery (quays JOIN stop_places)
    └── pipeline/populate_stops.py     Stoppkoordinater, navn, stop_place_ref, platform_code

pipeline/export_parquet.py → data/parquet/YYYY-WXX.parquet (ZSTD)
    └── pipeline/upload_to_r2.py        Cloudflare R2 (kjøres manuelt — se TODO under)
         └── DuckDB-WASM i nettleser    HTTP range requests for P50/P80/P95
```

### Filtrering i pipeline

- Alle 19 operatører ingestes per default; subset via `--operator SKY,RUT`
- Kun rader med `stopPointRef LIKE 'NSR:%'` — filtrerer bort legacy-ruter
- Alle ruteslag (`bus, coach, tram, metro, rail, water, ferry`) lagres; per nå har kun buss + flybuss faktiske observasjoner
- Forsinkelser >±120 min logges som outliers men inkluderes i statistikk

---

## TODO — før offisiell promotering og deling

Listene baserer seg på den interne fase-planen (tre Explore-agenter gjennomgikk hele kodebasen i mai 2026). Fase 1 er i hovedsak ferdig; fase 2 (skalering, infrastruktur) er utsatt til etter første promotering.

### Fase 1 — blockers før offentlig deling

**Ferdig** (commit `b1147ed`):
- [x] Dokumentasjon: ny `/metode`-side med tre nivåer (for alle / lett teknisk / detaljert metodikk) + "Begrensninger og kjente svakheter"
- [x] Info-ikoner med "Les mer →"-lenker til /metode-anker (dashboard, journey, departures, worst-lists, trip-planner)
- [x] Data-freshness-indikator (`GET /api/health` + sidebar-badge med oransje varsel ved >2 dager stale)
- [x] Rate limiting på Entur-proxy-endepunkter (trip 20/min, geocoder 60/min, departures 30/min)
- [x] Input-grenser (geocoder text 200, stops/search q 100) + operator-whitelist (defense-in-depth)
- [x] Sanitering av Entur-feildetaljer (logger fullt server-side, generisk norsk melding til klient)
- [x] Per-operatør ingest-diagnostikk (`data/diagnostics/YYYY-MM-DD-ingest.json` + synlig WARNING ved 0-rader-operatører)
- [x] Norsk 404-side, R2-env-vars i `.env.example`, `console.warn` gates bak DEV

**Gjenstår**:
- [ ] Wire `pipeline/upload_to_r2.py` inn i Railway nightly-cron etter `export_parquet.py` (krever Railway-dashboard-tilgang)
- [ ] Loading skeletons på journey-details profile-chart (lav prio, kosmetisk)
- [ ] Per-operatør try/catch i ingest så én operatørs BQ-feil ikke dreper hele jobben (i dag stopper alt ved første feil)
- [ ] Mobile responsiveness audit (alle sider på <768 px-bredde) — egen UX-økt
- [ ] Accessibility-audit (aria-labels på charts, keyboard-nav, kontrast) — egen økt

### Fase 2 — skalering, infrastruktur (etter første promotering)

- [ ] **R2-bucket tilgangskontroll**: prod-DB er offentlig nedlastbar via R2 public URL i dag. Beslutning: aksepter (data er offentlig uansett) eller splitt i `parquet-public` + `db-private` med presigned URLs?
- [ ] **Railway volume-grense (5 GB Hobby)**: prod-DB er allerede 2 GB. Estimat 5–10 GB innen ett år. Tre alternativer:
  - Drop mellomdata-tabeller (`line_hourly_raw`, `stop_hourly_raw`) fra prod-DB siden de kun brukes for å bygge profile-tabellene
  - Oppgrader til Railway Pro ($20/mnd, 50 GB volume)
  - Flytt aggregater til Parquet over tid (eldste år eksporteres + leses fra R2)
- [ ] **Frontend lazy-loading av Parquet**: i dag registreres alle ukefiler ved første sidelast. Ved 52+ uker blir oppstartstid og mobildata et problem. Last bare relevante uker basert på query.
- [ ] **R2 object versioning** på prod-DB-fila som de-facto backup (overskrives ellers hver natt)
- [ ] Monitorering/varsling hvis pipeline silently breaks i flere dager (e-post / webhook)
- [ ] Database backup-strategi utover R2-kopien

### Nice-to-have (når tiden tillater)

- [ ] CSV / JSON eksport-endepunkter for bussselskaper og forskere
- [ ] OpenAPI/Swagger-dokumentasjon for `/api/*`
- [ ] URL state persistence på alle sider (refresh skal beholde filtre)
- [ ] Share/copy-link-knapper på reise-, linje- og stoppsider
- [ ] Diagnostics-endepunkt som eksponerer `data/diagnostics/*.json` til frontend
- [ ] Parquet retention/cleanup (etter ~6 måneder)
- [ ] Outlier-håndtering: skille reelle disruption-hendelser fra GPS-feil i >±120 min-forsinkelser

---

## Datakilder

- **SIRI ET**: `ent-data-sharing-ext-prd.realtime_siri_et.realtime_siri_et_last_recorded`
- **NSR Quays**: `ent-data-sharing-ext-prd.national_stop_registry.quays_last_version`
- **NSR Stop Places**: `ent-data-sharing-ext-prd.national_stop_registry.stop_places_last_version`
- **Entur Journey Planner v3 (live trip-search)**: `https://api.entur.io/journey-planner/v3/graphql`
- **Entur Geocoder**: `https://api.entur.io/geocoder/v1/autocomplete`

Tilgang via Google Cloud Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`). Header `ET-Client-Name` er påkrevd av Entur for alle live-kall.

---

## Lisens og attribusjon

Statistikken er bygget på data under **Norsk lisens for offentlige data (NLOD 2.0)** distribuert av **Entur AS**. Selve denne tjenesten er bearbeiding og aggregering av disse dataene — Entur står ikke ansvarlig for tolkning eller fremstilling av tallene.
