import assert from "node:assert/strict";
import test from "node:test";

import { MainSessionCommandFacade } from "../../src-electron/main-session-command-facade.js";

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

test("MainSessionCommandFacade は create/update/delete/cancel を各 service に委譲する", async () => {
  const calls: string[] = [];
  const facade = new MainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [{ id: "s-1", workspacePath: "C:/work/repo" } as never],
    getStoredSessionSummaries: () => [],
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
  await facade.deleteSession("s-1");
  facade.cancelSessionRun("s-1");

  assert.deepEqual(calls, [
    "create:launch-test",
    "update:s-1",
    "delete:s-1",
    "cleanup-files:s-1",
    "cancel:s-1",
  ]);
});

test("MainSessionCommandFacade は SessionFolder を作成してから同じ ID の session を永続化する", async () => {
  const calls: string[] = [];
  let persistedInput: Record<string, unknown> | null = null;
  const facade = new MainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
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
    },
    {
      id: "launch-managed",
      workspaceLabel: "SessionFolder",
      workspacePath: "C:/WithMate/session-files/launch-managed",
      branch: "",
      workspace: undefined,
    },
  );
});

test("MainSessionCommandFacade は Browse で選んだ directory をそのまま session に使う", async () => {
  let persistedInput: Record<string, unknown> | null = null;
  const facade = new MainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
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
  const facade = new MainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
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
  };

  await facade.createSessionFromRequest(request as never);

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

test("MainSessionCommandFacade は SessionFolder 作成失敗時に session を永続化しない", async () => {
  let persistCount = 0;
  const facade = new MainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
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
  const facade = new MainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
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
  const facade = new MainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [{ id: "s-old", workspacePath: "C:/work/repo" } as never],
    getStoredSessionSummaries: () => [],
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
    async cleanupSessionFilesDirectory(sessionId) {
      calls.push(`cleanup-files:${sessionId}`);
    },
  });

  const result = await facade.deleteSessionsLastActiveBefore({ cutoffDate: "2026-07-01" });

  assert.deepEqual(result.deletedSessionIds, ["s-old"]);
  assert.deepEqual(result.skippedRunningSessionIds, ["s-running"]);
  assert.deepEqual(calls, [
    "delete-before:2026-07-01",
    "cleanup-files:s-old",
  ]);
});

test("MainSessionCommandFacade は cached/uncached の SessionFolder を保持し directory workspace だけ cleanup する", async () => {
  const cleanedSessionIds: string[] = [];
  const cachedManagedSession = {
    id: "s-cached-managed",
    workspacePath: "C:/WithMate/session-files/s-cached-managed",
  } as never;
  const cachedDirectorySession = {
    id: "s-cached-directory",
    workspacePath: "C:/work/cached",
  } as never;
  const facade = new MainSessionCommandFacade({
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
    async cleanupSessionFilesDirectory(sessionId) {
      cleanedSessionIds.push(sessionId);
    },
  });

  await facade.deleteSessionsLastActiveBefore({ cutoffDate: "2026-07-01" });

  assert.deepEqual(cleanedSessionIds, [
    "s-cached-directory",
    "s-uncached-directory",
  ]);
});

test("MainSessionCommandFacade は実在しない cutoff delete 日付を拒否する", async () => {
  const calls: string[] = [];
  const facade = new MainSessionCommandFacade({
    getSession: () => null,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
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
  const facade = new MainSessionCommandFacade({
    getSession: () => ({ id: "s-1", provider: "copilot" }) as never,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
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
  const facade = new MainSessionCommandFacade({
    getSession: () => ({ id: "s-1", provider: "codex" }) as never,
    getSessions: () => [],
    getStoredSessionSummaries: () => [],
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

