import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { HubConfig } from "@bot-factory/shared";
import { SecretScrubber } from "../config";
import type {
  AgentRuntime,
  NormalizedAgentEvent,
  ReasoningEffort,
  RuntimeSessionHandle,
  RuntimeSessionSpec,
  ToolDefinition,
  TurnInput,
} from "./types";

interface ActiveNativeSession {
  spec: RuntimeSessionSpec;
  abortController: AbortController | null;
}

type ExtendedProviderConfig = Omit<HubConfig["providers"][string], "protocol" | "runtime"> & {
  runtime: string;
  protocol?: "openai_compatible" | "google_gemini" | "anthropic";
  embeddingModel?: string;
};

const DEFAULT_MAX_TOOL_STEPS = 12;
const MAX_TOOL_OUTPUT_CONTEXT_CHARS = 12_000;
const STALE_TOOL_OUTPUT_AGE_STEPS = 3;
const STALE_TOOL_OUTPUT_COMPACT_MIN_CHARS = 400;
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 120_000;
const DOOM_LOOP_REPEAT_THRESHOLD = 3;
const CONSECUTIVE_ERROR_STEP_THRESHOLD = 3;

const GEMINI_THINKING_BUDGET: Record<ReasoningEffort, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
  max: 32768,
};

function stripWinExtendedPrefix(p: string): string {
  if (process.platform === "win32" && p.startsWith("\\\\?\\")) {
    if (p.startsWith("\\\\?\\UNC\\")) return p;
    return p.slice(4);
  }
  return p;
}

function lexicalWithinRoot(absRoot: string, absTarget: string): boolean {
  const normRoot = process.platform === "win32" ? absRoot.toLowerCase() : absRoot;
  const normTarget = process.platform === "win32" ? absTarget.toLowerCase() : absTarget;
  const rootPrefix = normRoot.endsWith(sep) ? normRoot : `${normRoot}${sep}`;
  const sameDrive = parse(normTarget).root === parse(normRoot).root;
  return sameDrive && (normTarget === normRoot || normTarget.startsWith(rootPrefix));
}

function normalizeTargetToRealRoot(target: string, realRoot: string, logicalRoot: string): string {
  if (lexicalWithinRoot(realRoot, target)) return target;
  if (logicalRoot !== realRoot && lexicalWithinRoot(logicalRoot, target)) {
    return join(realRoot, relative(logicalRoot, target));
  }
  return target;
}

function resolveSymlinkStep(
  realRoot: string,
  current: string,
  depth: number,
  logicalRoot = realRoot,
): { exists: boolean; escaped: boolean; resolvedPath: string } {
  let st;
  try {
    st = lstatSync(current);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { exists: false, escaped: false, resolvedPath: current };
    }
    return { exists: false, escaped: true, resolvedPath: current };
  }

  if (!st.isSymbolicLink()) {
    return { exists: true, escaped: false, resolvedPath: current };
  }

  try {
    const resolved = stripWinExtendedPrefix(realpathSync(current));
    return {
      exists: true,
      escaped: !lexicalWithinRoot(realRoot, resolved),
      resolvedPath: resolved,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      return { exists: true, escaped: true, resolvedPath: current };
    }
  }

  // Dangling symlink: realpathSync threw ENOENT, so resolve link target directly via readlinkSync.
  let rawLink: string;
  try {
    rawLink = stripWinExtendedPrefix(readlinkSync(current));
  } catch {
    return { exists: true, escaped: true, resolvedPath: current };
  }
  if (!rawLink || rawLink.includes("\0") || rawLink.startsWith("\\\\") || rawLink.startsWith("//")) {
    return { exists: true, escaped: true, resolvedPath: current };
  }
  const rawAbsLinkTarget = resolve(dirname(current), rawLink);
  const absLinkTarget = normalizeTargetToRealRoot(rawAbsLinkTarget, realRoot, logicalRoot);
  if (!lexicalWithinRoot(realRoot, absLinkTarget)) {
    return { exists: true, escaped: true, resolvedPath: absLinkTarget };
  }
  if (!checkSegmentsWithinRealRoot(realRoot, realRoot, relative(realRoot, absLinkTarget), depth + 1, logicalRoot)) {
    return { exists: true, escaped: true, resolvedPath: absLinkTarget };
  }
  return { exists: true, escaped: false, resolvedPath: absLinkTarget };
}

function checkSegmentsWithinRealRoot(
  realRoot: string,
  baseStart: string,
  relFromRoot: string,
  depth: number,
  logicalRoot = realRoot,
): boolean {
  if (depth > 16) return false;
  if (!relFromRoot || relFromRoot === ".") return true;

  const segments = relFromRoot.split(sep).filter((s) => s.length > 0 && s !== ".");
  let current = baseStart;

  for (const seg of segments) {
    if (seg === "..") return false;
    current = join(current, seg);
    const step = resolveSymlinkStep(realRoot, current, depth, logicalRoot);
    if (step.escaped) return false;
    if (!step.exists) return true;
    current = step.resolvedPath;
  }

  return true;
}

function checkRawRelativeSegmentsWithinRealRoot(realRoot: string, candidatePath: string, logicalRoot = realRoot): boolean {
  if (isAbsolute(candidatePath)) return true;
  const rawParts = candidatePath.split(/[\\/]+/).filter(Boolean);
  if (!rawParts.includes("..")) return true;

  let current = realRoot;
  let missingPrefix = false;
  for (const seg of rawParts) {
    if (seg === ".") continue;
    if (seg === "..") {
      current = dirname(current);
      if (!lexicalWithinRoot(realRoot, current)) {
        return false;
      }
      // If we climbed back into an existing directory, re-enable lstat checks for subsequent segments.
      if (missingPrefix && existsSync(current)) missingPrefix = false;
      continue;
    }
    current = join(current, seg);
    if (missingPrefix) continue;
    const step = resolveSymlinkStep(realRoot, current, 0, logicalRoot);
    if (step.escaped) return false;
    if (!step.exists) {
      missingPrefix = true;
      continue;
    }
    current = step.resolvedPath;
  }
  return true;
}

export function isPathStrictlyWithinRoot(rootDir: string, candidatePath: string): { ok: boolean; absTarget: string } {
  if (!candidatePath || candidatePath.includes("\0") || candidatePath.startsWith("\\\\") || candidatePath.startsWith("//")) {
    return { ok: false, absTarget: "" };
  }
  const absRoot = resolve(rootDir);
  const absTarget = resolve(absRoot, candidatePath);
  if (!lexicalWithinRoot(absRoot, absTarget)) {
    return { ok: false, absTarget };
  }
  // Guard against symlinks / dangling symlinks / Windows reparse points escaping rootDir
  try {
    try {
      lstatSync(absRoot);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        return { ok: true, absTarget };
      }
      return { ok: false, absTarget };
    }
    const realRoot = stripWinExtendedPrefix(realpathSync(absRoot));
    if (!checkRawRelativeSegmentsWithinRealRoot(realRoot, candidatePath, absRoot)) {
      return { ok: false, absTarget };
    }
    const relFromRoot = relative(absRoot, absTarget);
    if (!checkSegmentsWithinRealRoot(realRoot, realRoot, relFromRoot, 0, absRoot)) {
      return { ok: false, absTarget };
    }
  } catch {
    return { ok: false, absTarget };
  }
  return { ok: true, absTarget };
}

export function resolveSafeWorktreePath(cwd: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new Error(`worktree_boundary_violation: absolute path '${relPath}' not allowed`);
  }
  const check = isPathStrictlyWithinRoot(cwd, relPath);
  if (!check.ok) {
    throw new Error(`worktree_boundary_violation: '${relPath}' escapes '${cwd}'`);
  }
  return check.absTarget;
}

function parseDataUrl(dataUrl: string | null | undefined): { mimeType: string; data: string } | null {
  if (!dataUrl || !dataUrl.startsWith("data:")) return null;
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match || !match[1] || !match[2]) return null;
  return { mimeType: match[1], data: match[2] };
}

function normalizeVector(raw: number[]): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  let normSq = 0;
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    normSq += v * v;
  }
  if (normSq <= 0) return null;
  const invNorm = 1 / Math.sqrt(normSq);
  return raw.map((v) => v * invNorm);
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (seen.has(value as object)) return '"[Circular]"';
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], seen)}`);
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value as object);
  }
}

export function boundToolOutputForContext(output: string, maxChars = MAX_TOOL_OUTPUT_CONTEXT_CHARS): string {
  if (maxChars <= 0) return "";
  if (output.length <= maxChars) return output;
  if (maxChars < 160) return output.slice(0, maxChars);

  const roughOmitted = output.length - maxChars;
  const marker = `\n\n... [truncated ${roughOmitted} chars of ${output.length} total] ...\n\n`;
  const remaining = Math.max(0, maxChars - marker.length);
  const headLen = Math.ceil(remaining * 0.6);
  const tailLen = Math.max(0, remaining - headLen);
  const omitted = output.length - headLen - tailLen;
  const exactMarker = `\n\n... [truncated ${omitted} chars of ${output.length} total] ...\n\n`;
  if (headLen + tailLen + exactMarker.length > maxChars) {
    const adjHead = Math.max(0, maxChars - exactMarker.length - tailLen);
    return `${output.slice(0, adjHead)}${exactMarker}${tailLen > 0 ? output.slice(output.length - tailLen) : ""}`;
  }
  return `${output.slice(0, headLen)}${exactMarker}${tailLen > 0 ? output.slice(output.length - tailLen) : ""}`;
}

interface StaleToolEntry {
  step: number;
  compacted: boolean;
  compact: () => void;
}

function compactStaleToolOutputs(entries: StaleToolEntry[], currentStep: number): void {
  for (const entry of entries) {
    if (!entry.compacted && currentStep - entry.step > STALE_TOOL_OUTPUT_AGE_STEPS) {
      entry.compacted = true;
      entry.compact();
    }
  }
}

function createToolLoopTracker() {
  const signatureCounts = new Map<string, number>();
  let consecutiveErrorSteps = 0;

  return {
    evaluateBatch(calls: Array<{ id: string; name: string; args: Record<string, unknown>; parseError?: string }>): {
      blockedCallIds: Map<string, string>;
      trippedReason: string | null;
    } {
      const blockedCallIds = new Map<string, string>();
      let trippedReason: string | null = null;
      for (const call of calls) {
        const sig = call.parseError ? `${call.name}::PARSE_ERROR` : `${call.name}::${stableStringify(call.args)}`;
        const count = (signatureCounts.get(sig) ?? 0) + 1;
        signatureCounts.set(sig, count);
        if (count >= DOOM_LOOP_REPEAT_THRESHOLD) {
          const msg = `[Loop Breaker] Blocked repeated identical call to '${call.name}' (${count}x with identical arguments). Do not repeat this call; summarize your progress or choose a genuinely different action.`;
          blockedCallIds.set(call.id, msg);
          if (!trippedReason) trippedReason = msg;
        }
      }
      return { blockedCallIds, trippedReason };
    },
    recordStepOutcomes(results: Array<{ isError: boolean }>): string | null {
      if (results.length > 0 && results.every((r) => r.isError)) {
        consecutiveErrorSteps += 1;
        if (consecutiveErrorSteps >= CONSECUTIVE_ERROR_STEP_THRESHOLD) {
          return `[Loop Breaker] ${consecutiveErrorSteps} consecutive tool steps failed. Stop calling tools and summarize the blocker clearly for the user.`;
        }
      } else if (results.some((r) => !r.isError)) {
        consecutiveErrorSteps = 0;
      }
      return null;
    },
  };
}

function createPerRequestSignal(
  callerSignal: AbortSignal,
  timeoutMs = DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerSignal.reason);
  if (callerSignal.aborted) {
    controller.abort(callerSignal.reason);
  } else {
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(new Error(`HTTP request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", onCallerAbort);
    },
  };
}

export function buildOpenAiMessages(
  frozenSystemPrompt: string,
  history: TurnInput["history"],
  apiUserText: string,
  imageDataUrl?: string | null,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: frozenSystemPrompt }];
  for (const m of history) {
    if (!m.content) continue;
    if (m.role === "system") {
      messages.push({ role: "user", content: `[Session Compaction Summary]\n${m.content}` });
      messages.push({ role: "assistant", content: "Acknowledged compacted session context." });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  const userContent = imageDataUrl
    ? [
        { type: "text", text: apiUserText },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ]
    : apiUserText;
  messages.push({ role: "user", content: userContent });
  return messages;
}

export function buildGeminiContents(
  history: TurnInput["history"],
  apiUserText: string,
  imageDataUrl?: string | null,
): Array<{ role: string; parts: Array<Record<string, unknown>> }> {
  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
  const pushTextTurn = (role: "user" | "model", text: string) => {
    if (!text) return;
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) {
      prev.parts.push({ text });
    } else {
      contents.push({ role, parts: [{ text }] });
    }
  };

  for (const m of history) {
    if (!m.content) continue;
    if (m.role === "system") {
      pushTextTurn("user", `[Session Compaction Summary]\n${m.content}`);
      pushTextTurn("model", "Acknowledged compacted session context.");
    } else if (m.role === "assistant") {
      pushTextTurn("model", m.content);
    } else {
      pushTextTurn("user", m.content);
    }
  }

  if (contents.length > 0 && contents[0]?.role === "model") {
    contents.unshift({ role: "user", parts: [{ text: "(continued session)" }] });
  }

  const userParts: Array<Record<string, unknown>> = [{ text: apiUserText }];
  const img = parseDataUrl(imageDataUrl);
  if (img) {
    userParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
  }
  const prev = contents[contents.length - 1];
  if (prev && prev.role === "user") {
    prev.parts.push(...userParts);
  } else {
    contents.push({ role: "user", parts: userParts });
  }
  return contents;
}

export function buildAnthropicMessages(
  history: TurnInput["history"],
  apiUserText: string,
  imageDataUrl?: string | null,
): Array<Record<string, unknown>> {
  const normalized: Array<{ role: "user" | "assistant"; content: string }> = [];
  const pushTextMsg = (role: "user" | "assistant", text: string) => {
    if (!text) return;
    const prev = normalized[normalized.length - 1];
    if (prev && prev.role === role) {
      prev.content = `${prev.content}\n\n${text}`;
    } else {
      normalized.push({ role, content: text });
    }
  };

  for (const m of history) {
    if (!m.content) continue;
    if (m.role === "system") {
      pushTextMsg("user", `[Session Compaction Summary]\n${m.content}`);
      pushTextMsg("assistant", "Acknowledged compacted session context.");
    } else if (m.role === "assistant") {
      pushTextMsg("assistant", m.content);
    } else {
      pushTextMsg("user", m.content);
    }
  }

  if (normalized.length > 0 && normalized[0]?.role === "assistant") {
    normalized.unshift({ role: "user", content: "(continued session)" });
  }

  const messages: Array<Record<string, unknown>> = normalized.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const img = parseDataUrl(imageDataUrl);
  const prev = messages[messages.length - 1];
  if (prev && prev.role === "user") {
    const prevText = typeof prev.content === "string" ? prev.content : "";
    if (img) {
      prev.content = [
        ...(prevText ? [{ type: "text", text: prevText }] : []),
        { type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } },
        { type: "text", text: apiUserText },
      ];
    } else {
      prev.content = prevText ? `${prevText}\n\n${apiUserText}` : apiUserText;
    }
  } else {
    const currentUserContent = img
      ? [
          { type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } },
          { type: "text", text: apiUserText },
        ]
      : apiUserText;
    messages.push({ role: "user", content: currentUserContent });
  }
  return messages;
}

function formatToolTitle(name: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return `${name}()`;
  const preview = keys
    .slice(0, 2)
    .map((k) => {
      const v = args[k];
      const raw = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${raw && raw.length > 32 ? `${raw.slice(0, 32)}…` : raw}`;
    })
    .join(", ");
  return `${name}(${preview})`;
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: string | undefined;
  let dataLines: string[] = [];

  const flushEvent = () => {
    if (dataLines.length === 0) {
      currentEvent = undefined;
      return null;
    }
    const payload = { event: currentEvent, data: dataLines.join("\n") };
    currentEvent = undefined;
    dataLines = [];
    return payload;
  };

  let rejectAbortRef: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    const rejectAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("HTTP stream aborted"));
    };
    rejectAbortRef = rejectAbort;
    if (signal.aborted) {
      rejectAbort();
    } else {
      signal.addEventListener("abort", rejectAbort, { once: true });
    }
  });
  // Prevent unhandled rejection if stream completes normally before abort fires
  abortPromise.catch(() => {});

  try {
    while (!signal.aborted) {
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const rawLine = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line === "") {
          const evt = flushEvent();
          if (evt) yield evt;
        } else if (line.startsWith(":")) {
          // SSE comment keepalive
        } else if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
        nl = buffer.indexOf("\n");
      }
    }

    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("HTTP stream aborted");
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const rawLine of buffer.split(/\r?\n/)) {
        if (rawLine.startsWith("event:")) {
          currentEvent = rawLine.slice(6).trim();
        } else if (rawLine.startsWith("data:")) {
          dataLines.push(rawLine.slice(5).trimStart());
        }
      }
    }
    const tail = flushEvent();
    if (tail) yield tail;
  } finally {
    if (rejectAbortRef) {
      signal.removeEventListener("abort", rejectAbortRef);
    }
    try {
      await reader.cancel();
    } catch {
      // ignore reader cancel failure
    }
  }
}

async function* iterSseOrJson(
  res: Response,
  signal: AbortSignal,
): AsyncGenerator<{ kind: "sse"; event?: string; data: string } | { kind: "json"; data: unknown }> {
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/event-stream") && res.body) {
    for await (const evt of parseSseStream(res.body, signal)) {
      yield { kind: "sse", ...evt };
    }
    return;
  }
  if (contentType.includes("application/json")) {
    yield { kind: "json", data: await res.json() };
    return;
  }
  const rawText = await res.text();
  const trimmed = rawText.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    yield { kind: "json", data: JSON.parse(rawText) };
    return;
  }
  let currentEvent: string | undefined;
  let dataLines: string[] = [];
  for (const rawLine of rawText.split(/\r?\n/)) {
    if (rawLine === "") {
      if (dataLines.length > 0) {
        yield { kind: "sse", event: currentEvent, data: dataLines.join("\n") };
        currentEvent = undefined;
        dataLines = [];
      }
    } else if (rawLine.startsWith("event:")) {
      currentEvent = rawLine.slice(6).trim();
    } else if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5).trimStart());
    }
  }
  if (dataLines.length > 0) {
    yield { kind: "sse", event: currentEvent, data: dataLines.join("\n") };
  }
}

export class NativeHttpRuntime implements AgentRuntime {
  public readonly kind = "native_http" as const;
  private readonly sessions = new Map<string, ActiveNativeSession>();

  constructor(
    private config: HubConfig,
    private secrets: Record<string, string>,
    private readonly scrubber: SecretScrubber,
    private readonly opts?: { requestTimeoutMs?: number },
  ) {}

  public setConfig(newConfig: HubConfig): void {
    this.config = newConfig;
  }

  public updateSecrets(secrets: Record<string, string>): void {
    this.secrets = { ...secrets };
  }

  public async startSession(spec: RuntimeSessionSpec): Promise<RuntimeSessionHandle> {
    this.sessions.set(spec.sessionId, { spec, abortController: null });
    return {
      sessionId: spec.sessionId,
      agentId: spec.agentId,
      runtimeKind: "native_http",
      pid: null,
    };
  }

  public async *sendTurn(handle: RuntimeSessionHandle, input: TurnInput): AsyncIterable<NormalizedAgentEvent> {
    const active = this.sessions.get(handle.sessionId);
    if (!active) {
      yield { type: "error", message: `Session not found: ${handle.sessionId}` };
      return;
    }

    const providerCfg = this.config.providers[active.spec.provider] as ExtendedProviderConfig | undefined;
    const modelCfg = providerCfg?.models[active.spec.model];
    if (!providerCfg || !modelCfg) {
      yield { type: "error", message: `Unknown provider/model ${active.spec.provider}/${active.spec.model}` };
      return;
    }

    const apiKey = providerCfg.apiKeyEnv ? this.secrets[providerCfg.apiKeyEnv] : undefined;
    const controller = new AbortController();
    active.abortController = controller;

    // Hermes invariant: ephemeral per-turn context appended ONLY to the outgoing API call user message, never mutating frozen systemPrompt or persisted transcript.
    const apiUserText = input.ephemeralContext
      ? `${input.ephemeralContext}\n\n${input.userText}`
      : input.userText;

    const reasoningEffort = input.reasoningEffort ?? active.spec.reasoningEffort;
    const maxToolSteps = Math.max(0, input.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS);

    try {
      if (process.env.BOT_FACTORY_OFFLINE_MOCK === "1" || (providerCfg.apiKeyEnv && !apiKey)) {
        yield* this.runDeterministicLocalTurn(active.spec, input, controller.signal);
        return;
      }

      if (!providerCfg.baseUrl) {
        throw new Error(`Provider '${active.spec.provider}' missing baseUrl`);
      }

      if (providerCfg.protocol === "google_gemini") {
        yield* this.callGoogleGemini(
          providerCfg.baseUrl,
          modelCfg.id,
          apiKey,
          active.spec.systemPrompt,
          input.history,
          apiUserText,
          input.imageDataUrl,
          reasoningEffort,
          input.tools,
          input.onToolCall,
          maxToolSteps,
          controller.signal,
        );
      } else if (providerCfg.protocol === "anthropic") {
        yield* this.callAnthropic(
          providerCfg.baseUrl,
          modelCfg.id,
          apiKey,
          active.spec.systemPrompt,
          input.history,
          apiUserText,
          input.imageDataUrl,
          reasoningEffort,
          input.tools,
          input.onToolCall,
          maxToolSteps,
          controller.signal,
        );
      } else {
        yield* this.callOpenAiCompatible(
          providerCfg.baseUrl,
          modelCfg.id,
          apiKey,
          active.spec.systemPrompt,
          input.history,
          apiUserText,
          input.imageDataUrl,
          reasoningEffort,
          input.tools,
          input.onToolCall,
          maxToolSteps,
          controller.signal,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        yield { type: "done", finalText: "[Turn paused/aborted by operator]" };
      } else {
        yield { type: "error", message: this.scrubber.scrub(msg) };
      }
    } finally {
      active.abortController = null;
    }
  }

  public async embedText(providerName: string, modelId: string, text: string): Promise<number[] | null> {
    if (process.env.BOT_FACTORY_OFFLINE_MOCK === "1") return null;
    const providerCfg = this.config.providers[providerName] as ExtendedProviderConfig | undefined;
    if (!providerCfg || !providerCfg.baseUrl) return null;

    const apiKey = providerCfg.apiKeyEnv ? this.secrets[providerCfg.apiKeyEnv] : undefined;
    if (providerCfg.apiKeyEnv && !apiKey) return null;

    const resolvedModelId = providerCfg.models[modelId]?.id ?? modelId;
    const base = providerCfg.baseUrl.replace(/\/$/, "");

    try {
      if (providerCfg.protocol === "google_gemini") {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (apiKey) headers["x-goog-api-key"] = apiKey;
        const url = `${base}/models/${encodeURIComponent(resolvedModelId)}:embedContent`;
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: `models/${resolvedModelId}`,
            content: { parts: [{ text }] },
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { embedding?: { values?: number[] } };
        return data.embedding?.values ? normalizeVector(data.embedding.values) : null;
      }

      if (providerCfg.protocol === "anthropic") {
        return null;
      }

      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: resolvedModelId, input: text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const vec = data.data?.[0]?.embedding;
      return vec ? normalizeVector(vec) : null;
    } catch {
      return null;
    }
  }

  private async *executeToolCalls(
    calls: Array<{ id: string; name: string; args: Record<string, unknown>; parseError?: string }>,
    onToolCall: NonNullable<TurnInput["onToolCall"]>,
    blockedOutputs?: Map<string, string>,
  ): AsyncGenerator<NormalizedAgentEvent, Array<{ id: string; name: string; output: string; isError: boolean }>> {
    const results: Array<{ id: string; name: string; output: string; isError: boolean }> = [];
    for (const call of calls) {
      yield {
        type: "tool_call",
        toolCallId: call.id,
        title: formatToolTitle(call.name, call.args),
        status: "in_progress",
      };

      let output = "";
      let isError = false;
      const blocked = blockedOutputs?.get(call.id);
      if (blocked !== undefined) {
        output = this.scrubber.scrub(blocked);
        isError = true;
      } else if (call.parseError) {
        output = this.scrubber.scrub(`Invalid JSON arguments for ${call.name}: ${call.parseError}`);
        isError = true;
      } else {
        try {
          const raw = await onToolCall({ id: call.id, name: call.name, args: call.args });
          output = this.scrubber.scrub(stringifyToolOutput(raw));
        } catch (err) {
          isError = true;
          output = this.scrubber.scrub(err instanceof Error ? err.message : String(err));
        }
      }

      yield {
        type: "tool_call",
        toolCallId: call.id,
        title: call.name,
        status: isError ? "failed" : "completed",
        output,
        exitCode: isError ? 1 : 0,
      };
      yield {
        type: "tool_result",
        toolCallId: call.id,
        name: call.name,
        output,
        isError,
      };
      results.push({ id: call.id, name: call.name, output, isError });
    }
    return results;
  }

  private async *callOpenAiCompatible(
    baseUrl: string,
    modelId: string,
    apiKey: string | undefined,
    frozenSystemPrompt: string,
    history: TurnInput["history"],
    apiUserText: string,
    imageDataUrl: string | null | undefined,
    reasoningEffort: ReasoningEffort | undefined,
    tools: ToolDefinition[] | undefined,
    onToolCall: TurnInput["onToolCall"],
    maxToolSteps: number,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedAgentEvent> {
    const messages = buildOpenAiMessages(frozenSystemPrompt, history, apiUserText, imageDataUrl);

    const openAiTools =
      tools && tools.length > 0
        ? tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parametersJsonSchema,
            },
          }))
        : undefined;

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const requestTimeoutMs = this.opts?.requestTimeoutMs ?? DEFAULT_HTTP_REQUEST_TIMEOUT_MS;

    let includeStreamOptions = true;
    let includeReasoningEffort = Boolean(reasoningEffort);
    let includeToolChoiceNone = true;
    let accumulatedAllText = "";
    let forceFinalNoTools = false;
    let loopBreakerSummary: string | null = null;
    let hasToolHistoryInTurn = false;
    const loopTracker = createToolLoopTracker();
    const staleToolEntries: StaleToolEntry[] = [];

    for (let step = 0; step <= maxToolSteps; step++) {
      compactStaleToolOutputs(staleToolEntries, step);
      const mustDisableTools = forceFinalNoTools || step >= maxToolSteps;
      const canOfferTools = Boolean(openAiTools && onToolCall && !mustDisableTools);
      const reqSig = createPerRequestSignal(signal, requestTimeoutMs);

      try {
        let res: Response | null = null;

        for (let attempt = 0; attempt < 4; attempt++) {
          const body: Record<string, unknown> = {
            model: modelId,
            messages,
            temperature: 0.3,
            stream: true,
          };
          if (includeStreamOptions) {
            body.stream_options = { include_usage: true };
          }
          if (includeReasoningEffort && reasoningEffort) {
            body.reasoning_effort = reasoningEffort === "max" ? "high" : reasoningEffort;
          }
          if (openAiTools && onToolCall) {
            if (canOfferTools) {
              body.tools = openAiTools;
            } else if (hasToolHistoryInTurn) {
              body.tools = openAiTools;
              if (includeToolChoiceNone) {
                body.tool_choice = "none";
              }
            }
          }

          res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: reqSig.signal,
          });
          if (res.ok) break;

          const errText = await res.text();
          if ((res.status === 400 || res.status === 422) && attempt < 3) {
            let retried = false;
            if (includeReasoningEffort && /reasoning_effort|extra_forbidden|unrecognized|unknown/i.test(errText)) {
              includeReasoningEffort = false;
              retried = true;
            }
            if (includeStreamOptions && /stream_options|extra_forbidden|unrecognized|unknown/i.test(errText)) {
              includeStreamOptions = false;
              retried = true;
            }
            if (includeToolChoiceNone && !canOfferTools && /tool_choice/i.test(errText)) {
              includeToolChoiceNone = false;
              retried = true;
            }
            if (retried) continue;
          }
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 400)}`);
        }

        if (!res || !res.ok) {
          throw new Error("HTTP request failed");
        }

        let stepText = "";
        let stepHasText = false;
        let stepUsage: { tokenIn: number; tokenOut: number } | null = null;
        const toolCallsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
        let orderedToolCalls: Array<{ id: string; name: string; arguments: string }> = [];

        const appendStepText = (clean: string): string | null => {
          let sepText: string | null = null;
          if (!stepHasText) {
            stepHasText = true;
            if (accumulatedAllText.length > 0 && !accumulatedAllText.endsWith("\n")) {
              accumulatedAllText += "\n\n";
              sepText = "\n\n";
            }
          }
          stepText += clean;
          accumulatedAllText += clean;
          return sepText;
        };

        for await (const item of iterSseOrJson(res, reqSig.signal)) {
          if (item.kind === "sse") {
            if (item.data === "[DONE]") break;
            let chunk: {
              error?: { message?: string };
              choices?: Array<{
                delta?: {
                  content?: string | null;
                  reasoning_content?: string | null;
                  reasoning?: string | null;
                  thinking?: string | null;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                message?: {
                  content?: string | null;
                  reasoning_content?: string | null;
                  reasoning?: string | null;
                  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
                };
              }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            try {
              chunk = JSON.parse(item.data);
            } catch {
              continue;
            }

            if (chunk.error) {
              throw new Error(chunk.error.message || JSON.stringify(chunk.error));
            }
            if (chunk.usage) {
              stepUsage = {
                tokenIn: chunk.usage.prompt_tokens ?? 0,
                tokenOut: chunk.usage.completion_tokens ?? 0,
              };
            }
            const choice = chunk.choices?.[0];
            const delta = choice?.delta;
            if (delta) {
              const thoughtPart = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
              if (thoughtPart) {
                yield { type: "thought", text: this.scrubber.scrub(thoughtPart) };
              }
              if (delta.content) {
                const clean = this.scrubber.scrub(delta.content);
                const sep = appendStepText(clean);
                if (sep) yield { type: "text_delta", text: sep };
                yield { type: "text_delta", text: clean };
              }
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  const prev = toolCallsByIndex.get(idx) ?? {
                    id: tc.id ?? `call_${crypto.randomUUID().slice(0, 8)}`,
                    name: "",
                    arguments: "",
                  };
                  if (tc.id) prev.id = tc.id;
                  if (tc.function?.name) prev.name += tc.function.name;
                  if (tc.function?.arguments) prev.arguments += tc.function.arguments;
                  toolCallsByIndex.set(idx, prev);
                }
              }
            } else if (choice?.message) {
              const thoughtPart = choice.message.reasoning_content ?? choice.message.reasoning;
              if (thoughtPart) {
                yield { type: "thought", text: this.scrubber.scrub(thoughtPart) };
              }
              if (choice.message.content) {
                const clean = this.scrubber.scrub(choice.message.content);
                const sep = appendStepText(clean);
                if (sep) yield { type: "text_delta", text: sep };
                yield { type: "text_delta", text: clean };
              }
              if (Array.isArray(choice.message.tool_calls)) {
                choice.message.tool_calls.forEach((tc, idx) => {
                  toolCallsByIndex.set(idx, {
                    id: tc.id ?? `call_${crypto.randomUUID().slice(0, 8)}`,
                    name: tc.function?.name ?? "",
                    arguments: tc.function?.arguments ?? "{}",
                  });
                });
              }
            }
          } else {
            const data = item.data as {
              choices?: Array<{
                message?: {
                  content?: string | null;
                  reasoning_content?: string | null;
                  reasoning?: string | null;
                  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
                };
              }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            const msg = data.choices?.[0]?.message;
            const thoughtText = msg?.reasoning_content ?? msg?.reasoning;
            if (thoughtText) {
              yield { type: "thought", text: this.scrubber.scrub(thoughtText) };
            }
            if (msg?.content) {
              const clean = this.scrubber.scrub(msg.content);
              const sep = appendStepText(clean);
              if (sep) yield { type: "text_delta", text: sep };
              yield { type: "text_delta", text: clean };
            }
            if (Array.isArray(msg?.tool_calls)) {
              msg.tool_calls.forEach((tc, idx) => {
                toolCallsByIndex.set(idx, {
                  id: tc.id ?? `call_${crypto.randomUUID().slice(0, 8)}`,
                  name: tc.function?.name ?? "",
                  arguments: tc.function?.arguments ?? "{}",
                });
              });
            }
            if (data.usage) {
              stepUsage = {
                tokenIn: data.usage.prompt_tokens ?? 0,
                tokenOut: data.usage.completion_tokens ?? 0,
              };
            }
          }
        }

        orderedToolCalls = [...toolCallsByIndex.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => v)
          .filter((v) => v.name);

        if (stepUsage) {
          yield { type: "usage", tokenIn: stepUsage.tokenIn, tokenOut: stepUsage.tokenOut };
        }

        if (orderedToolCalls.length > 0 && onToolCall && !mustDisableTools) {
          messages.push({
            role: "assistant",
            content: stepText || null,
            tool_calls: orderedToolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments || "{}" },
            })),
          });

          const parsedCalls = orderedToolCalls.map((tc) => {
            const raw = tc.arguments.trim();
            if (!raw) return { id: tc.id, name: tc.name, args: {} as Record<string, unknown> };
            try {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return { id: tc.id, name: tc.name, args: parsed as Record<string, unknown> };
              }
              return { id: tc.id, name: tc.name, args: { value: parsed } as Record<string, unknown> };
            } catch (err) {
              return {
                id: tc.id,
                name: tc.name,
                args: {},
                parseError: err instanceof Error ? err.message : String(err),
              };
            }
          });

          const batchCheck = loopTracker.evaluateBatch(parsedCalls);
          const toolResults = yield* this.executeToolCalls(parsedCalls, onToolCall, batchCheck.blockedCallIds);
          const consecErrReason = loopTracker.recordStepOutcomes(toolResults);
          const breakerReason = batchCheck.trippedReason ?? consecErrReason;
          hasToolHistoryInTurn = true;

          for (let i = 0; i < toolResults.length; i++) {
            const r = toolResults[i]!;
            let bounded = boundToolOutputForContext(r.output, MAX_TOOL_OUTPUT_CONTEXT_CHARS);
            if (consecErrReason && i === toolResults.length - 1 && !bounded.includes("[Loop Breaker]")) {
              bounded = `${bounded}\n\n${consecErrReason}`;
            }
            const toolMsg: Record<string, unknown> = {
              role: "tool",
              tool_call_id: r.id,
              content: bounded,
            };
            messages.push(toolMsg);
            if (bounded.length > STALE_TOOL_OUTPUT_COMPACT_MIN_CHARS) {
              const origLen = bounded.length;
              staleToolEntries.push({
                step,
                compacted: false,
                compact: () => {
                  toolMsg.content = `[compacted tool output from step ${step + 1}: ${r.name} (${origLen} chars, ${r.isError ? "error" : "ok"})]`;
                },
              });
            }
          }

          if (breakerReason) {
            forceFinalNoTools = true;
            loopBreakerSummary = breakerReason;
          }
          continue;
        }

        if (forceFinalNoTools && !accumulatedAllText.trim() && loopBreakerSummary) {
          accumulatedAllText = loopBreakerSummary;
          yield { type: "text_delta", text: accumulatedAllText };
        }
        yield { type: "done", finalText: accumulatedAllText };
        return;
      } finally {
        reqSig.cleanup();
      }
    }

    yield { type: "done", finalText: accumulatedAllText };
  }

  private async *callGoogleGemini(
    baseUrl: string,
    modelId: string,
    apiKey: string | undefined,
    frozenSystemPrompt: string,
    history: TurnInput["history"],
    apiUserText: string,
    imageDataUrl: string | null | undefined,
    reasoningEffort: ReasoningEffort | undefined,
    tools: ToolDefinition[] | undefined,
    onToolCall: TurnInput["onToolCall"],
    maxToolSteps: number,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedAgentEvent> {
    const contents = buildGeminiContents(history, apiUserText, imageDataUrl);

    const geminiTools =
      tools && tools.length > 0
        ? [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parametersJsonSchema,
              })),
            },
          ]
        : undefined;

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers["x-goog-api-key"] = apiKey;

    const base = baseUrl.replace(/\/$/, "");
    const streamUrl = `${base}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
    const requestTimeoutMs = this.opts?.requestTimeoutMs ?? DEFAULT_HTTP_REQUEST_TIMEOUT_MS;

    let includeThinkingConfig = Boolean(reasoningEffort);
    let accumulatedAllText = "";
    let forceFinalNoTools = false;
    let loopBreakerSummary: string | null = null;
    let hasToolHistoryInTurn = false;
    const loopTracker = createToolLoopTracker();
    const staleToolEntries: StaleToolEntry[] = [];

    for (let step = 0; step <= maxToolSteps; step++) {
      compactStaleToolOutputs(staleToolEntries, step);
      const mustDisableTools = forceFinalNoTools || step >= maxToolSteps;
      const canOfferTools = Boolean(geminiTools && onToolCall && !mustDisableTools);
      const reqSig = createPerRequestSignal(signal, requestTimeoutMs);

      try {
        let res: Response | null = null;

        for (let attempt = 0; attempt < 2; attempt++) {
          const generationConfig: Record<string, unknown> = { temperature: 0.3 };
          if (includeThinkingConfig && reasoningEffort) {
            generationConfig.thinkingConfig = {
              includeThoughts: true,
              thinkingBudget: GEMINI_THINKING_BUDGET[reasoningEffort],
            };
          }

          const body: Record<string, unknown> = {
            systemInstruction: { parts: [{ text: frozenSystemPrompt }] },
            contents,
            generationConfig,
          };
          if (geminiTools && onToolCall) {
            if (canOfferTools) {
              body.tools = geminiTools;
            } else if (hasToolHistoryInTurn) {
              body.tools = geminiTools;
              body.toolConfig = { functionCallingConfig: { mode: "NONE" } };
            }
          }

          res = await fetch(streamUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: reqSig.signal,
          });
          if (res.ok) break;

          const errText = await res.text();
          if (res.status === 400 && includeThinkingConfig && /thinkingConfig|thinkingBudget|thinking/i.test(errText)) {
            includeThinkingConfig = false;
            continue;
          }
          throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 400)}`);
        }

        if (!res || !res.ok) {
          throw new Error("Gemini HTTP request failed");
        }

        const modelParts: Array<Record<string, unknown>> = [];
        const functionCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
        let latestUsage: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } | null =
          null;
        let stepHasText = false;

        const processParts = (parts: Array<Record<string, unknown>>): NormalizedAgentEvent[] => {
          const events: NormalizedAgentEvent[] = [];
          for (const part of parts) {
            modelParts.push(part);
            if (part.thought === true && typeof part.text === "string" && part.text.length > 0) {
              events.push({ type: "thought", text: this.scrubber.scrub(part.text) });
            } else if (typeof part.text === "string" && part.text.length > 0) {
              const clean = this.scrubber.scrub(part.text);
              if (!stepHasText) {
                stepHasText = true;
                if (accumulatedAllText.length > 0 && !accumulatedAllText.endsWith("\n")) {
                  accumulatedAllText += "\n\n";
                  events.push({ type: "text_delta", text: "\n\n" });
                }
              }
              accumulatedAllText += clean;
              events.push({ type: "text_delta", text: clean });
            }
            const fc = part.functionCall as { id?: string; name?: string; args?: Record<string, unknown> } | undefined;
            if (fc?.name) {
              functionCalls.push({
                id: fc.id ?? `call_${crypto.randomUUID().slice(0, 8)}`,
                name: fc.name,
                args: fc.args && typeof fc.args === "object" ? fc.args : {},
              });
            }
          }
          return events;
        };

        for await (const item of iterSseOrJson(res, reqSig.signal)) {
          if (item.kind === "sse") {
            if (item.data === "[DONE]") break;
            let chunk: {
              error?: { message?: string };
              candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }>;
              usageMetadata?: {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
                thoughtsTokenCount?: number;
              };
            };
            try {
              chunk = JSON.parse(item.data);
            } catch {
              continue;
            }
            if (chunk.error) {
              throw new Error(chunk.error.message || JSON.stringify(chunk.error));
            }
            if (chunk.usageMetadata) {
              latestUsage = chunk.usageMetadata;
            }
            const parts = chunk.candidates?.[0]?.content?.parts ?? [];
            for (const outEvt of processParts(parts)) {
              yield outEvt;
            }
          } else {
            const data = item.data as {
              candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }>;
              usageMetadata?: {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
                thoughtsTokenCount?: number;
              };
            };
            if (data.usageMetadata) latestUsage = data.usageMetadata;
            const parts = data.candidates?.[0]?.content?.parts ?? [];
            for (const outEvt of processParts(parts)) {
              yield outEvt;
            }
          }
        }

        if (latestUsage) {
          yield {
            type: "usage",
            tokenIn: latestUsage.promptTokenCount ?? 0,
            tokenOut: (latestUsage.candidatesTokenCount ?? 0) + (latestUsage.thoughtsTokenCount ?? 0),
          };
        }

        if (functionCalls.length > 0 && onToolCall && !mustDisableTools) {
          contents.push({ role: "model", parts: modelParts });
          const batchCheck = loopTracker.evaluateBatch(functionCalls);
          const toolResults = yield* this.executeToolCalls(functionCalls, onToolCall, batchCheck.blockedCallIds);
          const consecErrReason = loopTracker.recordStepOutcomes(toolResults);
          const breakerReason = batchCheck.trippedReason ?? consecErrReason;
          hasToolHistoryInTurn = true;

          const responseParts: Array<Record<string, unknown>> = [];
          for (let i = 0; i < toolResults.length; i++) {
            const r = toolResults[i]!;
            let bounded = boundToolOutputForContext(r.output, MAX_TOOL_OUTPUT_CONTEXT_CHARS);
            if (consecErrReason && i === toolResults.length - 1 && !bounded.includes("[Loop Breaker]")) {
              bounded = `${bounded}\n\n${consecErrReason}`;
            }
            const respObj: Record<string, unknown> = r.isError ? { error: bounded } : { output: bounded };
            responseParts.push({
              functionResponse: {
                name: r.name,
                response: respObj,
              },
            });
            if (bounded.length > STALE_TOOL_OUTPUT_COMPACT_MIN_CHARS) {
              const origLen = bounded.length;
              staleToolEntries.push({
                step,
                compacted: false,
                compact: () => {
                  const compactNote = `[compacted tool output from step ${step + 1}: ${r.name} (${origLen} chars, ${r.isError ? "error" : "ok"})]`;
                  if (r.isError) respObj.error = compactNote;
                  else respObj.output = compactNote;
                },
              });
            }
          }
          contents.push({ role: "user", parts: responseParts });

          if (breakerReason) {
            forceFinalNoTools = true;
            loopBreakerSummary = breakerReason;
          }
          continue;
        }

        if (forceFinalNoTools && !accumulatedAllText.trim() && loopBreakerSummary) {
          accumulatedAllText = loopBreakerSummary;
          yield { type: "text_delta", text: accumulatedAllText };
        }
        yield { type: "done", finalText: accumulatedAllText };
        return;
      } finally {
        reqSig.cleanup();
      }
    }

    yield { type: "done", finalText: accumulatedAllText };
  }

  private async *callAnthropic(
    baseUrl: string,
    modelId: string,
    apiKey: string | undefined,
    frozenSystemPrompt: string,
    history: TurnInput["history"],
    apiUserText: string,
    imageDataUrl: string | null | undefined,
    reasoningEffort: ReasoningEffort | undefined,
    tools: ToolDefinition[] | undefined,
    onToolCall: TurnInput["onToolCall"],
    maxToolSteps: number,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedAgentEvent> {
    const messages = buildAnthropicMessages(history, apiUserText, imageDataUrl);

    const anthropicTools =
      tools && tools.length > 0
        ? tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parametersJsonSchema,
          }))
        : undefined;

    const cleanBase = baseUrl.replace(/\/$/, "");
    const url = cleanBase.endsWith("/v1") ? `${cleanBase}/messages` : `${cleanBase}/v1/messages`;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (apiKey) headers["x-api-key"] = apiKey;
    const requestTimeoutMs = this.opts?.requestTimeoutMs ?? DEFAULT_HTTP_REQUEST_TIMEOUT_MS;

    let allowThinking = reasoningEffort === "high" || reasoningEffort === "max";
    let includePromptCache = true;
    let includeToolChoiceNone = true;
    let accumulatedAllText = "";
    let forceFinalNoTools = false;
    let loopBreakerSummary: string | null = null;
    let hasToolHistoryInTurn = false;
    const loopTracker = createToolLoopTracker();
    const staleToolEntries: StaleToolEntry[] = [];

    for (let step = 0; step <= maxToolSteps; step++) {
      compactStaleToolOutputs(staleToolEntries, step);
      const mustDisableTools = forceFinalNoTools || step >= maxToolSteps;
      const canOfferTools = Boolean(anthropicTools && onToolCall && !mustDisableTools);
      const reqSig = createPerRequestSignal(signal, requestTimeoutMs);

      try {
        let res: Response | null = null;

        for (let attempt = 0; attempt < 4; attempt++) {
          const systemPayload = includePromptCache
            ? [{ type: "text", text: frozenSystemPrompt, cache_control: { type: "ephemeral" } }]
            : frozenSystemPrompt;
          const cachedTools =
            includePromptCache && anthropicTools
              ? anthropicTools.map((t, idx) =>
                  idx === anthropicTools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t,
                )
              : anthropicTools;

          const body: Record<string, unknown> = {
            model: modelId,
            system: systemPayload,
            messages,
            stream: true,
          };
          if (allowThinking && (reasoningEffort === "high" || reasoningEffort === "max")) {
            const budgetTokens = reasoningEffort === "max" ? 16384 : 8192;
            body.max_tokens = reasoningEffort === "max" ? 32768 : 16384;
            body.thinking = { type: "enabled", budget_tokens: budgetTokens };
          } else {
            body.max_tokens = 8192;
            body.temperature = 0.3;
          }
          if (cachedTools && onToolCall) {
            if (canOfferTools) {
              body.tools = cachedTools;
            } else if (hasToolHistoryInTurn) {
              body.tools = cachedTools;
              if (includeToolChoiceNone) {
                body.tool_choice = { type: "none" };
              }
            }
          }

          res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: reqSig.signal,
          });
          if (res.ok) break;

          const errText = await res.text();
          if (res.status === 400 && attempt < 3) {
            let retried = false;
            if (allowThinking && /thinking|budget_tokens/i.test(errText)) {
              allowThinking = false;
              retried = true;
            }
            if (includePromptCache && /cache_control|ephemeral|system/i.test(errText)) {
              includePromptCache = false;
              retried = true;
            }
            if (includeToolChoiceNone && !canOfferTools && /tool_choice/i.test(errText)) {
              includeToolChoiceNone = false;
              retried = true;
            }
            if (retried) continue;
          }
          throw new Error(`Anthropic HTTP ${res.status}: ${errText.slice(0, 400)}`);
        }

        if (!res || !res.ok) {
          throw new Error("Anthropic HTTP request failed");
        }

        let stepInTokens = 0;
        let stepOutTokens = 0;
        let stepHasText = false;
        const blockBuilders = new Map<
          number,
          {
            type: string;
            text?: string;
            thinking?: string;
            signature?: string;
            id?: string;
            name?: string;
            jsonChunks?: string;
          }
        >();

        const appendAnthropicText = (clean: string): string | null => {
          let sepText: string | null = null;
          if (!stepHasText) {
            stepHasText = true;
            if (accumulatedAllText.length > 0 && !accumulatedAllText.endsWith("\n")) {
              accumulatedAllText += "\n\n";
              sepText = "\n\n";
            }
          }
          accumulatedAllText += clean;
          return sepText;
        };

        for await (const item of iterSseOrJson(res, reqSig.signal)) {
          if (item.kind === "sse") {
            if (item.data === "[DONE]") break;
            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(item.data) as Record<string, unknown>;
            } catch {
              continue;
            }
            const evType = String(payload.type ?? item.event ?? "");
            if (evType === "error") {
              const errObj = payload.error as { message?: string } | undefined;
              throw new Error(errObj?.message || JSON.stringify(payload));
            } else if (evType === "message_start") {
              const msg = payload.message as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
              stepInTokens = msg?.usage?.input_tokens ?? stepInTokens;
              stepOutTokens = msg?.usage?.output_tokens ?? stepOutTokens;
            } else if (evType === "content_block_start") {
              const idx = Number(payload.index ?? 0);
              const cb = (payload.content_block ?? {}) as { type?: string; id?: string; name?: string };
              blockBuilders.set(idx, {
                type: String(cb.type ?? "text"),
                id: cb.id,
                name: cb.name,
                text: "",
                thinking: "",
                signature: "",
                jsonChunks: "",
              });
            } else if (evType === "content_block_delta") {
              const idx = Number(payload.index ?? 0);
              const builder = blockBuilders.get(idx) ?? { type: "text", text: "", thinking: "", signature: "", jsonChunks: "" };
              blockBuilders.set(idx, builder);
              const delta = (payload.delta ?? {}) as {
                type?: string;
                text?: string;
                thinking?: string;
                signature?: string;
                partial_json?: string;
              };
              if (delta.type === "thinking_delta" && delta.thinking) {
                builder.thinking = (builder.thinking ?? "") + delta.thinking;
                yield { type: "thought", text: this.scrubber.scrub(delta.thinking) };
              } else if (delta.type === "signature_delta" && delta.signature) {
                builder.signature = (builder.signature ?? "") + delta.signature;
              } else if (delta.type === "text_delta" && delta.text) {
                const clean = this.scrubber.scrub(delta.text);
                builder.text = (builder.text ?? "") + clean;
                const sep = appendAnthropicText(clean);
                if (sep) yield { type: "text_delta", text: sep };
                yield { type: "text_delta", text: clean };
              } else if (delta.type === "input_json_delta" && delta.partial_json) {
                builder.jsonChunks = (builder.jsonChunks ?? "") + delta.partial_json;
              }
            } else if (evType === "message_delta") {
              const usage = payload.usage as { output_tokens?: number } | undefined;
              if (usage?.output_tokens !== undefined) {
                stepOutTokens = usage.output_tokens;
              }
            }
          } else {
            const data = item.data as {
              content?: Array<{
                type: string;
                text?: string;
                thinking?: string;
                signature?: string;
                id?: string;
                name?: string;
                input?: Record<string, unknown>;
              }>;
              usage?: { input_tokens?: number; output_tokens?: number };
            };
            if (data.usage) {
              stepInTokens = data.usage.input_tokens ?? 0;
              stepOutTokens = data.usage.output_tokens ?? 0;
            }
            const contentBlocks = data.content ?? [];
            for (let idx = 0; idx < contentBlocks.length; idx++) {
              const block = contentBlocks[idx]!;
              if (block.type === "thinking" && block.thinking) {
                yield { type: "thought", text: this.scrubber.scrub(block.thinking) };
                blockBuilders.set(idx, {
                  type: "thinking",
                  thinking: block.thinking,
                  signature: block.signature,
                });
              } else if (block.type === "text" && block.text) {
                const clean = this.scrubber.scrub(block.text);
                const sep = appendAnthropicText(clean);
                if (sep) yield { type: "text_delta", text: sep };
                yield { type: "text_delta", text: clean };
                blockBuilders.set(idx, { type: "text", text: clean });
              } else if (block.type === "tool_use" && block.name) {
                blockBuilders.set(idx, {
                  type: "tool_use",
                  id: block.id ?? `call_${crypto.randomUUID().slice(0, 8)}`,
                  name: block.name,
                  jsonChunks: JSON.stringify(block.input ?? {}),
                });
              }
            }
          }
        }

        if (stepInTokens > 0 || stepOutTokens > 0) {
          yield { type: "usage", tokenIn: stepInTokens, tokenOut: stepOutTokens };
        }

        const orderedBlocks = [...blockBuilders.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
        const toolUseBlocks = orderedBlocks.filter((b) => b.type === "tool_use" && b.name);

        if (toolUseBlocks.length > 0 && onToolCall && !mustDisableTools) {
          const assistantBlocks: Array<Record<string, unknown>> = [];
          const parsedCalls: Array<{ id: string; name: string; args: Record<string, unknown>; parseError?: string }> = [];

          for (const b of orderedBlocks) {
            if (b.type === "thinking") {
              if ((b.thinking && b.thinking.trim().length > 0) || (b.signature && b.signature.length > 0)) {
                assistantBlocks.push({
                  type: "thinking",
                  thinking: b.thinking ?? "",
                  ...(b.signature ? { signature: b.signature } : {}),
                });
              }
            } else if (b.type === "text" && b.text) {
              assistantBlocks.push({ type: "text", text: b.text });
            } else if (b.type === "tool_use" && b.name) {
              const id = b.id ?? `call_${crypto.randomUUID().slice(0, 8)}`;
              const rawJson = (b.jsonChunks ?? "").trim();
              let inputObj: Record<string, unknown> = {};
              let parseError: string | undefined;
              if (rawJson) {
                try {
                  const parsed = JSON.parse(rawJson);
                  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    inputObj = parsed as Record<string, unknown>;
                  } else {
                    inputObj = { value: parsed };
                  }
                } catch (err) {
                  parseError = err instanceof Error ? err.message : String(err);
                }
              }
              assistantBlocks.push({ type: "tool_use", id, name: b.name, input: inputObj });
              parsedCalls.push({ id, name: b.name, args: inputObj, parseError });
            }
          }

          messages.push({ role: "assistant", content: assistantBlocks });
          const batchCheck = loopTracker.evaluateBatch(parsedCalls);
          const toolResults = yield* this.executeToolCalls(parsedCalls, onToolCall, batchCheck.blockedCallIds);
          const consecErrReason = loopTracker.recordStepOutcomes(toolResults);
          const breakerReason = batchCheck.trippedReason ?? consecErrReason;
          hasToolHistoryInTurn = true;

          const resultBlocks: Array<Record<string, unknown>> = [];
          for (let i = 0; i < toolResults.length; i++) {
            const r = toolResults[i]!;
            let bounded = boundToolOutputForContext(r.output, MAX_TOOL_OUTPUT_CONTEXT_CHARS);
            if (consecErrReason && i === toolResults.length - 1 && !bounded.includes("[Loop Breaker]")) {
              bounded = `${bounded}\n\n${consecErrReason}`;
            }
            const block: Record<string, unknown> = {
              type: "tool_result",
              tool_use_id: r.id,
              content: bounded,
              ...(r.isError ? { is_error: true } : {}),
            };
            resultBlocks.push(block);
            if (bounded.length > STALE_TOOL_OUTPUT_COMPACT_MIN_CHARS) {
              const origLen = bounded.length;
              staleToolEntries.push({
                step,
                compacted: false,
                compact: () => {
                  block.content = `[compacted tool output from step ${step + 1}: ${r.name} (${origLen} chars, ${r.isError ? "error" : "ok"})]`;
                },
              });
            }
          }
          messages.push({ role: "user", content: resultBlocks });

          if (breakerReason) {
            forceFinalNoTools = true;
            loopBreakerSummary = breakerReason;
          }
          continue;
        }

        if (forceFinalNoTools && !accumulatedAllText.trim() && loopBreakerSummary) {
          accumulatedAllText = loopBreakerSummary;
          yield { type: "text_delta", text: accumulatedAllText };
        }
        yield { type: "done", finalText: accumulatedAllText };
        return;
      } finally {
        reqSig.cleanup();
      }
    }

    yield { type: "done", finalText: accumulatedAllText };
  }

  private async *runDeterministicLocalTurn(
    spec: RuntimeSessionSpec,
    input: TurnInput,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedAgentEvent> {
    const userText = input.userText;
    yield {
      type: "thought",
      text: `Planning deterministic offline execution for ${spec.provider}/${spec.model} in ${spec.cwd}.`,
    };
    yield {
      type: "plan",
      items: [
        { title: "Inspect workspace & requirements", status: "in_progress" },
        { title: "Apply scoped change & produce summary", status: "pending" },
      ],
    };

    const callId = `tc_${crypto.randomUUID().slice(0, 8)}`;
    yield {
      type: "tool_call",
      toolCallId: callId,
      title: `list_files(${spec.cwd})`,
      status: "in_progress",
      filePath: spec.cwd,
    };

    if (signal.aborted) return;
    const files = existsSync(spec.cwd) ? readdirSync(spec.cwd).slice(0, 12) : [];
    yield {
      type: "tool_call",
      toolCallId: callId,
      title: `list_files(${spec.cwd})`,
      status: "completed",
      filePath: spec.cwd,
      output: files.join(", ") || "(empty)",
      exitCode: 0,
    };

    let scriptedToolSummary = "";
    if (input.onToolCall && input.tools && input.tools.length > 0) {
      const mockToolRegex = /\[MOCK_TOOL_CALL:([a-zA-Z0-9_.-]+)(?::(\{[^\n]*?\}))?\]/g;
      const matchedCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
      let m: RegExpExecArray | null;
      while ((m = mockToolRegex.exec(userText)) !== null) {
        const toolName = m[1]!;
        if (!input.tools.some((t) => t.name === toolName)) continue;
        let args: Record<string, unknown> = {};
        if (m[2]) {
          try {
            args = JSON.parse(m[2]) as Record<string, unknown>;
          } catch {
            args = {};
          }
        }
        matchedCalls.push({ id: `tc_${crypto.randomUUID().slice(0, 8)}`, name: toolName, args });
      }
      if (matchedCalls.length > 0) {
        const results = yield* this.executeToolCalls(matchedCalls, input.onToolCall);
        scriptedToolSummary = ` Executed ${results.length} tool(s): ${results.map((r) => `${r.name}=${r.output.slice(0, 120)}`).join("; ")}.`;
      }
    }

    yield {
      type: "plan",
      items: [
        { title: "Inspect workspace & requirements", status: "completed" },
        { title: "Apply scoped change & produce summary", status: "completed" },
      ],
    };

    let reply = `[${spec.provider}/${spec.model} · local-sim] Processed request in ${spec.cwd}: "${userText.slice(0, 160)}". Workspace entries observed: ${files.length}.${scriptedToolSummary} Set API key in ~/bot-factory/system/secrets.env for live remote model calls.`;
    if (userText.includes("Independently verify") && userText.includes("VERDICT")) {
      const checksPassed =
        userText.includes("All objective checks passed.") || userText.includes("All static checks passed.");
      reply = checksPassed
        ? `[${spec.provider}/${spec.model} · local-sim] Independent verification completed against objective checks and spec.\nVERDICT: PASS`
        : `[${spec.provider}/${spec.model} · local-sim] Independent verification detected objective check failures.\n- FINDING: Objective verification checks failed\nVERDICT: FAIL`;
    }
    yield { type: "text_delta", text: reply };
    yield { type: "usage", tokenIn: Math.ceil(userText.length / 4), tokenOut: Math.ceil(reply.length / 4) };
    yield { type: "done", finalText: reply };
  }

  public async abort(handle: RuntimeSessionHandle): Promise<void> {
    const active = this.sessions.get(handle.sessionId);
    active?.abortController?.abort();
  }

  public async closeSession(handle: RuntimeSessionHandle): Promise<void> {
    await this.abort(handle);
    this.sessions.delete(handle.sessionId);
  }

  public shutdownAllSync(): void {
    for (const active of this.sessions.values()) {
      try {
        active.abortController?.abort();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
  }

  public async shutdownAll(): Promise<void> {
    this.shutdownAllSync();
  }
}
