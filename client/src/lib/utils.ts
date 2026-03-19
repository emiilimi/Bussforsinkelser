import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

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
