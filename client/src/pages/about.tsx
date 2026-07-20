import Layout from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Info } from "lucide-react";

/**
 * Om-siden: rammeverk klart, tekst kommer senere.
 */
export default function About() {
  return (
    <Layout>
      <div className="max-w-3xl mx-auto space-y-8">
        <header className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary p-2.5 rounded-lg">
              <Info className="w-6 h-6" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">Om Sen Tur</h1>
          </div>
        </header>

        <Card>
          <CardContent className="pt-6 space-y-2">
            <h2 className="text-lg font-semibold">Om prosjektet</h2>
            <p className="text-sm text-muted-foreground italic">Tekst kommer.</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6 space-y-2">
            <h2 className="text-lg font-semibold">Hvem står bak</h2>
            <p className="text-sm text-muted-foreground italic">Tekst kommer.</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6 space-y-2">
            <h2 className="text-lg font-semibold">Kontakt og tilbakemelding</h2>
            <p className="text-sm text-muted-foreground italic">Tekst kommer.</p>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
