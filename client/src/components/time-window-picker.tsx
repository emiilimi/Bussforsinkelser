import { useState } from "react";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatDateNO } from "@/lib/date-utils";
import { IS_REISE } from "@/lib/app-mode";

export type TimeWindow =
  | { kind: "preset"; days: number; label: string }
  | { kind: "custom"; from: string; to: string };

const ALL_PRESETS: Array<{ days: number; label: string }> = [
  { days: 7, label: "Siste uke" },
  { days: 14, label: "Siste 2 uker" },
  { days: 30, label: "Siste måned" },
  { days: 90, label: "Siste 3 mnd" },
  { days: 365, label: "Siste år" },
];

// Reise-bygget har maks 14 uker rådata (parquet på R2) — «Siste år» ville
// stille vist samme tall som 3 mnd.
export const PRESETS: Array<{ days: number; label: string }> = IS_REISE
  ? ALL_PRESETS.filter((p) => p.days <= 90)
  : ALL_PRESETS;

export function windowToQuery(w: TimeWindow): string {
  if (w.kind === "preset") return `days=${w.days}`;
  return `from=${w.from}&to=${w.to}`;
}

export function windowDays(w: TimeWindow): number {
  if (w.kind === "preset") return w.days;
  const fromMs = Date.parse(w.from);
  const toMs = Date.parse(w.to);
  return Math.max(1, Math.ceil((toMs - fromMs) / 86400000) + 1);
}

export function windowLabel(w: TimeWindow): string {
  if (w.kind === "preset") return w.label;
  return `${formatDateNO(w.from)} – ${formatDateNO(w.to)}`;
}

/** Kompakt strengkoding av et TimeWindow — for URL-persistering (?window=d30). */
export function serializeWindow(w: TimeWindow): string {
  if (w.kind === "preset") return `d${w.days}`;
  return `c${w.from}_${w.to}`;
}

/** Motsatt av serializeWindow. Faller tilbake til `fallback` ved ugyldig/tom streng. */
export function parseWindow(s: string, fallback: TimeWindow): TimeWindow {
  if (s.startsWith("d")) {
    const days = parseInt(s.slice(1), 10);
    const preset = ALL_PRESETS.find((p) => p.days === days);
    if (preset) return { kind: "preset", days: preset.days, label: preset.label };
  } else if (s.startsWith("c")) {
    const [from, to] = s.slice(1).split("_");
    if (from && to) return { kind: "custom", from, to };
  }
  return fallback;
}

type Props = {
  value: TimeWindow;
  onChange: (w: TimeWindow) => void;
  className?: string;
  /** Vis kun presets med disse dagene (f.eks. [7, 30, 90] der backend bare
   *  har forhåndsberegnede vinduer). Default: alle. */
  presetDays?: number[];
  /** Skjul egendefinert datointervall der backend ikke støtter det. */
  allowCustom?: boolean;
};

export function TimeWindowPicker({
  value,
  onChange,
  className,
  presetDays,
  allowCustom = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState<string>(value.kind === "custom" ? value.from : "");
  const [draftTo, setDraftTo] = useState<string>(value.kind === "custom" ? value.to : "");

  const apply = (from: string, to: string) => {
    if (!from || !to) return;
    const a = from <= to ? from : to;
    const b = from <= to ? to : from;
    onChange({ kind: "custom", from: a, to: b });
    setOpen(false);
  };

  const presets = presetDays
    ? PRESETS.filter((p) => presetDays.includes(p.days))
    : PRESETS;

  return (
    <div className={cn("flex items-center gap-2 flex-wrap", className)}>
      <span className="text-sm text-muted-foreground">Periode:</span>
      {presets.map((p) => (
        <Button
          key={p.days}
          size="sm"
          variant={value.kind === "preset" && value.days === p.days ? "default" : "outline"}
          onClick={() => onChange({ kind: "preset", days: p.days, label: p.label })}
          className="h-7 px-3 text-xs"
        >
          {p.label}
        </Button>
      ))}
      {allowCustom && (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant={value.kind === "custom" ? "default" : "outline"}
            className="h-7 px-3 text-xs"
          >
            <CalendarIcon className="h-3 w-3 mr-1" />
            {value.kind === "custom" ? windowLabel(value) : "Velg datoer"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-3" align="start">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={draftFrom}
                onChange={(e) => setDraftFrom(e.target.value)}
                className="h-8 text-xs w-[140px]"
              />
              <span className="text-xs text-muted-foreground">til</span>
              <Input
                type="date"
                value={draftTo}
                onChange={(e) => setDraftTo(e.target.value)}
                className="h-8 text-xs w-[140px]"
              />
            </div>
            <Calendar
              mode="range"
              selected={
                draftFrom && draftTo
                  ? { from: new Date(draftFrom), to: new Date(draftTo) }
                  : undefined
              }
              onSelect={(range: any) => {
                if (range?.from) setDraftFrom(toIsoDate(range.from));
                if (range?.to) setDraftTo(toIsoDate(range.to));
              }}
              numberOfMonths={2}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Avbryt</Button>
              <Button
                size="sm"
                disabled={!draftFrom || !draftTo}
                onClick={() => apply(draftFrom, draftTo)}
              >
                Bruk
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      )}
    </div>
  );
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
