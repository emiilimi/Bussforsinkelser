import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DayTypeFilter } from "@/lib/day-type";

// ---------------------------------------------------------------------------
// Ukedagsfilter
//
// Filtrerer på `day_type`-kolonnen som pipeline/day_type.py setter per dag og
// pipeline/export_parquet.py skriver til parquet-filene. Kolonnen har fem
// mulige verdier — may17 > holiday > sunday > saturday > weekday, i den
// prioriteten — men bare de tre siste er eksponert som knapper her.
//
// Hvorfor ikke helligdag/17. mai: de finnes ikke i det rullerende
// 90-dagersvinduet store deler av året (målt over alle ukefilene
// 2026-06-19 → 2026-08-23: 0 rader av 75,5 mill.), så de ville stått som
// tomme valg mesteparten av tiden. De er fortsatt med under «Alle dager», og
// dayTypeFilterLabel i lib/day-type.ts har etiketter for dem hvis de senere
// skal vises.
//
// Merk at dette IKKE er det samme som å filtrere på ukedag: en helligdag som
// faller på en tirsdag har day_type=holiday, ikke weekday, og holdes derfor
// utenfor «Hverdag». Det er hele poenget — rutetilbudet 1. mai ligner ikke
// en vanlig tirsdag.
// ---------------------------------------------------------------------------

const OPTIONS: Array<{ value: DayTypeFilter; label: string }> = [
  { value: "all", label: "Alle dager" },
  { value: "weekday", label: "Hverdag" },
  { value: "saturday", label: "Lørdag" },
  { value: "sunday", label: "Søndag" },
];

export function DayTypePicker({
  value,
  onChange,
  className,
}: {
  value: DayTypeFilter;
  onChange: (d: DayTypeFilter) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2 flex-wrap", className)}>
      <span className="text-sm text-muted-foreground">Dagtype:</span>
      {OPTIONS.map((o) => (
        <Button
          key={o.value}
          size="sm"
          variant={value === o.value ? "default" : "outline"}
          onClick={() => onChange(o.value)}
          className="h-7 px-3 text-xs"
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}
