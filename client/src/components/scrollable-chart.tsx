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
