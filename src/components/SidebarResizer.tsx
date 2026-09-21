import { useRef } from "react";

export function SidebarResizer({ width, min, max, onChange }: {
  width: number;
  min: number;
  max: number;
  onChange: (width: number | null) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resize = (value: number) => onChange(Math.max(min, Math.min(max, value)));
  return <div className="sidebar-resizer" role="separator" tabIndex={0} aria-label="Resize sessions sidebar"
    aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
    aria-valuetext={`${width} pixels`}
    title="Drag to resize sessions. Arrow keys adjust; double-click or Enter resets."
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, width };
    }}
    onPointerMove={(event) => {
      if (drag.current) resize(drag.current.width + event.clientX - drag.current.x);
    }}
    onPointerUp={() => { drag.current = null; }}
    onPointerCancel={() => { drag.current = null; }}
    onLostPointerCapture={() => { drag.current = null; }}
    onDoubleClick={() => onChange(null)}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 50 : 10;
      if (event.key === "ArrowLeft") resize(width - step);
      else if (event.key === "ArrowRight") resize(width + step);
      else if (event.key === "Home") resize(min);
      else if (event.key === "End") resize(max);
      else if (event.key === "Enter") onChange(null);
      else return;
      event.preventDefault();
      event.stopPropagation();
    }} />;
}
