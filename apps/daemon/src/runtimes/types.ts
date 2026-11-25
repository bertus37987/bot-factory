import type { HubConfig, RouteTarget, RuntimeKind as SharedRuntimeKind } from "@bot-factory/shared";

export type RuntimeKind = "native_http" | "acp_stdio" | "cli_stream";
export type AutonomyLevel = "spec" | "low" | "medium" | "high";
export type ReasoningEffort = "low" | "medium" | "high" | "max";

export interface ToolDefinition {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

export type ToolCallExecutor = (call: {
  id: string;
  name: string;
  args: Record<string, unknown>;
}) => Promise<unknown>;

export interface RuntimeSessionSpec {
  agentId: string;
  sessionId: string;
  provider: string;
  model: string;
  cwd: string;
  systemPrompt: string;
  mcpServers?: Array<{ name: string; command: string; args: string[]; env?: Record<string, string> }>;
  autonomyLevel?: AutonomyLevel;
  reasoningEffort?: ReasoningEffort;
  mcpToken?: string;
}

export interface RuntimeSessionHandle {
  sessionId: string;
  agentId: string;
  runtimeKind: RuntimeKind;
  pid: number | null;
  externalSessionId?: string;
  provider?: string;
  model?: string;
}

export interface TurnInput {
  userText: string;
  ephemeralContext?: string;
  history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  imageDataUrl?: string | null;
  reasoningEffort?: ReasoningEffort;
  autonomyLevel?: AutonomyLevel;
  tools?: ToolDefinition[];
  onToolCall?: ToolCallExecutor;
  maxToolSteps?: number;
}

export type NormalizedAgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thought"; text: string }
  | { type: "plan"; items: Array<{ title: string; status: "pending" | "in_progress" | "completed" | "cancelled" }> }
  | {
      type: "tool_call";
      toolCallId: string;
      title: string;
      status: "pending" | "in_progress" | "completed" | "failed";
      filePath?: string;
      diffPreview?: string;
      output?: string;
      exitCode?: number | null;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      output: string;
      isError?: boolean;
    }
  | { type: "permission_escalated"; requestId: string; reason: string }
  | {
      type: "permission_requested";
      permissionId: string;
      agentId: string;
      sessionId: string;
      title: string;
      commandOrPath: string;
      reason: string;
      timeoutMs: number;
    }
  | { type: "usage"; tokenIn: number; tokenOut: number }
  | { type: "done"; finalText: string }
  | { type: "error"; message: string };

export interface AgentRuntime {
  readonly kind: RuntimeKind;
  startSession(spec: RuntimeSessionSpec): Promise<RuntimeSessionHandle>;
  sendTurn(handle: RuntimeSessionHandle, input: TurnInput): AsyncIterable<NormalizedAgentEvent>;
  abort(handle: RuntimeSessionHandle, mode: "pause" | "hard_stop"): Promise<void>;
  closeSession(handle: RuntimeSessionHandle): Promise<void>;
  setConfig?(newConfig: HubConfig): void;
}

export interface ResolvedRoute extends RouteTarget {
  runtimeKind: RuntimeKind | SharedRuntimeKind;
  resolvedModelId: string;
}
