import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
import { SessionAuthorityError } from "../../src/session-authority.js";
import type { ResolvedAgentRuntimeBinding } from "../../src-electron/agent-runtime-binding.js";
import { buildNewSession, projectSessionSummary } from "../../src/session-state.js";
import type { SessionRuntimeOperation } from "../../src/session-external-runtime-contract.js";
import { SessionCrudError, SessionCrudService } from "../../src-electron/session-crud-service.js";
import { SessionAuthorityService } from "../../src-electron/session-authority-service.js";
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

const AUTHORITY_NOW = "2099-08-11T00:00:00.000Z";

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

function authorize(
  authority: SessionAuthorityService,
  storage: SessionStorageV6,
  sessionId: string,
  operation: SessionRuntimeOperation,
  input: unknown,
) {
  const session = storage.getSessionSummary(sessionId);
  if (!session?.roleBinding) throw new Error(`Missing Session Role binding: ${sessionId}`);
  const binding: ResolvedAgentRuntimeBinding = {
    bindingId: `binding-${sessionId}`,
    bindingIdHash: `binding-hash-${sessionId}`,
    actorSessionId: sessionId,
    providerId: session.provider,
    executionGeneration: "generation-1",
    authoritySnapshot: { sessionKind: "default", sessionRoleBinding: session.roleBinding },
    operationGrants: ["session.runtime.invoke"],
    createdAt: AUTHORITY_NOW,
    expiresAt: null,
  };
  return authority.authorize(binding, operation, input).proof;
}

function sessionRevision(storage: SessionStorageV6, sessionId: string): number {
  const revision = storage.getSessionResourceRevision(sessionId);
  if (revision === null) throw new Error(`Missing Session resource revision: ${sessionId}`);
  return revision;
}

describe("SessionCrudService", () => {
  // @test-value v1
  // kind = "security"
  // claim = "Session create replayとcanonical list projectionはauthority proofのprincipalとroot scopeを保つ"
  // oracle = { type = "contract", ref = "AUTONOMY-GRANT-02 / AUTONOMY-MUTATION-05" }
  // failure_mode = "self listが同rootの別Sessionを返す、root_member listが別rootを返す、またはcreate replayがcontainer revisionを二重消費する"
  // scope = "SessionCrudService real SQLite create and list"
  // lifecycle = "permanent"
  // distinction = "同一rootの親子Sessionと別root Sessionをreal storageへ保存し、serviceのpublic projectionでselfとroot_memberを比較する"
  // @end-test-value
  it("create replayはCharacterを再抽選せず、public projectionとGUI同期を一度だけ確定する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-crud-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    const sessionFilesRoot = path.join(tempDirectory, "session-files");
    const storage = new SessionStorageV6(dbPath);
    let catalogRevision = 4;
    let launchSelectionCount = 0;
    let sessionIdCount = 0;
    let snapshotCount = 0;
    let authority: SessionAuthorityService | null = null;
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
      authority = new SessionAuthorityService({
        databasePath: dbPath,
        getExecutionGeneration: () => "generation-1",
        now: () => new Date(AUTHORITY_NOW),
      });
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
        cleanupSessionFilesDirectory: async (sessionId) => {
          await rm(path.join(sessionFilesRoot, sessionId), { recursive: true, force: true });
        },
        resolveSessionFilesDirectory: (sessionId) => path.join(sessionFilesRoot, sessionId),
        publishCreatedSession: (session) => {
          publishedSessionIds.push(session.id);
          throw new Error("broadcast failed");
        },
        publishRenamedSession: () => undefined,
        reportPublicationError: (operation) => publicationErrors.push(operation),
        resolveCurrentWorkspaceBranch: async () => "feature/current",
        now: () => new Date(AUTHORITY_NOW),
        random: () => 0,
      });
      await mkdir(sessionFilesRoot);

      const input = {
        title: "Created externally",
        sessionRole: "task-coordinator" as const,
        provider: "codex" as const,
        catalogRevision: 4,
        workspace: { kind: "session_folder" as const },
        expectedContainerRevision: sessionRevision(storage, actorSessionId),
        idempotencyKey: "create-key-1",
      };
      const created = await service.create(
        input,
        actorSessionId,
        authorize(authority, storage, actorSessionId, "session.create", input),
      );
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
      const replay = await service.create(
        input,
        actorSessionId,
        authorize(authority, storage, actorSessionId, "session.create", input),
      );

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
        () => {
          const changedInput = { ...input, sessionRole: "executor" as const };
          return service.create(
            changedInput,
            actorSessionId,
            authorize(authority!, storage, actorSessionId, "session.create", changedInput),
          );
        },
        (error) => error instanceof SessionCrudError && error.code === "IDEMPOTENCY_CONFLICT",
      );
      catalogRevision = 4;
      const otherActorInput = {
        ...input,
        sessionRole: "executor" as const,
        expectedContainerRevision: sessionRevision(storage, secondActorSessionId),
      };
      const otherActorCreate = await service.create(
        otherActorInput,
        secondActorSessionId,
        authorize(authority, storage, secondActorSessionId, "session.create", otherActorInput),
      );
      assert.equal(otherActorCreate.parentSessionId, secondActorSessionId);
      assert.equal(otherActorCreate.sessionRole, "executor");
      assert.notEqual(otherActorCreate.sessionId, created.sessionId);

      const depthTwoInput = {
        ...input,
        sessionRole: "executor",
        expectedContainerRevision: sessionRevision(storage, created.sessionId),
        idempotencyKey: "depth-two",
      } as const;
      const depthTwoExecutor = await service.create(
        depthTwoInput,
        created.sessionId,
        authorize(authority, storage, created.sessionId, "session.create", depthTwoInput),
      );
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
        const forbiddenInput = {
          ...input,
          sessionRole: "executor" as const,
          expectedContainerRevision: sessionRevision(storage, forbiddenActorSessionId),
          idempotencyKey: `forbidden-${forbiddenActorSessionId}`,
        };
        assert.throws(
          () => authorize(authority!, storage, forbiddenActorSessionId, "session.create", forbiddenInput),
          (error) => error instanceof SessionAuthorityError && error.code === "AUTHORITY_FORBIDDEN",
        );
      }
      assert.equal(sessionIdCount, countBeforeForbiddenCreate);
      assert.equal(launchSelectionCount, launchCountBeforeForbiddenCreate);

      const listInput = { limit: 50 };
      const selfListed = await service.list(
        listInput,
        authorize(authority, storage, created.sessionId, "session.list", listInput),
      );
      assert.deepEqual(selfListed.items.map((session) => session.sessionId), [created.sessionId]);
      const listed = await service.list(
        listInput,
        authorize(authority, storage, actorSessionId, "session.list", listInput),
      );
      assert.deepEqual(
        new Set(listed.items.map((session) => session.sessionId)),
        new Set([actorSessionId, created.sessionId, depthTwoExecutor.sessionId]),
      );
      const listedCreated = listed.items.find((session) => session.sessionId === created.sessionId)!;
      assert.equal(listedCreated.workspace.path, path.join(sessionFilesRoot, "session-1"));
      assert.equal("branch" in listedCreated.workspace, false);
      assert.equal((await service.get(created.sessionId)).workspace.branch, null);

      const ordinarySessionFolderName = path.join(tempDirectory, "external", "SessionFolder");
      await mkdir(ordinarySessionFolderName, { recursive: true });
      catalogRevision = 4;
      const ordinaryDirectoryInput = {
        ...input,
        workspace: { kind: "directory", path: ordinarySessionFolderName },
        expectedContainerRevision: sessionRevision(storage, actorSessionId),
        idempotencyKey: "create-key-2",
      } as const;
      const ordinaryDirectory = await service.create(
        ordinaryDirectoryInput,
        actorSessionId,
        authorize(authority, storage, actorSessionId, "session.create", ordinaryDirectoryInput),
      );
      assert.equal(ordinaryDirectory.workspace.kind, "directory");
      const listedOrdinaryDirectory = (await service.list(
        listInput,
        authorize(authority, storage, actorSessionId, "session.list", listInput),
      )).items.find(
        (session) => session.sessionId === ordinaryDirectory.sessionId,
      );
      assert.equal(listedOrdinaryDirectory?.workspace.kind, "directory");
      assert.equal(listedOrdinaryDirectory?.workspace.path, ordinaryDirectory.workspace.path);
      assert.equal("branch" in listedOrdinaryDirectory!.workspace, false);
      assert.equal((await service.get(ordinaryDirectory.sessionId)).workspace.branch, "feature/current");

      const copilotInput = {
        ...input,
        provider: "copilot",
        workspace: { kind: "session_folder" },
        expectedContainerRevision: sessionRevision(storage, actorSessionId),
        idempotencyKey: "create-key-copilot",
      } as const;
      const copilot = await service.create(
        copilotInput,
        actorSessionId,
        authorize(authority, storage, actorSessionId, "session.create", copilotInput),
      );
      assert.equal(copilot.provider.id, "copilot");
      assert.equal(storage.getSession(copilot.sessionId)?.provider, "copilot");
    } finally {
      authority?.close();
      storage.close();
      await removeDirectory(tempDirectory);
    }
  });

  // @test-value v1
  // kind = "contract"
  // claim = "Session renameはresource revisionとauthority proofを要求し、同一入力のreplayでは再publishしない"
  // oracle = { type = "contract", ref = "AUTONOMY-GRANT-02 / AUTONOMY-MUTATION-05" }
  // failure_mode = "staleまたは無権限renameを保存する、またはidempotent replayでGUI publishを重複する"
  // scope = "SessionCrudService rename"
  // lifecycle = "permanent"
  // @end-test-value
  it("renameは通常Sessionだけをatomicに更新し、replay時は再publishしない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-crud-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    const storage = new SessionStorageV6(dbPath);
    const publishedTitles: string[] = [];
    const publicationErrors: string[] = [];
    let authority: SessionAuthorityService | null = null;

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
      authority = new SessionAuthorityService({
        databasePath: dbPath,
        getExecutionGeneration: () => "generation-1",
        now: () => new Date(AUTHORITY_NOW),
      });
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
        now: () => new Date(AUTHORITY_NOW),
      });

      const input = {
        sessionId: normal.id,
        title: "After",
        expectedRevision: sessionRevision(storage, normal.id),
        idempotencyKey: "rename-key-1",
      };
      const proof = authorize(authority, storage, normal.id, "session.rename", input);
      const renamed = await service.rename(input, proof);
      const replay = await service.rename(input, proof);
      assert.deepEqual(replay, renamed);
      assert.equal(storage.getSessionSummary(normal.id)?.taskTitle, "After");
      assert.deepEqual(publishedTitles, ["After"]);
      assert.deepEqual(publicationErrors, ["session.rename"]);
      await assert.rejects(
        () => service.rename({
          sessionId: "authoring-session",
          title: "Must not change",
          expectedRevision: sessionRevision(storage, "authoring-session"),
          idempotencyKey: "rename-key-2",
        }, proof),
        (error) => error instanceof SessionCrudError && error.code === "SESSION_KIND_UNSUPPORTED",
      );
      assert.equal(storage.getSessionSummary("authoring-session")?.taskTitle, "Authoring");
    } finally {
      authority?.close();
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
