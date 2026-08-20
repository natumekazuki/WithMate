import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
import { buildNewSession, projectSessionSummary } from "../../src/session-state.js";
import { SessionCrudError, SessionCrudService } from "../../src-electron/session-crud-service.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

const character: CharacterCatalogEntry = {
  id: "character-a",
  name: "Character A",
  description: "",
  iconFilePath: "",
  theme: { main: "#6f8cff", sub: "#6fb8c7" },
  state: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  archivedAt: null,
};

const characterSnapshot: CharacterRuntimeSnapshot = {
  characterId: character.id,
  name: character.name,
  description: "",
  iconFilePath: "",
  theme: character.theme,
  definitionMarkdown: "# Character A",
  definitionSha256: "character-a-sha256",
  definitionByteSize: 13,
  snapshotAt: "2026-08-01T00:00:00.000Z",
};

async function removeDirectory(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true });
}

function createRootSession(id: string, rootSessionRole: "standalone" | "overall-coordinator" = "overall-coordinator") {
  return buildNewSession({
    id,
    rootSessionRole,
    taskTitle: id,
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    characterId: character.id,
    character: character.name,
    characterIconPath: "",
    characterThemeColors: character.theme,
    approvalMode: DEFAULT_APPROVAL_MODE,
  });
}

describe("SessionCrudService", () => {
  it("create replayはCharacterを再抽選せず、public projectionとGUI同期を一度だけ確定する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-crud-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    const sessionFilesRoot = path.join(tempDirectory, "session-files");
    const storage = new SessionStorageV6(dbPath);
    let catalogRevision = 4;
    let launchSelectionCount = 0;
    let sessionIdCount = 0;
    let snapshotCount = 0;
    const publishedSessionIds: string[] = [];
    const publicationErrors: string[] = [];

    try {
      const db = new DatabaseSync(dbPath);
      db.prepare(`
        INSERT INTO characters (id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(character.id, character.name, character.createdAt, character.updatedAt);
      db.close();
      const actorSessionId = "actor-session";
      storage.insertSession(createRootSession(actorSessionId));
      const secondActorSessionId = "actor-session-2";
      storage.insertSession(createRootSession(secondActorSessionId));
      const standaloneActorSessionId = "standalone-session";
      storage.insertSession(createRootSession(standaloneActorSessionId, "standalone"));
      const service = new SessionCrudService({
        storage,
        resolveLaunchSelection: async (providerId) => {
          launchSelectionCount += 1;
          return {
            provider: providerId,
            catalogRevision,
            model: "gpt-test",
            reasoningEffort: "high",
            approvalMode: DEFAULT_APPROVAL_MODE,
            codexSandboxMode: "workspace-write",
            customAgentName: "",
          };
        },
        isProviderSupported: () => true,
        listCharacters: () => [character],
        listSessionSummaries: () => storage.listSessionSummaries(),
        listOpenSessionWindowIds: () => [],
        createCharacterRuntimeSnapshot: () => {
          snapshotCount += 1;
          return characterSnapshot;
        },
        createSessionId: () => `session-${++sessionIdCount}`,
        createSessionFilesDirectory: async (sessionId) => {
          const directoryPath = path.join(sessionFilesRoot, sessionId);
          await mkdir(directoryPath, { recursive: false });
          return directoryPath;
        },
        resolveSessionFilesDirectory: (sessionId) => path.join(sessionFilesRoot, sessionId),
        publishCreatedSession: (session) => {
          publishedSessionIds.push(session.id);
          throw new Error("broadcast failed");
        },
        publishRenamedSession: () => undefined,
        reportPublicationError: (operation) => publicationErrors.push(operation),
        resolveCurrentWorkspaceBranch: async () => "feature/current",
        now: () => new Date("2026-08-11T00:00:00.000Z"),
        random: () => 0,
      });
      await mkdir(sessionFilesRoot);

      const input = {
        title: "Created externally",
        sessionRole: "task-coordinator" as const,
        provider: "codex" as const,
        catalogRevision: 4,
        workspace: { kind: "session_folder" as const },
        idempotencyKey: "create-key-1",
      };
      const created = await service.create(input, actorSessionId);
      const replayDb = new DatabaseSync(dbPath);
      const replayRow = replayDb.prepare(`
        SELECT result_json
        FROM session_crud_idempotency_v6
        WHERE operation = ? AND idempotency_key = ?
      `).get("session.create", input.idempotencyKey) as { result_json: string };
      const legacyReplayResult = JSON.parse(replayRow.result_json) as Record<string, unknown>;
      legacyReplayResult.workspace = {
        ...(legacyReplayResult.workspace as Record<string, unknown>),
        branch: "stale/persisted-branch",
      };
      replayDb.prepare(`
        UPDATE session_crud_idempotency_v6
        SET result_json = ?
        WHERE operation = ? AND idempotency_key = ?
      `).run(JSON.stringify(legacyReplayResult), "session.create", input.idempotencyKey);
      replayDb.close();
      catalogRevision = 5;
      const replay = await service.create(input, actorSessionId);

      assert.deepEqual(replay, created);
      assert.equal(created.sessionId, "session-1");
      assert.deepEqual({
        sessionRole: created.sessionRole,
        roleContractRevision: created.roleContractRevision,
        rootSessionId: created.rootSessionId,
        parentSessionId: created.parentSessionId,
        delegationDepth: created.delegationDepth,
      }, {
        sessionRole: "task-coordinator",
        roleContractRevision: 1,
        rootSessionId: actorSessionId,
        parentSessionId: actorSessionId,
        delegationDepth: 1,
      });
      assert.deepEqual(created.character, { id: character.id, name: character.name });
      assert.deepEqual(created.workspace, {
        kind: "session_folder",
        label: "SessionFolder",
        path: path.join(sessionFilesRoot, "session-1"),
      });
      assert.deepEqual(created.sessionFolder, {
        path: path.join(sessionFilesRoot, "session-1"),
        isWorkspace: true,
      });
      assert.equal(launchSelectionCount, 1);
      assert.equal(sessionIdCount, 1);
      assert.equal(snapshotCount, 1);
      assert.deepEqual(publishedSessionIds, ["session-1"]);
      assert.deepEqual(publicationErrors, ["session.create"]);

      await assert.rejects(
        () => service.create({ ...input, sessionRole: "executor" }, actorSessionId),
        (error) => error instanceof SessionCrudError && error.code === "IDEMPOTENCY_CONFLICT",
      );
      catalogRevision = 4;
      const otherActorCreate = await service.create({ ...input, sessionRole: "executor" }, secondActorSessionId);
      assert.equal(otherActorCreate.parentSessionId, secondActorSessionId);
      assert.equal(otherActorCreate.sessionRole, "executor");
      assert.notEqual(otherActorCreate.sessionId, created.sessionId);

      const depthTwoExecutor = await service.create({
        ...input,
        sessionRole: "executor",
        idempotencyKey: "depth-two",
      }, created.sessionId);
      assert.deepEqual({
        rootSessionId: depthTwoExecutor.rootSessionId,
        parentSessionId: depthTwoExecutor.parentSessionId,
        delegationDepth: depthTwoExecutor.delegationDepth,
      }, {
        rootSessionId: actorSessionId,
        parentSessionId: created.sessionId,
        delegationDepth: 2,
      });
      const countBeforeForbiddenCreate = sessionIdCount;
      const launchCountBeforeForbiddenCreate = launchSelectionCount;
      for (const forbiddenActorSessionId of [standaloneActorSessionId, depthTwoExecutor.sessionId]) {
        await assert.rejects(
          () => service.create({ ...input, sessionRole: "executor", idempotencyKey: `forbidden-${forbiddenActorSessionId}` }, forbiddenActorSessionId),
          (error) => error instanceof SessionCrudError && error.code === "SESSION_ROLE_FORBIDDEN",
        );
      }
      assert.equal(sessionIdCount, countBeforeForbiddenCreate);
      assert.equal(launchSelectionCount, launchCountBeforeForbiddenCreate);

      const listed = await service.list({ limit: 50 });
      assert.equal(listed.items.length, 6);
      const listedCreated = listed.items.find((session) => session.sessionId === created.sessionId)!;
      assert.equal(listedCreated.workspace.path, path.join(sessionFilesRoot, "session-1"));
      assert.equal("branch" in listedCreated.workspace, false);
      assert.equal((await service.get(created.sessionId)).workspace.branch, null);

      const ordinarySessionFolderName = path.join(tempDirectory, "external", "SessionFolder");
      await mkdir(ordinarySessionFolderName, { recursive: true });
      catalogRevision = 4;
      const ordinaryDirectory = await service.create({
        ...input,
        workspace: { kind: "directory", path: ordinarySessionFolderName },
        idempotencyKey: "create-key-2",
      }, actorSessionId);
      assert.equal(ordinaryDirectory.workspace.kind, "directory");
      const listedOrdinaryDirectory = (await service.list({ limit: 50 })).items.find(
        (session) => session.sessionId === ordinaryDirectory.sessionId,
      );
      assert.equal(listedOrdinaryDirectory?.workspace.kind, "directory");
      assert.equal(listedOrdinaryDirectory?.workspace.path, ordinaryDirectory.workspace.path);
      assert.equal("branch" in listedOrdinaryDirectory!.workspace, false);
      assert.equal((await service.get(ordinaryDirectory.sessionId)).workspace.branch, "feature/current");

      const copilot = await service.create({
        ...input,
        provider: "copilot",
        workspace: { kind: "session_folder" },
        idempotencyKey: "create-key-copilot",
      }, actorSessionId);
      assert.equal(copilot.provider.id, "copilot");
      assert.equal(storage.getSession(copilot.sessionId)?.provider, "copilot");
    } finally {
      storage.close();
      await removeDirectory(tempDirectory);
    }
  });

  it("renameは通常Sessionだけをatomicに更新し、replay時は再publishしない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-crud-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    const storage = new SessionStorageV6(dbPath);
    const publishedTitles: string[] = [];
    const publicationErrors: string[] = [];

    try {
      const normal = storage.insertSession(buildNewSession({
        id: "normal-session",
        taskTitle: "Before",
        workspaceLabel: "workspace",
        workspacePath: tempDirectory,
        branch: "",
        characterId: character.id,
        character: character.name,
        characterIconPath: "",
        characterThemeColors: character.theme,
        approvalMode: DEFAULT_APPROVAL_MODE,
      }));
      storage.insertSession(buildNewSession({
        id: "authoring-session",
        taskTitle: "Authoring",
        workspaceLabel: "workspace",
        workspacePath: tempDirectory,
        branch: "",
        sessionKind: "character-authoring",
        characterId: character.id,
        character: character.name,
        characterIconPath: "",
        characterThemeColors: character.theme,
        approvalMode: DEFAULT_APPROVAL_MODE,
      }));
      const service = new SessionCrudService({
        storage,
        resolveLaunchSelection: async () => { throw new Error("not used"); },
        listCharacters: () => [],
        listSessionSummaries: () => storage.listSessionSummaries(),
        listOpenSessionWindowIds: () => [],
        createCharacterRuntimeSnapshot: () => null,
        createSessionId: () => "not-used",
        createSessionFilesDirectory: async () => { throw new Error("not used"); },
        resolveSessionFilesDirectory: (sessionId) => path.join(tempDirectory, "session-files", sessionId),
        publishCreatedSession: () => undefined,
        publishRenamedSession: (session) => {
          publishedTitles.push(session.taskTitle);
          throw new Error("broadcast failed");
        },
        reportPublicationError: (operation) => publicationErrors.push(operation),
        now: () => new Date("2026-08-11T00:10:00.000Z"),
      });

      const input = { sessionId: normal.id, title: "After", idempotencyKey: "rename-key-1" };
      const renamed = await service.rename(input);
      const replay = await service.rename(input);
      assert.deepEqual(replay, renamed);
      assert.equal(storage.getSessionSummary(normal.id)?.taskTitle, "After");
      assert.deepEqual(publishedTitles, ["After"]);
      assert.deepEqual(publicationErrors, ["session.rename"]);
      await assert.rejects(
        () => service.rename({
          sessionId: "authoring-session",
          title: "Must not change",
          idempotencyKey: "rename-key-2",
        }),
        (error) => error instanceof SessionCrudError && error.code === "SESSION_KIND_UNSUPPORTED",
      );
      assert.equal(storage.getSessionSummary("authoring-session")?.taskTitle, "Authoring");
    } finally {
      storage.close();
      await removeDirectory(tempDirectory);
    }
  });

  it("DB commit失敗時は作成済みSessionFolderをcleanupして孤立directoryを残さない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-crud-"));
    const sessionFolder = path.join(tempDirectory, "session-files", "session-failed");
    const actor = createRootSession("actor-session");
    try {
      const service = new SessionCrudService({
        storage: {
          resolveSessionCrudIdempotency: () => ({ kind: "absent" }),
          insertSessionIdempotently: () => { throw new Error("database failed"); },
          renameSessionIdempotently: () => { throw new Error("unused"); },
          listSessionSummaryPage: () => [],
          getSessionSummary: (sessionId) => sessionId === actor.id ? projectSessionSummary(actor) : null,
        },
        resolveLaunchSelection: async () => ({
          provider: "codex",
          catalogRevision: 4,
          model: "gpt-test",
          reasoningEffort: "high",
          approvalMode: DEFAULT_APPROVAL_MODE,
          codexSandboxMode: "workspace-write",
          customAgentName: "",
        }),
        isProviderSupported: () => true,
        listCharacters: () => [character],
        listSessionSummaries: () => [],
        listOpenSessionWindowIds: () => [],
        createCharacterRuntimeSnapshot: () => characterSnapshot,
        createSessionId: () => "session-failed",
        createSessionFilesDirectory: async () => {
          await mkdir(sessionFolder, { recursive: true });
          return sessionFolder;
        },
        cleanupSessionFilesDirectory: async () => removeDirectory(sessionFolder),
        resolveSessionFilesDirectory: () => sessionFolder,
        publishCreatedSession: () => undefined,
        publishRenamedSession: () => undefined,
        now: () => new Date("2026-08-11T00:00:00.000Z"),
        random: () => 0,
      });

      await assert.rejects(
        () => service.create({
          title: "Failed create",
          sessionRole: "executor",
          provider: "codex",
          catalogRevision: 4,
          workspace: { kind: "session_folder" },
          idempotencyKey: "failed-key",
        }, actor.id),
        (error) => error instanceof SessionCrudError && error.code === "RUNTIME_UNAVAILABLE",
      );
      await assert.rejects(() => stat(sessionFolder), { code: "ENOENT" });
    } finally {
      await removeDirectory(tempDirectory);
    }
  });

  it("DB commit失敗後のSessionFolder cleanup失敗をrecoverable errorとして返す", async () => {
    const actor = createRootSession("actor-session");
    const service = new SessionCrudService({
      storage: {
        resolveSessionCrudIdempotency: () => ({ kind: "absent" }),
        insertSessionIdempotently: () => { throw new Error("database failed"); },
        renameSessionIdempotently: () => { throw new Error("unused"); },
        listSessionSummaryPage: () => [],
        getSessionSummary: (sessionId) => sessionId === actor.id ? projectSessionSummary(actor) : null,
      },
      resolveLaunchSelection: async () => ({
        provider: "codex",
        catalogRevision: 4,
        model: "gpt-test",
        reasoningEffort: "high",
        approvalMode: DEFAULT_APPROVAL_MODE,
        codexSandboxMode: "workspace-write",
        customAgentName: "",
      }),
      isProviderSupported: () => true,
      listCharacters: () => [character],
      listSessionSummaries: () => [],
      listOpenSessionWindowIds: () => [],
      createCharacterRuntimeSnapshot: () => characterSnapshot,
      createSessionId: () => "session-cleanup-failed",
      createSessionFilesDirectory: async () => "C:/session-files/session-cleanup-failed",
      cleanupSessionFilesDirectory: async () => { throw new Error("cleanup failed"); },
      resolveSessionFilesDirectory: () => "C:/session-files/session-cleanup-failed",
      publishCreatedSession: () => undefined,
      publishRenamedSession: () => undefined,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
      random: () => 0,
    });

    await assert.rejects(
      () => service.create({
        title: "Failed create",
        sessionRole: "executor",
        provider: "codex",
        catalogRevision: 4,
        workspace: { kind: "session_folder" },
        idempotencyKey: "cleanup-failed-key",
      }, actor.id),
      (error) => error instanceof SessionCrudError
        && error.code === "SESSION_FOLDER_CLEANUP_REQUIRED"
        && error.details?.sessionId === "session-cleanup-failed",
    );
  });
});
