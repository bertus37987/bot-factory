import { useEffect, useRef, useState, type CSSProperties, type JSX } from "react";

export interface ResizeSplitterProps {
  /**
   * "vertical" = tall vertical bar resizing horizontal left/right width;
   * "horizontal" = wide horizontal bar resizing top/bottom height.
   */
  orientation: "vertical" | "horizontal";
  edge?: "left" | "right" | "top" | "bottom";
  onDelta: (deltaPx: number) => void;
  onResizeEnd?: () => void;
  ariaLabel?: string;
  className?: string;
}

/**
 * Zero-gap resize splitter with an invisible 8px pointer-capture hit strip
 * centered over the hairline border so dragging works smoothly even over
 * iframes and WebGL canvases.
 */
export function ResizeSplitter({
  orientation,
  edge,
  onDelta,
  onResizeEnd,
  ariaLabel,
  className,
}: ResizeSplitterProps): JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);

  const dragStateRef = useRef<{
    active: boolean;
    pointerId: number;
    lastPos: number;
  }>({ active: false, pointerId: -1, lastPos: 0 });
  const prevBodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);
  const onDeltaRef = useRef(onDelta);
  const onResizeEndRef = useRef(onResizeEnd);
  onDeltaRef.current = onDelta;
  onResizeEndRef.current = onResizeEnd;

  const isVertical = orientation === "vertical";

  const restoreBodyStyles = () => {
    if (!prevBodyStyleRef.current) return;
    document.body.style.cursor = prevBodyStyleRef.current.cursor;
    document.body.style.userSelect = prevBodyStyleRef.current.userSelect;
    prevBodyStyleRef.current = null;
  };

  useEffect(() => {
    return () => {
      if (!prevBodyStyleRef.current) return;
      document.body.style.cursor = prevBodyStyleRef.current.cursor;
      document.body.style.userSelect = prevBodyStyleRef.current.userSelect;
      prevBodyStyleRef.current = null;
    };
  }, []);

  const finishDrag = (target?: HTMLElement, pointerId?: number) => {
    if (!dragStateRef.current.active) return;
    dragStateRef.current.active = false;
    setDragging(false);
    restoreBodyStyles();
    if (target && pointerId !== undefined) {
      try {
        if (target.hasPointerCapture(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
      } catch {
        // Ignore release errors when element detached.
      }
    }
    onResizeEndRef.current?.();
  };

  const rootStyle: CSSProperties = isVertical
    ? {
        width: 0,
        height: "auto",
        alignSelf: "stretch",
        position: "relative",
        flexShrink: 0,
        zIndex: 25,
      }
    : {
        height: 0,
        width: "100%",
        position: "relative",
        flexShrink: 0,
        zIndex: 25,
      };

  const stripOffset = edge === "right" ? -5 : edge === "bottom" ? -5 : -4;
  const hitStripStyle: CSSProperties = isVertical
    ? {
        position: "absolute",
        top: 0,
        bottom: 0,
        left: stripOffset,
        width: 8,
        cursor: "col-resize",
        touchAction: "none",
        userSelect: "none",
        display: "flex",
        alignItems: "stretch",
        justifyContent: "center",
        outline: "none",
      }
    : {
        position: "absolute",
        left: 0,
        right: 0,
        top: stripOffset,
        height: 8,
        cursor: "row-resize",
        touchAction: "none",
        userSelect: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "stretch",
        outline: "none",
      };

  const accentVisible = hovered || dragging;
  const accentLineStyle: CSSProperties = isVertical
    ? {
        width: 2,
        height: "100%",
        background: "var(--accent-orange, #d95d22)",
        opacity: dragging ? 0.92 : accentVisible ? 0.65 : 0,
        transition: "opacity 120ms ease",
        pointerEvents: "none",
        borderRadius: 1,
      }
    : {
        height: 2,
        width: "100%",
        background: "var(--accent-orange, #d95d22)",
        opacity: dragging ? 0.92 : accentVisible ? 0.65 : 0,
        transition: "opacity 120ms ease",
        pointerEvents: "none",
        borderRadius: 1,
      };

  return (
    <div
      className={className ? `bf-resize-splitter ${className}` : "bf-resize-splitter"}
      data-orientation={orientation}
      data-edge={edge}
      data-dragging={dragging ? "true" : "false"}
      style={rootStyle}
    >
      <div
        role="separator"
        aria-orientation={orientation}
        aria-valuenow={50}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={ariaLabel ?? (isVertical ? "Resize panel width" : "Resize panel height")}
        tabIndex={0}
        style={hitStripStyle}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          const pos = isVertical ? e.clientX : e.clientY;
          dragStateRef.current = { active: true, pointerId: e.pointerId, lastPos: pos };
          prevBodyStyleRef.current = {
            cursor: document.body.style.cursor,
            userSelect: document.body.style.userSelect,
          };
          document.body.style.cursor = isVertical ? "col-resize" : "row-resize";
          document.body.style.userSelect = "none";
          setDragging(true);
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Fallback gracefully in environments without pointer capture.
          }
        }}
        onPointerMove={(e) => {
          if (!dragStateRef.current.active) return;
          const pos = isVertical ? e.clientX : e.clientY;
          const delta = pos - dragStateRef.current.lastPos;
          if (delta !== 0) {
            dragStateRef.current.lastPos = pos;
            onDeltaRef.current(delta);
          }
        }}
        onPointerUp={(e) => finishDrag(e.currentTarget, e.pointerId)}
        onPointerCancel={(e) => finishDrag(e.currentTarget, e.pointerId)}
        onLostPointerCapture={(e) => finishDrag(e.currentTarget, e.pointerId)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 32 : 16;
          if (isVertical && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            e.preventDefault();
            onDeltaRef.current(e.key === "ArrowLeft" ? -step : step);
            onResizeEndRef.current?.();
          } else if (!isVertical && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            onDeltaRef.current(e.key === "ArrowUp" ? -step : step);
            onResizeEndRef.current?.();
          }
        }}
      >
        <span style={accentLineStyle} />
      </div>
    </div>
  );
}
