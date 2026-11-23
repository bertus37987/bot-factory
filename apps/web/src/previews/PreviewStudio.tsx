import { Box, Check, Crosshair, FileText, Image as ImageIcon, Move, RotateCcw, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { AnnotationAnchor, AnnotationRecord, AnnotationStatus, ArtifactEntry } from "@bot-factory/shared";
import { BotThinkingOrb } from "../components/BotThinkingOrb";

interface PreviewStudioProps {
  projectId: string;
  artifacts: ArtifactEntry[];
  annotations: AnnotationRecord[];
  initialPath?: string | null;
  onCreateAnnotation: (params: {
    anchor: AnnotationAnchor;
    comment: string;
    snapshotDataUrl?: string;
    requestFixNow: boolean;
  }) => Promise<void>;
  onResolveAnnotation: (annotationId: string, status: AnnotationStatus) => Promise<void>;
}

function quickHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function PreviewStudio({
  projectId,
  artifacts,
  annotations,
  initialPath,
  onCreateAnnotation,
  onResolveAnnotation,
}: PreviewStudioProps) {
  const previewable = useMemo(
    () => artifacts.filter((a) => a.kind === "doc" || a.kind === "image" || a.kind === "model_3d"),
    [artifacts],
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath ?? previewable[0]?.relativePath ?? null);
  const [mode, setMode] = useState<"navigate" | "annotate">("annotate");
  const [pendingAnchor, setPendingAnchor] = useState<AnnotationAnchor | null>(null);
  const [pendingSnapshot, setPendingSnapshot] = useState<string | undefined>(undefined);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [focusCameraPose, setFocusCameraPose] = useState<{ pos: [number, number, number]; target: [number, number, number] } | null>(null);

  useEffect(() => {
    if (initialPath) {
      setSelectedPath(initialPath);
    }
  }, [initialPath]);

  useEffect(() => {
    if (!selectedPath && previewable[0]) {
      setSelectedPath(previewable[0].relativePath);
    }
  }, [previewable, selectedPath]);

  const activeArtifact = previewable.find((a) => a.relativePath === selectedPath) ?? previewable[0] ?? null;
  const activeAnnotations = useMemo(
    () => (activeArtifact ? annotations.filter((a) => a.filePath === activeArtifact.relativePath) : []),
    [annotations, activeArtifact],
  );

  const artifactUrl = activeArtifact
    ? `/api/projects/${encodeURIComponent(projectId)}/artifact?path=${encodeURIComponent(activeArtifact.relativePath)}`
    : "";

  const submitAnnotation = async () => {
    if (!pendingAnchor || !comment.trim() || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await onCreateAnnotation({
        anchor: pendingAnchor,
        comment: comment.trim(),
        snapshotDataUrl: pendingSnapshot,
        requestFixNow: true,
      });
      setPendingAnchor(null);
      setPendingSnapshot(undefined);
      setComment("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const resolveAnnotation = (annotationId: string, status: AnnotationStatus) => {
    setActionError(null);
    void onResolveAnnotation(annotationId, status).catch((err) => {
      setActionError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <div className="preview-layout">
      {/* Left: Artifact Picker */}
      <div className="preview-panel">
        <div className="preview-panel-header">
          <span>Artefakte & Pläne ({previewable.length})</span>
        </div>
        <div style={{ padding: 8, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
          {previewable.length === 0 && (
            <div style={{ color: "var(--ink-muted)", fontSize: "var(--text-xs)", padding: 8 }}>
              Keine Preview-Dateien gefunden.
            </div>
          )}
          {previewable.map((art) => {
            const count = annotations.filter((a) => a.filePath === art.relativePath).length;
            const active = activeArtifact?.relativePath === art.relativePath;
            return (
              <button
                key={art.relativePath}
                className={`artifact-pick-btn ${active ? "active" : ""}`}
                onClick={() => {
                  setSelectedPath(art.relativePath);
                  setPendingAnchor(null);
                  setPendingSnapshot(undefined);
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {art.kind === "doc" && <FileText size={13} strokeWidth={1.6} color="var(--ink-secondary)" />}
                  {art.kind === "image" && <ImageIcon size={13} strokeWidth={1.6} color="var(--ink-secondary)" />}
                  {art.kind === "model_3d" && <Box size={13} strokeWidth={1.6} color="var(--ink-secondary)" />}
                  <span>{art.name}</span>
                </span>
                {count > 0 && <span className="mono-tag">{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Center: Interactive Preview Canvas */}
      <div className="preview-panel">
        <div className="preview-panel-header">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>{activeArtifact ? activeArtifact.relativePath : "Kein Artefakt gewählt"}</span>
            {activeArtifact && <span className="mono-tag">{activeArtifact.kind}</span>}
          </span>
          <div className="subview-tabs">
            <button
              className={`subview-tab ${mode === "navigate" ? "active" : ""}`}
              onClick={() => setMode("navigate")}
              title="Zoom, Orbit & Lesen ohne Pins zu setzen"
            >
              <Move size={13} strokeWidth={1.6} color="var(--ink-secondary)" /> Navigate
            </button>
            <button
              className={`subview-tab ${mode === "annotate" ? "active" : ""}`}
              onClick={() => setMode("annotate")}
              title="Klicke auf Absatz, Bildbereich oder 3D-Oberfläche für Fix-Kommentar"
            >
              <Crosshair size={13} strokeWidth={1.6} color="var(--ink-secondary)" /> Annotate
            </button>
          </div>
        </div>

        <div
          className={`preview-canvas-wrap ${
            activeArtifact?.kind === "model_3d" || activeArtifact?.kind === "image" ? "stage-light" : ""
          }`}
        >
          {activeArtifact?.kind === "doc" && (
            <DocPreview
              artifactUrl={artifactUrl}
              filePath={activeArtifact.relativePath}
              mode={mode}
              annotations={activeAnnotations}
              onPickAnchor={(anchor) => {
                setPendingAnchor(anchor);
                setPendingSnapshot(undefined);
              }}
            />
          )}
          {activeArtifact?.kind === "image" && (
            <ImagePreview
              artifactUrl={artifactUrl}
              filePath={activeArtifact.relativePath}
              mode={mode}
              annotations={activeAnnotations}
              onPickAnchor={(anchor) => {
                setPendingAnchor(anchor);
                setPendingSnapshot(undefined);
              }}
            />
          )}
          {activeArtifact?.kind === "model_3d" && (
            <Model3DPreview
              artifactUrl={artifactUrl}
              filePath={activeArtifact.relativePath}
              mode={mode}
              annotations={activeAnnotations}
              focusCameraPose={focusCameraPose}
              onPickAnchor={(anchor, snapshot) => {
                setPendingAnchor(anchor);
                setPendingSnapshot(snapshot);
              }}
            />
          )}
        </div>
      </div>

      {/* Right: Comment-to-Fix Loop Panel */}
      <div className="preview-panel">
        <div className="preview-panel-header">
          <span>Annotationen → Fix-Loop ({activeAnnotations.length})</span>
        </div>
        <div style={{ padding: 10, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, flex: 1 }}>
          {actionError && <div className="inline-error">{actionError}</div>}

          {pendingAnchor && (
            <div className="ann-draft-card">
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink-primary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 6,
                }}
              >
                <span>Neuer Pin ({pendingAnchor.kind})</span>
                {submitting && <BotThinkingOrb activity="shaping" size={20} />}
              </div>
              <div className="mono-tag" style={{ overflowWrap: "anywhere" }}>
                {pendingAnchor.kind === "doc" && `block: ${pendingAnchor.blockId}`}
                {pendingAnchor.kind === "image" &&
                  (pendingAnchor.pin
                    ? `pin: (${pendingAnchor.pin.x.toFixed(2)}, ${pendingAnchor.pin.y.toFixed(2)})`
                    : "rect")}
                {pendingAnchor.kind === "model_3d" &&
                  `mesh: ${pendingAnchor.meshName} @ [${pendingAnchor.point.map((n) => n.toFixed(2)).join(", ")}]`}
              </div>
              {pendingSnapshot && (
                <img
                  src={pendingSnapshot}
                  alt="3D Camera Snapshot"
                  style={{
                    width: "100%",
                    borderRadius: "var(--radius-sm)",
                    border: "var(--hairline)",
                  }}
                />
              )}
              <textarea
                className="field-textarea"
                rows={3}
                placeholder="Was soll der zuständige Bot hier fixen?"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button className="btn sm" onClick={() => setPendingAnchor(null)}>
                  Abbrechen
                </button>
                <button className="btn sm primary" onClick={() => void submitAnnotation()} disabled={submitting || !comment.trim()}>
                  <Send size={12} strokeWidth={1.6} /> Fix-Task auslösen
                </button>
              </div>
            </div>
          )}

          {activeAnnotations.length === 0 && !pendingAnchor && (
            <div style={{ color: "var(--ink-muted)", fontSize: "var(--text-xs)", lineHeight: "var(--leading-normal)" }}>
              Wechsle auf <b>Annotate</b> und klicke direkt auf einen Plan-Absatz, Bildpunkt oder eine 3D-Fläche, um
              automatisch einen gezielten Fix-Task beim Project Manager auszulösen.
            </div>
          )}

          {activeAnnotations.map((ann, idx) => (
            <div
              key={ann.id}
              className={`ann-item ${ann.anchor.kind === "model_3d" ? "clickable" : ""}`}
              onClick={() => {
                if (ann.anchor.kind === "model_3d") {
                  setFocusCameraPose({ pos: ann.anchor.camera.pos, target: ann.anchor.camera.target });
                }
              }}
              style={{ cursor: ann.anchor.kind === "model_3d" ? "pointer" : "default" }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                <span style={{ fontWeight: "var(--weight-semibold)" }}>#{idx + 1} · {ann.targetType}</span>
                <span
                  className={`pill ${
                    ann.status === "approved"
                      ? "success"
                      : ann.status === "resolved_pending_review"
                        ? "warning"
                        : "active"
                  }`}
                >
                  {ann.status}
                </span>
              </div>
              <div>{ann.comment}</div>
              {ann.linkedTaskId && <span className="mono-tag">Task: {ann.linkedTaskId}</span>}
              {ann.status !== "approved" && (
                <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                  <button
                    className="btn sm primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      resolveAnnotation(ann.id, "approved");
                    }}
                  >
                    <Check size={12} strokeWidth={1.6} /> Freigeben
                  </button>
                  {ann.status === "resolved_pending_review" && (
                    <button
                      className="btn sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        resolveAnnotation(ann.id, "open");
                      }}
                    >
                      <RotateCcw size={12} strokeWidth={1.6} /> Nachbessern
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DocPreview({
  artifactUrl,
  filePath,
  mode,
  annotations,
  onPickAnchor,
}: {
  artifactUrl: string;
  filePath: string;
  mode: "navigate" | "annotate";
  annotations: AnnotationRecord[];
  onPickAnchor: (anchor: AnnotationAnchor) => void;
}) {
  const [text, setText] = useState("Lade Dokument...");

  useEffect(() => {
    let alive = true;
    fetch(artifactUrl)
      .then((r) => r.text())
      .then((t) => {
        if (alive) setText(t);
      })
      .catch(() => {
        if (alive) setText("(Dokument konnte nicht geladen werden)");
      });
    return () => {
      alive = false;
    };
  }, [artifactUrl, annotations.length]);

  const blocks = useMemo(() => {
    return text
      .split(/\n{2,}/)
      .map((raw, idx) => {
        const clean = raw.trim();
        const slug = clean
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 28);
        return {
          blockId: `blk-${idx}-${slug || "section"}`,
          contentHash: quickHash(clean),
          text: clean,
        };
      })
      .filter((b) => b.text.length > 0);
  }, [text]);

  return (
    <div className="doc-stage">
      {blocks.map((b) => {
        const pinned = annotations.some(
          (a) => a.anchor.kind === "doc" && (a.anchor.blockId === b.blockId || a.anchor.contentHash === b.contentHash),
        );
        const isHeading = b.text.startsWith("#");
        return (
          <div
            key={b.blockId}
            data-block-id={b.blockId}
            className={`doc-block ${mode === "annotate" ? "annotatable" : ""} ${pinned ? "has-pin" : ""}`}
            onClick={() => {
              if (mode !== "annotate") return;
              onPickAnchor({
                kind: "doc",
                filePath,
                blockId: b.blockId,
                contentHash: b.contentHash,
                quote: b.text.slice(0, 140),
              });
            }}
          >
            <div
              style={{
                fontWeight: isHeading ? "var(--weight-semibold)" : "var(--weight-regular)",
                fontSize: isHeading ? "var(--text-lg)" : "var(--text-base)",
                lineHeight: "var(--leading-prose)",
                color: "var(--ink-primary)",
                whiteSpace: "pre-wrap",
              }}
            >
              {b.text}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ImagePreview({
  artifactUrl,
  filePath,
  mode,
  annotations,
  onPickAnchor,
}: {
  artifactUrl: string;
  filePath: string;
  mode: "navigate" | "annotate";
  annotations: AnnotationRecord[];
  onPickAnchor: (anchor: AnnotationAnchor) => void;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-start", minHeight: "100%" }}>
      <div
        className="img-stage"
        style={{ cursor: mode === "annotate" ? "crosshair" : "grab" }}
        onClick={(e) => {
          if (mode !== "annotate" || !imgRef.current) return;
          const rect = imgRef.current.getBoundingClientRect();
          const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
          const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
          onPickAnchor({ kind: "image", filePath, pin: { x, y } });
        }}
      >
        <img
          ref={imgRef}
          src={artifactUrl}
          alt={filePath}
          style={{
            display: "block",
            maxWidth: "100%",
            borderRadius: "var(--radius-md)",
            border: "var(--hairline)",
          }}
        />
        {annotations.map((ann, idx) => {
          if (ann.anchor.kind !== "image" || !ann.anchor.pin) return null;
          return (
            <div
              key={ann.id}
              className="pin-marker"
              style={{ left: `${ann.anchor.pin.x * 100}%`, top: `${ann.anchor.pin.y * 100}%` }}
              title={ann.comment}
            >
              {idx + 1}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function disposeObjectTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry && typeof mesh.geometry.dispose === "function") {
      mesh.geometry.dispose();
    }
    const mat = mesh.material;
    if (Array.isArray(mat)) {
      for (const m of mat) {
        if (m && typeof m.dispose === "function") m.dispose();
      }
    } else if (mat && typeof mat.dispose === "function") {
      mat.dispose();
    }
  });
}

function Model3DPreview({
  artifactUrl,
  filePath,
  mode,
  annotations,
  focusCameraPose,
  onPickAnchor,
}: {
  artifactUrl: string;
  filePath: string;
  mode: "navigate" | "annotate";
  annotations: AnnotationRecord[];
  focusCameraPose: { pos: [number, number, number]; target: [number, number, number] } | null;
  onPickAnchor: (anchor: AnnotationAnchor, snapshotDataUrl?: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const modeRef = useRef(mode);
  const onPickRef = useRef(onPickAnchor);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pinsGroupRef = useRef<THREE.Group | null>(null);
  const pinAssetsRef = useRef<{ geo: THREE.SphereGeometry; mat: THREE.MeshBasicMaterial } | null>(null);
  const [loadStatus, setLoadStatus] = useState("Lade 3D-Asset...");

  modeRef.current = mode;
  onPickRef.current = onPickAnchor;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f5f5);

    const width = Math.max(host.clientWidth, 320);
    const height = Math.max(host.clientHeight, 360);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 200);
    camera.position.set(3.6, 2.8, 4.4);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.innerHTML = "";
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0.9, 0);
    controlsRef.current = controls;

    // Neutral museum studio daylight (Light-Mode Harmony)
    scene.add(new THREE.HemisphereLight(0xffffff, 0xe5e5e8, 1.15));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.25);
    keyLight.position.set(4, 7, 5);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xeef2f7, 0.55);
    fillLight.position.set(-4, 4, -3);
    scene.add(fillLight);
    scene.add(new THREE.GridHelper(8, 16, 0xd4d4d8, 0xe6e6ea));

    const modelGroup = new THREE.Group();
    scene.add(modelGroup);
    const pinsGroup = new THREE.Group();
    scene.add(pinsGroup);
    pinsGroupRef.current = pinsGroup;

    // Shared GPU resources for 3D annotation pins (reused across updates, disposed on unmount)
    const pinGeo = new THREE.SphereGeometry(0.065, 16, 16);
    const pinMat = new THREE.MeshBasicMaterial({ color: 0x171717, depthTest: false });
    pinAssetsRef.current = { geo: pinGeo, mat: pinMat };

    const loader = new GLTFLoader();
    loader.load(
      artifactUrl,
      (gltf) => {
        if (cancelled) {
          disposeObjectTree(gltf.scene);
          return;
        }
        modelGroup.add(gltf.scene);
        setLoadStatus(`GLB geladen (${filePath})`);
      },
      undefined,
      () => {
        if (cancelled) return;
        const fallback = new THREE.Mesh(
          new THREE.BoxGeometry(1.2, 1.8, 1.2),
          new THREE.MeshStandardMaterial({ color: 0x525252, metalness: 0.15, roughness: 0.55 }),
        );
        fallback.name = "FallbackMonolith";
        fallback.position.y = 0.9;
        modelGroup.add(fallback);
        setLoadStatus("Fallback-Mesh aktiv");
      },
    );

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const handleClick = (ev: MouseEvent) => {
      if (modeRef.current !== "annotate") return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(modelGroup.children, true);
      if (hits.length === 0) return;

      const hit = hits[0]!;
      const normal = hit.face?.normal
        ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
        : new THREE.Vector3(0, 1, 0);

      renderer.render(scene, camera);
      let snapshotDataUrl: string | undefined;
      try {
        snapshotDataUrl = renderer.domElement.toDataURL("image/png");
      } catch {
        snapshotDataUrl = undefined;
      }

      onPickRef.current(
        {
          kind: "model_3d",
          filePath,
          meshName: hit.object.name || "Mesh",
          point: [hit.point.x, hit.point.y, hit.point.z],
          normal: [normal.x, normal.y, normal.z],
          camera: {
            pos: [camera.position.x, camera.position.y, camera.position.z],
            target: [controls.target.x, controls.target.y, controls.target.z],
            fov: camera.fov,
          },
        },
        snapshotDataUrl,
      );
    };

    renderer.domElement.addEventListener("click", handleClick);

    const resizeObserver = new ResizeObserver(() => {
      const w = Math.max(host.clientWidth, 320);
      const h = Math.max(host.clientHeight, 360);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(host);

    let rafId = 0;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("click", handleClick);
      controls.dispose();
      disposeObjectTree(scene);
      pinGeo.dispose();
      pinMat.dispose();
      pinAssetsRef.current = null;
      pinsGroupRef.current = null;
      renderer.dispose();
      renderer.forceContextLoss();
    };
  }, [artifactUrl, filePath]);

  useEffect(() => {
    const group = pinsGroupRef.current;
    const assets = pinAssetsRef.current;
    if (!group || !assets) return;
    while (group.children.length > 0) {
      group.remove(group.children[0]!);
    }
    for (const ann of annotations) {
      if (ann.anchor.kind !== "model_3d") continue;
      const [px, py, pz] = ann.anchor.point;
      const [nx, ny, nz] = ann.anchor.normal;
      const pin = new THREE.Mesh(assets.geo, assets.mat);
      pin.position.set(px + nx * 0.08, py + ny * 0.08, pz + nz * 0.08);
      pin.renderOrder = 999;
      group.add(pin);
    }
  }, [annotations, artifactUrl]);

  useEffect(() => {
    if (!focusCameraPose || !cameraRef.current || !controlsRef.current) return;
    cameraRef.current.position.set(...focusCameraPose.pos);
    controlsRef.current.target.set(...focusCameraPose.target);
    controlsRef.current.update();
  }, [focusCameraPose]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", minHeight: 380 }}>
      <div ref={hostRef} style={{ width: "100%", height: "100%", cursor: mode === "annotate" ? "crosshair" : "grab" }} />
      <div className="stage-3d-hud">
        {loadStatus} · Modus: {mode === "annotate" ? "Annotate (Klick auf 3D-Mesh setzt Pin + Kamera-Snapshot)" : "Navigate (Orbit/Zoom)"}
      </div>
    </div>
  );
}
