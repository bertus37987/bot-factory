import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  AutonomyLevelSchema,
  MemoryKindSchema,
  MemoryL1TargetSchema,
  newId,
  ReasoningEffortSchema,
  TaskStatusSchema,
  VerifyCheckSchema,
  type AgentRecord,
  type AutonomyLevel,
  type MemoryKind,
  type ProjectRecord,
  type QuietStatusProjection,
  type ReasoningEffort,
  type RpcCommand,
  type SubscriptionTopic,
  type TaskRecord,
  type TimelineItem,
  type VerifyCheck,
} from "@bot-factory/shared";
import type { SecretScrubber } from "../config";
import type { CommandCore } from "../core/commandCore";
import type { StateDatabase } from "../db/database";
import { computeWorkspaceGitDiff, readSafeRepoFile } from "../git/worktrees";
import type { LocalSuperHermesMemory } from "../memory/memoryEngine";
import { isPathStrictlyWithinRoot } from "../runtimes/nativeHttpRuntime";
import type { ToolCallExecutor, ToolDefinition } from "../runtimes/types";
import type { AutonomyLoop } from "./autonomyLoop";

const SAFE_TREE_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "worktrees",
  ".bun",
  ".ssh",
  ".aws",
]);

function isSensitiveRepoBasename(name: string): boolean {
  const lower = name.toLowerCase().trim();
  return (
    lower === ".daemon-token" ||
    lower === ".ssh" ||
    lower === ".aws" ||
    lower === ".npmrc" ||
    lower === "config.json" ||
    lower === "secrets.env" ||
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower.endsWith(".pem") ||
    lower.startsWith(".pem") ||
    lower.endsWith(".key") ||
    lower.startsWith(".key") ||
    lower.endsWith(".db") ||
    lower.endsWith(".db-wal") ||
    lower.endsWith(".db-shm") ||
    lower.endsWith(".sqlite") ||
    lower === "id_rsa" ||
    lower.startsWith("id_rsa.") ||
    lower === "id_ed25519" ||
    lower.startsWith("id_ed25519.")
  );
}

export function isSensitiveRepoRelPath(relPath: string): boolean {
  return relPath
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => {
      const lower = segment.toLowerCase().trim();
      return (
        lower === ".git" ||
        lower === "node_modules" ||
        lower === ".ssh" ||
        lower === ".aws" ||
        isSensitiveRepoBasename(segment)
      );
    });
}

export interface RepoTreeEntry {
  path: string;
  type: "dir" | "file";
  sizeBytes?: number;
}

export function listRepoTreeSafe(
  repoRoot: string,
  maxDepth = 4,
  maxEntries = 400,
): { root: string; entries: RepoTreeEntry[]; truncated: boolean } {
  const boundedDepth = Number.isFinite(maxDepth) ? Math.max(1, Math.min(10, Math.trunc(maxDepth))) : 4;
  const boundedLimit = Number.isFinite(maxEntries) ? Math.max(1, Math.min(1000, Math.trunc(maxEntries))) : 400;
  const entries: RepoTreeEntry[] = [];
  let truncated = false;

  if (!repoRoot || !existsSync(repoRoot)) {
    return { root: repoRoot, entries, truncated };
  }
  const absRoot = resolve(repoRoot);

  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > boundedDepth) return;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }

    for (const d of dirents) {
      if (entries.length >= boundedLimit) {
        truncated = true;
        return;
      }
      if (d.isDirectory()) {
        if (SAFE_TREE_SKIP_DIRS.has(d.name.toLowerCase()) || isSensitiveRepoBasename(d.name)) continue;
      } else if (d.name.toLowerCase() === ".git" || isSensitiveRepoBasename(d.name)) {
        continue;
      }

      const full = join(dir, d.name);
      const relPosix = relative(absRoot, full).split(sep).join("/");
      if (!relPosix || isSensitiveRepoRelPath(relPosix)) continue;
      if (!isPathStrictlyWithinRoot(absRoot, relPosix).ok) continue;

      try {
        const lst = lstatSync(full);
        if (lst.isSymbolicLink()) continue;
        if (lst.isDirectory()) {
          entries.push({ path: relPosix, type: "dir" });
          if (depth < boundedDepth) {
            walk(full, depth + 1);
          }
        } else if (lst.isFile()) {
          entries.push({ path: relPosix, type: "file", sizeBytes: statSync(full).size });
        }
      } catch {
        // Skip unreadable entry
      }
    }
  };

  walk(absRoot, 1);
  return { root: absRoot, entries, truncated };
}

export interface MainManagerToolContext {
  db: StateDatabase;
  core: CommandCore;
  memory: LocalSuperHermesMemory;
  scrubber: SecretScrubber;
  autonomyLoop: AutonomyLoop;
  metaAgentId: string;
  executeCommand: (cmd: RpcCommand) => unknown;
  getQuietStatusProjection: () => QuietStatusProjection;
  getProjectBoardSnapshot: (projectId: string) => unknown;
}

export interface TeamLeadToolContext {
  db: StateDatabase;
  core: CommandCore;
  memory: LocalSuperHermesMemory;
  scrubber: SecretScrubber;
  autonomyLoop: AutonomyLoop;
  pmAgent: AgentRecord;
  project: ProjectRecord;
  metaAgentId: string;
  executeCommand: (cmd: RpcCommand) => unknown;
  getQuietStatusProjection: () => QuietStatusProjection;
  getProjectBoardSnapshot: (projectId: string) => unknown;
}

export const MAIN_MANAGER_TOOL_DEFS: ToolDefinition[] = [
  {
    name: "bf_projects_list",
    description: "List all managed Bot-Factory projects with status, paths, and verification checks.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
  {
    name: "bf_project_create",
    description: "Provision a new Bot-Factory project workspace, git repository, and Engineering Team Lead.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project display name." },
        slug: { type: "string", description: "Optional short slug." },
        externalRepoPath: { type: "string", description: "Optional existing local Git repo path to manage." },
        seedDemoArtifacts: { type: "boolean", description: "Whether to seed starter preview artifacts (default true)." },
        verifyChecks: {
          type: "array",
          description: "Optional project verification shell commands.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              cmd: { type: "string" },
              timeoutMs: { type: "number" },
            },
            required: ["name", "cmd"],
          },
        },
      },
      required: ["name"],
    },
  },
  {
    name: "bf_team_delegate",
    description: "Delegate a high-level engineering goal to a project's Engineering Team Lead with autonomous tracking.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID or slug." },
        goal: { type: "string", description: "Clear goal description and acceptance criteria." },
        autonomyLevel: { type: "string", enum: ["spec", "low", "medium", "high"] },
        reasoningEffort: { type: "string", enum: ["low", "medium", "high", "max"] },
        verifyChecks: {
          type: "array",
          description: "Optional updated verify commands for this project.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              cmd: { type: "string" },
              timeoutMs: { type: "number" },
            },
            required: ["name", "cmd"],
          },
        },
      },
      required: ["projectId", "goal"],
    },
  },
  {
    name: "bf_team_status",
    description: "Get live status of Team Lead, peer bots, subagents, tasks/DAG, goals, verifications, debates, and inbox notices.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Optional project ID or slug filter." },
      },
    },
  },
  {
    name: "bf_memory_search",
    description: "Search global or project hybrid memory (vector + FTS5 + graph).",
    parametersJsonSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text." },
        scope: { type: "string", description: "'global' (default), 'project', or 'project:<slug>'." },
        projectId: { type: "string", description: "Project ID/slug when scope is 'project'." },
        limit: { type: "number", description: "Max facts to return (default 8)." },
      },
      required: ["query"],
    },
  },
  {
    name: "bf_memory_remember",
    description: "Persist a durable fact, preference, decision, or episode into live memory.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        factText: { type: "string", description: "Fact text to store." },
        kind: { type: "string", enum: ["fact", "preference", "decision", "episode"] },
        entity: { type: "string", description: "Optional entity tag (default 'general')." },
        isStatic: { type: "boolean", description: "Whether to include in Always-On static profile." },
        scope: { type: "string", description: "'global' (default), 'project', or 'project:<slug>'." },
        projectId: { type: "string", description: "Project ID/slug when scope is 'project'." },
      },
      required: ["factText", "kind"],
    },
  },
  {
    name: "bf_memory_update_l1",
    description: "Update an L1 curated memory markdown file ('user', 'global', or 'project').",
    parametersJsonSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["user", "global", "project"] },
        projectId: { type: "string", description: "Required when target is 'project'." },
        content: { type: "string", description: "Full replacement markdown within L1 char budget." },
      },
      required: ["target", "content"],
    },
  },
  {
    name: "bf_memory_forget",
    description: "Mark a memory fact as forgotten with an audit reason.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        factId: { type: "string", description: "Memory fact ID." },
        reason: { type: "string", description: "Reason for forgetting." },
      },
      required: ["factId", "reason"],
    },
  },
];

export const TEAM_LEAD_TOOL_DEFS: ToolDefinition[] = [
  {
    name: "bf_repo_tree",
    description: "List the project repository file tree (strictly read-only, sensitive files redacted/excluded).",
    parametersJsonSchema: {
      type: "object",
      properties: {
        maxDepth: { type: "number", description: "Maximum directory depth (1-10, default 4)." },
      },
    },
  },
  {
    name: "bf_repo_read",
    description: "Read a file inside the project repository (strictly read-only with optional 1-based line range).",
    parametersJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative POSIX path inside the repository." },
        startLine: { type: "number", description: "Optional 1-indexed start line." },
        endLine: { type: "number", description: "Optional 1-indexed end line (inclusive)." },
      },
      required: ["path"],
    },
  },
  {
    name: "bf_repo_diff",
    description: "Inspect git diff for the project repository or a specific bot worktree.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Optional peer bot ID to inspect its isolated worktree diff." },
      },
    },
  },
  {
    name: "bf_task_create_batch",
    description: "Create a DAG batch of tasks with mapped dependency keys in one atomic operation.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "Batch-local unique task key for dependency mapping." },
              title: { type: "string", description: "Short task title." },
              specMd: { type: "string", description: "Detailed markdown specification." },
              priority: { type: "number", description: "Priority 1 (highest) to 5 (default 3)." },
              dependsOnKeys: {
                type: "array",
                items: { type: "string" },
                description: "Keys from this batch (or existing task IDs) that must verify before dispatch.",
              },
            },
            required: ["key", "title", "specMd"],
          },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "bf_task_update",
    description: "Update a task's status, specification, or priority in this project.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        status: { type: "string", enum: ["backlog", "ready", "claimed", "in_review", "verified", "merged", "blocked"] },
        specMd: { type: "string" },
        priority: { type: "number" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "bf_bot_spawn",
    description: "Spawn a new peer coding bot with its own isolated Git worktree in this project.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        autonomyLevel: { type: "string", enum: ["spec", "low", "medium", "high"] },
      },
      required: ["name"],
    },
  },
  {
    name: "bf_task_dispatch",
    description: "Dispatch a ready task (with all dependencies verified/merged) to an idle peer bot.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        agentId: { type: "string" },
        autonomous: { type: "boolean" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "bf_bot_message",
    description: "Send guidance or follow-up instructions to a peer bot in this project.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        message: { type: "string" },
      },
      required: ["agentId", "message"],
    },
  },
  {
    name: "bf_task_verify_trigger",
    description: "Trigger independent cross-family verification for a task.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        checks: { type: "array", items: { type: "string" } },
      },
      required: ["taskId"],
    },
  },
  {
    name: "bf_debate_resolve",
    description: "Resolve an open or escalated peer debate with a binding decision.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        debateId: { type: "string" },
        decision: { type: "string" },
      },
      required: ["debateId", "decision"],
    },
  },
  {
    name: "bf_report_to_manager",
    description: "Report milestone, completion, or blocker status back to the Main Managing Agent.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["milestone", "completed", "blocked"] },
        summary: { type: "string" },
        verifiedTaskIds: { type: "array", items: { type: "string" } },
        blockedReasons: { type: "array", items: { type: "string" } },
      },
      required: ["status", "summary"],
    },
  },
];

function resolveMemoryNamespace(
  db: StateDatabase,
  scopeArg: unknown,
  projectIdArg: unknown,
  defaultNs: string,
): string {
  const scope = typeof scopeArg === "string" ? scopeArg.trim() : "";
  if (!scope) return defaultNs;
  if (scope === "global") return "global";
  if (scope.startsWith("project:")) return scope;
  if (scope === "project") {
    const pid = typeof projectIdArg === "string" ? projectIdArg.trim() : "";
    if (!pid) return defaultNs.startsWith("project:") ? defaultNs : "global";
    const project = db.getProject(pid);
    if (!project) throw new Error(`project_not_found:${pid}`);
    return `project:${project.slug}`;
  }
  return defaultNs;
}

function validateVerifyChecks(raw: unknown): VerifyCheck[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error("invalid_verify_checks");
  return raw.map((item) => VerifyCheckSchema.parse(item));
}

export function createMainManagerToolExecutor(ctx: MainManagerToolContext): ToolCallExecutor {
  return async ({ name, args }) => {
    switch (name) {
      case "bf_projects_list": {
        const projects = ctx.db.listProjects().map((p) => ({
          id: p.id,
          slug: p.slug,
          name: p.name,
          status: p.status,
          repoPath: ctx.scrubber.scrub(p.repoPath),
          rootPath: ctx.scrubber.scrub(p.rootPath),
          verifyChecks: p.verifyChecks ?? [],
          createdAt: p.createdAt,
        }));
        return { projects };
      }
      case "bf_project_create": {
        const projName = typeof args.name === "string" ? args.name.trim() : "";
        if (!projName) throw new Error("project_name_required");
        const verifyChecks = validateVerifyChecks(args.verifyChecks);
        return ctx.executeCommand({
          commandId: newId("cmd"),
          type: "project.create",
          name: projName,
          slug: typeof args.slug === "string" && args.slug.trim() ? args.slug.trim() : undefined,
          externalRepoPath:
            typeof args.externalRepoPath === "string" && args.externalRepoPath.trim()
              ? args.externalRepoPath.trim()
              : undefined,
          seedDemoArtifacts: typeof args.seedDemoArtifacts === "boolean" ? args.seedDemoArtifacts : undefined,
          verifyChecks,
        });
      }
      case "bf_team_delegate": {
        const rawProjectId = typeof args.projectId === "string" ? args.projectId.trim() : "";
        const rawGoal = typeof args.goal === "string" ? args.goal.trim() : "";
        if (!rawProjectId || !rawGoal) throw new Error("projectId_and_goal_required");

        const project = ctx.db.getProject(rawProjectId);
        if (!project) throw new Error(`Project not found: ${rawProjectId}`);
        const pm = ctx.db.listAgents(project.id).find((a) => a.scope === "project" && a.status !== "stopped");
        if (!pm) throw new Error(`Project Manager missing for project: ${project.id}`);

        const autonomyLevel =
          args.autonomyLevel !== undefined ? AutonomyLevelSchema.parse(args.autonomyLevel) : undefined;
        const reasoningEffort =
          args.reasoningEffort !== undefined ? ReasoningEffortSchema.parse(args.reasoningEffort) : undefined;
        const verifyChecks = validateVerifyChecks(args.verifyChecks);
        const cleanGoal = ctx.scrubber.scrub(rawGoal);

        if (verifyChecks) {
          ctx.db.runAtomicWrite(() => {
            ctx.db.db
              .query("UPDATE projects SET verify_checks_json = ? WHERE id = ?")
              .run(JSON.stringify(verifyChecks), project.id);
          });
        }

        const goalCtx = ctx.autonomyLoop.startGoal({
          projectId: project.id,
          goal: cleanGoal,
          autonomyLevel,
          reasoningEffort,
        });

        const now = Date.now();
        const cardPayload = {
          id: newId("card"),
          projectId: project.id,
          goalId: goalCtx.goalId,
          kind: "delegation",
          title: `Delegated goal to ${project.name} Team Lead`,
          subtitle: cleanGoal.slice(0, 160),
          autonomyLevel: autonomyLevel ?? "high",
          reasoningEffort: reasoningEffort ?? "medium",
          createdAt: now,
        };

        const pmTimelineItem: TimelineItem | null = pm.activeSessionId
          ? {
              id: newId("msg"),
              agentId: pm.id,
              sessionId: pm.activeSessionId,
              seq: 0,
              kind: "steer",
              role: "user",
              title: `Main Manager Delegation (${goalCtx.goalId})`,
              content: cleanGoal,
              createdAt: now,
            }
          : null;

        ctx.core.commitCommand(newId("cmd"), "team.delegate", () => ({
          result: { ok: true, goalId: goalCtx.goalId, projectId: project.id, pmAgentId: pm.id, status: goalCtx.status },
          applyProjections: () => {
            if (pmTimelineItem) ctx.db.appendMessage(pmTimelineItem);
            ctx.db.updateAgentStatus(pm.id, "working", {
              lastSummary: `Planning goal: ${cleanGoal.slice(0, 60)}`,
            });
            ctx.db.addInboxNotice("info", `Delegated goal to ${project.name} Team Lead`, {
              projectId: project.id,
              agentId: pm.id,
            });
          },
          events: [
            { topic: "chat:meta", eventType: "chat.artifact_card", payload: cardPayload },
            ...(pmTimelineItem
              ? [{ topic: `bot:${pm.id}:timeline` as SubscriptionTopic, eventType: "timeline.item", payload: pmTimelineItem }]
              : []),
            { topic: `project:${project.id}:board`, eventType: "board.updated", payload: ctx.getProjectBoardSnapshot(project.id) },
            { topic: "global:status", eventType: "status.updated", payload: ctx.getQuietStatusProjection() },
          ],
          effects: [
            {
              effectType: "pm.goal.turn",
              payload: {
                projectId: project.id,
                pmAgentId: pm.id,
                goalId: goalCtx.goalId,
                goal: cleanGoal,
                ...(autonomyLevel ? { autonomyLevel } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
              },
            },
          ],
        }));

        return {
          ok: true,
          goalId: goalCtx.goalId,
          projectId: project.id,
          pmAgentId: pm.id,
          status: goalCtx.status,
        };
      }
      case "bf_team_status": {
        const filterPid = typeof args.projectId === "string" && args.projectId.trim() ? args.projectId.trim() : null;
        const projects = filterPid
          ? (() => {
              const p = ctx.db.getProject(filterPid);
              return p ? [p] : [];
            })()
          : ctx.db.listProjects();

        const teams = projects.map((project) => {
          const agents = ctx.db.listAgents(project.id);
          const tasks = ctx.db.listTasks(project.id);
          const debates = ctx.db.listDebates(project.id).filter((d) => d.status !== "resolved");
          const verifications = ctx.db.listVerifications({ projectId: project.id, limit: 10 });
          const goals = ctx.autonomyLoop.listGoals(project.id);
          return {
            project: { id: project.id, slug: project.slug, name: project.name, status: project.status },
            pm: agents.find((a) => a.scope === "project") ?? null,
            peers: agents.filter((a) => a.scope === "peer"),
            subagents: agents.filter((a) => a.scope === "sidekick"),
            tasks,
            goals,
            verifications,
            openDebates: debates,
          };
        });

        return {
          quietStatus: ctx.getQuietStatusProjection(),
          teams,
        };
      }
      case "bf_memory_search": {
        const query = typeof args.query === "string" ? args.query : "";
        const rawLimit = Number(args.limit ?? 8);
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 50) : 8;
        const ns = resolveMemoryNamespace(ctx.db, args.scope, args.projectId, "global");
        return await ctx.memory.hybridSearch(ns, query, limit);
      }
      case "bf_memory_remember": {
        const factText = typeof args.factText === "string" ? args.factText : "";
        const kind = MemoryKindSchema.parse(args.kind ?? "fact") as MemoryKind;
        const entity = typeof args.entity === "string" ? args.entity : undefined;
        const isStatic = typeof args.isStatic === "boolean" ? args.isStatic : undefined;
        const ns = resolveMemoryNamespace(ctx.db, args.scope, args.projectId, "global");
        return ctx.memory.rememberFact({ namespace: ns, factText, kind, entity, isStatic });
      }
      case "bf_memory_update_l1": {
        const target = MemoryL1TargetSchema.parse(args.target);
        const content = typeof args.content === "string" ? args.content : "";
        const projectId = typeof args.projectId === "string" ? args.projectId.trim() : undefined;
        return ctx.executeCommand({
          commandId: newId("cmd"),
          type: "memory.l1.update",
          target,
          projectId,
          content,
        });
      }
      case "bf_memory_forget": {
        const factId = typeof args.factId === "string" ? args.factId.trim() : "";
        const reason = typeof args.reason === "string" ? args.reason : "forgotten_by_manager";
        if (!factId) throw new Error("factId_required");
        const forgotten = ctx.memory.forgetFact(factId, reason);
        return { factId, forgotten };
      }
      default:
        throw new Error(`unknown_main_manager_tool:${name}`);
    }
  };
}

export function createTeamLeadToolExecutor(ctx: TeamLeadToolContext): ToolCallExecutor {
  const { project, pmAgent } = ctx;
  const repoRoot = pmAgent.worktreePath && existsSync(pmAgent.worktreePath) ? pmAgent.worktreePath : project.repoPath;

  return async ({ name, args }) => {
    switch (name) {
      case "bf_repo_tree": {
        const rawDepth = typeof args.maxDepth === "number" ? args.maxDepth : 4;
        const tree = listRepoTreeSafe(repoRoot, rawDepth, 400);
        return {
          root: ctx.scrubber.scrub(tree.root),
          entries: tree.entries.map((e) => ({
            ...e,
            path: ctx.scrubber.scrub(e.path),
          })),
          truncated: tree.truncated,
        };
      }
      case "bf_repo_read": {
        const relPath = typeof args.path === "string" ? args.path.trim() : "";
        if (!relPath) throw new Error("path_required");
        const read = readSafeRepoFile(repoRoot, relPath, (s) => ctx.scrubber.scrub(s));
        const lines = read.content.split(/\r?\n/);
        const totalLines = lines.length;
        const startLine =
          typeof args.startLine === "number" && Number.isFinite(args.startLine)
            ? Math.max(1, Math.trunc(args.startLine))
            : 1;
        const endLine =
          typeof args.endLine === "number" && Number.isFinite(args.endLine)
            ? Math.min(totalLines, Math.max(startLine, Math.trunc(args.endLine)))
            : totalLines;
        const sliced = ctx.scrubber.scrub(lines.slice(startLine - 1, endLine).join("\n")).slice(0, 24_000);
        return {
          path: read.relativePath,
          startLine,
          endLine,
          totalLines,
          sizeBytes: read.sizeBytes,
          content: sliced,
        };
      }
      case "bf_repo_diff": {
        const agentId = typeof args.agentId === "string" && args.agentId.trim() ? args.agentId.trim() : undefined;
        let diffRoot = repoRoot;
        if (agentId) {
          const bot = ctx.db.getAgent(agentId);
          if (!bot) throw new Error(`Agent not found: ${agentId}`);
          if (bot.projectId !== project.id) throw new Error("agent_project_mismatch");
          diffRoot = bot.worktreePath && existsSync(bot.worktreePath) ? bot.worktreePath : repoRoot;
        }
        return await computeWorkspaceGitDiff(diffRoot, (t) => ctx.scrubber.scrub(t));
      }
      case "bf_task_create_batch": {
        const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
        if (rawTasks.length === 0) throw new Error("tasks_array_required");

        interface BatchSpec {
          key: string;
          title: string;
          specMd: string;
          priority: number;
          dependsOnKeys: string[];
        }
        const parsedSpecs: BatchSpec[] = [];
        const keyToId = new Map<string, string>();
        for (const item of rawTasks) {
          if (!item || typeof item !== "object") throw new Error("invalid_task_item");
          const obj = item as Record<string, unknown>;
          const key = typeof obj.key === "string" ? obj.key.trim() : "";
          const title = typeof obj.title === "string" ? obj.title.trim() : "";
          const specMd = typeof obj.specMd === "string" ? obj.specMd : "";
          const rawPrio = typeof obj.priority === "number" && Number.isFinite(obj.priority) ? Math.trunc(obj.priority) : 3;
          const priority = Math.max(1, Math.min(5, rawPrio));
          const dependsOnKeys = Array.isArray(obj.dependsOnKeys)
            ? obj.dependsOnKeys.map((k) => String(k).trim()).filter(Boolean)
            : [];
          if (!key || !title) throw new Error("task_key_and_title_required");
          if (keyToId.has(key)) throw new Error(`duplicate_batch_task_key:${key}`);
          keyToId.set(key, newId("tsk"));
          parsedSpecs.push({ key, title, specMd, priority, dependsOnKeys });
        }

        // Validate dependencies & detect cycles
        const depsByKey = new Map<string, string[]>();
        for (const spec of parsedSpecs) {
          depsByKey.set(spec.key, spec.dependsOnKeys);
          for (const dep of spec.dependsOnKeys) {
            if (keyToId.has(dep)) continue;
            const existingTask = ctx.db.getTask(dep);
            if (!existingTask || existingTask.projectId !== project.id) {
              throw new Error(`unknown_dependency_key:${dep}`);
            }
          }
        }
        const visitState = new Map<string, 1 | 2>();
        const checkCycle = (key: string): void => {
          const state = visitState.get(key);
          if (state === 1) throw new Error(`task_dependency_cycle_detected:${key}`);
          if (state === 2) return;
          visitState.set(key, 1);
          for (const dep of depsByKey.get(key) ?? []) {
            if (keyToId.has(dep)) checkCycle(dep);
          }
          visitState.set(key, 2);
        };
        for (const spec of parsedSpecs) {
          checkCycle(spec.key);
        }

        const now = Date.now();
        const createdTasks: TaskRecord[] = parsedSpecs.map((spec) => ({
          id: keyToId.get(spec.key)!,
          projectId: project.id,
          parentTaskId: null,
          title: ctx.scrubber.scrub(spec.title),
          specMd: ctx.scrubber.scrub(spec.specMd),
          status: "ready",
          priority: spec.priority,
          assignedAgentId: null,
          sourceAnnotationId: null,
          worktreeBranch: null,
          handoffPath: null,
          retryCount: 0,
          dependsOn: spec.dependsOnKeys.map((k) => keyToId.get(k) ?? k),
          autoRetryCount: 0,
          createdAt: now,
          updatedAt: now,
        }));

        ctx.core.commitCommand(newId("cmd"), "task.create_batch", () => ({
          result: { tasks: createdTasks, keyToTaskId: Object.fromEntries(keyToId.entries()) },
          applyProjections: () => {
            for (const task of createdTasks) {
              ctx.db.upsertTask(task);
            }
          },
          events: [
            ...createdTasks.map((task) => ({
              topic: `project:${project.id}:board` as SubscriptionTopic,
              eventType: "task.created",
              payload: task,
            })),
            {
              topic: `project:${project.id}:board`,
              eventType: "board.updated",
              payload: ctx.getProjectBoardSnapshot(project.id),
            },
          ],
          effects: [],
        }));

        ctx.autonomyLoop.attachTasks(
          project.id,
          createdTasks.map((t) => t.id),
        );

        return {
          tasks: createdTasks,
          keyToTaskId: Object.fromEntries(keyToId.entries()),
        };
      }
      case "bf_task_update": {
        const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
        if (!taskId) throw new Error("taskId_required");
        const existing = ctx.db.getTask(taskId);
        if (!existing) throw new Error(`Task not found: ${taskId}`);
        if (existing.projectId !== project.id) throw new Error("task_project_mismatch");

        const nextStatus = args.status !== undefined ? TaskStatusSchema.parse(args.status) : existing.status;
        const nextSpecMd =
          typeof args.specMd === "string" ? ctx.scrubber.scrub(args.specMd) : existing.specMd;
        const nextPriority =
          typeof args.priority === "number" && Number.isFinite(args.priority)
            ? Math.max(1, Math.min(5, Math.trunc(args.priority)))
            : existing.priority;

        const updated: TaskRecord = {
          ...existing,
          status: nextStatus,
          specMd: nextSpecMd,
          priority: nextPriority,
          updatedAt: Date.now(),
        };

        return ctx.core.commitCommand(newId("cmd"), "task.update", () => ({
          result: { task: updated },
          applyProjections: () => {
            ctx.db.upsertTask(updated);
          },
          events: [
            { topic: `project:${project.id}:board`, eventType: "task.updated", payload: updated },
            { topic: `project:${project.id}:board`, eventType: "board.updated", payload: ctx.getProjectBoardSnapshot(project.id) },
          ],
          effects: [],
        }));
      }
      case "bf_bot_spawn": {
        const botName = typeof args.name === "string" ? args.name.trim() : "";
        if (!botName) throw new Error("bot_name_required");
        const autonomyLevel =
          args.autonomyLevel !== undefined ? AutonomyLevelSchema.parse(args.autonomyLevel) : undefined;
        const res = ctx.executeCommand({
          commandId: newId("cmd"),
          type: "bot.spawn",
          projectId: project.id,
          name: botName,
          scope: "peer",
          provider: typeof args.provider === "string" && args.provider.trim() ? args.provider.trim() : undefined,
          model: typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined,
          autonomyLevel,
        }) as { agent: AgentRecord };

        if (typeof args.role === "string" && args.role.trim()) {
          const cleanRole = ctx.scrubber.scrub(args.role.trim());
          ctx.db.runAtomicWrite(() => {
            ctx.db.updateAgentStatus(res.agent.id, res.agent.status, {
              lastSummary: `Role: ${cleanRole.slice(0, 70)}`,
            });
          });
          res.agent = ctx.db.getAgent(res.agent.id) ?? res.agent;
        }
        return res;
      }
      case "bf_task_dispatch": {
        const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
        if (!taskId) throw new Error("taskId_required");
        const task = ctx.db.getTask(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        if (task.projectId !== project.id) throw new Error("task_project_mismatch");

        const unmetDeps = (task.dependsOn ?? []).filter((depId) => {
          const dep = ctx.db.getTask(depId);
          return !dep || (dep.status !== "verified" && dep.status !== "merged");
        });
        if (unmetDeps.length > 0) {
          throw new Error(`task_dependencies_unmet:${unmetDeps.join(",")}`);
        }

        const autonomous =
          typeof args.autonomous === "boolean" ? args.autonomous : ctx.autonomyLoop.hasActiveGoal(project.id);
        return ctx.executeCommand({
          commandId: newId("cmd"),
          type: "task.dispatch",
          projectId: project.id,
          taskId: task.id,
          agentId: typeof args.agentId === "string" && args.agentId.trim() ? args.agentId.trim() : undefined,
          autonomous,
        });
      }
      case "bf_bot_message": {
        const agentId = typeof args.agentId === "string" ? args.agentId.trim() : "";
        const rawMsg = typeof args.message === "string" ? args.message.trim() : "";
        if (!agentId || !rawMsg) throw new Error("agentId_and_message_required");
        const bot = ctx.db.getAgent(agentId);
        if (!bot) throw new Error(`Agent not found: ${agentId}`);
        if (bot.projectId !== project.id) throw new Error("agent_project_mismatch");
        if (bot.scope !== "peer" && bot.scope !== "sidekick") {
          throw new Error(`agent_invalid_scope:${bot.scope}`);
        }
        if (bot.status === "stopped" || bot.status === "paused") {
          throw new Error(`agent_unavailable:${bot.status}`);
        }
        if (!bot.activeSessionId) throw new Error("agent_session_missing");

        const cleanMessage = ctx.scrubber.scrub(rawMsg);
        const item: TimelineItem = {
          id: newId("msg"),
          agentId: bot.id,
          sessionId: bot.activeSessionId,
          seq: 0,
          kind: "steer",
          role: "user",
          title: "Team Lead Message",
          content: cleanMessage,
          createdAt: Date.now(),
        };

        return ctx.core.commitCommand(newId("cmd"), "bot.message", () => ({
          result: { queued: true, agentId: bot.id, messageId: item.id },
          applyProjections: () => {
            ctx.db.appendMessage(item);
            ctx.db.updateAgentStatus(bot.id, "working", {
              lastSummary: `PM guidance: ${cleanMessage.slice(0, 60)}`,
            });
          },
          events: [
            { topic: `bot:${bot.id}:timeline`, eventType: "timeline.item", payload: item },
            { topic: "global:status", eventType: "status.updated", payload: ctx.getQuietStatusProjection() },
          ],
          effects: [
            {
              effectType: "bot.message.turn",
              payload: { projectId: project.id, agentId: bot.id, message: cleanMessage },
            },
          ],
        }));
      }
      case "bf_task_verify_trigger": {
        const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
        if (!taskId) throw new Error("taskId_required");
        const checks = Array.isArray(args.checks) ? args.checks.map((c) => String(c)) : undefined;
        return ctx.executeCommand({
          commandId: newId("cmd"),
          type: "task.verify",
          projectId: project.id,
          taskId,
          checks,
        });
      }
      case "bf_debate_resolve": {
        const debateId = typeof args.debateId === "string" ? args.debateId.trim() : "";
        const decision = typeof args.decision === "string" ? args.decision.trim() : "";
        if (!debateId || !decision) throw new Error("debateId_and_decision_required");
        const debate = ctx.db.getDebate(debateId);
        if (!debate) throw new Error(`Debate not found: ${debateId}`);
        if (debate.projectId !== project.id) throw new Error("debate_project_mismatch");
        return ctx.executeCommand({
          commandId: newId("cmd"),
          type: "debate.resolve",
          debateId,
          decision,
          resolvedByAgentId: pmAgent.id,
        });
      }
      case "bf_report_to_manager": {
        const rawStatus = typeof args.status === "string" ? args.status : "";
        if (rawStatus !== "milestone" && rawStatus !== "completed" && rawStatus !== "blocked") {
          throw new Error("invalid_report_status");
        }
        const status = rawStatus as "milestone" | "completed" | "blocked";
        const rawSummary = typeof args.summary === "string" ? args.summary.trim() : "";
        if (!rawSummary) throw new Error("summary_required");

        const cleanSummary = ctx.scrubber.scrub(rawSummary);
        const verifiedTaskIds = Array.isArray(args.verifiedTaskIds)
          ? args.verifiedTaskIds.map((id) => String(id).trim()).filter(Boolean)
          : [];
        const blockedReasons = Array.isArray(args.blockedReasons)
          ? args.blockedReasons.map((r) => ctx.scrubber.scrub(String(r).trim())).filter(Boolean)
          : [];

        const goalCtx = ctx.autonomyLoop.markGoalReported(project.id, status);
        const reportContent = [
          `Team Lead Report (${project.name} / ${status.toUpperCase()})`,
          `Summary: ${cleanSummary}`,
          verifiedTaskIds.length > 0 ? `Verified Tasks: ${verifiedTaskIds.join(", ")}` : "",
          blockedReasons.length > 0 ? `Blocked Reasons: ${blockedReasons.join("; ")}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        try {
          await ctx.memory.ingestDocument({
            docId: `report:${project.id}:${Date.now()}`,
            namespace: "global",
            content: reportContent,
            instant: true,
          });
          await ctx.memory.ingestDocument({
            docId: `report:${project.id}:proj:${Date.now()}`,
            namespace: `project:${project.slug}`,
            content: reportContent,
            instant: true,
          });
        } catch {
          // Fail-open memory ingestion
        }

        const reportPayload = {
          projectId: project.id,
          projectName: project.name,
          pmAgentId: pmAgent.id,
          goalId: goalCtx?.goalId ?? null,
          status,
          summary: cleanSummary,
          verifiedTaskIds,
          blockedReasons,
          reportedAt: Date.now(),
        };

        return ctx.core.commitCommand(newId("cmd"), "pm.report_to_manager", () => ({
          result: { ok: true, ...reportPayload },
          applyProjections: () => {
            ctx.db.addInboxNotice(
              status === "blocked" ? "action" : "info",
              `${project.name} Team Lead reported '${status}': ${cleanSummary.slice(0, 120)}`,
              { projectId: project.id, agentId: pmAgent.id },
            );
          },
          events: [
            { topic: `project:${project.id}:board`, eventType: "goal.reported", payload: reportPayload },
            { topic: `project:${project.id}:board`, eventType: "board.updated", payload: ctx.getProjectBoardSnapshot(project.id) },
            { topic: "global:status", eventType: "status.updated", payload: ctx.getQuietStatusProjection() },
          ],
          effects: [
            {
              effectType: "meta.team_report",
              payload: reportPayload,
            },
          ],
        }));
      }
      default:
        throw new Error(`unknown_team_lead_tool:${name}`);
    }
  };
}

export function getMainManagerTools(ctx: MainManagerToolContext): {
  tools: ToolDefinition[];
  onToolCall: ToolCallExecutor;
} {
  return {
    tools: MAIN_MANAGER_TOOL_DEFS,
    onToolCall: createMainManagerToolExecutor(ctx),
  };
}

export function getTeamLeadTools(ctx: TeamLeadToolContext): {
  tools: ToolDefinition[];
  onToolCall: ToolCallExecutor;
} {
  return {
    tools: TEAM_LEAD_TOOL_DEFS,
    onToolCall: createTeamLeadToolExecutor(ctx),
  };
}
