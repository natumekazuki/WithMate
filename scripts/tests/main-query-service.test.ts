import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CHARACTER_SESSION_COPY, type CharacterProfile, type Session } from "../../src/app-state.js";
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
    approvalMode: "provider-controlled",
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

test("MainQueryService は session skills/custom agents と preview/search/terminal を解決する", async () => {
  const calls: string[] = [];
  const sourceSessions = [
    createSession(),
    createSession({ id: "session-2", provider: "copilot", workspacePath: "C:/copilot" }),
  ];
  const service = new MainQueryService({
    getSessions: () => sourceSessions,
    getCharacters: () => [createCharacter()],
    getAuditLogs: () => [],
    getAppSettings: () =>
      ({
        providers: {},
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    discoverSessionSkills(workspacePath) {
      calls.push(`skills:${workspacePath}`);
      return [];
    },
    discoverSessionCustomAgents(workspacePath) {
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
      return ["a.ts"];
    },
    async launchTerminalAtPath(workspacePath) {
      calls.push(`terminal:${workspacePath}`);
    },
  });

  assert.equal(service.listSessions().length, 2);
  assert.equal(service.listCharacters().length, 1);
  const session = service.getSession("session-1");
  assert.notEqual(session, sourceSessions[0]);
  assert.equal(session?.workspacePath, "C:/workspace");
  service.listSessionSkills("session-1");
  service.listSessionCustomAgents("session-2");
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
});

test("MainQueryService は path 参照なし draft の preview を早期 return する", async () => {
  let getSessionsCalls = 0;
  const service = new MainQueryService({
    getSessions: () => {
      getSessionsCalls += 1;
      return [createSession()];
    },
    getCharacters: () => [createCharacter()],
    getAuditLogs: () => [],
    getAppSettings: () =>
      ({
        providers: {},
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    discoverSessionSkills: () => [],
    discoverSessionCustomAgents: () => [],
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
  assert.equal(getSessionsCalls, 0);
});

test("MainQueryService は対象 session だけを clone して返す", () => {
  const targetSession = createSession();
  const untouchedSession = {
    ...createSession({ id: "session-2" }),
    toJSON() {
      throw new Error("非対象 session の clone は不要");
    },
  } as Session;
  const service = new MainQueryService({
    getSessions: () => [targetSession, untouchedSession],
    getCharacters: () => [createCharacter()],
    getAuditLogs: () => [],
    getAppSettings: () =>
      ({
        providers: {},
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    discoverSessionSkills: () => [],
    discoverSessionCustomAgents: () => [],
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

  const session = service.getSession("session-1");
  assert.notEqual(session, targetSession);
  assert.equal(session?.id, "session-1");
});
