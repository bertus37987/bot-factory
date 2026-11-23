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
 * Bot-Factory Harness — Reasoning Effort ("Aufwand") Control
 * Calm pill trigger + floating Light-Mode popover with a thick 4-stop
 * burnt-orange track. Pointer drag (setPointerCapture), click-to-set and
 * full keyboard support (role="slider").
 * ------------------------------------------------------------------------ */

export type ReasoningEffort = "low" | "medium" | "high" | "max";

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "Niedrig",
  medium: "Mittel",
  high: "Hoch",
  max: "Max",
};

const ORDER: ReasoningEffort[] = ["low", "medium", "high", "max"];

const TRACK_BG = "#E7E7EA";
const TRACK_FILL = "#D95D22";
const DOT_OFF = "#A1A1AA";

const EFFORT_CSS = `
.bf-effort-trigger {
  transition:
    background 150ms cubic-bezier(0.22, 1, 0.36, 1),
    border-color 150ms cubic-bezier(0.22, 1, 0.36, 1);
}
.bf-effort-trigger:hover:not(:disabled) {
  background: var(--bg-hover, #F2F2F3);
  border-color: var(--border-strong, #D9D9DC);
}
.bf-effort-slider:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring, 0 0 0 2px #FFFFFF, 0 0 0 3.5px #171717);
  border-radius: 8px;
}
.bf-effort-popover {
  animation: bf-effort-pop 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes bf-effort-pop {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .bf-effort-popover { animation: none; }
}
`;

/** Mini 4-stop burnt-orange progress readout inside the trigger pill. */
function MiniEffortBar({ index }: { index: number }): JSX.Element {
  const xs = [2.5, 12.5, 22.5, 32.5];
  return (
    <svg width="35" height="10" viewBox="0 0 35 10" aria-hidden="true" style={{ display: "block" }}>
      <rect x="1" y="4" width="33" height="3" rx="1.5" fill={TRACK_BG} />
      {index > 0 && (
        <rect x="1" y="4" width={xs[index] - 1} height="3" rx="1.5" fill={TRACK_FILL} />
      )}
      {xs.map((x, i) => (
        <circle key={i} cx={x} cy="5.5" r="1.15" fill={i <= index ? "#FFFFFF" : DOT_OFF} />
      ))}
      <circle
        cx={xs[index]}
        cy="5.5"
        r="3"
        fill="#FFFFFF"
        stroke="rgba(23,23,23,0.16)"
        strokeWidth="1"
      />
    </svg>
  );
}

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
      onChange(ORDER[clamped]);
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

  // Close on Escape + outside pointerdown.
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
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <style>{EFFORT_CSS}</style>

      <button
        type="button"
        className="bf-effort-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Denk-Aufwand: ${EFFORT_LABELS[value]}`}
        title={`Denk-Aufwand: ${EFFORT_LABELS[value]}`}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 11px",
          borderRadius: 9999,
          border: "1px solid var(--border-hairline, #EBEBEB)",
          background: "var(--bg-canvas, #FFFFFF)",
          color: "var(--ink-primary, #171717)",
          fontSize: "var(--text-xs, 12px)",
          fontWeight: "var(--weight-medium, 500)",
          lineHeight: 1.3,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.45 : 1,
          whiteSpace: "nowrap",
        }}
      >
        <MiniEffortBar index={index} />
        {EFFORT_LABELS[value]}
      </button>

      {open && (
        <div
          className="bf-effort-popover"
          role="dialog"
          aria-label="Denk-Aufwand wählen"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            right: 0,
            width: 248,
            borderRadius: 12,
            border: "1px solid var(--border-strong, #D9D9DC)",
            background: "var(--bg-canvas, #FFFFFF)",
            boxShadow:
              "var(--shadow-popover, 0 1px 2px rgba(23,23,23,0.04), 0 6px 18px -4px rgba(23,23,23,0.07))",
            padding: "16px 16px 12px",
            zIndex: "var(--z-popover, 30)" as unknown as number,
          }}
        >
          {/* Slider hit-area: stops mapped 1:1 onto the inner track rect */}
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
            style={{
              position: "relative",
              height: 28,
              cursor: disabled ? "not-allowed" : "pointer",
              touchAction: "none",
              userSelect: "none",
              opacity: disabled ? 0.45 : 1,
            }}
          >
            {/* Visual full pill track extends 6px beyond outer stops so end dots sit cleanly inside */}
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 4,
                right: 4,
                top: "50%",
                transform: "translateY(-50%)",
                height: 11,
                borderRadius: 9999,
                background: TRACK_BG,
                overflow: "hidden",
              }}
            >
              {/* Filled burnt-orange track up to active stop */}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `calc(6px + (100% - 12px) * ${index / (ORDER.length - 1)})`,
                  borderRadius: 9999,
                  background: TRACK_FILL,
                  boxShadow: "0 0 10px rgba(217, 93, 34, 0.28)",
                }}
              />
            </div>
            {/* Inner coordinate track: stops 0..3 align 1:1 with dot and thumb centers */}
            <div
              ref={trackRef}
              style={{
                position: "absolute",
                left: 10,
                right: 10,
                top: "50%",
                transform: "translateY(-50%)",
                height: 11,
              }}
            >
              {/* Stop dots */}
              {ORDER.map((stop, i) => (
                <div
                  key={stop}
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    left: stopLeft(i),
                    top: "50%",
                    width: 4,
                    height: 4,
                    borderRadius: "50%",
                    transform: "translate(-50%, -50%)",
                    background: i <= index ? "#FFFFFF" : DOT_OFF,
                    pointerEvents: "none",
                  }}
                />
              ))}
              {/* Thumb */}
              <div
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: stopLeft(index),
                  top: "50%",
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  transform: "translate(-50%, -50%)",
                  background: "#FFFFFF",
                  border: "1.5px solid rgba(23,23,23,0.14)",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
                  pointerEvents: "none",
                }}
              />
            </div>
          </div>

          {/* Label row */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 8,
            }}
          >
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "#171717",
                letterSpacing: "-0.003em",
              }}
            >
              Aufwand
            </span>
            <span
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: "#C24E1A",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {EFFORT_LABELS[value]}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
