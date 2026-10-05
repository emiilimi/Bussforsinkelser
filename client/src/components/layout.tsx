import { Link, useLocation, useSearch } from "wouter";
import { Bus, BarChart3, Clock, Map as MapIcon, Navigation, Timer, BookOpen, Heart, Info, Users, Menu } from "lucide-react";
import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FreshnessBadge } from "@/components/freshness-badge";
import { IS_REISE } from "@/lib/app-mode";
import { PAX_ENABLED } from "@/lib/pax";
import { rememberCurrentUrl, getRememberedUrl } from "@/lib/nav-memory";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const search = useSearch();

  // Husk denne siden sin fulle URL (med filtre/valg) slik at sidemeny-lenken
  // hit tar deg tilbake til akkurat det du så på, ikke standardvisningen.
  useEffect(() => {
    rememberCurrentUrl(location, search);
  }, [location, search]);

  // Reise-bygget: analysesidene serveres fra R2-artefakter + DuckDB-WASM
  // (full offload) — ingen SQLite-backend.
  const navItems = IS_REISE
    ? [
        { href: "/reise", label: "Reiseplanlegger", icon: Navigation },
        { href: "/avganger", label: "Avganger og stopp", icon: Timer },
        { href: "/oversikt", label: "Oversikt", icon: BarChart3 },
        { href: "/journey", label: "Linjeanalyse", icon: Clock },
        { href: "/worst", label: "Topplister", icon: BarChart3 },
        { href: "/map", label: "Forsinkelseskart", icon: MapIcon },
        ...(PAX_ENABLED ? [{ href: "/passasjerer", label: "Passasjerer", icon: Users }] : []),
        { href: "/metode", label: "Metode", icon: BookOpen },
        { href: "/om", label: "Om", icon: Info },
      ]
    : [
        { href: "/", label: "Dashboard", icon: BarChart3 },
        { href: "/map", label: "Forsinkelseskart", icon: MapIcon },
        { href: "/worst", label: "Topplister", icon: BarChart3 },
        { href: "/journey", label: "Linjeanalyse", icon: Clock },
        { href: "/reise", label: "Reiseplanlegger", icon: Navigation },
        { href: "/avganger", label: "Avganger og stopp", icon: Timer },
        ...(PAX_ENABLED ? [{ href: "/passasjerer", label: "Passasjerer", icon: Users }] : []),
        { href: "/metode", label: "Metode", icon: BookOpen },
      ];

  const [menuOpen, setMenuOpen] = useState(false);
  const activeLabel = navItems.find((i) => i.href === location)?.label ?? "";

  const renderNav = (onNavigate?: () => void) => (
    <nav className="flex flex-col gap-1">
      {navItems.map((item) => {
        const isActive = location === item.href;
        return (
          <Link
            key={item.href}
            href={getRememberedUrl(item.href)}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-200",
              isActive
                ? "bg-primary text-primary-foreground shadow-md scale-[1.02]"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <item.icon className={cn("w-4 h-4", isActive ? "text-primary-foreground" : "text-muted-foreground")} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen bg-background font-sans text-foreground flex flex-col">
      <div className="flex-1 flex flex-col md:flex-row w-full">
        <aside className="w-full md:w-64 border-b md:border-r border-border bg-card/80 md:bg-card/50 backdrop-blur-sm z-50 sticky top-0 md:static">
        {/* Mobil: kompakt topplinje + skuffemeny. Tidligere sto alle
            menypunktene som knapper over innholdet, og på en 375 px-skjerm
            dyttet de søkefeltet i reiseplanleggeren ned under folden
            (~630 av 812 px var meny). */}
        <div className="md:hidden flex items-center gap-3 px-3 py-2">
          <Link href={IS_REISE ? "/reise" : "/"} className="shrink-0">
            {IS_REISE ? (
              <img src="/sen-tur-logo-compact.svg" alt="Sen Tur" className="h-8 w-auto" />
            ) : (
              <span className="font-bold text-primary">bussforsinkelser</span>
            )}
          </Link>
          <span className="flex-1 truncate text-sm font-medium text-muted-foreground text-right">{activeLabel}</span>
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="shrink-0 gap-1.5" aria-label="Åpne meny">
                <Menu className="h-4 w-4" />
                Meny
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-4 flex flex-col gap-4">
              <SheetTitle className="sr-only">Meny</SheetTitle>
              {IS_REISE && <img src="/sen-tur-logo-compact.svg" alt="Sen Tur" className="h-10 w-auto self-start" />}
              {renderNav(() => setMenuOpen(false))}
            </SheetContent>
          </Sheet>
        </div>

        <div className="hidden md:flex p-4 md:sticky md:top-0 flex-col gap-6">
          {IS_REISE ? (
            <div className="px-2 py-1">
              <img src="/sen-tur-logo-compact.svg" alt="Sen Tur" className="h-12 md:h-14 w-auto" />
              <p className="text-[10px] text-muted-foreground mt-1 leading-snug max-w-[200px]">
                for deg som vil vite når du faktisk kommer frem
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-3 px-2">
              <div className="bg-primary text-primary-foreground p-2 rounded-lg shadow-lg">
                <Bus className="w-6 h-6" />
              </div>
              <div>
                <h1 className="font-bold text-lg tracking-tight leading-none text-primary">
                  bussforsinkelser
                </h1>
                <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                  Historisk statistikk
                </p>
              </div>
            </div>
          )}

          {/* Operatørvelgeren ligger nå øverst på sidene som filtrerer på
              operatør (se components/region-selector.tsx) — ikke i sidemenyen. */}
          {renderNav()}

          <div className="mt-auto hidden md:block px-2 space-y-3">
            {/* Freshness gjelder analyse-DB-en — irrelevant for live reise-siten. */}
            {!IS_REISE && <FreshnessBadge />}

            <div className="p-3 rounded-lg bg-muted/50 border border-border text-[9px] text-muted-foreground space-y-1.5">
              <a href="https://entur.no" target="_blank" rel="noopener noreferrer" className="inline-block hover:opacity-80 transition-opacity">
                <img src="/entur-logo.svg" alt="Entur" className="h-12 w-auto" />
              </a>
              <p>Historiske sanntidsdata (SIRI ET) fra Entur. Oppdateres hver natt.</p>
              <p>
                Reiseplanleggeren bruker Entur sitt{" "}
                <a
                  href="https://developer.entur.no/docs/open-services/journey-planner"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground"
                >
                  Journey Planner API
                </a>{" "}
                for ruteforslag.
              </p>
              <p>
                Inneholder data under{" "}
                <a href="https://data.norge.no/nlod/no/2.0" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
                  NLOD 2.0
                </a>
                , distribuert av Entur AS og bearbeidet til forsinkelsesstatistikk.
              </p>
            </div>
          </div>
        </div>
        </aside>

        <main className="flex-1 p-4 md:p-8 overflow-y-auto w-full max-w-7xl mx-auto">
          {children}
        </main>
      </div>

      {IS_REISE && (
        <footer className="border-t border-border bg-card/30 py-2.5 px-4 md:px-8">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground text-center">
            <span>Laget av Emilie Moldestad og Claude.</span>
            <Link href="/om" className="underline hover:text-foreground">
              Om prosjektet
            </Link>
            <span>Ønsker du å støtte prosjektet?</span>
            <a
              href="https://gieffektivt.no/innsamling/til-effektiv-bistand"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2.5 py-0.5 font-medium hover:bg-primary/15 transition-colors"
            >
              <Heart className="w-3 h-3" />
              Støtt effektiv bistand
            </a>
          </div>
          {/* Datakilde-/lisensattribusjon på MOBIL — desktop har den samme
              informasjonen i sidemenyen (hidden md:block over), som skjules på
              mobil. NLOD 2.0 krever synlig attribusjon på alle skjermstørrelser. */}
          <div className="md:hidden max-w-7xl mx-auto mt-1.5 pt-1.5 border-t border-border/50 text-center text-[10px] text-muted-foreground/80 leading-snug">
            <a href="https://entur.no" target="_blank" rel="noopener noreferrer" className="inline-block align-middle mr-1 hover:opacity-80 transition-opacity">
              <img src="/entur-logo.svg" alt="Entur" className="h-6 w-auto align-middle" />
            </a>
            Historiske sanntidsdata (SIRI ET) fra Entur. Inneholder data under{" "}
            <a href="https://data.norge.no/nlod/no/2.0" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
              NLOD 2.0
            </a>
            , distribuert av Entur AS og bearbeidet til forsinkelsesstatistikk.
          </div>
        </footer>
      )}
    </div>
  );
}
