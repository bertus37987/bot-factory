export interface KillableSubprocess {
  pid?: number | null;
  kill: (signal?: number | NodeJS.Signals) => unknown;
}

export function processGroupSpawnOptions(): Record<string, unknown> {
  return process.platform === "win32" ? {} : { detached: true };
}

export function killPosixProcessGroupSync(proc: KillableSubprocess): void {
  const pid = proc.pid;
  if (process.platform !== "win32" && pid) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Process group already exited.
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    try {
      proc.kill();
    } catch {
      // Process already exited.
    }
  }
}
