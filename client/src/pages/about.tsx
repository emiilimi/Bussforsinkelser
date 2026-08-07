import Layout from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Info, Mail } from "lucide-react";

export default function About() {
  return (
    <Layout>
      <div className="max-w-3xl mx-auto space-y-8">
        <header className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary p-2.5 rounded-lg">
              <Info className="w-6 h-6" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">Om Sen Tur</h1>
          </div>
          <p className="text-lg text-foreground/90 italic">
            Hvor stor sannsynlighet har jeg for å rekke bussen?
          </p>
        </header>

        <Card>
          <CardContent className="pt-6 space-y-4">
            <h2 className="text-lg font-semibold">Om prosjektet</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Sentur.no har vært mitt hobbyprosjekt de siste månedene. Det begynte med ren
              nysgjerrighet: Jeg satt på 20-bussen, og lurte på om jeg kom til å rekke 70-bussen
              fra Nesttun. Reiseplanleggeren sa 3 minutter margin, men av erfaring vet jeg at
              20-bussen ofte blir 5 minutter sen.
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Derav navnet <span className="font-medium text-foreground">Sen Tur</span>, en
              reiseplanlegger for deg som vil vite når du faktisk kommer frem.
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Dette har vært mulig takket være Enturs åpne data (sanntidsdata fra 19(?)
              operatører i en og samme database(!)), Enturs åpne reiseplanlegger-API, og KIs
              kodeegenskaper. Jeg har ikke skrevet en eneste linje med kode selv.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6 space-y-4">
            <h2 className="text-lg font-semibold">Hvem står bak</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Det har vært en artig reise. I februar i fjor satt jeg på skolen og lekte meg med
              Python, Pandas, og plottet grafer over bussforsinkelsesdataene jeg nettopp hadde
              hentet. I mars i år ga jeg det arbeidet til KI, sa omtrent: «Jeg vil ha en nettside
              med ... funksjoner». Det første resultatet var ikke særlig bra. (Den har fortsatt
              ikke skjønt at VY190 er en ekspressbuss, ikke et fly :)) Veien har vært humpete, men
              mens jeg i starten stadig måtte minne KI-en på hva prosjektet het og hvor den fant
              sine tidligere notater, kan jeg nå sitte her og skrive denne teksten. Opus 5
              oppdaterer reiseanalysen, tester lokalt, og pusher til preview. Jeg sitter på
              bussen, åpner telefonen, skriver «Kan du oppdatere lenken til innsamlingsaksjonen?
              Her er lenken, push direkte til production.» Claude på pc-en hjemme fikser. (Og ja,
              jeg er bekymret for KI-utviklingen, mer om hvorfor kommer snart)
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6 space-y-4">
            <h2 className="text-lg font-semibold">Kontakt og tilbakemelding</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Så nå får dere gleden av å teste! Håpet er at dette kan være et nyttig verktøy,
              ikke mer «AI-slop». Om dere finner teite KI-feil, eller har forslag til flere kule
              funksjoner, vil jeg gjerne høre det!
            </p>
            <a
              href="mailto:emiliemoldestad@gmail.com"
              className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
            >
              <Mail className="w-4 h-4" />
              emiliemoldestad@gmail.com
            </a>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
