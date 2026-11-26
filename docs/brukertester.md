# Brukertester av reiseplanleggeren — logg

Startet 2026-11-25 etter Emilies ønske: to dager med jevnlige brukertester
(realistiske reisesøk som en vanlig bruker ville gjort), retting av alt som er
klart feil, og flagging av det som er uklart for brukeren. Preview
oppdateres fortløpende: `feat/reise-modell` →
https://feat-reise-modell-reiseplanlegger.emiliemoldestad.workers.dev/reise

Hver runde: 6–10 nye søk (region, tid, modus, adresse/stopp, ankomsttid,
mobilbredde). Status: ✅ rettet · 🟡 trenger beslutning · 🔍 under arbeid.

## Funn

| # | Funn | Hvor | Status |
|---|---|---|---|
| 1 | Overgangsanalysen linje 5 → R13 (Nationaltheatret) viste ankomst 13:49 hver dag mot planlagt 14:14, margin +30 min, 100 %. Ringlinjer passerer samme plattform to ganger på én avgang. | Overgangsanalyse | ✅ `084e60b` (app). Data-modellen slår fortsatt passeringene sammen — se 🟡 A |
| 2 | Plan-grafen: x-aksen gikk baklengs (14:53 → 14:59 → 14:45) og tooltip sa «Nationaltheatret · linje 5 · rutetid 14:59» — samme ringlinjefeil. | Plan-tre-graf | ✅ `084e60b` |
| 3 | Plan-grafen trakk én kurve gjennom alle legg; fallet ved bytte så ut som at toget «tok igjen» forsinkelse (det var neste buss som starter i rute). | Plan-tre-graf | ✅ `084e60b` — én kurve per legg + forklaring |
| 4 | Graf og legg viste «ingen observasjoner for denne linjen ennå» mens statistikken lastet. | Plan-tre | ✅ `084e60b` — «henter …» |
| 5 | Linjevelgeren i Linjeanalyse la seg over hele skjermen (1957 px bred). Tailwind 3-syntaks i Tailwind 4; samme feil i select/tooltip/popover. | Linjeanalyse + flere | ✅ `084e60b` |
| 6 | Nattjobben 25.11: overgangssteget drept to ganger → all reisestatistikk i produksjon falt til DuckDB (40–110 s). | Prod/nattjobb | ✅ appen tåler 2 dagers etterslep. 🟡 B: prod trenger ny kjøring |
| 7 | Bybanen viste ~P50/P80/P95 = rutetid ved hvert stopp (falske 0,0-rader i feeden) — ser ut som Bybanen aldri er forsinket. | Legg-kort | ✅ `1eed8ea` |
| 8 | Forklaringene på merkene (overgang, «mangler data», Tryggest, P80, plan B) lå i `title`-attributter, som aldri vises på mobil. | Kort | ✅ `1eed8ea` — trykk åpner forklaring |
| 9 | Enkel visning: forslag 2 var «14:08 → 14:49» rett under anbefalte «14:08 → 14:45» — samme avreise, senere fremme, aldri et bedre valg. | Enkel visning | ✅ `1eed8ea` — dominerte forslag legges bakerst |
| 10 | «Du rekker byttet nesten alltid, men det gjør ikke noe: mister du det …» — ulogisk. | Enkel visning | ✅ `1eed8ea` |
| 11 | Stoppsøket viser duplikater («Apotek 1 Lagunen» to ganger) og irrelevante treff (Launes, Grimstad når man skriver Lagunen). | Søk | ✅ duplikater fjernes (runde 2). Irrelevante treff: Enturs rangering |
| 13 | «Stavanger busstasjon» gir NULL treff (stedet heter «Stavanger bussterminal»). | Søk | ✅ synonym-reserve ved null treff (busstasjon↔bussterminal, flyplass→lufthavn, togstasjon→stasjon) |
| 14 | «Dra kl. 07:52. Ta buss 22 fra Olav Tryggvasons gate» — nevner ikke at du må gå dit først; leses som at bussen går 07:52. | Enkel visning | ✅ «Gå 4 min til … og ta buss 22 kl. 07:56» |
| 15 | «tidligere mest mer venting» — kronglete. | Enkel visning | ✅ |
| 16 | Utvidet kort i enkel visning: rød tidskolonne uten forklaring. | Enkel visning | ✅ «Grå: rutetid · rød: senest 4 av 5 dager» |
| 17 | Uten frist anbefales 07:45 (fremme 08:44) over 08:00 (fremme 08:47) uten å nevne at du kan dra et kvarter senere for 3 min. | Enkel visning | ✅ «Vil du heller dra senere, kan du dra kl. 08:00 (buss 102) og likevel være fremme innen 08:47» |
| 18 | «Viktig avtale» huskes ikke — nytt søk/side-last går tilbake til «Vanlig dag». | Enkel visning | ✅ Emilie 25.11: skal IKKE huskes — valget gjelder per søk |
| 19 | «Karl Johans gate 22» gir Halden før Oslo uten posisjon. Treffene viser by, og posisjonen brukes når den er kjent. | Søk | lav prioritet |
| 20 | **Fly ble aldri foreslått.** Oslo lufthavn → Trondheim lufthavn ga bare 7–8 timers tog/buss: `air` manglet i standard-transportmidlene, og filteret hadde ingen «Fly»-knapp. | Søk | ✅ fly er med som standard + «Fly» i filteret |
| 21 | Flykort viste «air» der linjenummeret skulle stå (Entur har ingen `publicCode` for fly). | Kort | ✅ flightnummer fra avgangs-IDen («DY750») |
| 22 | «Vær på holdeplassen 3 min før – fly går av og til før tiden» for fly. | Enkel visning | ✅ ingen holdeplass-buffer for fly; i stedet «legg til tid for innsjekking og sikkerhetskontroll» |
| 23 | Forslag uten data kan ikke anbefales — men da ble 10:59 → **19:35** anbefalt uten et ord om at 10:27 er fremme **17:50** etter rutetiden. | Enkel visning | ✅ «Raskere etter rutetiden: kl. 10:27 (tog F6) er fremme 17:50, men vi har for lite data om …» |
| 24 | Fremme kl.-søk: «Det er den seneste avgangen i søket» — høres ut som det kan finnes senere avganger vi ikke har sett på. | Enkel visning | ✅ «Senere avganger er ikke fremme før 09:00 etter rutetiden» |
| 25 | Samme fra og til: «Ingen reiseforslag funnet. Prøv andre stoppesteder …» | Tomtilstand | ✅ «Fra og til er samme sted – velg et annet mål» |
| 26 | Bybanen-reise: «Basert på hvordan de samme avgangene har gått de siste ukene» — men tallene er Bybanen AS sine fra 2023. | Enkel visning | ✅ «Basert på operatørens egne punktlighetstall» når alle legg er slike |
| 27 | Filterknappene «Bat/ferje» (mangler å) og «Flybuss» (er ekspressbuss generelt). | Filter | ✅ «Båt/ferje», «Ekspressbuss» |
| 28 | Trondheim St. Olavs gate → Lian: anbefaler å gå 18 min (07:46) framfor buss + trikk 3 min senere med samme ankomst (byttet holder 98 %). Forsvarlig (ingen bytte), men kan diskuteres. | Enkel visning | lav prioritet |
| 29 | «Tromsø sentrum» i stoppsøket gir bare «Sentrum legekontor». | Søk | lav prioritet (Enturs geokoder) |
| 30 | Utvidet kort: målet viste en annen rød tid enn kortet sa (Bergen → Voss: «fremme innen 09:06», Voss stasjon 09:05). Stopplista brukte linjas samlede tall, kortet avgangens egne + byttene. | Kort | ✅ siste avstigning viser samme tid som kortet |
| 31 | Samme avvik av en annen grunn: kortet kuttet sekundene (00:04:36 → «00:04»), stopplista avrundet (→ 00:05). Tøyen → Stortinget 00:00. | Kort | ✅ kortets ankomst avrundes til hele minutter som stopplista |
| 32 | Nattsøk uten treff (Lillehammer → Gjøvik fremme 02:00): «Prøv andre stoppesteder eller juster filtrene» — hjelper ikke. | Tomtilstand | ✅ «Fant ingen reiser rundt kl. 02:00. Mange steder går det ikke noe om natten – prøv …» |
| 33 | «Førde sentrum» gir først Førde sentrum i **Sveio**; «Kleppestø» gir bare stedsnavnet, ingen kai/stopp. | Søk | lav prioritet (Enturs geokoder) |
| 34 | «tog FLY2» — folk sier «Flytoget». | Enkel visning | ✅ «Flytoget» |
| 35 | Ny bruker ser bare et tomt skjema — ingenting viser hva siden kan før man har funnet to stopp. | Forside | ✅ «Prøv et eksempel – fra nå»: fire ett-trykks søk (Oslo, Bergen, Trondheim, Stavanger) |
| 36 | «Ålesund rutebilstasjon» ga NULL treff; heller ikke busstasjon/bussterminal/skysstasjon. Terminalen heter ulikt fra by til by (Molde trafikkterminal, Gjøvik skysstasjon, Førde rutebilstasjon). | Søk | ✅ reserven prøver alle fem navnene parallelt, krever at stedsnavnet står i stoppnavnet (ellers ga Ålesund → Moa trafikkterminal, 7 km unna), og faller til slutt tilbake på stedet alene («Ålesund») |
| 37 | Fredrikstad → Sarpsborg 23:40: buss 1 00:00 → 00:34, men «Fremme innen **01:34** fire av fem dager». Dataene: 1,3 min FØR rute på nest siste stopp, så **+61 min** på endestasjonen ett minutt senere — på 10 av 22 netter. Fysisk umulig. | Data | 🟡 G — trenger pipeline-fiks |
| 38 | Ferja Halhjem–Sandvikvåg heter «båt 1018», Moss–Horten «båt 1000». Folk sier «ferja». | Enkel visning | ✅ bilferjer (`transportSubmode` *CarFerry*) heter «ferja»; hurtigbåter beholder «båt B10» |
| 39 | Oslo S → Lillehammer fremme 16:00: «senere avganger er for risikable» — men den eneste senere (tog F6 14:02 → 15:59) mangler vi data om; den ble ikke nevnt. | Enkel visning | ✅ «Senere etter rutetiden: kl. 14:02 (tog F6) er fremme 15:59, men vi har for lite data …» + «Det er den seneste avgangen vi har nok data til å regne på» |
| 12 | Full visning: forklaringsboksen nederst snakker om «Parquet (ZSTD)», «DuckDB-WASM», «89. persentil» — teknisk for vanlige brukere. | Full visning | 🟡 C — greit for fornerder.sentur.no? |

## Trenger Emilies beslutning

- **A. Ringlinjer i dataene.** `journey_stop_daily` har én rad per (dato,
  avgang, plattform), så to passeringer blir én rad med første rutetid og
  SNITT av forsinkelsene. Appen bommer ikke lenger, men tallene for slike
  plattformer er en blanding. Riktig fiks: ny nøkkel i ingest (f.eks.
  passeringsnummer) → endret parquet-skjema → må gjennom deploy-rekkefølgen
  (R2 før kode). Stor endring; foreslår å ta den etter testrundene.
- **C. fornerder.sentur.no** — koden gjør nå den tekniske visningen til
  standard på det domenet. Domenet må legges til som custom domain på
  Cloudflare-workeren (Emilie).
- **D. «(anslått)»** på overgangsmerket betyr «få målte dager, supplert med
  hvor presise linjene er hver for seg». Bør vi si det i klartekst i
  stedet, f.eks. «(lite data)»?
- **E. App** — se `docs/app-store.md`. Anbefaling: PWA først.
- **G. Umulige hopp ved endestasjonen.** Ca. 930 rader per uke (av 10 mill.)
  har en ankomstforsinkelse som er >30 min større enn på stoppet før, mens
  stoppet før var <10 min forsinket. 2/3 er på siste stopp, og mange er
  nøyaktig 59–61 min (RUT 353/uke, OST 268, ATB 71, VYG 57). Typisk: bussen
  logger aldri ankomst på endestasjonen, og noe fyller inn en tid en time
  senere. Lite totalt, men samlet på bestemte avganger — buss 1
  Fredrikstad → Sarpsborg 00:00 får P80 = +61 min. Forslag: i
  `compute_delays()` sett ankomstforsinkelsen til NULL når den hopper >30 min
  fra forrige stopp på samme avgang med ≤10 min rutetid imellom; så ny
  eksport + aggregate (gjelder bare nye dager med mindre ukefilene bygges på
  nytt). Rører produksjonsdata, så venter på ja.
- **B. Overgangsfilene i produksjon** er fra 23.11. Start nattjobben på nytt
  (`Start-ScheduledTask -TaskName 'Bussforsinkelser Reise nightly'`) med
  lokket åpent og strøm tilkoblet.

## Runder

### Runde 0 — 2026-11-25 (Emilies egne søk)
Blindern → Asker 14:05 (funn 1–4), Linjeanalyse linjevelger (funn 5).

### Runde 1 — 2026-11-25 ettermiddag (mobil 375 px)
Lagunen → Bergen lufthavn (Bybanen, funn 7), Blindern → Asker i enkel
visning som ny bruker (funn 8–10), stoppsøk «Lagunen» (funn 11).
Førsteinntrykk full visning: overskriften sier ikke hva som skiller siden
fra Entur-appen — den enkle visningen («Når må jeg dra?») gjør det godt.

### Runde 2 — 2026-11-25 kveld (mobil 375 px, enkel visning)
Trondheim S → Gløshaugen fremme 08:15 (funn 14–15), «Stavanger busstasjon»
(13), Stavanger bussterminal → Sandnes 16:30 (ok), Aker brygge → Nesoddtangen
båt 17:10 (ok), Oslo S → Lillestrøm 23:50 over midnatt (ok), Karl Johans gate
22 → Sognsvannsveien 9 adresse 08:00 (16, 19; ingen overflyt), Lillehammer →
Gjøvik «Viktig avtale» (17, 18), Åsane → Haukeland 07:30 med Bybanen-bytte (ok).

### Runde 3 — 2026-11-25 kveld (mobil 375 px, enkel visning)
St. Olavs gate → Lian, trikk 07:40 (28), Oslo lufthavn → Trondheim lufthavn
10:00 (20–23, 27), samme uten fly (23), Holmenkollen → Jernbanetorget fremme
09:00 (24), Jernbanetorget → Jernbanetorget (25), Kristiansand rutebilstasjon
→ Universitetet fremme 08:15 «Viktig avtale» (ok), Bergen busstasjon → Lagunen
01:30 natt til lørdag (26), «Del reisen» (gir «Kopiert» ✓) og «Vis kart»
(kart 292 px, ingen overflyt ✓) på mobil, Prostneset → Tromsø lufthavn 05:30
(ok, «God plass»-merke vises). Stoppsøk: «UiA» finner ikke Universitetet i
Agder, «Tromsø sentrum» (29).

### Runde 4 — 2026-11-25 natt (mobil 375 px, enkel visning)
Bergen stasjon → Voss tog 07:30 (30), Majorstuen → Storo T-bane-ring 08:00
(ok, tidene stiger langs ruten), Strandkaien → Forus adresse→adresse fremme
08:00 (ok, belegg-merker), Bodø sentrum → Nordlandssykehuset 07:20 (ok),
Tøyen → Stortinget 23:55 over midnatt (31), Strandkaien (Bergen) → Kleppestø
båt 16:30 (ok, 33), Lillehammer → Gjøvik fremme 02:00 (32), Majorstuen →
Oslo lufthavn fremme 07:00 «Viktig avtale» (ok: stramt bytte med plan B som
fortsatt rekker; 34).

### Runde 5 — 2026-11-26 natt (mobil 375 px, enkel visning)
«Ålesund rutebilstasjon» (36) → Ålesund (by) → Moa trafikkterminal 07:30
(ok, buss 2), Kristiansand rutebilstasjon → Arendal bussterminal 07:00 (ok:
stramt bytte 8/10 forklart med plan B), Halhjem → Sandvikvåg ferje 08:00
(ok, 38), Oslo S → Frogner plass fremme 17:30 (ok: tog + buss 20, plan B
holder), Bergen lufthavn → Oslo lufthavn fremme 10:00 (ok — «senere avganger
er ikke fremme før 10:00» stemmer: ingen fly 08:00–09:20 torsdag, sjekket mot
Entur), Fredrikstad bussterminal → Sarpsborg stasjon 23:40 over midnatt (37),
Drammen → Kongsberg 06:30 (ok, VY1 merket «mangler data»).

### Runde 6 — 2026-11-26 formiddag (mobil 375 px, enkel visning)
Lerkendal → Trondheim S og Thorvald Meyers gate 50F → Oslo S i rushet
(ok; et passert klokkeslett i lenka flyttes bevisst til «nå» og vises i
Tid-feltet), Fyllingsdalen → Festplassen fremme 09:30 (ok), Madla → UiS
adresse→adresse fremme 09:15 (ok, belegg-merker), Moss → Horten ferje 10:00
(38), Tromsø lufthavn → Prostneset 09:40 (ok), Aker brygge → Nesoddtangen
hurtigbåt (ok, «båt B10»), Oslo S → Lillehammer fremme 16:00 + bytte til
«Viktig avtale» (knappen virker, teksten endres; 39).
