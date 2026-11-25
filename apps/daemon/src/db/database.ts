import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  newId,
  type AgentRecord,
  type AgentScope,
  type AgentStatus,
  type AnnotationAnchor,
  type AnnotationRecord,
  type AnnotationStatus,
  type DebateMessageRecord,
  type DebateRecord,
  type DebateStatus,
  type MemoryFactRecord,
  type MemoryKind,
  type MemoryRelation,
  type ProjectRecord,
  type RouteTarget,
  type RuntimeKind,
  type SelfModKind,
  type SelfModProposalRecord,
  type SelfModStatus,
  type TaskRecord,
  type TeamGoalStatus,
  type TaskStatus,
  type TimelineItem,
  type VerificationCheckResult,
  type VerificationReportRecord,
  type VerificationVerdict,
} from "@bot-factory/shared";

export const CURRENT_SCHEMA_VERSION = 4;

export interface OutboxEffectRow {
  id: string;
  effectType: string;
  payload: Record<string, unknown>;
  status: "pending" | "running" | "done" | "retired" | "dead_letter";
  attempts: number;
  nextAttemptAt: number;
  epoch: number;
  lastError: string | null;
  createdAt: number;
}

export interface SessionRecord {
  id: string;
  agentId: string;
  parentSessionId: string | null;
  systemPrompt: string;
  systemPromptHash: string;
  generation: number;
  tokenIn: number;
  tokenOut: number;
  status: "active" | "idle" | "closed";
  createdAt: number;
  updatedAt: number;
}

export interface AdmissionRow {
  id: string;
  sessionId: string;
  executionGeneration: number;
  inputText: string;
  status: "queued" | "started" | "terminal" | "unknown";
  createdAt: number;
  updatedAt: number;
}

export interface StoredTeamGoalRecord {
  goalId: string;
  projectId: string;
  goal: string;
  status: TeamGoalStatus;
  autonomyLevel: string | null;
  reasoningEffort: string | null;
  reported: boolean;
  createdAt: number;
  updatedAt: number;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "EPERM";
  }
}

export class StateDatabase {
  public readonly db: Database;
  public readonly epoch: number;
  public readonly instanceId: string;
  private readonly lockPath: string;
  private ownsLock = false;
  private ftsStale = false;
  private quarantined = false;
  private closed = false;

  constructor(private readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.lockPath = `${dbPath}.writer.lock`;
    this.acquireWriterLock();

    this.db = new Database(dbPath, { create: true, strict: false });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");

    this.instanceId = newId("inst");
    this.migrate();
    this.epoch = this.bumpRuntimeEpoch();
    this.checkAndRecoverFtsOnBoot();
  }

  private tryCreateExclusiveLock(): boolean {
    try {
      const fd = openSync(this.lockPath, "wx");
      try {
        writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, startedAt: Date.now(), exeHint: "bun" }),
          "utf8",
        );
      } finally {
        closeSync(fd);
      }
      this.ownsLock = true;
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST") return false;
      throw err;
    }
  }

  private isLockHolderAlive(holderPid: number, holderStartedAt: number | null, exeHint: string | null): boolean {
    if (!isPidAlive(holderPid)) return false;
    if (holderPid === process.pid) return true;
    if (process.platform !== "win32") return true;

    try {
      const psScript =
        `$p = Get-Process -Id ${holderPid} -ErrorAction SilentlyContinue; ` +
        `if ($p) { try { $ms = [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() } catch { $ms = 0 }; ` +
        `Write-Output ($p.ProcessName + "|" + $ms) }`;
      const res = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", psScript], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (res.exitCode !== 0) {
        return true;
      }
      const out = res.stdout.toString().trim();
      if (!out) {
        return false;
      }
      const [rawName, rawStart] = out.split("|");
      const procName = (rawName ?? "").trim().toLowerCase();
      const expected = (exeHint ?? "bun").trim().toLowerCase();
      const matchesExe =
        procName === expected ||
        procName === `${expected}.exe` ||
        (expected === "bun" && (procName === "bun" || procName === "bun.exe"));
      if (!matchesExe) {
        return false;
      }
      const procStartMs = Number(rawStart);
      if (
        Number.isFinite(procStartMs) &&
        procStartMs > 0 &&
        holderStartedAt !== null &&
        Number.isFinite(holderStartedAt) &&
        procStartMs > holderStartedAt + 15_000
      ) {
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  private acquireWriterLock(): void {
    if (this.tryCreateExclusiveLock()) return;

    // Inspect existing lock file to see if holder is still alive (or stale from an unclean crash / recycled PID)
    let holderPid: number | null = null;
    let holderStartedAt: number | null = null;
    let holderExeHint: string | null = null;
    try {
      const raw = JSON.parse(readFileSync(this.lockPath, "utf8")) as {
        pid?: unknown;
        startedAt?: unknown;
        exeHint?: unknown;
      };
      if (typeof raw.pid === "number") holderPid = raw.pid;
      if (typeof raw.startedAt === "number") holderStartedAt = raw.startedAt;
      if (typeof raw.exeHint === "string") holderExeHint = raw.exeHint;
    } catch {
      // Unreadable or empty lock file -> treat as stale if removable
    }

    if (holderPid !== null && this.isLockHolderAlive(holderPid, holderStartedAt, holderExeHint)) {
      throw new Error(`database_writer_lock_held: another daemon instance is active (pid=${holderPid})`);
    }

    // Stale lock from dead PID or recycled non-daemon PID -> clear and atomically re-acquire once
    try {
      unlinkSync(this.lockPath);
    } catch {
      // ignore race
    }
    if (!this.tryCreateExclusiveLock()) {
      throw new Error(`database_writer_lock_held: unable to acquire exclusive lock on ${this.lockPath}`);
    }
  }

  private assertWritable(): void {
    if (this.quarantined) {
      throw new Error("StateDatabase is quarantined due to SQLITE_CORRUPT");
    }
    const row = this.db.query("SELECT epoch FROM runtime_meta WHERE id = 1").get() as { epoch: number } | null;
    if (!row || row.epoch !== this.epoch) {
      throw new Error(`stale_epoch: expected ${this.epoch}, got ${row?.epoch ?? "none"}`);
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  }

  private ensureColumn(table: string, column: string, definitionSql: string): void {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definitionSql};`);
    }
  }

  private migrate(): void {
    const metaExists = this.db
      .query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'runtime_meta'")
      .get() as { ok: number } | null;
    const prevMeta = metaExists
      ? (this.db.query("SELECT schema_version, fts_stale FROM runtime_meta WHERE id = 1").get() as {
          schema_version: number;
          fts_stale: number;
        } | null)
      : null;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_meta (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        epoch INTEGER NOT NULL DEFAULT 0,
        schema_version INTEGER NOT NULL DEFAULT 4,
        instance_id TEXT NOT NULL,
        daemon_pid INTEGER NOT NULL,
        fts_stale INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        routing_overrides_json TEXT NOT NULL DEFAULT '{}',
        verify_checks_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        parent_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        scope TEXT NOT NULL,
        name TEXT NOT NULL,
        runtime_type TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        worktree_path TEXT,
        worktree_branch TEXT,
        pid INTEGER,
        active_session_id TEXT,
        last_summary TEXT,
        turn_counter INTEGER NOT NULL DEFAULT 0,
        depth INTEGER NOT NULL DEFAULT 0,
        subagent_mode TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        system_prompt TEXT NOT NULL,
        system_prompt_hash TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        token_in INTEGER NOT NULL DEFAULT 0,
        token_out INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_admissions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
        execution_generation INTEGER NOT NULL DEFAULT 1,
        input_text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','started','terminal','unknown')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'message',
        role TEXT NOT NULL,
        sender_agent_id TEXT,
        sender_role TEXT,
        title TEXT,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        tool_status TEXT,
        exit_code INTEGER,
        file_path TEXT,
        diff_preview TEXT,
        checkpoint_ref TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        compacted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_messages_agent_seq ON messages(agent_id, created_at);

      CREATE TABLE IF NOT EXISTS team_goals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        goal TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','completed','blocked')) DEFAULT 'active',
        autonomy_level TEXT,
        reasoning_effort TEXT,
        reported INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_team_goals_project_status ON team_goals(project_id, status, updated_at);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        goal_id TEXT,
        title TEXT NOT NULL,
        spec_md TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ready',
        priority INTEGER NOT NULL DEFAULT 3,
        assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        source_annotation_id TEXT,
        worktree_branch TEXT,
        handoff_path TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        auto_retry_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);

      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL CHECK(target_type IN ('doc','image','model_3d')),
        file_path TEXT NOT NULL,
        anchor_json TEXT NOT NULL,
        comment TEXT NOT NULL,
        snapshot_data_url TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        linked_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_annotations_project ON annotations(project_id, status);

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued',
        dream_status TEXT NOT NULL DEFAULT 'pending',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        namespace TEXT NOT NULL,
        position INTEGER NOT NULL,
        text TEXT NOT NULL,
        UNIQUE(doc_id, position)
      );

      CREATE TABLE IF NOT EXISTS memory_facts (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        namespace TEXT NOT NULL,
        doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        entity TEXT NOT NULL DEFAULT 'general',
        fact_text TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('fact','preference','decision','episode')),
        version INTEGER NOT NULL DEFAULT 1,
        is_latest INTEGER NOT NULL DEFAULT 1,
        is_forgotten INTEGER NOT NULL DEFAULT 0,
        is_inference INTEGER NOT NULL DEFAULT 0,
        is_static INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 0.85,
        valid_from INTEGER NOT NULL,
        forget_after INTEGER,
        forget_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mem_ns_live ON memory_facts(namespace, is_latest, is_forgotten);

      CREATE TABLE IF NOT EXISTS memory_edges (
        src_id TEXT NOT NULL,
        dst_id TEXT NOT NULL,
        rel TEXT NOT NULL CHECK(rel IN ('updates','extends','derives')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(src_id, dst_id, rel)
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        fact_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector_blob BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        turn_num INTEGER NOT NULL,
        ref_name TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(scope_key, turn_num)
      );

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        topic TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS command_receipts (
        command_id TEXT PRIMARY KEY,
        command_type TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox_effects (
        id TEXT PRIMARY KEY,
        effect_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_status_next ON outbox_effects(status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS inbox_notices (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        project_id TEXT,
        agent_id TEXT,
        message TEXT NOT NULL,
        dismissed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS debates (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        topic TEXT NOT NULL,
        reason TEXT NOT NULL,
        participant_agent_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('open','escalated','resolved')) DEFAULT 'open',
        round_count INTEGER NOT NULL DEFAULT 0,
        max_rounds INTEGER NOT NULL DEFAULT 3,
        escalated_to_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        resolution_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_debates_project_status ON debates(project_id, status);

      CREATE TABLE IF NOT EXISTS debate_messages (
        id TEXT PRIMARY KEY,
        debate_id TEXT NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
        round_num INTEGER NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        position TEXT NOT NULL,
        evidence TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_debate_messages_debate ON debate_messages(debate_id, round_num, created_at);

      CREATE TABLE IF NOT EXISTS verifications (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('task','selfmod')),
        target_id TEXT NOT NULL,
        author_agent_id TEXT,
        author_provider TEXT,
        verifier_agent_id TEXT NOT NULL,
        verifier_session_id TEXT NOT NULL,
        verifier_provider TEXT NOT NULL,
        verifier_model TEXT NOT NULL,
        cross_family INTEGER NOT NULL DEFAULT 0,
        verdict TEXT NOT NULL CHECK(verdict IN ('pass','fail','needs_human')),
        summary TEXT NOT NULL,
        checks_json TEXT NOT NULL DEFAULT '[]',
        findings_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_verifications_target ON verifications(target_kind, target_id, created_at);

      CREATE TABLE IF NOT EXISTS self_mod_proposals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('plugin','config_patch')),
        target_id TEXT NOT NULL,
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        author_agent_id TEXT,
        staging_path TEXT NOT NULL,
        live_path TEXT NOT NULL,
        backup_path TEXT,
        content_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('staged','verifying','verified','rejected','promoted','rolled_back')) DEFAULT 'staged',
        verification_id TEXT,
        verification_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_selfmod_status ON self_mod_proposals(status, updated_at);
    `);

    // Idempotent v2 column upgrades for pre-existing v1 databases
    this.ensureColumn("projects", "verify_checks_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("agents", "turn_counter", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("agents", "depth", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("agents", "subagent_mode", "TEXT");
    this.ensureColumn("tasks", "depends_on_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("tasks", "auto_retry_count", "INTEGER NOT NULL DEFAULT 0");

    // Idempotent v3 column upgrades for pre-existing v1/v2 databases
    this.ensureColumn("messages", "sender_agent_id", "TEXT");
    this.ensureColumn("messages", "sender_role", "TEXT");

    // Idempotent v4 autonomous DAG persistence upgrades
    this.ensureColumn("tasks", "goal_id", "TEXT");

    // Recreate live_memory_facts view cleanly for epoch-ms forget_after comparisons
    this.db.exec(`
      DROP VIEW IF EXISTS live_memory_facts;
      CREATE VIEW live_memory_facts AS
      SELECT * FROM memory_facts
      WHERE is_latest = 1
        AND is_forgotten = 0
        AND (forget_after IS NULL OR forget_after > (unixepoch() * 1000));
    `);

    // Upgrade second-scale memory_facts / memory_edges timestamps (< 1e11) to epoch ms
    this.db.exec(`
      UPDATE memory_facts
      SET
        created_at = CASE WHEN created_at > 0 AND created_at < 100000000000 THEN created_at * 1000 ELSE created_at END,
        updated_at = CASE WHEN updated_at > 0 AND updated_at < 100000000000 THEN updated_at * 1000 ELSE updated_at END,
        valid_from = CASE WHEN valid_from > 0 AND valid_from < 100000000000 THEN valid_from * 1000 ELSE valid_from END,
        forget_after = CASE WHEN forget_after IS NOT NULL AND forget_after > 0 AND forget_after < 100000000000 THEN forget_after * 1000 ELSE forget_after END
      WHERE (created_at > 0 AND created_at < 100000000000)
         OR (updated_at > 0 AND updated_at < 100000000000)
         OR (valid_from > 0 AND valid_from < 100000000000)
         OR (forget_after IS NOT NULL AND forget_after > 0 AND forget_after < 100000000000);

      UPDATE memory_edges
      SET created_at = created_at * 1000
      WHERE created_at > 0 AND created_at < 100000000000;
    `);

    if (prevMeta && Number(prevMeta.schema_version) < CURRENT_SCHEMA_VERSION) {
      this.db.query("UPDATE runtime_meta SET schema_version = ? WHERE id = 1").run(CURRENT_SCHEMA_VERSION);
      if (Number(prevMeta.fts_stale) === 0) {
        this.dropFtsTriggers();
      }
    }

    if (!prevMeta || Number(prevMeta.fts_stale) === 0) {
      this.installFtsObjects();
    }
  }

  private dropFtsTriggers(): void {
    this.db.exec(`
      DROP TRIGGER IF EXISTS trg_messages_ai;
      DROP TRIGGER IF EXISTS trg_messages_ad;
      DROP TRIGGER IF EXISTS trg_messages_au;
      DROP TRIGGER IF EXISTS trg_chunks_ai;
      DROP TRIGGER IF EXISTS trg_chunks_ad;
      DROP TRIGGER IF EXISTS trg_chunks_au;
      DROP TRIGGER IF EXISTS trg_facts_ai;
      DROP TRIGGER IF EXISTS trg_facts_ad;
      DROP TRIGGER IF EXISTS trg_facts_au;
    `);
  }

  private installFtsObjects(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, title, content='messages', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS trg_messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, title) VALUES (new.rowid, new.content, coalesce(new.title, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS trg_messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, title) VALUES('delete', old.rowid, old.content, coalesce(old.title, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS trg_messages_au AFTER UPDATE OF content, title ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, title) VALUES('delete', old.rowid, old.content, coalesce(old.title, ''));
        INSERT INTO messages_fts(rowid, content, title) VALUES (new.rowid, new.content, coalesce(new.title, ''));
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text, content='chunks', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS trg_chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_chunks_au AFTER UPDATE OF text ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
        INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        fact_text, entity, content='memory_facts', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS trg_facts_ai AFTER INSERT ON memory_facts BEGIN
        INSERT INTO facts_fts(rowid, fact_text, entity) VALUES (new.rowid, new.fact_text, new.entity);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_facts_ad AFTER DELETE ON memory_facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, fact_text, entity) VALUES('delete', old.rowid, old.fact_text, old.entity);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_facts_au AFTER UPDATE OF fact_text, entity ON memory_facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, fact_text, entity) VALUES('delete', old.rowid, old.fact_text, old.entity);
        INSERT INTO facts_fts(rowid, fact_text, entity) VALUES (new.rowid, new.fact_text, new.entity);
      END;
    `);
  }

  private bumpRuntimeEpoch(): number {
    const now = Date.now();
    const existing = this.db.query("SELECT epoch, fts_stale FROM runtime_meta WHERE id = 1").get() as {
      epoch: number;
      fts_stale: number;
    } | null;

    if (!existing) {
      this.db
        .query(
          "INSERT INTO runtime_meta (id, epoch, schema_version, instance_id, daemon_pid, fts_stale, started_at) VALUES (1, 1, ?, ?, ?, 0, ?)",
        )
        .run(CURRENT_SCHEMA_VERSION, this.instanceId, process.pid, now);
      return 1;
    }

    const nextEpoch = existing.epoch + 1;
    this.ftsStale = existing.fts_stale === 1;
    this.db
      .query(
        "UPDATE runtime_meta SET epoch = ?, schema_version = ?, instance_id = ?, daemon_pid = ?, started_at = ? WHERE id = 1",
      )
      .run(nextEpoch, CURRENT_SCHEMA_VERSION, this.instanceId, process.pid, now);
    return nextEpoch;
  }

  private checkAndRecoverFtsOnBoot(): void {
    if (!this.ftsStale) return;
    try {
      this.installFtsObjects();
      this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
      this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');");
      this.db.exec("INSERT INTO facts_fts(facts_fts) VALUES('rebuild');");
      this.db.query("UPDATE runtime_meta SET fts_stale = 0 WHERE id = 1").run();
      this.ftsStale = false;
    } catch {
      this.detachFtsTriggers();
    }
  }

  public detachFtsTriggers(): void {
    this.ftsStale = true;
    try {
      this.dropFtsTriggers();
      this.db.query("UPDATE runtime_meta SET fts_stale = 1 WHERE id = 1").run();
    } catch {
      // Best-effort detach
    }
  }

  public isFtsStale(): boolean {
    return this.ftsStale;
  }

  public isClosed(): boolean {
    return this.closed;
  }

  private isFtsError(msg: string): boolean {
    if (/\b(fts5|vtable|messages_fts|chunks_fts|facts_fts)\b/i.test(msg)) {
      return true;
    }
    return /malformed/i.test(msg) && /fts/i.test(msg);
  }

  public runAtomicWrite<T>(fn: () => T): T {
    this.assertWritable();
    const tx = this.db.transaction(() => fn());
    try {
      return tx();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: unknown })?.code;
      if (this.isFtsError(msg)) {
        this.detachFtsTriggers();
        return tx();
      }
      if (
        code === "SQLITE_CORRUPT" ||
        /SQLITE_CORRUPT|database disk image is malformed|file is not a database/i.test(msg)
      ) {
        this.quarantined = true;
      }
      throw err;
    }
  }

  public recoverAfterRestart(): {
    retiredEffects: number;
    unknownAdmissions: number;
    resetAgents: number;
    resetSelfMods: number;
  } {
    return this.runAtomicWrite(() => {
      const now = Date.now();
      const eff = this.db
        .query("UPDATE outbox_effects SET status = 'retired', last_error = 'daemon_restarted_previous_epoch' WHERE status IN ('pending','running') AND epoch < ?")
        .run(this.epoch);
      const adm = this.db
        .query("UPDATE session_admissions SET status = 'unknown', updated_at = ? WHERE status = 'started'")
        .run(now);
      const ag = this.db
        .query("UPDATE agents SET status = 'idle', pid = NULL, updated_at = ? WHERE status = 'working'")
        .run(now);
      const sm = this.db
        .query("UPDATE self_mod_proposals SET status = 'staged', updated_at = ? WHERE status = 'verifying'")
        .run(now);
      return {
        retiredEffects: eff.changes,
        unknownAdmissions: adm.changes,
        resetAgents: ag.changes,
        resetSelfMods: sm.changes,
      };
    });
  }

  // --- Receipts, Events, Outbox ---

  public getCommandReceipt(commandId: string): unknown | null {
    const row = this.db.query("SELECT result_json FROM command_receipts WHERE command_id = ?").get(commandId) as {
      result_json: string;
    } | null;
    return row ? JSON.parse(row.result_json) : null;
  }

  public saveCommandReceipt(commandId: string, commandType: string, result: unknown): void {
    this.db
      .query("INSERT OR REPLACE INTO command_receipts (command_id, command_type, result_json, created_at) VALUES (?, ?, ?, ?)")
      .run(commandId, commandType, JSON.stringify(result), Date.now());
  }

  public appendEvent(topic: string, eventType: string, payload: unknown): { seq: number; id: string } {
    const id = newId("evt");
    const info = this.db
      .query("INSERT INTO events (id, topic, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, topic, eventType, JSON.stringify(payload), Date.now());
    return { seq: Number(info.lastInsertRowid), id };
  }

  public enqueueOutboxEffect(effectType: string, payload: Record<string, unknown>): string {
    const id = newId("eff");
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO outbox_effects (id, effect_type, payload_json, status, attempts, next_attempt_at, epoch, created_at) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
      )
      .run(id, effectType, JSON.stringify(payload), now, this.epoch, now);
    return id;
  }

  private mapOutboxEffect(r: Record<string, unknown>): OutboxEffectRow {
    return {
      id: String(r.id),
      effectType: String(r.effect_type),
      payload: JSON.parse(String(r.payload_json)),
      status: String(r.status) as OutboxEffectRow["status"],
      attempts: Number(r.attempts),
      nextAttemptAt: Number(r.next_attempt_at),
      epoch: Number(r.epoch),
      lastError: r.last_error ? String(r.last_error) : null,
      createdAt: Number(r.created_at),
    };
  }

  public listPendingOutboxEffects(limit = 100): OutboxEffectRow[] {
    const now = Date.now();
    const rows = this.db
      .query(
        "SELECT * FROM outbox_effects WHERE status = 'pending' AND epoch = ? AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT ?",
      )
      .all(this.epoch, now, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapOutboxEffect(r));
  }

  public claimOutboxEffectById(id: string): OutboxEffectRow | null {
    return this.runAtomicWrite(() => {
      const r = this.db
        .query(
          "UPDATE outbox_effects SET status = 'running', attempts = attempts + 1 WHERE id = ? AND status = 'pending' AND epoch = ? RETURNING *",
        )
        .get(id, this.epoch) as Record<string, unknown> | null;
      return r ? this.mapOutboxEffect(r) : null;
    });
  }

  public claimPendingEffects(limit = 5): OutboxEffectRow[] {
    const now = Date.now();
    return this.runAtomicWrite(() => {
      const rows = this.db
        .query(
          "SELECT * FROM outbox_effects WHERE status = 'pending' AND epoch = ? AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT ?",
        )
        .all(this.epoch, now, limit) as Array<Record<string, unknown>>;

      const claimed: OutboxEffectRow[] = [];
      for (const r of rows) {
        this.db
          .query("UPDATE outbox_effects SET status = 'running', attempts = attempts + 1 WHERE id = ? AND status = 'pending'")
          .run(String(r.id));
        claimed.push({
          ...this.mapOutboxEffect(r),
          status: "running",
          attempts: Number(r.attempts) + 1,
        });
      }
      return claimed;
    });
  }

  public settleOutboxEffect(id: string, status: "done" | "pending" | "dead_letter" | "retired", error?: string, nextAttemptAt?: number): void {
    this.runAtomicWrite(() => {
      this.db
        .query("UPDATE outbox_effects SET status = ?, last_error = ?, next_attempt_at = coalesce(?, next_attempt_at) WHERE id = ?")
        .run(status, error ?? null, nextAttemptAt ?? null, id);
    });
  }

  // --- Projects ---

  public insertProject(p: ProjectRecord): void {
    this.db
      .query(
        "INSERT INTO projects (id, slug, name, root_path, repo_path, routing_overrides_json, verify_checks_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        p.id,
        p.slug,
        p.name,
        p.rootPath,
        p.repoPath,
        JSON.stringify(p.routingOverrides),
        JSON.stringify(p.verifyChecks ?? []),
        p.status,
        p.createdAt,
      );
  }

  public listProjects(): ProjectRecord[] {
    const rows = this.db.query("SELECT * FROM projects ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapProject(r));
  }

  public getProject(idOrSlug: string): ProjectRecord | null {
    const r = this.db.query("SELECT * FROM projects WHERE id = ? OR slug = ?").get(idOrSlug, idOrSlug) as Record<
      string,
      unknown
    > | null;
    return r ? this.mapProject(r) : null;
  }

  private mapProject(r: Record<string, unknown>): ProjectRecord {
    return {
      id: String(r.id),
      slug: String(r.slug),
      name: String(r.name),
      rootPath: String(r.root_path),
      repoPath: String(r.repo_path),
      routingOverrides: JSON.parse(String(r.routing_overrides_json || "{}")) as Record<string, RouteTarget>,
      verifyChecks: JSON.parse(String(r.verify_checks_json || "[]")) as NonNullable<ProjectRecord["verifyChecks"]>,
      status: String(r.status) as ProjectRecord["status"],
      createdAt: Number(r.created_at),
    };
  }

  // --- Agents ---

  public upsertAgent(a: AgentRecord): void {
    this.db
      .query(
        `INSERT INTO agents (id, project_id, parent_agent_id, scope, name, runtime_type, provider, model, status, worktree_path, worktree_branch, pid, active_session_id, last_summary, turn_counter, depth, subagent_mode, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           worktree_path = excluded.worktree_path,
           worktree_branch = excluded.worktree_branch,
           pid = excluded.pid,
           active_session_id = excluded.active_session_id,
           last_summary = excluded.last_summary,
           provider = excluded.provider,
           model = excluded.model,
           runtime_type = excluded.runtime_type,
           turn_counter = CASE WHEN ? = 1 THEN excluded.turn_counter ELSE agents.turn_counter END,
           depth = CASE WHEN ? = 1 THEN excluded.depth ELSE agents.depth END,
           subagent_mode = CASE WHEN ? = 1 THEN excluded.subagent_mode ELSE agents.subagent_mode END,
           updated_at = excluded.updated_at`,
      )
      .run(
        a.id,
        a.projectId,
        a.parentAgentId,
        a.scope,
        a.name,
        a.runtimeType,
        a.provider,
        a.model,
        a.status,
        a.worktreePath,
        a.worktreeBranch,
        a.pid,
        a.activeSessionId,
        a.lastSummary,
        a.turnCounter ?? 0,
        a.depth ?? 0,
        a.subagentMode ?? null,
        a.updatedAt,
        a.turnCounter !== undefined ? 1 : 0,
        a.depth !== undefined ? 1 : 0,
        a.subagentMode !== undefined ? 1 : 0,
      );
  }

  public incrementAgentTurnCounter(agentId: string): number {
    return this.runAtomicWrite(() => {
      const row = this.db
        .query("UPDATE agents SET turn_counter = turn_counter + 1, updated_at = ? WHERE id = ? RETURNING turn_counter")
        .get(Date.now(), agentId) as { turn_counter: number } | null;
      if (!row) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      return Number(row.turn_counter);
    });
  }

  public getAgent(id: string): AgentRecord | null {
    const r = this.db.query("SELECT * FROM agents WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapAgent(r) : null;
  }

  public listAgents(projectId?: string | null): AgentRecord[] {
    const rows =
      projectId === undefined
        ? (this.db.query("SELECT * FROM agents ORDER BY scope ASC, updated_at DESC").all() as Array<Record<string, unknown>>)
        : projectId === null
          ? (this.db.query("SELECT * FROM agents WHERE project_id IS NULL ORDER BY updated_at DESC").all() as Array<
              Record<string, unknown>
            >)
          : (this.db.query("SELECT * FROM agents WHERE project_id = ? ORDER BY scope ASC, updated_at DESC").all(projectId) as Array<
              Record<string, unknown>
            >);
    return rows.map((r) => this.mapAgent(r));
  }

  public updateAgentStatus(id: string, status: AgentStatus, opts?: { pid?: number | null; lastSummary?: string }): void {
    const setPid = opts !== undefined && opts.pid !== undefined ? 1 : 0;
    const pidVal = opts?.pid ?? null;
    this.db
      .query(
        "UPDATE agents SET status = ?, pid = CASE WHEN ? = 1 THEN ? ELSE pid END, last_summary = coalesce(?, last_summary), updated_at = ? WHERE id = ?",
      )
      .run(status, setPid, pidVal, opts?.lastSummary ?? null, Date.now(), id);
  }

  public updateAgentModel(
    agentId: string,
    provider: string,
    model: string,
    runtimeType: RuntimeKind,
  ): AgentRecord | null {
    return this.runAtomicWrite(() => {
      const row = this.db
        .query("UPDATE agents SET provider = ?, model = ?, runtime_type = ?, updated_at = ? WHERE id = ? RETURNING *")
        .get(provider, model, runtimeType, Date.now(), agentId) as Record<string, unknown> | null;
      return row ? this.mapAgent(row) : null;
    });
  }

  private mapAgent(r: Record<string, unknown>): AgentRecord {
    return {
      id: String(r.id),
      projectId: r.project_id ? String(r.project_id) : null,
      parentAgentId: r.parent_agent_id ? String(r.parent_agent_id) : null,
      scope: String(r.scope) as AgentScope,
      name: String(r.name),
      runtimeType: String(r.runtime_type) as RuntimeKind,
      provider: String(r.provider),
      model: String(r.model),
      status: String(r.status) as AgentStatus,
      worktreePath: r.worktree_path ? String(r.worktree_path) : null,
      worktreeBranch: r.worktree_branch ? String(r.worktree_branch) : null,
      pid: r.pid !== null && r.pid !== undefined ? Number(r.pid) : null,
      activeSessionId: r.active_session_id ? String(r.active_session_id) : null,
      lastSummary: r.last_summary ? String(r.last_summary) : null,
      turnCounter: Number(r.turn_counter ?? 0),
      depth: Number(r.depth ?? 0),
      subagentMode: r.subagent_mode ? (String(r.subagent_mode) as AgentRecord["subagentMode"]) : null,
      updatedAt: Number(r.updated_at),
    };
  }

  // --- Sessions, Admissions & Messages ---

  public createSession(s: SessionRecord): void {
    this.db
      .query(
        "INSERT INTO sessions (id, agent_id, parent_session_id, system_prompt, system_prompt_hash, generation, token_in, token_out, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        s.id,
        s.agentId,
        s.parentSessionId,
        s.systemPrompt,
        s.systemPromptHash,
        s.generation,
        s.tokenIn,
        s.tokenOut,
        s.status,
        s.createdAt,
        s.updatedAt,
      );
  }

  public getSession(id: string): SessionRecord | null {
    const r = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: String(r.id),
      agentId: String(r.agent_id),
      parentSessionId: r.parent_session_id ? String(r.parent_session_id) : null,
      systemPrompt: String(r.system_prompt),
      systemPromptHash: String(r.system_prompt_hash),
      generation: Number(r.generation),
      tokenIn: Number(r.token_in),
      tokenOut: Number(r.token_out),
      status: String(r.status) as SessionRecord["status"],
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  public compactSessionInPlace(sessionId: string, summaryText: string, newSystemPrompt: string, newHash: string): number {
    return this.runAtomicWrite(() => {
      const s = this.getSession(sessionId);
      if (!s) throw new Error(`Session not found: ${sessionId}`);
      const nextGen = s.generation + 1;
      const now = Date.now();
      this.db.query("UPDATE messages SET active = 0, compacted = 1 WHERE session_id = ? AND active = 1").run(sessionId);
      this.db
        .query(
          "UPDATE sessions SET system_prompt = ?, system_prompt_hash = ?, generation = ?, token_in = 0, token_out = 0, updated_at = ? WHERE id = ?",
        )
        .run(newSystemPrompt, newHash, nextGen, now, sessionId);
      this.appendMessage({
        id: newId("msg"),
        agentId: s.agentId,
        sessionId,
        seq: this.nextMessageSeq(sessionId),
        kind: "status",
        role: "system",
        title: `Compaction Gen #${nextGen}`,
        content: summaryText,
        createdAt: now,
      });
      return nextGen;
    });
  }

  public updateSessionSystemPrompt(sessionId: string, systemPrompt: string, systemPromptHash: string): void {
    this.assertWritable();
    this.db
      .query("UPDATE sessions SET system_prompt = ?, system_prompt_hash = ?, updated_at = ? WHERE id = ?")
      .run(systemPrompt, systemPromptHash, Date.now(), sessionId);
  }

  public addSessionTokenUsage(sessionId: string, tokenInDelta: number, tokenOutDelta: number): number {
    this.assertWritable();
    const inDelta = Number.isFinite(tokenInDelta) ? Math.max(0, Math.trunc(tokenInDelta)) : 0;
    const outDelta = Number.isFinite(tokenOutDelta) ? Math.max(0, Math.trunc(tokenOutDelta)) : 0;
    const row = this.db
      .query(
        "UPDATE sessions SET token_in = token_in + ?, token_out = token_out + ?, updated_at = ? WHERE id = ? RETURNING token_in, token_out",
      )
      .get(inDelta, outDelta, Date.now(), sessionId) as { token_in: number; token_out: number } | null;
    return row ? Number(row.token_in) + Number(row.token_out) : 0;
  }

  public getSessionTokenTotal(sessionId: string): number {
    const row = this.db
      .query("SELECT token_in, token_out FROM sessions WHERE id = ?")
      .get(sessionId) as { token_in: number; token_out: number } | null;
    return row ? Number(row.token_in) + Number(row.token_out) : 0;
  }

  public enqueueAdmission(sessionId: string, inputText: string, initialStatus: "queued" | "started" = "queued"): AdmissionRow {
    this.assertWritable();
    const s = this.getSession(sessionId);
    const gen = s?.generation ?? 1;
    const blocking = this.db
      .query("SELECT id FROM session_admissions WHERE session_id = ? AND status = 'unknown' LIMIT 1")
      .get(sessionId);
    if (blocking) {
      throw new Error(`session_blocked_by_unknown_admission: resolve unknown admission before queuing new input`);
    }
    const now = Date.now();
    const row: AdmissionRow = {
      id: newId("adm"),
      sessionId,
      executionGeneration: gen,
      inputText,
      status: initialStatus,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        "INSERT INTO session_admissions (id, session_id, execution_generation, input_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.sessionId, row.executionGeneration, row.inputText, row.status, row.createdAt, row.updatedAt);
    return row;
  }

  public getAdmission(id: string): AdmissionRow | null {
    const r = this.db.query("SELECT * FROM session_admissions WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: String(r.id),
      sessionId: String(r.session_id),
      executionGeneration: Number(r.execution_generation),
      inputText: String(r.input_text),
      status: String(r.status) as AdmissionRow["status"],
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  public updateAdmissionStatus(id: string, status: AdmissionRow["status"]): void {
    this.assertWritable();
    this.db.query("UPDATE session_admissions SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
  }

  public resolveUnknownAdmission(id: string, expectedGeneration: number): void {
    this.runAtomicWrite(() => {
      const row = this.getAdmission(id);
      if (!row || row.status !== "unknown") throw new Error("admission_not_unknown");
      if (row.executionGeneration !== expectedGeneration) throw new Error("stale_generation");
      this.db.query("UPDATE session_admissions SET status = 'terminal', updated_at = ? WHERE id = ?").run(Date.now(), id);
    });
  }

  public listUnknownAdmissions(): Array<{
    id: string;
    sessionId: string;
    agentId: string;
    executionGeneration: number;
    createdAt: number;
  }> {
    const rows = this.db
      .query(
        `SELECT sa.id, sa.session_id, s.agent_id, sa.execution_generation, sa.created_at
         FROM session_admissions sa
         JOIN sessions s ON s.id = sa.session_id
         WHERE sa.status = 'unknown'
         ORDER BY sa.created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      sessionId: String(r.session_id),
      agentId: String(r.agent_id),
      executionGeneration: Number(r.execution_generation),
      createdAt: Number(r.created_at),
    }));
  }

  public getQuietStatusCounts(): {
    activeProjects: number;
    runningBots: number;
    waitingReviews: number;
    openAnnotations: number;
    activeDebates: number;
    stagedSelfMods: number;
  } {
    const r = this.db
      .query(
        `SELECT
           (SELECT COUNT(*) FROM projects WHERE status = 'active') AS activeProjects,
           (SELECT COUNT(*) FROM agents WHERE scope != 'global' AND status = 'working') AS runningBots,
           (SELECT COUNT(*) FROM tasks WHERE status = 'in_review') AS waitingReviews,
           (SELECT COUNT(*) FROM annotations WHERE status IN ('open', 'in_progress')) AS openAnnotations,
           (SELECT COUNT(*) FROM debates WHERE status IN ('open', 'escalated')) AS activeDebates,
           (SELECT COUNT(*) FROM self_mod_proposals WHERE status IN ('staged', 'verifying', 'verified')) AS stagedSelfMods`,
      )
      .get() as Record<string, unknown>;
    return {
      activeProjects: Number(r?.activeProjects ?? 0),
      runningBots: Number(r?.runningBots ?? 0),
      waitingReviews: Number(r?.waitingReviews ?? 0),
      openAnnotations: Number(r?.openAnnotations ?? 0),
      activeDebates: Number(r?.activeDebates ?? 0),
      stagedSelfMods: Number(r?.stagedSelfMods ?? 0),
    };
  }

  public pruneOldOperationalRows(
    keepEvents = 10_000,
    keepReceipts = 5_000,
    keepOutbox = 2_000,
  ): { eventsDeleted: number; receiptsDeleted: number; outboxDeleted: number } {
    const evtLimit = Math.max(0, Math.floor(keepEvents));
    const rcptLimit = Math.max(0, Math.floor(keepReceipts));
    const obxLimit = Math.max(0, Math.floor(keepOutbox));
    return this.runAtomicWrite(() => {
      const evtRes = this.db
        .query("DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT ?)")
        .run(evtLimit);
      const rcptRes = this.db
        .query(
          "DELETE FROM command_receipts WHERE rowid NOT IN (SELECT rowid FROM command_receipts ORDER BY created_at DESC, rowid DESC LIMIT ?)",
        )
        .run(rcptLimit);
      const obxRes = this.db
        .query(
          `DELETE FROM outbox_effects
           WHERE status IN ('done', 'retired', 'dead_letter')
             AND rowid NOT IN (
               SELECT rowid FROM outbox_effects
               WHERE status IN ('done', 'retired', 'dead_letter')
               ORDER BY created_at DESC, rowid DESC
               LIMIT ?
             )`,
        )
        .run(obxLimit);
      return {
        eventsDeleted: evtRes.changes,
        receiptsDeleted: rcptRes.changes,
        outboxDeleted: obxRes.changes,
      };
    });
  }

  public nextMessageSeq(sessionId: string): number {
    const r = this.db.query("SELECT coalesce(max(seq), 0) AS m FROM messages WHERE session_id = ?").get(sessionId) as { m: number };
    return Number(r.m) + 1;
  }

  public appendMessage(item: TimelineItem): void {
    const seq = item.seq > 0 ? item.seq : this.nextMessageSeq(item.sessionId);
    item.seq = seq;
    this.db
      .query(
        `INSERT INTO messages (id, session_id, agent_id, seq, kind, role, sender_agent_id, sender_role, title, content, tool_call_id, tool_status, exit_code, file_path, diff_preview, checkpoint_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.sessionId,
        item.agentId,
        seq,
        item.kind,
        item.role,
        item.senderAgentId ?? null,
        item.senderRole ?? null,
        item.title ?? null,
        item.content,
        item.toolCallId ?? null,
        item.toolStatus ?? null,
        item.exitCode ?? null,
        item.filePath ?? null,
        item.diffPreview ?? null,
        item.checkpointRef ?? null,
        item.createdAt,
      );
  }

  public upsertToolCallMessage(item: TimelineItem): void {
    this.assertWritable();
    if (item.kind === "tool_call" && item.toolCallId) {
      const existing = this.db
        .query(
          "SELECT id FROM messages WHERE session_id = ? AND tool_call_id = ? AND kind = 'tool_call' AND tool_status = 'in_progress' ORDER BY seq DESC LIMIT 1",
        )
        .get(item.sessionId, item.toolCallId) as { id: string } | null;
      if (existing) {
        this.db.query("DELETE FROM messages WHERE id = ?").run(existing.id);
      }
    }
    this.appendMessage(item);
  }

  public getMessage(id: string): TimelineItem | null {
    const r = this.db.query("SELECT * FROM messages WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapTimelineItem(r) : null;
  }

  public listMessages(sessionId: string, limit = 150): TimelineItem[] {
    const rows = this.db
      .query("SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?")
      .all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTimelineItem(r));
  }

  public listAgentTimeline(agentId: string, limit = 150): TimelineItem[] {
    const rows = this.db
      .query("SELECT * FROM messages WHERE agent_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?")
      .all(agentId, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((r) => this.mapTimelineItem(r));
  }

  public listActiveSessionMessages(
    sessionId: string,
    limit = 100,
    opts?: { kinds?: Array<TimelineItem["kind"]> },
  ): TimelineItem[] {
    const kinds =
      opts?.kinds && opts.kinds.length > 0
        ? opts.kinds
        : (["message", "status"] as Array<TimelineItem["kind"]>);
    const placeholders = kinds.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `SELECT * FROM messages WHERE session_id = ? AND active = 1 AND kind IN (${placeholders}) ORDER BY seq DESC LIMIT ?`,
      )
      .all(sessionId, ...kinds, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((r) => this.mapTimelineItem(r));
  }

  private mapTimelineItem(r: Record<string, unknown>): TimelineItem {
    return {
      id: String(r.id),
      agentId: String(r.agent_id),
      sessionId: String(r.session_id),
      seq: Number(r.seq),
      kind: String(r.kind) as TimelineItem["kind"],
      role: String(r.role) as TimelineItem["role"],
      senderAgentId: r.sender_agent_id !== null && r.sender_agent_id !== undefined ? String(r.sender_agent_id) : null,
      senderRole: r.sender_role ? (String(r.sender_role) as TimelineItem["senderRole"]) : undefined,
      title: r.title ? String(r.title) : undefined,
      content: String(r.content),
      toolCallId: r.tool_call_id ? String(r.tool_call_id) : undefined,
      toolStatus: r.tool_status ? (String(r.tool_status) as TimelineItem["toolStatus"]) : undefined,
      exitCode: r.exit_code !== null && r.exit_code !== undefined ? Number(r.exit_code) : null,
      filePath: r.file_path ? String(r.file_path) : undefined,
      diffPreview: r.diff_preview ? String(r.diff_preview) : undefined,
      checkpointRef: r.checkpoint_ref ? String(r.checkpoint_ref) : null,
      createdAt: Number(r.created_at),
    };
  }

  public searchMessages(query: string, limit = 10): Array<{ id: string; agentId: string; content: string; createdAt: number }> {
    const q = query.trim();
    if (!q) return [];
    if (!this.ftsStale) {
      try {
        const ftsQuery = q.replace(/["'*]/g, " ").trim();
        if (ftsQuery) {
          const rows = this.db
            .query(
              `SELECT m.id, m.agent_id, m.content, m.created_at
               FROM messages_fts f
               JOIN messages m ON m.rowid = f.rowid
               WHERE messages_fts MATCH ?
               ORDER BY bm25(messages_fts) LIMIT ?`,
            )
            .all(ftsQuery, limit) as Array<Record<string, unknown>>;
          return rows.map((r) => ({
            id: String(r.id),
            agentId: String(r.agent_id),
            content: String(r.content),
            createdAt: Number(r.created_at),
          }));
        }
      } catch {
        // Fall through to LIKE fallback without mutating live index
      }
    }
    const rows = this.db
      .query("SELECT id, agent_id, content, created_at FROM messages WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?")
      .all(`%${q}%`, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      agentId: String(r.agent_id),
      content: String(r.content),
      createdAt: Number(r.created_at),
    }));
  }

  // --- Autonomous Team Goals ---

  public upsertTeamGoal(goal: StoredTeamGoalRecord): void {
    this.db
      .query(
        `INSERT INTO team_goals (id, project_id, goal, status, autonomy_level, reasoning_effort, reported, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           goal = excluded.goal,
           status = excluded.status,
           autonomy_level = excluded.autonomy_level,
           reasoning_effort = excluded.reasoning_effort,
           reported = excluded.reported,
           updated_at = excluded.updated_at`,
      )
      .run(
        goal.goalId,
        goal.projectId,
        goal.goal,
        goal.status,
        goal.autonomyLevel,
        goal.reasoningEffort,
        goal.reported ? 1 : 0,
        goal.createdAt,
        goal.updatedAt,
      );
  }

  public getTeamGoal(goalId: string): StoredTeamGoalRecord | null {
    const row = this.db.query("SELECT * FROM team_goals WHERE id = ?").get(goalId) as Record<string, unknown> | null;
    return row ? this.mapTeamGoal(row) : null;
  }

  public listTeamGoals(projectId?: string): StoredTeamGoalRecord[] {
    const rows = projectId
      ? (this.db.query("SELECT * FROM team_goals WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Array<
          Record<string, unknown>
        >)
      : (this.db.query("SELECT * FROM team_goals ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>);
    return rows.map((row) => this.mapTeamGoal(row));
  }

  private mapTeamGoal(row: Record<string, unknown>): StoredTeamGoalRecord {
    return {
      goalId: String(row.id),
      projectId: String(row.project_id),
      goal: String(row.goal),
      status: String(row.status) as TeamGoalStatus,
      autonomyLevel: row.autonomy_level ? String(row.autonomy_level) : null,
      reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : null,
      reported: Number(row.reported) === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  // --- Tasks ---

  public upsertTask(t: TaskRecord): void {
    this.db
      .query(
        `INSERT INTO tasks (id, project_id, parent_task_id, goal_id, title, spec_md, status, priority, assigned_agent_id, source_annotation_id, worktree_branch, handoff_path, retry_count, depends_on_json, auto_retry_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           spec_md = excluded.spec_md,
           status = excluded.status,
           priority = excluded.priority,
           assigned_agent_id = excluded.assigned_agent_id,
           worktree_branch = excluded.worktree_branch,
           handoff_path = excluded.handoff_path,
           retry_count = excluded.retry_count,
           goal_id = CASE WHEN ? = 1 THEN excluded.goal_id ELSE tasks.goal_id END,
           depends_on_json = CASE WHEN ? = 1 THEN excluded.depends_on_json ELSE tasks.depends_on_json END,
           auto_retry_count = CASE WHEN ? = 1 THEN excluded.auto_retry_count ELSE tasks.auto_retry_count END,
           updated_at = excluded.updated_at`,
      )
      .run(
        t.id,
        t.projectId,
        t.parentTaskId,
        t.goalId ?? null,
        t.title,
        t.specMd,
        t.status,
        t.priority,
        t.assignedAgentId,
        t.sourceAnnotationId,
        t.worktreeBranch,
        t.handoffPath,
        t.retryCount,
        JSON.stringify(t.dependsOn ?? []),
        t.autoRetryCount ?? 0,
        t.createdAt,
        t.updatedAt,
        t.goalId !== undefined ? 1 : 0,
        t.dependsOn !== undefined ? 1 : 0,
        t.autoRetryCount !== undefined ? 1 : 0,
      );
  }

  public getTask(id: string): TaskRecord | null {
    const r = this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapTask(r) : null;
  }

  public listTasks(projectId?: string): TaskRecord[] {
    const rows = projectId
      ? (this.db.query("SELECT * FROM tasks WHERE project_id = ? ORDER BY priority ASC, created_at DESC").all(projectId) as Array<
          Record<string, unknown>
        >)
      : (this.db.query("SELECT * FROM tasks ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapTask(r));
  }

  private mapTask(r: Record<string, unknown>): TaskRecord {
    return {
      id: String(r.id),
      projectId: String(r.project_id),
      parentTaskId: r.parent_task_id ? String(r.parent_task_id) : null,
      goalId: r.goal_id ? String(r.goal_id) : null,
      title: String(r.title),
      specMd: String(r.spec_md),
      status: String(r.status) as TaskStatus,
      priority: Number(r.priority),
      assignedAgentId: r.assigned_agent_id ? String(r.assigned_agent_id) : null,
      sourceAnnotationId: r.source_annotation_id ? String(r.source_annotation_id) : null,
      worktreeBranch: r.worktree_branch ? String(r.worktree_branch) : null,
      handoffPath: r.handoff_path ? String(r.handoff_path) : null,
      retryCount: Number(r.retry_count),
      dependsOn: JSON.parse(String(r.depends_on_json || "[]")) as string[],
      autoRetryCount: Number(r.auto_retry_count ?? 0),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  // --- Annotations ---

  public upsertAnnotation(a: AnnotationRecord): void {
    this.db
      .query(
        `INSERT INTO annotations (id, project_id, target_type, file_path, anchor_json, comment, snapshot_data_url, status, linked_task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           comment = excluded.comment,
           status = excluded.status,
           linked_task_id = excluded.linked_task_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        a.id,
        a.projectId,
        a.targetType,
        a.filePath,
        JSON.stringify(a.anchor),
        a.comment,
        a.snapshotDataUrl,
        a.status,
        a.linkedTaskId,
        a.createdAt,
        a.updatedAt,
      );
  }

  public getAnnotation(id: string): AnnotationRecord | null {
    const r = this.db.query("SELECT * FROM annotations WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapAnnotation(r) : null;
  }

  public listAnnotations(projectId?: string): AnnotationRecord[] {
    const rows = projectId
      ? (this.db.query("SELECT * FROM annotations WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Array<
          Record<string, unknown>
        >)
      : (this.db.query("SELECT * FROM annotations ORDER BY created_at DESC").all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapAnnotation(r));
  }

  private mapAnnotation(r: Record<string, unknown>): AnnotationRecord {
    return {
      id: String(r.id),
      projectId: String(r.project_id),
      targetType: String(r.target_type) as AnnotationRecord["targetType"],
      filePath: String(r.file_path),
      anchor: JSON.parse(String(r.anchor_json)) as AnnotationAnchor,
      comment: String(r.comment),
      snapshotDataUrl: r.snapshot_data_url ? String(r.snapshot_data_url) : null,
      status: String(r.status) as AnnotationStatus,
      linkedTaskId: r.linked_task_id ? String(r.linked_task_id) : null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  // --- Memory Fact Graph (Supermemory pattern) ---

  public insertMemoryFact(params: {
    id?: string;
    namespace: string;
    docId?: string | null;
    entity?: string;
    factText: string;
    kind: MemoryKind;
    isStatic?: boolean;
    isInference?: boolean;
    confidence?: number;
    forgetAfter?: number | null;
    supersedesFactId?: string | null;
    extendsFactId?: string | null;
    derivedFromFactIds?: string[];
  }): MemoryFactRecord {
    this.assertWritable();
    const now = Date.now();
    const id = params.id ?? newId("mem");
    let version = 1;

    // Normalize legacy second-scale forgetAfter (< 1e11) to epoch milliseconds.
    const forgetAfterMs =
      params.forgetAfter !== null && params.forgetAfter !== undefined
        ? params.forgetAfter > 0 && params.forgetAfter < 1e11
          ? params.forgetAfter * 1000
          : params.forgetAfter
        : null;

    if (params.supersedesFactId) {
      const prev = this.db
        .query("SELECT version FROM memory_facts WHERE id = ? AND namespace = ?")
        .get(params.supersedesFactId, params.namespace) as {
        version: number;
      } | null;
      if (prev) {
        version = Number(prev.version) + 1;
        this.db
          .query("UPDATE memory_facts SET is_latest = 0, updated_at = ? WHERE id = ? AND namespace = ?")
          .run(now, params.supersedesFactId, params.namespace);
      }
    }

    this.db
      .query(
        `INSERT INTO memory_facts (id, namespace, doc_id, entity, fact_text, kind, version, is_latest, is_forgotten, is_inference, is_static, confidence, valid_from, forget_after, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.namespace,
        params.docId ?? null,
        params.entity ?? "general",
        params.factText,
        params.kind,
        version,
        params.isInference ? 1 : 0,
        params.isStatic ? 1 : 0,
        params.confidence ?? 0.85,
        now,
        forgetAfterMs,
        now,
        now,
      );

    if (params.supersedesFactId) {
      this.addMemoryEdge(id, params.supersedesFactId, "updates");
    }
    if (params.extendsFactId) {
      this.addMemoryEdge(id, params.extendsFactId, "extends");
    }
    for (const src of params.derivedFromFactIds ?? []) {
      this.addMemoryEdge(id, src, "derives");
    }

    return this.getMemoryFact(id)!;
  }

  public addMemoryEdge(srcId: string, dstId: string, rel: MemoryRelation): void {
    this.db
      .query("INSERT OR IGNORE INTO memory_edges (src_id, dst_id, rel, created_at) VALUES (?, ?, ?, ?)")
      .run(srcId, dstId, rel, Date.now());
  }

  public getMemoryFact(id: string): MemoryFactRecord | null {
    const r = this.db.query("SELECT * FROM memory_facts WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapMemoryFact(r) : null;
  }

  public listLiveMemoryFacts(namespace: string, opts?: { isStatic?: boolean; limit?: number }): MemoryFactRecord[] {
    const limit = opts?.limit ?? 50;
    const rows =
      opts?.isStatic === undefined
        ? (this.db
            .query("SELECT * FROM live_memory_facts WHERE namespace = ? ORDER BY updated_at DESC LIMIT ?")
            .all(namespace, limit) as Array<Record<string, unknown>>)
        : (this.db
            .query("SELECT * FROM live_memory_facts WHERE namespace = ? AND is_static = ? ORDER BY updated_at DESC LIMIT ?")
            .all(namespace, opts.isStatic ? 1 : 0, limit) as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapMemoryFact(r));
  }

  public sweepExpiredMemoryFacts(): number {
    return this.runAtomicWrite(() => {
      const now = Date.now();
      const rows = this.db
        .query(
          "UPDATE memory_facts SET is_forgotten = 1, forget_reason = 'expired', updated_at = ? WHERE is_forgotten = 0 AND forget_after IS NOT NULL AND forget_after <= ? RETURNING id",
        )
        .all(now, now) as Array<{ id: string }>;
      return rows.length;
    });
  }

  private buildFtsMatchQueries(rawQuery: string): string[] {
    const rawTokens = rawQuery.match(/[\p{L}\p{N}_]+/gu) ?? [];
    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const tok of rawTokens) {
      const lower = tok.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      tokens.push(tok);
      if (tokens.length >= 16) break;
    }
    if (tokens.length === 0) return [];
    const quoted = tokens.map((t) => `"${t}"`);
    if (quoted.length === 1) return [quoted[0]!];
    return [quoted.join(" "), quoted.join(" OR ")];
  }

  public searchLiveMemoryFacts(namespace: string, query: string, limit = 8): MemoryFactRecord[] {
    return this.listAllLiveFacts({ namespace, query, limit });
  }

  public listAllLiveFacts(opts?: { namespace?: string; query?: string; limit?: number }): MemoryFactRecord[] {
    const limit = Math.max(1, Math.min(500, Math.trunc(opts?.limit ?? 100)));
    const ns = opts?.namespace?.trim() || undefined;
    const q = opts?.query?.trim() || undefined;

    if (!q) {
      const rows = ns
        ? (this.db
            .query("SELECT * FROM live_memory_facts WHERE namespace = ? ORDER BY updated_at DESC LIMIT ?")
            .all(ns, limit) as Array<Record<string, unknown>>)
        : (this.db
            .query("SELECT * FROM live_memory_facts ORDER BY updated_at DESC LIMIT ?")
            .all(limit) as Array<Record<string, unknown>>);
      return rows.map((r) => this.mapMemoryFact(r));
    }

    if (!this.ftsStale) {
      for (const ftsQuery of this.buildFtsMatchQueries(q)) {
        try {
          const rows = ns
            ? (this.db
                .query(
                  `SELECT lf.* FROM facts_fts f
                   JOIN live_memory_facts lf ON lf.rowid = f.rowid
                   WHERE lf.namespace = ? AND facts_fts MATCH ?
                   ORDER BY bm25(facts_fts) LIMIT ?`,
                )
                .all(ns, ftsQuery, limit) as Array<Record<string, unknown>>)
            : (this.db
                .query(
                  `SELECT lf.* FROM facts_fts f
                   JOIN live_memory_facts lf ON lf.rowid = f.rowid
                   WHERE facts_fts MATCH ?
                   ORDER BY bm25(facts_fts) LIMIT ?`,
                )
                .all(ftsQuery, limit) as Array<Record<string, unknown>>);
          if (rows.length > 0) return rows.map((r) => this.mapMemoryFact(r));
        } catch {
          // Fallback to next query / LIKE
        }
      }
    }

    const like = `%${q}%`;
    const rows = ns
      ? (this.db
          .query(
            "SELECT * FROM live_memory_facts WHERE namespace = ? AND (fact_text LIKE ? OR entity LIKE ?) ORDER BY updated_at DESC LIMIT ?",
          )
          .all(ns, like, like, limit) as Array<Record<string, unknown>>)
      : (this.db
          .query(
            "SELECT * FROM live_memory_facts WHERE (fact_text LIKE ? OR entity LIKE ?) ORDER BY updated_at DESC LIMIT ?",
          )
          .all(like, like, limit) as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapMemoryFact(r));
  }

  public forgetMemoryFact(factId: string, reason: string): boolean {
    return this.runAtomicWrite(() => {
      const res = this.db
        .query("UPDATE memory_facts SET is_forgotten = 1, is_latest = 0, forget_reason = ?, updated_at = ? WHERE id = ? AND is_forgotten = 0")
        .run(reason, Date.now(), factId);
      return res.changes > 0;
    });
  }

  public upsertMemoryEmbedding(factId: string, model: string, vector: number[]): void {
    if (!factId || !model || !Array.isArray(vector) || vector.length === 0) return;
    this.assertWritable();
    const f32 = new Float32Array(vector);
    const blob = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    this.db
      .query(
        `INSERT INTO memory_embeddings (fact_id, model, dims, vector_blob, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fact_id) DO UPDATE SET
           model = excluded.model,
           dims = excluded.dims,
           vector_blob = excluded.vector_blob,
           updated_at = excluded.updated_at`,
      )
      .run(factId, model, f32.length, blob, Date.now());
  }

  public listMemoryEmbeddingsByNamespace(
    namespace: string,
  ): Array<{ factId: string; model: string; dims: number; vector: Float32Array }> {
    const rows = this.db
      .query(
        `SELECT me.fact_id, me.model, me.dims, me.vector_blob
         FROM memory_embeddings me
         JOIN live_memory_facts lf ON lf.id = me.fact_id
         WHERE lf.namespace = ?`,
      )
      .all(namespace) as Array<{ fact_id: string; model: string; dims: number; vector_blob: Uint8Array | ArrayBuffer }>;

    const out: Array<{ factId: string; model: string; dims: number; vector: Float32Array }> = [];
    for (const r of rows) {
      const rawBytes = r.vector_blob instanceof Uint8Array ? r.vector_blob : new Uint8Array(r.vector_blob);
      const dims = Math.min(Number(r.dims), Math.floor(rawBytes.byteLength / 4));
      if (dims <= 0) continue;
      // Copy into a freshly allocated buffer to guarantee 4-byte Float32Array alignment.
      const aligned = new Uint8Array(dims * 4);
      aligned.set(rawBytes.subarray(0, dims * 4));
      out.push({
        factId: String(r.fact_id),
        model: String(r.model),
        dims,
        vector: new Float32Array(aligned.buffer, 0, dims),
      });
    }
    return out;
  }

  public getRelatedFacts(factIds: string | string[], maxHops = 3): MemoryFactRecord[] {
    const seeds = [...new Set((Array.isArray(factIds) ? factIds : [factIds]).filter(Boolean))];
    if (seeds.length === 0) return [];
    const hops = Math.min(Math.max(Math.trunc(maxHops), 1), 3);
    const valuesSql = seeds.map(() => "(?, 0)").join(", ");
    const placeholders = seeds.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `WITH RECURSIVE walk(id, depth) AS (
           VALUES ${valuesSql}
           UNION
           SELECT CASE WHEN e.src_id = w.id THEN e.dst_id ELSE e.src_id END, w.depth + 1
           FROM walk w
           JOIN memory_edges e ON e.src_id = w.id OR e.dst_id = w.id
           WHERE w.depth < ?
         )
         SELECT DISTINCT f.* FROM walk w
         JOIN live_memory_facts f ON f.id = w.id
         WHERE w.depth > 0 AND f.id NOT IN (${placeholders})`,
      )
      .all(...seeds, hops, ...seeds) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapMemoryFact(r));
  }

  private mapMemoryFact(r: Record<string, unknown>): MemoryFactRecord {
    return {
      id: String(r.id),
      namespace: String(r.namespace),
      docId: r.doc_id ? String(r.doc_id) : null,
      entity: String(r.entity),
      factText: String(r.fact_text),
      kind: String(r.kind) as MemoryKind,
      version: Number(r.version),
      isLatest: Number(r.is_latest) === 1,
      isForgotten: Number(r.is_forgotten) === 1,
      isInference: Number(r.is_inference) === 1,
      isStatic: Number(r.is_static) === 1,
      confidence: Number(r.confidence),
      validFrom: Number(r.valid_from),
      forgetAfter: r.forget_after !== null && r.forget_after !== undefined ? Number(r.forget_after) : null,
      forgetReason: r.forget_reason ? String(r.forget_reason) : null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  // --- Inbox Notices ---

  public addInboxNotice(level: "info" | "warn" | "action", message: string, opts?: { projectId?: string; agentId?: string }): string {
    const id = newId("ntc");
    this.db
      .query("INSERT INTO inbox_notices (id, level, project_id, agent_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, level, opts?.projectId ?? null, opts?.agentId ?? null, message, Date.now());
    return id;
  }

  public listInboxNotices(limit = 20): Array<{
    id: string;
    level: "info" | "warn" | "action";
    projectId?: string;
    agentId?: string;
    message: string;
    createdAt: number;
  }> {
    const rows = this.db
      .query("SELECT * FROM inbox_notices WHERE dismissed = 0 ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      level: String(r.level) as "info" | "warn" | "action",
      projectId: r.project_id ? String(r.project_id) : undefined,
      agentId: r.agent_id ? String(r.agent_id) : undefined,
      message: String(r.message),
      createdAt: Number(r.created_at),
    }));
  }

  // --- Checkpoints & Event Queries ---

  public upsertCheckpoint(cp: {
    id: string;
    scopeKey: string;
    agentId: string;
    cwd: string;
    turnNum: number;
    refName: string;
    commitSha: string;
    createdAt: number;
  }): void {
    this.runAtomicWrite(() => {
      this.db
        .query(
          `INSERT OR REPLACE INTO checkpoints (id, scope_key, agent_id, cwd, turn_num, ref_name, commit_sha, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(cp.id, cp.scopeKey, cp.agentId, cp.cwd, cp.turnNum, cp.refName, cp.commitSha, cp.createdAt);
    });
  }

  public getCheckpoint(id: string): {
    id: string;
    scopeKey: string;
    agentId: string;
    cwd: string;
    turnNum: number;
    refName: string;
    commitSha: string;
    createdAt: number;
  } | null {
    const r = this.db.query("SELECT * FROM checkpoints WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: String(r.id),
      scopeKey: String(r.scope_key),
      agentId: String(r.agent_id),
      cwd: String(r.cwd),
      turnNum: Number(r.turn_num),
      refName: String(r.ref_name),
      commitSha: String(r.commit_sha),
      createdAt: Number(r.created_at),
    };
  }

  public listRecentEvents(topic: string, eventType: string, limit = 20): unknown[] {
    const rows = this.db
      .query("SELECT payload_json FROM events WHERE topic = ? AND event_type = ? ORDER BY seq DESC LIMIT ?")
      .all(topic, eventType, limit) as Array<{ payload_json: string }>;
    return rows.reverse().map((r) => JSON.parse(r.payload_json));
  }

  // --- Phase 3: Conflict Debates ---

  public upsertDebate(d: DebateRecord): void {
    this.assertWritable();
    this.db
      .query(
        `INSERT INTO debates (id, project_id, task_id, topic, reason, participant_agent_ids_json, status, round_count, max_rounds, escalated_to_agent_id, resolution_summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           round_count = excluded.round_count,
           escalated_to_agent_id = excluded.escalated_to_agent_id,
           resolution_summary = excluded.resolution_summary,
           updated_at = excluded.updated_at`,
      )
      .run(
        d.id,
        d.projectId,
        d.taskId,
        d.topic,
        d.reason,
        JSON.stringify(d.participantAgentIds),
        d.status,
        d.roundCount,
        d.maxRounds,
        d.escalatedToAgentId,
        d.resolutionSummary,
        d.createdAt,
        d.updatedAt,
      );
  }

  public getDebate(id: string): DebateRecord | null {
    const r = this.db.query("SELECT * FROM debates WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapDebate(r) : null;
  }

  public listDebates(projectId?: string): DebateRecord[] {
    const rows = projectId
      ? (this.db.query("SELECT * FROM debates WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Array<
          Record<string, unknown>
        >)
      : (this.db.query("SELECT * FROM debates ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapDebate(r));
  }

  private mapDebate(r: Record<string, unknown>): DebateRecord {
    return {
      id: String(r.id),
      projectId: String(r.project_id),
      taskId: r.task_id ? String(r.task_id) : null,
      topic: String(r.topic),
      reason: String(r.reason),
      participantAgentIds: JSON.parse(String(r.participant_agent_ids_json || "[]")) as string[],
      status: String(r.status) as DebateStatus,
      roundCount: Number(r.round_count),
      maxRounds: Number(r.max_rounds),
      escalatedToAgentId: r.escalated_to_agent_id ? String(r.escalated_to_agent_id) : null,
      resolutionSummary: r.resolution_summary ? String(r.resolution_summary) : null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  public appendDebateMessage(m: DebateMessageRecord): void {
    this.assertWritable();
    this.db
      .query(
        "INSERT INTO debate_messages (id, debate_id, round_num, agent_id, position, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(m.id, m.debateId, m.roundNum, m.agentId, m.position, m.evidence, m.createdAt);
  }

  public listDebateMessages(debateId: string): DebateMessageRecord[] {
    const rows = this.db
      .query("SELECT * FROM debate_messages WHERE debate_id = ? ORDER BY round_num ASC, created_at ASC")
      .all(debateId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      debateId: String(r.debate_id),
      roundNum: Number(r.round_num),
      agentId: String(r.agent_id),
      position: String(r.position),
      evidence: r.evidence ? String(r.evidence) : null,
      createdAt: Number(r.created_at),
    }));
  }

  // --- Phase 3: Independent Verifications ---

  public upsertVerification(v: VerificationReportRecord): void {
    this.assertWritable();
    this.db
      .query(
        `INSERT OR REPLACE INTO verifications (id, project_id, target_kind, target_id, author_agent_id, author_provider, verifier_agent_id, verifier_session_id, verifier_provider, verifier_model, cross_family, verdict, summary, checks_json, findings_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        v.id,
        v.projectId,
        v.targetKind,
        v.targetId,
        v.authorAgentId,
        v.authorProvider,
        v.verifierAgentId,
        v.verifierSessionId,
        v.verifierProvider,
        v.verifierModel,
        v.crossFamily ? 1 : 0,
        v.verdict,
        v.summary,
        JSON.stringify(v.checks),
        JSON.stringify(v.findings),
        v.createdAt,
      );
  }

  public getVerification(id: string): VerificationReportRecord | null {
    const r = this.db.query("SELECT * FROM verifications WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapVerification(r) : null;
  }

  public listVerifications(opts?: { projectId?: string; targetKind?: "task" | "selfmod"; targetId?: string; limit?: number }): VerificationReportRecord[] {
    const limit = opts?.limit ?? 40;
    let rows: Array<Record<string, unknown>>;
    if (opts?.targetKind && opts?.targetId) {
      rows = this.db
        .query("SELECT * FROM verifications WHERE target_kind = ? AND target_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(opts.targetKind, opts.targetId, limit) as Array<Record<string, unknown>>;
    } else if (opts?.targetKind) {
      rows = this.db
        .query("SELECT * FROM verifications WHERE target_kind = ? ORDER BY created_at DESC LIMIT ?")
        .all(opts.targetKind, limit) as Array<Record<string, unknown>>;
    } else if (opts?.projectId) {
      rows = this.db
        .query("SELECT * FROM verifications WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(opts.projectId, limit) as Array<Record<string, unknown>>;
    } else {
      rows = this.db.query("SELECT * FROM verifications ORDER BY created_at DESC LIMIT ?").all(limit) as Array<
        Record<string, unknown>
      >;
    }
    return rows.map((r) => this.mapVerification(r));
  }

  public listVerificationsByTarget(targetKind: "task" | "selfmod", limit = 40): VerificationReportRecord[] {
    const rows = this.db
      .query("SELECT * FROM verifications WHERE target_kind = ? ORDER BY created_at DESC LIMIT ?")
      .all(targetKind, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapVerification(r));
  }

  private mapVerification(r: Record<string, unknown>): VerificationReportRecord {
    return {
      id: String(r.id),
      projectId: r.project_id ? String(r.project_id) : null,
      targetKind: String(r.target_kind) as "task" | "selfmod",
      targetId: String(r.target_id),
      authorAgentId: r.author_agent_id ? String(r.author_agent_id) : null,
      authorProvider: r.author_provider ? String(r.author_provider) : null,
      verifierAgentId: String(r.verifier_agent_id),
      verifierSessionId: String(r.verifier_session_id),
      verifierProvider: String(r.verifier_provider),
      verifierModel: String(r.verifier_model),
      crossFamily: Number(r.cross_family) === 1,
      verdict: String(r.verdict) as VerificationVerdict,
      summary: String(r.summary),
      checks: JSON.parse(String(r.checks_json || "[]")) as VerificationCheckResult[],
      findings: JSON.parse(String(r.findings_json || "[]")) as string[],
      createdAt: Number(r.created_at),
    };
  }

  // --- Phase 3: Self-Modification Proposals ---

  public upsertSelfModProposal(p: SelfModProposalRecord): void {
    this.assertWritable();
    this.db
      .query(
        `INSERT INTO self_mod_proposals (id, kind, target_id, title, rationale, author_agent_id, staging_path, live_path, backup_path, content_sha256, status, verification_id, verification_summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           backup_path = excluded.backup_path,
           status = excluded.status,
           verification_id = excluded.verification_id,
           verification_summary = excluded.verification_summary,
           updated_at = excluded.updated_at`,
      )
      .run(
        p.id,
        p.kind,
        p.targetId,
        p.title,
        p.rationale,
        p.authorAgentId,
        p.stagingPath,
        p.livePath,
        p.backupPath,
        p.contentSha256,
        p.status,
        p.verificationId,
        p.verificationSummary,
        p.createdAt,
        p.updatedAt,
      );
  }

  public getSelfModProposal(id: string): SelfModProposalRecord | null {
    const r = this.db.query("SELECT * FROM self_mod_proposals WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapSelfModProposal(r) : null;
  }

  public listSelfModProposals(limit = 40): SelfModProposalRecord[] {
    const rows = this.db
      .query("SELECT * FROM self_mod_proposals ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapSelfModProposal(r));
  }

  private mapSelfModProposal(r: Record<string, unknown>): SelfModProposalRecord {
    return {
      id: String(r.id),
      kind: String(r.kind) as SelfModKind,
      targetId: String(r.target_id),
      title: String(r.title),
      rationale: String(r.rationale),
      authorAgentId: r.author_agent_id ? String(r.author_agent_id) : null,
      stagingPath: String(r.staging_path),
      livePath: String(r.live_path),
      backupPath: r.backup_path ? String(r.backup_path) : null,
      contentSha256: String(r.content_sha256),
      status: String(r.status) as SelfModStatus,
      verificationId: r.verification_id ? String(r.verification_id) : null,
      verificationSummary: r.verification_summary ? String(r.verification_summary) : null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (!this.quarantined) {
        this.db.close(false);
      }
    } finally {
      if (this.ownsLock && existsSync(this.lockPath)) {
        try {
          unlinkSync(this.lockPath);
        } catch {
          // ignore
        }
        this.ownsLock = false;
      }
    }
  }
}
