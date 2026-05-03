import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { MemoryRuntimeWorkspaceService } from "../../src-electron/memory-runtime-workspace.js";

describe("MemoryRuntimeWorkspaceService", () => {
  it("prepareRun は固定 workspace を作り直し、ロックを作成して template をコピーする", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));
    const templateRootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-template-"));
    const workspaceTemplateDir = path.join(templateRootPath, "workspace");

    try {
      await writeFile(path.join(templateRootPath, "AGENTS.md"), "# AGENTS\n", "utf8");
      await writeFile(path.join(templateRootPath, "provider-openai.md"), "# openai\n", "utf8");
      await mkdir(workspaceTemplateDir, { recursive: true });
      await writeFile(path.join(workspaceTemplateDir, "nested.md"), "# nested\n", "utf8");

      const service = new MemoryRuntimeWorkspaceService({
        userDataPath,
        templateRootPath,
      });

      const result = await service.prepareRun();
      const expectedWorkspacePath = path.join(userDataPath, "memory-runtime", "current");

      assert.equal(result.workspacePath, expectedWorkspacePath);
      assert.equal(service.getWorkspacePath(), expectedWorkspacePath);
      assert.equal(service.getCurrentWorkspacePath(), expectedWorkspacePath);
      assert.equal(result.lockPath, path.join(expectedWorkspacePath, ".lock"));
      assert.equal(await exists(result.lockPath), true);
      assert.equal(await exists(path.join(expectedWorkspacePath, "AGENTS.md")), true);
      assert.equal(await exists(path.join(expectedWorkspacePath, "provider-openai.md")), true);
      assert.equal(await exists(path.join(expectedWorkspacePath, "workspace", "nested.md")), true);

      const copiedAgents = await readFile(path.join(expectedWorkspacePath, "AGENTS.md"), "utf8");
      assert.match(copiedAgents, /AGENTS/);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
      await rm(templateRootPath, { recursive: true, force: true });
    }
  });

  it("prepareRun は lock が既にある場合は上書きせずエラーにする", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));
    const workspacePath = path.join(userDataPath, "memory-runtime", "current");
    const lockPath = path.join(workspacePath, ".lock");

    try {
      await mkdir(workspacePath, { recursive: true });
      await writeFile(lockPath, "stale", "utf8");
      await writeFile(path.join(workspacePath, "keep.txt"), "keep", "utf8");

      const service = new MemoryRuntimeWorkspaceService({ userDataPath });

      await assert.rejects(() => service.prepareRun(), /already in use/i);
      assert.equal(await readFile(lockPath, "utf8"), "stale");
      assert.equal(await readFile(path.join(workspacePath, "keep.txt"), "utf8"), "keep");
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("acquireLock は新しい lock が残っている場合はエラーにし、stale lock は上書きして取得できる", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));
    const workspacePath = path.join(userDataPath, "memory-runtime", "current");
    const lockPath = path.join(workspacePath, ".lock");

    try {
      await mkdir(workspacePath, { recursive: true });
      await writeFile(lockPath, String(Date.now()), "utf8");

      const service = new MemoryRuntimeWorkspaceService({ userDataPath });

      await assert.rejects(() => service.acquireLock(), /already in use/i);

      const staleTimestamp = Date.now() - 60_000;
      await writeFile(lockPath, String(staleTimestamp), "utf8");

      await service.acquireLock({ staleLockMs: 1_000 });
      const newTimestamp = Number(await readFile(lockPath, "utf8"));
      assert.ok(newTimestamp >= staleTimestamp + 1_000);
      await service.releaseLock();
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("withLock は処理完了後に lock を解放する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));
    const workspacePath = path.join(userDataPath, "memory-runtime", "current");
    const lockPath = path.join(workspacePath, ".lock");

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });

      const result = await service.withLock(async () => {
        assert.equal(await exists(lockPath), true);
        return "ok";
      });

      assert.equal(result, "ok");
      assert.equal(await exists(lockPath), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("completeRun は lock を削除する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      await service.prepareRun();

      await service.completeRun();

      assert.equal(await exists(path.join(service.getWorkspacePath(), ".lock")), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("resetWorkspace は current 配下を丸ごと作り直す", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));
    const workspacePath = path.join(userDataPath, "memory-runtime", "current");

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(path.join(workspacePath, "old.md"), "old", "utf8");
      await writeFile(path.join(workspacePath, ".lock"), "stale", "utf8");

      await service.resetWorkspace();

      const filesAfterReset = await readdir(workspacePath);
      assert.deepEqual(filesAfterReset, []);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("regenerateTemplateInstructionFiles は同一 relativePath を毎回上書きして再生成する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));
    const workspacePath = path.join(userDataPath, "memory-runtime", "current");
    const agentsPath = path.join(workspacePath, "AGENTS.md");
    const copilotPath = path.join(workspacePath, "provider", "copilot", "COPILOT.md");

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      await service.resetWorkspace();

      await service.regenerateTemplateInstructionFiles([
        { relativePath: "AGENTS.md", content: "# first\n" },
        { relativePath: "provider/copilot/COPILOT.md", content: "# copilot first\n" },
      ]);

      await service.regenerateTemplateInstructionFiles([
        { relativePath: "AGENTS.md", content: "# second\n" },
        { relativePath: "provider/copilot/COPILOT.md", content: "# copilot second\n" },
      ]);

      const agentsContent = await readFile(agentsPath, "utf8");
      const copilotContent = await readFile(copilotPath, "utf8");
      assert.equal(agentsContent, "# second\n");
      assert.equal(copilotContent, "# copilot second\n");
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("regenerateTemplateInstructionFiles は path traversal を拒否する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));
    const workspacePath = path.join(userDataPath, "memory-runtime", "current");
    const outsideWorkspacePath = path.join(userDataPath, "outside.md");

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      await service.resetWorkspace();

      await assert.rejects(
        () =>
          service.regenerateTemplateInstructionFiles([
            { relativePath: "../outside.md", content: "blocked\n" },
          ]),
        /path traversal/i,
      );
      await assert.rejects(
        () =>
          service.regenerateTemplateInstructionFiles([
            { relativePath: path.join("/", "absolute", "path.md"), content: "blocked\n" },
          ]),
        /relativePath/i,
      );

      assert.equal(await exists(outsideWorkspacePath), false);
      assert.deepEqual(await readdir(workspacePath), []);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
