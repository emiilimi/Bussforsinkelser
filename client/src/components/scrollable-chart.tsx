import { useRef, useCallback, useState, useEffect } from "react";

/**
 * Hook for Y-axis drag: drag up/down on the Y-axis area to adjust yMax.
 * Returns { onMouseDown, isDragging } plus updates yMax via the setter.
 */
export function useYAxisDrag(
  yMax: number,
  setYMax: (v: number) => void,
  dataMax: number,
  minVal = 1,
) {
  const dragState = useRef<{ startY: number; startMax: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only respond to clicks in the left ~50px (Y-axis area)
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const relX = e.clientX - rect.left;
      if (relX > 55) return; // not on Y-axis

      e.preventDefault();
      dragState.current = { startY: e.clientY, startMax: yMax };
      setIsDragging(true);
    },
    [yMax],
  );

  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      if (!dragState.current) return;
      const dy = dragState.current.startY - e.clientY; // up = positive
      const scale = dataMax / 200; // sensitivity: 200px drag = full range
      const newMax = Math.max(minVal, Math.min(dataMax, dragState.current.startMax + dy * scale));
      setYMax(Math.round(newMax * 2) / 2); // snap to 0.5
    };

    const onMouseUp = () => {
      dragState.current = null;
      setIsDragging(false);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragging, dataMax, minVal, setYMax]);

  return { onMouseDown, isDragging };
}

/**
 * Vertical Y-axis slider control with reset button.
 * Placed to the right of charts for easy access.
 */
function YAxisSlider({ yMax, setYMax, dataMax, height }: {
  yMax: number; setYMax: (v: number) => void; dataMax: number; height: number;
}) {
  if (dataMax <= 2) return null;
  return (
    <div className="flex flex-col items-center gap-1 ml-1" style={{ height }}>
      <button
        onClick={() => setYMax(dataMax)}
        className="text-[9px] text-muted-foreground hover:text-foreground transition-colors px-1"
        title="Tilbakestill Y-akse"
      >
        ↺
      </button>
      <input
        type="range"
        min={1}
        max={dataMax}
        step={0.5}
        value={yMax}
        onChange={(e) => setYMax(Number(e.target.value))}
        className="h-full w-4 accent-primary"
        style={{
          writingMode: "vertical-lr",
          direction: "rtl",
        } as React.CSSProperties}
        title={`Y-maks: ${yMax}m`}
      />
      <span className="text-[9px] text-muted-foreground font-mono">{yMax}m</span>
    </div>
  );
}

/**
 * ScrollableChart: renders a sticky Y-axis overlay on the left while the chart scrolls horizontally.
 * Also includes a vertical slider on the right for Y-axis control.
 */
type ScrollableChartProps = {
  chartWidth: number;
  chartHeight: number;
  yMax: number;
  setYMax: (v: number) => void;
  dataMax: number;
  children: React.ReactNode;
  marginTop?: number;
  marginBottom?: number;
};

export function ScrollableChart({
  chartWidth,
  chartHeight,
  yMax,
  setYMax,
  dataMax,
  children,
  marginTop = 10,
  marginBottom = 80,
}: ScrollableChartProps) {
  const { onMouseDown, isDragging } = useYAxisDrag(yMax, setYMax, dataMax);

  // Generate Y-axis ticks for the overlay
  const plotHeight = chartHeight - marginTop - marginBottom;
  const tickCount = 5;
  const ticks: { value: number; y: number }[] = [];
  for (let i = 0; i <= tickCount; i++) {
    const value = (yMax / tickCount) * i;
    const y = marginTop + plotHeight - (value / yMax) * plotHeight;
    ticks.push({ value, y });
  }

  return (
    <div className="flex items-stretch">
      <div
        className="relative flex-1 min-w-0"
        style={{ cursor: isDragging ? "ns-resize" : undefined }}
        onMouseDown={onMouseDown}
      >
        {/* Scrollable chart area */}
        <div className="overflow-x-auto">
          <div style={{ width: chartWidth, height: chartHeight }}>
            {children}
          </div>
        </div>

        {/* Sticky Y-axis overlay on the left */}
        <div
          className="absolute top-0 left-0 pointer-events-none"
          style={{ width: 55, height: chartHeight }}
        >
          <div className="absolute inset-0 bg-gradient-to-r from-card via-card to-transparent" />
          <svg width={55} height={chartHeight} className="relative">
            {ticks.map((t, i) => (
              <g key={i}>
                <text
                  x={48}
                  y={t.y + 3}
                  textAnchor="end"
                  fontSize={11}
                  fill="hsl(var(--muted-foreground))"
                >
                  {t.value.toFixed(0)}m
                </text>
                <line
                  x1={50}
                  x2={55}
                  y1={t.y}
                  y2={t.y}
                  stroke="hsl(var(--border))"
                  strokeWidth={1}
                />
              </g>
            ))}
          </svg>
        </div>

        {/* Drag hint on Y-axis */}
        <div
          className="absolute top-0 left-0 w-[55px] cursor-ns-resize pointer-events-auto opacity-0 hover:opacity-100 transition-opacity"
          style={{ height: chartHeight }}
          title="Dra for å justere Y-akse"
        >
          <div className="absolute left-1 top-1/2 -translate-y-1/2 text-[8px] text-muted-foreground/50 select-none">
            ↕
          </div>
        </div>
      </div>

      {/* Vertical slider on the right */}
      <YAxisSlider yMax={yMax} setYMax={setYMax} dataMax={dataMax} height={chartHeight - marginBottom} />
    </div>
  );
}
