import { Check, Crosshair, MessageSquare, RotateCcw, Send, X } from "lucide-react";
import { useEffect, type JSX } from "react";
import type { AnnotationAnchor, AnnotationRecord, AnnotationStatus } from "@bot-factory/shared";
import { BotThinkingOrb } from "../components/BotThinkingOrb";
import { formatAnnotationStatus } from "./types";

export interface AnnotationOverlayProps {
  pendingAnchor: AnnotationAnchor | null;
  pendingSnapshot?: string;
  comment: string;
  requestFixNow: boolean;
  submitting: boolean;
  actionError: string | null;
  pinsOpen: boolean;
  fileAnnotations: AnnotationRecord[];
  onChangeComment: (next: string) => void;
  onChangeRequestFixNow: (next: boolean) => void;
  onCancelComposer: () => void;
  onSubmitComposer: () => void;
  onClosePins: () => void;
  onJumpToPin: (ann: AnnotationRecord) => void;
  onResolveAnnotation: (annotationId: string, status: AnnotationStatus) => void;
}

function formatAnchorSummary(anchor: AnnotationAnchor): string {
  switch (anchor.kind) {
    case "doc":
      return `block: ${anchor.blockId}`;
    case "image":
      if (anchor.pin) {
        return `pin: (${(anchor.pin.x * 100).toFixed(1)}%, ${(anchor.pin.y * 100).toFixed(1)}%)`;
      }
      if (anchor.rect) {
        return `rect: (${(anchor.rect.x * 100).toFixed(1)}%, ${(anchor.rect.y * 100).toFixed(1)}%, ${(anchor.rect.w * 100).toFixed(1)}% x ${(anchor.rect.h * 100).toFixed(1)}%)`;
      }
      return "region";
    case "model_3d":
      return `mesh: ${anchor.meshName} @ [${anchor.point.map((n) => n.toFixed(2)).join(", ")}]`;
  }
}

function statusPillClass(status: AnnotationStatus): string {
  switch (status) {
    case "approved":
      return "pill success";
    case "resolved_pending_review":
    case "in_progress":
      return "pill warning";
    case "open":
      return "pill active";
  }
}

export function AnnotationOverlay({
  pendingAnchor,
  pendingSnapshot,
  comment,
  requestFixNow,
  submitting,
  actionError,
  pinsOpen,
  fileAnnotations,
  onChangeComment,
  onChangeRequestFixNow,
  onCancelComposer,
  onSubmitComposer,
  onClosePins,
  onJumpToPin,
  onResolveAnnotation,
}: AnnotationOverlayProps): JSX.Element | null {
  useEffect(() => {
    if (!pinsOpen && !pendingAnchor) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pendingAnchor) {
        onCancelComposer();
      } else if (pinsOpen) {
        onClosePins();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pinsOpen, pendingAnchor, onCancelComposer, onClosePins]);

  if (pendingAnchor) {
    return (
      <div
        className="iab-composer"
        role="dialog"
        aria-label="New annotation pin"
        style={{
          position: "absolute",
          right: 12,
          bottom: 12,
          width: 316,
          maxWidth: "calc(100% - 24px)",
          background: "#FFFFFF",
          border: "1px solid var(--border-hairline)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-modal)",
          zIndex: 40,
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 6,
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink-primary)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <MessageSquare size={13} strokeWidth={1.6} color="#D95D22" />
            <span>New Pin ({pendingAnchor.kind})</span>
          </span>
          {submitting && <BotThinkingOrb activity="shaping" size={20} />}
        </div>

        <div
          className="mono-tag"
          style={{
            overflowWrap: "anywhere",
            whiteSpace: "normal",
            fontSize: "var(--text-2xs)",
            color: "var(--ink-muted)",
          }}
        >
          {formatAnchorSummary(pendingAnchor)}
        </div>

        {pendingSnapshot && (
          <img
            src={pendingSnapshot}
            alt="3D camera snapshot"
            style={{
              width: "100%",
              maxHeight: 132,
              objectFit: "cover",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-hairline)",
              display: "block",
            }}
          />
        )}

        <textarea
          className="field-textarea iab-composer-text"
          rows={3}
          placeholder="Describe what should be updated or reviewed here..."
          value={comment}
          autoFocus
          onChange={(e) => onChangeComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSubmitComposer();
            }
          }}
          style={{
            width: "100%",
            resize: "vertical",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
            lineHeight: "var(--leading-normal)",
            border: "1px solid var(--border-hairline)",
            borderRadius: "var(--radius-sm)",
            padding: "6px 8px",
            color: "var(--ink-primary)",
            background: "#FFFFFF",
          }}
        />

        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 7,
            fontSize: "var(--text-xs)",
            color: "var(--ink-secondary)",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            checked={requestFixNow}
            onChange={(e) => onChangeRequestFixNow(e.target.checked)}
            style={{ marginTop: 2, accentColor: "#D95D22" }}
          />
          <span>
            <span style={{ display: "block", fontWeight: "var(--weight-medium)", color: "var(--ink-primary)" }}>
              Request fix immediately
            </span>
            <span style={{ display: "block", fontSize: "var(--text-2xs)", color: "var(--ink-muted)" }}>
              Uncheck to save a comment-only pin without dispatching a bot.
            </span>
          </span>
        </label>

        {actionError && (
          <div className="inline-error" role="alert">
            <span>{actionError}</span>
          </div>
        )}

        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button type="button" className="btn sm" onClick={onCancelComposer}>
            Cancel
          </button>
          <button
            type="button"
            className="btn sm primary"
            onClick={onSubmitComposer}
            disabled={submitting || !comment.trim()}
          >
            <Send size={12} strokeWidth={1.6} />
            <span>{requestFixNow ? "Submit Fix Pin" : "Save Comment"}</span>
          </button>
        </div>
      </div>
    );
  }

  if (pinsOpen) {
    return (
      <div
        className="iab-pins-popover"
        role="dialog"
        aria-label="Pins review"
        style={{
          position: "absolute",
          right: 12,
          top: 76,
          width: 336,
          maxWidth: "calc(100% - 24px)",
          maxHeight: "calc(100% - 92px)",
          overflowY: "auto",
          background: "#FFFFFF",
          border: "1px solid var(--border-hairline)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-modal)",
          zIndex: 40,
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink-primary)",
          }}
        >
          <span>Annotations ({fileAnnotations.length})</span>
          <button
            type="button"
            className="btn xs ghost"
            aria-label="Close pins panel"
            onClick={onClosePins}
          >
            <X size={13} strokeWidth={1.6} />
          </button>
        </div>

        {actionError && (
          <div className="inline-error" role="alert">
            <span>{actionError}</span>
          </div>
        )}

        {fileAnnotations.length === 0 && (
          <div style={{ color: "var(--ink-muted)", fontSize: "var(--text-xs)", lineHeight: "var(--leading-normal)" }}>
            No pins on this file yet. Enable <b>Annotate</b> and click or drag directly on the canvas.
          </div>
        )}

        {fileAnnotations.map((ann, idx) => (
          <div
            key={ann.id}
            className="ann-item iab-ann-item"
            style={{
              border: "1px solid var(--border-hairline)",
              borderRadius: "var(--radius-md)",
              padding: "8px 10px",
              fontSize: "var(--text-xs)",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              background: "#FAFAFA",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
              <span style={{ fontWeight: "var(--weight-semibold)", color: "var(--ink-primary)", display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    background: ann.status === "approved" ? "#165E3D" : "#D95D22",
                    color: "#FFFFFF",
                    fontSize: 10,
                  }}
                >
                  {idx + 1}
                </span>
                <span>{ann.targetType}</span>
              </span>
              <span className={statusPillClass(ann.status)}>{formatAnnotationStatus(ann.status)}</span>
            </div>

            {ann.snapshotDataUrl && (
              <img
                src={ann.snapshotDataUrl}
                alt={`Snapshot for pin #${idx + 1}`}
                style={{
                  width: "100%",
                  maxHeight: 112,
                  objectFit: "cover",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border-hairline)",
                  display: "block",
                  background: "#F5F5F5",
                }}
              />
            )}

            <div style={{ color: "var(--ink-secondary)", lineHeight: "var(--leading-normal)" }}>{ann.comment}</div>

            {ann.linkedTaskId && (
              <span className="mono-tag" style={{ width: "fit-content" }}>
                Task: {ann.linkedTaskId}
              </span>
            )}

            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
              <button
                type="button"
                className="btn xs"
                onClick={() => onJumpToPin(ann)}
                title={
                  ann.anchor.kind === "model_3d"
                    ? "Restore 3D camera pose for this pin"
                    : "Jump to pin location"
                }
              >
                <Crosshair size={11} strokeWidth={1.6} />
                <span>Jump to pin</span>
              </button>

              {ann.status !== "approved" && (
                <button
                  type="button"
                  className="btn xs primary"
                  onClick={() => onResolveAnnotation(ann.id, "approved")}
                >
                  <Check size={11} strokeWidth={1.6} />
                  <span>Approve</span>
                </button>
              )}

              {(ann.status === "resolved_pending_review" || ann.status === "approved") && (
                <button
                  type="button"
                  className="btn xs"
                  onClick={() => onResolveAnnotation(ann.id, "open")}
                >
                  <RotateCcw size={11} strokeWidth={1.6} />
                  <span>Request Revision</span>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return null;
}
