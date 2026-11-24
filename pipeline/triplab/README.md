# Reiselaboratoriet (`pipeline/triplab/`)

Tester reiseplanleggeren på **hundrevis av hypotetiske, men realistiske reiser**
i stedet for de få vi tilfeldigvis søker på selv. Startet 2026-11-23 etter
Lyderhornsveien → Øvsttun-feilen (STATUS.md 2026-11-18): appen sa «dra 18:14»
fordi Entur med standard overgangsmargin aldri viste 19:07-reisen med romslig
bytte.

## Kjøring

```bash
# 1. Grunnlag (sjelden — SSB oppdaterer årlig). Skriver data/triplab/places_<region>.json
python pipeline/triplab/fetch_places.py
# 2. Trekk reiser. Samme --seed = samme reiser (sammenlign før/etter en endring)
python pipeline/triplab/sample_od.py --per-region 40 --seed 1
# 3. Søk + avspilling (~5 Entur-kall per reise, ~2,1 s mellom kall; svar caches)
PARQUET_DIR=../Bussforsinkelser/data/reise-parquet python pipeline/triplab/run.py data/triplab/od_s1.json
# 4. Rapport (tekst + data/triplab/report_od_s1.html)
python pipeline/triplab/report.py data/triplab/results_od_s1.jsonl
```

Entur-svar caches i `data/triplab/cache/` (nøkkel = sha1 av spørringen), så
en ny kjøring etter en endring i avspilling eller rapport koster null kall.
Et søk som feilet (nett nede) caches ikke og hentes neste gang.

## Filer

| Fil | Hva |
|---|---|
| `regions.py` | Byområder: bbox, operatør, kuraterte reisemål (geokoder-tekst + type) |
| `fetch_places.py` | SSB befolkning på 250 m-rutenett (WFS) + reisemål → holdeplass (Entur-geokoder) |
| `sample_od.py` | Bosted vektet med bosatte, reisemål vektet med type, frist typisk for typen, 85 % hverdag |
| `run.py` | Entur «fremme kl.» med `transferSlack` None/0/300/600/900, avspilling, beste valg per søkekombinasjon |
| `report.py` | Oppsummering og HTML-rapport (inkl. planlagt → faktisk margin ved bytte) |
| `app_compare.py` | Appens svar (samlet fra `window.__reiseDebug` i nettleseren) mot avspillingen: kalibrering, APP_FOR_TIDLIG/SENT |
| `entur_estimates.py` | Enturs egne anslag mot våre data: `empiricalDelay {p50 p90}` (samferdselsdata.no «Empiriske forsinkelser») og sanntidsprognosen (`snapshot` nå, `evaluate` etter nattjobben) |
| `../replay_trips.py` | Avspillingen (orakelet) + det lille håndlagde korpuset `replay_corpus.json` |

## Avspillingen — hva den antar

- Du står på første stopp 2 min før rutetid.
- Hvert legg får faktisk avgang og ankomst fra parquet (match på linje +
  plattform + planlagt HH:MM — `serviceJourneyId` er ikke stabil hos Skyss).
- Mister du et bytte: det som først når neste stopp fra **samme plattform**,
  samme eller annen linje (`REPLAY_PLAN_B=line` = bare samme linje).
- Bybanen har ingen ekte målinger: regnes som i rute, neste etter 10 min.
- Mangler avgangsraden, telles ikke dagen for det forslaget (`n` < 5 → «uten data»).
- Mangler bare **ankomstraden**, anslås den som planlagt ankomst + forsinkelsen
  ved avgang (~2–4 % av leggene). Å droppe dagen var skjevt: Ruter rapporterer
  ikke alle stopp, og når byttet holdt falt dagen bort, mens et tapt bytte fant
  plan B med data — bare de dårlige dagene overlevde (oslo-010 74 → 5: 0 % på
  4 dager → 60 % på 10).
- Ankomsten som brukes er den nærmest forventet tid, ikke den første etter
  avgang: samme `serviceJourneyId` kan passere en plattform to ganger (linje 5
  snur på Sognsvann).

## Begrensninger vi vet om

- Rutetiden antas lik på alle avspilte dager (samme klokkeslett).
- Plan B ser ikke omveier (gå til en annen plattform/holdeplass, annen trasé).
- Reisemålene er håndplukket (Overpass var nede); ingen vekting etter faktisk
  antall reisende til hvert mål.
- Appens egen beslutning (`decisionCost` + modell-pOnTime) er ikke i løkka
  ennå — rapporten måler hva SØKET gjør mulig, ikke hva appen faktisk velger.

## Veien videre

1. **Appen i løkka.** Kjør `trip-model.ts` (via `tsx`) på de samme
   Entur-svarene og overgangsfilene, så hver reise også får «appen valgte X».
   Da kan vi måle kalibrering (appens pOnTime mot avspilt andel) og flagge
   APP_FOR_TIDLIG / APP_FOR_SENT på hundrevis av reiser, ikke 8.
2. **Regresjonstest.** Fast seed + cachede Entur-svar = deterministisk
   rapport. Lagre nøkkeltall i en `baseline.json` og la en endring i modellen
   vise «+3 reiser bedre, 1 verre» før den merges.
3. **Flere tider per reise.** Samme OD på 3–4 frister (rush, midt på dagen,
   kveld) skiller dårlige forbindelser fra dårlige tidspunkt.
4. **Bedre plan B i orakelet.** Tillat gange til nabo-plattformer (< 200 m)
   og neste rutealternativ fra Entur ved bommet bytte.
5. **Faktiske reisemål.** Når Overpass er oppe: arbeidsplasser og skoler fra
   OSM; eller vekt reisemål med passasjertellinger der vi har dem (KOL/OST).
6. **Andre regioner og operatører.** Datadekning per operatør i rapporten
   viser hvor vi mangler data (f.eks. VYX ekspressbusser).
