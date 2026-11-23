import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBotFactoryDaemon, type BotFactoryApp } from "../apps/daemon/src/index";

const tempDirs: string[] = [];
const runningApps: BotFactoryApp[] = [];
let prevOfflineMock: string | undefined;

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "bf-browser-api-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (runningApps.length > 0) {
    runningApps.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows handle release delay
    }
  }
  if (prevOfflineMock === undefined) delete process.env.BOT_FACTORY_OFFLINE_MOCK;
  else process.env.BOT_FACTORY_OFFLINE_MOCK = prevOfflineMock;
  prevOfflineMock = undefined;
});

describe("Read-only in-app browser API security", () => {
  it("lists safe repo files, blocks traversal/sensitive/binary reads, and reports the workspace diff", async () => {
    prevOfflineMock = process.env.BOT_FACTORY_OFFLINE_MOCK;
    process.env.BOT_FACTORY_OFFLINE_MOCK = "1";
    const rootDir = makeTempRoot();
    const app = startBotFactoryDaemon({ rootDir, port: 0 });
    runningApps.push(app);

    const created = app.engine.executeCommand({
      commandId: "browser_api_project",
      type: "project.create",
      name: "Browser API",
      seedDemoArtifacts: false,
    }) as { project: { id: string; rootPath: string; repoPath: string } };
    const projectId = created.project.id;
    const repoPath = created.project.repoPath;

    // Plant sensitive files and a binary file in the managed repo.
    writeFileSync(join(repoPath, ".env"), "SECRET=topsecret\n", "utf8");
    writeFileSync(join(repoPath, "secrets.env"), "API_KEY=topsecret\n", "utf8");
    writeFileSync(join(repoPath, "binary.bin"), Buffer.from([0, 1, 2, 3, 4, 0]));

    const token = readFileSync(join(rootDir, "system", ".daemon-token"), "utf8").trim();
    const authHeaders = { "x-bf-token": token };

    // Unauthenticated requests to /api/projects/* MUST fail closed with 401.
    expect((await fetch(`${app.url}/api/projects/${projectId}/files`)).status).toBe(401);
    expect(
      (await fetch(`${app.url}/api/projects/${projectId}/file?path=${encodeURIComponent("README.md")}`)).status,
    ).toBe(401);
    expect((await fetch(`${app.url}/api/projects/${projectId}/diff`)).status).toBe(401);

    // --- /files ---
    const filesRes = await fetch(`${app.url}/api/projects/${projectId}/files`, { headers: authHeaders });
    expect(filesRes.status).toBe(200);
    const filesBody = (await filesRes.json()) as { files: Array<{ relativePath: string; name: string }> };
    const listed = filesBody.files.map((f) => f.relativePath);
    expect(listed).toContain("README.md");
    expect(listed).not.toContain(".env");
    expect(listed).not.toContain("secrets.env");
    expect(listed).not.toContain(".git");
    expect(listed.some((p) => p.startsWith(".git/"))).toBe(false);
    expect(filesBody.files.find((f) => f.relativePath === "README.md")?.name).toBe("README.md");

    // --- /file happy path ---
    const readRes = await fetch(
      `${app.url}/api/projects/${projectId}/file?path=${encodeURIComponent("README.md")}`,
      { headers: authHeaders },
    );
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as {
      path: string;
      content: string;
      sizeBytes: number;
      truncated: boolean;
    };
    expect(readBody.path).toBe("README.md");
    expect(readBody.content).toContain("# Browser API");
    expect(readBody.sizeBytes).toBeGreaterThan(0);
    expect(readBody.truncated).toBe(false);

    // --- /file blocked paths ---
    for (const blockedPath of ["../project.json", ".git/config", ".env", "secrets.env"]) {
      const res = await fetch(
        `${app.url}/api/projects/${projectId}/file?path=${encodeURIComponent(blockedPath)}`,
        { headers: authHeaders },
      );
      expect(res.status).toBe(403);
    }

    // --- /file binary rejection ---
    const binaryRes = await fetch(
      `${app.url}/api/projects/${projectId}/file?path=${encodeURIComponent("binary.bin")}`,
      { headers: authHeaders },
    );
    expect(binaryRes.status).toBe(415);

    // --- /diff: modify a tracked file and add an untracked file ---
    writeFileSync(
      join(repoPath, "README.md"),
      "# Browser API\n\nManaged by Bot Factory.\n\nModified by test.\n",
      "utf8",
    );
    writeFileSync(join(repoPath, "notes.txt"), "alpha\nbeta\n", "utf8");

    const diffRes = await fetch(`${app.url}/api/projects/${projectId}/diff`, { headers: authHeaders });
    expect(diffRes.status).toBe(200);
    const diff = (await diffRes.json()) as {
      branch: string;
      filesChanged: number;
      insertions: number;
      deletions: number;
      files: Array<{ path: string; status: string; added: number; removed: number; patch: string }>;
    };
    expect(diff.branch).toBe("main");
    expect(diff.filesChanged).toBeGreaterThan(0);
    expect(diff.insertions).toBeGreaterThan(0);

    const readme = diff.files.find((f) => f.path === "README.md");
    expect(readme?.status).toBe("modified");
    expect(readme?.patch).toContain("Modified by test.");
    // Regression guard: trimmed `git status --porcelain` (" M README.md") must never chop the first character.
    expect(diff.files.some((f) => f.path === "EADME.md")).toBe(false);
    expect(diff.files.map((f) => f.path).sort()).toEqual(["README.md", "binary.bin", "notes.txt"]);

    const notes = diff.files.find((f) => f.path === "notes.txt");
    expect(notes?.status).toBe("untracked");
    expect(notes?.patch.startsWith("--- /dev/null")).toBe(true);
    expect(notes?.patch).toContain("+alpha");

    // Sensitive paths never leak through the diff feed.
    expect(diff.files.some((f) => f.path === ".env" || f.path === "secrets.env")).toBe(false);
  });
});
