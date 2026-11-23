import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";
import type { HubConfig } from "@bot-factory/shared";
import { SecretScrubber } from "../config";
import type { AgentRuntime, NormalizedAgentEvent, RuntimeSessionHandle, RuntimeSessionSpec, TurnInput } from "./types";

interface ActiveNativeSession {
  spec: RuntimeSessionSpec;
  abortController: AbortController | null;
}

function lexicalWithinRoot(absRoot: string, absTarget: string): boolean {
  const normRoot = process.platform === "win32" ? absRoot.toLowerCase() : absRoot;
  const normTarget = process.platform === "win32" ? absTarget.toLowerCase() : absTarget;
  const rootPrefix = normRoot.endsWith(sep) ? normRoot : `${normRoot}${sep}`;
  const sameDrive = parse(normTarget).root === parse(normRoot).root;
  return sameDrive && (normTarget === normRoot || normTarget.startsWith(rootPrefix));
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
  // Guard against symlinks / Windows reparse points escaping rootDir
  try {
    if (existsSync(absRoot)) {
      const realRoot = realpathSync(absRoot);
      let probe = absTarget;
      while (probe && !existsSync(probe)) {
        if (!lexicalWithinRoot(absRoot, probe)) break;
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
      if (existsSync(probe) && lexicalWithinRoot(absRoot, probe)) {
        const realProbe = realpathSync(probe);
        if (!lexicalWithinRoot(realRoot, realProbe)) {
          return { ok: false, absTarget };
        }
      }
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

export class NativeHttpRuntime implements AgentRuntime {
  public readonly kind = "native_http" as const;
  private readonly sessions = new Map<string, ActiveNativeSession>();

  constructor(
    private readonly config: HubConfig,
    private readonly secrets: Record<string, string>,
    private readonly scrubber: SecretScrubber,
  ) {}

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

    const providerCfg = this.config.providers[active.spec.provider];
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

    try {
      if (!apiKey || process.env.BOT_FACTORY_OFFLINE_MOCK === "1") {
        yield* this.runDeterministicLocalTurn(active.spec, input.userText, controller.signal);
        return;
      }

      if (providerCfg.protocol === "google_gemini") {
        yield* this.callGoogleGemini(providerCfg.baseUrl!, modelCfg.id, apiKey, active.spec.systemPrompt, input.history, apiUserText, input.imageDataUrl, controller.signal);
      } else {
        yield* this.callOpenAiCompatible(providerCfg.baseUrl!, modelCfg.id, apiKey, active.spec.systemPrompt, input.history, apiUserText, controller.signal);
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

  private async *callOpenAiCompatible(
    baseUrl: string,
    modelId: string,
    apiKey: string,
    frozenSystemPrompt: string,
    history: TurnInput["history"],
    apiUserText: string,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedAgentEvent> {
    const messages = [
      { role: "system", content: frozenSystemPrompt },
      ...history,
      { role: "user", content: apiUserText },
    ];

    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: modelId, messages, temperature: 0.3 }),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 400)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const finalText = this.scrubber.scrub(data.choices?.[0]?.message?.content ?? "");
    if (finalText) yield { type: "text_delta", text: finalText };
    if (data.usage) {
      yield { type: "usage", tokenIn: data.usage.prompt_tokens ?? 0, tokenOut: data.usage.completion_tokens ?? 0 };
    }
    yield { type: "done", finalText };
  }

  private async *callGoogleGemini(
    baseUrl: string,
    modelId: string,
    apiKey: string,
    frozenSystemPrompt: string,
    history: TurnInput["history"],
    apiUserText: string,
    imageDataUrl: string | null | undefined,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedAgentEvent> {
    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = history
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const userParts: Array<Record<string, unknown>> = [{ text: apiUserText }];
    if (imageDataUrl && imageDataUrl.startsWith("data:")) {
      const match = /^data:([^;]+);base64,(.+)$/.exec(imageDataUrl);
      if (match) {
        userParts.push({ inline_data: { mime_type: match[1], data: match[2] } });
      }
    }
    contents.push({ role: "user", parts: userParts });

    const url = `${baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: frozenSystemPrompt }] },
        contents,
      }),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 400)}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const finalText = this.scrubber.scrub(
      (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join(""),
    );
    if (finalText) yield { type: "text_delta", text: finalText };
    if (data.usageMetadata) {
      yield {
        type: "usage",
        tokenIn: data.usageMetadata.promptTokenCount ?? 0,
        tokenOut: data.usageMetadata.candidatesTokenCount ?? 0,
      };
    }
    yield { type: "done", finalText };
  }

  private async *runDeterministicLocalTurn(
    spec: RuntimeSessionSpec,
    userText: string,
    signal: AbortSignal,
  ): AsyncIterable<NormalizedAgentEvent> {
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

    yield {
      type: "plan",
      items: [
        { title: "Inspect workspace & requirements", status: "completed" },
        { title: "Apply scoped change & produce summary", status: "completed" },
      ],
    };

    let reply = `[${spec.provider}/${spec.model} · local-sim] Processed request in ${spec.cwd}: "${userText.slice(0, 160)}". Workspace entries observed: ${files.length}. Set API key in ~/bot-factory/system/secrets.env for live remote model calls.`;
    if (userText.includes("Independently verify") && userText.includes("VERDICT")) {
      const checksPassed = userText.includes("All objective checks passed.") || userText.includes("All static checks passed.");
      reply = checksPassed
        ? `[${spec.provider}/${spec.model} · local-sim] Independent verification completed against objective checks and spec.\nVERDICT: PASS`
        : `[${spec.provider}/${spec.model} · local-sim] Independent verification detected objective check failures.\n- FINDING: Objective verification checks failed\nVERDICT: FAIL`;
    }
    yield { type: "text_delta", text: reply };
    yield { type: "usage", tokenIn: Math.ceil(userText.length / 4), tokenOut: Math.ceil(reply.length / 4) };
    yield { type: "done", finalText: reply };
  }

  public readWorktreeFile(cwd: string, relPath: string): string {
    const abs = resolveSafeWorktreePath(cwd, relPath);
    return readFileSync(abs, "utf8");
  }

  public writeWorktreeFile(cwd: string, relPath: string, content: string): void {
    const abs = resolveSafeWorktreePath(cwd, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
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
