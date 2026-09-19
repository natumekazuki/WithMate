import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { CompanionGroup, CompanionMergeRun, CompanionSession } from "../../src/companion-state.js";
import type { CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src/codex-sandbox-mode.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../../src/model-catalog.js";
import { CompanionStorage } from "../../src-electron/companion-storage.js";

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

function createGroup(): CompanionGroup {
  return {
    id: "group-1",
    repoRoot: "F:/work/demo",
    displayName: "demo",
    createdAt: "2026-04-26 10:00",
    updatedAt: "2026-04-26 10:00",
  };
}

function createSession(groupId: string, overrides: Partial<CompanionSession> = {}): CompanionSession {
  return {
    id: "session-1",
    groupId,
    taskTitle: "Companion task",
    status: "active",
    repoRoot: "F:/work/demo",
    focusPath: "src",
    targetBranch: "main",
    baseSnapshotRef: "refs/withmate/companion/session-1/base",
    baseSnapshotCommit: "abc123",
    companionBranch: "withmate/companion/session-1",
    worktreePath: "F:/app/companion-worktrees/group-1/session-1",
    selectedPaths: [],
    changedFiles: [],
    siblingWarnings: [],
    allowedAdditionalDirectories: [],
    runState: "idle",
    threadId: "",
    provider: "codex",
    catalogRevision: DEFAULT_CATALOG_REVISION,
    model: DEFAULT_MODEL_ID,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    customAgentName: "",
    approvalMode: DEFAULT_APPROVAL_MODE,
    codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
    codexSpeed: "standard",
    codexReviewer: "user",
    characterId: "char-1",
    character: "Mia",
    characterRoleMarkdown: "落ち着いて伴走する。",
    characterIconPath: "icon.png",
    characterThemeColors: {
      main: "#6f8cff",
      sub: "#6fb8c7",
    },
    characterRuntimeSnapshot: null,
    createdAt: "2026-04-26 10:01",
    updatedAt: "2026-04-26 10:01",
    messages: [],
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
    definitionMarkdown: "# Character\nCompanion runtime snapshot",
    definitionSha256: "sha256-companion",
    definitionByteSize: 49,
    snapshotAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

function createMergeRun(groupId: string, overrides: Partial<CompanionMergeRun> = {}): CompanionMergeRun {
  return {
    id: "merge-run-1",
    sessionId: "session-merged",
    groupId,
    operation: "merge",
    selectedPaths: ["README.md"],
    changedFiles: [{ path: "README.md", kind: "edit" }],
    diffSnapshot: [
      {
        kind: "edit",
        path: "README.md",
        summary: "README.md を更新",
        diffRows: [{ kind: "add", rightNumber: 1, rightText: "merged" }],
      },
    ],
    siblingWarnings: [],
    createdAt: "2026-04-26 10:04",
    ...overrides,
  };
}

describe("CompanionStorage", () => {
  it("max / ultra を session の保存と読込で保持する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CompanionStorage | null = null;

    try {
      storage = new CompanionStorage(dbPath);
      const group = storage.ensureGroup(createGroup());

      for (const reasoningEffort of ["max", "ultra"] as const) {
        const sessionId = `session-${reasoningEffort}`;
        storage.createSession(createSession(group.id, { id: sessionId, reasoningEffort }));
        assert.equal(storage.getSession(sessionId)?.reasoningEffort, reasoningEffort);
      }
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v1
  // kind = "contract"
  // claim = "Companion summaryとdetailは保存済みCodex speedとReviewerを同じSession ownerから返す"
  // oracle = { type = "contract", ref = "accepted behavior: Companion persistence projection" }
  // failure_mode = "Companionの一覧とdetailでSpeedまたはReviewer選択が失われるか食い違う"
  // scope = "companion-storage"
  // lifecycle = "permanent"
  // @end-test-value
  it("group と active session を保存して summary と detail を読み戻せる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CompanionStorage | null = null;

    try {
      storage = new CompanionStorage(dbPath);
      const group = storage.ensureGroup(createGroup());
      const session = storage.createSession(createSession(group.id, {
        approvalMode: "never",
        codexSpeed: "fast",
        codexReviewer: "auto-review",
      }));

      assert.equal(session.groupId, group.id);
      assert.deepEqual(storage.listActiveSessionSummaries(), [
        {
          id: "session-1",
          groupId: group.id,
          taskTitle: "Companion task",
          status: "active",
          repoRoot: "F:/work/demo",
          focusPath: "src",
          targetBranch: "main",
          baseSnapshotRef: "refs/withmate/companion/session-1/base",
          baseSnapshotCommit: "abc123",
          selectedPaths: [],
          changedFiles: [],
          siblingWarnings: [],
          allowedAdditionalDirectories: [],
          latestMergeRun: null,
          runState: "idle",
          threadId: "",
          provider: "codex",
          model: DEFAULT_MODEL_ID,
          reasoningEffort: DEFAULT_REASONING_EFFORT,
          approvalMode: "never",
          codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
          codexSpeed: "fast",
          codexReviewer: "auto-review",
          character: "Mia",
          characterRoleMarkdown: "落ち着いて伴走する。",
          characterIconPath: "icon.png",
          characterThemeColors: {
            main: "#6f8cff",
            sub: "#6fb8c7",
          },
          updatedAt: "2026-04-26 10:01",
        },
      ]);
      assert.equal(storage.getSession("session-1")?.companionBranch, "withmate/companion/session-1");
      assert.equal(storage.getSession("session-1")?.approvalMode, "never");
      assert.equal(storage.getSession("session-1")?.codexSpeed, "fast");
      assert.equal(storage.getSession("session-1")?.codexReviewer, "auto-review");
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "Companion Session更新は保存済みApprovalがneverの間、他項目を更新しても現在のReviewerを保持する"
  // oracle = { type = "contract", ref = "CODEX-AUTO-REVIEW-AR-3" }
  // failure_mode = "直接IPCまたはstale payloadがnever中のCompanion Reviewerを変更し、後のinteractive復帰で意図しない値が有効になる"
  // scope = "companion-storage"
  // lifecycle = "permanent"
  // @end-test-value
  it("updateSession は保存済みApprovalがneverの間Reviewerを保持する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-reviewer-never-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CompanionStorage | null = null;

    try {
      storage = new CompanionStorage(dbPath);
      const group = storage.ensureGroup(createGroup());
      const session = storage.createSession(createSession(group.id, {
        approvalMode: "never",
        codexReviewer: "auto-review",
      }));

      const updated = storage.updateSession({
        ...session,
        taskTitle: "Renamed Companion",
        codexReviewer: "user",
      });

      assert.equal(updated.taskTitle, "Renamed Companion");
      assert.equal(updated.codexReviewer, "auto-review");
      assert.equal(storage.getSession(session.id)?.codexReviewer, "auto-review");
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("merged / discarded session は summary から除外する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CompanionStorage | null = null;

    try {
      storage = new CompanionStorage(dbPath);
      const group = storage.ensureGroup(createGroup());
      storage.createSession(createSession(group.id, {
        id: "session-merged",
        status: "merged",
        taskTitle: "Merged task",
        selectedPaths: ["README.md", "src/app.ts"],
        changedFiles: [
          { path: "README.md", kind: "edit" },
          { path: "src/app.ts", kind: "add" },
        ],
        siblingWarnings: [
          {
            sessionId: "session-sibling",
            taskTitle: "Sibling task",
            paths: ["README.md"],
            message: "Sibling task と 1 file が重なっているよ。",
          },
        ],
        updatedAt: "2026-04-26 10:03",
      }));
      storage.createSession(createSession(group.id, {
        id: "session-discarded",
        status: "discarded",
        taskTitle: "Discarded task",
        updatedAt: "2026-04-26 10:02",
      }));

      assert.deepEqual(storage.listActiveSessionSummaries(), []);
      assert.deepEqual(storage.listSessionSummaries(), []);
      assert.deepEqual(storage.getSession("session-merged")?.selectedPaths, ["README.md", "src/app.ts"]);
      assert.equal(storage.getSession("session-discarded")?.status, "discarded");
      assert.deepEqual(storage.getSession("session-merged")?.changedFiles, [
        { path: "README.md", kind: "edit" },
        { path: "src/app.ts", kind: "add" },
      ]);
      assert.deepEqual(storage.getSession("session-merged")?.siblingWarnings, [
        {
          sessionId: "session-sibling",
          taskTitle: "Sibling task",
          paths: ["README.md"],
          message: "Sibling task と 1 file が重なっているよ。",
        },
      ]);
      const mergeRun = storage.createMergeRun(createMergeRun(group.id));
      assert.equal(mergeRun.operation, "merge");
      assert.deepEqual(storage.listMergeRunsForSession("session-merged"), [
        {
          id: "merge-run-1",
          sessionId: "session-merged",
          groupId: group.id,
          operation: "merge",
          selectedPaths: ["README.md"],
          changedFiles: [{ path: "README.md", kind: "edit" }],
          diffSnapshot: [
            {
              kind: "edit",
              path: "README.md",
              summary: "README.md を更新",
              diffRows: [{ kind: "add", rightNumber: 1, rightText: "merged" }],
            },
          ],
          siblingWarnings: [],
          createdAt: "2026-04-26 10:04",
        },
      ]);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("deleteSession は CompanionSession と関連履歴を削除する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CompanionStorage | null = null;

    try {
      storage = new CompanionStorage(dbPath);
      const group = storage.ensureGroup(createGroup());
      const session = storage.createSession(createSession(group.id, {
        id: "session-discard-target",
        taskTitle: "Discard target",
        updatedAt: "2026-04-26 10:04",
      }));
      storage.createMergeRun({
        id: "run-discard-target",
        sessionId: session.id,
        groupId: group.id,
        operation: "discard",
        selectedPaths: [],
        changedFiles: [],
        diffSnapshot: [],
        siblingWarnings: [],
        createdAt: "2026-04-26 10:05",
      });

      storage.deleteSession(session.id);

      assert.equal(storage.getSession(session.id), null);
      assert.deepEqual(storage.listSessionSummaries(), []);
      assert.deepEqual(storage.listMergeRunsForSession(session.id), []);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("汎用 updateSession は base snapshot を変更せず Sync Target 専用更新だけが変更できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CompanionStorage | null = null;

    try {
      storage = new CompanionStorage(dbPath);
      const group = storage.ensureGroup(createGroup());
      const session = storage.createSession(createSession(group.id));

      const staleUpdate = storage.updateSession({
        ...session,
        taskTitle: "Renamed task",
        baseSnapshotCommit: "stale-base",
        updatedAt: "2026-04-26 10:02",
      });
      assert.equal(staleUpdate.taskTitle, "Renamed task");
      assert.equal(staleUpdate.baseSnapshotCommit, "abc123");

      const synced = storage.updateSessionBaseSnapshot({
        ...staleUpdate,
        baseSnapshotCommit: "synced-base",
        selectedPaths: ["README.md"],
        changedFiles: [{ path: "README.md", kind: "edit" }],
        updatedAt: "2026-04-26 10:03",
      });
      assert.equal(synced.baseSnapshotCommit, "synced-base");
      assert.deepEqual(synced.selectedPaths, ["README.md"]);
      assert.deepEqual(synced.changedFiles, [{ path: "README.md", kind: "edit" }]);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "汎用 companion update は owner と runtime snapshot を変更しない"
  // fault = "汎用更新経路から Character owner または runtime snapshot を差し替える"
  // observable = "保存後 session の owner、runtime snapshot、本文"
  // observation_boundary = "component-behavior"
  // scope = "companion-update-immutable-fields"
  // oracle = { type = "contract", ref = "src-electron/companion-storage.ts#updateSession" }
  // lifecycle = "permanent"
  // impact = "companion の所有境界と実行時状態が意図せず破壊される"
  // distinction = "runtime metadata CAS ではなく汎用 update の禁止境界を確認する"
  // @end-test-value
  it("汎用 updateSession は Character owner / runtime snapshot の差し替えを拒否する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-storage-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CompanionStorage | null = null;

    try {
      storage = new CompanionStorage(dbPath);
      const group = storage.ensureGroup(createGroup());
      const characterRuntimeSnapshot = createCharacterRuntimeSnapshot();
      const session = storage.createSession(createSession(group.id, { characterRuntimeSnapshot, messages: [{ role: "user", text: "Keep owner-bound history" }] }));
      const persistedBefore = storage.getSession(session.id);
      const invalidUpdates = [
        { ...session, characterId: "char-2" },
        {
          ...session,
          characterId: "char-2",
          characterRuntimeSnapshot: createCharacterRuntimeSnapshot({ characterId: "char-2" }),
        },
        {
          ...session,
          characterRuntimeSnapshot: null,
        },
      ];

      for (const invalidUpdate of invalidUpdates) {
        assert.throws(
          () => storage?.updateSession(invalidUpdate),
          /Character owner \/ runtime snapshot は更新できない/,
        );
      }

      const persisted = storage.getSession(session.id);
      assert.equal(persisted?.characterId, session.characterId);
      assert.deepEqual(persisted?.characterRuntimeSnapshot, characterRuntimeSnapshot);
      assert.deepEqual(persisted?.messages, persistedBefore?.messages);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Legacy Companion runtime metadata CAS は本文を保持し stale patch を拒否する"
  // oracle = { type = "contract", ref = "src-electron/companion-storage.ts#updateRuntimeMetadataIfMatches" }
  // fault = "legacy Companion のcatalog migrationが全体payloadを書き戻す"
  // observable = "getSession のmetadata、messages、CAS結果"
  // observation_boundary = "public-boundary"
  // scope = "companion-storage-legacy-runtime-metadata-cas"
  // lifecycle = "permanent"
  // impact = "旧形式Companionのレビュー内容が失われる"
  // distinction = "V3と異なるlegacy schemaでもmetadata列だけをCAS更新する"
  // @end-test-value
  it("Legacy Companion runtime metadata CAS は本文を保持し stale patch を拒否する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-companion-runtime-metadata-cas-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    let storage: CompanionStorage | null = null;
    try {
      storage = new CompanionStorage(dbPath);
      const group = storage.ensureGroup(createGroup());
      const session = storage.createSession(createSession(group.id, {
        messages: [{ role: "user", text: "message to keep" }],
      }));
      const expected = {
        provider: session.provider,
        catalogRevision: session.catalogRevision,
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        threadId: session.threadId,
        updatedAt: session.updatedAt,
      };
      const next = { ...expected, catalogRevision: expected.catalogRevision + 1, threadId: "", updatedAt: "2026-08-01T00:00:00.000Z" };
      const updated = storage.updateRuntimeMetadataIfMatches(session.id, { expected, next });
      assert.equal(updated?.catalogRevision, next.catalogRevision);
      assert.deepEqual(storage.getSession(session.id)?.messages.map(({ role, text }) => ({ role, text })), session.messages.map(({ role, text }) => ({ role, text })));
      assert.equal(storage.updateRuntimeMetadataIfMatches(session.id, {
        expected,
        next: { ...next, catalogRevision: next.catalogRevision + 1 },
      }), null);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });
});
