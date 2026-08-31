import { Button } from "@/components/ui/button";
import { Eye, EyeOff } from "lucide-react";

// ---------------------------------------------------------------------------
// Min/maks-bånd-bryter
//
// Båndene i graf-etter-graf viser ytterpunkter (verste/beste enkeltdag,
// min/maks per stopp, o.l.), og ett enkelt datafeil-utlig (>120 min, se
// data-quality-flag.tsx) kan blåse opp båndet så mye at gjennomsnittslinjen
// blir vanskelig å lese. Én bryter for HELE siden i stedet for én per graf —
// det er samme avveining uansett hvilken graf man ser på.
// ---------------------------------------------------------------------------

export function BandToggle({
  show,
  onChange,
  className,
}: {
  show: boolean;
  onChange: (show: boolean) => void;
  className?: string;
}) {
  return (
    <Button
      size="sm"
      variant={show ? "default" : "outline"}
      onClick={() => onChange(!show)}
      className={`h-7 px-3 text-xs gap-1.5 ${className ?? ""}`}
      title={show ? "Skjul min/maks-bånd i grafene" : "Vis min/maks-bånd i grafene"}
    >
      {show ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
      Min/maks-bånd
    </Button>
  );
}
