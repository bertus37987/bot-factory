import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateAutonomyPermission } from "../apps/daemon/src/runtimes/acpSubprocessRuntime";

function evalShell(title: string, worktree: string, autonomyLevel: "medium" | "high" = "medium") {
  return evaluateAutonomyPermission(
    {
      toolCall: { title, kind: "execute" },
      options: [{ optionId: "allow", kind: "allow_once" }],
    },
    worktree,
    autonomyLevel,
  );
}

describe("ACP autonomy shell containment", () => {
  it("does not auto-approve medium shell reads outside the worktree", () => {
    const worktree = mkdtempSync(join(tmpdir(), "bf-autonomy-"));
    try {
      for (const command of [
        "cat /etc/passwd",
        "cat ~/.aws/credentials",
        "cat ~/.config/gh/hosts.yml",
        "cat ../outside-secret.txt",
        'cat "/etc/passwd"',
      ]) {
        const result = evalShell(command, worktree);
        expect(result.decision).toBe("escalate");
        expect(result.reason).not.toBe("safe_shell_command_in_worktree");
      }
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("still auto-approves in-worktree reads and standard build/test commands in medium mode", () => {
    const worktree = mkdtempSync(join(tmpdir(), "bf-autonomy-"));
    try {
      for (const command of ["cat notes.txt", 'cat "docs/plan.md"', "rg TODO packages", "bun test", "bun run typecheck"]) {
        expect(evalShell(command, worktree).decision).toBe("allow");
      }
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("documents the intentionally risky published high-autonomy behavior", () => {
    const worktree = mkdtempSync(join(tmpdir(), "bf-autonomy-"));
    try {
      expect(evalShell("curl https://example.com", worktree, "medium").decision).toBe("escalate");
      expect(evalShell("curl https://example.com", worktree, "high").decision).toBe("allow");
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
