import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRegion, REGION_LABEL, INDIVIDUAL_REGIONS, type Region } from "@/lib/RegionContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

/**
 * Operatørvelger. Lå tidligere fast i sidemenyen; nå rendres den øverst på
 * sidene som faktisk filtrerer på operatør (oversikt, linjeanalyse,
 * stoppstedsanalyse, topplister, kart). Sider uten operatørfilter
 * (reiseplanlegger, avganger, metode) viser den ikke.
 * Valget deles via RegionContext og persisteres i localStorage som før.
 */
export function RegionSelector({ className, regions: controlledRegions, onChange }: {
  className?: string;
  /** Kontrollert modus: overstyrer den delte RegionContext-en med lokal
   *  state (f.eks. URL-synkronisert). Kun relevant for sider som bevisst
   *  IKKE skal dele operatørvalg med resten av appen (se avganger-siden). */
  regions?: Region[];
  onChange?: (r: Region[]) => void;
}) {
  const ctx = useRegion();
  const regions = controlledRegions ?? ctx.regions;
  const setRegions = onChange ?? ctx.setRegions;

  // "Alle operatører" when empty array
  const isAll = regions.length === 0;

  function toggleRegion(r: Region) {
    if (r === "alle") {
      setRegions([]);
      return;
    }
    if (regions.includes(r)) {
      setRegions(regions.filter((x) => x !== r)); // empty = alle
    } else {
      setRegions([...regions, r]);
    }
  }

  function labelForSelection() {
    if (isAll) return "Alle operatører";
    if (regions.length === 1) return REGION_LABEL[regions[0]];
    if (regions.length === 2) return `${REGION_LABEL[regions[0]]}, ${REGION_LABEL[regions[1]]}`;
    return `${REGION_LABEL[regions[0]]} +${regions.length - 1}`;
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:inline">
        Operatør:
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="h-9 w-44 sm:w-52 bg-background/50 text-sm justify-between font-normal truncate"
          >
            <span className="truncate text-left">{labelForSelection()}</span>
            <ChevronDown className="w-4 h-4 flex-shrink-0 opacity-50 ml-1" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-1 max-h-[70vh] overflow-y-auto" align="end">
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
            Alle operatører
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
  );
}
