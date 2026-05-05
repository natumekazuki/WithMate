import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { MemoryRuntimeWorkspaceService } from "../../src-electron/memory-runtime-workspace.js";

describe("MemoryRuntimeWorkspaceService", () => {
  it("prepareRun は runs/{runId} を作って template をコピーし lock + metadata を作成する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));
    const templateRootPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-template-"));
    const workspaceTemplateDir = path.join(templateRootPath, "workspace");
    const currentWorkspacePath = path.join(userDataPath, "memory-runtime", "current");

    try {
      await writeFile(path.join(templateRootPath, "AGENTS.md"), "# AGENTS\n", "utf8");
      await writeFile(path.join(templateRootPath, "provider-openai.md"), "# openai\n", "utf8");
      await mkdir(workspaceTemplateDir, { recursive: true });
      await writeFile(path.join(workspaceTemplateDir, "nested.md"), "# nested\n", "utf8");
      await mkdir(currentWorkspacePath, { recursive: true });
      await writeFile(path.join(currentWorkspacePath, "previous-only.md"), "stale\n", "utf8");

      const service = new MemoryRuntimeWorkspaceService({
        userDataPath,
        templateRootPath,
      });

      const result = await service.prepareRun();

      assert.equal(path.dirname(result.workspacePath), path.join(userDataPath, "memory-runtime", "runs"));
      assert.equal(service.getWorkspacePath(), result.workspacePath);
      assert.equal(service.getCurrentWorkspacePath(), result.workspacePath);
      assert.equal(result.lockPath, path.join(result.workspacePath, ".lock"));
      assert.equal(await exists(result.lockPath), true);
      assert.equal(await exists(path.join(result.workspacePath, "AGENTS.md")), true);
      assert.equal(await exists(path.join(result.workspacePath, "provider-openai.md")), true);
      assert.equal(await exists(path.join(result.workspacePath, "workspace", "nested.md")), true);
      assert.equal(await exists(path.join(currentWorkspacePath, "AGENTS.md")), true);
      assert.equal(await exists(path.join(currentWorkspacePath, "provider-openai.md")), true);
      assert.equal(await exists(path.join(currentWorkspacePath, "previous-only.md")), false);

      const copiedAgents = await readFile(path.join(result.workspacePath, "AGENTS.md"), "utf8");
      assert.match(copiedAgents, /AGENTS/);

      const lockMetadata = await readRunMetadata(result.lockPath);
      assert.equal(lockMetadata?.status, "running");
      assert.equal(typeof lockMetadata?.runId, "string");
      assert.equal(typeof lockMetadata?.createdAt, "number");
      assert.equal(typeof lockMetadata?.heartbeatAt, "number");
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
      await rm(templateRootPath, { recursive: true, force: true });
    }
  });

  it("prepareRun は active lock がある間は拒否する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));
    const service = new MemoryRuntimeWorkspaceService({ userDataPath });
    const workspacePath = path.join(userDataPath, "memory-runtime", "current");
    const runPath = path.join(workspacePath, ".lock");

    try {
      await mkdir(workspacePath, { recursive: true });
      await writeFile(runPath, "locked", "utf8");

      await assert.rejects(() => service.prepareRun(), /already in use/i);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("prepareRun は current lock がなくても runs 配下の active lock を検出して拒否する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));
    const runPath = path.join(userDataPath, "memory-runtime", "runs", "orphan-active-run");

    try {
      await mkdir(runPath, { recursive: true });
      await writeFile(path.join(runPath, ".lock"), JSON.stringify({
        runId: "orphan-active-run",
        createdAt: Date.now(),
        heartbeatAt: Date.now(),
        status: "running",
      }), "utf8");

      const service = new MemoryRuntimeWorkspaceService({ userDataPath });

      await assert.rejects(() => service.prepareRun(), /already in use/i);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("並行 prepareRun は 1 件だけ成功し、失敗側が成功側の lock を消さない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      const results = await Promise.allSettled([
        service.prepareRun(),
        service.prepareRun(),
      ]);
      const fulfilled = results.filter((result): result is PromiseFulfilledResult<{ workspacePath: string; lockPath: string }> => (
        result.status === "fulfilled"
      ));
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.match(String(rejected[0].reason), /already in use/i);
      assert.equal(await exists(fulfilled[0].value.lockPath), true);
      assert.equal(await exists(path.join(userDataPath, "memory-runtime", "current", ".lock")), true);

      await service.completeRun();
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
      const lockMetadata = await readRunMetadata(lockPath);
      assert.equal(lockMetadata?.status, "running");
      assert.ok((lockMetadata?.heartbeatAt ?? staleTimestamp) >= staleTimestamp + 1_000);
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

  it("releaseLock は active workspace state も解除する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      const prepared = await service.prepareRun();

      await service.releaseLock();

      assert.equal(await exists(prepared.lockPath), false);
      assert.equal(service.getWorkspacePath(), path.join(userDataPath, "memory-runtime", "current"));
      await assert.rejects(() => service.touchHeartbeat(), /アクティブな memory runtime workspace/);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("completeRun で lock を削除し status が completed になる", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      const result = await service.prepareRun();
      await service.completeRun();

      const status = await readRunMetadata(path.join(result.workspacePath, ".status"));
      assert.equal(status?.status, "completed");
      assert.equal(await exists(result.lockPath), false);
      assert.equal(await exists(path.join(service.getWorkspacePath(), ".lock")), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("failRun で status が failed になり lock を削除し active state が current に戻る", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      const result = await service.prepareRun();

      await service.failRun("failure detected");

      const status = await readRunMetadata(path.join(result.workspacePath, ".status"));
      assert.equal(status?.status, "failed");
      assert.equal(await exists(result.lockPath), false);
      assert.equal(service.getWorkspacePath(), path.join(userDataPath, "memory-runtime", "current"));
      assert.equal(await exists(path.join(service.getWorkspacePath(), ".lock")), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("startHeartbeat が heartbeat を更新し、stop 後は更新を止める", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      const result = await service.prepareRun();
      const statusPath = path.join(result.workspacePath, ".status");
      const initial = await readRunMetadata(statusPath);

      const stopHeartbeat = service.startHeartbeat(5);
      const afterStart = await waitForHeartbeatAfter(statusPath, initial?.heartbeatAt ?? 0);
      assert.ok(afterStart != null);
      assert.equal(afterStart.heartbeatAt > (initial?.heartbeatAt ?? 0), true);

      await stopHeartbeat();
      const afterStop = await waitForRunMetadata(statusPath);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const later = await waitForRunMetadata(statusPath);
      assert.equal(afterStop?.heartbeatAt, later?.heartbeatAt);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("completeRun は in-flight heartbeat 後でも completed status と lock release を維持する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      const result = await service.prepareRun();
      const statusPath = path.join(result.workspacePath, ".status");

      const stopHeartbeat = service.startHeartbeat(1);
      await waitForHeartbeatAfter(statusPath, 0);
      await service.completeRun();
      await stopHeartbeat();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const metadata = await waitForRunMetadata(statusPath);
      assert.equal(metadata?.status, "completed");
      assert.equal(await exists(result.lockPath), false);
      assert.equal(await exists(path.join(userDataPath, "memory-runtime", "current", ".lock")), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("failRun は in-flight heartbeat 後でも failed status と lock release を維持する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      const result = await service.prepareRun();
      const statusPath = path.join(result.workspacePath, ".status");

      const stopHeartbeat = service.startHeartbeat(1);
      await waitForHeartbeatAfter(statusPath, 0);
      await service.failRun("failed after heartbeat");
      await stopHeartbeat();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const metadata = await waitForRunMetadata(statusPath);
      assert.equal(metadata?.status, "failed");
      assert.equal(await exists(result.lockPath), false);
      assert.equal(await exists(path.join(userDataPath, "memory-runtime", "current", ".lock")), false);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("touchHeartbeat で heartbeat が更新される", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      const result = await service.prepareRun();

      const before = await readRunMetadata(result.lockPath);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await service.touchHeartbeat();
      const after = await readRunMetadata(result.lockPath);

      assert.ok(before != null);
      assert.ok(after != null);
      assert.equal(after.heartbeatAt >= (before?.heartbeatAt ?? 0), true);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("stale run cleanup で stale active run は quarantine に移動し次の prepare が実行できる", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      const prepared = await service.prepareRun();

      const staleMetadata = {
        runId: path.basename(prepared.workspacePath),
        createdAt: Date.now() - 120_000,
        heartbeatAt: Date.now() - 120_000,
        status: "running",
      };
      await writeFile(prepared.lockPath, JSON.stringify(staleMetadata), "utf8");
      await writeFile(path.join(prepared.workspacePath, ".status"), JSON.stringify(staleMetadata), "utf8");

      const restartedService = new MemoryRuntimeWorkspaceService({ userDataPath });
      await restartedService.cleanupStaleRuns({ staleHeartbeatMs: 1 });

      const quarantinePath = path.join(
        userDataPath,
        "memory-runtime",
        "quarantine",
        path.basename(prepared.workspacePath),
      );
      assert.equal(await exists(quarantinePath), true);
      assert.equal(await exists(prepared.workspacePath), false);

      const next = await restartedService.prepareRun();
      assert.equal(await exists(path.join(next.workspacePath, ".lock")), true);
      assert.equal(next.workspacePath === prepared.workspacePath, false);
      await restartedService.completeRun();
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("prepareRun は stale 化した crash 残り lock を on-demand cleanup してから新 run を開始する", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      const prepared = await service.prepareRun();
      const staleMetadata = {
        runId: path.basename(prepared.workspacePath),
        createdAt: Date.now() - 120_000,
        heartbeatAt: Date.now() - 120_000,
        status: "running",
      };
      await writeFile(prepared.lockPath, JSON.stringify(staleMetadata), "utf8");
      await writeFile(path.join(prepared.workspacePath, ".status"), JSON.stringify(staleMetadata), "utf8");
      await writeFile(path.join(userDataPath, "memory-runtime", "current", ".lock"), JSON.stringify(staleMetadata), "utf8");

      const restartedService = new MemoryRuntimeWorkspaceService({ userDataPath });
      const next = await restartedService.prepareRun();

      assert.equal(await exists(prepared.workspacePath), false);
      assert.equal(await exists(path.join(userDataPath, "memory-runtime", "quarantine", path.basename(prepared.workspacePath))), true);
      assert.equal(await exists(next.lockPath), true);
      await restartedService.completeRun();
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("cleanupStaleRuns は同一 instance の active run を quarantine しない", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      const prepared = await service.prepareRun();

      const staleMetadata = {
        runId: path.basename(prepared.workspacePath),
        createdAt: Date.now() - 120_000,
        heartbeatAt: Date.now() - 120_000,
        status: "running",
      };
      await writeFile(prepared.lockPath, JSON.stringify(staleMetadata), "utf8");
      await writeFile(path.join(prepared.workspacePath, ".status"), JSON.stringify(staleMetadata), "utf8");

      await service.cleanupStaleRuns({ staleHeartbeatMs: 1 });

      assert.equal(await exists(prepared.workspacePath), true);
      assert.equal(await exists(prepared.lockPath), true);
      await service.completeRun();
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("completed/failed run は cleanupStaleRuns で削除される", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "withmate-memory-runtime-"));

    try {
      const service = new MemoryRuntimeWorkspaceService({ userDataPath });
      const completed = await service.prepareRun();
      await service.completeRun();

      const failedRunPath = path.join(userDataPath, "memory-runtime", "runs", "failed-run");
      await mkdir(failedRunPath, { recursive: true });
      await writeFile(path.join(failedRunPath, ".status"), JSON.stringify({
        runId: "failed-run",
        createdAt: Date.now(),
        heartbeatAt: Date.now(),
        status: "failed",
      }), "utf8");

      await service.cleanupStaleRuns({ staleHeartbeatMs: 1 });

      assert.equal(await exists(completed.workspacePath), false);
      assert.equal(await exists(failedRunPath), false);
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

async function readRunMetadata(filePath: string): Promise<{
  runId: string;
  createdAt: number;
  heartbeatAt: number;
  status: "running" | "completed" | "failed";
} | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as {
      runId: string;
      createdAt: number;
      heartbeatAt: number;
      status: "running" | "completed" | "failed";
    };
  } catch {
    return null;
  }
}

async function waitForHeartbeatAfter(filePath: string, heartbeatAt: number): Promise<{
  runId: string;
  createdAt: number;
  heartbeatAt: number;
  status: "running" | "completed" | "failed";
} | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const metadata = await readRunMetadata(filePath);
    if (metadata && metadata.heartbeatAt > heartbeatAt) {
      return metadata;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readRunMetadata(filePath);
}

async function waitForRunMetadata(filePath: string): Promise<{
  runId: string;
  createdAt: number;
  heartbeatAt: number;
  status: "running" | "completed" | "failed";
} | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const metadata = await readRunMetadata(filePath);
    if (metadata) {
      return metadata;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readRunMetadata(filePath);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
