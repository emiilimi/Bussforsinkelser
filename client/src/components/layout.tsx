import { Link, useLocation } from "wouter";
import { Bus, BarChart3, AlertTriangle, Map, Clock, Map as MapIcon, Navigation } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRegion, REGION_LABEL, type Region } from "@/lib/RegionContext";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { region, setRegion } = useRegion();

  const navItems = [
    { href: "/", label: "Dashboard", icon: BarChart3 },
    { href: "/map", label: "Forsinkelseskart", icon: MapIcon },
    { href: "/stops", label: "Stoppstedsanalyse", icon: Map },
    { href: "/worst", label: "Topplister", icon: BarChart3 },
    { href: "/journey", label: "Linjeanalyse", icon: Clock },
    { href: "/reise", label: "Reisesjekk", icon: Navigation },
  ];

  return (
    <div className="min-h-screen bg-background font-sans text-foreground flex flex-col md:flex-row">
      <aside className="w-full md:w-64 border-b md:border-r border-border bg-card/50 backdrop-blur-sm p-4 md:h-screen md:sticky md:top-0 flex flex-col gap-6 z-50">
        <div className="flex items-center gap-3 px-2">
          <div className="bg-primary text-primary-foreground p-2 rounded-lg shadow-lg">
            <Bus className="w-6 h-6" />
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight leading-none text-primary">bussforsinkelser.no</h1>
            <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">Historisk statistikk</p>
          </div>
        </div>

        <div className="px-2 space-y-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground ml-1">Region</label>
          <Select value={region} onValueChange={(v) => setRegion(v as Region)}>
            <SelectTrigger className="w-full h-9 bg-background/50 text-sm">
              <SelectValue placeholder="Velg region" />
            </SelectTrigger>
            <SelectContent>
              {(Object.entries(REGION_LABEL) as [Region, string][]).map(([key, label]) => (
                <SelectItem key={key} value={key}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

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
          <div className="p-4 rounded-lg bg-muted/50 border border-border text-[10px] text-muted-foreground space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <span className="font-semibold">Entur åpne data</span>
            </div>
            <p>Historiske SIRI ET-data. Oppdateres nightly.</p>
            <p className="opacity-70">Kilde: ent-data-sharing-ext-prd</p>
          </div>

          <div className="p-3 rounded-lg bg-muted/30 border border-border/50 text-[9px] text-muted-foreground space-y-2">
            <a href="https://entur.no" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <svg viewBox="0 0 300 80" className="h-4 w-auto flex-shrink-0" aria-label="Entur logo">
                <text x="0" y="58" fontFamily="system-ui, sans-serif" fontWeight="700" fontSize="62" fill="currentColor">entur</text>
              </svg>
            </a>
            <p>
              Inneholder data under{" "}
              <a href="https://data.norge.no/nlod/no/2.0" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
                Norsk lisens for offentlige data (NLOD 2.0)
              </a>{" "}
              distribuert av Entur AS.
            </p>
            <p className="opacity-70">Dataene er bearbeidet og aggregert til forsinkelsesstatistikk.</p>
          </div>
        </div>
      </aside>

      <main className="flex-1 p-4 md:p-8 overflow-y-auto w-full max-w-7xl mx-auto">
        {children}
      </main>
    </div>
  );
}
