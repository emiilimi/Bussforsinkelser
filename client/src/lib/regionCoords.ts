import type { Region } from "./RegionContext";

/**
 * Map center coordinates and default zoom level for each region.
 * Center is placed at the main city / most densely served area.
 */
export const REGION_MAP_CENTER: Record<Region, { lat: number; lng: number; zoom: number }> = {
  vestland:  { lat: 60.3913, lng:  5.3221, zoom: 12 }, // Bergen sentrum
  oslo:      { lat: 59.9139, lng: 10.7522, zoom: 12 }, // Oslo sentrum
  viken:     { lat: 59.7440, lng: 10.2045, zoom: 10 }, // Drammen — geografisk midtpunkt i Viken
  rogaland:  { lat: 58.9700, lng:  5.7331, zoom: 12 }, // Stavanger sentrum
  trondelag: { lat: 63.4305, lng: 10.3951, zoom: 12 }, // Trondheim sentrum
  agder:     { lat: 58.1599, lng:  8.0182, zoom: 12 }, // Kristiansand sentrum
};
