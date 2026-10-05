// ---------------------------------------------------------------------------
// Kart over stopp: størrelse = passasjerer eller passasjertimer tapt,
// farge = forsinkelsen passasjerene som gikk av der merket.
//
// Lastes lat (React.lazy) fra passengers.tsx så Leaflet ikke havner i
// sidens hoved-chunk. Fargeskalaen er den samme som getColor i delay-map.tsx.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup, ZoomControl, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { cn } from "@/lib/utils";
import { usePaxStops, fmtInt, fmtMin, type PaxOperator, type PaxStopRow } from "@/lib/pax";

const getColor = (delay: number) => {
  if (delay < 1) return "#10b981";
  if (delay < 3) return "#fbbf24";
  if (delay < 5) return "#f97316";
  if (delay < 10) return "#ef4444";
  return "#991b1b";
};

type Metric = "lost" | "people";

function FitTo({ rows }: { rows: PaxStopRow[] }) {
  const map = useMap();
  useEffect(() => {
    if (rows.length === 0) return;
    // De 60 største stoppene bestemmer utsnittet — enkeltstopp langt ute
    // (fjerntliggende kaier o.l.) skal ikke zoome kartet ut til hele fylket.
    const top = rows.slice(0, 60);
    const lats = top.map((r) => r[2]).sort((a, b) => a - b);
    const lons = top.map((r) => r[3]).sort((a, b) => a - b);
    const q = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))))];
    map.fitBounds([[q(lats, 0.05), q(lons, 0.05)], [q(lats, 0.95), q(lons, 0.95)]], { padding: [20, 20] });
  }, [rows, map]);
  return null;
}

export default function PaxStopMap({ op, opName }: { op: PaxOperator; opName: string }) {
  const { data, isLoading } = usePaxStops(op);
  const [metric, setMetric] = useState<Metric>("lost");

  const rows = useMemo(() => {
    const all = (data ?? []).filter((r) => r[2] && r[3]);
    const val = (r: PaxStopRow) => (metric === "lost" ? r[6] ?? 0 : r[4] + r[5]);
    return [...all].sort((a, b) => val(b) - val(a));
  }, [data, metric]);
  const maxVal = useMemo(() => {
    const vals = rows.map((r) => (metric === "lost" ? r[6] ?? 0 : r[4] + r[5]));
    return Math.max(1, vals[0] ?? 1);
  }, [rows, metric]);

  // Tegn fra minst til størst, så de store ligger øverst og er klikkbare
  const drawn = useMemo(() => [...rows].reverse(), [rows]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border p-0.5 text-xs">
          <button onClick={() => setMetric("lost")} className={cn("px-2.5 py-1 rounded", metric === "lost" ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
            Størrelse: timer tapt
          </button>
          <button onClick={() => setMetric("people")} className={cn("px-2.5 py-1 rounded", metric === "people" ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
            Størrelse: passasjerer
          </button>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>Merket forsinkelse:</span>
          {[["< 1", "#10b981"], ["1–3", "#fbbf24"], ["3–5", "#f97316"], ["5–10", "#ef4444"], ["> 10 min", "#991b1b"]].map(([l, c]) => (
            <span key={l} className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} />
              {l}
            </span>
          ))}
        </div>
      </div>
      <div className="h-[460px] rounded-lg overflow-hidden border relative">
        {isLoading && (
          <div className="absolute inset-0 z-[500] flex items-center justify-center bg-background/60 text-sm text-muted-foreground">
            Henter stopp …
          </div>
        )}
        <MapContainer center={[59, 7]} zoom={8} className="w-full h-full z-0" zoomControl={false} preferCanvas scrollWheelZoom={false}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <ZoomControl position="bottomright" />
          <FitTo rows={rows} />
          {drawn.map((r) => {
            const v = metric === "lost" ? r[6] ?? 0 : r[4] + r[5];
            if (v <= 0) return null;
            const radius = Math.max(2, 22 * Math.sqrt(v / maxVal));
            const color = r[7] != null ? getColor(r[7]) : "#9ca3af";
            return (
              <CircleMarker
                key={r[0]}
                center={[r[2], r[3]]}
                radius={radius}
                pathOptions={{ fillColor: color, fillOpacity: 0.7, color: "white", weight: radius > 6 ? 1 : 0 }}
              >
                <Popup>
                  <div className="text-xs space-y-0.5 min-w-[180px]">
                    <div className="font-semibold text-sm">{r[1] ?? r[0]}</div>
                    <div>Påstigninger: <b>{fmtInt(r[4])}</b> · avstigninger: <b>{fmtInt(r[5])}</b></div>
                    <div>Merket forsinkelse: <b style={{ color }}>{fmtMin(r[7])}</b></div>
                    <div>Passasjertimer tapt: <b>{fmtInt(r[6])}</b></div>
                    {r[8] && <div className="text-muted-foreground">Inkluderer tellinger flyttet hit fra stopp med få bosatte.</div>}
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>
      <p className="text-xs text-muted-foreground">
        {fmtInt(rows.length)} stopp hos {opName}, siste måned. Fargen er snitt ankomstforsinkelse for dem som gikk av ved stoppet.
        Timer tapt telles der folk går av, så store sirkler ligger ofte ved knutepunkter og endeholdeplasser.
      </p>
    </div>
  );
}
