import { useEffect, useRef, useState } from "react";

export function ResizableDivider({
  label,
  controls,
  value,
  min,
  max,
  onChange,
  onReset,
}: {
  label: string;
  controls: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ x: number; value: number } | null>(null);
  const [active, setActive] = useState(false);
  const clamp = (v: number) => Math.round(Math.max(min, Math.min(max, v)));
  useEffect(
    () => () => document.documentElement.classList.remove("resizing-columns"),
    [],
  );
  function finish() {
    drag.current = null;
    setActive(false);
    document.documentElement.classList.remove("resizing-columns");
  }
  return (
    <div className="divider-region" role="region" aria-label={label}>
      <div
        className={`column-divider ${active ? "dragging" : ""}`}
        role="separator"
        tabIndex={0}
        aria-label={label}
        aria-orientation="vertical"
        aria-controls={controls}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${value} 像素`}
        title="拖动调整栏宽；方向键微调；双击恢复默认"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, value };
          setActive(true);
          document.documentElement.classList.add("resizing-columns");
        }}
        onPointerMove={(e) => {
          if (drag.current)
            onChange(clamp(drag.current.value + e.clientX - drag.current.x));
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onDoubleClick={onReset}
        onKeyDown={(e) => {
          if (
            ["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(e.key)
          ) {
            e.preventDefault();
            if (e.key === "Enter") onReset();
            else
              onChange(
                clamp(
                  e.key === "Home"
                    ? min
                    : e.key === "End"
                      ? max
                      : value +
                        (e.key === "ArrowLeft" ? -1 : 1) *
                          (e.shiftKey ? 50 : 10),
                ),
              );
          }
        }}
      >
        <span aria-hidden="true" />
      </div>
    </div>
  );
}
