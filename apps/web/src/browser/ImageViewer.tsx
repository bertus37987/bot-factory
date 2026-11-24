import {
  ArrowUpRight,
  Check,
  Crop,
  FileWarning,
  MessageSquare,
  PenTool,
  Save,
  Square,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { AnnotationAnchor, AnnotationRecord } from "@bot-factory/shared";
import type { ComposerAttachment, ImageZoomMode } from "./types";

export interface ImageViewerProps {
  projectId: string;
  filePath: string;
  annotate?: boolean;
  annotations?: AnnotationRecord[];
  zoom: ImageZoomMode;
  focusAnnotationId?: string | null;
  focusNonce?: number;
  artifactVersion?: number;
  onPickAnchor?: (anchor: AnnotationAnchor) => void;
  onImportToChat?: (attachment: ComposerAttachment) => void;
  onArtifactSaved?: (filePath: string) => void;
}

type ImageTool = "comment" | "pen" | "arrow" | "rect" | "crop";

interface DraftRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type MarkupShape =
  | { kind: "pen"; color: string; points: Array<{ x: number; y: number }> }
  | { kind: "arrow"; color: string; start: { x: number; y: number }; end: { x: number; y: number } }
  | { kind: "rect"; color: string; rect: DraftRect };

interface EditorSnapshot {
  customImageDataUrl: string | null;
  shapes: MarkupShape[];
}

interface PendingImageComment {
  pin?: { x: number; y: number };
  rect?: DraftRect;
  anchorX: number;
  anchorY: number;
}

const COLOR_DOTS: Array<{ id: "amber" | "cyan" | "rose" | "white"; label: string; hex: string }> = [
  { id: "amber", label: "Amber", hex: "#F59E0B" },
  { id: "cyan", label: "Cyan", hex: "#06B6D4" },
  { id: "rose", label: "Rose", hex: "#F43F5E" },
  { id: "white", label: "White", hex: "#FFFFFF" },
];

function buildEditedPngPath(filePath: string): string {
  if (/\.svg$/i.test(filePath)) {
    return filePath.replace(/\.svg$/i, "-edited.png");
  }
  return filePath;
}

function getSaveMimeAndPath(filePath: string): { savePath: string; mime: string } {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".svg")) {
    return { savePath: buildEditedPngPath(filePath), mime: "image/png" };
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return { savePath: filePath, mime: "image/jpeg" };
  }
  if (lower.endsWith(".webp")) {
    return { savePath: filePath, mime: "image/webp" };
  }
  return { savePath: filePath, mime: "image/png" };
}

function drawShapeOnCanvas(
  ctx: CanvasRenderingContext2D,
  shape: MarkupShape,
  w: number,
  h: number,
  lineWidth: number,
): void {
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (shape.kind === "pen") {
    if (shape.points.length === 1) {
      const p = shape.points[0]!;
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, lineWidth * 0.6, 0, Math.PI * 2);
      ctx.fill();
    } else if (shape.points.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(shape.points[0]!.x * w, shape.points[0]!.y * h);
      for (let i = 1; i < shape.points.length; i += 1) {
        ctx.lineTo(shape.points[i]!.x * w, shape.points[i]!.y * h);
      }
      ctx.stroke();
    }
  } else if (shape.kind === "rect") {
    ctx.strokeRect(shape.rect.x * w, shape.rect.y * h, shape.rect.w * w, shape.rect.h * h);
  } else if (shape.kind === "arrow") {
    const x1 = shape.start.x * w;
    const y1 = shape.start.y * h;
    const x2 = shape.end.x * w;
    const y2 = shape.end.y * h;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLen = Math.max(10, lineWidth * 4);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

export function ImageViewer({
  projectId,
  filePath,
  annotations = [],
  zoom,
  focusAnnotationId,
  focusNonce = 0,
  artifactVersion = 0,
  onPickAnchor,
  onImportToChat,
  onArtifactSaved,
}: ImageViewerProps): JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageBoxRef = useRef<HTMLDivElement | null>(null);

  const drawStartRef = useRef<{ x: number; y: number } | null>(null);
  const panStartRef = useRef<{ clientX: number; clientY: number; scrollLeft: number; scrollTop: number } | null>(null);
  const draftShapeRef = useRef<MarkupShape | null>(null);
  const draftRectRef = useRef<DraftRect | null>(null);
  const spaceDownRef = useRef(false);

  const [tool, setTool] = useState<ImageTool>("comment");
  const [activeColor, setActiveColor] = useState<string>(COLOR_DOTS[0]!.hex);
  const [customImageDataUrl, setCustomImageDataUrl] = useState<string | null>(null);
  const [shapes, setShapes] = useState<MarkupShape[]>([]);
  const [history, setHistory] = useState<EditorSnapshot[]>([]);

  const [draftRect, setDraftRect] = useState<DraftRect | null>(null);
  const [draftShape, setDraftShape] = useState<MarkupShape | null>(null);
  const [pendingComment, setPendingComment] = useState<PendingImageComment | null>(null);
  const [commentText, setCommentText] = useState("");
  const commentInputRef = useRef<HTMLInputElement | null>(null);

  const [loadError, setLoadError] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({ w: 560, h: 480 });
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const artifactUrl =
    `/api/projects/${encodeURIComponent(projectId)}/artifact?path=${encodeURIComponent(filePath)}` +
    (artifactVersion > 0 ? `&v=${artifactVersion}` : "");
  const activeSrc = customImageDataUrl ?? artifactUrl;
  const isSvg = !customImageDataUrl && filePath.toLowerCase().endsWith(".svg");

  useEffect(() => {
    return () => {
      if (statusTimerRef.current !== null) clearTimeout(statusTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        spaceDownRef.current = true;
      } else if (e.key === "Escape" && pendingComment) {
        setPendingComment(null);
        setCommentText("");
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDownRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [pendingComment]);

  useEffect(() => {
    setStatusMessage(null);
  }, [projectId, filePath]);

  useEffect(() => {
    setCustomImageDataUrl(null);
    setShapes([]);
    setHistory([]);
    setPendingComment(null);
    setCommentText("");
  }, [artifactUrl]);

  useEffect(() => {
    setLoadError(false);
    setDraftRect(null);
    setDraftShape(null);
    draftRectRef.current = null;
    draftShapeRef.current = null;
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
    } else {
      setNaturalSize(null);
    }
  }, [activeSrc]);

  useEffect(() => {
    if (pendingComment) {
      setTimeout(() => commentInputRef.current?.focus(), 0);
    }
  }, [pendingComment]);

  useEffect(() => {
    if (!focusAnnotationId || !viewportRef.current) return;
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(focusAnnotationId)
        : focusAnnotationId.replace(/"/g, '\\"');
    const marker = viewportRef.current.querySelector(`[data-annotation-id="${escaped}"]`);
    if (marker && typeof marker.scrollIntoView === "function") {
      marker.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    }
  }, [focusAnnotationId, focusNonce]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const sync = () => {
      setViewportSize({
        w: Math.max(200, el.clientWidth),
        h: Math.max(200, el.clientHeight),
      });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const showTempStatus = (tone: "success" | "error", text: string) => {
    setStatusMessage({ tone, text });
    if (statusTimerRef.current !== null) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => {
      setStatusMessage(null);
      statusTimerRef.current = null;
    }, 3000);
  };

  const normFromPointer = (clientX: number, clientY: number) => {
    const img = imgRef.current;
    if (!img) return { x: 0, y: 0, widthPx: 0, heightPx: 0 };
    const rect = img.getBoundingClientRect();
    const widthPx = Math.max(1, rect.width);
    const heightPx = Math.max(1, rect.height);
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / widthPx)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / heightPx)),
      widthPx,
      heightPx,
    };
  };

  const loadRenderableImage = useCallback(async (): Promise<HTMLImageElement | null> => {
    const el = imgRef.current;
    if (el?.complete && el.naturalWidth > 0 && el.naturalHeight > 0) {
      return el;
    }
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = activeSrc;
    });
  }, [activeSrc]);

  const exportOffscreenDataUrl = useCallback(
    async (opts?: {
      cropRect?: DraftRect;
      highlightRect?: DraftRect;
      highlightPin?: { x: number; y: number };
      maxEdge?: number;
      mime?: string;
    }): Promise<string | undefined> => {
      const baseImg = await loadRenderableImage();
      if (!baseImg) return undefined;

      const baseW = Math.max(1, baseImg.naturalWidth || 960);
      const baseH = Math.max(1, baseImg.naturalHeight || 560);

      const composite = document.createElement("canvas");
      composite.width = baseW;
      composite.height = baseH;
      const ctx = composite.getContext("2d");
      if (!ctx) return undefined;

      ctx.drawImage(baseImg, 0, 0, baseW, baseH);
      const lineWidth = Math.max(2, Math.round(Math.min(baseW, baseH) * 0.0055));
      for (const shape of shapes) {
        drawShapeOnCanvas(ctx, shape, baseW, baseH, lineWidth);
      }

      if (opts?.highlightRect) {
        ctx.save();
        ctx.strokeStyle = "#D95D22";
        ctx.lineWidth = Math.max(3, lineWidth * 1.2);
        ctx.strokeRect(
          opts.highlightRect.x * baseW,
          opts.highlightRect.y * baseH,
          opts.highlightRect.w * baseW,
          opts.highlightRect.h * baseH,
        );
        ctx.restore();
      }

      if (opts?.highlightPin) {
        const px = opts.highlightPin.x * baseW;
        const py = opts.highlightPin.y * baseH;
        const r = Math.max(8, Math.round(Math.min(baseW, baseH) * 0.018));
        ctx.save();
        ctx.fillStyle = "#D95D22";
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = Math.max(2, Math.round(r * 0.28));
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      let sx = 0;
      let sy = 0;
      let sw = baseW;
      let sh = baseH;
      if (opts?.cropRect) {
        sx = Math.max(0, Math.floor(opts.cropRect.x * baseW));
        sy = Math.max(0, Math.floor(opts.cropRect.y * baseH));
        sw = Math.max(1, Math.min(baseW - sx, Math.ceil(opts.cropRect.w * baseW)));
        sh = Math.max(1, Math.min(baseH - sy, Math.ceil(opts.cropRect.h * baseH)));
      } else if (opts?.highlightRect) {
        const pad = 0.06;
        const rx = Math.max(0, opts.highlightRect.x - pad);
        const ry = Math.max(0, opts.highlightRect.y - pad);
        const rx2 = Math.min(1, opts.highlightRect.x + opts.highlightRect.w + pad);
        const ry2 = Math.min(1, opts.highlightRect.y + opts.highlightRect.h + pad);
        sx = Math.floor(rx * baseW);
        sy = Math.floor(ry * baseH);
        sw = Math.max(1, Math.ceil((rx2 - rx) * baseW));
        sh = Math.max(1, Math.ceil((ry2 - ry) * baseH));
      } else if (opts?.highlightPin) {
        const win = 0.45;
        const rx = Math.max(0, Math.min(1 - win, opts.highlightPin.x - win / 2));
        const ry = Math.max(0, Math.min(1 - win, opts.highlightPin.y - win / 2));
        sx = Math.floor(rx * baseW);
        sy = Math.floor(ry * baseH);
        sw = Math.max(1, Math.min(baseW - sx, Math.ceil(win * baseW)));
        sh = Math.max(1, Math.min(baseH - sy, Math.ceil(win * baseH)));
      }

      let outW = sw;
      let outH = sh;
      if (opts?.maxEdge && Math.max(sw, sh) > opts.maxEdge) {
        const scale = opts.maxEdge / Math.max(sw, sh);
        outW = Math.max(1, Math.round(sw * scale));
        outH = Math.max(1, Math.round(sh * scale));
      }

      const outCanvas = document.createElement("canvas");
      outCanvas.width = outW;
      outCanvas.height = outH;
      const outCtx = outCanvas.getContext("2d");
      if (!outCtx) return undefined;
      outCtx.drawImage(composite, sx, sy, sw, sh, 0, 0, outW, outH);

      try {
        return outCanvas.toDataURL(opts?.mime ?? "image/png", 0.92);
      } catch {
        return undefined;
      }
    },
    [loadRenderableImage, shapes],
  );

  const handleUndo = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1]!;
    setHistory((h) => h.slice(0, -1));
    setCustomImageDataUrl(prev.customImageDataUrl);
    setShapes(prev.shapes);
  };

  const handleSave = async () => {
    if (saving || loadError) return;
    setSaving(true);
    try {
      const { savePath, mime } = getSaveMimeAndPath(filePath);
      const dataUrl = await exportOffscreenDataUrl({ mime });
      if (!dataUrl) {
        throw new Error("Could not render image onto offscreen canvas.");
      }
      const commaIdx = dataUrl.indexOf(",");
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/artifact?path=${encodeURIComponent(savePath)}`,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: base64, encoding: "base64" }),
        },
      );
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) msg = body.error;
        } catch {
          // Use status fallback.
        }
        throw new Error(msg);
      }
      showTempStatus("success", `Saved ${savePath.split("/").pop() ?? savePath}`);
      onArtifactSaved?.(savePath);
    } catch (err) {
      showTempStatus("error", err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleAddSnapshotToChat = async () => {
    const thumbnailDataUrl = await exportOffscreenDataUrl({ maxEdge: 720, mime: "image/png" });
    const label = filePath.split("/").pop() ?? filePath;
    if (onImportToChat) {
      onImportToChat({
        id: `att_img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        kind: "image_comment",
        filePath,
        label,
        comment: shapes.length > 0 || customImageDataUrl ? "Edited image preview" : "Image preview",
        thumbnailDataUrl,
      });
      showTempStatus("success", "Added to chat composer");
    } else if (onPickAnchor) {
      onPickAnchor({ kind: "image", filePath, pin: { x: 0.5, y: 0.5 } });
    }
  };

  const submitCommentPopover = async () => {
    if (!pendingComment) return;
    const trimmed = commentText.trim();
    if (!trimmed) return;
    const thumbnailDataUrl = await exportOffscreenDataUrl({
      highlightRect: pendingComment.rect,
      highlightPin: pendingComment.pin,
      maxEdge: 480,
      mime: "image/png",
    });
    const label = filePath.split("/").pop() ?? filePath;
    if (onImportToChat) {
      onImportToChat({
        id: `att_img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        kind: "image_comment",
        filePath,
        label,
        comment: trimmed,
        thumbnailDataUrl,
        ...(pendingComment.rect ? { region: pendingComment.rect } : {}),
      });
    } else if (onPickAnchor) {
      onPickAnchor(
        pendingComment.rect
          ? { kind: "image", filePath, rect: pendingComment.rect }
          : { kind: "image", filePath, pin: pendingComment.pin ?? { x: 0.5, y: 0.5 } },
      );
    }
    setPendingComment(null);
    setCommentText("");
  };

  const maxFitWidth = Math.max(120, viewportSize.w - 48);
  const maxFitHeight = Math.max(120, viewportSize.h - 112);
  const hasNatural = Boolean(naturalSize && naturalSize.w > 0 && naturalSize.h > 0);
  const naturalAspect = hasNatural && naturalSize ? naturalSize.w / naturalSize.h : null;

  const imgStyle: React.CSSProperties = (() => {
    const baseStyle: React.CSSProperties = {
      display: "block",
      borderRadius: "var(--radius-md)",
      userSelect: "none",
    };

    if (zoom === "fit") {
      if (naturalSize && naturalAspect) {
        if (isSvg) {
          const maxByHeight = maxFitHeight * naturalAspect;
          const fitWidth = Math.max(1, Math.floor(Math.min(maxFitWidth, maxByHeight)));
          const fitHeight = Math.min(maxFitHeight, Math.max(1, Math.round(fitWidth / naturalAspect)));
          return {
            ...baseStyle,
            width: fitWidth,
            height: fitHeight,
            maxWidth: maxFitWidth,
            maxHeight: maxFitHeight,
          };
        }
        const scale = Math.min(1, maxFitWidth / naturalSize.w, maxFitHeight / naturalSize.h);
        return {
          ...baseStyle,
          width: Math.max(1, Math.round(naturalSize.w * scale)),
          height: Math.max(1, Math.round(naturalSize.h * scale)),
          maxWidth: maxFitWidth,
          maxHeight: maxFitHeight,
        };
      }

      if (isSvg) {
        const fallbackWidth = Math.min(720, maxFitWidth);
        const fallbackHeight = Math.min(maxFitHeight, Math.max(120, Math.round(fallbackWidth * (9 / 16))));
        return {
          ...baseStyle,
          width: fallbackWidth,
          height: fallbackHeight,
          maxWidth: maxFitWidth,
          maxHeight: maxFitHeight,
        };
      }

      return {
        ...baseStyle,
        width: "auto",
        height: "auto",
        maxWidth: maxFitWidth,
        maxHeight: maxFitHeight,
      };
    }

    const baseWidth = hasNatural && naturalSize ? naturalSize.w : isSvg ? 720 : 640;
    const zoomScale = zoom === "75%" ? 0.75 : 1;
    const zoomedWidth = Math.max(80, Math.round(baseWidth * zoomScale));
    const zoomedHeight = naturalAspect
      ? Math.max(1, Math.round(zoomedWidth / naturalAspect))
      : isSvg
        ? Math.max(1, Math.round(zoomedWidth * (9 / 16)))
        : "auto";
    return {
      ...baseStyle,
      width: zoomedWidth,
      height: zoomedHeight,
      maxWidth: "none",
      maxHeight: "none",
    };
  })();

  const svgViewW = 1000;
  const svgViewH = naturalAspect ? Math.max(100, Math.round(1000 / naturalAspect)) : 562;

  const renderSvgShape = (s: MarkupShape, idx: number | string) => {
    if (s.kind === "pen") {
      const d = s.points
        .map((p, i) => `${i === 0 ? "M" : "L"} ${(p.x * svgViewW).toFixed(1)} ${(p.y * svgViewH).toFixed(1)}`)
        .join(" ");
      return (
        <path
          key={idx}
          d={d}
          fill="none"
          stroke={s.color}
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    }
    if (s.kind === "rect") {
      return (
        <rect
          key={idx}
          x={s.rect.x * svgViewW}
          y={s.rect.y * svgViewH}
          width={s.rect.w * svgViewW}
          height={s.rect.h * svgViewH}
          fill="none"
          stroke={s.color}
          strokeWidth={4}
          rx={4}
        />
      );
    }
    const x1 = s.start.x * svgViewW;
    const y1 = s.start.y * svgViewH;
    const x2 = s.end.x * svgViewW;
    const y2 = s.end.y * svgViewH;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = 16;
    const p1x = x2 - head * Math.cos(angle - Math.PI / 6);
    const p1y = y2 - head * Math.sin(angle - Math.PI / 6);
    const p2x = x2 - head * Math.cos(angle + Math.PI / 6);
    const p2y = y2 - head * Math.sin(angle + Math.PI / 6);
    return (
      <g key={idx}>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={s.color} strokeWidth={4} strokeLinecap="round" />
        <polygon points={`${x2},${y2} ${p1x},${p1y} ${p2x},${p2y}`} fill={s.color} />
      </g>
    );
  };

  const microBtnStyle = (active: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    height: 26,
    padding: "0 8px",
    borderRadius: "var(--radius-sm)",
    border: active ? "1px solid var(--border-strong)" : "1px solid transparent",
    background: active ? "var(--bg-active)" : "transparent",
    color: active ? "var(--ink-primary)" : "var(--ink-secondary)",
    fontSize: "var(--text-2xs)",
    fontWeight: active ? "var(--weight-semibold)" : "var(--weight-medium)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  });

  return (
    <div
      ref={viewportRef}
      className="iab-image-stage"
      onPointerDown={(e) => {
        if ((e.button === 1 || (e.button === 0 && spaceDownRef.current)) && viewportRef.current) {
          e.preventDefault();
          panStartRef.current = {
            clientX: e.clientX,
            clientY: e.clientY,
            scrollLeft: viewportRef.current.scrollLeft,
            scrollTop: viewportRef.current.scrollTop,
          };
          setIsPanning(true);
          try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          } catch {
            // Ignore.
          }
        }
      }}
      onPointerMove={(e) => {
        const pan = panStartRef.current;
        if (!pan || !viewportRef.current) return;
        viewportRef.current.scrollLeft = pan.scrollLeft - (e.clientX - pan.clientX);
        viewportRef.current.scrollTop = pan.scrollTop - (e.clientY - pan.clientY);
      }}
      onPointerUp={() => {
        panStartRef.current = null;
        setIsPanning(false);
      }}
      onPointerCancel={() => {
        panStartRef.current = null;
        setIsPanning(false);
      }}
      style={{
        height: "100%",
        width: "100%",
        overflow: zoom === "fit" ? "hidden" : "auto",
        backgroundColor: "var(--stage-3d-bg, var(--bg-surface-subtle))",
        backgroundImage: "radial-gradient(var(--border-strong) 1px, transparent 1px)",
        backgroundSize: "16px 16px",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {statusMessage && (
        <div
          role="status"
          className={`pill ${statusMessage.tone === "error" ? "danger" : "success"}`}
          style={{
            position: "absolute",
            top: 10,
            right: 12,
            zIndex: 15,
            boxShadow: "var(--shadow-popover)",
          }}
        >
          {statusMessage.text}
        </div>
      )}

      <div
        style={{
          flex: 1,
          minWidth: "100%",
          minHeight: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px 24px 84px",
        }}
      >
        {loadError ? (
          <div
            style={{
              color: "var(--ink-muted)",
              fontSize: "var(--text-sm)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "var(--bg-elevated, var(--bg-canvas))",
              padding: "10px 14px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-hairline)",
            }}
          >
            <FileWarning size={14} strokeWidth={1.6} />
            <span>Failed to load image artifact.</span>
          </div>
        ) : (
          <div
            ref={stageBoxRef}
            className="img-stage iab-img-stage"
            style={{
              position: "relative",
              display: "inline-block",
              lineHeight: 0,
              flexShrink: 0,
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-hairline)",
              background: "var(--bg-canvas)",
              boxShadow: "0 1px 4px rgba(0, 0, 0, 0.08)",
              cursor: isPanning ? "grabbing" : "crosshair",
              touchAction: "none",
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 || spaceDownRef.current) return;
              const target = e.target as HTMLElement | null;
              if (target?.closest(".iab-image-comment-popover")) return;
              e.stopPropagation();
              const p = normFromPointer(e.clientX, e.clientY);
              drawStartRef.current = { x: p.x, y: p.y };
              try {
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              } catch {
                // Ignore.
              }

              if (tool === "pen") {
                const init: MarkupShape = { kind: "pen", color: activeColor, points: [{ x: p.x, y: p.y }] };
                draftShapeRef.current = init;
                setDraftShape(init);
              } else if (tool === "arrow") {
                const init: MarkupShape = {
                  kind: "arrow",
                  color: activeColor,
                  start: { x: p.x, y: p.y },
                  end: { x: p.x, y: p.y },
                };
                draftShapeRef.current = init;
                setDraftShape(init);
              } else if (tool === "rect") {
                const init: MarkupShape = {
                  kind: "rect",
                  color: activeColor,
                  rect: { x: p.x, y: p.y, w: 0, h: 0 },
                };
                draftShapeRef.current = init;
                setDraftShape(init);
              }
            }}
            onPointerMove={(e) => {
              const start = drawStartRef.current;
              if (!start) return;
              const cur = normFromPointer(e.clientX, e.clientY);

              if (tool === "comment" || tool === "crop") {
                const dx = Math.abs(cur.x - start.x) * cur.widthPx;
                const dy = Math.abs(cur.y - start.y) * cur.heightPx;
                if (dx > 8 || dy > 8) {
                  const next: DraftRect = {
                    x: Math.min(start.x, cur.x),
                    y: Math.min(start.y, cur.y),
                    w: Math.abs(cur.x - start.x),
                    h: Math.abs(cur.y - start.y),
                  };
                  draftRectRef.current = next;
                  setDraftRect(next);
                }
                return;
              }

              const curShape = draftShapeRef.current;
              if (!curShape) return;
              if (curShape.kind === "pen") {
                const last = curShape.points[curShape.points.length - 1]!;
                if (Math.hypot(cur.x - last.x, cur.y - last.y) >= 0.002) {
                  const updated: MarkupShape = { ...curShape, points: [...curShape.points, { x: cur.x, y: cur.y }] };
                  draftShapeRef.current = updated;
                  setDraftShape(updated);
                }
              } else if (curShape.kind === "arrow") {
                const updated: MarkupShape = { ...curShape, end: { x: cur.x, y: cur.y } };
                draftShapeRef.current = updated;
                setDraftShape(updated);
              } else if (curShape.kind === "rect") {
                const updated: MarkupShape = {
                  ...curShape,
                  rect: {
                    x: Math.min(start.x, cur.x),
                    y: Math.min(start.y, cur.y),
                    w: Math.abs(cur.x - start.x),
                    h: Math.abs(cur.y - start.y),
                  },
                };
                draftShapeRef.current = updated;
                setDraftShape(updated);
              }
            }}
            onPointerUp={(e) => {
              const start = drawStartRef.current;
              drawStartRef.current = null;
              const finalRect = draftRectRef.current;
              const finalShape = draftShapeRef.current;
              draftRectRef.current = null;
              draftShapeRef.current = null;
              setDraftRect(null);
              setDraftShape(null);

              if (!start) return;

              if (tool === "comment") {
                setCommentText("");
                if (finalRect && finalRect.w > 0.006 && finalRect.h > 0.006) {
                  setPendingComment({
                    rect: finalRect,
                    anchorX: Math.min(0.85, Math.max(0.15, finalRect.x + finalRect.w / 2)),
                    anchorY: Math.min(0.85, finalRect.y + finalRect.h),
                  });
                } else {
                  const p = normFromPointer(e.clientX, e.clientY);
                  setPendingComment({
                    pin: { x: p.x, y: p.y },
                    anchorX: Math.min(0.85, Math.max(0.15, p.x)),
                    anchorY: Math.min(0.85, p.y),
                  });
                }
                return;
              }

              if (tool === "crop") {
                if (finalRect && finalRect.w > 0.015 && finalRect.h > 0.015) {
                  void exportOffscreenDataUrl({ cropRect: finalRect, mime: "image/png" }).then((cropped) => {
                    if (!cropped) return;
                    setHistory((h) => [...h, { customImageDataUrl, shapes }]);
                    setCustomImageDataUrl(cropped);
                    setShapes([]);
                  });
                }
                return;
              }

              if (!finalShape) return;
              const shouldCommit =
                finalShape.kind === "pen"
                  ? finalShape.points.length >= 1
                  : finalShape.kind === "arrow"
                    ? Math.hypot(finalShape.end.x - finalShape.start.x, finalShape.end.y - finalShape.start.y) > 0.008
                    : finalShape.rect.w > 0.006 && finalShape.rect.h > 0.006;
              if (shouldCommit) {
                setHistory((h) => [...h, { customImageDataUrl, shapes }]);
                setShapes((s) => [...s, finalShape]);
              }
            }}
            onPointerCancel={() => {
              drawStartRef.current = null;
              draftRectRef.current = null;
              draftShapeRef.current = null;
              setDraftRect(null);
              setDraftShape(null);
            }}
          >
            <img
              ref={imgRef}
              src={activeSrc}
              alt={filePath}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
              }}
              onError={() => setLoadError(true)}
              style={imgStyle}
            />

            {/* Vector Markup Overlay (Pen / Arrow / Rect) */}
            {(shapes.length > 0 || draftShape) && (
              <svg
                viewBox={`0 0 ${svgViewW} ${svgViewH}`}
                preserveAspectRatio="none"
                aria-hidden="true"
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  pointerEvents: "none",
                  zIndex: 3,
                }}
              >
                <title>Image markup overlay</title>
                {shapes.map((s, idx) => renderSvgShape(s, idx))}
                {draftShape && renderSvgShape(draftShape, "draft")}
              </svg>
            )}

            {/* Existing saved pin & region overlays rendered strictly in percentage coordinates */}
            {annotations.map((ann, idx) => {
              if (ann.anchor.kind !== "image") return null;
              const isFocused = focusAnnotationId === ann.id;
              const isApproved = ann.status === "approved";
              const markerColor = isApproved ? "#165E3D" : "#D95D22";

              if (ann.anchor.pin) {
                return (
                  <div
                    key={ann.id}
                    data-annotation-id={ann.id}
                    className={`pin-marker iab-pin-marker ${isFocused ? "focused" : ""}`}
                    title={`#${idx + 1}: ${ann.comment}`}
                    style={{
                      position: "absolute",
                      left: `${ann.anchor.pin.x * 100}%`,
                      top: `${ann.anchor.pin.y * 100}%`,
                      transform: isFocused ? "translate(-50%, -50%) scale(1.18)" : "translate(-50%, -50%)",
                      width: 20,
                      height: 20,
                      borderRadius: "50%",
                      background: markerColor,
                      color: "#FFFFFF",
                      fontSize: 10,
                      fontWeight: "var(--weight-semibold)",
                      lineHeight: 1,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: "0 0 0 2px rgba(255,255,255,0.92)",
                      pointerEvents: "none",
                      zIndex: isFocused ? 4 : 2,
                    }}
                  >
                    {idx + 1}
                  </div>
                );
              }

              if (ann.anchor.rect) {
                return (
                  <div
                    key={ann.id}
                    data-annotation-id={ann.id}
                    className={`iab-rect-marker ${isFocused ? "focused" : ""}`}
                    title={`#${idx + 1}: ${ann.comment}`}
                    style={{
                      position: "absolute",
                      left: `${ann.anchor.rect.x * 100}%`,
                      top: `${ann.anchor.rect.y * 100}%`,
                      width: `${ann.anchor.rect.w * 100}%`,
                      height: `${ann.anchor.rect.h * 100}%`,
                      border: `2px solid ${markerColor}`,
                      borderRadius: 4,
                      background: isApproved ? "rgba(22, 94, 61, 0.08)" : "rgba(217, 93, 34, 0.12)",
                      pointerEvents: "none",
                      zIndex: isFocused ? 4 : 2,
                    }}
                  />
                );
              }
              return null;
            })}

            {/* Live drag-rectangle preview for Comment or Crop */}
            {draftRect && (
              <div
                className="iab-rect-draft"
                style={{
                  position: "absolute",
                  left: `${draftRect.x * 100}%`,
                  top: `${draftRect.y * 100}%`,
                  width: `${draftRect.w * 100}%`,
                  height: `${draftRect.h * 100}%`,
                  border: tool === "crop" ? "2px dashed #06B6D4" : "2px dashed var(--accent-orange)",
                  borderRadius: 4,
                  background: tool === "crop" ? "rgba(6, 182, 212, 0.12)" : "rgba(217, 93, 34, 0.14)",
                  pointerEvents: "none",
                  zIndex: 5,
                }}
              />
            )}

            {/* Pending comment location marker */}
            {pendingComment?.pin && (
              <div
                style={{
                  position: "absolute",
                  left: `${pendingComment.pin.x * 100}%`,
                  top: `${pendingComment.pin.y * 100}%`,
                  transform: "translate(-50%, -50%)",
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: "var(--accent-orange)",
                  border: "2px solid #FFFFFF",
                  boxShadow: "0 2px 6px rgba(0,0,0,0.28)",
                  pointerEvents: "none",
                  zIndex: 6,
                }}
              />
            )}
            {pendingComment?.rect && (
              <div
                style={{
                  position: "absolute",
                  left: `${pendingComment.rect.x * 100}%`,
                  top: `${pendingComment.rect.y * 100}%`,
                  width: `${pendingComment.rect.w * 100}%`,
                  height: `${pendingComment.rect.h * 100}%`,
                  border: "2px solid var(--accent-orange)",
                  borderRadius: 4,
                  background: "rgba(217, 93, 34, 0.14)",
                  pointerEvents: "none",
                  zIndex: 6,
                }}
              />
            )}

            {/* Inline Comment -> Chat Popover */}
            {pendingComment && (
              <div
                className="iab-image-comment-popover"
                role="dialog"
                aria-label="Comment on image to chat"
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  position: "absolute",
                  left: `${Math.min(72, Math.max(4, pendingComment.anchorX * 100 - 20))}%`,
                  top: `${Math.min(82, Math.max(8, pendingComment.anchorY * 100 + 2))}%`,
                  width: 268,
                  maxWidth: "calc(100vw - 48px)",
                  background: "var(--bg-elevated, var(--bg-canvas))",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "var(--radius-lg)",
                  boxShadow: "var(--shadow-modal)",
                  padding: 9,
                  zIndex: 20,
                  display: "flex",
                  flexDirection: "column",
                  gap: 7,
                  lineHeight: 1.35,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: "var(--text-2xs)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--ink-primary)",
                  }}
                >
                  <span>Comment → Chat</span>
                  <button
                    type="button"
                    className="btn xs ghost"
                    aria-label="Cancel comment"
                    onClick={() => {
                      setPendingComment(null);
                      setCommentText("");
                    }}
                  >
                    <X size={11} strokeWidth={1.7} />
                  </button>
                </div>
                <input
                  ref={commentInputRef}
                  type="text"
                  placeholder="Describe what to change here..."
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void submitCommentPopover();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setPendingComment(null);
                    }
                  }}
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border-hairline)",
                    background: "var(--bg-surface)",
                    color: "var(--ink-primary)",
                    fontSize: "var(--text-xs)",
                    outline: "none",
                  }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                  <button
                    type="button"
                    className="btn xs primary"
                    disabled={!commentText.trim()}
                    onClick={() => void submitCommentPopover()}
                  >
                    <MessageSquare size={11} strokeWidth={1.6} />
                    <span>Add to Chat</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Floating Bottom Micro-Toolbar */}
      {!loadError && (
        <div
          className="iab-image-toolbar"
          role="toolbar"
          aria-label="Image annotation and edit tools"
          style={{
            position: "absolute",
            bottom: 12,
            left: "50%",
            transform: "translateX(-50%)",
            width: "max-content",
            maxWidth: "calc(100% - 20px)",
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            alignItems: "center",
            gap: 4,
            padding: "4px 6px",
            borderRadius: "var(--radius-lg)",
            background: "var(--bg-elevated, var(--bg-canvas))",
            border: "1px solid var(--border-strong)",
            boxShadow: "var(--shadow-popover)",
            zIndex: 12,
          }}
        >
          <button
            type="button"
            aria-pressed={tool === "comment"}
            onClick={() => setTool("comment")}
            style={microBtnStyle(tool === "comment")}
            title="Click or drag to comment in chat"
          >
            <MessageSquare size={12} strokeWidth={1.7} />
            <span>Comment</span>
          </button>
          <button
            type="button"
            aria-pressed={tool === "pen"}
            onClick={() => setTool("pen")}
            style={microBtnStyle(tool === "pen")}
            title="Freehand pen"
          >
            <PenTool size={12} strokeWidth={1.7} />
            <span>Pen</span>
          </button>
          <button
            type="button"
            aria-pressed={tool === "arrow"}
            onClick={() => setTool("arrow")}
            style={microBtnStyle(tool === "arrow")}
            title="Arrow"
          >
            <ArrowUpRight size={12} strokeWidth={1.7} />
            <span>Arrow</span>
          </button>
          <button
            type="button"
            aria-pressed={tool === "rect"}
            onClick={() => setTool("rect")}
            style={microBtnStyle(tool === "rect")}
            title="Rectangle"
          >
            <Square size={12} strokeWidth={1.7} />
            <span>Rect</span>
          </button>
          <button
            type="button"
            aria-pressed={tool === "crop"}
            onClick={() => setTool("crop")}
            style={microBtnStyle(tool === "crop")}
            title="Drag to crop image"
          >
            <Crop size={12} strokeWidth={1.7} />
            <span>Crop</span>
          </button>

          <span style={{ width: 1, height: 16, background: "var(--border-hairline)", margin: "0 2px", flexShrink: 0 }} />

          <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "0 2px", flexShrink: 0 }}>
            {COLOR_DOTS.map((c) => {
              const selected = activeColor === c.hex;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-label={`Color ${c.label}`}
                  aria-pressed={selected}
                  title={c.label}
                  onClick={() => setActiveColor(c.hex)}
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    background: c.hex,
                    border: selected ? "2px solid var(--accent-orange)" : "1.5px solid var(--border-strong)",
                    boxShadow: selected ? "0 0 0 1px var(--bg-canvas)" : "none",
                    cursor: "pointer",
                    padding: 0,
                  }}
                />
              );
            })}
          </div>

          <span style={{ width: 1, height: 16, background: "var(--border-hairline)", margin: "0 2px", flexShrink: 0 }} />

          <button
            type="button"
            disabled={history.length === 0}
            onClick={handleUndo}
            style={{
              ...microBtnStyle(false),
              opacity: history.length === 0 ? 0.4 : 1,
              cursor: history.length === 0 ? "not-allowed" : "pointer",
            }}
            title="Undo last edit"
          >
            <Undo2 size={12} strokeWidth={1.7} />
            <span>Undo</span>
          </button>

          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave()}
            style={microBtnStyle(false)}
            title={isSvg ? "Save rasterized PNG copy" : "Save edits to artifact"}
          >
            {saving ? <Check size={12} strokeWidth={1.7} /> : <Save size={12} strokeWidth={1.7} />}
            <span>{saving ? "Saving..." : "Save"}</span>
          </button>

          <button
            type="button"
            onClick={() => void handleAddSnapshotToChat()}
            style={{
              ...microBtnStyle(false),
              background: "var(--accent-orange)",
              borderColor: "var(--accent-orange)",
              color: "#FFFFFF",
              fontWeight: "var(--weight-semibold)",
            }}
            title="Attach current image preview to chat composer"
          >
            <MessageSquare size={12} strokeWidth={1.7} />
            <span>Add to Chat</span>
          </button>
        </div>
      )}
    </div>
  );
}
