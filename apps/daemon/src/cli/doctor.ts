import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  resolveHubConfigInspection,
  listSecretPresence,
  type ConfigSourceKind,
  type SecretPresence,
} from "../config";

const CLI_TOOLS = ["bun", "git", "devin", "opencode", "claude", "codex"] as const;

export interface WriterLockDiagnostics {
  lockPath: string;
  exists: boolean;
  pid: number | null;
  startedAt: number | null;
  exeHint: string | null;
  pidAlive: boolean;
  stale: boolean;
  detail: string;
}

export interface DbDiagnostics {
  dbPath: string;
  exists: boolean;
  walExists: boolean;
  shmExists: boolean;
  usedTempCopy: boolean;
  schemaVersion: number | null;
  epoch: number | null;
  ftsStale: boolean | null;
  hasPhase3Tables: boolean;
  hasEmbeddingsTable: boolean;
  error: string | null;
}

export interface DoctorReport {
  envRoot: string | null;
  rootDir: string;
  configSource: ConfigSourceKind | "parse_error";
  configSourcePath: string | null;
  configError: string | null;
  secretsPath: string;
  secretsFileExists: boolean;
  daemonTokenExists: boolean;
  secrets: SecretPresence[];
  writerLock: WriterLockDiagnostics;
  database: DbDiagnostics;
  tools: Record<string, string | null>;
}

function isPidAliveRaw(pid: number): boolean {
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

function isWindowsProcessMatchingHint(pid: number, exeHint: string | null, startedAt: number | null): boolean {
  if (process.platform !== "win32") return true;
  try {
    const script =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue; ` +
      `if (-not $p) { "MISSING" } else { "$($p.Name)|$(([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds())" }`;
    const proc = Bun.spawnSync(["powershell", "-NoProfile", "-Command", script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return true;
    const out = proc.stdout.toString().trim();
    if (!out || out === "MISSING") return false;
    const [procName, rawStart] = out.split("|");
    if (exeHint && procName && !procName.toLowerCase().includes(exeHint.toLowerCase())) {
      return false;
    }
    if (startedAt && rawStart) {
      const createdMs = Number(rawStart);
      if (Number.isFinite(createdMs) && createdMs - startedAt > 10_000) {
        return false;
      }
    }
    return true;
  } catch {
    return true;
  }
}

function inspectWriterLock(dbPath: string): WriterLockDiagnostics {
  const lockPath = `${dbPath}.writer.lock`;
  if (!existsSync(lockPath)) {
    return {
      lockPath,
      exists: false,
      pid: null,
      startedAt: null,
      exeHint: null,
      pidAlive: false,
      stale: false,
      detail: "none",
    };
  }

  let pid: number | null = null;
  let startedAt: number | null = null;
  let exeHint: string | null = null;
  let parseFailed = false;
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as {
      pid?: unknown;
      startedAt?: unknown;
      exeHint?: unknown;
    };
    if (typeof raw.pid === "number") pid = raw.pid;
    if (typeof raw.startedAt === "number") startedAt = raw.startedAt;
    if (typeof raw.exeHint === "string") exeHint = raw.exeHint;
  } catch {
    parseFailed = true;
  }

  if (parseFailed || pid === null) {
    return {
      lockPath,
      exists: true,
      pid,
      startedAt,
      exeHint,
      pidAlive: false,
      stale: true,
      detail: "unreadable_or_missing_pid (stale)",
    };
  }

  const rawAlive = isPidAliveRaw(pid);
  const pidAlive = rawAlive && isWindowsProcessMatchingHint(pid, exeHint, startedAt);
  return {
    lockPath,
    exists: true,
    pid,
    startedAt,
    exeHint,
    pidAlive,
    stale: !pidAlive,
    detail: pidAlive ? `active (pid=${pid})` : `stale (dead or reused pid=${pid})`,
  };
}

function inspectDatabaseReadOnly(dbPath: string, lockExists: boolean): DbDiagnostics {
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const walExists = existsSync(walPath);
  const shmExists = existsSync(shmPath);

  if (!existsSync(dbPath)) {
    return {
      dbPath,
      exists: false,
      walExists,
      shmExists,
      usedTempCopy: false,
      schemaVersion: null,
      epoch: null,
      ftsStale: null,
      hasPhase3Tables: false,
      hasEmbeddingsTable: false,
      error: null,
    };
  }

  // Always copy to a temp dir when WAL/SHM/lock exist (and by default to guarantee zero mutation to live state.db)
  const shouldCopy = walExists || shmExists || lockExists || true;
  let tmpDir: string | null = null;
  let inspectPath = dbPath;
  let db: Database | null = null;

  try {
    if (shouldCopy) {
      tmpDir = mkdtempSync(join(tmpdir(), "bf-doctor-db-"));
      const base = basename(dbPath);
      inspectPath = join(tmpDir, base);
      copyFileSync(dbPath, inspectPath);
      if (walExists) copyFileSync(walPath, join(tmpDir, `${base}-wal`));
      if (shmExists) copyFileSync(shmPath, join(tmpDir, `${base}-shm`));
    }

    // Temp copy may hold uncheckpointed WAL frames; opening the temp copy lets SQLite replay WAL safely without touching real state.db.
    db = shouldCopy ? new Database(inspectPath) : new Database(inspectPath, { readonly: true });
    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    const tableSet = new Set(tables);

    let schemaVersion: number | null = null;
    let epoch: number | null = null;
    let ftsStale: boolean | null = null;
    if (tableSet.has("runtime_meta")) {
      const meta = db
        .query("SELECT schema_version, epoch, fts_stale FROM runtime_meta WHERE id = 1")
        .get() as { schema_version: number; epoch: number; fts_stale: number } | null;
      if (meta) {
        schemaVersion = Number(meta.schema_version);
        epoch = Number(meta.epoch);
        ftsStale = Number(meta.fts_stale) === 1;
      }
    }

    const hasPhase3Tables =
      tableSet.has("debates") &&
      tableSet.has("debate_messages") &&
      tableSet.has("verifications") &&
      tableSet.has("self_mod_proposals");
    const hasEmbeddingsTable = tableSet.has("memory_embeddings");

    return {
      dbPath,
      exists: true,
      walExists,
      shmExists,
      usedTempCopy: shouldCopy,
      schemaVersion,
      epoch,
      ftsStale,
      hasPhase3Tables,
      hasEmbeddingsTable,
      error: null,
    };
  } catch (err) {
    return {
      dbPath,
      exists: true,
      walExists,
      shmExists,
      usedTempCopy: shouldCopy,
      schemaVersion: null,
      epoch: null,
      ftsStale: null,
      hasPhase3Tables: false,
      hasEmbeddingsTable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore Windows handle release delay
      }
    }
  }
}

export function collectDoctorReport(overrides?: {
  configPath?: string;
  rootDir?: string;
  dbPath?: string;
}): DoctorReport {
  const envRoot = process.env.BOT_FACTORY_ROOT?.trim() || null;

  let inspection;
  let configError: string | null = null;
  try {
    inspection = resolveHubConfigInspection(overrides);
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
    const fallbackRoot = overrides?.rootDir?.trim() || envRoot || "~/bot-factory";
    inspection = resolveHubConfigInspection({
      rootDir: fallbackRoot,
      configPath: join(fallbackRoot, "__missing_config__.json"),
      dbPath: overrides?.dbPath,
    });
    const tools: Record<string, string | null> = {};
    for (const cmd of CLI_TOOLS) {
      tools[cmd] = Bun.which(cmd);
    }
    const writerLock = inspectWriterLock(inspection.dbPath);
    const database = inspectDatabaseReadOnly(inspection.dbPath, writerLock.exists);
    return {
      envRoot,
      rootDir: inspection.rootDir,
      configSource: "parse_error",
      configSourcePath: overrides?.configPath ?? join(inspection.systemDir, "config.json"),
      configError,
      secretsPath: inspection.secretsPath,
      secretsFileExists: existsSync(inspection.secretsPath),
      daemonTokenExists: existsSync(join(inspection.systemDir, ".daemon-token")),
      secrets: listSecretPresence(inspection.secretsPath, inspection.config),
      writerLock,
      database,
      tools,
    };
  }

  const tools: Record<string, string | null> = {};
  for (const cmd of CLI_TOOLS) {
    tools[cmd] = Bun.which(cmd);
  }

  const writerLock = inspectWriterLock(inspection.dbPath);
  const database = inspectDatabaseReadOnly(inspection.dbPath, writerLock.exists);

  return {
    envRoot,
    rootDir: inspection.rootDir,
    configSource: inspection.configSource,
    configSourcePath: inspection.configSourcePath,
    configError,
    secretsPath: inspection.secretsPath,
    secretsFileExists: existsSync(inspection.secretsPath),
    daemonTokenExists: existsSync(join(inspection.systemDir, ".daemon-token")),
    secrets: listSecretPresence(inspection.secretsPath, inspection.config),
    writerLock,
    database,
    tools,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("Bot-Factory Doctor (read-only preflight)");
  lines.push(`- BOT_FACTORY_ROOT env : ${report.envRoot ?? "(unset)"}`);
  lines.push(`- Resolved rootDir     : ${report.rootDir}`);
  lines.push(
    `- Config source        : ${report.configSource}${report.configSourcePath ? ` (${report.configSourcePath})` : ""}`,
  );
  if (report.configError) {
    lines.push(`- Config error         : ${report.configError}`);
  }
  lines.push(`- secrets.env          : ${report.secretsFileExists ? "present" : "missing"} (${report.secretsPath})`);
  lines.push(`- .daemon-token        : ${report.daemonTokenExists ? "present" : "missing"}`);
  lines.push("- Secret presence      :");
  for (const s of report.secrets) {
    lines.push(`    * ${s.key}: present=${String(s.present)} source=${s.source}`);
  }
  lines.push(
    `- .writer.lock         : ${report.writerLock.exists ? report.writerLock.detail : "absent"} (${report.writerLock.lockPath})`,
  );
  if (report.database.error) {
    lines.push(`- State DB             : error (${report.database.error})`);
  } else if (!report.database.exists) {
    lines.push(`- State DB             : not initialized (${report.database.dbPath})`);
  } else {
    lines.push(
      `- State DB             : schema_version=${report.database.schemaVersion ?? "unknown"} epoch=${report.database.epoch ?? "unknown"} fts_stale=${String(report.database.ftsStale)} wal=${String(report.database.walExists)} phase3_tables=${String(report.database.hasPhase3Tables)} embeddings=${String(report.database.hasEmbeddingsTable)} (inspected via temp copy=${String(report.database.usedTempCopy)})`,
    );
  }
  lines.push("- CLI availability     :");
  for (const cmd of CLI_TOOLS) {
    const found = report.tools[cmd];
    lines.push(`    * ${cmd}: ${found ? `found (${found})` : "not found"}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const report = collectDoctorReport();
  console.log(formatDoctorReport(report));
}
