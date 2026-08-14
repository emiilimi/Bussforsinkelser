import type { Region } from "./RegionContext";

/**
 * Map center coordinates and default zoom level for each region.
 * Center is placed at the main city / most densely served area.
 */
export const REGION_MAP_CENTER: Record<Region, { lat: number; lng: number; zoom: number }> = {
  alle:  { lat: 65.0,    lng: 13.5,   zoom: 5  }, // Norge senter
  sky:   { lat: 60.3913, lng:  5.3221, zoom: 12 }, // Bergen sentrum
  mor:   { lat: 62.4722, lng:  6.1495, zoom: 11 }, // Ålesund
  inn:   { lat: 60.7945, lng: 11.0680, zoom: 10 }, // Hamar/Lillehammer-området
  ost:   { lat: 59.2181, lng: 10.9298, zoom: 11 }, // Fredrikstad
  rut:   { lat: 59.9139, lng: 10.7522, zoom: 12 }, // Oslo sentrum
  kol:   { lat: 58.9700, lng:  5.7331, zoom: 12 }, // Stavanger sentrum
  vyg:   { lat: 59.7440, lng: 10.2045, zoom: 10 }, // Drammen (Vy grønn knutepunkt)
  tro:   { lat: 69.6492, lng: 18.9553, zoom: 12 }, // Tromsø sentrum
  bra:   { lat: 59.7440, lng: 10.2045, zoom: 11 }, // Drammen (Brakar)
  fin:   { lat: 70.0663, lng: 23.2714, zoom: 10 }, // Alta/Hammerfest-området
  nor:   { lat: 67.2804, lng: 14.4049, zoom: 10 }, // Bodø
  akt:   { lat: 58.1467, lng:  7.9956, zoom: 11 }, // Kristiansand (Agder)
  atb:   { lat: 63.4305, lng: 10.3951, zoom: 11 }, // Trondheim (AtB)
  bnr:   { lat: 65.0,    lng: 13.5,    zoom:  5 }, // Bane NOR (landsdekkende jernbane)
  nbu:   { lat: 65.0,    lng: 13.5,    zoom:  5 }, // Connect Bus Flybuss (landsdekkende)
  fli:   { lat: 65.0,    lng: 13.5,    zoom:  5 }, // Flixbus (langdistanse)
  flt:   { lat: 60.0,    lng: 11.1,    zoom: 10 }, // Oslo–Gardermoen (Flytoget)
  goa:   { lat: 58.5,    lng:  8.5,    zoom:  7 }, // Sør-Norge tog (Go Ahead)
  vot:   { lat: 59.2674, lng: 10.4076, zoom: 10 }, // Tønsberg (Vestfold og Telemark)
  avi:   { lat: 65.0,    lng: 13.5,    zoom:  5 }, // Fly — hele landet
};
