import assert from "node:assert/strict";
import test from "node:test";

import type { CharacterProfile, Session } from "../../src/app-state.js";
import { MainQueryService } from "../../src-electron/main-query-service.js";

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: "session-1",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "high",
    taskTitle: "task",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    characterId: "char-1",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#111", sub: "#222" },
    approvalMode: "provider-controlled",
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
    sessionCopy: {
      pendingApproval: [],
      pendingWorking: [],
      pendingResponding: [],
      pendingPreparing: [],
      retryInterruptedTitle: [],
      retryFailedTitle: [],
      retryCanceledTitle: [],
      latestCommandWaiting: [],
      latestCommandEmpty: [],
      changedFilesEmpty: [],
      contextEmpty: [],
    },
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:00:00.000Z",
  };
}

test("MainQueryService は session skills/custom agents と preview/search/terminal を解決する", async () => {
  const calls: string[] = [];
  const service = new MainQueryService({
    getSessions: () => [createSession(), createSession({ id: "session-2", provider: "copilot", workspacePath: "C:/copilot" })],
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
  service.listSessionSkills("session-1");
  service.listSessionCustomAgents("session-2");
  await service.refreshCharactersFromStorage();
  await service.previewComposerInput("session-1", "hello");
  await service.searchWorkspaceFiles("session-1", "main");
  await service.openSessionTerminal("session-1");

  assert.deepEqual(calls, [
    "skills:C:/workspace",
    "agents:C:/copilot",
    "refresh",
    "preview:session-1:hello",
    "search:C:/workspace:main",
    "terminal:C:/workspace",
  ]);
});
