import { useEffect, useRef, useState, type JSX } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { AnnotationAnchor, AnnotationRecord } from "@bot-factory/shared";
import type { CameraPose, Model3DPreset } from "./types";

export interface Model3DViewerProps {
  projectId: string;
  filePath: string;
  annotate: boolean;
  annotations: AnnotationRecord[];
  activePreset: Model3DPreset | "";
  presetNonce: number;
  wireframe: boolean;
  focusCameraPose: CameraPose | null;
  onPickAnchor: (anchor: AnnotationAnchor, snapshotDataUrl?: string) => void;
  onUserOrbit?: () => void;
}

const DEFAULT_MODEL_BOUNDS = {
  center: new THREE.Vector3(0, 1.05, 0),
  dist: 6.4,
};

function computePresetPose(
  preset: Model3DPreset,
  center: THREE.Vector3,
  dist: number,
): CameraPose {
  switch (preset) {
    case "Iso":
      return {
        pos: [center.x + dist * 0.72, center.y + dist * 0.56, center.z + dist * 0.88],
        target: [center.x, center.y, center.z],
      };
    case "Front":
      return {
        pos: [center.x, center.y + dist * 0.12, center.z + dist],
        target: [center.x, center.y, center.z],
      };
    case "Top":
      return {
        pos: [center.x + 0.001, center.y + dist * 1.18, center.z + 0.001],
        target: [center.x, center.y, center.z],
      };
  }
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

function applyWireframeToGroup(group: THREE.Group, enabled: boolean): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if ("wireframe" in mat) {
        (mat as THREE.MeshStandardMaterial).wireframe = enabled;
        mat.needsUpdate = true;
      }
    }
  });
}

export function Model3DViewer({
  projectId,
  filePath,
  annotate,
  annotations,
  activePreset,
  presetNonce,
  wireframe,
  focusCameraPose,
  onPickAnchor,
  onUserOrbit,
}: Model3DViewerProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const annotateRef = useRef(annotate);
  const wireframeRef = useRef(wireframe);
  const onPickRef = useRef(onPickAnchor);
  const onUserOrbitRef = useRef(onUserOrbit);

  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const pinsGroupRef = useRef<THREE.Group | null>(null);
  const boundsRef = useRef<{ center: THREE.Vector3; dist: number }>({
    center: DEFAULT_MODEL_BOUNDS.center.clone(),
    dist: DEFAULT_MODEL_BOUNDS.dist,
  });
  const pinAssetsRef = useRef<{
    geo: THREE.SphereGeometry;
    openMat: THREE.MeshBasicMaterial;
    approvedMat: THREE.MeshBasicMaterial;
  } | null>(null);
  const requestRenderRef = useRef<((withDamping?: boolean) => void) | null>(null);
  const programmaticCameraRef = useRef(false);

  const [loadStatus, setLoadStatus] = useState("Loading 3D asset...");

  annotateRef.current = annotate;
  wireframeRef.current = wireframe;
  onPickRef.current = onPickAnchor;
  onUserOrbitRef.current = onUserOrbit;

  const artifactUrl = `/api/projects/${encodeURIComponent(projectId)}/artifact?path=${encodeURIComponent(filePath)}`;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f5f5);

    const width = Math.max(host.clientWidth, 320);
    const height = Math.max(host.clientHeight, 320);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 200);
    const initialPose = computePresetPose("Iso", DEFAULT_MODEL_BOUNDS.center, DEFAULT_MODEL_BOUNDS.dist);
    camera.position.set(...initialPose.pos);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    host.innerHTML = "";
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(...initialPose.target);
    controlsRef.current = controls;

    // Light Museum neutral gallery studio lighting
    scene.add(new THREE.HemisphereLight(0xffffff, 0xe4e4e8, 1.15));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.25);
    keyLight.position.set(4.5, 7.5, 5.5);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xf0f4f8, 0.55);
    fillLight.position.set(-4, 4, -3);
    scene.add(fillLight);

    const grid = new THREE.GridHelper(10, 20, 0xd4d4dc, 0xe8e8ec);
    scene.add(grid);

    const modelGroup = new THREE.Group();
    scene.add(modelGroup);
    modelGroupRef.current = modelGroup;

    const pinsGroup = new THREE.Group();
    scene.add(pinsGroup);
    pinsGroupRef.current = pinsGroup;

    // Burnt-orange (#D95D22) surface pins for active annotations, muted green for approved
    const pinGeo = new THREE.SphereGeometry(0.068, 16, 16);
    const openMat = new THREE.MeshBasicMaterial({ color: 0xd95d22, depthTest: false });
    const approvedMat = new THREE.MeshBasicMaterial({ color: 0x165e3d, depthTest: false });
    pinAssetsRef.current = { geo: pinGeo, openMat, approvedMat };

    // Demand-driven rendering: zero rAF cycles while idle, smooth damping when interacting
    let rafId = 0;
    let needsRender = false;
    let dampingFramesRemaining = 0;
    let inRenderFrame = false;
    const prevPos = new THREE.Vector3();
    const prevTarget = new THREE.Vector3();

    const scheduleRaf = () => {
      if (cancelled || rafId !== 0) return;
      rafId = requestAnimationFrame(renderFrame);
    };

    const renderFrame = () => {
      rafId = 0;
      if (cancelled) return;
      needsRender = false;

      prevPos.copy(camera.position);
      prevTarget.copy(controls.target);
      inRenderFrame = true;
      controls.update();
      inRenderFrame = false;

      renderer.render(scene, camera);

      const moved =
        prevPos.distanceToSquared(camera.position) > 1e-7 ||
        prevTarget.distanceToSquared(controls.target) > 1e-7;

      if (needsRender) {
        scheduleRaf();
      } else if (moved && dampingFramesRemaining > 0) {
        dampingFramesRemaining -= 1;
        scheduleRaf();
      } else {
        dampingFramesRemaining = 0;
      }
    };

    const requestRender = (withDamping = false) => {
      if (cancelled) return;
      needsRender = true;
      if (withDamping) {
        dampingFramesRemaining = 45;
      }
      scheduleRaf();
    };
    requestRenderRef.current = requestRender;

    const handleControlsChange = () => {
      if (inRenderFrame) return;
      if (!programmaticCameraRef.current) {
        onUserOrbitRef.current?.();
      }
      requestRender(true);
    };
    controls.addEventListener("change", handleControlsChange);

    // Load GLB/GLTF asset with clean fallback monolith on failure
    boundsRef.current = {
      center: DEFAULT_MODEL_BOUNDS.center.clone(),
      dist: DEFAULT_MODEL_BOUNDS.dist,
    };

    const loader = new GLTFLoader();
    loader.load(
      artifactUrl,
      (gltf) => {
        if (cancelled) {
          disposeObjectTree(gltf.scene);
          return;
        }
        modelGroup.add(gltf.scene);
        if (wireframeRef.current) {
          applyWireframeToGroup(modelGroup, true);
        }
        const box = new THREE.Box3().setFromObject(gltf.scene);
        if (!box.isEmpty()) {
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z, 1);
          const dist = maxDim * 2.15;
          boundsRef.current = { center: center.clone(), dist };
          const pose = computePresetPose("Iso", center, dist);
          programmaticCameraRef.current = true;
          camera.position.set(...pose.pos);
          controls.target.set(...pose.target);
          controls.update();
          programmaticCameraRef.current = false;
        }
        setLoadStatus(`GLB loaded (${filePath})`);
        requestRender(false);
      },
      undefined,
      () => {
        if (cancelled) return;
        const fallback = new THREE.Mesh(
          new THREE.BoxGeometry(1.2, 1.8, 1.2),
          new THREE.MeshStandardMaterial({
            color: 0x525252,
            metalness: 0.15,
            roughness: 0.55,
            wireframe: wireframeRef.current,
          }),
        );
        fallback.name = "FallbackMonolith";
        fallback.position.y = 0.9;
        modelGroup.add(fallback);
        boundsRef.current = {
          center: new THREE.Vector3(0, 0.9, 0),
          dist: 5.2,
        };
        setLoadStatus("Fallback mesh active (GLB unavailable)");
        requestRender(false);
      },
    );

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downPos: { x: number; y: number } | null = null;

    const handlePointerDown = (ev: PointerEvent) => {
      downPos = { x: ev.clientX, y: ev.clientY };
    };

    const handlePointerUp = () => {
      requestRender(true);
    };

    const handleClick = (ev: MouseEvent) => {
      if (!annotateRef.current) return;
      if (downPos) {
        const moved = Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y);
        if (moved > 6) return;
      }
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(modelGroup.children, true);
      if (hits.length === 0) return;

      const hit = hits[0]!;
      const normal = hit.face?.normal
        ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
        : new THREE.Vector3(0, 1, 0);

      // Synchronous render immediately prior to PNG capture
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

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("click", handleClick);

    const resizeObserver = new ResizeObserver(() => {
      const w = Math.max(host.clientWidth, 320);
      const h = Math.max(host.clientHeight, 320);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      requestRender(false);
    });
    resizeObserver.observe(host);

    // Initial render
    requestRender(false);

    return () => {
      cancelled = true;
      if (rafId !== 0) cancelAnimationFrame(rafId);
      requestRenderRef.current = null;
      resizeObserver.disconnect();
      controls.removeEventListener("change", handleControlsChange);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("click", handleClick);
      controls.dispose();
      disposeObjectTree(scene);
      pinGeo.dispose();
      openMat.dispose();
      approvedMat.dispose();
      pinAssetsRef.current = null;
      pinsGroupRef.current = null;
      modelGroupRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      renderer.dispose();
      renderer.forceContextLoss();
    };
  }, [artifactUrl, filePath]);

  // Sync 3D annotation pin spheres & request demand render
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
      const mat = ann.status === "approved" ? assets.approvedMat : assets.openMat;
      const pin = new THREE.Mesh(assets.geo, mat);
      pin.position.set(px + nx * 0.08, py + ny * 0.08, pz + nz * 0.08);
      pin.renderOrder = 999;
      group.add(pin);
    }
    requestRenderRef.current?.(false);
  }, [annotations, artifactUrl]);

  // Apply wireframe mode toggle
  useEffect(() => {
    const modelGroup = modelGroupRef.current;
    if (!modelGroup) return;
    applyWireframeToGroup(modelGroup, wireframe);
    requestRenderRef.current?.(false);
  }, [wireframe]);

  // Apply camera preset from Row 2 chrome toolbar
  useEffect(() => {
    if (!activePreset || !cameraRef.current || !controlsRef.current) return;
    const { center, dist } = boundsRef.current;
    const pose = computePresetPose(activePreset, center, dist);
    programmaticCameraRef.current = true;
    cameraRef.current.position.set(...pose.pos);
    controlsRef.current.target.set(...pose.target);
    controlsRef.current.update();
    programmaticCameraRef.current = false;
    requestRenderRef.current?.(false);
  }, [activePreset, presetNonce]);

  // Restore saved pin camera pose when jumping to a pin
  useEffect(() => {
    if (!focusCameraPose || !cameraRef.current || !controlsRef.current) return;
    programmaticCameraRef.current = true;
    cameraRef.current.position.set(...focusCameraPose.pos);
    controlsRef.current.target.set(...focusCameraPose.target);
    controlsRef.current.update();
    programmaticCameraRef.current = false;
    requestRenderRef.current?.(false);
  }, [focusCameraPose]);

  return (
    <div
      className="model3d-stage iab-3d-stage"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 320,
        background: "#F5F5F5",
      }}
    >
      <div
        ref={hostRef}
        style={{
          width: "100%",
          height: "100%",
          cursor: annotate ? "crosshair" : "grab",
        }}
      />
      <div
        className="stage-3d-hud iab-3d-hud"
        style={{
          position: "absolute",
          left: 10,
          bottom: 10,
          fontSize: "var(--text-2xs)",
          color: annotate ? "#B84312" : "var(--ink-muted)",
          background: annotate ? "#FFF7F2" : "rgba(255,255,255,0.88)",
          border: annotate ? "1px solid #F7D5C2" : "1px solid var(--border-hairline)",
          borderRadius: "var(--radius-pill)",
          padding: "3px 10px",
          pointerEvents: "none",
        }}
      >
        {loadStatus} ·{" "}
        {annotate ? "Annotate: click 3D surface to drop pin + snapshot" : "Navigate: drag to orbit, scroll to zoom"}
      </div>
    </div>
  );
}

export default Model3DViewer;
