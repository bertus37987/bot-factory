import { z } from "zod";

// --- Hub & Provider Config ---

export const RuntimeKindSchema = z.enum(["native_http", "acp_stdio", "cli_stream"]);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

export const ProviderProtocolSchema = z.enum(["openai_compatible", "google_gemini", "anthropic"]);
export type ProviderProtocol = z.infer<typeof ProviderProtocolSchema>;

export const CliStreamAdapterSchema = z.enum(["claude", "codex"]);
export type CliStreamAdapter = z.infer<typeof CliStreamAdapterSchema>;

export const AutonomyLevelSchema = z.enum(["spec", "low", "medium", "high"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

export const ReasoningEffortSchema = z.enum(["low", "medium", "high", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const SubagentModeSchema = z.enum(["readonly", "code"]);
export type SubagentMode = z.infer<typeof SubagentModeSchema>;

export const ModelEntrySchema = z.object({
  id: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  tier: z.enum(["flagship", "balanced", "fast"]).default("balanced"),
});
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

export const ProviderConfigSchema = z.object({
  runtime: RuntimeKindSchema,
  protocol: ProviderProtocolSchema.optional(),
  adapter: CliStreamAdapterSchema.optional(),
  baseUrl: z
    .string()
    .url()
    .refine(
      (val) => {
        try {
          const parsed = new URL(val);
          return parsed.protocol === "http:" || parsed.protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "baseUrl must use http:// or https://" },
    )
    .optional(),
  apiKeyEnv: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  embeddingModel: z.string().optional(),
  models: z.record(z.string(), ModelEntrySchema),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const RouteTargetSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type RouteTarget = z.infer<typeof RouteTargetSchema>;

export const HubConfigSchema = z.object({
  version: z.string().default("1.0"),
  hub: z.object({
    rootDir: z.string().default("~/bot-factory"),
    host: z.literal("127.0.0.1").default("127.0.0.1"),
    port: z
      .number()
      .int()
      .refine((p) => p === 0 || (p >= 1024 && p <= 65535), {
        message: "Port must be 0 (ephemeral) or between 1024 and 65535",
      })
      .default(4310),
    dbPath: z.string().default("~/bot-factory/system/state.db"),
    secretsEnvPath: z.string().default("~/bot-factory/system/secrets.env"),
    defaultProjectsDir: z.string().default("~/bot-factory/projects"),
  }),
  providers: z.record(z.string(), ProviderConfigSchema),
  routing: z.object({
    policy: z.enum(["task_adaptive", "manual"]).default("task_adaptive"),
    allowPerProjectOverride: z.boolean().default(true),
    allowPerTaskOverride: z.boolean().default(true),
    defaultsByIntent: z.record(z.string(), RouteTargetSchema),
    crossFamilyVerification: z.boolean().default(true),
  }),
  memory: z.object({
    provider: z.string().default("local_sqlite_superhermes"),
    l1Files: z.object({
      globalUser: z.object({ file: z.string(), maxChars: z.number().int().positive() }),
      globalMemory: z.object({ file: z.string(), maxChars: z.number().int().positive() }),
      projectMemory: z.object({ file: z.string(), maxChars: z.number().int().positive() }),
    }),
    pluginPromptCaps: z.object({
      maxCharsPerBlock: z.number().int().positive().default(4000),
      maxCharsTotal: z.number().int().positive().default(8000),
    }),
    dreaming: z.object({
      mode: z.enum(["dynamic", "instant"]).default("dynamic"),
      debounceSeconds: z.number().int().min(1).default(20),
      maxBatchDocs: z.number().int().min(1).default(8),
      modelIntent: z.string().default("memory_dreaming"),
    }),
    graphMaxHops: z.number().int().min(1).max(3).default(3),
    defaultDecaySweepIntervalMinutes: z.number().int().min(1).default(30),
    embeddings: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
      })
      .optional(),
  }),
  guardrails: z.object({
    maxConcurrentBotsPerProject: z.number().int().min(1).default(4),
    maxDebateRounds: z.number().int().min(1).max(10).default(3),
    maxAnnotationFixRetries: z.number().int().min(1).max(5).default(2),
    maxTaskAutoRetries: z.number().int().min(0).max(5).default(2),
    maxSubagentsPerBot: z.number().int().min(1).max(6).default(3),
    autoCompactThresholdTokens: z.number().int().min(4000).default(60000),
    permissionRequestTimeoutSeconds: z.number().int().min(5).default(120),
    acpWorktreeBoundaryEnforced: z.boolean().default(true),
    redactSecretsInLogsAndMemory: z.boolean().default(true),
    selfModRequiresStagingAndVerifier: z.boolean().default(true),
  }),
});
export type HubConfig = z.infer<typeof HubConfigSchema>;

// --- Core Domain Models ---

export const AgentScopeSchema = z.enum(["global", "project", "peer", "sidekick", "verifier"]);
export type AgentScope = z.infer<typeof AgentScopeSchema>;

export const AgentStatusSchema = z.enum([
  "idle",
  "working",
  "waiting_review",
  "debating",
  "requires_action",
  "paused",
  "stopped",
  "error",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const TaskStatusSchema = z.enum([
  "backlog",
  "ready",
  "claimed",
  "in_review",
  "verified",
  "merged",
  "blocked",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const AnnotationStatusSchema = z.enum([
  "open",
  "in_progress",
  "resolved_pending_review",
  "approved",
]);
export type AnnotationStatus = z.infer<typeof AnnotationStatusSchema>;

export const MemoryRelationSchema = z.enum(["updates", "extends", "derives"]);
export type MemoryRelation = z.infer<typeof MemoryRelationSchema>;

export const MemoryKindSchema = z.enum(["fact", "preference", "decision", "episode"]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const DebateStatusSchema = z.enum(["open", "escalated", "resolved"]);
export type DebateStatus = z.infer<typeof DebateStatusSchema>;

export const VerificationVerdictSchema = z.enum(["pass", "fail", "needs_human"]);
export type VerificationVerdict = z.infer<typeof VerificationVerdictSchema>;

export const SelfModKindSchema = z.enum(["plugin", "config_patch"]);
export type SelfModKind = z.infer<typeof SelfModKindSchema>;

export const SelfModStatusSchema = z.enum(["staged", "verifying", "verified", "rejected", "promoted", "rolled_back"]);
export type SelfModStatus = z.infer<typeof SelfModStatusSchema>;

export const DocAnchorSchema = z.object({
  kind: z.literal("doc"),
  filePath: z.string(),
  blockId: z.string(),
  contentHash: z.string(),
  quote: z.string(),
});

export const ImageAnchorSchema = z.object({
  kind: z.literal("image"),
  filePath: z.string(),
  pin: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  rect: z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      w: z.number().min(0).max(1),
      h: z.number().min(0).max(1),
    })
    .optional(),
});

export const Model3DAnchorSchema = z.object({
  kind: z.literal("model_3d"),
  filePath: z.string(),
  meshName: z.string(),
  point: z.tuple([z.number(), z.number(), z.number()]),
  normal: z.tuple([z.number(), z.number(), z.number()]),
  camera: z.object({
    pos: z.tuple([z.number(), z.number(), z.number()]),
    target: z.tuple([z.number(), z.number(), z.number()]),
    fov: z.number().positive(),
  }),
});

export const AnnotationAnchorSchema = z.discriminatedUnion("kind", [
  DocAnchorSchema,
  ImageAnchorSchema,
  Model3DAnchorSchema,
]);
export type AnnotationAnchor = z.infer<typeof AnnotationAnchorSchema>;

export const VerifyCheckSchema = z.object({
  name: z.string().min(1),
  cmd: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
});
export type VerifyCheck = z.infer<typeof VerifyCheckSchema>;

export interface ProjectRecord {
  id: string;
  slug: string;
  name: string;
  rootPath: string;
  repoPath: string;
  routingOverrides: Record<string, RouteTarget>;
  verifyChecks?: VerifyCheck[];
  status: "active" | "paused" | "archived";
  createdAt: number;
}

export interface RepoFileEntry {
  relativePath: string;
  name: string;
  sizeBytes: number;
  ext: string;
}

export interface GitDiffFileSummary {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked" | "renamed";
  added: number;
  removed: number;
  patch: string;
}

export interface GitDiffResponse {
  branch: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: GitDiffFileSummary[];
}

export interface AgentRecord {
  id: string;
  projectId: string | null;
  parentAgentId: string | null;
  scope: AgentScope;
  name: string;
  runtimeType: RuntimeKind;
  provider: string;
  model: string;
  status: AgentStatus;
  worktreePath: string | null;
  worktreeBranch: string | null;
  pid: number | null;
  activeSessionId: string | null;
  lastSummary: string | null;
  turnCounter?: number;
  depth?: number;
  subagentMode?: SubagentMode | null;
  autonomyLevel?: AutonomyLevel;
  reasoningEffort?: ReasoningEffort;
  updatedAt: number;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  goalId?: string | null;
  title: string;
  specMd: string;
  status: TaskStatus;
  priority: number;
  assignedAgentId: string | null;
  sourceAnnotationId: string | null;
  worktreeBranch: string | null;
  handoffPath: string | null;
  retryCount: number;
  dependsOn?: string[];
  autoRetryCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AnnotationRecord {
  id: string;
  projectId: string;
  targetType: "doc" | "image" | "model_3d";
  filePath: string;
  anchor: AnnotationAnchor;
  comment: string;
  snapshotDataUrl: string | null;
  status: AnnotationStatus;
  linkedTaskId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TimelineItem {
  id: string;
  agentId: string;
  sessionId: string;
  seq: number;
  kind: "message" | "thought" | "plan" | "tool_call" | "terminal" | "steer" | "handoff" | "status";
  role: "user" | "assistant" | "system" | "tool";
  senderAgentId?: string | null;
  senderRole?: "user" | "orchestrator" | "bot" | "system";
  title?: string;
  content: string;
  toolCallId?: string;
  toolStatus?: "pending" | "in_progress" | "completed" | "failed";
  exitCode?: number | null;
  filePath?: string;
  diffPreview?: string;
  checkpointRef?: string | null;
  createdAt: number;
}

export interface ArtifactEntry {
  projectId: string;
  relativePath: string;
  name: string;
  kind: "doc" | "image" | "model_3d" | "handoff" | "other";
  sizeBytes: number;
  updatedAt: number;
}

export interface MemoryFactRecord {
  id: string;
  namespace: string;
  docId: string | null;
  entity: string;
  factText: string;
  kind: MemoryKind;
  version: number;
  isLatest: boolean;
  isForgotten: boolean;
  isInference: boolean;
  isStatic: boolean;
  confidence: number;
  validFrom: number;
  forgetAfter: number | null;
  forgetReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DebateRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  topic: string;
  reason: string;
  participantAgentIds: string[];
  status: DebateStatus;
  roundCount: number;
  maxRounds: number;
  escalatedToAgentId: string | null;
  resolutionSummary: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DebateMessageRecord {
  id: string;
  debateId: string;
  roundNum: number;
  agentId: string;
  position: string;
  evidence: string | null;
  createdAt: number;
}

export interface VerificationCheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerificationReportRecord {
  id: string;
  projectId: string | null;
  targetKind: "task" | "selfmod";
  targetId: string;
  authorAgentId: string | null;
  authorProvider: string | null;
  verifierAgentId: string;
  verifierSessionId: string;
  verifierProvider: string;
  verifierModel: string;
  crossFamily: boolean;
  verdict: VerificationVerdict;
  summary: string;
  checks: VerificationCheckResult[];
  findings: string[];
  createdAt: number;
}

export interface SelfModProposalRecord {
  id: string;
  kind: SelfModKind;
  targetId: string;
  title: string;
  rationale: string;
  authorAgentId: string | null;
  stagingPath: string;
  livePath: string;
  backupPath: string | null;
  contentSha256: string;
  status: SelfModStatus;
  verificationId: string | null;
  verificationSummary: string | null;
  createdAt: number;
  updatedAt: number;
}

export const PermissionDecisionSchema = z.enum(["allow_once", "allow_session", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export interface PermissionRequestRecord {
  id: string;
  agentId: string;
  sessionId: string;
  projectId?: string | null;
  agentName?: string;
  title: string;
  commandOrPath: string;
  reason: string;
  status: "pending" | "allowed" | "denied" | "timed_out";
  decision?: PermissionDecision | null;
  createdAt: number;
  expiresAt: number;
}

export interface CheckpointRecord {
  id: string;
  scopeKey: string;
  agentId: string;
  cwd: string;
  turnNum: number;
  refName: string;
  commitSha: string;
  createdAt: number;
}

export const MemoryL1TargetSchema = z.enum(["user", "global", "project"]);
export type MemoryL1Target = z.infer<typeof MemoryL1TargetSchema>;

export interface MemoryL1Snapshot {
  target: MemoryL1Target;
  projectId?: string | null;
  filePath: string;
  content: string;
  usedChars: number;
  maxChars: number;
  gaugeHeader: string;
}

export const TeamGoalStatusSchema = z.enum(["active", "completed", "blocked"]);
export type TeamGoalStatus = z.infer<typeof TeamGoalStatusSchema>;

export interface TeamGoalRecord {
  goalId: string;
  projectId: string;
  goal: string;
  status: TeamGoalStatus;
  taskIds: string[];
  updatedAt: number;
}

export interface QuietStatusProjection {
  activeProjects: number;
  runningBots: number;
  waitingReviews: number;
  openAnnotations: number;
  activeDebates: number;
  stagedSelfMods: number;
  unknownAdmissions?: Array<{
    id: string;
    sessionId: string;
    agentId: string;
    executionGeneration: number;
    createdAt: number;
  }>;
  pendingPermissionsCount?: number;
  pendingPermissions?: PermissionRequestRecord[];
  activeGoals?: TeamGoalRecord[];
  inboxNotices: Array<{
    id: string;
    level: "info" | "warn" | "action";
    projectId?: string;
    agentId?: string;
    message: string;
    createdAt: number;
  }>;
}

// --- Typed WebSocket RPC & Scoped Subscriptions ---

export type SubscriptionTopic =
  | "global:status"
  | "global:selfmod"
  | "chat:meta"
  | `project:${string}:board`
  | `project:${string}:previews`
  | `project:${string}:debates`
  | `bot:${string}:timeline`;

export const RpcCommandSchema = z.discriminatedUnion("type", [
  z.object({
    commandId: z.string(),
    type: z.literal("chat.send"),
    text: z.string().min(1),
    projectId: z.string().optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    autonomyLevel: AutonomyLevelSchema.optional(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("project.create"),
    name: z.string().min(1),
    slug: z.string().optional(),
    externalRepoPath: z.string().optional(),
    seedDemoArtifacts: z.boolean().optional(),
    verifyChecks: z.array(VerifyCheckSchema).optional(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("project.archive"),
    projectId: z.string().min(1),
    status: z.enum(["active", "paused", "archived"]),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("bot.spawn"),
    projectId: z.string(),
    name: z.string().min(1),
    scope: AgentScopeSchema.default("peer"),
    provider: z.string().optional(),
    model: z.string().optional(),
    taskId: z.string().optional(),
    parentAgentId: z.string().optional(),
    autonomyLevel: AutonomyLevelSchema.optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("bot.pause"),
    agentId: z.string(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("bot.stop"),
    agentId: z.string(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("bot.resume"),
    agentId: z.string().min(1),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("bot.update_model"),
    agentId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("bot.message"),
    projectId: z.string().min(1),
    agentId: z.string().min(1),
    message: z.string().min(1),
    senderAgentId: z.string().optional(),
    senderRole: z.enum(["user", "orchestrator"]).optional(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("permission.respond"),
    permissionId: z.string().min(1),
    decision: PermissionDecisionSchema,
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("steer.submit"),
    projectId: z.string(),
    message: z.string().min(1),
    reasoningEffort: ReasoningEffortSchema.optional(),
    autonomyLevel: AutonomyLevelSchema.optional(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("task.create"),
    projectId: z.string(),
    title: z.string().min(1),
    specMd: z.string().default(""),
    priority: z.number().int().min(1).max(5).default(3),
    dependsOn: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("task.dispatch"),
    projectId: z.string(),
    taskId: z.string(),
    agentId: z.string().optional(),
    autonomous: z.boolean().optional(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("task.verify"),
    projectId: z.string(),
    taskId: z.string(),
    checks: z.array(z.string().min(1)).max(8).optional(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("task.merge"),
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    strategy: z.enum(["squash", "merge_commit"]).default("squash"),
    commitMessage: z.string().optional(),
    overrideReason: z.string().optional(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("annotation.create"),
    projectId: z.string(),
    anchor: AnnotationAnchorSchema,
    comment: z.string().min(1),
    snapshotDataUrl: z.string().max(2_500_000).optional(),
    requestFixNow: z.boolean().default(true),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("annotation.resolve"),
    annotationId: z.string(),
    status: AnnotationStatusSchema,
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("session.resolve_unknown"),
    admissionId: z.string(),
    expectedGeneration: z.number().int().positive(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("debate.open"),
    projectId: z.string(),
    taskId: z.string().optional(),
    topic: z.string().min(1).max(200),
    reason: z.string().min(1).max(1000),
    participantAgentIds: z.array(z.string().min(1)).min(1).max(6),
    maxRounds: z.number().int().min(1).max(10).optional(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("debate.post"),
    debateId: z.string(),
    agentId: z.string(),
    position: z.string().min(1).max(4000),
    evidence: z.string().max(4000).optional(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("debate.resolve"),
    debateId: z.string(),
    decision: z.string().min(1).max(4000),
    resolvedByAgentId: z.string().optional(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("selfmod.propose"),
    kind: SelfModKindSchema,
    targetId: z.string().min(1).max(64),
    title: z.string().min(1).max(160),
    rationale: z.string().min(1).max(2000),
    content: z.string().min(1).max(200_000),
    authorAgentId: z.string().optional(),
    autoVerify: z.boolean().default(false),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("selfmod.verify"),
    proposalId: z.string(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("selfmod.promote"),
    proposalId: z.string(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("selfmod.rollback"),
    proposalId: z.string(),
    reason: z.string().max(500).optional(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("config.update"),
    patchJson: z.string().min(1),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("routing.set_override"),
    projectId: z.string().min(1),
    intent: z.string().min(1),
    target: RouteTargetSchema.nullable(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("memory.l1.get"),
    target: MemoryL1TargetSchema,
    projectId: z.string().optional(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("memory.l1.update"),
    target: MemoryL1TargetSchema,
    projectId: z.string().optional(),
    content: z.string(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("checkpoint.list"),
    projectId: z.string().min(1),
    agentId: z.string().optional(),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("checkpoint.rollback"),
    projectId: z.string().min(1),
    checkpointId: z.string().min(1),
  }),
  z.object({
    commandId: z.string(),
    type: z.literal("inbox.dismiss"),
    noticeId: z.string().min(1),
  }),
]);
export type RpcCommand = z.infer<typeof RpcCommandSchema>;

export type WsClientMessage =
  | { kind: "subscribe"; topic: SubscriptionTopic }
  | { kind: "unsubscribe"; topic: SubscriptionTopic }
  | { kind: "command"; payload: RpcCommand }
  | { kind: "ping"; ts: number };

export type WsServerMessage =
  | { kind: "ack"; commandId: string; ok: boolean; result?: unknown; error?: string }
  | { kind: "snapshot"; topic: SubscriptionTopic; data: unknown; seq: number }
  | { kind: "event"; topic: SubscriptionTopic; eventType: string; data: unknown; seq: number }
  | { kind: "pong"; ts: number };

export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return cleaned || "project";
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
