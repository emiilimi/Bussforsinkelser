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

## 4. Forsinkelsesstatistikken er fortsatt treg — krever et produktvalg

Reisesøket i seg selv er fikset (reiseforslag vises nå etter ~3 s i stedet for
53,6 s — se STATUS.md 2026-08-08). Men *statistikken* på kortene bruker
fortsatt ~30 s (varm DuckDB) til ~83 s (kald sidelast) før den er komplett.

Årsaken er arkitektonisk, ikke en bug: kostnaden er lineær i antall ulike
stopp, det er én DuckDB-worker, og det er et gulv på ~5 s per spørring mot
35–71 MB store parquet-filer på R2. Kostnadsmodellen med målinger står i
CLAUDE.md. To hypoteser er allerede testet og avkreftet (row group-pruning og
`enable_object_cache`).

Den mest lovende veien er et **pipeline-grep, ikke flere frontend-triks**:
eksporter forhåndsaggregerte persentiler per `(stop_ref, line_ref)` som en
liten JSON/parquet-artefakt, slik at nettleseren slår opp i stedet for å regne
persentiler over 54 mill. rader ved hvert søk.

Det er et reelt valg, ikke bare teknikk, og bør diskuteres først:
- Hvilke oppdelinger må forhåndsberegnes (day_type? per time?). Hver dimensjon
  multipliserer artefaktstørrelsen.
- Per-avgang-tallene (`legTimes`, samme rute-ID) kan neppe forhåndsaggregeres
  like enkelt — skal de fortsatt regnes live, eller droppes?

Merk at det døde tidsvindu-filteret er FJERNET (2026-08-08, se punkt 5). Det
gjør forhåndsaggregering enklere: uten vilkårlige brukervalgte datointervaller
holder det å forhåndsberegne faste oppdelinger.

## 5. Tidsvindu-filteret i reiseplanleggeren — fjernet 2026-08-08

Filteret («Statistikkperiode») hadde sju knapper som skrev til `statsTimeWindow`,
men ingen kode leste den noen gang — å endre det gjorde ingenting, samtidig som
metodeboksen påsto at det påvirket statistikken.

Vurdert og valgt bort å koble det opp: `legTimingSql()` og overgangs-gap-
spørringene låser allerede `day_type` til dagtypen for reisedatoen brukeren har
valgt. «Ukedager»/«Helg» ville derfor kunne vise selvmotsigende tall på samme
kort (topplinjen fra reisedatoens dagtype, stopptallene fra en annen). Emilie
valgte å fjerne hele filteret framfor å koble opp bare datointervall-delen.

Metodeboksen sier nå i stedet at statistikken bruker hele datagrunnlaget, og at
tall for din egen avgang/overganger hentes fra dager med samme dagtype.

**Hvis det skal tilbake**: gjør det til et rent datointervall (ikke dagtype), og
koble det til ALLE tre spørringsveiene — persentiler
(`useTripDelayDistribution`), per-avgang (`legTimingSql`) og overgangs-gap
(`computeTransferGaps` i `lib/trip-shared.ts`) — ellers blir det halvsant igjen.
`QueryOptions` har allerede `fromDate`/`toDate`, som i tillegg begrenser hvilke
ukefiler som lastes, så et smalt vindu ville også gjort statistikken raskere.

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