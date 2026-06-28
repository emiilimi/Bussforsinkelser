// ---------------------------------------------------------------------------
// Byggemodus-flagg.
//
// `VITE_APP=reise vite build` produserer den frittstående reiseplanlegger-siten
// (reise.emoldestad.no): trimmet router (kun /reise, /avganger, /metode),
// trimmet sidebar, og ingen avhengighet til SQLite-backenden — alt henter fra
// Entur-proxyen (Pages Functions) + Parquet på R2.
//
// Default (uten flagget) er det fulle analysenettstedet, helt uendret.
// ---------------------------------------------------------------------------

export const APP_MODE: string =
  (import.meta as any).env?.VITE_APP ?? "full";

/** True når vi bygger den frittstående reiseplanlegger-siten. */
export const IS_REISE = APP_MODE === "reise";
