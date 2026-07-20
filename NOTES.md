# Notater — uavklarte punkter

Denne filen samler punkter som er bevisst IKKE løst ennå, fordi betydningen
er uklar eller krever et produktvalg fra Emilie. Ikke løs disse uten å
diskutere først.

## 1. Avgangsanalyse — "Velg stopp"-dropdown

Opprinnelig tolket som: dropdown for stoppvalg skal vise reelle stopp basert
på faktiske data, ikke en hardkodet/feil liste. Emilie har gitt beskjed om at
dette ble misforstått — riktig betydning er ikke avklart. Ikke gjør endringer
her før dette er avklart i en samtale.

## 2. Stoppanalyse — progressiv/animert avgangsvisning

Ønske om å "plotte avganger per linje og forsinkelse, vis en og en mens det
plottes" — trolig en progressiv/animert visning i stedet for at hele
datasettet dukker opp på én gang. I tillegg ønskes forslag til andre
visualiseringer for denne siden. Krever en designdiskusjon (hvilken graf,
hvilken interaksjon) før implementering.

## 3. Reiseanalyse — ny visning for hele reisen

Tilsvarende stoppanalysen, men for hele reisen: ankomst/avgang per
på-/avstigningsstopp for en valgt reise, ikke bare ett enkelt stopp. Mulig
med en egen "Vis reiseanalyse"-knapp i reiseplanleggeren
([trip-planner.tsx](client/src/pages/trip-planner.tsx)) eller på
avgangssiden. Omfang og plassering i UI-et er ikke avklart.

---

## Sekundært funn (ikke løst, verdt å diskutere)

Under arbeidet med "identisk forsinkelsessnitt for siste uke/måned"
(undersøkt, ingen kode-bug funnet — tidsvinduet brukes korrekt i alle
spørringer jeg sjekket) ble to ting oppdaget som er verdt å se på:

- **Lokal `data/bussforsinkelser.db` er sterkt utdatert** (alle tabeller
  stopper 2026-05-23, ca. 2 måneder gammel i skrivende stund). Gjør det
  vanskelig å teste SQLite-baserte endepunkter lokalt. Ukjent om dette også
  gjelder produksjonsdataene, eller bare denne lokale kopien.
- **`stop-analysis.tsx` og `journey-details.tsx` kaller fortsatt de
  SQLite-baserte endepunktene** (`/api/stop/:stopref`, `/api/line/:lineref`)
  uten `!IS_REISE`-sperre, i motsetning til `departures.tsx` som eksplisitt
  skrur av tilsvarende kall i reise-bygget («ingen SQLite-backend» per
  CLAUDE.md). I reise-bygget (som skal være «full offload») fører dette til
  trege (2–4s) kall som til slutt feiler/gir tomt resultat, med en
  "Laster data..."-spinner som henger unødvendig lenge før "Ingen data"
  vises. Ble ikke rettet nå siden det ikke var en del av de bestilte
  punktene — bør vurderes sammen med Emilie (skal disse sidene også
  bruke Parquet/DuckDB slik `linesAtStop` m.fl. allerede gjør på samme side?).
