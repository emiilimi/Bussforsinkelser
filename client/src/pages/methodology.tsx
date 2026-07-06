import Layout from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { IS_REISE } from "@/lib/app-mode";
import {
  BookOpen,
  Calculator,
  Database,
  Info,
  Clock,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";

/**
 * Metode-side: forklarer hva nettsiden viser, hvordan tallene beregnes, og
 * den tekniske metodikken bak. Tre nivåer, samme side. Andre sider lenker
 * til ankerne (#hva-vises, #persentiler, #dwell-time osv.).
 */
export default function Methodology() {
  return (
    <Layout>
      <div className="max-w-3xl mx-auto space-y-8">
        <header className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary p-2.5 rounded-lg">
              <BookOpen className="w-6 h-6" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">Metode og datagrunnlag</h1>
          </div>
          <p className="text-muted-foreground">
            Hvor tallene kommer fra, hva de betyr, og hvordan de er beregnet. Tre nivåer —
            velg etter hvor mye detalj du vil ha.
          </p>
        </header>

        {/* Innholdsfortegnelse */}
        <Card>
          <CardContent className="pt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              På denne siden
            </h2>
            <ol className="space-y-1.5 text-sm">
              <li>
                <a href="#hva-vises" className="text-primary hover:underline">
                  1. Hva viser nettsiden? <span className="text-muted-foreground">(for alle)</span>
                </a>
              </li>
              <li>
                <a href="#hvordan-beregnes" className="text-primary hover:underline">
                  2. Hvordan beregnes tallene? <span className="text-muted-foreground">(litt teknisk)</span>
                </a>
              </li>
              <li>
                <a href="#detaljert-metodikk" className="text-primary hover:underline">
                  3. Detaljert metodikk <span className="text-muted-foreground">(teknisk)</span>
                </a>
              </li>
              <li>
                <a href="#begrensninger" className="text-primary hover:underline">
                  4. Begrensninger og kjente svakheter
                </a>
              </li>
            </ol>
          </CardContent>
        </Card>

        {/* === Nivå 1 === */}
        <section id="hva-vises" className="scroll-mt-8 space-y-4">
          <div className="flex items-center gap-2">
            <Info className="w-5 h-5 text-primary" />
            <h2 className="text-2xl font-bold">1. Hva viser nettsiden?</h2>
          </div>

          <p className="text-muted-foreground leading-relaxed">
            {IS_REISE ? (
              <>
                Dette er en <strong>reiseplanlegger med historisk forsinkelsesstatistikk</strong>.
                Reisesøket henter forslag fra Entur, og beriker dem med hva som faktisk har
                skjedd med de samme avgangene tidligere: Når en buss rapporterer sin faktiske
                tid via sanntidssystemet, sammenlikner vi det med ruteplanen. Differansen
                kalles <strong>forsinkelse</strong> (i minutter), og danner grunnlaget for
                estimerte tider, overgangssannsynligheter og plan B-forslag.
              </>
            ) : (
              <>
                Denne siden viser <strong>historisk forsinkelsesstatistikk</strong> for offentlig
                transport i Norge. Når en buss eller annet kollektivkjøretøy rapporterer sin
                faktiske posisjon og tid via sanntidssystemet, sammenlikner vi det med ruteplanen.
                Differansen kalles <strong>forsinkelse</strong> (i minutter).
              </>
            )}
          </p>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="p-4 rounded-lg bg-muted/40 border border-border space-y-1">
              <div className="text-xs font-semibold uppercase text-muted-foreground">Kilde</div>
              <p className="text-sm">
                Sanntidsdata fra <a href="https://entur.no" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Entur</a>{" "}
                (SIRI ET) — Norges nasjonale knutepunkt for offentlig transportdata.
              </p>
            </div>
            <div className="p-4 rounded-lg bg-muted/40 border border-border space-y-1">
              <div className="text-xs font-semibold uppercase text-muted-foreground">Lisens</div>
              <p className="text-sm">
                Norsk lisens for offentlige data (<a href="https://data.norge.no/nlod/no/2.0" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">NLOD 2.0</a>). Data er bearbeidet og aggregert til statistikk.
              </p>
            </div>
            <div className="p-4 rounded-lg bg-muted/40 border border-border space-y-1">
              <div className="text-xs font-semibold uppercase text-muted-foreground">Operatører</div>
              <p className="text-sm">
                {IS_REISE
                  ? "Forsinkelsesstatistikken dekker foreløpig Skyss (Vestland) — buss og flybuss. Reisesøket dekker hele Norge via Entur."
                  : "19 operatører over hele Norge (Skyss, Ruter, AtB, Kolumbus, Brakar m.fl.). Velg i sidemenyen."}
              </p>
            </div>
            <div className="p-4 rounded-lg bg-muted/40 border border-border space-y-1">
              <div className="text-xs font-semibold uppercase text-muted-foreground">Tidsvindu</div>
              <p className="text-sm">
                {IS_REISE
                  ? "Rullende vindu på inntil 90 dager med rå observasjoner. Statistikken vokser etter hvert som flere dager samles inn — antall dager vises alltid."
                  : "Standard er siste 30 dager. Noen visninger har egne tidsvelgere."}
              </p>
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <h3 className="text-lg font-semibold">Hva betyr de viktigste tallene?</h3>

            <Term name="Forsinkelse (minutter)">
              Faktisk tid minus planlagt tid. Positiv = bussen var sen, negativ = bussen var tidlig.
              Vi tar utgangspunkt i avgangstiden fra hvert stopp.
            </Term>

            <Term name="Snitt forsinkelse">
              Gjennomsnittet av alle observerte forsinkelser i tidsvinduet. Et tall på{" "}
              <em>2,1 min</em> betyr at en bussavgang i snitt var 2 minutter og 6 sekunder sen.
            </Term>

            <Term name="Andel i rute (%)">
              Andel avganger som var mellom <em>1 minutt tidlig</em> og <em>3 minutter sen</em>.
              Dette er en vanlig definisjon i kollektivbransjen for "punktlig".
            </Term>

            <Term name="Andel mer enn 2/5/10 min sen">
              Andel avganger med forsinkelse over den oppgitte grensen. Brukes på topplister
              for å fange opp problematiske stopp eller linjer.
            </Term>
          </div>
        </section>

        {/* === Nivå 2 === */}
        <section id="hvordan-beregnes" className="scroll-mt-8 space-y-4 pt-4 border-t border-border">
          <div className="flex items-center gap-2">
            <Calculator className="w-5 h-5 text-primary" />
            <h2 className="text-2xl font-bold">2. Hvordan beregnes tallene?</h2>
          </div>

          <div id="persentiler" className="scroll-mt-8 space-y-3">
            <h3 className="text-lg font-semibold">Persentiler: P50, P80 og P95</h3>
            <p className="text-muted-foreground leading-relaxed">
              Når noe varierer mye, er gjennomsnittet alene misvisende. En busslinje kan ha
              snitt på 1 minutt forsinkelse, men hver tiende avgang kan være 15 minutter sen.
              Derfor bruker vi <strong>persentiler</strong>:
            </p>
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 space-y-1">
                <div className="font-bold text-emerald-900">P50 (median)</div>
                <p className="text-xs text-emerald-900/80">
                  Halvparten av avgangene er bedre, halvparten dårligere. En "typisk dag".
                </p>
              </div>
              <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 space-y-1">
                <div className="font-bold text-amber-900">P80</div>
                <p className="text-xs text-amber-900/80">
                  4 av 5 avganger er bedre enn dette. Et godt mål på "ganske dårlig dag".
                </p>
              </div>
              <div className="p-4 rounded-lg bg-rose-50 border border-rose-200 space-y-1">
                <div className="font-bold text-rose-900">P95</div>
                <p className="text-xs text-rose-900/80">
                  19 av 20 avganger er bedre enn dette. Worst case du må regne med.
                </p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Eksempel: Hvis vi viser "P80 = 7 min" for en avgang, betyr det at det er
              omtrent 80 % sjanse for at neste avgang er mindre enn 7 minutter sen.
            </p>
            <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-900 dark:text-amber-200 space-y-2">
              <p className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" />
                Viktig: persentiler med lite data
              </p>
              <p>
                Persentiler beregnes med <code>PERCENTILE_CONT</code> (kontinuerlig
                interpolasjon): observasjonene sorteres, og persentilen leses av på posisjon{" "}
                <code>p × (n − 1)</code> i den sorterte listen. Havner posisjonen mellom to
                observasjoner, interpoleres det <em>lineært</em> mellom dem. Persentilen er
                altså ikke nødvendigvis en verdi som faktisk er observert.
              </p>
              <div className="p-2.5 rounded bg-amber-100/60 dark:bg-amber-900/30 font-mono text-xs space-y-1">
                <p className="font-sans font-semibold">Regneeksempel med bare 2 dager (1,0 min og 5,0 min forsinkelse):</p>
                <p>P50 = 1,0 + 0,50 × (5,0 − 1,0) = <strong>3,0 min</strong> — midtpunktet</p>
                <p>P80 = 1,0 + 0,80 × (5,0 − 1,0) = <strong>4,2 min</strong> — 80 % av veien mot verste dag</p>
                <p>P95 = 1,0 + 0,95 × (5,0 − 1,0) = <strong>4,8 min</strong> — nesten lik verste dag</p>
              </div>
              <p>
                Med 2 datapunkter er "P80" altså bare et punkt på linjen mellom beste og verste
                dag — ikke et statistisk estimat på noe som helst. Tallene ser presise ut
                (4,2 min!), men presisjonen er en illusjon: en tredje dag kan flytte alt.
                Først med flere titalls dager begynner persentilene å beskrive en faktisk
                fordeling.
              </p>
              <p>
                Vi viser alltid antall observasjoner tallene er basert på. Tommelfingerregel:
                under 5 dager = upålitelig, 10–30 dager = brukbart, 30+ dager = solid.
              </p>
            </div>
          </div>

          <div id="dwell-time" className="scroll-mt-8 space-y-3 pt-2">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <Clock className="w-4 h-4 text-muted-foreground" />
              Dwell time (stoppetid)
            </h3>
            <p className="text-muted-foreground leading-relaxed">
              <strong>Dwell time</strong> er hvor lenge bussen står stille på et stoppested —
              fra den åpner dørene til den kjører videre. Vi måler dette i sekunder. Et høyt
              dwell time på et bestemt stopp kan tyde på mange påstigninger (rushtid, populært
              knutepunkt) eller infrastruktur som bremser flyten (smal vei, billettering).
            </p>
          </div>

          <div id="day-type" className="scroll-mt-8 space-y-3 pt-2">
            <h3 className="text-lg font-semibold">Dagtype-segmentering</h3>
            <p className="text-muted-foreground leading-relaxed">
              Hverdager, lørdager og søndager har ofte ulikt rutemønster og trafikkmengde. For
              å unngå at lørdagstall sløver hverdagsstatistikken, segmenterer vi etter{" "}
              <strong>dagtype</strong>:
            </p>
            <ul className="text-sm text-muted-foreground space-y-1 ml-4 list-disc">
              <li><strong>Hverdag</strong> — mandag til fredag (ekskl. helligdager)</li>
              <li><strong>Lørdag</strong></li>
              <li><strong>Søndag</strong></li>
              <li><strong>Helligdag</strong> — norske offentlige helligdager (1. mai, 17. mai, jul, påske, m.fl.)</li>
              <li><strong>17. mai</strong> — egen kategori pga. parade og kraftig avvikende rutemønster</li>
            </ul>
            <p className="text-sm text-muted-foreground">
              Når du ser statistikk på en avgang, beregnes den fra historiske dager med samme
              dagtype som datoen du ser på.
            </p>
          </div>

          <div id="overgang" className="scroll-mt-8 space-y-3 pt-2">
            <h3 className="text-lg font-semibold">Empirisk overgangssannsynlighet</h3>
            <p className="text-muted-foreground leading-relaxed">
              I reiseplanleggeren viser vi sannsynligheten for at du faktisk{" "}
              <strong>rekker en overgang</strong> mellom to busser. Dette er ikke et estimat
              basert på snitt-forsinkelser, men en <strong>empirisk telling</strong>:
            </p>
            <ol className="text-sm text-muted-foreground space-y-2 ml-4 list-decimal">
              <li>
                Vi finner alle historiske dager (med samme dagtype) der både den ankomne
                avgangen og den påfølgende avgangen faktisk gikk.
              </li>
              <li>
                For hver av disse dagene måler vi den faktiske avstanden mellom ankomst og
                neste avgang.
              </li>
              <li>
                Vi teller hvor mange av dagene som hadde mer enn nok tid til å rekke overgangen
                (inkl. din valgte gangtid + sikkerhetsmargin).
              </li>
              <li>
                Andelen blir sannsynligheten. <em>"Snitt over 47 dager: 82 %"</em> betyr at
                samme overgang har gått 82 % av historiske dager.
              </li>
            </ol>
            <p className="text-sm text-muted-foreground">
              Hvis vi ikke har nok data på akkurat din avgangs-ID, faller vi tilbake til
              statistikk per (linje, stopp, retning, dagtype) — uthevet i hvor tallene kommer
              fra. Retningen leses fra hvordan den planlagte avgangen selv er registrert i
              dataene, siden noen plattformer trafikkeres i begge retninger av samme linje.
              I fallback-modusen sammenlikner vi <strong>forsinkelser</strong>, ikke absolutte
              klokkeslett: for hver historisk dag finner vi en sammenliknbar ankomst og avgang
              (nærmest i rutetid, samme retning), og regner{" "}
              <code className="text-xs bg-muted px-1 rounded">
                gap = planlagt gap + (avgangsforsinkelse − ankomstforsinkelse)
              </code>
              . Dette er viktig for sjeldne linjer: sammenliknet man klokkeslett direkte,
              kunne dagens nærmeste registrerte avgang være en <em>tidligere</em> rute enn
              den du skal rekke — og en romslig overgang ville feilaktig vist 0 %.
            </p>
            <p className="text-sm text-muted-foreground">
              <strong>Kjent begrensning:</strong> sammenlikningen skjer per <em>plattform</em>{" "}
              (NSR-quay). Går samme linje i samme retning fra en annen plattform enkelte
              dager (typisk sporendringer for tog), faller de dagene ut av grunnlaget —
              det gir færre dager med data, men aldri feil tall. Busser har normalt fast
              plattform, så dette rammer i praksis mest skinnegående transport.
            </p>
            <p className="text-sm text-muted-foreground">
              Med få observasjoner (f.eks. 1–2 dager) blir sannsynligheten enten 0 % eller
              100 % — det finnes ingen mellomting når du teller binært over én dag. Dette
              kan se motstridende ut (f.eks. 0 % med margin, men 100 % med spurt), men er
              logisk korrekt: den ene dagen var gapet akkurat stort nok til å rekke ved
              spurt, men ikke stort nok med gangfart + margin. Antall dager vises alltid
              slik at du kan vurdere påliteligheten selv.
            </p>
          </div>

          {IS_REISE && (
            <div id="plan-b" className="scroll-mt-8 space-y-3 pt-2">
              <h3 className="text-lg font-semibold">Plan B/C/D: hva skjer hvis du mister overgangen?</h3>
              <p className="text-muted-foreground leading-relaxed">
                Når sannsynligheten for å miste en overgang er over 5 %, viser reiseplanleggeren
                automatisk hva alternativet ditt er. Slik beregnes det:
              </p>
              <ol className="text-sm text-muted-foreground space-y-2 ml-4 list-decimal">
                <li>
                  Vi anslår når du realistisk står på overgangsstoppet hvis bussen er sen:{" "}
                  <em>planlagt ankomst + P80-ankomstforsinkelse + gangtid</em>. Mangler vi
                  P80-data antas 5 minutter (dette merkes i visningen).
                </li>
                <li>
                  Fra det tidspunktet søker vi en ny reise fra overgangsstoppet til
                  destinasjonen via Entur — tidligst 1 minutt etter avgangen du mistet,
                  og aldri samme avgang (serviceJourney) som en plan vi allerede har
                  regnet med. Første brukbare forslag blir <strong>plan B</strong>.
                </li>
                <li>
                  <strong>Ren gange vurderes alltid</strong>: er det raskere å gå til
                  destinasjonen enn å vente på neste buss, blir gange planen (gange
                  påvirkes ikke av forsinkelser, så kjeden slutter der). Neste buss vises
                  likevel som alternativ for de som heller vil vente — men den teller
                  ikke med i forventet ankomst. Gåtiden beregnes av Entur langs faktisk
                  gangnett med ganghastigheten du selv har valgt i filtrene; tilbyr ikke
                  hovedsøket gange, gjør vi et eget rent gangesøk.
                </li>
                <li>
                  Plan B får sin egen empiriske overgangssannsynlighet (samme metode som
                  hovedreisen). Er sjansen for at du trenger enda et alternativ fortsatt over
                  5 % — dvs. P(miste opprinnelig) × P(miste plan B) ≥ 5 % — henter vi{" "}
                  <strong>plan C</strong> (første avgang etter plan B), og så videre.
                </li>
                <li>
                  <strong>Forventet ankomst</strong> beregnes som et vektet snitt:{" "}
                  <code className="text-xs bg-muted px-1 rounded">
                    P(plan A) × ankomst_A + P(plan B) × ankomst_B + …
                  </code>{" "}
                  Hele regnestykket vises i visningen, ledd for ledd.
                </li>
              </ol>
              <p className="text-sm text-muted-foreground">
                <strong>Forenkling du bør kjenne til:</strong> plan C søkes fra <em>samme</em>{" "}
                overgangsstopp som plan B (neste avgang derfra) — ikke fra plan Bs eventuelle
                egne overgangsstopp. Det dekker det vanlige tilfellet der alternativene er
                påfølgende avganger fra stoppet du står på, men er ikke en full sannsynlighetsmodell
                over alle mulige forgreninger.
              </p>
              <h4 className="text-base font-semibold pt-1">Bytte av avgang på et enkelt legg</h4>
              <p className="text-sm text-muted-foreground">
                Du kan bytte en enkelt del av reisen til en tidligere eller senere avgang av
                samme linje ("Bytt avgang"). Da antar vi at kjøretiden er identisk med den
                opprinnelige avgangen, og skyver hele legget tilsvarende. Bytter du et legg
                midt i reisen slik at gapet til neste buss blir mindre enn gangtiden, flagges
                overgangen som brutt i rødt — vi skjuler den ikke.
              </p>
            </div>
          )}

          <div id="punktlighet" className="scroll-mt-8 space-y-3 pt-2">
            <h3 className="text-lg font-semibold">Definisjonen av "punktlig"</h3>
            <p className="text-muted-foreground leading-relaxed">
              Vi regner en avgang som <strong>punktlig</strong> hvis den er mellom 1 minutt
              tidlig (-1) og 3 minutter sen (+3). Dette er den vanligste definisjonen i
              kollektivbransjen, men ikke universell — noen operatører bruker andre vinduer
              (f.eks. -1 til +5).
            </p>
          </div>
        </section>

        {/* === Nivå 3 === */}
        <section id="detaljert-metodikk" className="scroll-mt-8 space-y-4 pt-4 border-t border-border">
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-primary" />
            <h2 className="text-2xl font-bold">3. Detaljert metodikk</h2>
          </div>

          <div className="space-y-3">
            <h3 className="text-lg font-semibold">Datakjede</h3>
            {IS_REISE ? (
              <p className="text-muted-foreground leading-relaxed text-sm">
                Hver natt henter vi forrige dags rådata fra Enturs BigQuery-tabell{" "}
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                  realtime_siri_et.realtime_siri_et_last_recorded
                </code>{" "}
                (SIRI ET = Service Interface for Real time Information / Estimated Timetable).
                Vi sammenlikner faktisk avgangs-/ankomsttid med planlagt tid, kvalitetssikrer
                dataene, og lagrer rå observasjoner per (avgang, stopp, dag) i et rullende
                90-dagers vindu. Disse eksporteres som ukentlige Parquet-filer til Cloudflare
                R2. <strong>All statistikk beregnes i nettleseren din</strong> med DuckDB-WASM
                direkte mot Parquet-filene — det finnes ingen statistikk-server.
              </p>
            ) : (
              <p className="text-muted-foreground leading-relaxed text-sm">
                Hver natt henter vi forrige dags rådata fra Enturs BigQuery-tabell{" "}
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                  realtime_siri_et.realtime_siri_et_last_recorded
                </code>{" "}
                (SIRI ET = Service Interface for Real time Information / Estimated Timetable).
                Vi sammenlikner faktisk avgangs-/ankomsttid med planlagt tid, kvalitetssikrer
                dataene, og lagrer i en SQLite-database. Aggregerte data eksporteres til
                Parquet-filer for klient-side persentilberegning via DuckDB-WASM i nettleseren.
              </p>
            )}
          </div>

          <div className="space-y-3 pt-2">
            <h3 className="text-lg font-semibold">{IS_REISE ? "Datagrunnlag" : "Aggregeringsnivåer"}</h3>
            <div className="space-y-2 text-sm">
              <div className="p-3 rounded bg-muted/40 border border-border">
                <div className="font-mono text-xs text-primary">journey_stop_daily</div>
                <p className="text-muted-foreground mt-1">
                  Rå observasjon per avgang per stopp. Beholdes i 90 dager. Eksporteres til
                  ukentlige Parquet-filer for klient-side persentilberegning.
                </p>
              </div>
              {!IS_REISE && (
                <>
                  <div className="p-3 rounded bg-muted/40 border border-border">
                    <div className="font-mono text-xs text-primary">journey_stop_weekly</div>
                    <p className="text-muted-foreground mt-1">
                      13-ukers rullende vindu, vektet snitt per (avgang, stopp). Brukes til
                      reiseprofil og dagsvise grafer.
                    </p>
                  </div>
                  <div className="p-3 rounded bg-muted/40 border border-border">
                    <div className="font-mono text-xs text-primary">line_hourly_profile, stop_hourly_profile</div>
                    <p className="text-muted-foreground mt-1">
                      30-dagers rullende snitt per time. Brukes til timesgrafene på linje- og
                      stoppanalysesidene.
                    </p>
                  </div>
                  <div className="p-3 rounded bg-muted/40 border border-border">
                    <div className="font-mono text-xs text-primary">line_daily, stop_daily, daily_summary</div>
                    <p className="text-muted-foreground mt-1">
                      Per-dag aggregat. Ubegrenset historikk. Brukes til topplister, kart og
                      trendgrafer.
                    </p>
                  </div>
                </>
              )}
              {IS_REISE && (
                <p className="text-muted-foreground text-xs">
                  Dette er det eneste datagrunnlaget for reise-siden — alle persentiler,
                  overgangssannsynligheter og plan B-beregninger går tilbake til disse rå
                  observasjonene. Ingen forhåndsaggregerte tabeller brukes.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <h3 className="text-lg font-semibold">Filtrering og kvalitetssikring</h3>
            <ul className="text-sm text-muted-foreground space-y-1.5 ml-4 list-disc">
              <li>
                Bare data fra NSR-registrerte stopp (<code className="text-xs bg-muted px-1 rounded">NSR:Quay:*</code>) inkluderes
                — fjerner stoppdata uten kobling til nasjonalt stopperegister.
              </li>
              <li>
                Dwell time begrenset til [0, 600] sekunder — verdier utenfor antas å være
                feilrapporteringer.
              </li>
              <li>
                Forsinkelser over ±120 minutter logges som <em>outliers</em> i en egen
                kvalitetslogg, men inkluderes fortsatt i statistikken (de er ofte reelle
                hendelser som streik, snøstorm eller infrastrukturproblemer).
              </li>
              <li>
                Avlyste avganger telles separat (ikke som "veldig sen").
              </li>
            </ul>
          </div>

          {IS_REISE && (
            <div className="space-y-3 pt-2">
              <h3 className="text-lg font-semibold">Sanntidsdekning</h3>
              <p className="text-muted-foreground leading-relaxed text-sm">
                Dekningsprosenten på oversikten måles ved innhenting: av alle
                (avgang, stopp)-passeringer i Enturs SIRI ET-feed for dagen, hvor stor andel
                hadde faktisk rapportert tid. <strong>Avlyste avganger holdes utenfor</strong>{" "}
                dekningsmålet — en avlyst buss har naturlig nok ingen sanntid, og det er ikke
                «manglende data». Avlysninger telles i stedet separat (som unike avganger)
                og vises i egne kolonner. <strong>Viktig forbehold:</strong> nevneren er
                passeringer som finnes i sanntids-feeden — en buss som aldri sender noe som
                helst, er usynlig også i nevneren. Tallet er dermed et{" "}
                <em>øvre estimat</em>: «av det som ble rapportert inn, hvor mye hadde
                tidsdata». Full dekning mot ruteplanen ville krevd sammenlikning med
                planlagte rutetider (NeTEx), som ikke gjøres i dag. Dekning måles fra
                5. juli 2026 og avlysninger fra 6. juli 2026 — eldre dager har ingen verdi.
              </p>
            </div>
          )}

          <div className="space-y-3 pt-2">
            <h3 className="text-lg font-semibold">Klient-side persentiler (DuckDB-WASM)</h3>
            <p className="text-muted-foreground leading-relaxed text-sm">
              For å unngå tungt server-arbeid på hver visning, lastes ukentlige Parquet-filer
              direkte til nettleseren og spørres med <strong>DuckDB-WASM</strong>. Dette gir
              raske persentilberegninger uten å belaste serveren, og er grunnen til at
              reiseplanleggeren og avgangslisten kan vise P50/P80/P95 nesten umiddelbart etter
              første sidelast. DuckDB henter bare de delene av Parquet-filene den faktisk
              trenger via HTTP range requests.
            </p>
          </div>

          <div className="space-y-3 pt-2">
            <h3 className="text-lg font-semibold">Kildekode og kontakt</h3>
            <p className="text-muted-foreground leading-relaxed text-sm">
              Dette er et personlig prosjekt under aktiv utvikling. Spørsmål, tilbakemeldinger
              eller forslag mottas gjerne — kontakt prosjekteier via Entur-data-fellesskapet
              eller direkte hvis du kjenner til personen bak.
            </p>
          </div>
        </section>

        {/* === Nivå 4 — begrensninger === */}
        <section id="begrensninger" className="scroll-mt-8 space-y-4 pt-4 border-t border-border">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
            <h2 className="text-2xl font-bold">4. Begrensninger og kjente svakheter</h2>
          </div>

          <div className="space-y-3 text-sm text-muted-foreground">
            <Limitation title="Kun buss og flybuss har forsinkelsesdata">
              Skyss' SIRI ET-feed dekker buss og flybuss (coach). Trikk, T-bane, tog og båt er
              forberedt i databasen, men inneholder per dags dato ingen sanntidsobservasjoner.
              Dette kan endre seg etter hvert som flere operatører deler sanntidsdata.
            </Limitation>

            <Limitation title="Ikke alle avganger rapporteres">
              Selv om en avgang står i rutetabellen, kan den mangle sanntidsdata (defekt sensor,
              nedetid hos operatøren, kjøretøy uten kommunikasjon). Disse "manglende" avgangene
              telles separat i kvalitetsloggen, men kan ikke skilles fra avlyste avganger med
              full sikkerhet.
            </Limitation>

            <Limitation title="Forsinkelser måles ved avgang fra stopp">
              Tallene reflekterer hvor sen bussen var da den forlot stoppet — ikke når den
              kom inn. Det betyr at en buss som står 3 minutter ekstra på terminalen pga.
              passasjerer telles som "sen ved avgang", selv om kjøretiden mellom stoppene var
              normal.
            </Limitation>

            <Limitation title="Datatilgjengelighet kan variere">
              {IS_REISE
                ? "Pipelinen kjøres hver natt, men kan feile pga. nettverk eller endringer i Enturs API. Da mangler de nyeste dagene i statistikken til den kjøres igjen — reisesøket påvirkes ikke (det går direkte mot Entur)."
                : "Pipelinen kjøres hver natt, men kan feile pga. nettverk eller endringer i Enturs API. Hvis du ser en oransje varselbjelke i sidemenyen, er data eldre enn 2 dager."}
            </Limitation>

            {IS_REISE && (
              <Limitation title="Plan B-kjeden er en forenklet modell">
                Fallback-alternativene (plan B/C/D) antar at du står på det opprinnelige
                overgangsstoppet, og at alternativene er påfølgende avganger derfra. Kjeden
                modellerer ikke forgreninger der plan B har sitt eget overgangsstopp et annet
                sted. Forventet ankomst er derfor et estimat med kjente forenklinger — hele
                regnestykket vises åpent slik at du kan vurdere det selv.
              </Limitation>
            )}

            <Limitation title="Persentiler og sannsynligheter trenger nok observasjoner">
              For sjeldne kombinasjoner (avgang om natten, sjelden linje, lite trafikkert
              stopp) kan persentiler og overgangssannsynligheter være basert på få
              observasjoner. Vi skjuler ikke tallene, men viser alltid antall observasjoner
              de er basert på, og en advarsel når det er under 5. Se{" "}
              <a href="#persentiler" className="text-primary hover:underline">seksjonen om persentiler</a>{" "}
              for en forklaring på hvorfor tallene kan se merkelige ut med lite data.
            </Limitation>
          </div>
        </section>

        <footer className="pt-6 border-t border-border text-xs text-muted-foreground space-y-2">
          <p className="flex items-center gap-1.5">
            <ExternalLink className="w-3 h-3" />
            <a
              href="https://data.entur.no/domain/public-transport-data/product/realtime_siri_et"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              Datakatalog hos Entur — SIRI ET
            </a>
          </p>
          <p>
            Inneholder data under Norsk lisens for offentlige data (NLOD 2.0), distribuert av
            Entur AS. Statistikken er bearbeidet og aggregert av denne tjenesten — Entur står
            ikke ansvarlig for tolkning eller fremstilling av tallene.
          </p>
        </footer>
      </div>
    </Layout>
  );
}

function Term({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="border-l-2 border-primary/30 pl-3 py-1">
      <div className="font-semibold text-sm">{name}</div>
      <p className="text-sm text-muted-foreground mt-0.5 leading-relaxed">{children}</p>
    </div>
  );
}

function Limitation({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-3 rounded-lg bg-amber-50/50 border border-amber-200/60">
      <div className="font-semibold text-sm text-amber-950">{title}</div>
      <p className="text-sm text-amber-900/80 mt-1 leading-relaxed">{children}</p>
    </div>
  );
}
