/**
 * Lean stdio MCP Bridge server.
 *
 * Spawned by external ACP agents (`devin acp`, `opencode acp`) via
 * `session/new { mcpServers: [...] }`. Speaks line-delimited JSON-RPC 2.0
 * on stdin/stdout and forwards tool calls to the Bot Factory daemon's
 * `/api/mcp/*` HTTP endpoints.
 *
 * Contract: stdout carries ONLY JSON-RPC responses (one per line).
 * All diagnostics go to stderr.
 */

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "bot-factory-mcp-bridge";
const SERVER_VERSION = "0.1.0";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:4310";
const DAEMON_FETCH_TIMEOUT_MS = 15_000;

// --- Types ---

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcError {
  code: number;
  message: string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface BridgeConfig {
  daemonUrl: string;
  token: string;
  projectId: string;
  agentId: string;
}

export interface McpToolPropertySchema {
  type: string;
  description: string;
  items?: { type: string };
  enum?: string[];
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, McpToolPropertySchema>;
    required?: string[];
  };
}

export type CallToolFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

// --- Tool catalog ---

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "bf_task_list",
    description:
      "List tasks for the project (optionally filtered by status).",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["backlog", "ready", "claimed", "in_review", "verified", "merged", "blocked"],
          description: "Optional TaskStatus filter (backlog, ready, claimed, in_review, verified, merged, blocked).",
        },
      },
    },
  },
  {
    name: "bf_task_claim",
    description: "Atomically claim an available task for this agent.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "ID of the task to claim. If omitted, claims the highest-priority available task.",
        },
      },
    },
  },
  {
    name: "bf_task_update",
    description: "Update a task status.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "ID of the task to update." },
        status: {
          type: "string",
          enum: ["backlog", "ready", "claimed", "in_review", "verified", "merged", "blocked"],
          description: "New TaskStatus value.",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "bf_handoff_write",
    description: "Write or replace the handoff document for a task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "ID of the task." },
        title: { type: "string", description: "Short handoff title (defaults to taskId)." },
        summary: { type: "string", description: "Summary of completed work and findings (markdown)." },
        content: { type: "string", description: "Legacy alias for summary (markdown)." },
        changedFiles: {
          type: "array",
          items: { type: "string" },
          description: "List of modified file paths.",
        },
        testsRun: {
          type: "array",
          items: { type: "string" },
          description: "List of test/check commands executed and their outcomes.",
        },
        notes: { type: "string", description: "Optional additional notes or caveats." },
      },
      required: ["taskId"],
    },
  },
  {
    name: "bf_memory_search",
    description: "Search project or global memory for relevant facts or decisions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text." },
        scope: {
          type: "string",
          enum: ["project", "global"],
          description: "Memory scope to search ('project' default or 'global').",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default 8).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "bf_fix_tasks_list",
    description: "List open fix tasks derived from annotations for the project.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "bf_fix_task_resolve",
    description: "Resolve a fix task or annotation (marks annotation resolved_pending_review).",
    inputSchema: {
      type: "object",
      properties: {
        annotationId: { type: "string", description: "ID of the annotation to resolve." },
        taskId: { type: "string", description: "ID of the linked fix task (used if annotationId is omitted)." },
        resolution: { type: "string", description: "Resolution summary note." },
      },
    },
  },
  {
    name: "bf_debate_post",
    description: "Post a position message to an active debate.",
    inputSchema: {
      type: "object",
      properties: {
        debateId: { type: "string", description: "ID of the debate to post to." },
        position: { type: "string", description: "Position statement (max 4000 chars)." },
        evidence: { type: "string", description: "Optional supporting evidence for the position." },
      },
      required: ["debateId", "position"],
    },
  },
];

const TOOL_NAMES = new Set(MCP_TOOLS.map((t) => t.name));

// --- Config parsing ---

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const value = argv[i + 1];
      if (value === undefined) break;
      out[a.slice(2)] = value;
      i++;
    }
  }
  return out;
}

export function resolveConfig(argv: string[], env: Record<string, string | undefined>): BridgeConfig {
  const flags = parseFlags(argv);
  return {
    daemonUrl: flags["daemon-url"] || env.BOT_FACTORY_DAEMON_URL || DEFAULT_DAEMON_URL,
    token: flags["token"] || env.BOT_FACTORY_TOKEN || "",
    projectId: flags["project"] || env.BOT_FACTORY_PROJECT_ID || "",
    agentId: flags["agent"] || env.BOT_FACTORY_AGENT_ID || "",
  };
}

// --- Pure JSON-RPC handling (unit-testable without a subprocess) ---

function textResult(text: string, isError: boolean): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  return { content: [{ type: "text", text }], isError };
}

export async function handleMcpJsonRpcRequest(
  req: unknown,
  callTool: CallToolFn,
): Promise<JsonRpcResponse | null> {
  if (req === null || typeof req !== "object" || Array.isArray(req)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    };
  }
  const r = req as JsonRpcRequest;
  const id = r.id ?? null;
  if (r.jsonrpc !== "2.0" || typeof r.method !== "string") {
    return id === null
      ? null
      : { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
  }

  // Notifications (no id) never produce a response.
  if (id === null) {
    return null;
  }

  switch (r.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: MCP_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };
    case "tools/call": {
      const params = (r.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = params.name;
      if (typeof name !== "string" || !TOOL_NAMES.has(name)) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${String(name)}` },
        };
      }
      let args: Record<string, unknown> = {};
      if (params.arguments !== undefined && params.arguments !== null) {
        if (typeof params.arguments !== "object" || Array.isArray(params.arguments)) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid tool arguments" },
          };
        }
        args = params.arguments as Record<string, unknown>;
      }
      try {
        const result = await callTool(name, args);
        return {
          jsonrpc: "2.0",
          id,
          result: textResult(typeof result === "string" ? result : JSON.stringify(result, null, 2), false),
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          result: textResult(
            err instanceof Error ? err.message : String(err),
            true,
          ),
        };
      }
    }
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${r.method}` },
      };
  }
}

// --- Daemon HTTP client ---

export function makeDaemonCallTool(config: BridgeConfig): CallToolFn {
  return async (name, args) => {
    const url = `${config.daemonUrl.replace(/\/+$/, "")}/api/mcp/${name}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bf-token": config.token,
        },
        body: JSON.stringify({
          projectId: config.projectId,
          agentId: config.agentId,
          args,
        }),
        signal: AbortSignal.timeout(DAEMON_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `Daemon unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`Daemon ${name} failed: HTTP ${res.status} ${bodyText}`);
    }
    try {
      return JSON.parse(bodyText);
    } catch {
      return bodyText;
    }
  };
}

// --- stdio loop ---

export function startStdioLoop(callTool: CallToolFn, opts?: { exitOnEnd?: boolean }): void {
  let buffer = "";
  const inFlight = new Set<Promise<void>>();

  const lineHandler = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: unknown;
    try {
      req = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`mcpBridge: skipping non-JSON line: ${trimmed.slice(0, 200)}\n`);
      return;
    }
    const task = handleMcpJsonRpcRequest(req, callTool)
      .then((resp) => {
        if (resp !== null) {
          process.stdout.write(JSON.stringify(resp) + "\n");
        }
      })
      .catch((err: unknown) => {
        process.stderr.write(
          `mcpBridge: internal error handling request: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      lineHandler(line);
    }
  });
  process.stdin.on("end", () => {
    void (async () => {
      if (buffer.trim()) {
        lineHandler(buffer);
        buffer = "";
      }
      const keepalive = inFlight.size > 0 ? setInterval(() => {}, 50) : null;
      try {
        while (inFlight.size > 0) {
          await Promise.allSettled([...inFlight]);
        }
        await new Promise<void>((resolveFlush) => {
          if (process.stdout.writableFinished) {
            resolveFlush();
            return;
          }
          process.stdout.write("", () => resolveFlush());
        });
      } finally {
        if (keepalive) clearInterval(keepalive);
      }
      process.stderr.write("mcpBridge: stdin closed, exiting\n");
      if (opts?.exitOnEnd) {
        process.exit(0);
      }
    })();
  });
  process.stdin.on("error", (err: Error) => {
    process.stderr.write(`mcpBridge: stdin error: ${err.message}\n`);
  });
}

// --- Entry point ---

if (import.meta.main) {
  const config = resolveConfig(process.argv.slice(2), process.env);
  if (!config.token) {
    process.stderr.write(
      "mcpBridge: warning — no token configured (--token / BOT_FACTORY_TOKEN)\n",
    );
  }
  if (!config.projectId || !config.agentId) {
    process.stderr.write(
      "mcpBridge: warning — projectId/agentId not configured (--project/--agent or BOT_FACTORY_PROJECT_ID/BOT_FACTORY_AGENT_ID)\n",
    );
  }
  process.stderr.write(
    `mcpBridge: starting — daemon=${config.daemonUrl} project=${config.projectId || "(unset)"} agent=${config.agentId || "(unset)"}\n`,
  );
  startStdioLoop(makeDaemonCallTool(config), { exitOnEnd: true });
}
