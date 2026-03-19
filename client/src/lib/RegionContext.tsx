import { createContext, useContext, useState, ReactNode } from "react";

export type Region = "vestland" | "oslo" | "viken" | "rogaland" | "trondelag" | "agder";

// Maps each region to its Entur NeTEx operator code (used to filter lineRef)
export const REGION_OPERATOR: Record<Region, string> = {
  vestland: "SKY",
  oslo: "RUT",
  viken: "RUT",
  rogaland: "KOL",
  trondelag: "ATB",
  agder: "AKT",
};

export const REGION_LABEL: Record<Region, string> = {
  vestland: "Vestland",
  oslo: "Oslo",
  viken: "Viken",
  rogaland: "Rogaland",
  trondelag: "Trøndelag",
  agder: "Agder",
};

interface RegionContextType {
  region: Region;
  setRegion: (region: Region) => void;
  operator: string;
}

const STORAGE_KEY = "bussforsinkelser_region";

function getSavedRegion(): Region {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in REGION_OPERATOR) return saved as Region;
  } catch {
    // localStorage unavailable (SSR, private mode)
  }
  return "vestland";
}

const RegionContext = createContext<RegionContextType | undefined>(undefined);

export function RegionProvider({ children }: { children: ReactNode }) {
  const [region, setRegionState] = useState<Region>(getSavedRegion);

  const setRegion = (r: Region) => {
    setRegionState(r);
    try {
      localStorage.setItem(STORAGE_KEY, r);
    } catch {
      // ignore write errors
    }
  };

  return (
    <RegionContext.Provider value={{ region, setRegion, operator: REGION_OPERATOR[region] }}>
      {children}
    </RegionContext.Provider>
  );
}

export function useRegion() {
  const context = useContext(RegionContext);
  if (!context) throw new Error("useRegion must be used within a RegionProvider");
  return context;
}
