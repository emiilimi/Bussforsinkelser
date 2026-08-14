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
  | "vot"
  | "avi";

/**
 * Region → LINJE-prefiksene den dekker (brukes til å filtrere på `line_ref`).
 * Tom liste = ingen filtrering (alle).
 *
 * Hvorfor en LISTE og ikke én kode: `dataSource` (hvem som publiserer feeden)
 * og linjas eget prefiks er ULIKE navnerom, og for noen fylker er de ikke like.
 * Filtrene her kjører mot `split_part(line_ref, ':', 1)`, altså linje-prefikset.
 *
 * Målt mot produksjonsdata 2026-08-14 (uke 32–33) — før dette pekte `vot` og
 * `bnr` på koder som ALDRI forekommer som linje-prefiks, så begge regionene ga
 * tomme lister, og ~865 000 rader var uleselige gjennom regionvelgeren:
 *   VOT publiserer linjene VKT (517 991 rader) og TEL (335 255)
 *   BNR publiserer SJN (11 695), SJV (211), TM (141) og Vy (25)
 *   OST publiserer i tillegg BOR (4 rader)
 */
export const REGION_OPERATOR: Record<Region, string[]> = {
  alle: [],
  sky: ["SKY"],
  mor: ["MOR"],
  inn: ["INN"],
  ost: ["OST", "BOR"],
  rut: ["RUT"],
  kol: ["KOL"],
  vyg: ["VYG"],
  tro: ["TRO"],
  bra: ["BRA"],
  fin: ["FIN"],
  nor: ["NOR"],
  akt: ["AKT"],
  atb: ["ATB"],
  bnr: ["SJN", "SJV", "TM", "Vy"],
  nbu: ["NBU"],
  fli: ["FLI"],
  flt: ["FLT"],
  goa: ["GOA"],
  vot: ["VKT", "TEL"],
  avi: ["AVI"],
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
  vot: "Vestfold og Telemark (VKT/Farte)",
  avi: "Avinor (fly)",
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
  // flatMap: én region kan dekke flere linje-prefikser (se REGION_OPERATOR).
  const operators = regions.flatMap((r) => REGION_OPERATOR[r] ?? []);

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
