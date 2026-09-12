import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
import { SessionAuthorityError } from "../../src/session-authority.js";
import type { ResolvedAgentRuntimeBinding } from "../../src-electron/agent-runtime-binding.js";
import { buildNewSession } from "../../src/session-state.js";
import type { SessionRuntimeOperation } from "../../src/session-external-runtime-contract.js";
import { SessionCrudError, SessionCrudService } from "../../src-electron/session-crud-service.js";
import { SessionLifecycleRecoveryError, SessionLifecycleService } from "../../src-electron/session-lifecycle-service.js";
import { SessionLifecycleResolver } from "../../src-electron/session-lifecycle-resolver.js";
import { SessionAuthorityService } from "../../src-electron/session-authority-service.js";
import { ResourceBudgetStorage } from "../../src-electron/resource-budget-storage.js";
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
  return {
    ...buildNewSession({
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
    }),
    updatedAt: AUTHORITY_NOW,
  };
}

function authorize(
  authority: SessionAuthorityService,
  storage: SessionStorageV6,
  sessionId: string,
  operation: SessionRuntimeOperation,
  input: unknown,
) {
  if (operation === "session.create" && typeof input === "object" && input !== null && "placement" in input) {
    const lifecycleInput = input as { placement: { kind: string; sessionRole?: string }; provider: { id: string; catalogRevision: number }; workspace: unknown };
    input = { ...(input as Record<string, unknown>), sessionRole: lifecycleInput.placement.sessionRole,
      provider: lifecycleInput.provider.id, catalogRevision: lifecycleInput.provider.catalogRevision,
      workspace: lifecycleInput.workspace };
  }
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

function committedSessionCount(dbPath: string, sessionId: string): number {
  const storage = new ResourceBudgetStorage(dbPath);
  try {
    return storage.get(sessionId).dimensions.sessions.committed;
  } finally {
    storage.close();
  }
}

async function makeLifecycleFailureCrud(root: string, cleanupFolder: (folder: string) => Promise<void>): Promise<{
  service: SessionCrudService;
  lifecycle: SessionLifecycleService;
  storage: SessionStorageV6;
  authority: SessionAuthorityService;
  dbPath: string;
  folder: string;
  actorSessionId: string;
  close: () => Promise<void>;
}> {
  const dbPath = path.join(root, "app.db");
  const sessionFilesRoot = path.join(root, "session-files");
  const folder = path.join(sessionFilesRoot, "session-created");
  const actorSessionId = "failure-parent";
  const storage = new SessionStorageV6(dbPath);
  storage.insertSession(createRootSession(actorSessionId));
  const authority = new SessionAuthorityService({ databasePath: dbPath, getExecutionGeneration: () => "generation-1", now: () => new Date(AUTHORITY_NOW) });
  const lifecycle = new SessionLifecycleService({
    storage,
    resolver: new SessionLifecycleResolver({
      currentModelCatalog: () => ({ revision: 4, providers: [{ id: "codex", label: "Codex", defaultModelId: "gpt-test", defaultReasoningEffort: "high", models: [{ id: "gpt-test", label: "GPT test", reasoningEfforts: ["high"] }] }] }),
      isProviderEnabled: () => true,
      isProviderSupported: () => true,
      listCharacters: () => [character],
      createCharacterRuntimeSnapshot: () => characterSnapshot,
      resolveSessionFilesDirectory: (sessionId) => path.join(sessionFilesRoot, sessionId),
    }),
    createSessionFilesDirectory: async () => { await mkdir(folder, { recursive: false }); },
    cleanupSessionFilesDirectory: async () => cleanupFolder(folder),
    resolveSessionFilesDirectory: (sessionId) => path.join(sessionFilesRoot, sessionId),
    publishSession: () => undefined,
    publishRemovedSession: async () => undefined,
    createSessionId: () => "session-created",
    now: () => new Date(AUTHORITY_NOW),
  });
  const service = new SessionCrudService({
    lifecycle,
    storage,
    resolveLaunchSelection: async () => ({ provider: "codex", catalogRevision: 4, model: "gpt-test", reasoningEffort: "high", approvalMode: DEFAULT_APPROVAL_MODE, codexSandboxMode: "workspace-write", customAgentName: "" }),
    isProviderSupported: () => true,
    listCharacters: () => [character],
    listSessionSummaries: () => storage.listSessionSummaries(),
    listOpenSessionWindowIds: () => [],
    createCharacterRuntimeSnapshot: () => characterSnapshot,
    createSessionId: () => "session-created",
    createSessionFilesDirectory: async () => { await mkdir(folder, { recursive: false }); },
    cleanupSessionFilesDirectory: async () => cleanupFolder(folder),
    resolveSessionFilesDirectory: (sessionId) => path.join(sessionFilesRoot, sessionId),
    publishCreatedSession: () => undefined,
    publishRenamedSession: () => undefined,
    reportPublicationError: () => undefined,
    resolveCurrentWorkspaceBranch: async () => "feature/current",
    now: () => new Date(AUTHORITY_NOW),
    random: () => 0,
  });
  await mkdir(sessionFilesRoot);
  return { service, lifecycle, storage, authority, dbPath, folder, actorSessionId, close: async () => { storage.close(); authority.close(); await rm(root, { recursive: true, force: true }); } };
}

function failureCreateInput(storage: SessionStorageV6, actorSessionId: string, idempotencyKey: string) {
  return {
    title: "Failure create",
    placement: { kind: "child" as const, parentSessionId: actorSessionId, sessionRole: "executor" as const },
    character: { characterId: character.id, expectedDefinitionSha256: characterSnapshot.definitionSha256 },
    provider: { id: "codex" as const, catalogRevision: 4, model: "gpt-test", reasoningEffort: "high" as const, threadContinuity: "reset" as const, approvalMode: DEFAULT_APPROVAL_MODE, codexSandboxMode: "workspace-write" as const, allowedAdditionalDirectories: [] },
    workspace: { kind: "session_folder" as const }, expectedContainerRevision: sessionRevision(storage, actorSessionId),
    initialGrant: { kind: "inherit" as const }, budget: { kind: "inherit" as const }, idempotencyKey,
  };
}

describe("SessionCrudService", () => {
  // @test-value v2
  // kind = "security"
  // claim = "Session create replayとcanonical listはauthority scopeを保ち、root累積Session数を二重消費せず削除後も消費済み枠を返却しない"
  // oracle = { type = "contract", ref = "AUTONOMY-GRANT-02 / AUTONOMY-MUTATION-05; docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md" }
  // fault = "同root外のSessionを公開する、同一createの再送を新規Sessionとして計上する、またはSession削除で累積消費を減らす"
  // observable = "Session list projectionとroot budgetのsessions.committed"
  // observation_boundary = "component-behavior"
  // scope = "SessionCrudService real SQLite create and list"
  // lifecycle = "permanent"
  // distinction = "Session projectionとauthorityに加え、同じSQLite transactionへ接続された累積Session数をreplayと削除の前後で観測する"
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
      const lifecycle = new SessionLifecycleService({
        storage,
        resolver: new SessionLifecycleResolver({
          currentModelCatalog: () => ({ revision: catalogRevision, providers: [
            { id: "codex", label: "Codex", defaultModelId: "gpt-test", defaultReasoningEffort: "high", models: [{ id: "gpt-test", label: "GPT test", reasoningEfforts: ["high"] }] },
            { id: "copilot", label: "Copilot", defaultModelId: "gpt-test", defaultReasoningEffort: "high", models: [{ id: "gpt-test", label: "GPT test", reasoningEfforts: ["high"] }] },
          ] }),
          isProviderEnabled: () => true,
          isProviderSupported: () => true,
          listCharacters: () => [character],
          createCharacterRuntimeSnapshot: () => { snapshotCount += 1; return characterSnapshot; },
          resolveSessionFilesDirectory: (sessionId) => path.join(sessionFilesRoot, sessionId),
        }),
        createSessionFilesDirectory: async (sessionId) => {
          const directoryPath = path.join(sessionFilesRoot, sessionId);
          await mkdir(directoryPath, { recursive: false });
          return directoryPath;
        },
        cleanupSessionFilesDirectory: async (sessionId) => removeDirectory(path.join(sessionFilesRoot, sessionId)),
        resolveSessionFilesDirectory: (sessionId) => path.join(sessionFilesRoot, sessionId),
        publishSession: (session) => { publishedSessionIds.push(session.id); },
        publishRemovedSession: async () => undefined,
        createSessionId: () => `session-${++sessionIdCount}`,
        now: () => new Date(AUTHORITY_NOW),
      });
      const service = new SessionCrudService({
        lifecycle,
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
        placement: { kind: "child" as const, parentSessionId: actorSessionId, sessionRole: "task-coordinator" as const },
        character: { characterId: character.id, expectedDefinitionSha256: characterSnapshot.definitionSha256 },
        provider: { id: "codex" as const, catalogRevision: 4, model: "gpt-test", reasoningEffort: "high" as const, threadContinuity: "reset" as const, approvalMode: DEFAULT_APPROVAL_MODE, codexSandboxMode: "workspace-write" as const, allowedAdditionalDirectories: [] },
        workspace: { kind: "session_folder" as const },
        expectedContainerRevision: sessionRevision(storage, actorSessionId),
        initialGrant: { kind: "inherit" as const },
        budget: { kind: "inherit" as const },
        idempotencyKey: "create-key-1",
      };

      const created = await service.create(
        input,
        actorSessionId,
        authorize(authority, storage, actorSessionId, "session.create", input),
      );
      catalogRevision = 5;
      const replay = await service.create(
        input,
        actorSessionId,
        authorize(authority, storage, actorSessionId, "session.create", input),
      );
      assert.equal(committedSessionCount(dbPath, actorSessionId), 2);

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
      assert.equal(launchSelectionCount, 0);
      assert.equal(sessionIdCount, 1);
      assert.equal(snapshotCount, 1);
      assert.deepEqual(publishedSessionIds, ["session-1"]);
      assert.deepEqual(publicationErrors, []);

      await assert.rejects(
        () => {
          const changedInput = { ...input, placement: { ...input.placement, sessionRole: "executor" as const } };
          return service.create(
            changedInput,
            actorSessionId,
            authorize(authority!, storage, actorSessionId, "session.create", changedInput),
          );
        },
        (error) => (error as { code?: string }).code === "SESSION_LIFECYCLE_OPERATION_CONFLICT",
      );
      catalogRevision = 4;
      const otherActorInput = {
        ...input,
        placement: { kind: "child" as const, parentSessionId: secondActorSessionId, sessionRole: "executor" as const },
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
        placement: { kind: "child" as const, parentSessionId: "session-1", sessionRole: "executor" as const },
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
          placement: { kind: "child" as const, parentSessionId: forbiddenActorSessionId, sessionRole: "executor" as const },
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
        provider: { id: "copilot" as const, catalogRevision: 4, model: "gpt-test", reasoningEffort: "high" as const, threadContinuity: "reset" as const, approvalMode: DEFAULT_APPROVAL_MODE, customAgentName: "" },
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
      const committedBeforeDelete = committedSessionCount(dbPath, actorSessionId);
      await lifecycle.deleteSession(copilot.sessionId, "tombstone");
      assert.equal(storage.getSession(copilot.sessionId), null);
      assert.equal(committedSessionCount(dbPath, actorSessionId), committedBeforeDelete);
    } finally {
      storage.close();
      authority?.close();
      await removeDirectory(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Session renameは通常Sessionに限定され、同一入力のreplayでは再publishしない"
  // oracle = { type = "contract", ref = "AUTONOMY-GRANT-02 / AUTONOMY-MUTATION-05" }
  // fault = "character-authoring Sessionへのrenameを受理する、またはreplayで再publishする"
  // observable = "stored Session title、publish callback回数、stable SessionCrudError code"
  // observation_boundary = "component-behavior"
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
      storage.close();
      authority?.close();
      await removeDirectory(tempDirectory);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "SessionFolder作成後のdeterministicなDB拒否はSession rowを残さず、成功した補償cleanupで孤児folderを残さない"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md#Failure timing" }
  // fault = "DB commit拒否後にSessionFolderだけが残る"
  // observable = "Session rowの不在、pending operationの不在、実filesystemのfolder不在"
  // observation_boundary = "public-boundary"
  // scope = "SessionLifecycleService create compensation"
  // lifecycle = "permanent"
  // @end-test-value
  it("createはDB拒否後にSessionFolderを補償cleanupする", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "withmate-crud-create-compensation-"));
    const fixture = await makeLifecycleFailureCrud(root, async (folder) => { await rm(folder, { recursive: true, force: true }); });
    const originalCommit = fixture.storage.commitLifecycleMutation;
    fixture.storage.commitLifecycleMutation = (() => { throw new SessionCrudError("SESSION_STATE_CONFLICT", "deterministic DB rejection"); }) as typeof originalCommit;
    try {
      const input = failureCreateInput(fixture.storage, fixture.actorSessionId, "crud-compensation");
      await assert.rejects(fixture.service.create(input, fixture.actorSessionId, authorize(fixture.authority, fixture.storage, fixture.actorSessionId, "session.create", input)), SessionCrudError);
      assert.equal(fixture.storage.getLifecycleSession("session-created"), null);
      assert.equal(fixture.storage.listPendingLifecycleOperations().length, 0);
      await assert.rejects(access(fixture.folder));
    } finally { await fixture.close(); }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "補償cleanupが失敗したcreateはrecovery-requiredとしてidentityを保持し、再開時にcleanupだけを実行してnot_appliedで終端する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md#Direct validation" }
  // fault = "SessionFolder cleanup失敗後にoperationをrejectedまたは成功扱いにして再試行identityを失う"
  // observable = "recovery-required pending record、再開後のfolderとSession row、pending record数"
  // observation_boundary = "public-boundary"
  // scope = "SessionLifecycleService create cleanup recovery"
  // lifecycle = "permanent"
  // @end-test-value
  it("createはcleanup失敗をrecovery-requiredに保持して再開できる", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "withmate-crud-create-recovery-"));
    let cleanupFailures = 1;
    const fixture = await makeLifecycleFailureCrud(root, async (folder) => {
      if (cleanupFailures > 0) { cleanupFailures -= 1; throw new Error("cleanup unavailable"); }
      await rm(folder, { recursive: true, force: true });
    });
    const originalCommit = fixture.storage.commitLifecycleMutation;
    fixture.storage.commitLifecycleMutation = (() => { throw new SessionCrudError("SESSION_STATE_CONFLICT", "deterministic DB rejection"); }) as typeof originalCommit;
    try {
      const input = failureCreateInput(fixture.storage, fixture.actorSessionId, "crud-recovery");
      const proof = authorize(fixture.authority, fixture.storage, fixture.actorSessionId, "session.create", input);
      await assert.rejects(fixture.service.create(input, fixture.actorSessionId, proof), SessionLifecycleRecoveryError);
      const pending = fixture.storage.listPendingLifecycleOperations();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].state, "recovery-required");
      assert.equal((pending[0].error as { cleanupRequired?: boolean } | null)?.cleanupRequired, true);
      await access(fixture.folder);
      await fixture.lifecycle.recoverPending();
      assert.equal(fixture.storage.listPendingLifecycleOperations().length, 0);
      assert.equal(fixture.storage.getLifecycleSession("session-created"), null);
      await assert.rejects(access(fixture.folder));
    } finally { await fixture.close(); }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "createはlifecycle owner未接続を成功扱いせずRUNTIME_UNAVAILABLEで拒否する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md" }
  // fault = "ownerが未接続でも旧create経路へ進むか成功を返す"
  // observable = "createのRUNTIME_UNAVAILABLE error"
  // observation_boundary = "component-behavior"
  // scope = "SessionCrudService create delegation guard"
  // lifecycle = "permanent"
  // @end-test-value
  it("createはlifecycle owner未接続を拒否する", async () => {
    const service = new SessionCrudService({} as never);
    await assert.rejects(() => service.create({
      expectedContainerRevision: 1, placement: { kind: "child", parentSessionId: "actor", sessionRole: "executor" },
      title: "Create", character: { characterId: "character-a", expectedDefinitionSha256: "definition" },
      provider: { id: "codex", catalogRevision: 1, model: "model", reasoningEffort: "high", threadContinuity: "reset", approvalMode: "on-request", codexSandboxMode: "workspace-write", allowedAdditionalDirectories: [] },
      workspace: { kind: "session_folder" }, initialGrant: { kind: "inherit" }, budget: { kind: "inherit" }, idempotencyKey: "missing-owner",
    }, "actor", { principal: { kind: "agent", actorSessionId: "actor" } } as never),
    (error) => error instanceof SessionCrudError && error.code === "RUNTIME_UNAVAILABLE");
  });
});
