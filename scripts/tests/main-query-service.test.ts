import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CHARACTER_SESSION_COPY, type CharacterProfile, type Session, type SessionSummary } from "../../src/app-state.js";
import { MainQueryService } from "../../src-electron/main-query-service.js";

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: "session-1",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "high",
    taskTitle: "task",
    taskSummary: "",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    sessionKind: "default",
    characterId: "char-1",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#111", sub: "#222" },
    approvalMode: "on-request",
    customAgentName: "",
    status: "idle",
    runState: "idle",
    threadId: "",
    updatedAt: "2026-03-28T00:00:00.000Z",
    messages: [],
    stream: [],
    allowedAdditionalDirectories: [],
    ...overrides,
  };
}

function createCharacter(): CharacterProfile {
  return {
    id: "char-1",
    name: "A",
    iconPath: "",
    roleMarkdown: "",
    notesMarkdown: "",
    description: "",
    themeColors: { main: "#111", sub: "#222" },
    sessionCopy: DEFAULT_CHARACTER_SESSION_COPY,
    updatedAt: "2026-03-28T00:00:00.000Z",
  };
}

function createSessionSummary(overrides?: Partial<SessionSummary>): SessionSummary {
  const session = createSession(overrides);
  const { messages: _messages, stream: _stream, ...summary } = session;
  return summary;
}

test("MainQueryService は session skills/custom agents と preview/search/terminal を解決する", async () => {
  const calls: string[] = [];
  const sourceSessions = [
    createSession(),
    createSession({ id: "session-2", provider: "copilot", workspacePath: "C:/copilot" }),
  ];
  const fullSessionRequests: string[] = [];
  const service = new MainQueryService({
    getSessionSummaries: () => sourceSessions.map((session) => createSessionSummary(session)),
    getSession: (sessionId) => {
      fullSessionRequests.push(sessionId);
      return sourceSessions.find((session) => session.id === sessionId) ?? null;
    },
    getSessionMessageArtifact: () => null,
    getCharacters: () => [createCharacter()],
    getAuditLogs: () => [],
    getAuditLogSummaries: () => [],
    getAuditLogSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false, total: 0 }),
    getAuditLogDetail: () => null,
    getAuditLogDetailSection: () => null,
    getAuditLogOperationDetail: () => null,
    getAppSettings: () =>
      ({
        providers: {},
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    async discoverSessionSkills(workspacePath) {
      calls.push(`skills:${workspacePath}`);
      return [];
    },
    async discoverSessionCustomAgents(workspacePath) {
      calls.push(`agents:${workspacePath}`);
      return [];
    },
    async getStoredCharacter() {
      return createCharacter();
    },
    async refreshCharactersFromStorage() {
      calls.push("refresh");
      return [createCharacter()];
    },
    async resolveComposerPreview(session, userMessage) {
      calls.push(`preview:${session.id}:${userMessage}`);
      return { attachments: [], errors: [] };
    },
    async searchWorkspaceFiles(workspacePath, query) {
      calls.push(`search:${workspacePath}:${query}`);
      return [{ path: "a.ts", kind: "file" }];
    },
    async launchTerminalAtPath(workspacePath) {
      calls.push(`terminal:${workspacePath}`);
    },
  });

  assert.equal((await service.listSessionSummaries()).length, 2);
  assert.equal((await service.listCharacters()).length, 1);
  const session = await service.getSession("session-1");
  assert.notEqual(session, sourceSessions[0]);
  assert.equal(session?.workspacePath, "C:/workspace");
  await service.listSessionSkills("session-1");
  await service.listSessionCustomAgents("session-2");
  await service.refreshCharactersFromStorage();
  await service.previewComposerInput("session-1", "@src/main.ts");
  await service.searchWorkspaceFiles("session-1", "main");
  await service.openSessionTerminal("session-1");

  assert.deepEqual(calls, [
    "skills:C:/workspace",
    "agents:C:/copilot",
    "refresh",
    "preview:session-1:@src/main.ts",
    "search:C:/workspace:main",
    "terminal:C:/workspace",
  ]);
  assert.deepEqual(fullSessionRequests, ["session-1"]);
});

test("MainQueryService は path 参照なし draft の preview を早期 return する", async () => {
  let getSessionSummariesCalls = 0;
  const service = new MainQueryService({
    getSessionSummaries: () => {
      getSessionSummariesCalls += 1;
      return [createSessionSummary()];
    },
    getSession: () => createSession(),
    getSessionMessageArtifact: () => null,
    getCharacters: () => [createCharacter()],
    getAuditLogs: () => [],
    getAuditLogSummaries: () => [],
    getAuditLogSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false, total: 0 }),
    getAuditLogDetail: () => null,
    getAuditLogDetailSection: () => null,
    getAuditLogOperationDetail: () => null,
    getAppSettings: () =>
      ({
        providers: {},
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    discoverSessionSkills: async () => [],
    discoverSessionCustomAgents: async () => [],
    async getStoredCharacter() {
      return createCharacter();
    },
    async refreshCharactersFromStorage() {
      return [createCharacter()];
    },
    async resolveComposerPreview() {
      throw new Error("path 参照なしでは preview 解決まで進まないはず");
    },
    async searchWorkspaceFiles() {
      return [];
    },
    async launchTerminalAtPath() {},
  });

  const preview = await service.previewComposerInput("session-1", "hello");
  assert.deepEqual(preview, { attachments: [], errors: [] });
  assert.equal(getSessionSummariesCalls, 0);
});

test("MainQueryService は一覧を summary に射影して detail payload を含めない", async () => {
  const service = new MainQueryService({
    getSessionSummaries: () => [createSessionSummary()],
    getSession: () => createSession(),
    getSessionMessageArtifact: () => null,
    getCharacters: () => [createCharacter()],
    getAuditLogs: () => [],
    getAuditLogSummaries: () => [],
    getAuditLogSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false, total: 0 }),
    getAuditLogDetail: () => null,
    getAuditLogDetailSection: () => null,
    getAuditLogOperationDetail: () => null,
    getAppSettings: () =>
      ({
        providers: {},
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    discoverSessionSkills: async () => [],
    discoverSessionCustomAgents: async () => [],
    async getStoredCharacter() {
      return createCharacter();
    },
    async refreshCharactersFromStorage() {
      return [createCharacter()];
    },
    async resolveComposerPreview() {
      return { attachments: [], errors: [] };
    },
    async searchWorkspaceFiles() {
      return [];
    },
    async launchTerminalAtPath() {},
  });

  const summaries = await service.listSessionSummaries();
  assert.deepEqual(Object.keys(summaries[0] ?? {}).includes("messages"), false);
  assert.deepEqual(Object.keys(summaries[0] ?? {}).includes("stream"), false);
});

test("MainQueryService は対象 session detail だけを clone して返す", async () => {
  const targetSession = createSession();
  let requestedSessionId: string | null = null;
  const service = new MainQueryService({
    getSessionSummaries: () => [createSessionSummary(targetSession)],
    getSession: (sessionId) => {
      requestedSessionId = sessionId;
      return sessionId === targetSession.id ? targetSession : null;
    },
    getSessionMessageArtifact: () => null,
    getCharacters: () => [createCharacter()],
    getAuditLogs: () => [],
    getAuditLogSummaries: () => [],
    getAuditLogSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false, total: 0 }),
    getAuditLogDetail: () => null,
    getAuditLogDetailSection: () => null,
    getAuditLogOperationDetail: () => null,
    getAppSettings: () =>
      ({
        providers: {},
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    discoverSessionSkills: async () => [],
    discoverSessionCustomAgents: async () => [],
    async getStoredCharacter() {
      return createCharacter();
    },
    async refreshCharactersFromStorage() {
      return [createCharacter()];
    },
    async resolveComposerPreview() {
      return { attachments: [], errors: [] };
    },
    async searchWorkspaceFiles() {
      return [];
    },
    async launchTerminalAtPath() {},
  });

  const session = await service.getSession("session-1");
  assert.notEqual(session, targetSession);
  assert.equal(session?.id, "session-1");
  assert.equal(requestedSessionId, "session-1");
});

