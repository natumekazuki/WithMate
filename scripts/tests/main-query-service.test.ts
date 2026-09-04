import assert from "node:assert/strict";
import test from "node:test";

import {
  projectHomeSessionSummary,
  type Session,
  type SessionSummary,
} from "../../src/app-state.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
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

function createSessionSummary(overrides?: Partial<SessionSummary>): SessionSummary {
  const session = createSession(overrides);
  const { messages: _messages, stream: _stream, ...summary } = session;
  return summary;
}

// @test-value v1
// kind = "contract"
// claim = "MainQueryServiceがSessionのskills、custom agents、preview、terminal queryを各serviceの結果として返す"
// oracle = { type = "contract", ref = "MainQueryService query surface" }
// failure_mode = "query facadeが対象resourceを解決せず、Session UIの候補またはpreviewが欠落する"
// scope = "MainQueryService read queries"
// lifecycle = "permanent"
// distinction = "複数のquery種別を同じfixtureで確認する"
// @end-test-value
test("MainQueryService は session skills/custom agents と preview/terminal を解決する", async () => {
  const calls: string[] = [];
  const sourceSessions = [
    createSession(),
    createSession({ id: "session-2", provider: "copilot", workspacePath: "C:/copilot" }),
  ];
  const fullSessionRequests: string[] = [];
  const service = new MainQueryService({
    getSessionSummaries: () => sourceSessions.map((session) => createSessionSummary(session)),
    getSessionSummaryPage: () => ({ entries: sourceSessions.map((session) => createSessionSummary(session)), nextCursor: null, hasMore: false }),
    getRelatedSessionSummaries: (sessionIds) => sessionIds.flatMap((sessionId) => {
      const session = sourceSessions.find((candidate) => candidate.id === sessionId);
      return session ? [{ sessionId, taskTitle: session.taskTitle }] : [];
    }),
    getSessionCharacterUsage: () => [{ characterId: "char-1", sessionKind: "default" }],
    getSession: (sessionId) => {
      fullSessionRequests.push(sessionId);
      return sourceSessions.find((session) => session.id === sessionId) ?? null;
    },
    getSessionMessageArtifact: () => null,
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
    async resolveComposerPreview(session, userMessage) {
      calls.push(`preview:${session.id}:${userMessage}`);
      return { attachments: [], errors: [] };
    },
    async launchTerminalAtPath(workspacePath) {
      calls.push(`terminal:${workspacePath}`);
    },
  });

  assert.deepEqual(await service.listRelatedSessionSummaries(["session-2", "missing"]), [{
    sessionId: "session-2",
    taskTitle: "task",
  }]);
  assert.deepEqual(fullSessionRequests, []);

  assert.equal((await service.listSessionSummaries()).length, 2);
  const session = await service.getSession("session-1");
  assert.notEqual(session, sourceSessions[0]);
  assert.equal(session?.workspacePath, "C:/workspace");
  await service.listSessionSkills("session-1");
  await service.listSessionCustomAgents("session-2");
  await service.previewComposerInput("session-1", "@src/main.ts");
  await service.openSessionTerminal("session-1");

  assert.deepEqual(calls, [
    "skills:C:/workspace",
    "agents:C:/copilot",
    "preview:session-1:@src/main.ts",
    "terminal:C:/workspace",
  ]);
  assert.deepEqual(fullSessionRequests, ["session-1"]);
});

// @test-value v1
// kind = "contract"
// claim = "bounded summary pageとCharacter usageが呼び出し元へ独立したcloneとして返る"
// oracle = { type = "contract", ref = "Session summary query projection" }
// failure_mode = "summaryまたはusageが欠落・共有参照のまま返され、Home projectionが壊れる"
// scope = "MainQueryService session summary"
// lifecycle = "permanent"
// distinction = "page metadataとCharacter usageの両方を観測する"
// @end-test-value
test("MainQueryService は bounded summary page と Character usage を clone して返す", async () => {
  const entry = createSessionSummary({ id: "page-session" });
  const usage = { characterId: "char-page", sessionKind: "default" as const };
  const service = new MainQueryService({
    getSessionSummaries: () => [],
    getSessionSummaryPage: () => ({ entries: [entry], nextCursor: "cursor-1", hasMore: true }),
    getSessionCharacterUsage: () => [usage],
    getSession: () => null,
    getSessionMessageArtifact: () => null,
    getAuditLogs: () => [],
    getAuditLogSummaries: () => [],
    getAuditLogSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false, total: 0 }),
    getAuditLogDetail: () => null,
    getAuditLogDetailSection: () => null,
    getAuditLogOperationDetail: () => null,
    getAppSettings: () => ({
      providers: {},
      codingProviderSettings: {},
      memoryExtractionProviderSettings: {},
      characterReflectionProviderSettings: {},
    }) as never,
    discoverSessionSkills: async () => [],
    discoverSessionCustomAgents: async () => [],
    resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
    launchTerminalAtPath: async () => undefined,
  });

  const page = await service.listSessionSummaryPage({ scope: "recent", limit: 1 });
  const usages = await service.listSessionCharacterUsage();

  assert.deepEqual(page, {
    entries: [projectHomeSessionSummary(entry)],
    nextCursor: "cursor-1",
    hasMore: true,
  });
  assert.equal("provider" in page.entries[0], false);
  assert.equal("threadId" in page.entries[0], false);
  assert.notEqual(page.entries[0], entry);
  assert.deepEqual(usages, [usage]);
  assert.notEqual(usages[0], usage);
});

// @test-value v1
// kind = "regression"
// claim = "path参照を持たないdraft previewはfilesystem queryを行わず空結果を返す"
// oracle = { type = "contract", ref = "Draft preview no-path boundary" }
// failure_mode = "無効なpathなしdraftで不要なfilesystem accessまたは例外が発生する"
// scope = "MainQueryService draft preview"
// lifecycle = "permanent"
// distinction = "path参照なしという早期return条件を対象にする"
// @end-test-value
test("MainQueryService は path 参照なし draft の preview を早期 return する", async () => {
  let getSessionSummariesCalls = 0;
  const service = new MainQueryService({
    getSessionSummaries: () => {
      getSessionSummariesCalls += 1;
      return [createSessionSummary()];
    },
    getSessionSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false }),
    getSessionCharacterUsage: () => [],
    getSession: () => createSession(),
    getSessionMessageArtifact: () => null,
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
    async resolveComposerPreview() {
      throw new Error("path 参照なしでは preview 解決まで進まないはず");
    },
    async launchTerminalAtPath() {},
  });

  const preview = await service.previewComposerInput("session-1", "hello");
  assert.deepEqual(preview, { attachments: [], errors: [] });
  assert.equal(getSessionSummariesCalls, 0);
});

// @test-value v1
// kind = "contract"
// claim = "Session providerごとのskill directoryが対応providerのdiscoveryへ渡される"
// oracle = { type = "contract", ref = "Provider skill discovery boundary" }
// failure_mode = "provider固有skillが別provider rootへ渡され、候補一覧が誤る"
// scope = "MainQueryService provider skill discovery"
// lifecycle = "permanent"
// distinction = "provider選択値とdiscovery引数の対応を確認する"
// @end-test-value
test("MainQueryService は session provider ごとの skill directory を discovery に渡す", async () => {
  const providerSkillRoots: Array<{ workspacePath: string; skillRootPath: string | null }> = [];
  const settings = createDefaultAppSettings();
  settings.codingProviderSettings.codex = {
    enabled: true,
    apiKey: "",
    skillRootPath: "C:/provider-files/codex",
    skillRelativePath: ".codex/skills",
    instructionRelativePath: "AGENTS.md",
  };
  settings.codingProviderSettings.copilot = {
    enabled: true,
    apiKey: "",
    skillRootPath: "C:/provider-files/copilot",
    skillRelativePath: "skills",
    instructionRelativePath: "copilot-instructions.md",
  };
  const service = new MainQueryService({
    getSessionSummaries: () => [
      createSessionSummary({ id: "codex-session", provider: "codex", workspacePath: "C:/workspace" }),
      createSessionSummary({ id: "copilot-session", provider: "copilot", workspacePath: "C:/workspace" }),
    ],
    getSessionSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false }),
    getSessionCharacterUsage: () => [],
    getSession: () => null,
    getSessionMessageArtifact: () => null,
    getAuditLogs: () => [],
    getAuditLogSummaries: () => [],
    getAuditLogSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false, total: 0 }),
    getAuditLogDetail: () => null,
    getAuditLogDetailSection: () => null,
    getAuditLogOperationDetail: () => null,
    getAppSettings: () => settings,
    async discoverSessionSkills(workspacePath, skillRootPath) {
      providerSkillRoots.push({ workspacePath, skillRootPath });
      return [];
    },
    discoverSessionCustomAgents: async () => [],
    async resolveComposerPreview() {
      return { attachments: [], errors: [] };
    },
    async launchTerminalAtPath() {},
  });

  await service.listSessionSkills("codex-session");
  await service.listSessionSkills("copilot-session");

  assert.deepEqual(providerSkillRoots, [
    { workspacePath: "C:/workspace", skillRootPath: "C:/provider-files/codex/.codex/skills" },
    { workspacePath: "C:/workspace", skillRootPath: "C:/provider-files/copilot/skills" },
  ]);
});

// @test-value v1
// kind = "invariant"
// claim = "Session一覧queryはsummary projectionだけを返し、detail payloadやmessagesを含めない"
// oracle = { type = "contract", ref = "Session summary public projection" }
// failure_mode = "一覧取得がdetailを漏らし、不要な本文・データがHomeへ到達する"
// scope = "MainQueryService session list projection"
// lifecycle = "permanent"
// distinction = "summaryの存在とdetail payloadの不在を同時に確認する"
// @end-test-value
test("MainQueryService は一覧を summary に射影して detail payload を含めない", async () => {
  const service = new MainQueryService({
    getSessionSummaries: () => [createSessionSummary()],
    getSessionSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false }),
    getSessionCharacterUsage: () => [],
    getSession: () => createSession(),
    getSessionMessageArtifact: () => null,
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
    async resolveComposerPreview() {
      return { attachments: [], errors: [] };
    },
    async launchTerminalAtPath() {},
  });

  const summaries = await service.listSessionSummaries();
  assert.deepEqual(Object.keys(summaries[0] ?? {}).includes("messages"), false);
  assert.deepEqual(Object.keys(summaries[0] ?? {}).includes("stream"), false);
});

// @test-value v1
// kind = "contract"
// claim = "MainQueryServiceは指定されたSession detailだけをcloneして返す"
// oracle = { type = "contract", ref = "Session detail query scope" }
// failure_mode = "別Sessionのdetailまたは共有参照が返り、Session Windowの表示が汚染される"
// scope = "MainQueryService session detail"
// lifecycle = "permanent"
// distinction = "対象Session限定とclone結果を確認する"
// @end-test-value
test("MainQueryService は対象 session detail だけを clone して返す", async () => {
  const targetSession = createSession();
  let requestedSessionId: string | null = null;
  const service = new MainQueryService({
    getSessionSummaries: () => [createSessionSummary(targetSession)],
    getSessionSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false }),
    getSessionCharacterUsage: () => [],
    getSession: (sessionId) => {
      requestedSessionId = sessionId;
      return sessionId === targetSession.id ? targetSession : null;
    },
    getSessionMessageArtifact: () => null,
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
    async resolveComposerPreview() {
      return { attachments: [], errors: [] };
    },
    async launchTerminalAtPath() {},
  });

  const session = await service.getSession("session-1");
  assert.notEqual(session, targetSession);
  assert.equal(session?.id, "session-1");
  assert.equal(requestedSessionId, "session-1");
});

// @test-value v1
// kind = "contract"
// claim = "summary pageとCharacter usageを指定queryに対応するcloneとして返す"
// oracle = { type = "contract", ref = "Session summary query projection" }
// failure_mode = "pageまたはusageのquery結果が欠落し、Homeの一覧更新が不完全になる"
// scope = "MainQueryService bounded summary"
// lifecycle = "permanent"
// distinction = "同名のsummary testとは別fixtureでbounded query委譲を検証する"
// @end-test-value
test("MainQueryService は bounded summary page と Character usage を clone して返す", async () => {
  const entry = createSessionSummary({ id: "page-session" });
  const usage = { characterId: "char-page", sessionKind: "default" as const };
  const service = new MainQueryService({
    getSessionSummaries: () => [],
    getSessionSummaryPage: () => ({ entries: [entry], nextCursor: "cursor-1", hasMore: true }),
    getSessionCharacterUsage: () => [usage],
    getSession: () => null,
    getSessionMessageArtifact: () => null,
    getAuditLogs: () => [],
    getAuditLogSummaries: () => [],
    getAuditLogSummaryPage: () => ({ entries: [], nextCursor: null, hasMore: false, total: 0 }),
    getAuditLogDetail: () => null,
    getAuditLogDetailSection: () => null,
    getAuditLogOperationDetail: () => null,
    getAppSettings: () => ({}) as never,
    discoverSessionSkills: async () => [],
    discoverSessionCustomAgents: async () => [],
    resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
    launchTerminalAtPath: async () => undefined,
  });
  const page = await service.listSessionSummaryPage({ scope: "recent", limit: 1 });
  const usages = await service.listSessionCharacterUsage();
  assert.deepEqual(page, {
    entries: [projectHomeSessionSummary(entry)],
    nextCursor: "cursor-1",
    hasMore: true,
  });
  assert.equal("provider" in page.entries[0], false);
  assert.equal("threadId" in page.entries[0], false);
  assert.notEqual(page.entries[0], entry);
  assert.deepEqual(usages, [usage]);
  assert.notEqual(usages[0], usage);
});

