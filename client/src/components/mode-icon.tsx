import { Bus, TramFront, Train, Ship, Plane } from "lucide-react";
import { cn } from "@/lib/utils";

export type VehicleMode = "bus" | "coach" | "tram" | "metro" | "rail" | "water";

const ICONS: Record<VehicleMode, typeof Bus> = {
  bus: Bus,
  coach: Bus,
  tram: TramFront,
  metro: TramFront,
  rail: Train,
  water: Ship,
};

const LABELS: Record<VehicleMode, string> = {
  bus: "Buss",
  coach: "Flybuss",
  tram: "Bybane",
  metro: "T-bane",
  rail: "Tog",
  water: "Båt",
};

/**
 * Whether we have historic delay statistics for this mode in our DB.
 * Currently only buss/flybuss are ingested from Skyss SIRI ET. Tram/rail/water
 * placeholder support is wired up but the DB has no rows yet.
 */
export const MODES_WITH_DELAY_DATA: ReadonlySet<VehicleMode> = new Set<VehicleMode>(["bus", "coach"]);

export function modeLabel(mode: string | null | undefined): string {
  if (!mode) return LABELS.bus;
  return LABELS[mode as VehicleMode] ?? LABELS.bus;
}

export function ModeIcon({
  mode,
  className,
  size = 16,
}: {
  mode: string | null | undefined;
  className?: string;
  size?: number;
}) {
  const key = (mode ?? "bus") as VehicleMode;
  const Icon = ICONS[key] ?? Bus;
  return (
    <Icon
      className={cn("inline-block shrink-0", className)}
      size={size}
      aria-label={modeLabel(key)}
    />
  );
}
