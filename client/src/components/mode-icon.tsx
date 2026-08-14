import { Bus, TramFront, Train, Ship, Plane } from "lucide-react";
import { cn } from "@/lib/utils";

// To navnepar der sanntidsfeeden og Entur Journey Planner sier ULIKE ting om
// samme transportmiddel — begge må finnes her, ellers ser det ut som «ingen
// data» selv når dataene er der:
//   båt: feeden sier 'ferry', Entur sier 'water'
//   fly: vi lagrer 'airplane' (AVI/Avinor), Entur/SIRI sier 'air'
export type VehicleMode =
  | "bus" | "coach" | "tram" | "metro" | "rail" | "water" | "ferry" | "airplane" | "air";

const ICONS: Record<VehicleMode, typeof Bus> = {
  bus: Bus,
  coach: Bus,
  tram: TramFront,
  metro: TramFront,
  rail: Train,
  water: Ship,
  ferry: Ship,
  airplane: Plane,
  air: Plane,
};

const LABELS: Record<VehicleMode, string> = {
  bus: "Buss",
  coach: "Flybuss",
  tram: "Bybane",
  metro: "T-bane",
  rail: "Tog",
  water: "Båt",
  ferry: "Ferje",
  airplane: "Fly",
  air: "Fly",
};

/**
 * Modes we actually have historic delay statistics for.
 *
 * Målt på R2 (uke 31–32 2026): bus 14,4 mill. rader, rail 150 793,
 * ferry 98 741, tram 14 940 — altså har tog, båt og bybane ekte tall, bare
 * langt færre enn buss. Settet sa tidligere {bus, coach, ferry} og skjulte
 * dermed statistikk vi faktisk hadde.
 *
 * BEGGE båt-navnene må stå her: sanntidsfeeden (og parqueten) bruker `ferry`,
 * mens Entur Journey Planner returnerer `water` for de samme rutene. Dette
 * settet sammenliknes mot Enturs `leg.mode`, så uten `water` ble båt vist som
 * «ingen data» selv når dataene fantes.
 *
 * `coach` beholdes fordi Entur bruker den for ekspressbuss; i våre egne data
 * ligger de under `bus`.
 */
export const MODES_WITH_DELAY_DATA: ReadonlySet<VehicleMode> = new Set<VehicleMode>([
  "bus", "coach", "ferry", "water", "rail", "tram", "airplane", "air",
]);

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
