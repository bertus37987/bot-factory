import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/* --------------------------------------------------------------------------
 * Bot-Factory Studio — Reasoning Effort Control
 * Compact trigger pill ("Effort · <Level>" with burnt-orange stop dot) +
 * tactile 4-stop #D95D22 horizontal slider popover.
 * ------------------------------------------------------------------------ */

export type ReasoningEffort = "low" | "medium" | "high" | "max";

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
};

const ORDER: ReasoningEffort[] = ["low", "medium", "high", "max"];
const DOT_OFF = "#A1A1AA";

export interface ReasoningEffortControlProps {
  value: ReasoningEffort;
  onChange: (next: ReasoningEffort) => void;
  disabled?: boolean;
}

export function ReasoningEffortControl({
  value,
  onChange,
  disabled = false,
}: ReasoningEffortControlProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const index = Math.max(0, ORDER.indexOf(value));

  const setIndex = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(ORDER.length - 1, next));
      onChange(ORDER[clamped]!);
    },
    [onChange],
  );

  const indexFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return index;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return index;
      const fraction = (clientX - rect.left) / rect.width;
      return Math.round(fraction * (ORDER.length - 1));
    },
    [index],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const onSliderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    setIndex(indexFromClientX(e.clientX));
  };

  const onSliderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging || disabled) return;
    setIndex(indexFromClientX(e.clientX));
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onSliderKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(index - 1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(index + 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      setIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setIndex(ORDER.length - 1);
    }
  };

  const stopLeft = (i: number) => `${(i / (ORDER.length - 1)) * 100}%`;

  return (
    <div ref={rootRef} className="bf-effort-root">
      <button
        type="button"
        className="bf-effort-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Reasoning effort: ${EFFORT_LABELS[value]}`}
        title={`Reasoning effort: ${EFFORT_LABELS[value]}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="bf-effort-dot-pill" aria-hidden="true" />
        <span>Effort · {EFFORT_LABELS[value]}</span>
      </button>

      {open && (
        <div className="bf-effort-popover" role="dialog" aria-label="Select reasoning effort">
          <div
            className="bf-effort-slider"
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-valuemin={0}
            aria-valuemax={ORDER.length - 1}
            aria-valuenow={index}
            aria-valuetext={EFFORT_LABELS[value]}
            aria-disabled={disabled || undefined}
            onPointerDown={onSliderPointerDown}
            onPointerMove={onSliderPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onSliderKeyDown}
          >
            <div className="bf-effort-track-bg" aria-hidden="true">
              <div
                className="bf-effort-track-fill"
                style={{
                  width: `calc(6px + (100% - 12px) * ${index / (ORDER.length - 1)})`,
                }}
              />
            </div>
            <div ref={trackRef} className="bf-effort-inner-track">
              {ORDER.map((stop, i) => (
                <div
                  key={stop}
                  aria-hidden="true"
                  className="bf-effort-stop-dot"
                  style={{
                    left: stopLeft(i),
                    background: i <= index ? "#FFFFFF" : DOT_OFF,
                  }}
                />
              ))}
              <div
                aria-hidden="true"
                className="bf-effort-thumb"
                style={{ left: stopLeft(index) }}
              />
            </div>
          </div>

          <div className="bf-effort-footer">
            <span className="bf-effort-title">Effort</span>
            <span className="bf-effort-level">{EFFORT_LABELS[value]}</span>
          </div>
          <div className="bf-effort-ticks" aria-hidden="true">
            {ORDER.map((stop) => (
              <span key={stop}>{EFFORT_LABELS[stop]}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
