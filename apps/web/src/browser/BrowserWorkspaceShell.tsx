import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ResizeSplitter } from "../components/ResizeSplitter";
import type { BrowserDockMode } from "./types";

const LS_RIGHT_W = "bf_browser_right_w";
const LS_BOTTOM_H = "bf_browser_bottom_h";
const LS_FLOAT_RECT = "bf_browser_float_rect";

const DEFAULT_RIGHT_W = 520;
const DEFAULT_BOTTOM_H = 320;
const FLOAT_MIN_W = 360;
const FLOAT_MIN_H = 280;
const VIEWPORT_PAD = 8;
const VIEWPORT_PAD_LEFT = 52;

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BrowserShellContextValue {
  dockMode: BrowserDockMode;
  onStartFloatDrag: (e: ReactPointerEvent<HTMLElement>) => void;
}

export const BrowserShellContext = createContext<BrowserShellContextValue | null>(null);

export function useBrowserShellContext(): BrowserShellContextValue | null {
  return useContext(BrowserShellContext);
}

export interface BrowserWorkspaceShellProps {
  dockMode: BrowserDockMode;
  className?: string;
  children:
    | ReactNode
    | ((helpers: { onStartFloatDrag: (e: ReactPointerEvent<HTMLElement>) => void }) => ReactNode);
}

type ResizeHandleDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

function viewportSize(): { vw: number; vh: number } {
  if (typeof window === "undefined") return { vw: 1440, vh: 900 };
  return {
    vw: Math.max(320, window.innerWidth || 1440),
    vh: Math.max(240, window.innerHeight || 900),
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), Math.max(min, max));
}

function clampRightWidth(w: number): number {
  const { vw } = viewportSize();
  const maxW = Math.max(300, Math.round(vw * 0.78));
  return clamp(Math.round(w), 300, maxW);
}

function clampBottomHeight(h: number): number {
  const { vh } = viewportSize();
  const maxH = Math.max(200, Math.round(vh * 0.72));
  return clamp(Math.round(h), 200, maxH);
}

function defaultFloatRect(): FloatRect {
  const { vw, vh } = viewportSize();
  const maxW = Math.max(FLOAT_MIN_W, vw - VIEWPORT_PAD_LEFT - VIEWPORT_PAD);
  const maxH = Math.max(FLOAT_MIN_H, vh - VIEWPORT_PAD * 2);
  const w = clamp(Math.round(vw * 0.52), Math.min(FLOAT_MIN_W, maxW), Math.min(760, maxW));
  const h = clamp(Math.round(vh * 0.72), Math.min(FLOAT_MIN_H, maxH), Math.min(640, maxH));
  const x = clamp(vw - w - 28, VIEWPORT_PAD_LEFT, Math.max(VIEWPORT_PAD_LEFT, vw - w - VIEWPORT_PAD));
  const y = clamp(Math.round((vh - h) / 2), VIEWPORT_PAD, Math.max(VIEWPORT_PAD, vh - h - VIEWPORT_PAD));
  return { x, y, w, h };
}

function clampFloatRect(rect: FloatRect): FloatRect {
  const { vw, vh } = viewportSize();
  const availW = Math.max(240, vw - VIEWPORT_PAD_LEFT - VIEWPORT_PAD);
  const availH = Math.max(200, vh - VIEWPORT_PAD * 2);
  const minW = Math.min(FLOAT_MIN_W, availW);
  const minH = Math.min(FLOAT_MIN_H, availH);
  const w = clamp(Math.round(rect.w), minW, availW);
  const h = clamp(Math.round(rect.h), minH, availH);
  const x = clamp(Math.round(rect.x), VIEWPORT_PAD_LEFT, Math.max(VIEWPORT_PAD_LEFT, vw - w - VIEWPORT_PAD));
  const y = clamp(Math.round(rect.y), VIEWPORT_PAD, Math.max(VIEWPORT_PAD, vh - h - VIEWPORT_PAD));
  return { x, y, w, h };
}

function readStoredNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredNumber(key: string, val: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(Math.round(val)));
  } catch {
    // Ignore storage quota errors.
  }
}

function readStoredFloatRect(): FloatRect {
  const fallback = defaultFloatRect();
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(LS_FLOAT_RECT);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<FloatRect>;
    if (
      typeof parsed.x === "number" &&
      typeof parsed.y === "number" &&
      typeof parsed.w === "number" &&
      typeof parsed.h === "number"
    ) {
      return clampFloatRect(parsed as FloatRect);
    }
  } catch {
    // Ignore malformed stored rect.
  }
  return fallback;
}

function writeStoredFloatRect(rect: FloatRect): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_FLOAT_RECT, JSON.stringify(rect));
  } catch {
    // Ignore storage quota errors.
  }
}

const FLOAT_HANDLES: Array<{ dir: ResizeHandleDir; cursor: string; style: CSSProperties }> = [
  { dir: "n", cursor: "ns-resize", style: { top: -3, left: 10, right: 10, height: 7 } },
  { dir: "s", cursor: "ns-resize", style: { bottom: -3, left: 10, right: 10, height: 7 } },
  { dir: "e", cursor: "ew-resize", style: { right: -3, top: 10, bottom: 10, width: 7 } },
  { dir: "w", cursor: "ew-resize", style: { left: -3, top: 10, bottom: 10, width: 7 } },
  { dir: "nw", cursor: "nwse-resize", style: { top: -4, left: -4, width: 12, height: 12, zIndex: 3 } },
  { dir: "ne", cursor: "nesw-resize", style: { top: -4, right: -4, width: 12, height: 12, zIndex: 3 } },
  { dir: "sw", cursor: "nesw-resize", style: { bottom: -4, left: -4, width: 12, height: 12, zIndex: 3 } },
  { dir: "se", cursor: "nwse-resize", style: { bottom: -4, right: -4, width: 12, height: 12, zIndex: 3 } },
];

export function BrowserWorkspaceShell({
  dockMode,
  className,
  children,
}: BrowserWorkspaceShellProps): JSX.Element {
  const [rightWidth, setRightWidth] = useState<number>(() =>
    clampRightWidth(readStoredNumber(LS_RIGHT_W, DEFAULT_RIGHT_W)),
  );
  const [bottomHeight, setBottomHeight] = useState<number>(() =>
    clampBottomHeight(readStoredNumber(LS_BOTTOM_H, DEFAULT_BOTTOM_H)),
  );
  const [floatRect, setFloatRect] = useState<FloatRect>(() => readStoredFloatRect());
  const [floatInteracting, setFloatInteracting] = useState(false);

  const rightWidthRef = useRef(rightWidth);
  rightWidthRef.current = rightWidth;
  const bottomHeightRef = useRef(bottomHeight);
  bottomHeightRef.current = bottomHeight;
  const floatRectRef = useRef(floatRect);
  floatRectRef.current = floatRect;

  const activeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const onResize = () => {
      setRightWidth((w) => clampRightWidth(w));
      setBottomHeight((h) => clampBottomHeight(h));
      setFloatRect((r) => clampFloatRect(r));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      activeCleanupRef.current?.();
      activeCleanupRef.current = null;
    };
  }, []);

  const onStartFloatDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (dockMode !== "float" || e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('button, input, textarea, select, a, [role="tab"], [data-no-drag="true"]')) {
        return;
      }
      e.preventDefault();
      activeCleanupRef.current?.();

      const startX = e.clientX;
      const startY = e.clientY;
      const startRect = floatRectRef.current;
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      setFloatInteracting(true);

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const { vw, vh } = viewportSize();
        const nextX = clamp(
          startRect.x + dx,
          VIEWPORT_PAD_LEFT,
          Math.max(VIEWPORT_PAD_LEFT, vw - startRect.w - VIEWPORT_PAD),
        );
        const nextY = clamp(startRect.y + dy, VIEWPORT_PAD, Math.max(VIEWPORT_PAD, vh - startRect.h - VIEWPORT_PAD));
        setFloatRect({ ...startRect, x: nextX, y: nextY });
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        setFloatInteracting(false);
        activeCleanupRef.current = null;
      };

      const onUp = () => {
        cleanup();
        writeStoredFloatRect(floatRectRef.current);
      };

      activeCleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [dockMode],
  );

  const startFloatHandleResize = (dir: ResizeHandleDir, e: ReactPointerEvent<HTMLDivElement>) => {
    if (dockMode !== "float" || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    activeCleanupRef.current?.();

    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = floatRectRef.current;
    const handleMeta = FLOAT_HANDLES.find((h) => h.dir === dir);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = handleMeta?.cursor ?? "nwse-resize";
    document.body.style.userSelect = "none";
    setFloatInteracting(true);

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore if capture is unsupported.
    }

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const { vw, vh } = viewportSize();
      const minW = Math.min(FLOAT_MIN_W, Math.max(240, vw - VIEWPORT_PAD_LEFT - VIEWPORT_PAD));
      const minH = Math.min(FLOAT_MIN_H, Math.max(200, vh - VIEWPORT_PAD * 2));

      let { x, y, w, h } = startRect;
      if (dir.includes("e")) {
        w = clamp(startRect.w + dx, minW, Math.max(minW, vw - startRect.x - VIEWPORT_PAD));
      }
      if (dir.includes("s")) {
        h = clamp(startRect.h + dy, minH, Math.max(minH, vh - startRect.y - VIEWPORT_PAD));
      }
      if (dir.includes("w")) {
        const rightEdge = startRect.x + startRect.w;
        const nextX = clamp(startRect.x + dx, VIEWPORT_PAD_LEFT, rightEdge - minW);
        x = nextX;
        w = rightEdge - nextX;
      }
      if (dir.includes("n")) {
        const bottomEdge = startRect.y + startRect.h;
        const nextY = clamp(startRect.y + dy, VIEWPORT_PAD, bottomEdge - minH);
        y = nextY;
        h = bottomEdge - nextY;
      }
      setFloatRect({ x, y, w, h });
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      setFloatInteracting(false);
      activeCleanupRef.current = null;
    };

    const onUp = () => {
      cleanup();
      writeStoredFloatRect(floatRectRef.current);
    };

    activeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const ctxValue = useMemo<BrowserShellContextValue>(
    () => ({ dockMode, onStartFloatDrag }),
    [dockMode, onStartFloatDrag],
  );

  const renderedChildren = typeof children === "function" ? children({ onStartFloatDrag }) : children;

  const contentInner = (
    <BrowserShellContext.Provider value={ctxValue}>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          pointerEvents: floatInteracting ? "none" : "auto",
        }}
      >
        {renderedChildren}
      </div>
    </BrowserShellContext.Provider>
  );

  if (dockMode === "fullscreen") {
    return (
      <section
        data-testid="browser-workspace-shell"
        data-dock-mode="fullscreen"
        className={`browser-workspace-shell browser-sidebar-pane expanded ${className ?? ""}`.trim()}
        style={{
          flex: 1,
          width: "100%",
          height: "100%",
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-canvas)",
          position: "relative",
        }}
      >
        {contentInner}
      </section>
    );
  }

  if (dockMode === "bottom") {
    return (
      <aside
        data-testid="browser-workspace-shell"
        data-dock-mode="bottom"
        className={`browser-workspace-shell browser-bottom-pane ${className ?? ""}`.trim()}
        style={{
          height: bottomHeight,
          width: "100%",
          flexShrink: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-canvas)",
          borderTop: "1px solid var(--border-hairline)",
          position: "relative",
        }}
      >
        <ResizeSplitter
          orientation="horizontal"
          edge="top"
          ariaLabel="Resize bottom browser panel height"
          onDelta={(deltaPx) => {
            setBottomHeight((prev) => clampBottomHeight(prev - deltaPx));
          }}
          onResizeEnd={() => writeStoredNumber(LS_BOTTOM_H, bottomHeightRef.current)}
        />
        {contentInner}
      </aside>
    );
  }

  if (dockMode === "float") {
    return (
      <section
        data-testid="browser-workspace-shell"
        data-dock-mode="float"
        aria-label="Floating browser window"
        className={`browser-workspace-shell browser-float-pane ${className ?? ""}`.trim()}
        style={{
          position: "fixed",
          left: floatRect.x,
          top: floatRect.y,
          width: floatRect.w,
          height: floatRect.h,
          zIndex: 45,
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-elevated, var(--bg-canvas))",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-lg, 10px)",
          boxShadow: "var(--shadow-modal, 0 18px 48px rgba(0, 0, 0, 0.28))",
          overflow: "visible",
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            borderRadius: "inherit",
          }}
        >
          {contentInner}
        </div>
        {FLOAT_HANDLES.map((h) => (
          <div
            key={h.dir}
            data-resize-handle={h.dir}
            aria-hidden="true"
            onPointerDown={(e) => startFloatHandleResize(h.dir, e)}
            style={{
              position: "absolute",
              zIndex: 2,
              cursor: h.cursor,
              touchAction: "none",
              userSelect: "none",
              ...h.style,
            }}
          />
        ))}
      </section>
    );
  }

  // Default: "right" docked split aside
  return (
    <aside
      data-testid="browser-workspace-shell"
      data-dock-mode="right"
      className={`browser-workspace-shell browser-sidebar-pane ${className ?? ""}`.trim()}
      style={{
        width: rightWidth,
        height: "100%",
        flexShrink: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "row",
        background: "var(--bg-canvas)",
        borderLeft: "1px solid var(--border-hairline)",
        position: "relative",
      }}
    >
      <ResizeSplitter
        orientation="vertical"
        edge="left"
        ariaLabel="Resize right browser panel width"
        onDelta={(deltaPx) => {
          setRightWidth((prev) => clampRightWidth(prev - deltaPx));
        }}
        onResizeEnd={() => writeStoredNumber(LS_RIGHT_W, rightWidthRef.current)}
      />
      {contentInner}
    </aside>
  );
}
