import { FileWarning } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import type { AnnotationAnchor, AnnotationRecord } from "@bot-factory/shared";
import type { ImageZoomMode } from "./types";

export interface ImageViewerProps {
  projectId: string;
  filePath: string;
  annotate: boolean;
  annotations: AnnotationRecord[];
  zoom: ImageZoomMode;
  focusAnnotationId?: string | null;
  focusNonce?: number;
  artifactVersion?: number;
  onPickAnchor: (anchor: AnnotationAnchor) => void;
}

interface DraftRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function ImageViewer({
  projectId,
  filePath,
  annotate,
  annotations,
  zoom,
  focusAnnotationId,
  focusNonce = 0,
  artifactVersion = 0,
  onPickAnchor,
}: ImageViewerProps): JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const drawStartRef = useRef<{ x: number; y: number } | null>(null);
  const panStartRef = useRef<{ clientX: number; clientY: number; scrollLeft: number; scrollTop: number } | null>(null);

  const [draftRect, setDraftRect] = useState<DraftRect | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({ w: 560, h: 480 });

  const artifactUrl =
    `/api/projects/${encodeURIComponent(projectId)}/artifact?path=${encodeURIComponent(filePath)}` +
    (artifactVersion > 0 ? `&v=${artifactVersion}` : "");
  const isSvg = filePath.toLowerCase().endsWith(".svg");

  useEffect(() => {
    setLoadError(false);
    setNaturalSize(null);
    setDraftRect(null);
  }, [artifactUrl]);

  useEffect(() => {
    if (!focusAnnotationId || !viewportRef.current) return;
    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
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

  const baseWidth = naturalSize && naturalSize.w > 0 ? naturalSize.w : isSvg ? 720 : 640;
  const imgStyle: React.CSSProperties =
    zoom === "fit"
      ? {
          display: "block",
          width: isSvg && (!naturalSize || naturalSize.w === 0) ? Math.min(720, Math.max(180, viewportSize.w - 48)) : "auto",
          height: "auto",
          maxWidth: Math.max(120, viewportSize.w - 48),
          maxHeight: Math.max(120, viewportSize.h - 48),
          borderRadius: "var(--radius-md)",
          userSelect: "none",
        }
      : {
          display: "block",
          width: Math.max(80, Math.round(baseWidth * (zoom === "75%" ? 0.75 : 1))),
          height: "auto",
          maxWidth: "none",
          maxHeight: "none",
          borderRadius: "var(--radius-md)",
          userSelect: "none",
        };

  return (
    <div
      ref={viewportRef}
      className="iab-image-stage"
      onPointerDown={(e) => {
        if (annotate || e.button !== 0 || !viewportRef.current) return;
        panStartRef.current = {
          clientX: e.clientX,
          clientY: e.clientY,
          scrollLeft: viewportRef.current.scrollLeft,
          scrollTop: viewportRef.current.scrollTop,
        };
        setIsPanning(true);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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
        backgroundColor: "#F5F5F5",
        backgroundImage: "radial-gradient(#D5D5DA 1px, transparent 1px)",
        backgroundSize: "16px 16px",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        cursor: annotate ? "default" : isPanning ? "grabbing" : "grab",
      }}
    >
      {annotate && (
        <div
          className="iab-stage-hint"
          style={{
            position: "sticky",
            top: 10,
            zIndex: 5,
            alignSelf: "center",
            marginTop: 10,
            padding: "4px 12px",
            borderRadius: "var(--radius-pill)",
            background: "#FFF7F2",
            border: "1px solid #F7D5C2",
            color: "#B84312",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-medium)",
            pointerEvents: "none",
          }}
        >
          Click to drop a pin or drag to select a region
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
          padding: 24,
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
              background: "#FFFFFF",
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
            className="img-stage iab-img-stage"
            style={{
              position: "relative",
              display: "inline-block",
              lineHeight: 0,
              flexShrink: 0,
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-hairline)",
              background: "#FFFFFF",
              boxShadow: "0 1px 3px rgba(23, 23, 23, 0.05)",
              cursor: annotate ? "crosshair" : isPanning ? "grabbing" : "grab",
              touchAction: annotate ? "none" : "auto",
            }}
            onPointerDown={(e) => {
              if (!annotate || e.button !== 0) return;
              e.stopPropagation();
              const p = normFromPointer(e.clientX, e.clientY);
              drawStartRef.current = { x: p.x, y: p.y };
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const start = drawStartRef.current;
              if (!start || !annotate) return;
              const cur = normFromPointer(e.clientX, e.clientY);
              const dx = Math.abs(cur.x - start.x) * cur.widthPx;
              const dy = Math.abs(cur.y - start.y) * cur.heightPx;
              if (dx > 8 || dy > 8) {
                setDraftRect({
                  x: Math.min(start.x, cur.x),
                  y: Math.min(start.y, cur.y),
                  w: Math.abs(cur.x - start.x),
                  h: Math.abs(cur.y - start.y),
                });
              }
            }}
            onPointerUp={(e) => {
              const start = drawStartRef.current;
              drawStartRef.current = null;
              if (!start || !annotate) {
                setDraftRect(null);
                return;
              }
              if (draftRect && draftRect.w > 0.005 && draftRect.h > 0.005) {
                onPickAnchor({ kind: "image", filePath, rect: draftRect });
              } else {
                const p = normFromPointer(e.clientX, e.clientY);
                onPickAnchor({ kind: "image", filePath, pin: { x: p.x, y: p.y } });
              }
              setDraftRect(null);
            }}
            onPointerCancel={() => {
              drawStartRef.current = null;
              setDraftRect(null);
            }}
          >
            <img
              ref={imgRef}
              src={artifactUrl}
              alt={filePath}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
              }}
              onError={() => setLoadError(true)}
              style={imgStyle}
            />

            {/* Saved pin & region overlays rendered strictly in percentage coordinates */}
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
                      boxShadow: isFocused
                        ? "0 0 0 3px #FFFFFF, 0 0 0 5px #D95D22"
                        : "0 0 0 2px rgba(255,255,255,0.92)",
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
                      boxShadow: isFocused ? "0 0 0 2px rgba(255,255,255,0.9)" : "none",
                      pointerEvents: "none",
                      zIndex: isFocused ? 4 : 2,
                    }}
                  >
                    <span
                      style={{
                        position: "absolute",
                        top: -9,
                        left: -9,
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        background: markerColor,
                        color: "#FFFFFF",
                        fontSize: 10,
                        fontWeight: "var(--weight-semibold)",
                        lineHeight: 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        boxShadow: "0 0 0 1.5px #FFFFFF",
                      }}
                    >
                      {idx + 1}
                    </span>
                  </div>
                );
              }

              return null;
            })}

            {/* Live drag-rectangle preview in percentage coordinates */}
            {draftRect && (
              <div
                className="iab-rect-draft"
                style={{
                  position: "absolute",
                  left: `${draftRect.x * 100}%`,
                  top: `${draftRect.y * 100}%`,
                  width: `${draftRect.w * 100}%`,
                  height: `${draftRect.h * 100}%`,
                  border: "2px dashed #D95D22",
                  borderRadius: 4,
                  background: "rgba(217, 93, 34, 0.14)",
                  pointerEvents: "none",
                  zIndex: 5,
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
