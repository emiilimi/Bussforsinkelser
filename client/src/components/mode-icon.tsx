import { Bus, TramFront, Train, Ship, Plane } from "lucide-react";
import { cn } from "@/lib/utils";

// 'ferry' = Skyss SIRI ET vehicleMode for boat routes (not NeTEx 'water').
export type VehicleMode = "bus" | "coach" | "tram" | "metro" | "rail" | "water" | "ferry";

const ICONS: Record<VehicleMode, typeof Bus> = {
  bus: Bus,
  coach: Bus,
  tram: TramFront,
  metro: TramFront,
  rail: Train,
  water: Ship,
  ferry: Ship,
};

const LABELS: Record<VehicleMode, string> = {
  bus: "Buss",
  coach: "Flybuss",
  tram: "Bybane",
  metro: "T-bane",
  rail: "Tog",
  water: "Båt",
  ferry: "Ferje",
};

/**
 * Modes for which we have historic delay statistics in the DB.
 * Bus + coach (flybuss) come from Skyss SIRI ET.
 * Ferry routes are now also ingested (Skyss uses vehicleMode='ferry').
 */
export const MODES_WITH_DELAY_DATA: ReadonlySet<VehicleMode> = new Set<VehicleMode>(["bus", "coach", "ferry"]);

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
