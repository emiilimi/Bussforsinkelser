import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Recharts tooltip props — minimal shape for our content callbacks.
 * Recharts ships its own TooltipProps, but it's heavy on generics; this
 * lightweight shape covers what our custom tooltips actually use.
 */
export type RechartsTooltipProps<T = Record<string, unknown>> = {
  active?: boolean;
  label?: string | number;
  payload?: Array<{
    value?: number | string;
    name?: string;
    dataKey?: string;
    color?: string;
    payload: T;
  }>;
};

/**
 * Returns a human-readable stop name.
 * If the name is null or looks like a raw NSR ID (e.g. "NSR:Quay:12345"),
 * extracts the numeric part and returns "Stoppested 12345".
 */
export function formatStopName(name: string | null | undefined, ref?: string): string {
  if (name && !name.startsWith("NSR:")) return name;
  const id = ref ?? name ?? "";
  const match = id.match(/:(\d+)$/);
  return match ? `Stoppested ${match[1]}` : id;
}
