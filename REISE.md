# reise.emoldestad.no — egen reiseplanlegger-side

> **Levende dokument.** Claude oppdaterer denne fila etter hvert som faser blir
> ferdige. Sjekk **Statustabellen** for hvor vi er.
> Sist oppdatert: 2026-06-28 (Fase 1–3 kode ferdig).

---

## Hva dette er

En **egen, frittstående nettside** (`reise.emoldestad.no`) som inneholder bare
reiseplanleggeren + avgangsvisningen — bygget fra det samme kodebasen, men
hostet uten den tunge databasen og pipelinen som fyller opp disken din.

Senere utvides den med to nye Entur-aktige funksjoner (kart for gangavstand,
tidligere/senere avganger) og en forenklet analysedel (journey/linje/stopp,
siste 90 dager).

---

## Avgjorte valg (27. juni 2026)

| Spørsmål | Valg |
|---|---|
| Hvor kjører Entur-proxyen? | **Cloudflare Pages Functions** (Workers-runtime, ingen egen server) |
| Repo-struktur | **Eget byggemål i samme repo** (delt kode, ett vedlikeholdspunkt) |
| Hvor mye analyse? | Reiseplanlegger + avganger + **journey + linje + stopp (siste 90 dager)** |
| Rekkefølge | **Pipeline + hosting først**, deretter nye UI-funksjoner |
| R2-bøtte | **Egen ny bøtte** (`reise-parquet`) — holder gammel demo frosset |
| R2 public URL | `https://pub-0644836d41534e3d9ed8d6e056e5d0fb.r2.dev` (= `VITE_PARQUET_BASE_URL`) |
| Gammel demo | `bussforsinkelser.no` blir værende på **Railway** med stale data, urørt |

### Trenger jeg Railway? **Nei.**
- **GitHub Pages** = bare statiske filer, kan ikke kjøre Entur-proxyen → utelukket alene.
- **Cloudflare Pages** = statiske filer **+ Pages Functions** (`/api/*`). Dekker både
  nettsiden og proxyen i ett produkt, samme konto som R2-bøtta.
- **Railway** = alltid-på Node-server. Proxyen er tre tilstandsløse Entur-kall — den
  trenger ingen server eller database. Railway = unødvendig kostnad. **Droppes.**

---

## Hvordan det fungerer i praksis

### Trenger jeg å kjøre noe?

| Situasjon | Hva som skjer |
|---|---|
| **Bruker besøker reise.emoldestad.no** | Cloudflare serverer alt automatisk. Du kjører ingenting. |
| **Daglig oppdatering av forsinkelsesdata** | Kjør 3 kommandoer på din PC (ingest → parquet → upload). Tar ~2 min. Kan automatiseres med Task Scheduler. |
| **Deploy av kodeendringer** | Push til GitHub → Cloudflare Pages bygger og deployer automatisk. |

**Du kjører aldri en server.** Ingen Railway, ingen Express, ingen terminal som
må stå åpen. Cloudflare Pages kjører nettsiden + `/api/*`-proxyen 24/7 for deg.

### Hva betyr «virker på Pages» vs «virker ikke på Pages»?
«Pages» = Cloudflare Pages, der reise-siten hostes. Noen sider fra det fulle
analysenettstedet henter data fra SQLite-databasen via Express — den serveren
finnes **ikke** på Pages. Derfor virker de ikke der ennå.

| Side | Virker på Pages? | Hvorfor |
|---|---|---|
| `/reise` (reiseplanlegger) | ✅ Ja | Bruker kun Entur-proxy + Parquet/R2 |
| `/avganger` (avganger) | ✅ Ja | Live-avganger fra Entur + persentiler fra Parquet |
| `/metode` (metode) | ✅ Ja | Statisk innhold, ingen datakall |
| `/journey` (linjeanalyse) | ⛔ Ikke ennå | Henter fra `/api/lines/all` og `/api/line/:ref` (SQLite) |
| `/stops` (stoppanalyse) | ⛔ Ikke ennå | Henter fra `/api/stop/:ref` og `/api/stops/search` (SQLite) |

Fase 5 porterer de to siste til Parquet/DuckDB slik at de også virker.

---

## Arkitektur

```
reise.emoldestad.no
        │
        │  (statisk SPA: /reise, /avganger, /journey, linje/stopp 90d)
        │  Cloudflare Pages
        │
        ├── /api/trip, /api/departures, /api/geocoder
        │        └─►  Cloudflare Pages Functions   (Entur-proxy, INGEN database)
        │
        └── Parquet-filer + manifest.json
                 └─►  Cloudflare R2 (offentlig bøtte)
                          └─►  DuckDB-WASM i nettleseren
                               (persentiler, overgangs-sannsynlighet, analyse)
```

**Hvorfor er Parquet + nettleser nok?** Reiseplanleggeren har allerede *ingen*
hard avhengighet til SQLite-basen ved kjøretid:
- Ruteforslag (`/api/trip`), avganger (`/api/departures`) og stoppsøk
  (`/api/geocoder`) er bare tilstandsløse proxy-kall til Entur.
- Alle persentiler / overgangs-sannsynligheter / estimerte tider regnes allerede
  ut **i nettleseren** med DuckDB-WASM mot Parquet (`use-parquet-query.ts` leser
  fra `VITE_PARQUET_BASE_URL` → bytt til R2-URL = én env-variabel).
- Journey-analyse er **allerede** 100 % Parquet (`use-journey-queries.ts`
  erstattet de gamle `/api/journey-*`-endepunktene).

Diskproblemet ditt kommer fra **analysedelens** ubegrensede aggregat-tabeller
(`daily_summary`, `line_daily`, `stop_daily`, `*_hourly_raw` …) — som
reiseplanleggeren aldri leser. Den slanke pipelinen dropper alle disse.

---

## Statustabell

| Fase | Beskrivelse | Status |
|---|---|---|
| **1** | Slanket daglig pipeline (kun `journey_stop_daily`) + R2 | 🟡 Pågår (kode klar, venter backfill/bøtte) |
| **2** | Entur-proxy som Pages Functions (+ cursor + pointsOnLink) | 🟢 Kode ferdig (venter deploy) |
| **3** | Eget `reise`-byggemål i repoet (router/sidebar trimmet) | 🟢 Kode ferdig (bygger grønt) |
| 4 | Nye funksjoner: tidligere/senere avganger + Leaflet-kart | ⚪ Ikke startet |
| 5 | `/journey` + `/stops` + linjeanalyse portet til Parquet | ⚪ Ikke startet |

Tegnforklaring: ✅ ferdig · 🟢 kode ferdig · 🟡 pågår · ⚪ ikke startet

---

## Fase 1 — slanket pipeline (PÅGÅR)

### Hva som er laget
- **`pipeline/ingest_lite.py`** — daglig BigQuery → SQLite som skriver **kun**
  `journey_stop_daily`. Gjenbruker `fetch_day` / `compute_delays` /
  `upsert_journey_stop_daily` fra `ingest.py`, så tallene er identiske.
  - Egen, lett base: **`data/reise.db`** (rører ikke `data/bussforsinkelser.db`).
  - Lager schemaen selv (idempotent) — ingen egen `db_setup` nødvendig.
  - Rullende vindu via `JSD_RETENTION_DAYS` (default 90), `VACUUM` hver kjøring
    så fila holdes kompakt.

### Daglig kjøring (runbook)
Kjør disse tre i rekkefølge. Sett `DATABASE_PATH` så hele kjeden bruker den lette basen:

**Engangs:** lag fila `r2.reise.env` i repo-roten (gitignored av `*.env`):
```ini
R2_ACCOUNT_ID=...            # samme som r2.env
R2_ACCESS_KEY_ID=...         # samme
R2_SECRET_ACCESS_KEY=...     # samme
R2_BUCKET=reise-parquet      # NY bøtte
R2_PUBLIC_URL=https://...    # NY bøttas URL (r2.dev nå, evt. custom domene senere)
```

```powershell
$env:DATABASE_PATH = "data/reise.db"
$env:PARQUET_DIR   = "data/reise-parquet"   # EGEN mappe (ikke data/parquet/)
$env:R2_ENV_FILE   = "r2.reise.env"         # EGEN bøtte

# 1) Hent gårsdagen fra BigQuery → journey_stop_daily
python pipeline/ingest_lite.py

# 2) Eksporter nye/ufullstendige uker til data/reise-parquet/*.parquet
python pipeline/export_parquet.py

# 3) Last opp parquet + manifest.json til den NYE bøtta
python pipeline/upload_to_r2.py
```
> **VIKTIG:** `upload_to_r2.py` skriver `manifest.json` til bøtte-roten. Bruker du
> den gamle bøtta overskriver du filene `bussforsinkelser.no`-demoen leser — derfor
> egen bøtte + `R2_ENV_FILE=r2.reise.env`. Shell-variabler vinner alltid over
> fil-verdiene. `R2_PUBLIC_URL` blir også `VITE_PARQUET_BASE_URL` i Fase 3.

### Førstegangs-oppsett (én gang)
```powershell
$env:DATABASE_PATH = "data/reise.db"

# Stoppnavn/-koord (export_parquet JOIN-er mot denne for stop_name i Parquet).
# Leser fra cache (data/stop_coords.json) — ingen BigQuery-kostnad.
python pipeline/populate_stops.py

# Backfill EN UKE av gangen (BigQuery-grenser). Kjør blokka én gang per dag til
# du har dekket ~90 dager. Sett høy retention så pruning ikke sletter eldste dag
# mens ekte dager tikker forbi underveis:
$env:JSD_RETENTION_DAYS = "120"
$from = [datetime]"2026-06-20"; $to = [datetime]"2026-06-26"   # flytt vinduet bakover hver dag
for ($d = $from; $d -le $to; $d = $d.AddDays(1)) {
    python pipeline/ingest_lite.py $d.ToString("yyyy-MM-dd")
    if ($LASTEXITCODE -ne 0) { Write-Host "FEIL på $d" -ForegroundColor Red; break }
}
$env:PARQUET_DIR = "data/reise-parquet"
python pipeline/export_parquet.py        # skriver de nye ukene (inkrementelt)
$env:R2_ENV_FILE = "r2.reise.env"
python pipeline/upload_to_r2.py          # laster opp nye filer + manifest (hopper over uendret)
```
> `ingest_lite.py` er idempotent per dag — kjør dato på nytt uten skade. `export`/
> `upload` er inkrementelle, så du kan kjøre dem etter hver ukes-batch.
> For >2 ukers backfill er BigQuery billigere via `pipeline/backfill.py` (batcher
> måned-for-måned), men den skriver hele aggregat-settet — hold deg til
> `ingest_lite.py` per dag for en ren reise-base.

### Diskbruk — hvordan dette løser problemet
- Gamle pipelinen beholdt ubegrensede aggregat-tabeller **for alltid** → vokste uten tak.
- `ingest_lite.py` lager bare `journey_stop_daily` (rullende 90 dager) + `stop_coords`.
  Det er et **bundet** vindu som ikke vokser over tid.
- Parquet-filene (ZSTD, ~13 ukefiler for 90 dager) er små og beholdes lokalt;
  historikken nettleseren ser ligger på R2.
- Når reise-siten er bekreftet å virke: **slett `data/bussforsinkelser.db`** og den
  gamle pipelinens diskbruk er borte. (Behold den hvis du fortsatt vil ha det
  fulle analysenettstedet lokalt.)

### Gjenstår i Fase 1
- [ ] Opprette ny R2-bøtte `reise-parquet` + gjøre den offentlig → notere public URL.
- [ ] Kjøre førstegangs-backfill + verifisere `manifest.json` på den nye bøtta.
- [ ] (Valgfritt) Beskjære gamle Parquet-uker på R2 + skrive om manifest når >90 dager.
- [ ] Planlagt kjøring (Windows Task Scheduler eller GitHub Action) for de tre stegene.

> ✅ Bekreftet 27. juni: gammel `bussforsinkelser`-bøtte er offentlig og `r2.env`
> er fylt ut (samme konto/nøkler gjenbrukes for den nye bøtta).

---

## Fase 2 — Entur-proxy som Pages Functions (KODE FERDIG)

Portet de tre tilstandsløse Entur-endepunktene fra `server/routes.ts` til
Cloudflare Pages Functions. Ingen database, ingen Express. Ligger i `functions/`:

| Fil | Rute | Erstatter |
|---|---|---|
| `functions/api/trip.ts` | `POST /api/trip` | `app.post("/api/trip")` |
| `functions/api/departures/[stopPlaceRef].ts` | `GET /api/departures/:ref` | `app.get("/api/departures/:stopPlaceRef")` |
| `functions/api/geocoder/autocomplete.ts` | `GET /api/geocoder/autocomplete` | `app.get("/api/geocoder/autocomplete")` |
| `functions/api/_entur.ts` | *(delt modul, ikke rute)* | felles hjelpere/whitelists |

**Nytt vs. Express-versjonen** (forberedt for Fase 4):
- `pageCursor`-input + `nextPageCursor`/`previousPageCursor` i svaret → **tidligere/senere avganger**.
- `pointsOnLink { points }` per leg → **kartgeometri** (Google-encoded polyline).

**Caching:** Cloudflare Cache API i stedet for Express' in-memory `Map`.
Trip 5 min, avganger 60 sek, geocoder 5 min. Den gamle per-IP rate-limiteren er
**fjernet** — Workers-isolater deler ikke minne, så den ville ikke virket. Cache
API demper Entur-lasten; legg ev. på **rate-limiting-regler på Cloudflare-sonen**
(krever sonen på Cloudflare) som produksjonsvern senere.

**Lokal testing** (når du vil prøve før deploy):
```powershell
# Bygg klienten (Fase 3 setter opp reise-bygget; foreløpig vanlig build),
# pek wrangler på output-mappa:
npx wrangler pages dev dist/public --compatibility-date=2024-09-01
```

**Type-sjekk:** `npx tsc -p functions/tsconfig.json` (egen tsconfig, isolert fra
rot-`tsconfig.json` så `npm run check` ikke berøres). ✅ grønn.

> ⚠️ **Reise-bygget MÅ sette `VITE_PARQUET_BASE_URL`** til R2-URL-en. Ellers faller
> `use-parquet-query.ts` tilbake til `/api/parquet/*`, som IKKE finnes på Pages
> (ingen Express). Persentiler ville da bli tomme. Wires i Fase 3.

---

## Fase 3 — eget reise-byggemål (KODE FERDIG, bygger grønt)

`VITE_APP=reise`-flagg gjør det fulle repoet om til den frittstående reise-siten,
uten å røre default-bygget.

**Endringer:**
- `client/src/lib/app-mode.ts` — `IS_REISE`-flagg (fra `VITE_APP`).
- `client/src/App.tsx` — `ReiseRouter`: `/` → redirect `/reise`; ruter `/reise`,
  `/avganger`, `/metode`; alt annet → 404. Default `FullRouter` uendret.
- `client/src/components/layout.tsx` — trimmet sidebar (3 nav-punkter), tittel
  «reise / Reiseplanlegger», operatørvelger skjult (irrelevant uten DB).
- `client/src/pages/departures.tsx` — i reise-modus: stoppsøk via **Geocoder**
  (ikke `/api/stops/search`), DB-baserte statistikk-kort skrudd av.
- `vite.config.ts` — `VITE_APP=reise` → output `dist/reise` + `/api`-proxy i dev.
- `package.json` — `build:reise` og `dev:reise`.

**Produksjon: du kjører INGENTING.** Cloudflare kjører både statiske filer og
`/api/*`-Functions 24/7. Ingen server, ingen terminal, ingen Railway.

**Lokal forhåndsvisning (valgfritt) — én kommando, speiler produksjon:**
```powershell
$env:VITE_PARQUET_BASE_URL = "https://pub-0644836d41534e3d9ed8d6e056e5d0fb.r2.dev"
npm run build:reise                 # → dist/reise/
npx wrangler pages dev dist/reise   # kjører Functions + statisk, som på Pages
```
> Alternativ for hot-reload under utvikling (to vinduer): `npm run dev` (Express
> :5000) + `npm run dev:reise` (vite :5001, proxyer /api → :5000). Kun en
> bekvemmelighet — ikke nødvendig for at noe skal virke.

> ⚠️ **`VITE_PARQUET_BASE_URL` MÅ settes ved bygg** (Cloudflare Pages → Environment
> variables), ellers faller persentilene tilbake til `/api/parquet` som ikke finnes
> på Pages. Verdien er R2-URL-en (se tabellen øverst).

**Cloudflare Pages-prosjekt (når du er klar):**
- Build command: `npm run build:reise`
- Build output directory: `dist/reise`
- Root directory: repo-rot (functions/ ligger der → `/api/*` deployes automatisk)
- Environment variables: `VITE_PARQUET_BASE_URL` = R2-URL, (valgfritt `ET_CLIENT_NAME`)

### Oppdagelse: analysesidene henger mer på SQLite enn antatt
Kartla `/api/*`-kallene i de aktuelle sidene:

| Side | Avhenger av | Status på Pages |
|---|---|---|
| `/reise` (trip-planner) | `/api/geocoder`, `/api/trip`, Parquet | ✅ Virker nå |
| `/metode` (methodology) | ingenting (statisk) | ✅ Virker nå |
| `/avganger` (departures) | `/api/departures` ✅ + Parquet ✅; søk + statkort byttet/av | ✅ Virker (statkort kommer i Fase 5) |
| `/journey` (linjeanalyse) | `/api/lines/all`, `/api/line/:ref` (DB) | ⛔ Fase 5 |
| `/stops` (stoppanalyse) | `/api/stops/search`, `/api/stop/:ref`, `/api/lines/all` (DB) | ⛔ Fase 5 |

> CLAUDE.md-notatet om at journey er «100 % Parquet» gjaldt bare per-stopp-
> profilen (`use-journey-queries.ts`). Selve sidene henter fortsatt linjeliste +
> linjestatistikk fra DB. Fase 5 porterer disse til DuckDB/Parquet (90 dager).

---

## Hva Claude trenger fra deg (hosting-wiring)

Disse er de eneste tingene Claude **ikke** kan gjøre selv — kodebiten er klar:

1. **Ny R2-bøtte:** Opprett `reise-parquet` i Cloudflare R2, gjør den offentlig,
   og noter den offentlige URL-en (`https://pub-XXXX.r2.dev`). Samme R2-konto/
   -nøkler som den gamle bøtta. *(Gammel bøtte + `r2.env` er allerede bekreftet OK.)*
2. **DNS for `emoldestad.no` (i dag hos Domeneshop).** Bøtte-URL-en er usynlig for
   brukere (JS-en henter Parquet i bakgrunnen), så bøtta trenger *ikke* et pent
   domene — `r2.dev` funker nå. Men `r2.dev` er rate-limited/ucachet ("ikke for
   produksjon"), og DuckDB gjør mange små range-requests → custom domene (via
   Cloudflare CDN) er bedre på sikt.
   - **Custom domene på R2 krever at DNS-sonen ligger på Cloudflare** (ikke mulig
     med ekstern CNAME fra Domeneshop).
   - **Anbefalt vei:** legg `emoldestad.no` inn som side i Cloudflare → bytt
     nameservere hos Domeneshop til Cloudflares. ⚠️ Gjenskap eksisterende
     DNS-records (hovedside, e-post/MX, subdomener) i Cloudflare FØR byttet, ellers
     går de ned. Etterpå: `parquet.emoldestad.no` → bøtte og `reise.emoldestad.no`
     → Pages er begge ett klikk.
   - **Nå:** start på `r2.dev` for å komme i gang; flytt sonen til Cloudflare når
     `reise`-subdomenet skal kobles på i Fase 3.
   Gammel `bussforsinkelser.no`-demo på **Railway røres ikke** (annet domene).

---

## Fase 4 — Entur-features + Plan B/C/D (FERDIG 4. juli 2026)

Implementert i denne runden:

1. **Cache-fix (ingen mer force-refresh)**: `manifest.json` inneholder nå
   `{name, md5}` per fil. Klienten henter manifestet med `cache: "no-store"` og
   legger `?v=<md5>` på parquet-URLene — nettleseren henter automatisk ferske
   bytes når filinnholdet endres. Opplasting setter `Cache-Control`:
   parquet = `immutable` (trygt pga. versjonert URL), manifest = `no-cache`.
   **Engangs-tiltak**: kjør neste opplasting med `--all` slik at alle
   eksisterende filer i R2 får riktige headere:
   ```powershell
   $env:PARQUET_DIR = "data/reise-parquet"; $env:R2_ENV_FILE = "r2.reise.env"
   python pipeline/upload_to_r2.py --all
   ```
2. **Tidligere/senere avganger** (hele søket): knapper over/under resultatlisten,
   koblet til `nextPageCursor`/`previousPageCursor`. Nye forslag legges til i
   listen (dedup på tid+linjer).
3. **Bytt avgang per legg**: hvert transit-legg har «Bytt avgang»-knapp som viser
   andre avganger av samme linje fra samme stopp (±5 rundt valgt, via
   `startTime`-parameter på departures-endepunktet — lagt til i både Functions
   og Express). Tidligere avganger som ikke rekkes fra forrige buss er deaktivert;
   senere avganger som bryter neste overgang flagges «rekker ikke neste buss» men
   kan velges — da vises overgangen som **brutt** i rødt og total-sannsynlighet
   blir 0 %. Kjøretid antas lik originalavgangen (hele legget skyves).
4. **Plan B/C/D**: når P(miste overgang) ≥ 5 % søkes en ny reise fra
   overgangsstoppet (avreise = planlagt ankomst + P80-forsinkelse [fallback 5 min]
   + gangtid). Kjeden fortsetter (plan C, D…) til P(trenger neste) < 5 % eller
   maks 4 nivåer. Hver plan viser: trengs-sannsynlighet, egen empirisk
   overgangssannsynlighet, ankomstdelta, og et åpent «Forventet ankomst»-regnestykke
   (vektet snitt). Kjent forenkling (dokumentert i /metode): plan C søkes fra samme
   overgangsstopp som plan B, ikke fra plan Bs egne overganger.
5. **Metode-siden**: reise-modus har nå egne tekster (Skyss-dekning, 90-dagers
   vindu, ren parquet-datakjede uten SQLite-server), eksplisitt regneeksempel for
   `PERCENTILE_CONT`-interpolasjon med 2 datapunkter, full dokumentasjon av
   plan B-matematikken og bytt-avgang-antakelsene, og ny begrensning om
   forenklingene i fallback-kjeden.

## Gjenværende faser (kort)

- **Fase 4b** — Leaflet-kart per reiseforslag som tegner gangstrekk + bussrute
  (dekod polyline fra `pointsOnLink` som proxyen allerede henter). Design basert
  på entur.no sin kartvisning. Avgangssiden: tidspunkt-velger + avgang/ankomst-toggle.
- **Fase 5** — Port `/api/line/:ref`- og `/api/stop/:ref`-logikken fra `storage.ts`
  til DuckDB-WASM-hooks (slik `use-journey-queries.ts` allerede gjorde for journey).
  Linje-/stopp-velgere henter alternativer fra `DISTINCT line_ref`/`stop_ref` i Parquet.
  Merkes tydelig «siste 90 dager».

---

## Filer som hører til dette arbeidet

| Fil | Rolle |
|---|---|
| `pipeline/ingest_lite.py` | **Ny.** Slanket daglig ingest (kun journey_stop_daily) |
| `functions/api/*.ts` | **Ny.** Entur-proxy som Cloudflare Pages Functions (Fase 2) |
| `client/src/lib/app-mode.ts` | **Ny.** `IS_REISE`-byggeflagg (Fase 3) |
| `pipeline/export_parquet.py` | Eksisterende. journey_stop_daily → ukentlig Parquet |
| `pipeline/upload_to_r2.py` | Eksisterende. Parquet + manifest → R2 |
| `pipeline/populate_stops.py` | Eksisterende. Fyller stop_coords (fra cache) |
| `client/src/hooks/use-parquet-query.ts` | Leser Parquet fra `VITE_PARQUET_BASE_URL` |
| `client/src/hooks/use-journey-queries.ts` | Journey-analyse, allerede klient-side |
| `client/src/pages/trip-planner.tsx` | Reiseplanleggeren (`/reise`) |
| `client/src/pages/departures.tsx` | Avgangsvisning (`/avganger`) |
| `server/routes.ts` | Kilde for de 3 proxy-endepunktene (porteres i Fase 2) |
