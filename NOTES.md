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

### Scoping med FAKTISKE tall (målt 2026-08-15)

Målt over hele parquet-arkivet slik `aggregate_stats.py` faktisk leser det
(56 dager, 2026-06-19 → 2026-08-14, 63,8 mill. rader med minst én
forsinkelsesmåling):

| Oppdeling | Celler | ≥10 obs | ≥20 obs | ≥30 obs |
|---|---|---|---|---|
| stopp × linje × dagtype × **time** | 1 987 273 | 54,6 % | 41,0 % | 36,7 % |
| stopp × linje × **dagtype** | 309 785 | 62,0 % | 53,2 % | 48,5 % |
| stopp × linje | 190 180 | 53,5 % | 49,5 % | 47,6 % |

**«Bør vi begrense til 7 eller 14 dager av hensyn til DB-størrelse?» — nei,
og premisset er feil.** Tre ting blandes lett sammen:

1. `data/reise.db` er ALLEREDE kappet til 14 dager (`JSD_RETENTION_DAYS`).
   Forhåndsaggregatet legges ikke der — det bygges fra parquet og skrives som
   en ny artefakt ved siden av `stats_*.json`. SQLite-basen vokser ikke uansett
   hva vi velger.
2. R2 har 14 UKER med parquet (`PARQUET_KEEP_WEEKS`), og `aggregate_stats.py`
   leser alle ukefilene — ikke 14-dagersbasen. Vinduet er altså allerede ~8
   uker i dag og vokser mot 14.
3. **Vinduslengden påvirker ikke artefaktstørrelsen i det hele tatt.** Antall
   rader i aggregatet bestemmes av antall CELLER (hvilke dimensjoner vi deler
   på), ikke av hvor mange dager som summeres inn i hver celle. 56 dager gir
   nøyaktig like mange rader som 14 dager — bare med bedre statistikk.

Å korte vinduet ned til 7/14 dager sparer altså ingenting, og koster mye:
samme måling på 14-dagersbasen ga bare **15,6 %** av time-cellene ≥20 obs, mot
41,0 % på 56 dager. Konklusjon: **bruk hele vinduet som er tilgjengelig.**

**Granulariteten er derimot et reelt valg**, og det er der størrelsen ligger:
time-oppdeling gir 6,4× flere rader (2,0 mill. mot 310 k) og har samtidig
DÅRLIGST dekning (41 % mot 53 % med ≥20 obs). P95 på under ~20 observasjoner
er støy. Anbefaling: start på **stopp × linje × dagtype** (310 k rader) og
vurder time-oppdeling først når arkivet er fylt til 14 uker — da bør
time-cellene lande rundt dagens dagtype-nivå.

Gevinsten er uansett strukturell: ÉN sortert artefaktfil (anslagsvis 5–15 MB
ZSTD) i stedet for 16 ukefiler à 35–71 MB. Footer-lesingen ved kaldstart går
fra 16 filer til 1, og oppslaget blir et punktoppslag i stedet for en
`PERCENTILE_CONT` over 54 mill. rader.

Fortsatt uavklart før bygging:
- Per-avgang-tallene (`legTimes`, samme rute-ID) kan neppe forhåndsaggregeres
  like enkelt — skal de fortsatt regnes live, eller droppes?
- Overgangs-gapene (`computeTransferGaps`) er PAR av avganger og passer ikke
  inn i denne celleformen i det hele tatt. De blir liggende live inntil
  videre — og de er en stor del av ventetiden (se punkt 8).
- Celler under obs-terskelen: utelates de fra artefakten (mindre fil, men
  frontend må falle tilbake), eller tas de med og merkes med `n` slik at UI-et
  kan flagge lavt grunnlag? Sistnevnte passer «flagg, ikke skjul»-prinsippet.

Merk at det døde tidsvindu-filteret er FJERNET (2026-08-08, se punkt 5). Det
gjør forhåndsaggregering enklere: uten vilkårlige brukervalgte datointervaller
holder det å forhåndsberegne faste oppdelinger.

## 5. Tidsvindu-filteret — LØST 2026-08-08 (kort fjernet, så koblet opp)

Filteret («Statistikkperiode») hadde sju knapper som skrev til `statsTimeWindow`,
men ingen kode leste den noen gang. Det ble først fjernet, og deretter — etter
avklaring med Emilie — koblet opp for ordentlig med **overstyrings-semantikk**:

- **«Samme dagtype» (standard)**: statistikken låses til dagtypen for
  reisedatoen, som før.
- **Alle andre valg OVERSTYRER dagtype-låsen.** Velger du «Siste 30 dager»
  eller egne datoer, er det datoutvalget som gjelder, og UI-et sier «valgte
  datoer» i stedet for «samme dagtype» (tre steder: filterpanelet,
  overgangsforklaringen og metodeboksen).

Vinduet er koblet til ALLE spørringsveiene, ellers ville det vært halvsant:
persentiler (`useTripDelayDistribution`), per-avgang (`legTimingSql`),
overgangs-gap (alle tre nivåene i `lib/trip-shared.ts`), plan-tre-grafene
(`PlanNodeDetails`) og plan B-kjeden (`useFallbackChain`).

Sentrale biter: `ResolvedStatsWindow` + `statsWindowSql()` i `lib/trip-shared.ts`
(bygger SQL-fragmentet), `resolveStatsWindow()` i `trip-planner.tsx` (gjør
brukervalget om til konkrete datoer/dagtyper). «Siste N dager» regnes fra
FERSKESTE tilgjengelige data, ikke fra dagens dato — ingesten henger etter, og
et vindu målt fra i dag kunne blitt tomt.

Bonus: `fromDate`/`toDate` sendes til `QueryOptions`, som begrenser hvilke
ukefiler DuckDB i det hele tatt åpner. Et smalt vindu gjør derfor statistikken
raskere, ikke bare smalere — relevant gitt punkt 4.

Verifisert mot data: for ett stopp ga uten filter 3589 rader, `day_type`
weekday 2817 og helg 772 — 2817 + 772 = 3589, altså en eksakt partisjonering.

## 6. computeDayType() returnerte «weekday» for ALT — rettet 2026-08-08

Funnet mens tidsvindu-filteret ble koblet opp. `computeDayType()` gjorde
`new Date(input + "T12:00:00")` uansett input-form. Kallene i reiseplanleggeren
sender Enturs `expectedStartTime` («2026-08-08T08:00:00+02:00»), og da ble
strengen «…+02:00T12:00:00» → **Invalid Date** → alle felt NaN → funksjonen falt
gjennom alle sjekkene og returnerte `"weekday"`.

Konsekvens: **all dagtype-filtrering i reiseplanleggeren traff ukedagsdata**,
uansett reisedato. Lørdags-, søndags- og 17. mai-reiser viste ukedagsstatistikk
for både overgangssannsynlighet og per-avgang-estimater. Feilen var stille —
ingen feilmelding, bare litt feil tall.

Rettet i `lib/day-type.ts`: ren dato og fullt tidsstempel parses hver for seg,
og uparsebar input kaster nå i stedet for å falle tilbake på «weekday» (det var
nettopp den stille fallbacken som skjulte feilen). Verifisert: Entur-formatert
lørdag → `saturday`, søndag → `sunday`, 17. mai → `may17`, 1. juledag →
`holiday`.

## 7b. latestAvailableDate() er et FILNAVN-anslag — ikke bruk det som ankerpunkt

Rettet i reiseplanleggeren 2026-08-09, men fellen ligger fortsatt i koden og
gjelder andre sider.

`latestAvailableDate()` (`hooks/use-parquet-query.ts`) leser ikke data. Den tar
nyeste registrerte ukefil og returnerer den ISO-ukens SØNDAG. Kommentaren kaller
det «en øvre tilnærming, aldri for lav» — altså: verdien er alltid lik eller
SENERE enn siste faktiske datadag. Den er gratis (ingen DuckDB-spørring), som er
hele poenget med den.

Men som ankerpunkt for «N dager tilbake» er «for høy» nettopp feil retning:
`fra = anker − (N−1)`, så et anker som ligger for sent skyver vindusstarten like
langt fram og gir stille FÆRRE dager enn brukeren ba om.

Avviket er (ukas søndag − i går) og svinger gjennom uka:

| Søkedag | Avvik | Faktiske dager du får av «Siste 7 dager» |
|---|---|---|
| mandag | 0 | 7 |
| tirsdag (ny ukefil dukker opp) | 6 | **1** |
| onsdag | 5 | 2 |
| … | … | … |
| søndag | 1 | 6 |

Målt søndag 9. august 2026 (data t.o.m. 7. august): anker ble 9. august, «Siste
7 dager» ga 3.–7. august = 5 dager.

**LØST i roten 2026-08-09**: manifestet oppgir nå `maxDate` per fil, lest av
`upload_to_r2.py` fra parquetens radgruppe-statistikk (metadata-only: 6–23 ms
for en 50–70 MB fil). `latestAvailableDate()` bruker den når den finnes, og
faller bare tilbake på filnavn-utledningen for et manifest fra før feltet
fantes. Feltet er valgfritt i begge ender, så gammel/ny klient og gammelt/nytt
manifest virker i alle fire kombinasjoner.

Fordi `daysAgoFromLatest()` i `lib/stats-adapter.ts` kaller samme funksjon, ble
dashboard/topplister/kart riktig uten endringer der — det var nettopp derfor
manifest-varianten ble valgt framfor å måle `MAX(date)` per side.

Et tidligere, mer lokalt forsøk ligger fortsatt i koden som ekstra sikring:
`primeParquetMetadata()` henter `MAX(date)` sammen med `COUNT(*)` (samme
spørring, samme kostnad) og `useLatestDataDate()` eksponerer den. Rekkefølgen i
`resolveStatsWindow()` er målt → manifest → filnavn. Den kan fjernes når alle
manifester i omløp har `maxDate`.

## 8. Rekkefølge på DuckDB-spørringene i reiseplanleggeren — AVKREFTET 2026-08-15

**Ikke prøv «kjør overgangssannsynligheten først» på nytt uten en ny måling.**

Hypotesen var rimelig: «rekker jeg bussen?» er sidens hovedspørsmål, så gapene
burde kjøre før persentilene i stedet for bak dem. Testet på preview mot ekte
R2, identisk metode og samme søk (Lagunen→Åsane, kald sidelast, tid til de
synlige tallene — «~ankomst» og P80 — dukker opp på kortene):

| Rekkefølge | Tid til synlige tall |
|---|---|
| Persentiler først (dagens/gamle kode) | **101 s** |
| Gap først | **149 s** |

Altså ~48 s DÅRLIGERE. Årsaken er DuckDB-workeren: den tar én spørring om
gangen og kan ikke avbrytes. Legger gap-spørringen seg først, betaler DEN
kaldstartkostnaden (footer-lesing av alle ukefiler, jf. kostnadsmodellen i
CLAUDE.md), og persentilene — som driver alt brukeren faktisk ser — havner bak
i køen.

To varianter ble prøvd og forkastet:
- «Vent på ALLE 12 reiseforslags gap»: >2 min, og ett hengende gap blokkerte
  all statistikk permanent (målt 110 s uten et eneste tall).
- «Slipp løs etter FØRSTE gap + 8 s sikkerhetsventil»: hjalp ikke nok. En
  timeout kan flippe et `enabled`-flagg, men ikke ta workeren fra en spørring
  som allerede er i gang.

Beholdt fra samme økt (uavhengig av rekkefølgen, begge fortsatt i koden):
- **Snevrere stoppsett** i `duckPairs`: påstigningsstoppet hentes nå bare for
  FØRSTE transitt-legg når kortet er sammenslått. Byttestoppenes påstigningskø
  ble tidligere hentet for alle reiseforslag uten at noe leste dem før kortet
  ble utvidet. Ren besparelse, ingen synlig endring.
- **P80 justert for overgangsrisiko** (`arrivalQuantileLevel`): ankomsten er en
  blandingsfordeling, så P80 leses av på 0,80/pMakeAll av «alt går etter
  planen». Under 80 % sjanse for å rekke alt finnes ikke P80 i den grenen —
  da vises «P80 = mistet overgang». Dette REGNES OM når gapene lander, så
  tallet blir riktig selv om persentilene kommer først.

Den egentlige flaskehalsen er fortsatt punkt 4 (forhåndsaggregerte
persentiler). Rekkefølge-triks flytter bare ventetiden rundt.

## 7. «Min buss, mitt stopp» — rapport-prototype, IKKE bygget som funksjon ennå

Utforsket 2026-08 som svar på ønske om mer avansert analyse: en personlig
"min buss, mitt stopp"-rapport med faktiske plott (forsinkelsesfordeling,
time-/ukedagsprofil, trend over tid, forsinkelse langs ruten, linje-mot-linje
sammenligning). Prototypen bruker ekte historiske data (linje 20 ved
Krohnsminde, kombinert fra `data/bussforsinkelser.db` og `data/reise.db`,
46 dager) — ikke påfunnet tall — for å vise hva slags innsikt en slik rapport
kunne gi.

**Lagret**: [`prototypes/min-buss-mitt-stopp.html`](prototypes/min-buss-mitt-stopp.html)
(selvstendig HTML, åpnes direkte i nettleser — samme fil som ble delt som
Artifact i samtalen). Datauttrekks-scriptene som genererte tallene er ikke
lagret (kjørt ad-hoc mot begge SQLite-basene); må re-kjøres fra rådata om
prototypen skal oppdateres.

**Emilies tilbakemelding — IKKE løst, diskuter før noe bygges for ekte**:
- Ser "litt for AI-ete" ut — sannsynligvis fargevalg/typografi fra
  dataviz-skillets generiske referansepalett, ikke Sen Turs faktiske
  visuelle språk (shadcn/ui-komponenter, eksisterende Tailwind-tokens/
  fargebruk fra resten av appen).
- Inkonsistent med resten av siden — samme årsak; bør bygges med appens egne
  komponenter (`Card`, `CardContent` osv.) i stedet for frittstående HTML/CSS
  neste gang.
- Mangler transparens — trolig at datakvalitet/metodikk-forbeholdene (datahull,
  ingen kanselleringsdeteksjon, to-database-sammenslåing) sto som løse
  bildetekster i stedet for å følge appens etablerte mønstre for dette
  (InfoTip, `DataQualityFlag`, lenker til `/metode` — se "flagg, ikke skjul"-
  prinsippet brukt i `components/data-quality-flag.tsx`).

Åpent spørsmål for en eventuell ekte implementasjon: datakilde bør trolig være
14-ukers Parquet-arkivet via DuckDB-WASM (samme mekanisme som
`delay-percentiles.tsx` allerede bruker), ikke SQLite direkte — gir mer
historikk uten server-rundtur. Ikke startet.

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