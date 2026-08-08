# Bussforsinkelser — Statusoversikt

> **Hensikt**: Én levende kilde for prosjektets status, datakilder, API, kjente svakheter og endringslogg.
> Oppdateres for hver meningsfull endring. Hierarkisk strukturert per komponent slik at man enkelt kan se historikken til en gitt bit.

**Sist oppdatert**: 2026-08-08

## Endringslogg — 2026-08-08: reisesøket blokkerte på statistikk (målt 53 s → 3 s)

**Symptom**: «Finn reise» føltes ekstremt tregt. Målt (Lagunen→Åsane, 12
reiseforslag): INGENTING vist på skjermen før 53,6 s.

**Rotårsak**: `tripMutation.mutationFn` i `trip-planner.tsx` ventet på en
DuckDB-spørring FØR den returnerte reiseforslagene, så `tripPatterns` ble satt
først når statistikken var ferdig. Entur svarte på ~3 s; resten var venting.
Spørringen var i tillegg en nesten-duplikat av persentil-spørringen
(`useTripDelayDistribution`) — to fulle skann av samme datasett på én
DuckDB-worker — og ga bare snitt-tall som brukes som *fallback* når
persentilene mangler.

Dette er samme klasse feil som `9125b91` (juli) ryddet opp i for
overgangs-/tidsspørringene; den blokkerende spørringen i `mutationFn`
overlevde den runden.

**Fikset**:
- `mutationFn` returnerer nå `{ patterns, cursors }` — ingen DuckDB. Statistikk
  beregnes reaktivt etterpå, som for overgangs-gapene.
- `delayStats`-state + `stats`-propen fjernet. Fallback i `estimatedTimes`
  leser nå P50/P80 fra `duckStats` (persentil-spørringen) i stedet for snitt.
  **Merk tallendring**: P80-fallbacken var `snitt × 1,5` (heuristikk som kun
  fantes fordi den blokkerende spørringen ga snitt); nå brukes det faktisk
  målte aggregerte P80-et. Fortsatt merket «~» siden det gjelder alle avganger
  på linjen ved stoppet, ikke din spesifikke avgang.
- `duckPairs` henter ikke lenger mellomstopp for ALLE reiseforslag på forhånd,
  kun endepunkter (som de sammenslåtte kortene viser) + fulle stopplister for
  UTVIDEDE kort. Målt: 38 → 17 ulike stopp for standardvisningen.
- `placeholderData: keepPreviousData` på persentil-spørringen, så allerede
  hentede tall ikke forsvinner mens det utvidede settet lastes.
- Overgangs-gap-løkken venter nå på `duckStatsFetching`. Den la 12 tunge
  spørringer i kø foran persentil-spørringen; målt ble til og med en
  `SELECT 1` liggende >17 s bak den køen.
- `primeParquetMetadata(family)` (ny, `use-parquet-query.ts`): leser
  parquet-footerne når brukeren velger et stopp, så metadata-kostnaden
  overlapper med utfylling av skjemaet. Tar familie som argument — å prime
  begge legger en unødvendig tung spørring foran den brukeren venter på.

**Resultat (målt, dev mot R2)**: reiseforslag vises etter ~3 s i stedet for
53,6 s. Andre søk i samme økt: statistikken er der nesten umiddelbart.

**⚠️ Fortsatt tregt — ikke løst**: selve statistikken bruker ~30 s (varm
DuckDB) til ~83 s (kald sidelast) før den er komplett. Målingene som forklarer
hvorfor:

| Måling | Tid |
|---|---|
| Første spørring etter sidelast (leser footere for 8 ukefiler) | 45,7 s |
| Samme spørring varm | ~5 s |
| `SELECT COUNT(*)` over 53,9 mill. rader | 1,7 s |
| Ett enkelt `stop_ref` | 1,3 s |
| 38 ulike `stop_ref` | 23 s |

Kostnaden er tilnærmet **lineær i antall ulike stopp** (egne HTTP range-kall
per stopp per ukefil, serielt på én worker), med et gulv på ~5 s per spørring.
Undersøkt og **avkreftet** som årsak: manglende row group-pruning (å legge til
`stop_ref IN (...)` foran OR-kjeden endret ingenting: 23,8 s vs 25,1 s) og
DuckDBs `enable_object_cache` (5,0 s vs 4,9–5,2 s). `by-stop`-ukefilene er
35–71 MB hver.

Ekte fiks krever trolig et pipeline-grep, ikke flere frontend-triks: forhånds-
aggregerte persentiler per (stop_ref, line_ref) som en liten artefakt, slik at
nettleseren slår opp i stedet for å regne over 54 mill. rader.

## Endringslogg — 2026-07-27: produksjonsfix (parquet-URL), Min posisjon, «mulig datafeil»-merking

**🔴 Produksjonsutfall ved overgang til `parquet.sentur.no`**: `VITE_PARQUET_BASE_URL`
hadde et etterslepende mellomrom → `https://parquet.sentur.no%20/manifest.json`
→ `ERR_NAME_NOT_RESOLVED` på alle parquet-/manifest-kall. Eneste synlige symptom
var «Statistikk utilgjengelig». R2-oppsettet var korrekt hele tiden (verifisert
200 + 206 range + `Access-Control-Allow-Origin: *` + `Access-Control-Expose-Headers`).
Fikset i kode: `PARQUET_BASE` gjør nå `.trim()` FØR skråstrek-strippingen, så et
mellomrom i env-variabelen ikke lenger kan velte datalasting.
**Lærdom**: env-variabler som blir til URL-er må trimmes — UI-et for
miljøvariabler i Cloudflare Pages gjør det ikke for deg.

**Kart (rutekart i reiseplanleggeren)**:
- **Start-/målmarkører forvekslet med forsinkelsesfarge**: de var grønn/rød —
  nøyaktig forsinkelsesskalaens ytterpunkter — så endestoppet så «forsinket» ut
  og startstoppet «i rute», uavhengig av om vi hadde data. Nå nøytrale (hvit
  fyll, mørk ring; mål stiplet). Dette var den faktiske årsaken til at bruker så
  «rød» Bergen busstasjon og «grønn» start; ikke få observasjoner, som først antatt.
- Stopp fargelegges kun ved ≥ 5 observasjoner (`MIN_OBS_FOR_COLOR`); tooltip
  viser antall obs. og sier eksplisitt fra ved for få/ingen data.
- Fjernet tooltip på selve rutelinjene (svart felt ved klikk).
- Rullehjul-zoom: var helt av (`scrollWheelZoom={false}`), så desktop-brukere
  kunne i praksis ikke zoome. Nå «klikk i kartet for å aktivere», med
  hint-overlegg — unngår at kartet kaprer sidescrollingen i resultatlista.

**Min posisjon + favoritter/nylige** (`client/src/lib/stop-history.ts`, ny):
Stoppsøket har nedtrekksliste med «Min posisjon» (Geolocation API, norske
feilmeldinger), favoritter (stjerne) og nylig søkte steder. Lagres i
localStorage — **ingen innlogging, ingen server, ingen cookie-banner**: dette er
førsteparts *funksjonell* lagring, ikke sporing. «Min posisjon» lagres bevisst
ikke i historikken (koordinaten er ferskvare).

**«Mulig datafeil»-merking** (`components/data-quality-flag.tsx`, ny):
Etter brukerens prinsipp — *vi filtrerer ikke bort tall som ser urimelige ut, vi
merker dem*, siden det ikke er vår vurdering å gjøre på leserens vegne.
Forsinkelser ≥ 120 min (samme terskel som pipelinens uteligger-logging) merkes nå
med varselikon/tekst på dashboardets «Dårligste linje»-kort, i
dårligste-linjer-grafen, og i topplistenes stopp- og linjetabeller.
Løser audit-punkt #2 (Linje `1_5` med +226,2 min) uten å skjule tallet.

> ⚠️ **Ubesvart spenning**: filteret fra 2026-07-26 som *utelater* ufullstendige
> ingest-dager fra beste/verste-listene er strengt tatt samme «vi bestemmer hva
> som vises»-mønster. Det filtrerer på datamengde (ikke på om verdien ser
> urimelig ut), men bør vurderes gjort om til en merking i stedet.

## Endringslogg — 2026-07-26: Brukervennlighetstest — fikser + kjente svakheter

Omfattende brukervennlighets-/sannhetsaudit av reise-bygget (branch `reise` @
`ce7e015`, testet desktop 1280 + mobil 375). **Metodebegrensning**: skjermbilder
og CSS-animasjoner rendrer ikke i testmiljøet (panelet komposerer ikke frames),
så auditen brukte DOM/computed styles/tekst/nettverk/layout-mål — ikke piksler.

**Fikset (pushet til reise-preview):**
- **#1 Metodeboks utdatert (sannhet):** «Slik beregner vi tallene» på /reise
  beskrev fortsatt det GAMLE 2-nivå overgangssystemet («under 5 dager på
  avgangs-ID → statistikk per linje/stopp»). Omskrevet til dagens 3-nivå
  (stabil id → eksakt rutetid → nabo-pool) + to-spors «Din avgang /
  Sammenlignbare», i tråd med /metode.
- **#3 Ufullstendige dager skjevfordelte beste/verste-lister (sannhet):** en
  halvferdig ingest-dag (f.eks. 24. juli: 0,1 min / 97,6 % i rute / 1
  kansellering) framsto som «Mest punktlige dag». `apiWorstBestDays` i
  `stats-adapter.ts` utelater nå dager med `totalJourneys < 0.5 × median` for
  vinduet (filtrerer på datamengde, ikke forsinkelse — ekte dårlige dager
  beholdes). InfoTip-ene på /worst forklarer utelatelsen.
- **#5 Mobilnav (mobil):** navigasjonen var en horisontal scroll-rad med skjult
  scrollbar (`no-scrollbar`) — 5 av 7 lenker lå usynlig utenfor skjermen.
  Endret til `flex-wrap` på mobil, så alle 7 er synlige.
- **#6 Attribusjon manglet på mobil (NLOD-krav):** NLOD 2.0/Entur-attribusjonen
  var `hidden md:block`. Lagt til en mobil-attribusjonslinje i footeren
  (`md:hidden`), så lisens+kilde vises på alle skjermstørrelser.
- **#8 Intern kilde lekket:** sidemenyen viste «Kilde: ent-data-sharing-ext-prd»
  (rå BigQuery-prosjektnavn). Erstattet med «Historiske sanntidsdata (SIRI ET)
  fra Entur.»
- **#9 Sjargong i metodeboks:** statuspill «DuckDB klar/starter/…» → «Statistikk
  klar/…»; «Beregnet med DuckDB-WASM fra Parquet-filer» → «Regnet ut direkte i
  nettleseren din». Den eksplisitt merkede «Teknisk:»-fotnoten beholder
  DuckDB/Parquet/R2-detaljene (rett sted for det).

**Kjente svakheter — IKKE fikset (skrevet ned etter brukerens ønske):**
- **#2 Dashboard «Dårligste linje: Linje `1_5` +226,2m snitt»:** urimelig
  uteligger (3,7 timer snitt) + misdannet linje-id (`1_5` med understrek = rå
  identifikator lekker gjennom), vist som topp-KPI uten fornuftsfilter.
  Undergraver tillit. Bør filtreres/saneres (sannsynligvis i
  `populate_line_names.py`/`aggregate_stats.py` eller med et
  min-observasjons/max-snitt-filter i leaderboard).
- **#4 Fortidsdato-søk gir misvisende tom-melding:** «Ingen reiseforslag funnet.
  Prøv andre stoppesteder eller juster filtrene» — egentlig fordi Entur ikke
  planlegger reiser bakover i tid. Bør si det.
- **#7 Overgangsanalyse-dialogens sentrering på mobil — UVERIFISERT:** målinger
  antydet at tittel/lukkeknapp lå delvis utenfor skjermen, men entré-animasjonen
  var frosset (panelet komposerer ikke frames), så inkonklusivt. Sjekk på ekte
  mobil.
- **#10 Kart-attribusjonsspråk:** /map bruker engelsk «OpenStreetMap
  contributors», rutekartet norsk «OpenStreetMap-bidragsytere». Triviell.
- **#11 Mørk modus er død kode:** `.dark`-variabler finnes, men ingenting setter
  klassen (ingen bryter, ingen `prefers-color-scheme`) → lys modus i praksis.

**Verifisert OK i auditen:** ingen horisontal sideoverflow på noen av 7 sidene
på mobil; /metode er korrekt og oppdatert; estimater er ærlig merket (~P50);
tom-resultat-melding og feilbanner finnes; datafriskhet vises; rutekartet virker.

## Endringslogg — 2026-07-24: Overgangsanalyse-fikser (henge-bug, feilmelding, ordlyd) + P95/std.avvik på avganger-siden

**🔴 Rotårsak funnet for "henge"-bugen fra i går**: Cloudflare R2 sin offentlige
`.r2.dev`-bucket svarer **429 Too Many Requests** ved høyt volum, og
`duckdb-wasm` sin httpfs-klient ser IKKE ut til å overføre 429-en videre som
en avvist promise — kallet blir stående uten å verken løse seg eller feile.
Reprodusert direkte: samme SQL kjørt i ren Python/DuckDB mot samme R2-URL
feilet raskt og tydelig med `HTTP 429`, mens `duckdb-wasm` i nettleseren hang
på akkurat den spørringen. Trigget i dag av uvanlig høyt automatisert
testvolum (mange sideinnlastninger på kort tid under denne økten) — men
samme sårbarhet kan i prinsippet ramme en vanlig bruker også ved nok samtidig
trafikk, så fiksen under er ment som generell beskyttelse, ikke bare en
engangsløsning. **Kjent begrensning**: tidsavbruddet slutter bare å VENTE på
løftet; det avbryter ikke selve nettverkskallet inni duckdb-wasm sin worker,
så belastningen på R2 reduseres ikke i seg selv — bare det at UI-et står fast
for alltid.

- **Tidsavbrudd på overgangs-gap-spørringer** (`client/src/lib/trip-shared.ts`
  `computeTransferGap`): 15 sek `withTimeout`-wrapper rundt DuckDB-kallet.
  `computeTransferGaps` fanger tidsavbrudd/feil PER overgang (ikke per
  reiseforslag) og setter `source: "none"` for akkurat den — resten av
  reiseforslagets overganger beregnes fortsatt, i stedet for at hele
  reiseforslaget mister sin `gapMap`-oppføring og blir stående på "beregner…"
  for alltid.
- **"Mangler forsinkelsesdata" viste feilaktig mens det egentlig lastet**:
  `TransferAnalysisDialog` sjekket bare om sannsynligheten var beregnet, ikke
  om sidenivå-prefetchen (`gapMap`) i det hele tatt hadde nådd dette
  reiseforslaget ennå. Ny `isPending`-prop (`!gapMap` på kallestedet) viser nå
  "Beregner overgangsdata …" med spinner mens man venter, og reserverer
  "Mangler forsinkelsesdata" til det faktisk er bekreftet tomt. Verifisert i
  nettleser: dialogen åpnet rett før prefetchen var ferdig viste riktig
  lastetekst, ikke feilmeldingen.
- **"Gap" oversatt til "Margin" + "Rakk?" omformulert** i «Vis data»-tabellen:
  kolonnen viser nå `margin = gap − gangtid` (samme størrelse som
  «Overgangsmargin»-filteret, så tallene er direkte sammenlignbare), og
  «Rakk?» er erstattet med et to-linjers kolonnehode «Innenfor / din margin?»
  som eksplisitt viser til margin-kolonnen ved siden av. Dialogens
  toppseksjon endret fra "Planlagt gap X min, hvorav Y min gange" til
  "Planlagt margin X min utover gange (Y min)".
- **«Reiseanalyse» → «Overgangsanalyse»**: knapp, dialogtittel og
  kommentarer i `trip-planner.tsx` samt én referanse i `methodology.tsx`
  omdøpt — navnet beskriver bedre at funksjonen gjelder ett enkelt bytte,
  ikke hele reisen.
- **P95 + standardavvik på avganger-siden** (`client/src/pages/departures.tsx`
  `JourneyDetail`): «hele reisen»-visningen har nå samme
  avkryssingsboks-mønster som reiseplanleggeren (P50/P80/P95/σ, alle på som
  standard). DuckDB-spørringen utvidet med `PERCENTILE_CONT(0.95)` og
  `STDDEV_SAMP` for både avgang og ankomst. Verifisert i nettleser (lokalt
  full-bygg, ingen R2-avhengighet): P95- og σ-kolonnene vises, og
  av-/påslåing av P95-boksen fjerner/viser kolonnen korrekt.

**Verifisert**: `tsc` og `npm run build` rene. Overgangsanalyse-dialogens
tittel, margin-ordlyd og lasteindikator bekreftet i nettleser mot R2-data
(Lagunen→Åsane). «Vis data»-tabellens faktiske tallinnhold (margin-kolonnen
med ekte rader) kunne IKKE reverifiseres i denne økten — R2 var fortsatt
429-rate-limitet ved commit-tidspunktet, mest sannsynlig fra denne øktens
egen høye testvolum. Koden er lest gjennom og typechecker; bør sjekkes
manuelt når R2 har roet seg (normalt innen kort tid uten videre automatisert
trafikk).

**ET-Client-Name → `emiliemoldestad-sentur`**: byttet fra `emiliemoldestad-bussprosjekt` i `functions/api/_entur.ts` (`DEFAULT_ET_CLIENT_NAME`) og de fire hardkodede stedene i `server/routes.ts` (trip/geocoder/departures/servicejourney-proxyene). Docs oppdatert (CLAUDE.md, README uendret, STATUS "gjeldende"-seksjoner). Den daterte 2026-04-12-endringen i historikken beholdt som den var.

**Reiseplanlegger (`client/src/pages/trip-planner.tsx` + nye filer)**:
- **Delt modul `client/src/lib/trip-shared.ts` (ny)**: flyttet trip-typene (`TripLeg`/`TripPattern`/`DuckDelayRow`), gap-SQL (`specificGapSql`/`fallbackGapSql`), `legStops()`, `probFromGaps()` og `minutesToHM()` hit så plan-graf-komponenten og reiseanalyse-dialogen kan gjenbruke dem. Gap-SQL-ene returnerer nå også `date`/`arr_min`/`dep_min` (per-dag-observasjoner, ikke bare rå gap), og primær+fallback UNION-es i **én DuckDB-rundtur** per overgang (`computeTransferGap`) — halverer antall spørringer mot forrige to-sekvensielle mønster.
- **Persentilvelger**: erstattet «Vis reiseanalyse»-knappen (som gjemte P95 bak en per-kort-toggle) med tre avkryssingsbokser (P50/P80/P95) over resultatlista — **alle på som standard**. Styrer hvilke estimatkolonner som vises per stopp på alle kort samtidig. Kollaps av lange stopplister er nå uavhengig av persentilvalget.
- **Reiseanalyse-popup** (`TransferAnalysisDialog`): den store inline-blokken per overgang er krympet til én kompakt rad (%-merke + gangtid + linjer + «Reiseanalyse»-knapp). Dialogen viser de tre sannsynlighetene (2 min / brukermargin / spurt), datakilde, og en **«Vis data»**-tabell med de siste inntil 10 faktiske forekomstene (dato, ankomst, avgang, gap, rakk?). For «specific»-kilde vises faktiske klokkeslett; for «fallback» vises «—» (tallene er fra sammenlignbare naboavganger, ikke akkurat dine avganger).
- **Plan-tre** (`TransferFallbacks` omskrevet): flat Plan B/C/D-liste erstattet med en rekursiv gren-visning (Plan A-rot → «↳ hvis du mister overgangen» → Plan B → «↳ hvis du også mister plan B» → Plan C …), med sannsynlighet på hver gren. Hver plan-node har «Vis graf» som åpner en **forsinkelse-langs-ruten-graf** (`client/src/components/plan-delay-chart.tsx`, ny) — P50/P80/P95 per stopp langs hele reisen med leggegrenser markert, en forbedret utgave av stopp-profilen i avgangsanalysen. Fallback-plan-statistikken tar nå med mellomstopp (ikke bare første/siste) så grafen får full profil.
- **Gap-prefetch for alle forslag**: overgangs-gapene beregnes nå på sidenivå for **alle** reiseforslag, sekvensielt i bakgrunnen, med utvidede kort prioritert først. Kollapsede kort får %-merket fylt inn topp-til-bunn etter hvert som beregningen fullfører (tidligere ventet hvert kort til det ble utvidet). Verifisert i nettleser: utvidelse av et kort som prefetchen alt har nådd viser resultater umiddelbart (ingen «beregner…»).
- **Klikkbart linjenummer → hele avgangen** (`client/src/components/service-journey-detail.tsx`, ny): klikk på linjenr./-navn i et legg åpner HELE avgangens stoppliste (ikke bare reisens delstrekning — f.eks. linje 760 viser alle 88 stopp fra Odda), med rutetid, sanntid og P50/P80/P95 per stopp (samme avkryssingsbokser). Reisens på-/avstigning markeres «(på)»/«(av)». Data (Entur `/api/servicejourney/:id` + DuckDB per-stopp-persentiler) prefetches i bakgrunnen for alle legg i et utvidet kort (`active={expanded}`), så visningen er umiddelbar ved klikk. Rendrer bare tabellen når åpnet.
- **Perrong tydeliggjort**: trip-spørringene (`functions/api/trip.ts` + `server/routes.ts`) henter nå `quay.publicCode`. Perrong vises som badge på på-/avstigningsstopp i leggvisningen og på hvert stopp i «hele avgangen»-visningen. `TripLeg`/`StopEntry`/`legStops()` i trip-shared.ts bærer `platform`.

### 🔴 Rotårsak: overgangs-statistikken har ALDRI brukt de faktiske avgangene

**Symptom**: «Ankomst»/«Avgang» i reiseanalysens «Vis data» sto alltid tomt, og kilden var alltid `fallback` (±60 min-pool av naboavganger) — aldri `specific`.

**Rotårsak**: `specificGapSql` matchet på hele `service_journey_id`. **Skyss' SJ-id er ikke stabil over dager.** Formatet er `SKY:ServiceJourney:{linje}-{datasettversjon}-{avgang}`, og MIDTERSTE ledd endres nesten daglig når ruteplanen republiseres:

```
2026-04-20  SKY:ServiceJourney:20-198135-19135528
2026-04-21  SKY:ServiceJourney:20-200353-19135528
2026-04-22  SKY:ServiceJourney:20-200567-19135528
```

Målt: samme 10:00-avgang på linje 20 hadde **23 ulike SJ-id-er over 35 dager**; 38,9 % av alle SJ-id-er finnes på kun én dato. Terskelen `SPECIFIC_MIN_DAYS = 5` ble derfor nesten aldri nådd, og koden falt stille tilbake til poolen. Dette har vært tilfelle så lenge funksjonen har eksistert — ikke en ny regresjon.

**Siste ledd er derimot stabilt**: `19135528` = hverdagsavgangen 10:00 (13 dager), `19141661` = lørdagsavgangen. Det bytter kun ved ekte ruteendring, som er ønsket — en omlagt avgang skal ikke slås sammen med sin gamle utgave.

**Fiks — tre matche-nivåer** (`computeTransferGap`, UNION-et i én DuckDB-rundtur):
| Nivå | Kilde | Match | Klokkeslett |
|---|---|---|---|
| 1 | `sj` | stabil avgangs-id (`stableSjId()`) + stopp + dagtype | faktisk målte |
| 2 | `aimed` | eksakt rutetid + linje + stopp + retning + dagtype | faktisk målte |
| 3 | `pool` | ±60 min naboavganger (som før) | vises ikke |

Nivå 1 og 2 krever ≥5 dager. Poolen er nå eksplisitt merket i UI med et gult varsel («Ikke dine avganger») både i dialogen og på den kompakte overgangsraden, så den aldri kan forveksles med faktiske observasjoner.

Predikatet bruker `ENDS_WITH(service_journey_id, '-<stabil>')` framfor `REGEXP_EXTRACT` (målt 204 ms mot 235 ms over 7 ukefiler, identisk resultat). Det kan ikke brukes til radgruppe-pruning — pruningen kommer fra `stop_ref`, som er sorteringsnøkkel i by-stop-familien, så disse spørringene MÅ kjøre mot den familien.

**Verifisert**: overgang 760→2080 gikk fra `fallback`/8 dager/tomme tider til `sj`/7 dager med ekte målte klokkeslett (17:20→17:27 mot gap 7,9 min), og sannsynligheten endret seg 88 % → 86 %.

**Verifisert**: `tsc` rent, `npm run build` OK, og manuell nettlesertest mot R2-data (Lagunen→Åsane, 6 forslag): badges fyller inn i bakgrunnen, reiseanalyse-dialog + «Vis data»-tabell + persentil-avkryssing + plan-tre-graf fungerer alle.

## Endringslogg — 2026-07-20: Loading-states, historiske avganger, Parquet-ytelse, og en kort produksjons-outage

**Kontekst**: fortsettelse av en tidligere økt som satt fast (ventet ubesvart på et spørsmålswidget). Startet med opprydding av gjenstående punkter, endte med et ytelsesdykk i Parquet/DuckDB og et rotårsaksfunn for en demo som hang seg opp hos en bruker — som i sin tur avdekket en reell, kortvarig outage forårsaket av denne økten selv (se "Deploy-hendelsen" nederst).

**Loading-states og avganger**:
- `client/src/pages/departures.tsx` + `journey-details.tsx`: fullførte en tidligere økts isLoading-gating (samme mønster som retningsvelgeren) — "laster"-melding i stedet for "ingen data" mens trege DuckDB-spørringer pågår.
- `client/src/pages/departures.tsx`: historisk avgangssøk (dato tilbake i tid) hentet før ingenting, siden Enturs sanntidstavle ikke har data så langt tilbake. Bygger nå en avgangsliste fra egne målte data (`journey_stop_daily` via DuckDB) for valgt dato — faktisk avgangstid, faktisk registrert forsinkelse for dagen, og P50/P80 som normalt. Henter quay-settet ved stoppet fra en live Entur-spørring (ikke fra `stop_coords`-cachen, som kan ha utdaterte StopPlace-IDer — se kjent avvik lenger ned).
- `client/src/lib/RegionContext.tsx`: default operatørfilter endret fra "Skyss" til "Alle operatører". Multi-select-velgeren (`region-selector.tsx`) var allerede på plass.
- `client/src/lib/RegionContext.tsx`: 7 operatørnavn rettet mot Enturs offisielle codespace-liste (Fram, Snelandia, Troms fylkestrafikk, Brakar/Buskerud — Viken er avviklet, Vy Group, Østfold kollektivtrafikk, Nordland fylkeskommune).
- `client/src/components/layout.tsx`: header-tekst i reise-bygget endret fra "reise" til "SenTur.no".
- `client/src/pages/dashboard.tsx`: "Snitt forsinkelse", "Andel i rute" og "Totale avganger" var bundet til `/api/summary` (alltid siste enkeltdag) uavhengig av Uke/Måned/90-dager-velgeren rett over — tallene sto stille ved periodebytte. Bruker nå et vektet snitt over samme `trend`-data som grafen henter for valgt periode.

**Parquet-ytelse — dobbeltsortert eksport (`by-line` / `by-stop`)**:
- Målt: en typisk linje- eller stopp-spørring måtte laste hele ukefiler (~9–12 MB, 23 HTTP-kall) fordi Parquets radgruppestatistikk (min/max) ikke var nyttig for `line_ref`/`stop_ref`-filtre — filene var bare sortert etter innsettingsrekkefølge (~dato). Testet fire alternativer (usortert, stop-sortert, line-sortert, z-order) med en range-loggende HTTP-server foran DuckDBs httpfs; z-order viste seg ubrukelig (ødelegger min/max-clustering på strengkolonner). Riktig sortert familie henter ~0.3 MB i 4–5 HTTP-kall — en ~25–40x reduksjon.
- `pipeline/export_parquet.py`: hver uke skrives nå som to filer med identiske rader, `ORDER BY line_ref/stop_ref`, radgruppestørrelse 122880 (finere pruning enn pyarrows default på ~1M).
- `pipeline/migrate_parquet_sort.py` (ny): engangsmigrering av gamle enkeltfil-uker — kjører mot eksisterende Parquet (ikke SQLite), siden de eldste ukenes kilderader for lengst er prunet fra `journey_stop_daily`. Krever ingen BigQuery-kvote.
- `pipeline/upload_to_r2.py`: `KEEP_WEEKS` teller nå uker, ikke enkeltfiler.
- `client/src/hooks/use-parquet-query.ts`: registrerer begge filfamilier, eksponerer `delays_by_line`/`delays_by_stop`-views. Ny `options`-parameter (`family`, `fromDate`, `toDate`) på `query()`/`standaloneDuckQuery()` lar spørringer begrense hvilke ukefiler som i det hele tatt registreres.
- Alle DuckDB-spørringer i `use-journey-queries.ts`, `stats-adapter.ts`, `departures.tsx`, `trip-planner.tsx`, `delay-percentiles.tsx` oppdatert til å velge riktig familie ut fra sitt primære `WHERE`-filter.

**Rotårsak: demo hang seg opp — manglende retry-beskyttelse**:
- Bruker rapporterte at reise-bygget hang seg opp under en demo. Reprodusert direkte på sentur.no (ikke bare lokalt): `useParquetQuery()`s fil-registreringseffekt satte `initDone.current = true` uansett utfall — ett eneste forbigående nettverksglipp (treg R2-kaldstart, wifi-hikk) låste `ready` på `false` resten av siden, uten retry-vei siden DuckDB-singletonen (`db`) aldri ble `null` igjen for å trigge effekten på nytt.
- Verre for stoppanalyse/linjeanalyse: disse går via `stats-adapter.ts` sine `apiStopStats`/`apiLineStats`, som kaller en egen funksjon (`standaloneDuckQuery`) uten hookens retry-logikk. React Query er satt opp med `retry:false` og `staleTime:Infinity` globalt (`queryClient.ts`) — én mislykket kjøring ble en **permanent cachet feiltilstand** for akkurat det stoppet/linjen, uten noen selvhelbredelse i det hele tatt.
- `client/src/hooks/use-duckdb.ts`: 20s timeout rundt hele DuckDB-init-kjeden (jsDelivr → worker → instantiate), nullstiller `initPromise`/`initError` uansett utfall slik at neste `warmupDuckDB()` faktisk prøver på nytt.
- `client/src/hooks/use-parquet-query.ts`: retry-logikken brakt ut til en delt `registerFilesWithRetry()`-hjelper (backoff 2s/5s/10s), brukt av **alle tre kodeveier**: hooken (reiseplanlegger, avganger), `standaloneDuckQuery` (stoppanalyse, linjeanalyse via adapteren), og `ensureParquetFilesRegistered`. Ny `retry()`-funksjon eksponert fra hooken for manuelt nytt forsøk.
- `client/src/pages/trip-planner.tsx`: "Prøv igjen"-knapp i DuckDB-statusbadgen når automatiske forsøk er brukt opp.
- Verifisert ved å simulere 2 og 4 påfølgende manifest-feil direkte i en levende fane, både lokalt og på selve sentur.no: appen selvhelbreder på ~7s uten brukerhandling, og "Prøv igjen" gjenoppretter umiddelbart selv etter vedvarende feil.

**Deploy-hendelsen (viktig driftslærdom)**:
- Bekreftet at `reise`-branchen har automatisk deploy til Cloudflare på push — ingen GitHub Actions-workflow i repoet (`gh api .../actions/workflows` gir 0 registrerte), sannsynligvis en Cloudflare Workers Builds/Pages-integrasjon som ikke rapporterer tilbake til GitHub sitt Deployments-API. Bekreftet empirisk: JS-bundlenavnet på sentur.no endret seg umiddelbart etter push.
- Dette betyr at kode og data (R2-innhold) **må synkroniseres i riktig rekkefølge** når filnavnformat endres. Denne økten traff akkurat dette: Parquet-sorteringsarbeidet ble pushet og auto-deployet FØR de nye `-by-line`/`-by-stop`-filene ble lastet opp til R2. Den nye frontend-koden hopper stille over filnavn den ikke kjenner igjen (`parseFileName()` returnerer `null`), så `registeredFiles` ble tom — **alle DuckDB-avhengige sider (reiseplanlegger, linjeanalyse, stoppanalyse) var helt nede** med feilen "Ingen parquet-filer tilgjengelig" i noen minutter, inntil R2 ble oppdatert (`python pipeline/upload_to_r2.py --prune` med `R2_ENV_FILE=r2.reise.env`).
- **Lærdom**: ved endringer som krever at frontend og R2-filformat henger sammen, last opp data til R2 FØR koden pushes/deployes — ikke etter. Motsatt rekkefølge (kode før data) gir et vindu med total nedetid for reise-siten siden auto-deploy er umiddelbar.

**Kjent avvik, ikke rettet — NSR StopPlace-ID mismatch**:
- Entur geocoder resolver "Bergen busstasjon" til `NSR:StopPlace:62356`, men `stats_stops_map.json` (generert fra `stop_coords`, populert via `populate_stops.py`/BigQuery) har fortsatt den samme fysiske plassen under en eldre ID, `NSR:StopPlace:30810`. NSR-IDer slås periodisk sammen/erstattes; cachen har ikke fanget opp endringen. Gir "Ingen data funnet for dette stoppestedet" i stoppanalysen for akkurat dette søket, selv om data faktisk finnes under den gamle IDen. `departures.tsx` sitt historiske avgangssøk unngår problemet ved å hente quay-settet fra en live Entur-spørring i stedet for `stop_coords`-cachen (se over) — samme løsning kunne vurderes for stoppanalyse ved en senere anledning. Krever trolig en `populate_stops.py --refresh` for å friske opp cachen permanent.

## Endringslogg — 2026-05-21: Fase 1 — blockers før offentlig promotering

**Mål**: gjøre nettsiden klar til å deles med bussselskaper og publikum. Tre Explore-agenter gikk gjennom hele kodebasen og identifiserte blockers — denne iterasjonen dekker dokumentasjon, data-freshness, backend-sikkerhet og pipeline-rapportering. Plan i `C:\Users\emili\.claude\plans\hi-i-have-recently-async-panda.md`.

**Dokumentasjon — ny `/metode`-side**:
- `client/src/pages/methodology.tsx` (ny): tre-nivå dokumentasjon — "Hva viser nettsiden?" (alle), "Hvordan beregnes tallene?" (lett teknisk: P50/P80/P95, dwell time, dagtype, empirisk overgang, punktlighet), "Detaljert metodikk" (datakjede, aggregeringsnivåer, kvalitetssikring, DuckDB-WASM), pluss en "Begrensninger"-seksjon for kjente svakheter. Ankerseksjoner: `#hva-vises`, `#persentiler`, `#dwell-time`, `#day-type`, `#overgang`, `#punktlighet`.
- `client/src/App.tsx`: ny `/metode`-rute.
- `client/src/components/layout.tsx`: ny "Metode"-lenke i navigasjonen.

**Info-ikoner som lenker til /metode**:
- `client/src/components/info-tip.tsx` (ny): delt `<InfoTip>` med valgfri `learnMoreHref` for "Les mer →"-lenke.
- `client/src/pages/dashboard.tsx`: info-ikoner på "Snitt forsinkelse" og "Andel i rute" → /metode-anker.
- `client/src/pages/journey-details.tsx`: info-ikon på stopprofile-toggle (forklarer Forsinkelse / Forsinkelsesendring / Stopptid) → `#dwell-time`.
- `client/src/pages/departures.tsx`: info-ikon på avgangsliste-headeren forklarer Sanntid-badge og P80-badge → `#persentiler`. P80-badge har nå title-attributt.
- `client/src/pages/worst-lists.tsx`: lokal `<InfoTip>` erstattet med delt komponent. Sentrale tooltips fikk `learnMoreHref`.
- `client/src/pages/trip-planner.tsx`: info-ikon ved overgangs-indikatoren → `#overgang`.

**Data-freshness-indikator**:
- `client/src/components/freshness-badge.tsx` (ny): viser "Sist oppdatert: DD. mmm" i sidebar; hvis data >2 dager gammelt vises oransje varsel "Data ikke oppdatert siden ...".
- `server/routes.ts`: nytt `GET /api/health` returnerer `{ status: "ok"|"stale"|"no_data"|"error", lastIngestDate, staleDays }`. Bruker `getLatestStopDate()` fra storage.

**Backend-sikkerhet og robusthet** (`server/routes.ts`):
- In-memory sliding-window rate limiter (per IP, X-Forwarded-For-aware): `/api/trip` (20/min), `/api/geocoder/autocomplete` (60/min), `/api/departures/:ref` (30/min). Returnerer 429 + `Retry-After`.
- Input-grenser: `text` på geocoder kuttes til 200 tegn, `q` på `/api/stops/search` til 100.
- Operator-whitelist: ny `VALID_OPERATORS` (Set av 19 kjente koder); `parseOperator()` og `parseOperators()` filtrerer mot dette (defense-in-depth selv om alle SQL-queries bruker parameterbinding).
- Sanitering av Entur-feilrespons: erstattet `detail: err.message` / `detail: text` med generiske norske meldinger. Originalfeil logges fortsatt server-side via `console.error`.

**Pipeline — per-operatør coverage-rapport** (`pipeline/ingest.py`):
- Ny `write_ingest_diagnostics()` skriver `data/diagnostics/YYYY-MM-DD-ingest.json` med rader-per-operatør, runtime og advarsler. Logger en synlig WARNING per operatør med 0 rader, slik at Railway-cron-loggen avslører silent partial failures.

**Polish**:
- `client/src/pages/not-found.tsx`: oversatt til norsk ("404 — Siden finnes ikke") + lenke tilbake til forsiden.
- `client/src/pages/trip-planner.tsx`: to `console.warn` gates bak `import.meta.env.DEV`.
- `.env.example`: lagt til R2-vars (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL`) og `VITE_PARQUET_BASE_URL` for frontend-konfig.

**Bevisst utelatt**:
- R2-cron-integrasjon (krever Railway-konfig + bekreftelse på hvor cron er definert).
- Loading skeletons på journey-details profile-chart (lav prio, kan gjøres i ny økt).
- Strukturelle skaleringstiltak (Railway volume, drop av mellomdata-tabeller) — håndteres i fase 2.

## Endringslogg — 2026-05-13: Frontend-tilpasninger for nye datakilder

- `client/src/lib/RegionContext.tsx`: utvidet med støtte for flere nye operatører og regioner.
- `client/src/lib/regionCoords.ts`: lagt til kartsentrum + zoom for nye regioner.
- `client/src/components/layout.tsx`: oppdatert nav og regionvelger for nye datakilder.
- `client/src/pages/delay-map.tsx`: mindre justeringer for multi-operator-visning.
- `client/src/pages/trip-planner.tsx`: videre forbedringer av overgangsanalyse og UI.
- `pipeline/ingest.py`: mindre justering.
- `pipeline/upload_to_r2.py`: refaktorert opplasting til Cloudflare R2.

## Endringslogg — 2026-05-08: Empirisk dag-for-dag overgangssannsynlighet i reiseplanleggeren

Erstatter pooled (stopp, linje) percentil-baserte estimater med per-dag historisk paring:

- **Primær**: matcher BÅDE arriving + departing `service_journey_id` eksakt pluss riktig `day_type`. Gir én observert "gap" per historisk dag der begge avgangene gikk.
- **Fallback**: pooler per `(line, stop, day_type)` når SJ-paret har under 5 observasjoner. Velger rad med aimed-tid nærmest planlagt tid (±60 min).
- Sannsynlighet er nå empirisk: andel historiske dager der faktisk avstand >= gangtid + margin.
- `client/src/lib/day-type.ts` (ny): klient-side `day_type`-beregning (matcher `pipeline/day_type.py`), inkl. hardkodet liste over norske helligdager 2024–2028.
- `client/src/pages/trip-planner.tsx`: UI viser "Snitt over X dager" + kilde. Fjernet utdaterte pooled-helpere (`transferProbabilityFromDist`, `transferProbability`, `transferChance`, `transferColor`).

## Endringslogg — 2026-05-07: Ny avgangsvisning (/avganger)

Ny side: sanntidsavganger fra et valgfritt stoppested, med historisk delay-overlay.

**Backend**:
- `server/routes.ts`: ny `GET /api/departures/:stopPlaceRef?minutes=90&limit=50`. Proxer Entur `stopPlace(id:){estimatedCalls}` GraphQL-query. Støtter både `NSR:StopPlace:` og `NSR:Quay:`-refs. 60s server-cache (LRU, max 200 entries).

**Frontend** (`client/src/pages/departures.tsx`, ny):
- Stopp-søk med 300ms debounce (gjenbruker `/api/stops/search`).
- Tidsvindu-velger (30/60/90/180 min, default 90 min).
- 4 stat-kort fra `/api/stop/:ref` (snitt, σ, % >2 min, totale avganger).
- Avgangsliste: planlagt tid, linjeikon + nummer + destinasjon, sanntid-badge (grønn/gul/rød), P80-badge fra DuckDB-WASM, klikkbar → `/journey`.
- Auto-refresh hvert 60. sekund.
- `client/src/App.tsx`: ny `/avganger`-rute. `client/src/components/layout.tsx`: ny nav-lenke.

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
| `POST /api/trip` | — (Entur proxy) | trip-planner | Cachet 5 min, `ET-Client-Name: emiliemoldestad-sentur` |
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

**Entur API-vilkår**: NLOD 2.0-lisens. `ET-Client-Name: emiliemoldestad-sentur`. ~30 req/min rate limit for trip-queries. Attribusjon lagt til i sidebar.

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
| **Databasefriskhet** | Inneholder nå 18 april - 6. mai med mange tilgjengelige operatører, samt 11. mai med enda flere tilgjengelige oppdateringer.


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
