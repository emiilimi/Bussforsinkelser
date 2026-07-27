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

## Rettelse av et tidligere (feil) funn i denne filen

En tidligere versjon av dette dokumentet hevdet at `stop-analysis.tsx` og
`journey-details.tsx` kaller SQLite-baserte endepunkter ubetinget i
reise-bygget. Det var feil — testet med en rå `fetch()` som hoppet forbi
`stats-adapter.ts`, som i praksis fanger opp ALLE disse kallene
(`getQueryFn` i `queryClient.ts` prøver `statsAdapterFetch()` først når
`IS_REISE` er sann) og ruter dem til DuckDB/Parquet, aldri SQLite. Lokal
`data/bussforsinkelser.db` (sterkt utdatert, stopper 2026-05-23) er derfor
irrelevant for reise-bygget — den brukes kun av det gamle "full"-bygget.

Se `STATUS.md` (2026-07-20-oppføringen) for hva som faktisk feilet: ingen
retry-beskyttelse i `standaloneDuckQuery`/`useParquetQuery`-kjeden, kombinert
med at React Query er satt til `retry:false` globalt — fikset samme dag.

## Kjent avvik, ikke rettet — NSR StopPlace-ID mismatch

Entur geocoder resolver "Bergen busstasjon" til `NSR:StopPlace:62356`, men
`stats_stops_map.json` (bygget fra `stop_coords`, populert via
`populate_stops.py`/BigQuery) har fortsatt samme fysiske sted under en eldre
ID, `NSR:StopPlace:30810`. NSR-IDer slås periodisk sammen/erstattes, og
cachen har ikke fanget opp endringen. Gir "Ingen data funnet for dette
stoppestedet" i stoppanalysen for akkurat dette søket, selv om data finnes
under den gamle IDen. `departures.tsx` sitt historiske avgangssøk unngår
problemet ved å hente quay-settet fra en live Entur-spørring i stedet for
`stop_coords`-cachen — samme tilnærming kunne vurderes for stoppanalyse.
Krever trolig `populate_stops.py --refresh` for å friske opp cachen
permanent. Ikke rørt nå — diskuter med Emilie før noen løsning velges.

prøver å trigge en redeploy.