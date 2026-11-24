import { Globe } from "lucide-react";
import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import type { AnnotationAnchor } from "@bot-factory/shared";
import { BrowserChrome } from "./BrowserChrome";
import { useBrowserShellContext } from "./BrowserWorkspaceShell";
import { CodeViewer } from "./CodeViewer";
import { DiffViewer } from "./DiffViewer";
import { DocViewer } from "./DocViewer";
import { ImageViewer } from "./ImageViewer";
import type {
  BrowserDockMode,
  BrowserTab,
  BrowserTabKind,
  CameraPose,
  ComposerAttachment,
  ImageZoomMode,
  InAppBrowserProps,
  Model3DPreset,
} from "./types";
import { WebViewer } from "./WebViewer";

export type { BrowserDockMode, BrowserTab, BrowserTabKind, ComposerAttachment, InAppBrowserProps };

const LazyModel3DViewer = lazy(() => import("./Model3DViewer"));

class ViewerErrorBoundary extends Component<
  { fallbackTitle: string; children: ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { fallbackTitle: string; children: ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: unknown) {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="iab-error-banner"
          role="alert"
          style={{
            margin: 16,
            padding: "10px 14px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--status-danger-border)",
            background: "var(--status-danger-bg)",
            color: "var(--status-danger-ink)",
            fontSize: "var(--text-sm)",
          }}
        >
          {this.props.fallbackTitle}: {this.state.message || "Unexpected viewer error."}
        </div>
      );
    }
    return this.props.children;
  }
}

export function InAppBrowser({
  project,
  artifacts,
  annotations,
  repoFiles,
  gitDiff,
  activeAgentId = null,
  tabs,
  activeTabId,
  expanded,
  dockMode,
  onChangeDockMode,
  onImportToChat,
  onArtifactSaved,
  onStartFloatDrag,
  onSelectTab,
  onCloseTab,
  onOpenTab,
  onToggleExpand,
  onCloseSidebar,
  onRefreshContext,
  onCreateAnnotation,
}: InAppBrowserProps): JSX.Element {
  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);
  const effectiveProjectId = activeTab?.projectId || project?.id || null;
  const shellCtx = useBrowserShellContext();
  const effectiveDockMode: BrowserDockMode =
    dockMode ?? shellCtx?.dockMode ?? (expanded ? "fullscreen" : "right");
  const effectiveFloatDrag = onStartFloatDrag ?? shellCtx?.onStartFloatDrag;

  /* Per-session visited-tab history -------------------------------------- */
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);
  const [, setHistVersion] = useState(0);

  const pushHistory = useCallback((tabId: string) => {
    const cur = historyRef.current[historyIdxRef.current];
    if (cur === tabId) return;
    historyRef.current = historyRef.current.slice(0, historyIdxRef.current + 1);
    historyRef.current.push(tabId);
    historyIdxRef.current = historyRef.current.length - 1;
    setHistVersion((v) => v + 1);
  }, []);

  const selectTab = useCallback(
    (tabId: string) => {
      pushHistory(tabId);
      onSelectTab(tabId);
    },
    [pushHistory, onSelectTab],
  );

  const goBack = useCallback(() => {
    if (historyIdxRef.current <= 0) return;
    historyIdxRef.current -= 1;
    const targetId = historyRef.current[historyIdxRef.current];
    setHistVersion((v) => v + 1);
    if (targetId) onSelectTab(targetId);
  }, [onSelectTab]);

  const goForward = useCallback(() => {
    if (historyIdxRef.current >= historyRef.current.length - 1) return;
    historyIdxRef.current += 1;
    const targetId = historyRef.current[historyIdxRef.current];
    setHistVersion((v) => v + 1);
    if (targetId) onSelectTab(targetId);
  }, [onSelectTab]);

  useEffect(() => {
    if (activeTabId) pushHistory(activeTabId);
  }, [activeTabId, pushHistory]);

  useEffect(() => {
    const ids = new Set(tabs.map((t) => t.id));
    const kept = historyRef.current.filter((id) => ids.has(id));
    if (kept.length !== historyRef.current.length) {
      const activeIdx = kept.indexOf(activeTabId ?? "");
      historyRef.current = kept;
      historyIdxRef.current = activeIdx >= 0 ? activeIdx : kept.length - 1;
      setHistVersion((v) => v + 1);
    }
  }, [tabs, activeTabId]);

  /* Local browser UI & viewer state -------------------------------------- */
  const [reloadNonce, setReloadNonce] = useState(0);
  const [omniboxFeedback, setOmniboxFeedback] = useState<string | null>(null);

  // Viewer-specific toolbar & focus states
  const [imageZoom, setImageZoom] = useState<ImageZoomMode>("fit");
  const [model3dPreset, setModel3dPreset] = useState<Model3DPreset | "">("Iso");
  const [model3dPresetNonce, setModel3dPresetNonce] = useState(0);
  const [model3dWireframe, setModel3dWireframe] = useState(false);
  const [focusCameraPose, setFocusCameraPose] = useState<CameraPose | null>(null);

  useEffect(() => {
    setFocusCameraPose(null);
    setOmniboxFeedback(null);
  }, [activeTabId]);

  const activeArtifact = useMemo(
    () => (activeTab ? artifacts.find((a) => a.relativePath === activeTab.target) ?? null : null),
    [artifacts, activeTab],
  );

  const fileAnnotations = useMemo(() => {
    if (!activeTab) return [];
    return annotations.filter(
      (a) => a.filePath === activeTab.target && (!activeTab.projectId || a.projectId === activeTab.projectId),
    );
  }, [annotations, activeTab]);

  const handleImportToChat = useCallback(
    (attachment: ComposerAttachment) => {
      if (onImportToChat) {
        onImportToChat(attachment);
        return;
      }
      if (onCreateAnnotation) {
        const anchor: AnnotationAnchor =
          attachment.kind === "doc_comment"
            ? {
                kind: "doc",
                filePath: attachment.filePath,
                blockId: attachment.id,
                contentHash: attachment.id,
                quote: attachment.quote ?? "",
              }
            : attachment.kind === "image_comment"
              ? {
                  kind: "image",
                  filePath: attachment.filePath,
                  ...(attachment.region ? { rect: attachment.region } : { pin: { x: 0.5, y: 0.5 } }),
                }
              : {
                  kind: "model_3d",
                  filePath: attachment.filePath,
                  meshName: attachment.label || "Mesh",
                  point: [0, 0, 0],
                  normal: [0, 1, 0],
                  camera: { pos: [0, 2, 5], target: [0, 0, 0], fov: 45 },
                };
        void onCreateAnnotation({
          anchor,
          comment: attachment.comment,
          snapshotDataUrl: attachment.thumbnailDataUrl,
          requestFixNow: true,
        });
      }
    },
    [onImportToChat, onCreateAnnotation],
  );

  const handleArtifactSaved = useCallback(
    (savedPath: string) => {
      onRefreshContext();
      onArtifactSaved?.(savedPath);
    },
    [onRefreshContext, onArtifactSaved],
  );

  const handleChangeDockMode = useCallback(
    (next: BrowserDockMode) => {
      if (onChangeDockMode) {
        onChangeDockMode(next);
        return;
      }
      if (next === "fullscreen" || effectiveDockMode === "fullscreen") {
        onToggleExpand();
      }
    },
    [onChangeDockMode, effectiveDockMode, onToggleExpand],
  );

  const canBack = historyIdxRef.current > 0;
  const canForward = historyIdxRef.current < historyRef.current.length - 1;

  return (
    <div
      className={`iab-root iab-shell ${effectiveDockMode === "fullscreen" ? "iab-expanded" : ""}`}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--bg-canvas)",
        color: "var(--ink-primary)",
        fontFamily: "var(--font-sans)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <BrowserChrome
        project={project}
        tabs={tabs}
        activeTab={activeTab}
        activeTabId={activeTabId}
        artifacts={artifacts}
        repoFiles={repoFiles}
        gitDiff={gitDiff}
        dockMode={effectiveDockMode}
        canBack={canBack}
        canForward={canForward}
        imageZoom={imageZoom}
        model3dPreset={model3dPreset}
        model3dWireframe={model3dWireframe}
        omniboxFeedback={omniboxFeedback}
        onSelectTab={selectTab}
        onCloseTab={onCloseTab}
        onOpenTab={onOpenTab}
        onBack={goBack}
        onForward={goForward}
        onReload={() => {
          setReloadNonce((n) => n + 1);
          onRefreshContext();
        }}
        onChangeDockMode={handleChangeDockMode}
        onStartFloatDrag={effectiveFloatDrag}
        onCloseSidebar={onCloseSidebar}
        onChangeImageZoom={setImageZoom}
        onSelectModel3DPreset={(preset) => {
          setModel3dPreset(preset);
          setModel3dPresetNonce((n) => n + 1);
        }}
        onToggleModel3DWireframe={() => setModel3dWireframe((w) => !w)}
        onClearOmniboxFeedback={() => setOmniboxFeedback(null)}
        onSetOmniboxFeedback={setOmniboxFeedback}
      />

      {/* ============================ CONTENT CANVAS ============================ */}
      <div
        className="iab-canvas iab-body"
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          background: "var(--bg-canvas)",
          overflow: "hidden",
        }}
      >
        {!activeTab && (
          <div
            className="iab-empty"
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: 24,
              textAlign: "center",
              color: "var(--ink-muted)",
              fontSize: "var(--text-sm)",
            }}
          >
            <Globe size={22} strokeWidth={1.4} color="var(--ink-faint)" />
            <span>
              No tab open — click <b>+</b> above to open docs, images, 3D assets, code files, Git diff, or a local URL.
            </span>
          </div>
        )}

        {activeTab?.kind === "doc" && effectiveProjectId && (
          <DocViewer
            key={`${activeTab.id}:${reloadNonce}`}
            projectId={effectiveProjectId}
            filePath={activeTab.target}
            annotations={fileAnnotations}
            artifactVersion={activeArtifact?.updatedAt ?? 0}
            onImportToChat={handleImportToChat}
            onArtifactSaved={handleArtifactSaved}
          />
        )}

        {activeTab?.kind === "image" && effectiveProjectId && (
          <ImageViewer
            key={`${activeTab.id}:${reloadNonce}`}
            projectId={effectiveProjectId}
            filePath={activeTab.target}
            annotations={fileAnnotations}
            zoom={imageZoom}
            artifactVersion={activeArtifact?.updatedAt ?? 0}
            onImportToChat={handleImportToChat}
            onArtifactSaved={handleArtifactSaved}
          />
        )}

        {activeTab?.kind === "model_3d" && effectiveProjectId && (
          <ViewerErrorBoundary key={`${activeTab.id}:${reloadNonce}`} fallbackTitle="3D viewport error">
            <Suspense
              fallback={
                <div
                  className="model3d-stage"
                  style={{
                    width: "100%",
                    height: "100%",
                    background: "var(--stage-3d-bg, var(--bg-surface-subtle))",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--ink-muted)",
                    fontSize: "var(--text-sm)",
                  }}
                >
                  Loading 3D viewport...
                </div>
              }
            >
              <LazyModel3DViewer
                projectId={effectiveProjectId}
                filePath={activeTab.target}
                annotations={fileAnnotations}
                activePreset={model3dPreset}
                presetNonce={model3dPresetNonce}
                wireframe={model3dWireframe}
                focusCameraPose={focusCameraPose}
                onImportToChat={handleImportToChat}
                onUserOrbit={() => setModel3dPreset("")}
              />
            </Suspense>
          </ViewerErrorBoundary>
        )}

        {activeTab?.kind === "code" && effectiveProjectId && (
          <CodeViewer
            key={`${activeTab.id}:${reloadNonce}`}
            projectId={effectiveProjectId}
            agentId={activeAgentId}
            filePath={activeTab.target}
          />
        )}

        {activeTab?.kind === "diff" && <DiffViewer gitDiff={gitDiff} onRefreshDiff={onRefreshContext} />}

        {activeTab?.kind === "web" && <WebViewer key={`${activeTab.id}:${reloadNonce}`} url={activeTab.target} />}

        {activeTab && !effectiveProjectId && activeTab.kind !== "diff" && activeTab.kind !== "web" && (
          <div
            className="iab-error-banner"
            style={{
              margin: 16,
              padding: "10px 14px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--status-warning-border)",
              background: "var(--status-warning-bg)",
              color: "var(--status-warning-ink)",
              fontSize: "var(--text-sm)",
            }}
          >
            No project selected — unable to load workspace file.
          </div>
        )}
      </div>
    </div>
  );
}
