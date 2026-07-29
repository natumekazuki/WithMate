import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import type { CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
import { CompanionSessionService } from "../../src-electron/companion-session-service.js";
import { CompanionStorage } from "../../src-electron/companion-storage.js";
import {
  ProviderRuntimeOperationCoordinator,
  type RunProviderRuntimeOperationExclusive,
} from "../../src-electron/provider-runtime-operation-coordinator.js";
import type { SessionLaunchSelection } from "../../src-electron/session-launch-selection-service.js";

const execFileAsync = promisify(execFile);
const runProviderRuntimeOperationExclusive: RunProviderRuntimeOperationExclusive =
  async (operation) => await operation();

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  return result.stdout.trim();
}

async function removeDirectoryWithRetry(targetPath: string, attempts = 5): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const isBusyError = typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY";
      if (!isBusyError || index === attempts - 1) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 50 * (index + 1)));
    }
  }
}

function createLaunchSelection(
  overrides: Partial<SessionLaunchSelection> = {},
): SessionLaunchSelection {
  return {
    provider: "codex",
    catalogRevision: 5,
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    approvalMode: "never",
    codexSandboxMode: "danger-full-access",
    customAgentName: "reviewer",
    ...overrides,
  };
}

function createCharacterRuntimeSnapshot(overrides?: Partial<CharacterRuntimeSnapshot>): CharacterRuntimeSnapshot {
  return {
    characterId: "char-1",
    name: "Mia",
    description: "保存済み Character",
    iconFilePath: "icon.png",
    theme: {
      main: "#6f8cff",
      sub: "#6fb8c7",
    },
    definitionMarkdown: [
      "---",
      "schema: withmate.character.v1",
      "name: Mia",
      "---",
      "# Character",
      "Companion 起動時に固定した character.md。",
    ].join("\n"),
    definitionSha256: "sha256-companion-definition",
    definitionByteSize: 128,
    snapshotAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("CompanionSessionService", () => {
  it("CompanionSession 作成時に snapshot ref と shadow worktree を実体化する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-service-"));
    const repoPath = path.join(tempDirectory, "repo");
    const appDataPath = path.join(tempDirectory, "app-data");
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CompanionStorage | null = null;
    let worktreePath = "";

    try {
      await mkdir(repoPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
      await git(repoPath, ["config", "user.name", "WithMate Test"]);
      await git(repoPath, ["config", "user.email", "withmate@example.invalid"]);
      await writeFile(path.join(repoPath, "README.md"), "# demo\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);
      await writeFile(path.join(repoPath, "README.md"), "# demo\n\nservice\n", "utf8");

      storage = new CompanionStorage(dbPath);
      const characterRuntimeSnapshot = createCharacterRuntimeSnapshot();
      const snapshotCharacterIds: string[] = [];
      const coordinator = new ProviderRuntimeOperationCoordinator();
      const service = new CompanionSessionService({
        appDataPath,
        runProviderRuntimeOperationExclusive: (operation) => coordinator.runExclusive(operation),
        resolveSessionLaunchSelection: async () => createLaunchSelection(),
        getStorage: () => storage as CompanionStorage,
        createCharacterRuntimeSnapshot(characterId) {
          snapshotCharacterIds.push(characterId);
          return characterRuntimeSnapshot;
        },
      });
      const createPromise = service.createSession({
        taskTitle: "Shadow worktree",
        workspacePath: repoPath,
        provider: "codex",
        characterId: "char-1",
        character: "Mia",
        characterRoleMarkdown: "落ち着いて伴走する。",
        characterIconPath: "icon.png",
        characterThemeColors: {
          main: "#6f8cff",
          sub: "#6fb8c7",
        },
      });
      const persistedSessionCounts: number[] = [];
      const settingsMutation = coordinator.runExclusive(() => {
        persistedSessionCounts.push(storage?.listSessionSummaries().length ?? 0);
      });
      const session = await createPromise;
      await settingsMutation;
      worktreePath = session.worktreePath;

      assert.deepEqual(persistedSessionCounts, [1]);
      assert.match(session.baseSnapshotRef, /^refs\/withmate\/companion\/companion-session-[^/]+\/base$/);
      assert.match(session.baseSnapshotCommit, /^[0-9a-f]{40}$/);
      assert.equal(await gitOutput(repoPath, ["rev-parse", session.baseSnapshotRef]), session.baseSnapshotCommit);
      assert.equal(await gitOutput(repoPath, ["rev-parse", session.companionBranch]), session.baseSnapshotCommit);
      assert.equal((await readFile(path.join(session.worktreePath, "README.md"), "utf8")).replace(/\r\n/g, "\n"), "# demo\n\nservice\n");
      assert.deepEqual(snapshotCharacterIds, ["char-1"]);
      assert.deepEqual(session.characterRuntimeSnapshot, characterRuntimeSnapshot);
      assert.notEqual(session.characterRuntimeSnapshot, characterRuntimeSnapshot);
      assert.equal(storage.getSession(session.id)?.baseSnapshotRef, session.baseSnapshotRef);
      assert.equal(session.catalogRevision, 5);
      assert.equal(session.model, "gpt-5.5");
      assert.equal(session.reasoningEffort, "xhigh");
      assert.equal(session.approvalMode, "never");
      assert.equal(session.codexSandboxMode, "danger-full-access");
      assert.equal(session.customAgentName, "reviewer");
      assert.deepEqual(storage.getSession(session.id)?.characterRuntimeSnapshot, characterRuntimeSnapshot);
    } finally {
      if (worktreePath) {
        await git(repoPath, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      }
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("DB 再作成が先行した CompanionSession 作成は排他取得後の現行 storage に保存する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-storage-generation-"));
    const repoPath = path.join(tempDirectory, "repo");
    const appDataPath = path.join(tempDirectory, "app-data");
    const oldDbPath = path.join(tempDirectory, "old.db");
    const newDbPath = path.join(tempDirectory, "new.db");
    let oldStorage: CompanionStorage | null = null;
    let newStorage: CompanionStorage | null = null;
    let currentStorage: CompanionStorage | null = null;
    let worktreePath = "";

    try {
      await mkdir(repoPath, { recursive: true });
      await git(repoPath, ["init", "-b", "main"]);
      await git(repoPath, ["config", "user.name", "WithMate Test"]);
      await git(repoPath, ["config", "user.email", "withmate@example.invalid"]);
      await writeFile(path.join(repoPath, "README.md"), "# demo\n", "utf8");
      await git(repoPath, ["add", "README.md"]);
      await git(repoPath, ["commit", "-m", "initial"]);

      oldStorage = new CompanionStorage(oldDbPath);
      currentStorage = oldStorage;
      const storageGenerationReads: string[] = [];
      const coordinator = new ProviderRuntimeOperationCoordinator();
      const service = new CompanionSessionService({
        appDataPath,
        runProviderRuntimeOperationExclusive: (operation) => coordinator.runExclusive(operation),
        resolveSessionLaunchSelection: async () => createLaunchSelection(),
        getStorage: () => {
          if (!currentStorage) {
            throw new Error("Companion storage is unavailable");
          }
          storageGenerationReads.push(currentStorage === oldStorage ? "old" : "new");
          return currentStorage;
        },
      });

      let markResetStarted: () => void = () => undefined;
      const resetStarted = new Promise<void>((resolve) => {
        markResetStarted = resolve;
      });
      let continueReset: () => void = () => undefined;
      const resetCanContinue = new Promise<void>((resolve) => {
        continueReset = resolve;
      });
      const resetOperation = coordinator.runExclusive(async () => {
        markResetStarted();
        await resetCanContinue;
        oldStorage?.close();
        oldStorage = null;
        newStorage = new CompanionStorage(newDbPath);
        currentStorage = newStorage;
      });

      await resetStarted;
      const createPromise = service.createSession({
        taskTitle: "After database reset",
        workspacePath: repoPath,
        provider: "codex",
        characterId: "char-1",
        character: "Mia",
        characterRoleMarkdown: "落ち着いて伴走する。",
        characterIconPath: "icon.png",
        characterThemeColors: {
          main: "#6f8cff",
          sub: "#6fb8c7",
        },
      });
      continueReset();
      await resetOperation;
      const session = await createPromise;
      worktreePath = session.worktreePath;

      assert.deepEqual(storageGenerationReads, ["new"]);
      assert.equal(newStorage.getSession(session.id)?.id, session.id);
    } finally {
      if (worktreePath) {
        await git(repoPath, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      }
      oldStorage?.close();
      newStorage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("CompanionSession 作成時に起動設定の取得に失敗したら storage や worktree を変更しない", async () => {
    const service = new CompanionSessionService({
      appDataPath: path.join(os.tmpdir(), "withmate-companion-service-stale"),
      runProviderRuntimeOperationExclusive,
      resolveSessionLaunchSelection: async () => {
        throw new Error("latest selection read failed");
      },
      getStorage: () => ({
        listSessionSummaries: () => [],
        listActiveSessionSummaries: () => [],
        ensureGroup() {
          throw new Error("storage should not be touched");
        },
        createSession() {
          throw new Error("storage should not be touched");
        },
      }),
    });

    await assert.rejects(
      () => service.createSession({
        taskTitle: "Selection read failure",
        workspacePath: "C:/not-a-repo",
        provider: "codex",
        characterId: "char-1",
        character: "Mia",
        characterRoleMarkdown: "落ち着いて伴走する。",
        characterIconPath: "icon.png",
        characterThemeColors: {
          main: "#6f8cff",
          sub: "#6fb8c7",
        },
      }),
      /latest selection read failed/,
    );
  });
});
