import { createContext, useContext, useState, ReactNode } from "react";

export type Region =
  | "alle"
  | "sky"
  | "mor"
  | "inn"
  | "ost"
  | "rut"
  | "kol"
  | "vyg"
  | "tro"
  | "bra"
  | "fin"
  | "nor"
  | "akt"
  | "atb"
  | "bnr"
  | "nbu"
  | "fli"
  | "flt"
  | "goa"
  | "vot";

// Maps each region key to its NeTEx operator code (used to filter lineRef / API calls).
// Empty string = no filter (alle).
export const REGION_OPERATOR: Record<Region, string> = {
  alle: "",
  sky: "SKY",
  mor: "MOR",
  inn: "INN",
  ost: "OST",
  rut: "RUT",
  kol: "KOL",
  vyg: "VYG",
  tro: "TRO",
  bra: "BRA",
  fin: "FIN",
  nor: "NOR",
  akt: "AKT",
  atb: "ATB",
  bnr: "BNR",
  nbu: "NBU",
  fli: "FLI",
  flt: "FLT",
  goa: "GOA",
  vot: "VOT",
};

// Offisielle operatørnavn per codespace, hentet fra Enturs egen liste:
// https://entur.atlassian.net/wiki/spaces/PUBLIC/pages/637370434/List+of+current+Codespaces
export const REGION_LABEL: Record<Region, string> = {
  alle: "Alle operatører",
  sky: "Skyss (Vestland)",
  mor: "Fram (Møre og Romsdal)",
  inn: "Innlandet",
  ost: "Østfold kollektivtrafikk",
  rut: "Ruter (Oslo/Akershus)",
  kol: "Kolumbus (Rogaland)",
  vyg: "Vy Group",
  tro: "Troms fylkestrafikk",
  bra: "Brakar (Buskerud)",
  fin: "Snelandia (Finnmark)",
  nor: "Nordland fylkeskommune",
  akt: "Agder kollektivtrafikk",
  atb: "AtB (Trøndelag)",
  bnr: "Bane NOR",
  nbu: "Connect Bus Flybuss",
  fli: "Flixbus",
  flt: "Flytoget",
  goa: "Go Ahead",
  vot: "Vestfold og Telemark",
};

// All individual region keys (excluding "alle" sentinel)
export const INDIVIDUAL_REGIONS = Object.keys(REGION_OPERATOR).filter(
  (k) => k !== "alle",
) as Exclude<Region, "alle">[];

interface RegionContextType {
  /** Currently selected regions. Empty array means "alle" (no filter). */
  regions: Region[];
  setRegions: (r: Region[]) => void;
  /** Derived: operator codes for API calls. Empty array = no filter (alle). */
  operators: string[];
  // Legacy single-value accessors for pages not yet migrated (still used by some hooks)
  region: Region;
  operator: string;
}

const STORAGE_KEY = "bussforsinkelser_region";

function getSavedRegions(): Region[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return [];

    // New format: JSON array like ["sky","rut"] or []
    if (saved.startsWith("[")) {
      const parsed = JSON.parse(saved) as unknown;
      if (Array.isArray(parsed)) {
        const valid = (parsed as unknown[]).filter(
          (r): r is Region => typeof r === "string" && r in REGION_OPERATOR,
        );
        return valid.length > 0 ? valid : [];
      }
    }

    // Migrate old string keys
    const MIGRATE: Record<string, Region> = {
      vestland: "sky",
      oslo: "rut",
      viken: "rut",
      rogaland: "kol",
      trondelag: "tro",
      agder: "kol",
    };
    if (saved in REGION_OPERATOR) {
      const r = saved as Region;
      return r === "alle" ? [] : [r];
    }
    if (saved in MIGRATE) return [MIGRATE[saved]];
  } catch {
    // localStorage unavailable
  }
  return [];
}

const RegionContext = createContext<RegionContextType | undefined>(undefined);

export function RegionProvider({ children }: { children: ReactNode }) {
  const [regions, setRegionsState] = useState<Region[]>(getSavedRegions);

  const setRegions = (r: Region[]) => {
    setRegionsState(r);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
    } catch {
      // ignore
    }
  };

  // operators: actual codes for the API (empty = no filter = alle)
  const operators = regions
    .map((r) => REGION_OPERATOR[r])
    .filter((op) => op !== "" && op !== "alle");

  // Legacy: expose first region / first operator for pages not yet fully migrated
  const region: Region = regions.length === 0 ? "alle" : regions[0];
  const operator = operators[0] ?? "";

  return (
    <RegionContext.Provider value={{ regions, setRegions, operators, region, operator }}>
      {children}
    </RegionContext.Provider>
  );
}

export function useRegion() {
  const context = useContext(RegionContext);
  if (!context) throw new Error("useRegion must be used within a RegionProvider");
  return context;
}
