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
 * Metode-side: hva nettsiden viser, hvordan tallene beregnes, og hvilke
 * forbehold som gjelder. Andre sider lenker til ankerne
 * (#hva-vises, #persentiler, #dwell-time, #overgang, #plan-b, #begrensninger).
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
            Hvor tallene kommer fra, hvordan de er regnet ut, og hva de ikke kan
            fortelle deg. Starter enkelt, blir mer teknisk nedover.
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
                  1. Hva viser nettsiden?
                </a>
              </li>
              <li>
                <a href="#hvordan-beregnes" className="text-primary hover:underline">
                  2. Hvordan beregnes tallene?
                </a>
              </li>
              <li>
                <a href="#detaljert-metodikk" className="text-primary hover:underline">
                  3. Detaljert metodikk
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
                Dette er en reiseplanlegger som legger historikk oppå reisesøket.
                Selve reiseforslagene kommer fra Entur. I tillegg viser vi hva som
                faktisk har skjedd med de samme avgangene tidligere: hver gang en buss
                rapporterer faktisk tid via sanntidssystemet, sammenlikner vi med
                ruteplanen. Differansen — <strong>forsinkelsen</strong>, målt i
                minutter — er grunnlaget for estimerte tider,
                overgangssannsynligheter og plan B-forslagene.
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
                  ? "Forsinkelsesstatistikken dekker 19 norske operatører med sanntid i SIRI ET-feeden (Skyss, Ruter, AtB, Kolumbus, Brakar m.fl.). Reisesøket dekker hele Norge via Entur."
                  : "19 operatører over hele Norge (Skyss, Ruter, AtB, Kolumbus, Brakar m.fl.). Velg i sidemenyen."}
              </p>
            </div>
            <div className="p-4 rounded-lg bg-muted/40 border border-border space-y-1">
              <div className="text-xs font-semibold uppercase text-muted-foreground">Tidsvindu</div>
              <p className="text-sm">
                {IS_REISE
                  ? "Rådataene dekker inntil 14 uker tilbake i tid (rullende). Innsamlingen er relativt ny, så vinduet vokser til det er fullt — antall dager bak et tall vises alltid."
                  : "Standard er siste 30 dager. Noen visninger har egne tidsvelgere."}
              </p>
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <h3 className="text-lg font-semibold">Hva betyr de viktigste tallene?</h3>

            <Term name="Forsinkelse (minutter)">
              Faktisk tid minus planlagt tid ved et stopp. Positiv = bussen var sen,
              negativ = bussen var tidlig. Vi bruker avgangstiden der den er
              rapportert; mangler den, brukes ankomsttiden.
            </Term>

            <Term name="Snitt forsinkelse">
              Gjennomsnittet av alle observerte forsinkelser i tidsvinduet, regnet per
              stopp-passering. <em>2,1 min</em> betyr at bussene i snitt var 2 minutter
              og 6 sekunder sene ved stoppene sine.
            </Term>

            <Term name="Andel i rute (%)">
              Andel stopp-passeringer med <em>høyst 2 minutter forsinkelse</em>. Tidlige
              passeringer regnes også som i rute i dette målet. Beregnes per
              stopp-passering (ikke per avgang) — en avgang som er sen på 3 av 30 stopp
              bidrar med 90 % i rute.
            </Term>

            <Term name="Andel mer enn 2/10 min sen">
              Andel stopp-passeringer med forsinkelse over den oppgitte grensen. Brukes
              på topplistene for å fange opp problematiske stopp og linjer.
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
              Gjennomsnitt skjuler variasjon. En linje kan ha 1 minutt i snittforsinkelse
              og likevel være kvarteret for sen hver tiende tur — og det er den turen du
              husker. Derfor viser vi persentiler i tillegg:
            </p>
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 space-y-1">
                <div className="font-bold text-emerald-900">P50 (median)</div>
                <p className="text-xs text-emerald-900/80">
                  Halvparten av observasjonene er bedre, halvparten dårligere. En typisk dag.
                </p>
              </div>
              <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 space-y-1">
                <div className="font-bold text-amber-900">P80</div>
                <p className="text-xs text-amber-900/80">
                  4 av 5 observasjoner er bedre enn dette. En ganske dårlig dag.
                </p>
              </div>
              <div className="p-4 rounded-lg bg-rose-50 border border-rose-200 space-y-1">
                <div className="font-bold text-rose-900">P95</div>
                <p className="text-xs text-rose-900/80">
                  19 av 20 er bedre enn dette. Så ille kan det bli uten at noe ekstraordinært skjer.
                </p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Står det «P80 = 7 min» for en avgang, betyr det at rundt 80 % av de
              historiske turene var mindre enn 7 minutter sene.
            </p>
            <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-900 dark:text-amber-200 space-y-2">
              <p className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" />
                Persentiler med lite data
              </p>
              <p>
                Persentiler beregnes med <code>PERCENTILE_CONT</code> (kontinuerlig
                interpolasjon): observasjonene sorteres, og persentilen leses av på posisjon{" "}
                <code>p × (n − 1)</code> i den sorterte listen. Havner posisjonen mellom to
                observasjoner, interpoleres det lineært mellom dem — persentilen er
                altså ikke nødvendigvis en verdi som faktisk er observert.
              </p>
              <div className="p-2.5 rounded bg-amber-100/60 dark:bg-amber-900/30 font-mono text-xs space-y-1">
                <p className="font-sans font-semibold">Regneeksempel med bare 2 dager (1,0 min og 5,0 min forsinkelse):</p>
                <p>P50 = 1,0 + 0,50 × (5,0 − 1,0) = <strong>3,0 min</strong> — midtpunktet</p>
                <p>P80 = 1,0 + 0,80 × (5,0 − 1,0) = <strong>4,2 min</strong> — 80 % av veien mot verste dag</p>
                <p>P95 = 1,0 + 0,95 × (5,0 − 1,0) = <strong>4,8 min</strong> — nesten lik verste dag</p>
              </div>
              <p>
                Med 2 datapunkter er «P80» bare et punkt på linjen mellom beste og verste
                dag. Tallet ser presist ut (4,2 min!), men en tredje dag kan flytte alt.
                Først med noen titalls dager begynner persentilene å beskrive en faktisk
                fordeling. Vi viser derfor alltid hvor mange observasjoner et tall bygger
                på — under 5 dager bør du lese det som en anekdote, ikke statistikk.
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
              fra den ankommer til den kjører videre, målt i sekunder. Høy dwell time kan
              bety to ganske ulike ting: mange på- og avstigninger (rushtid, knutepunkt),
              eller at bussen ligger <em>foran</em> ruten og venter på planlagt avgangstid
              (regulering). Tallet skiller ikke mellom de to.
            </p>
          </div>

          <div id="day-type" className="scroll-mt-8 space-y-3 pt-2">
            <h3 className="text-lg font-semibold">Dagtype-segmentering</h3>
            <p className="text-muted-foreground leading-relaxed">
              Hverdager, lørdager og søndager har ulikt rutemønster og trafikkmengde. For
              at ikke lørdagstall skal blandes inn i hverdagsstatistikken, får hver dag en{" "}
              <strong>dagtype</strong>:
            </p>
            <ul className="text-sm text-muted-foreground space-y-1 ml-4 list-disc">
              <li><strong>Hverdag</strong> — mandag til fredag (ekskl. helligdager)</li>
              <li><strong>Lørdag</strong></li>
              <li><strong>Søndag</strong></li>
              <li><strong>Helligdag</strong> — norske offentlige helligdager (1. mai, jul, påske, Kristi himmelfart m.fl.)</li>
            </ul>
            <p className="text-sm text-muted-foreground">
              17. mai skilles i tillegg ut som egen kategori i datagrunnlaget —
              paradedagen har et så avvikende kjøremønster at den ville forstyrret
              helligdagstallene.
            </p>
            <p className="text-sm text-muted-foreground">
              Statistikk for en avgang beregnes fra historiske dager med samme dagtype
              som datoen du ser på.
            </p>
          </div>

          <div id="overgang" className="scroll-mt-8 space-y-3 pt-2">
            <h3 className="text-lg font-semibold">Empirisk overgangssannsynlighet</h3>
            <p className="text-muted-foreground leading-relaxed">
              I reiseplanleggeren viser vi sannsynligheten for at du faktisk{" "}
              <strong>rekker en overgang</strong> mellom to busser. Dette er ikke regnet
              ut fra snittforsinkelser, men telt opp dag for dag i historikken:
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
                Vi teller hvor mange av dagene som hadde nok tid til å rekke overgangen
                (inkl. din valgte gangtid + sikkerhetsmargin).
              </li>
              <li>
                Andelen blir sannsynligheten. <em>«Snitt over 47 dager: 82 %»</em> betyr at
                samme overgang har gått 82 % av historiske dager.
              </li>
            </ol>
            <p className="text-sm text-muted-foreground">
              Har vi for få dager (under 5) på akkurat din avgangs-ID, faller vi tilbake
              til statistikk per (linje, stopp, retning, dagtype) — kilden merkes i
              visningen. Retningen leses fra hvordan den planlagte avgangen selv er
              registrert i dataene, siden noen plattformer trafikkeres i begge retninger
              av samme linje. I fallback-modusen sammenlikner vi{" "}
              <strong>forsinkelser</strong>, ikke absolutte klokkeslett: for hver
              historisk dag finner vi en sammenliknbar ankomst og avgang (nærmest i
              rutetid, samme retning), og regner{" "}
              <code className="text-xs bg-muted px-1 rounded">
                gap = planlagt gap + (avgangsforsinkelse − ankomstforsinkelse)
              </code>
              . Det er viktig for sjeldne linjer: sammenliknet man klokkeslett direkte,
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
              Med 1–2 observasjoner blir sannsynligheten enten 0 % eller 100 % — det
              finnes ingen mellomting når man teller binært over én dag. Det kan se
              rart ut (0 % med margin, men 100 % med spurt), men er korrekt: den ene
              dagen var gapet stort nok til å rekke ved spurt, men ikke med vanlig
              gangfart + margin. Antall dager vises alltid, så du kan vurdere
              påliteligheten selv.
            </p>
          </div>

          {IS_REISE && (
            <div id="plan-b" className="scroll-mt-8 space-y-3 pt-2">
              <h3 className="text-lg font-semibold">Plan B/C/D: hva skjer hvis du mister overgangen?</h3>
              <p className="text-muted-foreground leading-relaxed">
                Er sannsynligheten for å miste en overgang 5 % eller mer, viser
                reiseplanleggeren hva alternativet ditt er. Slik beregnes det:
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
                  hovedreisen). Er sjansen for at du trenger enda et alternativ fortsatt
                  minst 5 % — dvs. P(miste opprinnelig) × P(miste plan B) ≥ 5 % — henter vi{" "}
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
                samme linje («Bytt avgang»). Da antar vi at kjøretiden er identisk med den
                opprinnelige avgangen, og skyver hele legget tilsvarende. Bytter du et legg
                midt i reisen slik at gapet til neste buss blir mindre enn gangtiden, flagges
                overgangen som brutt i rødt — vi skjuler den ikke.
              </p>
            </div>
          )}

          <div id="punktlighet" className="scroll-mt-8 space-y-3 pt-2">
            <h3 className="text-lg font-semibold">Definisjonen av «punktlig»</h3>
            <p className="text-muted-foreground leading-relaxed">
              Vi regner en stopp-passering som <strong>punktlig</strong> når forsinkelsen er{" "}
              <strong>høyst 2 minutter</strong> (avgangstid der den finnes, ellers ankomsttid).
              Tidlige passeringer regnes som i rute i dette målet. Bransjen har ingen
              universell definisjon — mange operatører bruker vinduer som −1 til +3 eller
              −1 til +5 minutter og teller per avgang. Våre tall er derfor ikke direkte
              sammenliknbare med operatørenes egne punktlighetsrapporter, og vil typisk
              se strengere ut.
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
                Hver natt hentes forrige dags rådata fra Enturs BigQuery-tabell{" "}
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                  realtime_siri_et.realtime_siri_et_last_recorded
                </code>{" "}
                (SIRI ET = Service Interface for Real time Information / Estimated Timetable).
                Faktisk avgangs-/ankomsttid sammenliknes med planlagt tid, dataene
                kvalitetssikres, og observasjonene per (avgang, stopp, dag) skrives til
                ukentlige Parquet-filer som lastes opp til Cloudflare R2. De siste 14
                ukene beholdes der. <strong>All statistikk beregnes i nettleseren
                din</strong> med DuckDB-WASM direkte mot Parquet-filene — det finnes
                ingen statistikk-server.
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
                  {IS_REISE
                    ? "Rå observasjon per avgang per stopp per dag. Lagres som ukentlige Parquet-filer på R2; de siste 14 ukene beholdes."
                    : "Rå observasjon per avgang per stopp. Beholdes i 90 dager. Eksporteres til ukentlige Parquet-filer for klient-side persentilberegning."}
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
                  Dette er det eneste datagrunnlaget — alle persentiler,
                  overgangssannsynligheter og plan B-beregninger går tilbake til disse rå
                  observasjonene. I tillegg forhåndsberegnes noen små oppsummeringsfiler
                  hver natt fra de samme rådataene (dagstall, topplister, kartdata,
                  linjenavn), slik at oversikts- og kartsidene slipper å skanne Parquet
                  ved hvert besøk. Analysevinduene der er 7, 30 og 90 dager.
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
                {IS_REISE ? (
                  <>
                    Ekstreme forsinkelser (over ±2 timer) kappes ikke, men inkluderes som
                    de er — de er ofte reelle hendelser (streik, snøstorm,
                    infrastrukturproblemer), men kan også være klokke- eller GPS-feil.
                  </>
                ) : (
                  <>
                    Forsinkelser over ±120 minutter logges som <em>outliers</em> i en egen
                    kvalitetslogg, men inkluderes fortsatt i statistikken (de er ofte reelle
                    hendelser som streik, snøstorm eller infrastrukturproblemer).
                  </>
                )}
              </li>
              <li>
                Avlyste avganger telles separat (ikke som «veldig sen»).
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
              Persentiler og overgangsstatistikk beregnes med <strong>DuckDB-WASM</strong> —
              en SQL-motor som kjører i nettleseren og spør direkte mot Parquet-filene på
              R2. Den henter bare de delene av filene den faktisk trenger, via HTTP range
              requests. Motoren (~7 MB) lastes først når du gjør noe som trenger den —
              velger et stoppested, starter et søk — slik at selve sidelasten forblir
              lett.
            </p>
          </div>

          <div className="space-y-3 pt-2">
            <h3 className="text-lg font-semibold">Kildekode og kontakt</h3>
            <p className="text-muted-foreground leading-relaxed text-sm">
              Dette er et personlig prosjekt under aktiv utvikling. Spørsmål, tilbakemeldinger
              eller forslag mottas gjerne — kontakt:{" "}
              <a
                href="https://emoldestad.no"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                emoldestad.no
              </a>
              .
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
            <Limitation title="Dekningen varierer per operatør og transportmiddel">
              Vi har sanntidsdata fra de aller fleste norske operatører i SIRI ET-feeden,
              men hvor komplett rapporteringen er varierer — per operatør, transportmiddel
              og linje. Sanntidsdekningen på oversikten viser dette per dag. Statistikk for
              kombinasjoner med tynn rapportering bygger på færre observasjoner (antall
              vises alltid).
            </Limitation>

            <Limitation title="Ikke alle avganger rapporteres">
              Selv om en avgang står i rutetabellen, kan den mangle sanntidsdata (defekt sensor,
              nedetid hos operatøren, kjøretøy uten kommunikasjon). Disse «manglende» avgangene
              kan ikke skilles fra avlyste avganger med full sikkerhet.
            </Limitation>

            <Limitation title="Forsinkelse måles primært ved avgang fra stopp">
              Der bussen rapporterer avgangstid, er det den som telles — en buss som står
              3 minutter ekstra på terminalen regnes som sen ved avgang, selv om kjøretiden
              mellom stoppene var normal. Mangler avgangstiden, brukes ankomsttiden i
              stedet. Overgangsanalysen bruker derimot alltid ankomsttid for bussen du
              kommer med og avgangstid for bussen du skal rekke — det er de tidspunktene
              som avgjør om du rekker byttet.
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
              for hvorfor tallene kan se merkelige ut med lite data.
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
