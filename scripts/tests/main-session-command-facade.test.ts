import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import { MainSessionCommandFacade } from "../../src-electron/main-session-command-facade.js";
import { resolveComposerPreview } from "../../src-electron/composer-attachments.js";
import { SessionTurnValidationError } from "../../src-electron/session-turn-validation-error.js";
import { SessionExecutionQueueFullError } from "../../src-electron/session-execution-storage-v6.js";
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
    | "dismissSessionTurnNotification"
    | "cancelSessionRun"
    | "validateWorkspaceDirectory"
    | "getSessionExecutionService"
  >
  & Partial<Pick<
    ConstructorParameters<typeof MainSessionCommandFacade>[0],
    | "dismissSessionTurnNotification"
    | "cancelSessionRun"
    | "validateWorkspaceDirectory"
    | "getSessionExecutionService"
  >>;

function createMainSessionCommandFacade(
  deps: MainSessionCommandFacadeTestDeps,
): MainSessionCommandFacade {
  return new MainSessionCommandFacade({
    dismissSessionTurnNotification: () => undefined,
    cancelSessionRun: (sessionId) => deps.getSessionRuntimeService().cancelRun(sessionId),
    validateWorkspaceDirectory: async () => ({ valid: true }),
    getSessionExecutionService: () => ({
      async enqueue() { throw new Error("unused"); },
      getRecord() { throw new Error("unused"); },
      listRecords() { return []; },
      async cancel() { throw new Error("unused"); },
    }) as never,
    ...deps,
  });
}

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
          calls.push(`runtime-cancel:${sessionId}`);
        },
        isRunInFlight() {
          return false;
        },
      }) as never,
    cancelSessionRun(sessionId) {
      calls.push(`cancel:${sessionId}`);
    },
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

test("Session 作成中は Settings 更新を同じ runtime 選択境界の完了まで待機させる", async () => {
  const coordinator = new ProviderRuntimeOperationCoordinator();
  const runExclusive: RunProviderRuntimeOperationExclusive =
    (operation) => coordinator.runExclusive(operation);
  const folderEntered = createDeferred();
  const releaseFolder = createDeferred();
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
        createSession(input) {
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

  await Promise.resolve();
  assert.deepEqual(events, [
    "selection:resolve",
    "folder:start",
  ]);

  releaseFolder.resolve();
  await Promise.all([createPromise, settingsPromise]);

  assert.deepEqual(events, [
    "selection:resolve",
    "folder:start",
    "folder:end",
    "session:persist",
    "settings:update",
    "settings:broadcast",
  ]);
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

test("MainSessionCommandFacade は IPC payload の余分な session ID と legacy workspace fields を無視する", async () => {
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

test("MainSessionCommandFacade は GUI run の成功後にSession queueを再開する", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    getSession: () => ({ id: "s-1", provider: "codex" }) as never,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () => ({} as never),
    getSessionRuntimeService: () => ({
      async runSessionTurn(sessionId: string) {
        calls.push(`run:${sessionId}`);
        return { id: sessionId } as never;
      },
    }) as never,
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
    resumeSessionExecutionQueue(sessionId) {
      calls.push(`resume:${sessionId}`);
    },
  });

  await facade.runSessionTurn("s-1", { userMessage: "hello" });

  assert.deepEqual(calls, ["run:s-1", "resume:s-1"]);
});

test("MainSessionCommandFacade は GUI run の失敗後もSession queueを再開する", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    getSession: () => ({ id: "s-1", provider: "codex" }) as never,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () => ({} as never),
    getSessionRuntimeService: () => ({
      async runSessionTurn() {
        calls.push("run");
        throw new Error("run failed");
      },
    }) as never,
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
    resumeSessionExecutionQueue(sessionId) {
      calls.push(`resume:${sessionId}`);
    },
  });

  await assert.rejects(
    facade.runSessionTurn("s-1", { userMessage: "hello" }),
    /run failed/,
  );
  assert.deepEqual(calls, ["run", "resume:s-1"]);
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
    getSessionRuntimeService: () => ({
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

test("MainSessionCommandFacade はGUI送信をrunStateに関係なく同じ永続enqueueへ渡す", async () => {
  const calls: Array<{ sessionId: string; idempotencyKey: string; request: unknown }> = [];
  let record: any = null;
  const facade = createMainSessionCommandFacade({
    getSession: () => ({ id: "s-1", provider: "codex", runState: "running" }) as never,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () => ({} as never),
    getSessionRuntimeService: () => ({} as never),
    getSessionExecutionService: () => ({
      async enqueue(input: any) {
        calls.push(input);
        record = {
          id: "execution-1",
          sessionId: input.sessionId,
          operation: "turn.enqueue",
          state: "queued",
          result: null,
          errorCode: "",
          reason: "",
          sequence: 4,
          request: input.request,
          createdAt: "2026-08-16T00:00:00.000Z",
          admittedAt: null,
          completedAt: null,
          updatedAt: "2026-08-16T00:00:00.000Z",
        };
        return record;
      },
      getRecord() { return record; },
      listRecords() { return record ? [record] : []; },
      async cancel() { throw new Error("unused"); },
    }) as never,
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
  });

  const result = await facade.enqueueSessionTurn("s-1", {
    userMessage: "次の依頼",
    clientRequestId: "11111111-1111-4111-8111-111111111111",
    model: "gpt-5.6",
    reasoningEffort: "high",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write",
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.sessionId, "s-1");
  assert.equal(calls[0]?.idempotencyKey, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(calls[0]?.request, {
    initiator: { kind: "user" },
    turn: {
      userMessage: "次の依頼",
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      model: "gpt-5.6",
      reasoningEffort: "high",
      approvalMode: "untrusted",
      codexSandboxMode: "workspace-write",
    },
  });
  if (result.ok) {
    assert.equal(result.execution?.userMessage, "次の依頼");
    assert.equal(result.execution?.queuePosition, 1);
  }
});

test("MainSessionCommandFacade はQUEUE_FULLを副作用なしのGUI admission errorへ写す", async () => {
  const facade = createMainSessionCommandFacade({
    getSession: () => ({ id: "s-1", provider: "codex" }) as never,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () => ({} as never),
    getSessionRuntimeService: () => ({} as never),
    getSessionExecutionService: () => ({
      async enqueue() { throw new SessionExecutionQueueFullError("s-1"); },
      getRecord() { throw new Error("unused"); },
      listRecords() { return []; },
      async cancel() { throw new Error("unused"); },
    }) as never,
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
  });

  const result = await facade.enqueueSessionTurn("s-1", {
    userMessage: "11件目",
    clientRequestId: "22222222-2222-4222-8222-222222222222",
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "QUEUE_FULL",
      message: "このSessionは待機中のTurnが10件に達しています。",
      retryable: true,
    },
  });
});

test("MainSessionCommandFacade はuser/session/legacyのactive executionをFIFO順で公開する", () => {
  const records = [
    {
      id: "gui-running",
      sessionId: "s-1",
      state: "running",
      request: {
        initiator: { kind: "user" },
        turn: { userMessage: "running GUI request", clientRequestId: "gui-running-request" },
      },
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    },
    {
      id: "session-1",
      sessionId: "s-1",
      state: "queued",
      request: {
        initiator: {
          kind: "session",
          sessionId: "actor-b",
          character: {
            characterId: "character-b",
            name: "Character B",
            iconFilePath: "C:/characters/b.png",
          },
        },
        catalogRevision: 3,
        turn: { provider: "codex", userMessage: "session request" },
      },
      createdAt: "2026-08-16T00:00:00.500Z",
      updatedAt: "2026-08-16T00:00:00.500Z",
    },
    {
      id: "external-1",
      sessionId: "s-1",
      state: "queued",
      request: {
        catalogRevision: 3,
        turn: { provider: "codex", userMessage: "external request" },
      },
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    },
    {
      id: "gui-1",
      sessionId: "s-1",
      state: "queued",
      request: {
        initiator: { kind: "user" },
        turn: { userMessage: "GUI request", clientRequestId: "gui-request-1" },
      },
      createdAt: "2026-08-16T00:00:01.000Z",
      updatedAt: "2026-08-16T00:00:01.000Z",
    },
  ];
  const facade = createMainSessionCommandFacade({
    getSession: () => ({ id: "s-1", provider: "codex" }) as never,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () => ({} as never),
    getSessionRuntimeService: () => ({} as never),
    getSessionExecutionService: () => ({
      async enqueue() { throw new Error("unused"); },
      getRecord() { throw new Error("unused"); },
      listRecords() { return records; },
      async cancel() { throw new Error("unused"); },
    }) as never,
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
  });

  assert.deepEqual(facade.listSessionTurnExecutions("s-1"), [
    {
      executionId: "gui-running",
      sessionId: "s-1",
      clientRequestId: "gui-running-request",
      userMessage: "running GUI request",
      initiator: { kind: "user" },
      state: "running",
      queuePosition: null,
      canCancel: false,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    },
    {
      executionId: "session-1",
      sessionId: "s-1",
      clientRequestId: null,
      userMessage: "session request",
      initiator: {
        kind: "session",
        sessionId: "actor-b",
        character: {
          characterId: "character-b",
          name: "Character B",
          iconFilePath: "C:/characters/b.png",
        },
      },
      state: "queued",
      queuePosition: 1,
      canCancel: false,
      createdAt: "2026-08-16T00:00:00.500Z",
      updatedAt: "2026-08-16T00:00:00.500Z",
    },
    {
      executionId: "external-1",
      sessionId: "s-1",
      clientRequestId: null,
      userMessage: "external request",
      initiator: null,
      state: "queued",
      queuePosition: 2,
      canCancel: false,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    },
    {
      executionId: "gui-1",
      sessionId: "s-1",
      clientRequestId: "gui-request-1",
      userMessage: "GUI request",
      initiator: { kind: "user" },
      state: "queued",
      queuePosition: 3,
      canCancel: true,
      createdAt: "2026-08-16T00:00:01.000Z",
      updatedAt: "2026-08-16T00:00:01.000Z",
    },
  ]);
});

test("MainSessionCommandFacade はqueued cancelをqueued限定条件でexecution ownerへ渡す", async () => {
  const cancelCalls: unknown[] = [];
  const facade = createMainSessionCommandFacade({
    getSession: () => ({ id: "s-1", provider: "codex" }) as never,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () => ({} as never),
    getSessionRuntimeService: () => ({} as never),
    getSessionExecutionService: () => ({
      async enqueue() { throw new Error("unused"); },
      getRecord() {
        return {
          id: "gui-1",
          sessionId: "s-1",
          state: "queued",
          request: { initiator: { kind: "user" }, turn: { userMessage: "GUI request" } },
        };
      },
      listRecords() { return []; },
      async cancel(input: unknown) { cancelCalls.push(input); },
    }) as never,
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
  });

  const result = await facade.cancelSessionExecution("s-1", {
    executionId: "gui-1",
    clientRequestId: "cancel-gui-1",
  });

  assert.deepEqual(result, { ok: true });
  assert.equal((cancelCalls[0] as { expectedState?: string }).expectedState, "queued");
});

test("ID-03: Session由来とlegacy queued executionをGUI cancelへ渡さない", async () => {
  for (const request of [
    {
      initiator: {
        kind: "session",
        sessionId: "session-actor",
        character: { characterId: "character-actor", name: "Actor", iconFilePath: "" },
      },
      catalogRevision: 4,
      turn: { provider: "codex", userMessage: "Session request" },
    },
    {
      catalogRevision: 4,
      turn: { provider: "codex", userMessage: "Legacy request" },
    },
  ]) {
    let cancelInvoked = false;
    const facade = createMainSessionCommandFacade({
      getSession: () => ({ id: "s-1", provider: "codex" }) as never,
      getSessions: () => [],
      getStoredSessionSummaries: () => [],
      runProviderRuntimeOperationExclusive,
      resolveSessionLaunchSelection: async () => createLaunchSelection(),
      getSessionPersistenceService: () => ({} as never),
      getSessionRuntimeService: () => ({} as never),
      getSessionExecutionService: () => ({
        getRecord: () => ({ id: "execution-1", sessionId: "s-1", state: "queued", request }),
        listRecords: () => [],
        async enqueue() { throw new Error("unused"); },
        async cancel() { cancelInvoked = true; throw new Error("must not cancel"); },
      }) as never,
      getProviderQuotaTelemetry: () => null,
      isProviderQuotaTelemetryStale: () => false,
      refreshProviderQuotaTelemetry: async () => null,
      createSessionId: () => "launch-test",
      createSessionFilesDirectory: () => "C:/session-files/launch-test",
      isSessionFilesWorkspace: () => false,
    });

    const result = await facade.cancelSessionExecution("s-1", {
      executionId: "execution-1",
      clientRequestId: "cancel-1",
    });
    assert.equal(result.ok, false);
    assert.equal(cancelInvoked, false);
  }
});

test("schedule enqueue replayはcurrent catalogとprovider再検証より先に解決する", async () => {
  let validationCalled = false;
  let enqueueCalled = false;
  const record = {
    id: "execution-schedule-1",
    sessionId: "s-1",
    state: "queued",
    request: {
      initiator: { kind: "user" },
      turn: { userMessage: "scheduled", clientRequestId: "schedule-key-1" },
    },
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
  const facade = createMainSessionCommandFacade({
    getSession: () => ({ id: "s-1", provider: "copilot" }) as never,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () => ({} as never),
    getSessionRuntimeService: () => ({
      async validateExternalSessionTurn() {
        validationCalled = true;
        throw new Error("provider changed");
      },
    }) as never,
    getSessionExecutionService: () => ({
      resolveReplay: () => ({ id: record.id }),
      listRecords: () => [record],
      async enqueue() {
        enqueueCalled = true;
        throw new Error("must not enqueue replay");
      },
    }) as never,
    getCurrentModelCatalogRevision: () => 8,
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
  });

  const result = await facade.enqueueScheduledSessionTurn("s-1", "codex", {
    userMessage: "scheduled",
    clientRequestId: "schedule-key-1",
    model: "gpt-5.6",
    reasoningEffort: "high",
    approvalMode: "never",
    codexSandboxMode: "workspace-write",
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.execution?.executionId : null, record.id);
  assert.equal(validationCalled, false);
  assert.equal(enqueueCalled, false);
});

test("schedule attachmentはordinary enqueue validationでcurrent additional-directory permissionを再検証する", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-schedule-attachment-"));
  const workspacePath = path.join(directory, "workspace");
  const additionalPath = path.join(directory, "additional");
  const attachmentPath = path.join(additionalPath, "evidence.txt");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(additionalPath, { recursive: true });
  await writeFile(attachmentPath, "evidence", "utf8");

  let allowedAdditionalDirectories = [additionalPath];
  type ScheduledExecutionRecord = {
    id: string;
    sessionId: string;
    state: "queued";
    request: {
      initiator: { kind: "user" };
      turn: { userMessage: string; clientRequestId: string };
    };
    createdAt: string;
    updatedAt: string;
  };
  const records: ScheduledExecutionRecord[] = [];
  let durableEffects = 0;
  const executionService = {
    resolveReplay: () => null,
    listRecords: () => records,
    async enqueue(input: { sessionId: string; request: unknown }) {
      const request = input.request as {
        initiator: { kind: "user" };
        turn: { userMessage: string; clientRequestId: string };
      };
      const preview = await resolveComposerPreview(
        { workspacePath, allowedAdditionalDirectories },
        request.turn.userMessage,
      );
      if (preview.errors.length > 0) {
        throw new SessionTurnValidationError(
          "INVALID_INPUT",
          preview.errors[0] ?? "attachment validation failed",
        );
      }
      durableEffects += 1;
      const record = {
        id: `execution-${durableEffects}`,
        sessionId: input.sessionId,
        state: "queued",
        request,
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      };
      records.push(record);
      return { id: record.id };
    },
  };
  const facade = createMainSessionCommandFacade({
    getSession: () => ({ id: "s-1", provider: "codex" }) as never,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    getSessionPersistenceService: () => ({} as never),
    getSessionRuntimeService: () => ({
      async validateExternalSessionTurn() {
        return undefined;
      },
    }) as never,
    getSessionExecutionService: () => executionService as never,
    getCurrentModelCatalogRevision: () => 8,
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
    createSessionId: () => "launch-test",
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    isSessionFilesWorkspace: () => false,
  });
  try {
    const valid = await facade.enqueueScheduledSessionTurn("s-1", "codex", {
      userMessage: `review @"${attachmentPath}"`,
      clientRequestId: "schedule-attachment-valid",
      model: "gpt-5.6",
      reasoningEffort: "high",
      approvalMode: "never",
      codexSandboxMode: "workspace-write",
    });
    assert.equal(valid.ok, true);
    assert.equal(durableEffects, 1);
    assert.match(
      (records[0]?.request as { turn: { userMessage: string } }).turn.userMessage,
      /evidence\.txt/,
    );

    allowedAdditionalDirectories = [];
    const rejected = await facade.enqueueScheduledSessionTurn("s-1", "codex", {
      userMessage: `review @"${attachmentPath}"`,
      clientRequestId: "schedule-attachment-rejected",
      model: "gpt-5.6",
      reasoningEffort: "high",
      approvalMode: "never",
      codexSandboxMode: "workspace-write",
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.ok ? null : rejected.error.code, "INVALID_INPUT");
    assert.equal(durableEffects, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

