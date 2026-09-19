import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import { MainSessionCommandFacade } from "../../src-electron/main-session-command-facade.js";
import {
  ProviderRuntimeOperationCoordinator,
  type RunProviderRuntimeOperationExclusive,
} from "../../src-electron/provider-runtime-operation-coordinator.js";
import type { SessionLaunchSelection } from "../../src-electron/session-launch-selection-service.js";
import { SettingsCatalogService } from "../../src-electron/settings-catalog-service.js";

const runProviderRuntimeOperationExclusive: RunProviderRuntimeOperationExclusive =
  async (operation) => await operation();

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createLaunchSelection(
  overrides: Partial<SessionLaunchSelection> = {},
): SessionLaunchSelection {
  return {
    provider: "codex",
    catalogRevision: 3,
    model: "gpt-5.6",
    reasoningEffort: "high",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    ...overrides,
  };
}

function createSessionRequest(workspace: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: "codex",
    taskTitle: "test task",
    workspace,
    characterId: "character-1",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: {
      main: "#112233",
      sub: "#445566",
    },
    approvalMode: "untrusted",
  };
}

type MainSessionCommandFacadeTestDeps =
  Omit<
    ConstructorParameters<typeof MainSessionCommandFacade>[0],
    "dismissSessionTurnNotification" | "validateWorkspaceDirectory" | "initializeCreatedSession" | "getSessionStorageIdentity"
  >
  & Partial<Pick<
    ConstructorParameters<typeof MainSessionCommandFacade>[0],
    "dismissSessionTurnNotification" | "validateWorkspaceDirectory" | "initializeCreatedSession" | "getSessionStorageIdentity"
  >>;

function createMainSessionCommandFacade(
  deps: MainSessionCommandFacadeTestDeps,
): MainSessionCommandFacade {
  const defaultStorageIdentity = {};
  return new MainSessionCommandFacade({
    initializeCreatedSession: async () => undefined,
    dismissSessionTurnNotification: () => undefined,
    validateWorkspaceDirectory: async () => ({ valid: true }),
    getSessionStorageIdentity: () => defaultStorageIdentity,
    ...deps,
  });
}

// @test-value v2
// kind = "contract"
// claim = "Session削除結果に含まれる親SessionとAuxiliaryの通知対象をすべて撤去する"
// oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
// fault = "削除結果に含まれるAuxiliary通知の追跡keyを通知撤去へ渡さない"
// observable = "dismissSessionTurnNotificationへ渡されたID"
// observation_boundary = "component-behavior"
// scope = "main-session-command-facade-notification-cleanup"
// lifecycle = "permanent"
// distinction = "通知service単体ではなく、削除結果から親・Auxiliaryの通知撤去へ渡すfacade境界を検証する"
// @end-test-value
test("MainSessionCommandFacade は削除結果に含まれるAuxiliary通知も撤去する", async () => {
  const dismissedIds: string[] = [];
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () => ({
      deleteSession: () => ({
        deletedSessionIds: ["session-1"],
        deletedAuxiliarySessionIds: ["auxiliary-1"],
        skippedRunningSessionIds: [],
      }),
    }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
    dismissSessionTurnNotification(sessionId) {
      dismissedIds.push(sessionId);
    },
  });

  await facade.deleteSession("session-1");

  assert.deepEqual(dismissedIds, ["session-1", "auxiliary-1"]);
});

test("MainSessionCommandFacade は create/update/delete/cancel を各 service に委譲する", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [{ id: "s-1", workspacePath: "C:/work/repo" } as never],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () =>
      ({
        createSession(input) {
          calls.push(`create:${input.id}`);
          return input as never;
        },
        updateSession(session) {
          calls.push(`update:${session.id}`);
          return session as never;
        },
        setSessionPinned(sessionId, isPinned) {
          calls.push(`pin:${sessionId}:${isPinned}`);
          return { id: sessionId, isPinned } as never;
        },
        deleteSession(sessionId) {
          calls.push(`delete:${sessionId}`);
          return {
            deletedSessionIds: [sessionId],
            skippedRunningSessionIds: [],
          };
        },
        deleteSessionsLastActiveBefore() {
          calls.push("delete-old");
          return {
            deletedSessionIds: ["s-old"],
            skippedRunningSessionIds: [],
          };
        },
      }) as never,
    getSessionRuntimeService: () =>
      ({
        cancelRun(sessionId) {
          calls.push(`cancel:${sessionId}`);
        },
        isRunInFlight() {
          return false;
        },
      }) as never,
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
    dismissSessionTurnNotification(sessionId) {
      calls.push(`dismiss-notification:${sessionId}`);
    },
    async cleanupSessionFilesDirectory(sessionId) {
      calls.push(`cleanup-files:${sessionId}`);
    },
  });

  await facade.createSession({
    taskTitle: "test",
    workspaceLabel: "repo",
    workspacePath: "C:/work/repo",
    branch: "main",
    characterId: "character-1",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: {
      main: "#112233",
      sub: "#445566",
    },
    approvalMode: "untrusted",
  });
  facade.updateSession({ id: "s-1" } as never);
  await facade.setSessionPinned({ sessionId: " s-1 ", isPinned: true });
  await facade.deleteSession("s-1");
  facade.cancelSessionRun("s-1");

  assert.deepEqual(calls, [
    "create:launch-test",
    "update:s-1",
    "pin:s-1:true",
    "delete:s-1",
    "dismiss-notification:s-1",
    "cleanup-files:s-1",
    "cancel:s-1",
  ]);
});

test("MainSessionCommandFacade は Session 削除失敗時に通知を撤去しない", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [{ id: "s-1", workspacePath: "C:/work/repo" } as never],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () =>
      ({
        deleteSession(sessionId) {
          calls.push(`delete:${sessionId}`);
          throw new Error("delete failed");
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
    dismissSessionTurnNotification(sessionId) {
      calls.push(`dismiss-notification:${sessionId}`);
    },
  });

  await assert.rejects(facade.deleteSession("s-1"), /delete failed/);
  assert.deepEqual(calls, ["delete:s-1"]);
});

// @test-value v2
// kind = "contract"
// claim = "SessionFolderと保存するSessionは同じMain発行IDを使い、再検証済みの起動設定で保存する"
// oracle = { type = "adr", ref = "docs/adr/007-provider-runtime-selection-inheritance.md" }
// fault = "folderとSessionのIDが分岐する、またはworkspace情報や継承する起動設定を欠落させる"
// observable = "folder作成・保存へ渡すID、永続化入力のworkspaceと起動設定"
// observation_boundary = "component-behavior"
// scope = "MainSessionCommandFacadeのSessionFolder作成入力"
// lifecycle = "permanent"
// @end-test-value
test("MainSessionCommandFacade は SessionFolder を作成してから同じ ID の session を永続化する", async () => {
  const calls: string[] = [];
  let persistedInput: Record<string, unknown> | null = null;
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async (providerId) => {
      calls.push(`resolve:${providerId}`);
      return createLaunchSelection({
        model: "gpt-5.6-pro",
        reasoningEffort: "xhigh",
        approvalMode: "never",
        codexSandboxMode: "danger-full-access",
        customAgentName: "reviewer",
      });
    },
    getSessionPersistenceService: () =>
      ({
        createSession(input) {
          calls.push(`persist:${input.id}`);
          persistedInput = input as unknown as Record<string, unknown>;
          return input as never;
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => {
      calls.push("issue-id");
      return "launch-managed";
    },
    createSessionFilesDirectory: (sessionId) => {
      calls.push(`mkdir:${sessionId}`);
      return "C:/WithMate/session-files/launch-managed";
    },
    isSessionFilesWorkspace: () => false,
  });

  await facade.createSessionFromRequest(createSessionRequest({ kind: "session-folder" }) as never);

  assert.deepEqual(calls, [
    "resolve:codex",
    "issue-id",
    "mkdir:launch-managed",
    "resolve:codex",
    "persist:launch-managed",
  ]);
  assert.deepEqual(
    {
      id: persistedInput?.id,
      workspaceLabel: persistedInput?.workspaceLabel,
      workspacePath: persistedInput?.workspacePath,
      branch: persistedInput?.branch,
      workspace: persistedInput?.workspace,
      model: persistedInput?.model,
      reasoningEffort: persistedInput?.reasoningEffort,
      approvalMode: persistedInput?.approvalMode,
      codexSandboxMode: persistedInput?.codexSandboxMode,
      customAgentName: persistedInput?.customAgentName,
    },
    {
      id: "launch-managed",
      workspaceLabel: "SessionFolder",
      workspacePath: "C:/WithMate/session-files/launch-managed",
      branch: "",
      workspace: undefined,
      model: "gpt-5.6-pro",
      reasoningEffort: "xhigh",
      approvalMode: "never",
      codexSandboxMode: "danger-full-access",
      customAgentName: "reviewer",
    },
  );
});

// @test-value v2
// kind = "contract"
// claim = "Main Sessionの永続化後に行う初期Auxiliary作成はprovider runtime lockの外で実行し、同じlockを使う初期化処理を完了できる"
// oracle = { type = "contract", ref = "accepted behavior: created session initialization runs after provider-exclusive creation" }
// fault = "初期Auxiliary作成がprovider runtime lockを再取得してdeadlockする、または初期化前に作成結果を返す"
// observable = "initializeCreatedSession内のprovider runtime lock再取得とcreateSessionFromRequestの完了"
// observation_boundary = "public-boundary"
// scope = "main-session-create"
// lifecycle = "permanent"
// @end-test-value
test("MainSessionCommandFacade は Main Session 作成後の初期化を provider runtime lock の外で完了する", async () => {
  const coordinator = new ProviderRuntimeOperationCoordinator();
  const events: string[] = [];
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive: (operation) => coordinator.runExclusive(operation),
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () =>
      ({
        createSession(input) {
          events.push(`persist:${input.id}`);
          return input as never;
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    initializeCreatedSession: async (session) => {
      events.push(`initialize:start:${session.id}`);
      await coordinator.runExclusive(() => {
        events.push(`initialize:lock:${session.id}`);
      });
      events.push(`initialize:end:${session.id}`);
    },
    createSessionId: () => "launch-initialized",
    createSessionFilesDirectory: () => "C:/WithMate/session-files/launch-initialized",
    isSessionFilesWorkspace: () => false,
  });

  const result = await facade.createSessionFromRequest(
    createSessionRequest({ kind: "directory", label: "repo", path: "C:/repo", branch: "main" }) as never,
  );

  assert.equal(result.id, "launch-initialized");
  assert.deepEqual(events, [
    "persist:launch-initialized",
    "initialize:start:launch-initialized",
    "initialize:lock:launch-initialized",
    "initialize:end:launch-initialized",
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "Main Session保存後の初期Auxiliary作成失敗は保存済みSessionを保持し、再開用IDをエラーへ含める"
// oracle = { type = "contract", ref = "src-electron/main-session-command-facade.ts#createSessionFromRequest" }
// fault = "初期化失敗後に保存済みMain Sessionを削除し、利用者が再開できるSession IDを失う"
// observable = "返却されたError messageの保存済みSession IDとdeleteSessionが呼ばれていないこと"
// observation_boundary = "public-boundary"
// scope = "main-session-create"
// lifecycle = "permanent"
// @end-test-value
test("MainSessionCommandFacade は保存後の初期化失敗時に Main Session と SessionFolder を保持する", async () => {
  const calls: string[] = [];
  const existingSession = { id: "existing-session", workspacePath: "C:/existing" } as never;
  const createdSession = {
    id: "launch-initialize-failed",
    workspacePath: "C:/WithMate/session-files/launch-initialize-failed",
  } as never;
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [existingSession, createdSession],
    getStoredSessionSummaries: () => [existingSession],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () =>
      ({
        createSession() {
          calls.push("persist");
          return createdSession;
        },
        deleteSession(sessionId) {
          calls.push(`delete:${sessionId}`);
          return { deletedSessionIds: [sessionId], skippedRunningSessionIds: [] };
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    initializeCreatedSession: async () => {
      calls.push("initialize");
      throw new Error("default Auxiliary を作成できない");
    },
    createSessionId: () => "launch-initialize-failed",
    createSessionFilesDirectory: () => "C:/WithMate/session-files/launch-initialize-failed",
    isSessionFilesWorkspace: (session) => session.id === createdSession.id,
    dismissSessionTurnNotification(sessionId) {
      calls.push(`dismiss:${sessionId}`);
    },
    cleanupSessionFilesDirectory(sessionId) {
      calls.push(`cleanup:${sessionId}`);
      return Promise.resolve();
    },
  });

  await assert.rejects(
    facade.createSessionFromRequest(createSessionRequest({ kind: "session-folder" }) as never),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /保存済みの Session ID: launch-initialize-failed/);
      assert.match(error.message, /default Auxiliary を作成できない/);
      assert.equal(error.cause instanceof Error ? error.cause.message : error.cause, "default Auxiliary を作成できない");
      return true;
    },
  );
  assert.deepEqual(calls, [
    "persist",
    "initialize",
  ]);
  assert.equal(calls.some((call) => call.startsWith("delete:")), false);
  assert.equal(calls.some((call) => call.startsWith("cleanup:")), false);
});

// @test-value v2
// kind = "contract"
// claim = "初期化失敗中に同じMain Sessionが更新されても保存済みSessionを削除しない"
// oracle = { type = "contract", ref = "src-electron/main-session-command-facade.ts#createSessionFromRequest" }
// fault = "初期化失敗時の無条件rollbackが並行updateの変更を破壊する"
// observable = "並行updateの完了とdeleteSessionの不在"
// observation_boundary = "public-boundary"
// scope = "main-session-create"
// lifecycle = "permanent"
// @end-test-value
test("MainSessionCommandFacade は並行操作中の初期化失敗でも保存済みSessionを削除しない", async () => {
  const initializationError = new Error("Auxiliary initialization failed");
  const initializationStarted = createDeferred<void>();
  const releaseInitialization = createDeferred<never>();
  const calls: string[] = [];
  const createdSession = {
    id: "launch-cleanup-failed",
    workspacePath: "C:/WithMate/session-files/launch-cleanup-failed",
  } as never;
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [createdSession],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () =>
      ({
        createSession() {
          calls.push("persist");
          return createdSession;
        },
        updateSession(session: unknown) {
          calls.push("update");
          return session;
        },
        deleteSession() {
          calls.push("delete");
          return { deletedSessionIds: [createdSession.id], skippedRunningSessionIds: [] };
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    initializeCreatedSession: async () => {
      initializationStarted.resolve();
      await releaseInitialization.promise;
      throw initializationError;
    },
    createSessionId: () => createdSession.id,
    createSessionFilesDirectory: () => "C:/WithMate/session-files/launch-cleanup-failed",
    isSessionFilesWorkspace: () => true,
    dismissSessionTurnNotification: () => undefined,
  });

  const createPromise = facade.createSessionFromRequest(createSessionRequest({ kind: "session-folder" }) as never);
  await initializationStarted.promise;
  const update = await facade.updateSession({ ...createdSession, taskTitle: "updated while initializing" } as never);
  releaseInitialization.resolve(undefined as never);

  await assert.rejects(
    createPromise,
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, initializationError);
      assert.match(error.message, /保存済みの Session ID: launch-cleanup-failed/);
      return true;
    },
  );
  assert.equal((update as { taskTitle: string }).taskTitle, "updated while initializing");
  assert.deepEqual(calls, ["persist", "update"]);
});

test("MainSessionCommandFacade は空の Character ID を SessionFolder 作成前に拒否する", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => {
      calls.push("resolve-selection");
      return createLaunchSelection();
    },
    getSessionPersistenceService: () =>
      ({
        createSession() {
          calls.push("persist");
          throw new Error("unexpected persistence");
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => {
      calls.push("issue-id");
      return "launch-empty-character";
    },
    createSessionFilesDirectory: () => {
      calls.push("create-folder");
      return "C:/WithMate/session-files/launch-empty-character";
    },
    isSessionFilesWorkspace: () => false,
  });

  for (const workspace of [
    { kind: "session-folder" },
    { kind: "directory", label: "repo", path: "C:/repo", branch: "main" },
  ]) {
    for (const characterId of ["", " \t\n "]) {
      const request = createSessionRequest(workspace);
      request.characterId = characterId;
      request.characterRuntimeSnapshot = null;

      await assert.rejects(
        facade.createSessionFromRequest(request as never),
        /characterId.*空/,
      );
    }
  }
  assert.deepEqual(calls, []);
});

test("MainSessionCommandFacade は Character owner ID と snapshot owner ID を trim 後の値で保存する", async () => {
  let persistedInput: Record<string, unknown> | null = null;
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () =>
      ({
        createSession(input) {
          persistedInput = input as unknown as Record<string, unknown>;
          return input as never;
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-normalized-owner",
    createSessionFilesDirectory: () => "C:/WithMate/session-files/launch-normalized-owner",
    isSessionFilesWorkspace: () => false,
  });
  const request = createSessionRequest({ kind: "session-folder" });
  request.characterId = " character-1 ";
  request.characterRuntimeSnapshot = {
    characterId: "\tcharacter-1\n",
    name: "Character",
    description: "",
    iconFilePath: "",
    theme: { main: "#112233", sub: "#445566" },
    definitionMarkdown: "# Character\nCharacter",
    definitionSha256: "character-sha256",
    definitionByteSize: 21,
    snapshotAt: "2026-08-01T00:00:00.000Z",
  };

  await facade.createSessionFromRequest(request as never);

  assert.equal(persistedInput?.characterId, "character-1");
  assert.equal(
    (persistedInput?.characterRuntimeSnapshot as { characterId?: unknown } | undefined)?.characterId,
    "character-1",
  );
});

test("MainSessionCommandFacade は Character ID と runtime snapshot owner の不一致を副作用前に拒否する", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => {
      calls.push("resolve-selection");
      return createLaunchSelection();
    },
    getSessionPersistenceService: () =>
      ({
        createSession() {
          calls.push("persist");
          throw new Error("unexpected persistence");
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-mismatch",
    createSessionFilesDirectory: () => {
      calls.push("create-folder");
      return "C:/WithMate/session-files/launch-mismatch";
    },
    isSessionFilesWorkspace: () => false,
  });
  const request = createSessionRequest({ kind: "session-folder" });
  request.characterRuntimeSnapshot = {
    characterId: "other-character",
    name: "Other",
    description: "",
    iconFilePath: "",
    theme: { main: "#112233", sub: "#445566" },
    definitionMarkdown: "# Character\nOther",
    definitionSha256: "other-sha256",
    definitionByteSize: 17,
    snapshotAt: "2026-08-01T00:00:00.000Z",
  };

  await assert.rejects(
    facade.createSessionFromRequest(request as never),
    /characterId と一致しない/,
  );
  assert.deepEqual(calls, []);
});

// @test-value v2
// kind = "contract"
// claim = "SessionFolder準備中のSettings更新は待機せず、起動設定の最終解決と保存中のSettings更新だけを直列化する"
// oracle = { type = "adr", ref = "docs/adr/007-provider-runtime-selection-inheritance.md" }
// fault = "folder準備がprovider coordinatorを保持してSettings更新を待たせる、または再検証と保存の途中にSettings更新が割り込む"
// observable = "folder barrier解放前のSettings更新完了、再解決・永続化event、保存後の次Settings更新event"
// observation_boundary = "component-behavior"
// scope = "実provider coordinatorとSettingsCatalogServiceを接続したMain作成境界"
// lifecycle = "permanent"
// impact = "filesystem待機がSettings操作を停止させるか、古い起動設定で作成する"
// distinction = "任意sleepではなくfolder barrierを保持した状態で別の実service操作が完了することを確認する"
// @end-test-value
test("Session 作成中は Settings 更新を同じ runtime 選択境界の完了まで待機させる", async () => {
  const coordinator = new ProviderRuntimeOperationCoordinator();
  const runExclusive: RunProviderRuntimeOperationExclusive =
    (operation) => coordinator.runExclusive(operation);
  const folderEntered = createDeferred();
  const releaseFolder = createDeferred();
  const persistenceEntered = createDeferred();
  const releasePersistence = createDeferred();
  const events: string[] = [];
  let settings = createDefaultAppSettings();
  const settingsService = new SettingsCatalogService({
    runProviderRuntimeOperationExclusive: runExclusive,
    getAppSettings: () => settings,
    updateAppSettings: (nextSettings) => {
      events.push("settings:update");
      settings = nextSettings;
      return settings;
    },
    listSessions: () => [],
    listAuxiliarySessions: () => [],
    applyAppSettingsSideEffects: () => undefined,
    broadcastAppSettings: () => {
      events.push("settings:broadcast");
    },
  } as never);
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive: runExclusive,
    resolveSessionLaunchSelection: async () => {
      events.push("selection:resolve");
      return createLaunchSelection();
    },
    getSessionPersistenceService: () =>
      ({
        async createSession(input) {
          persistenceEntered.resolve();
          await releasePersistence.promise;
          events.push("session:persist");
          return input as never;
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-serialized",
    createSessionFilesDirectory: async () => {
      events.push("folder:start");
      folderEntered.resolve();
      await releaseFolder.promise;
      events.push("folder:end");
      return "C:/WithMate/session-files/launch-serialized";
    },
    isSessionFilesWorkspace: () => false,
  });

  const createPromise = facade.createSessionFromRequest(
    createSessionRequest({ kind: "session-folder" }) as never,
  );
  await folderEntered.promise;
  const settingsPromise = settingsService.updateAppSettings({
    ...settings,
    launchAtLoginEnabled: !settings.launchAtLoginEnabled,
  });

  await settingsPromise;
  assert.deepEqual(events, ["selection:resolve", "folder:start", "settings:update", "settings:broadcast"]);
  releaseFolder.resolve();
  await persistenceEntered.promise;
  const nextSettingsPromise = settingsService.updateAppSettings({
    ...settings,
    launchAtLoginEnabled: !settings.launchAtLoginEnabled,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event === "settings:update").length, 1);
  releasePersistence.resolve();
  await Promise.all([createPromise, nextSettingsPromise]);

  assert.deepEqual(events, [
    "selection:resolve",
    "folder:start",
    "settings:update",
    "settings:broadcast",
    "folder:end",
    "selection:resolve",
    "session:persist",
    "settings:update",
    "settings:broadcast",
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "SessionFolder準備後のcommitは初回に解決したstorage identityとlaunch selectionを再検証し、不一致時は保存せず今回のfolderだけを後始末する"
// oracle = { type = "adr", ref = "docs/adr/007-provider-runtime-selection-inheritance.md" }
// fault = "準備中のSettings/catalog/providerまたはDB resetの変更を検知せず古い選択でSessionを保存する、または再検証失敗後にfolderを残す"
// observable = "再解決回数、Persistence Service呼出し、今回のSession IDに対するfolder cleanup呼出し"
// observation_boundary = "public-boundary"
// scope = "main-session-create-session-folder-revalidation"
// lifecycle = "permanent"
// distinction = "SessionFolder準備中の外部待機とcoordinator内のcommit再検証を、Persistence Serviceの保存結果ではなく作成境界で確認する"
// @end-test-value
test("SessionFolder のcommit前再検証は selection と storage の変更を保存せず今回のfolderだけcleanupする", async () => {
  const selectionChanges: Partial<SessionLaunchSelection>[] = [
    { provider: "copilot" },
    { catalogRevision: 4 },
    { model: "gpt-5.6-pro" },
    { reasoningEffort: "medium" },
    { approvalMode: "never" },
    { codexSandboxMode: "read-only" },
    { codexSpeed: "fast" },
    { codexReviewer: "auto-review" },
    { customAgentName: "reviewer" },
  ];
  for (const change of selectionChanges) {
    const calls: string[] = [];
    let resolveCount = 0;
    let persisted = false;
    const baseSelection = createLaunchSelection();
    const facade = createMainSessionCommandFacade({
      getSession: () => null,
      getSessions: () => [],
      getStoredSessionSummaries: () => [],
      runProviderRuntimeOperationExclusive,
      resolveSessionLaunchSelection: async () => {
        resolveCount += 1;
        calls.push(`resolve:${resolveCount}`);
        return resolveCount === 1
          ? baseSelection
          : { ...baseSelection, ...change };
      },
      getSessionPersistenceService: () => ({
        createSession() {
          persisted = true;
          return {} as never;
        },
      }) as never,
      getSessionRuntimeService: () => ({} as never),
      getProviderQuotaTelemetry: () => null,
      isProviderQuotaTelemetryStale: () => false,
      refreshProviderQuotaTelemetry: async () => null,
      createSessionId: () => "launch-selection-changed",
      createSessionFilesDirectory: () => "C:/WithMate/session-files/launch-selection-changed",
      isSessionFilesWorkspace: () => false,
      cleanupSessionFilesDirectory: async (sessionId) => {
        calls.push(`cleanup:${sessionId}`);
      },
    });

    await assert.rejects(
      facade.createSessionFromRequest(createSessionRequest({ kind: "session-folder" }) as never),
      /起動設定が作成中に変わった/,
    );
    assert.equal(persisted, false);
    assert.deepEqual(calls, ["resolve:1", "resolve:2", "cleanup:launch-selection-changed"]);
  }

  for (const mode of ["storage", "resolve-error"] as const) {
    const calls: string[] = [];
    const initialStorage = {};
    let currentStorage = initialStorage;
    let resolveCount = 0;
    const facade = createMainSessionCommandFacade({
      getSession: () => null,
      getSessions: () => [],
      getStoredSessionSummaries: () => [],
      runProviderRuntimeOperationExclusive,
      getSessionStorageIdentity: () => currentStorage,
      resolveSessionLaunchSelection: async () => {
        resolveCount += 1;
        if (mode === "resolve-error" && resolveCount === 2) {
          throw new Error("latest selection read failed");
        }
        return createLaunchSelection();
      },
      getSessionPersistenceService: () => ({
        createSession() {
          throw new Error("should not persist");
        },
      }) as never,
      getSessionRuntimeService: () => ({} as never),
      getProviderQuotaTelemetry: () => null,
      isProviderQuotaTelemetryStale: () => false,
      refreshProviderQuotaTelemetry: async () => null,
      createSessionId: () => "launch-storage-changed",
      createSessionFilesDirectory: () => {
        if (mode === "storage") {
          currentStorage = {};
        }
        return "C:/WithMate/session-files/launch-storage-changed";
      },
      isSessionFilesWorkspace: () => false,
      cleanupSessionFilesDirectory: async (sessionId) => {
        calls.push(`cleanup:${sessionId}`);
      },
    });

    await assert.rejects(
      facade.createSessionFromRequest(createSessionRequest({ kind: "session-folder" }) as never),
      mode === "storage" ? /storage が作成中に切り替わった/ : /latest selection read failed/,
    );
    assert.deepEqual(calls, ["cleanup:launch-storage-changed"]);
  }
});

test("MainSessionCommandFacade は Browse で選んだ directory をそのまま session に使う", async () => {
  let persistedInput: Record<string, unknown> | null = null;
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () =>
      ({
        createSession(input) {
          persistedInput = input as unknown as Record<string, unknown>;
          return input as never;
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-directory",
    createSessionFilesDirectory: () => {
      throw new Error("directory workspace では SessionFolder を作成しない");
    },
    isSessionFilesWorkspace: () => false,
  });

  await facade.createSessionFromRequest(
    createSessionRequest({
      kind: "directory",
      label: "repo",
      path: "C:/work/repo",
      branch: "main",
    }) as never,
  );

  assert.deepEqual(
    {
      id: persistedInput?.id,
      workspaceLabel: persistedInput?.workspaceLabel,
      workspacePath: persistedInput?.workspacePath,
      branch: persistedInput?.branch,
    },
    {
      id: "launch-directory",
      workspaceLabel: "repo",
      workspacePath: "C:/work/repo",
      branch: "main",
    },
  );
});

// @test-value v2
// kind = "contract"
// claim = "Main Session作成はlaunch selectionのCodex speedとReviewerをPersistence Serviceへ渡し、IPC payloadで上書きさせない"
// oracle = { type = "contract", ref = "accepted behavior: new Session runtime selection inheritance" }
// fault = "IPC payloadのspeedまたはReviewerがlaunch selectionの値を上書きする、または解決値がPersistence Serviceへの入力から欠落する"
// observable = "Session persistence serviceへ渡された作成入力のcodexSpeedとcodexReviewer"
// observation_boundary = "public-boundary"
// scope = "main-session-create"
// lifecycle = "permanent"
// @end-test-value
test("MainSessionCommandFacade は IPC payload のMain-owned fieldsを無視する", async () => {
  let persistedInput: Record<string, unknown> | null = null;
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection({
      model: "gpt-5.6-pro",
      reasoningEffort: "xhigh",
      approvalMode: "on-request",
      codexSandboxMode: "read-only",
      codexSpeed: "fast",
      codexReviewer: "auto-review",
      customAgentName: "stored-agent",
    }),
    getSessionPersistenceService: () =>
      ({
        createSession(input) {
          persistedInput = input as unknown as Record<string, unknown>;
          return input as never;
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => {
      return "launch-directory";
    },
    createSessionFilesDirectory: () => {
      throw new Error("directory workspace では SessionFolder を作成しない");
    },
    isSessionFilesWorkspace: () => false,
  });
  const request = {
    ...createSessionRequest({
      kind: "directory",
      label: "repo",
      path: "C:/work/repo",
      branch: "main",
    }),
    id: "existing-session",
    workspaceLabel: "forged",
    workspacePath: "C:/forged",
    branch: "forged",
    model: "forged-model",
    reasoningEffort: "low",
    approvalMode: "never",
    codexSandboxMode: "danger-full-access",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "forged-agent",
  };

  await facade.createSessionFromRequest(request as never);

  assert.deepEqual(
    {
      id: persistedInput?.id,
      workspaceLabel: persistedInput?.workspaceLabel,
      workspacePath: persistedInput?.workspacePath,
      branch: persistedInput?.branch,
      model: persistedInput?.model,
      reasoningEffort: persistedInput?.reasoningEffort,
      approvalMode: persistedInput?.approvalMode,
      codexSandboxMode: persistedInput?.codexSandboxMode,
      codexSpeed: persistedInput?.codexSpeed,
      codexReviewer: persistedInput?.codexReviewer,
      customAgentName: persistedInput?.customAgentName,
    },
    {
      id: "launch-directory",
      workspaceLabel: "repo",
      workspacePath: "C:/work/repo",
      branch: "main",
      model: "gpt-5.6-pro",
      reasoningEffort: "xhigh",
      approvalMode: "on-request",
      codexSandboxMode: "read-only",
      codexSpeed: "fast",
      codexReviewer: "auto-review",
      customAgentName: "stored-agent",
    },
  );
});

test("MainSessionCommandFacade は起動設定の取得失敗時に ID 発行・SessionFolder 作成・永続化を行わない", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => {
      calls.push("resolve");
      throw new Error("latest selection read failed");
    },
    getSessionPersistenceService: () =>
      ({
        createSession() {
          calls.push("persist");
          throw new Error("should not persist");
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => {
      calls.push("issue-id");
      return "launch-managed";
    },
    createSessionFilesDirectory: () => {
      calls.push("mkdir");
      return "C:/WithMate/session-files/launch-managed";
    },
    isSessionFilesWorkspace: () => false,
  });

  await assert.rejects(
    facade.createSessionFromRequest(createSessionRequest({ kind: "session-folder" }) as never),
    /latest selection read failed/,
  );
  assert.deepEqual(calls, ["resolve"]);
});

test("MainSessionCommandFacade は SessionFolder 作成失敗時に session を永続化しない", async () => {
  let persistCount = 0;
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () =>
      ({
        createSession(input) {
          persistCount += 1;
          return input as never;
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-managed",
    createSessionFilesDirectory: () => {
      throw new Error("mkdir failed");
    },
    isSessionFilesWorkspace: () => false,
  });

  await assert.rejects(
    facade.createSessionFromRequest(createSessionRequest({ kind: "session-folder" }) as never),
    /mkdir failed/,
  );
  assert.equal(persistCount, 0);
});

test("MainSessionCommandFacade は session 永続化失敗後に作成済み SessionFolder を削除しない", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () =>
      ({
        createSession() {
          calls.push("persist");
          throw new Error("persist failed after commit");
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => {
      calls.push("issue-id");
      return "launch-managed";
    },
    createSessionFilesDirectory: () => {
      calls.push("mkdir");
      return "C:/WithMate/session-files/launch-managed";
    },
    isSessionFilesWorkspace: () => false,
    async cleanupSessionFilesDirectory() {
      calls.push("cleanup");
    },
  });

  await assert.rejects(
    facade.createSessionFromRequest(createSessionRequest({ kind: "session-folder" }) as never),
    /persist failed after commit/,
  );
  assert.deepEqual(calls, ["issue-id", "mkdir", "persist"]);
});

test("MainSessionCommandFacade は cutoff delete の削除済み session だけ cleanup する", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [{ id: "s-old", workspacePath: "C:/work/repo" } as never],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () =>
      ({
        deleteSessionsLastActiveBefore(cutoff) {
          calls.push(`delete-before:${cutoff.cutoffDate}`);
          return {
            cutoffDate: cutoff.cutoffDate,
            cutoffTimestampMs: cutoff.cutoffTimestampMs,
            deletedSessionIds: ["s-old"],
            skippedRunningSessionIds: ["s-running"],
          };
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
    dismissSessionTurnNotification(sessionId) {
      calls.push(`dismiss-notification:${sessionId}`);
    },
    async cleanupSessionFilesDirectory(sessionId) {
      calls.push(`cleanup-files:${sessionId}`);
    },
  });

  const result = await facade.deleteSessionsLastActiveBefore({ cutoffDate: "2026-07-01" });

  assert.deepEqual(result.deletedSessionIds, ["s-old"]);
  assert.deepEqual(result.skippedRunningSessionIds, ["s-running"]);
  assert.deepEqual(calls, [
    "delete-before:2026-07-01",
    "dismiss-notification:s-old",
    "cleanup-files:s-old",
  ]);
});

test("MainSessionCommandFacade は cached/uncached の SessionFolder を保持し directory workspace だけ cleanup する", async () => {
  const dismissedSessionIds: string[] = [];
  const cleanedSessionIds: string[] = [];
  const cachedManagedSession = {
    id: "s-cached-managed",
    workspacePath: "C:/WithMate/session-files/s-cached-managed",
  } as never;
  const cachedDirectorySession = {
    id: "s-cached-directory",
    workspacePath: "C:/work/cached",
  } as never;
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [cachedManagedSession, cachedDirectorySession],
    getStoredSessionSummaries: () => [
      cachedManagedSession,
      cachedDirectorySession,
      {
        id: "s-uncached-managed",
        workspacePath: "C:/WithMate/session-files/s-uncached-managed",
      } as never,
      {
        id: "s-uncached-directory",
        workspacePath: "C:/work/uncached",
      } as never,
    ],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () =>
      ({
        deleteSessionsLastActiveBefore() {
          return {
            deletedSessionIds: [
              "s-cached-managed",
              "s-cached-directory",
              "s-uncached-managed",
              "s-uncached-directory",
            ],
            skippedRunningSessionIds: [],
          };
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: (session) => session.id.endsWith("-managed"),
    dismissSessionTurnNotification(sessionId) {
      dismissedSessionIds.push(sessionId);
    },
    async cleanupSessionFilesDirectory(sessionId) {
      cleanedSessionIds.push(sessionId);
    },
  });

  await facade.deleteSessionsLastActiveBefore({ cutoffDate: "2026-07-01" });

  assert.deepEqual(dismissedSessionIds, [
    "s-cached-managed",
    "s-cached-directory",
    "s-uncached-managed",
    "s-uncached-directory",
  ]);
  assert.deepEqual(cleanedSessionIds, [
    "s-cached-directory",
    "s-uncached-directory",
  ]);
});

test("MainSessionCommandFacade は directory cleanup が失敗しても削除済み Session の通知をすべて先に閉じる", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [
      {
        id: "s-first",
        workspacePath: "C:/work/first",
      } as never,
      {
        id: "s-second",
        workspacePath: "C:/work/second",
      } as never,
    ],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () =>
      ({
        deleteSessionsLastActiveBefore() {
          calls.push("delete-before");
          return {
            deletedSessionIds: ["s-first", "s-second"],
            skippedRunningSessionIds: [],
          };
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
    dismissSessionTurnNotification(sessionId) {
      calls.push(`dismiss-notification:${sessionId}`);
    },
    async cleanupSessionFilesDirectory(sessionId) {
      calls.push(`cleanup-files:${sessionId}`);
      if (sessionId === "s-first") {
        throw new Error("cleanup failed");
      }
    },
  });

  await assert.rejects(
    facade.deleteSessionsLastActiveBefore({ cutoffDate: "2026-07-01" }),
    /cleanup failed/,
  );
  assert.deepEqual(calls, [
    "delete-before",
    "dismiss-notification:s-first",
    "dismiss-notification:s-second",
    "cleanup-files:s-first",
  ]);
});

test("MainSessionCommandFacade は実在しない cutoff delete 日付を拒否する", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () =>
      ({
        deleteSessionsLastActiveBefore() {
          calls.push("delete-old");
          return {
            deletedSessionIds: ["s-old"],
            skippedRunningSessionIds: [],
          };
        },
      }) as never,
    getSessionRuntimeService: () => ({} as never),
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
    async cleanupSessionFilesDirectory(sessionId) {
      calls.push(`cleanup-files:${sessionId}`);
    },
  });

  await assert.rejects(
    facade.deleteSessionsLastActiveBefore({ cutoffDate: "2026-02-31" }),
    /削除基準日を解釈できないよ。/,
  );
  assert.deepEqual(calls, []);
});

test("MainSessionCommandFacade は stale な Copilot quota を非同期更新して run を委譲する", async () => {
  const calls: string[] = [];
  let refreshedProviderId: string | null = null;
  const facade = createMainSessionCommandFacade({
    getSession: () => ({ id: "s-1", provider: "copilot" }) as never,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () => ({} as never),
    getSessionRuntimeService: () =>
      ({
        async runSessionTurn(sessionId) {
          calls.push(`run:${sessionId}`);
          return { id: sessionId } as never;
        },
        isRunInFlight() {
          return false;
        },
      }) as never,
    getProviderQuotaTelemetry: () => ({ providerId: "copilot", updatedAt: "old" } as never),
    isProviderQuotaTelemetryStale: () => true,
    refreshProviderQuotaTelemetry: async (providerId) => {
      refreshedProviderId = providerId;
      return null;
    },
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
  });

  const result = await facade.runSessionTurn("s-1", { userMessage: "hello" } as never);

  assert.equal(result.id, "s-1");
  assert.equal(refreshedProviderId, "copilot");
  assert.deepEqual(calls, ["run:s-1"]);
});

test("MainSessionCommandFacade は non-Copilot session では quota refresh を行わない", async () => {
  let refreshed = false;
  const facade = createMainSessionCommandFacade({
    getSession: () => ({ id: "s-1", provider: "codex" }) as never,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () => ({} as never),
    getSessionRuntimeService: () =>
      ({
        async runSessionTurn(sessionId) {
          return { id: sessionId } as never;
        },
        isRunInFlight() {
          return false;
        },
      }) as never,
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => true,
    refreshProviderQuotaTelemetry: async () => {
      refreshed = true;
      return null;
    },
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
  });

  await facade.runSessionTurn("s-1", { userMessage: "hello" } as never);

  assert.equal(refreshed, false);
});

test("MainSessionCommandFacade は Workspace が利用不可なら provider runtime の前で送信を拒否する", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    getSession: () => ({ id: "s-1", provider: "codex", workspacePath: "C:/missing" }) as never,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () => ({} as never),
    getSessionRuntimeService: () =>
      ({
        async runSessionTurn() {
          calls.push("run");
          return { id: "s-1" } as never;
        },
      }) as never,
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
    validateWorkspaceDirectory: async (targetPath) => {
      calls.push(`validate:${String(targetPath)}`);
      return { valid: false, reason: "missing" };
    },
  });

  await assert.rejects(
    facade.runSessionTurn("s-1", { userMessage: "hello" } as never),
    /Workspace is unavailable\. Path not found\./,
  );
  assert.deepEqual(calls, ["validate:C:/missing"]);
});

