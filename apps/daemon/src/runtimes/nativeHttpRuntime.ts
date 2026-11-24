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

function resolveSymlinkStep(
  realRoot: string,
  current: string,
  depth: number,
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
  const absLinkTarget = resolve(dirname(current), rawLink);
  if (!lexicalWithinRoot(realRoot, absLinkTarget)) {
    return { exists: true, escaped: true, resolvedPath: absLinkTarget };
  }
  if (!checkSegmentsWithinRealRoot(realRoot, realRoot, relative(realRoot, absLinkTarget), depth + 1)) {
    return { exists: true, escaped: true, resolvedPath: absLinkTarget };
  }
  return { exists: true, escaped: false, resolvedPath: absLinkTarget };
}

function checkSegmentsWithinRealRoot(
  realRoot: string,
  baseStart: string,
  relFromRoot: string,
  depth: number,
): boolean {
  if (depth > 16) return false;
  if (!relFromRoot || relFromRoot === ".") return true;

  const segments = relFromRoot.split(sep).filter((s) => s.length > 0 && s !== ".");
  let current = baseStart;

  for (const seg of segments) {
    if (seg === "..") return false;
    current = join(current, seg);
    const step = resolveSymlinkStep(realRoot, current, depth);
    if (step.escaped) return false;
    if (!step.exists) return true;
    current = step.resolvedPath;
  }

  return true;
}

function checkRawRelativeSegmentsWithinRealRoot(realRoot: string, candidatePath: string): boolean {
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
    const step = resolveSymlinkStep(realRoot, current, 0);
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
    if (!checkRawRelativeSegmentsWithinRealRoot(realRoot, candidatePath)) {
      return { ok: false, absTarget };
    }
    const relFromRoot = relative(absRoot, absTarget);
    if (!checkSegmentsWithinRealRoot(realRoot, realRoot, relFromRoot, 0)) {
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

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
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
      if (call.parseError) {
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
    const userContent = imageDataUrl
      ? [
          { type: "text", text: apiUserText },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ]
      : apiUserText;

    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: frozenSystemPrompt },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userContent },
    ];

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

    let includeStreamOptions = true;
    let includeReasoningEffort = Boolean(reasoningEffort);
    let accumulatedAllText = "";

    for (let step = 0; step <= maxToolSteps; step++) {
      const canOfferTools = Boolean(openAiTools && onToolCall && step < maxToolSteps);
      let res: Response | null = null;

      for (let attempt = 0; attempt < 3; attempt++) {
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
        if (canOfferTools && openAiTools) {
          body.tools = openAiTools;
        }

        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
        if (res.ok) break;

        const errText = await res.text();
        if ((res.status === 400 || res.status === 422) && attempt < 2) {
          let retried = false;
          if (includeReasoningEffort && /reasoning_effort|extra_forbidden|unrecognized|unknown/i.test(errText)) {
            includeReasoningEffort = false;
            retried = true;
          }
          if (includeStreamOptions && /stream_options|extra_forbidden|unrecognized|unknown/i.test(errText)) {
            includeStreamOptions = false;
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
      let stepUsage: { tokenIn: number; tokenOut: number } | null = null;
      const toolCallsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
      let orderedToolCalls: Array<{ id: string; name: string; arguments: string }> = [];

      for await (const item of iterSseOrJson(res, signal)) {
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
              stepText += clean;
              accumulatedAllText += clean;
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
              stepText += clean;
              accumulatedAllText += clean;
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
            stepText = clean;
            accumulatedAllText += clean;
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

      if (orderedToolCalls.length > 0 && onToolCall && step < maxToolSteps) {
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

        const toolResults = yield* this.executeToolCalls(parsedCalls, onToolCall);
        for (const r of toolResults) {
          messages.push({
            role: "tool",
            tool_call_id: r.id,
            content: r.output,
          });
        }
        continue;
      }

      yield { type: "done", finalText: accumulatedAllText };
      return;
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
    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = history
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const userParts: Array<Record<string, unknown>> = [{ text: apiUserText }];
    const img = parseDataUrl(imageDataUrl);
    if (img) {
      userParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
    contents.push({ role: "user", parts: userParts });

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

    let includeThinkingConfig = Boolean(reasoningEffort);
    let accumulatedAllText = "";

    for (let step = 0; step <= maxToolSteps; step++) {
      const canOfferTools = Boolean(geminiTools && onToolCall && step < maxToolSteps);
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
        if (canOfferTools && geminiTools) {
          body.tools = geminiTools;
        }

        res = await fetch(streamUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
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

      const processParts = (parts: Array<Record<string, unknown>>): NormalizedAgentEvent[] => {
        const events: NormalizedAgentEvent[] = [];
        for (const part of parts) {
          modelParts.push(part);
          if (part.thought === true && typeof part.text === "string" && part.text.length > 0) {
            events.push({ type: "thought", text: this.scrubber.scrub(part.text) });
          } else if (typeof part.text === "string" && part.text.length > 0) {
            const clean = this.scrubber.scrub(part.text);
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

      for await (const item of iterSseOrJson(res, signal)) {
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

      if (functionCalls.length > 0 && onToolCall && step < maxToolSteps) {
        contents.push({ role: "model", parts: modelParts });
        const toolResults = yield* this.executeToolCalls(functionCalls, onToolCall);
        contents.push({
          role: "user",
          parts: toolResults.map((r) => ({
            functionResponse: {
              name: r.name,
              response: r.isError ? { error: r.output } : { output: r.output },
            },
          })),
        });
        continue;
      }

      yield { type: "done", finalText: accumulatedAllText };
      return;
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
    const messages: Array<Record<string, unknown>> = history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

    const img = parseDataUrl(imageDataUrl);
    const currentUserContent = img
      ? [
          { type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } },
          { type: "text", text: apiUserText },
        ]
      : apiUserText;
    messages.push({ role: "user", content: currentUserContent });

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

    let allowThinking = reasoningEffort === "high" || reasoningEffort === "max";
    let accumulatedAllText = "";

    for (let step = 0; step <= maxToolSteps; step++) {
      const canOfferTools = Boolean(anthropicTools && onToolCall && step < maxToolSteps);
      let res: Response | null = null;

      for (let attempt = 0; attempt < 2; attempt++) {
        const body: Record<string, unknown> = {
          model: modelId,
          system: frozenSystemPrompt,
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
        if (canOfferTools && anthropicTools) {
          body.tools = anthropicTools;
        }

        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
        if (res.ok) break;

        const errText = await res.text();
        if (res.status === 400 && allowThinking && /thinking|budget_tokens/i.test(errText)) {
          allowThinking = false;
          continue;
        }
        throw new Error(`Anthropic HTTP ${res.status}: ${errText.slice(0, 400)}`);
      }

      if (!res || !res.ok) {
        throw new Error("Anthropic HTTP request failed");
      }

      let stepInTokens = 0;
      let stepOutTokens = 0;
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

      for await (const item of iterSseOrJson(res, signal)) {
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
              accumulatedAllText += clean;
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
              accumulatedAllText += clean;
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

      if (toolUseBlocks.length > 0 && onToolCall && step < maxToolSteps) {
        const assistantBlocks: Array<Record<string, unknown>> = [];
        const parsedCalls: Array<{ id: string; name: string; args: Record<string, unknown>; parseError?: string }> = [];

        for (const b of orderedBlocks) {
          if (b.type === "thinking") {
            assistantBlocks.push({
              type: "thinking",
              thinking: b.thinking ?? "",
              ...(b.signature ? { signature: b.signature } : {}),
            });
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
        const toolResults = yield* this.executeToolCalls(parsedCalls, onToolCall);
        messages.push({
          role: "user",
          content: toolResults.map((r) => ({
            type: "tool_result",
            tool_use_id: r.id,
            content: r.output,
            ...(r.isError ? { is_error: true } : {}),
          })),
        });
        continue;
      }

      yield { type: "done", finalText: accumulatedAllText };
      return;
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
