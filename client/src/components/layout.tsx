import { Link, useLocation } from "wouter";
import { Bus, BarChart3, Map, Clock, Map as MapIcon, Navigation, Timer, BookOpen, Info, Heart } from "lucide-react";
import { cn } from "@/lib/utils";
import { FreshnessBadge } from "@/components/freshness-badge";
import { IS_REISE } from "@/lib/app-mode";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  // Reise-bygget: analysesidene serveres fra R2-artefakter + DuckDB-WASM
  // (full offload) — ingen SQLite-backend.
  const navItems = IS_REISE
    ? [
        { href: "/reise", label: "Reiseplanlegger", icon: Navigation },
        { href: "/avganger", label: "Avganger", icon: Timer },
        { href: "/oversikt", label: "Oversikt", icon: BarChart3 },
        { href: "/journey", label: "Linjeanalyse", icon: Clock },
        { href: "/stops", label: "Stoppstedsanalyse", icon: Map },
        { href: "/worst", label: "Topplister", icon: BarChart3 },
        { href: "/map", label: "Forsinkelseskart", icon: MapIcon },
        { href: "/metode", label: "Metode", icon: BookOpen },
        { href: "/om", label: "Om", icon: Info },
      ]
    : [
        { href: "/", label: "Dashboard", icon: BarChart3 },
        { href: "/map", label: "Forsinkelseskart", icon: MapIcon },
        { href: "/stops", label: "Stoppstedsanalyse", icon: Map },
        { href: "/worst", label: "Topplister", icon: BarChart3 },
        { href: "/journey", label: "Linjeanalyse", icon: Clock },
        { href: "/reise", label: "Reiseplanlegger", icon: Navigation },
        { href: "/avganger", label: "Avganger", icon: Timer },
        { href: "/metode", label: "Metode", icon: BookOpen },
      ];

  return (
    <div className="min-h-screen bg-background font-sans text-foreground flex flex-col">
      <div className="flex-1 flex flex-col md:flex-row w-full">
        <aside className="w-full md:w-64 border-b md:border-r border-border bg-card/50 backdrop-blur-sm z-50">
        <div className="p-4 md:sticky md:top-0 flex flex-col gap-6">
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
          <nav className="flex flex-row md:flex-col gap-1 overflow-x-auto md:overflow-visible no-scrollbar">
            {navItems.map((item) => {
              const isActive = location === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
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

          <div className="mt-auto hidden md:block px-2 space-y-3">
            {/* Freshness gjelder analyse-DB-en — irrelevant for live reise-siten. */}
            {!IS_REISE && <FreshnessBadge />}

            <div className="p-3 rounded-lg bg-muted/50 border border-border text-[9px] text-muted-foreground space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  <span className="font-semibold text-foreground/80">Entur åpne data</span>
                </div>
                <a href="https://entur.no" target="_blank" rel="noopener noreferrer" className="hover:opacity-80 transition-opacity">
                  <img src="/entur-logo.svg" alt="Entur" className="h-6 w-auto" />
                </a>
              </div>
              <p>Historiske SIRI ET-data. Oppdateres hver natt. Kilde: ent-data-sharing-ext-prd.</p>
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
            <span>Ønsker du å støtte prosjektet?</span>
            {/* TODO: sett inn faktisk lenke til innsamlingsaksjonen */}
            <a
              href="#"
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2.5 py-0.5 font-medium hover:bg-primary/15 transition-colors"
            >
              <Heart className="w-3 h-3" />
              Støtt effektiv bistand
            </a>
          </div>
        </footer>
      )}
    </div>
  );
}
