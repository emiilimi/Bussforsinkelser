import { Link, useLocation } from "wouter";
import { Bus, BarChart3, Map, Clock, Map as MapIcon, Navigation, ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRegion, REGION_LABEL, INDIVIDUAL_REGIONS, type Region } from "@/lib/RegionContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { regions, setRegions } = useRegion();

  // "Alle regioner" when empty array
  const isAll = regions.length === 0;

  function toggleRegion(r: Region) {
    if (r === "alle") {
      setRegions([]);
      return;
    }
    if (regions.includes(r)) {
      const next = regions.filter((x) => x !== r);
      setRegions(next); // empty = alle
    } else {
      setRegions([...regions, r]);
    }
  }

  function labelForSelection() {
    if (isAll) return "Alle regioner";
    if (regions.length === 1) return REGION_LABEL[regions[0]];
    if (regions.length === 2) return `${REGION_LABEL[regions[0]]}, ${REGION_LABEL[regions[1]]}`;
    return `${REGION_LABEL[regions[0]]} +${regions.length - 1}`;
  }

  const navItems = [
    { href: "/", label: "Dashboard", icon: BarChart3 },
    { href: "/map", label: "Forsinkelseskart", icon: MapIcon },
    { href: "/stops", label: "Stoppstedsanalyse", icon: Map },
    { href: "/worst", label: "Topplister", icon: BarChart3 },
    { href: "/journey", label: "Linjeanalyse", icon: Clock },
    { href: "/reise", label: "Reiseplanlegger", icon: Navigation },
  ];

  return (
    <div className="min-h-screen bg-background font-sans text-foreground flex flex-col md:flex-row">
      <aside className="w-full md:w-64 border-b md:border-r border-border bg-card/50 backdrop-blur-sm p-4 md:h-screen md:sticky md:top-0 flex flex-col gap-6 z-50">
        <div className="flex items-center gap-3 px-2">
          <div className="bg-primary text-primary-foreground p-2 rounded-lg shadow-lg">
            <Bus className="w-6 h-6" />
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight leading-none text-primary">bussforsinkelser</h1>
            <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">Historisk statistikk</p>
          </div>
        </div>

        <div className="px-2 space-y-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground ml-1">Region</label>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className="w-full h-9 bg-background/50 text-sm justify-between font-normal truncate"
              >
                <span className="truncate text-left">{labelForSelection()}</span>
                <ChevronDown className="w-4 h-4 flex-shrink-0 opacity-50 ml-1" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="start">
              {/* Alle-option */}
              <button
                onClick={() => setRegions([])}
                className={cn(
                  "flex items-center gap-2 w-full px-3 py-2 rounded-sm text-sm hover:bg-muted transition-colors",
                  isAll && "font-semibold",
                )}
              >
                <span className={cn("flex h-4 w-4 items-center justify-center rounded border border-primary", isAll ? "bg-primary" : "bg-transparent")}>
                  {isAll && <Check className="w-3 h-3 text-primary-foreground" />}
                </span>
                Alle regioner
              </button>

              <div className="my-1 border-t border-border" />

              {INDIVIDUAL_REGIONS.map((r) => {
                const checked = regions.includes(r);
                return (
                  <button
                    key={r}
                    onClick={() => toggleRegion(r)}
                    className="flex items-center gap-2 w-full px-3 py-2 rounded-sm text-sm hover:bg-muted transition-colors"
                  >
                    <span className={cn("flex h-4 w-4 items-center justify-center rounded border border-primary flex-shrink-0", checked ? "bg-primary" : "bg-transparent")}>
                      {checked && <Check className="w-3 h-3 text-primary-foreground" />}
                    </span>
                    <span className="truncate">{REGION_LABEL[r]}</span>
                  </button>
                );
              })}
            </PopoverContent>
          </Popover>
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
            <p>Historiske SIRI ET-data. Oppdateres for øyeblikket sporadisk, da dette fortsatt er i testfasen.</p>
            <p className="opacity-70">Kilde: ent-data-sharing-ext-prd</p>
          </div>

          <div className="p-3 rounded-lg bg-muted/30 border border-border/50 text-[9px] text-muted-foreground space-y-2">
            <a href="https://entur.no" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <img src="/entur-logo.svg" alt="Entur" className="h-10 w-auto flex-shrink-0" />
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
