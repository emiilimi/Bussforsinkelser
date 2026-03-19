# bussforsinkelser.no

Historisk statistikk over bussforsinkelser i Norge, region for region.
Datakilde: Entur SIRI ET (BigQuery) + NSR (National Stop Registry).

---

## Stack

| Lag | Teknologi |
|---|---|
| Frontend | React + Vite + Tailwind + shadcn/ui + Recharts + Leaflet |
| Backend | Node.js + Express + Drizzle ORM |
| Database | SQLite (better-sqlite3) |
| Pipeline | Python 3.14, pandas, google-cloud-bigquery |
| Hosting | Railway (planned) |

---

## Kjøre lokalt

```powershell
# 1. Sett miljøvariabler
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\gcp-credentials.json"
$env:DATABASE_PATH = "./data/bussforsinkelser.db"

# 2. Sett opp database og stopp-koordinater
python pipeline/db_setup.py
python pipeline/populate_stops.py        # laster fra cache; --refresh tvinger BigQuery-henting

# 3. Hent data (bytt ut datoer etter behov)
foreach ($d in "2026-03-01","2026-03-02","2026-03-03","2026-03-04","2026-03-05","2026-03-06","2026-03-07","2026-03-08","2026-03-09") {
    python pipeline/ingest.py $d
}

# 4. Start utviklingsserver
npm run dev
```

---

## Pipeline-oversikt

```
BigQuery (Entur SIRI ET)
    └── pipeline/ingest.py          Henter én dag, beregner forsinkelser, skriver til SQLite
         ├── daily_summary          Daglig snitt for hele nettet (kun buss)
         ├── line_daily             Per linje per dag per retning
         ├── stop_daily             Per stoppested per dag
         ├── line_hourly_raw        Rådata for timeprofil
         ├── line_hourly_profile    30-dagers rullerende timeprofil (rebuild nightly)
         ├── leaderboard_lines      All-time topplistе linjer (rebuild nightly)
         ├── leaderboard_stops      All-time toppliste stopp (rebuild nightly) — brukes ikke lenger
         └── worst_days             De 100 verste dagene (rebuild nightly)

NSR BigQuery (quays JOIN stop_places)
    └── pipeline/populate_stops.py  Henter stoppkoordinater og -navn, lagrer i stop_coords
         └── data/stop_coords.json  Lokal cache (oppdateres automatisk etter 30 dager)
```

### Filtrering i pipeline

- Kun `dataSource = 'SKY'` (Skyss / Hordaland) — én region om gangen
- Kun rader der `stopPointRef LIKE 'NSR:%'` — filtrerer bort legacy-ruter (f.eks. skolebuss linje 1200 med gamle Rutebanken numeriske ID-er)
- `vehicle_mode` lagres per rad; leaderboards og API-er filtrerer på `vehicle_mode = 'bus'`

---

## Kjente problemer / TODO

### Må fikses før backfill

- [ ] **Re-ingest alle 9 dager** med nåværende kode for å rydde opp `stop_name = "None"` (streng) i `stop_daily` fra en tidligere bug. Kommando:
  ```powershell
  foreach ($d in "2026-03-01","2026-03-02","2026-03-03","2026-03-04","2026-03-05","2026-03-06","2026-03-07","2026-03-08","2026-03-09") { python pipeline/ingest.py $d }
  ```
- [ ] **Kjør `populate_stops.py --refresh`** for å hente ny cache med korrekt spørring (quays JOIN stop_places → quay-ID + stopplassnavn + koordinater). Uten dette vil stoppestedsnavn fortsatt mangle.

### Funksjoner som gjenstår

- [ ] **Reiseprofil-analyse (journey check)** — se "Arkitekturforslag" nedenfor
  - Velg linje → velg retning → velg avgang → se forsinkelse per stopp langs ruten
  - Graf: x-akse = stopperekkefølge med rutetid, y-akse = snitt/maks/min forsinkelse
- [ ] **Linjer per stoppested** — i stoppstedsanalysen: hvilke linjer betjener dette stoppet, og hvor punktlige er de?
  - Krever journey-profil-data (se nedenfor)
- [ ] **Multi-region** — støtte for Ruter, AtB, Skyss mfl. samtidig
  - Avklare: felles DB med `operator`-kolonne, eller separate DB-filer per region?
  - Ruter-data: `stopPointName` er fylt inn i SIRI ET (trenger ikke NSR-oppslag for navn)
  - Skyss-data: `stopPointName` er alltid null — avhengig av NSR-join
- [ ] **Full historisk backfill** for Skyss (2021–i dag) når multi-region-strategi er avklart

### Deployment (Railway)

- [ ] Sett opp Railway-prosjekt med SQLite persistent volume
- [ ] Konfigurer cron-jobb: `python pipeline/ingest.py` kjører kl. 02:00 daglig
- [ ] Sett miljøvariabler: `GOOGLE_APPLICATION_CREDENTIALS`, `DATABASE_PATH`, `BQ_TABLE`
- [ ] Legg inn `data/stop_coords.json` i Railway-volumet (eller kjør `populate_stops.py` ved oppstart)

### Mindre forbedringer

- [ ] `leaderboard_stops`-tabellen brukes ikke lenger (erstattet av live-spørring mot `stop_daily`) — kan fjernes fra schema og pipeline
- [ ] `getLinesAtStop` i `storage.ts` er defekt (feil JOIN) — fikses når journey-data er på plass
- [ ] Ferry-linjer vises fortsatt i leaderboard-linjer for "all-time"-perioden inntil leaderboard-tabellen er rebuilt med nåværende kode

---

## Arkitekturforslag: journey_stop_weekly (sliding window)

For å støtte reiseprofil-analyse uten å sprenge databasen med rådata.

### Problemet
90 dager med rådata per (avgang × stoppested) = ~14M rader for Skyss = ~1.4 GB. For mye.

### Løsning: ukentlige aggregat-buckets

**Tabell: `journey_stop_weekly`**

| Kolonne | Type | Beskrivelse |
|---|---|---|
| `week_start` | TEXT | ISO-dato mandag (f.eks. "2026-03-09") |
| `service_journey_id` | TEXT | Stabil ID for én spesifikk avgang (f.eks. "den 06:15-bussen") |
| `line_ref` | TEXT | |
| `direction_ref` | TEXT | |
| `stop_ref` | TEXT | NSR:Quay:xxxxx |
| `sequence_nr` | INTEGER | Rekkefølge langs ruten |
| `aimed_time` | TEXT | "06:15" — rutetid for visning |
| `avg_delay_min` | REAL | Vektet snitt for uken |
| `max_delay_min` | REAL | |
| `min_delay_min` | REAL | |
| `num_samples` | INTEGER | Antall kjøringer denne uken |

**Primærnøkkel:** `(week_start, service_journey_id, stop_ref)`

**Nightly oppdatering:**
1. Beregn dagens per-(serviceJourneyId × stop) snitt/maks/min fra dagens BigQuery-data
2. UPSERT inn i inneværende ukes bucket med vektet snitt:
   ```sql
   ON CONFLICT DO UPDATE SET
     avg_delay_min = (avg_delay_min * num_samples + excluded.avg_delay_min * excluded.num_samples)
                     / (num_samples + excluded.num_samples),
     max_delay_min = MAX(max_delay_min, excluded.max_delay_min),
     min_delay_min = MIN(min_delay_min, excluded.min_delay_min),
     num_samples   = num_samples + excluded.num_samples
   ```
3. `DELETE WHERE week_start < date('now', '-91 days')` — eldste bucket rulles av automatisk

**Datamengde for Skyss:**
- ~120 linjer × ~25 avganger × ~25 stopp = ~75 000 rader per uke
- 13 uker beholdt: ~975 000 rader totalt = **~80 MB** — helt håndterbart

**Spørring for graf:**
```sql
SELECT stop_ref, sequence_nr, aimed_time,
       ROUND(SUM(avg_delay_min * num_samples) / SUM(num_samples), 2) AS avg_delay,
       MAX(max_delay_min) AS max_delay,
       MIN(min_delay_min) AS min_delay
FROM journey_stop_weekly
WHERE service_journey_id = ?
  AND week_start >= date('now', '-91 days')
GROUP BY stop_ref, sequence_nr
ORDER BY sequence_nr
```

**Nye API-endepunkter som trengs:**
- `GET /api/journeys/:lineref?direction=1` — liste over tilgjengelige avganger (serviceJourneyId + rutetid)
- `GET /api/journey/:journeyid` — full stopprofil for én avgang

---

## Datakilder

- **SIRI ET:** `ent-data-sharing-ext-prd.realtime_siri_et.realtime_siri_et_last_recorded`
- **NSR Quays:** `ent-data-sharing-ext-prd.national_stop_registry.quays_last_version`
- **NSR Stop Places:** `ent-data-sharing-ext-prd.national_stop_registry.stop_places_last_version`
- Tilgang via Google Cloud Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`)
