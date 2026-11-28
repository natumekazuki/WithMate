import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectHomeSessionSummary } from "../../src-shared/session/session-state.js";
import type {
  Session,
  SessionSummary,
} from "../../src-shared/session/session-state.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { MainQueryService } from "../../src-electron/app/main-query-service.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { resolveV6FreshDatabasePath } from "../../src-electron/storage/database-schema-v6.js";
import {
  createV6StorageWorkerBundle,
  type V6StorageWorkerBundle,
} from "../../src-electron/storage/storage-worker-bundle.js";

/** 一覧と詳細の射影を比較するため、実行設定・メッセージ・ストリームを持つセッションを組み立てる。 */
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
    accessMode: "active",
    sourceSchemaVersion: 5,
    isPinned: false,
    characterId: "char-1",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#111", sub: "#222" },
    characterRuntimeSnapshot: null,
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
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

/** 詳細用のメッセージとストリームを取り除き、問い合わせの保存元となる概要を作る。 */
function createSessionSummary(
  overrides?: Partial<SessionSummary>,
): SessionSummary {
  const session = createSession(overrides);
  const { messages: _messages, stream: _stream, ...summary } = session;
  return summary;
}

// @test-value v2
// kind = "contract"
// claim = "Skills、Custom Agents、添付preview、Terminalは準備完了した対象Sessionのworkspaceだけを使い、全一覧を取得しない"
// oracle = { type = "contract", ref = "src-electron/app/main-query-service.ts" }
// fault = "単体操作で全件取得するか、未準備・不在のSessionのworkspaceを使う"
// observable = "実SQLiteを使う操作の対象引数、未準備・不在時の拒否、全件およびdetail取得回数"
// observation_boundary = "public-boundary"
// scope = "main query service"
// lifecycle = "permanent"
// @end-test-value
/** 利用可能なセッションのワークスペースに技能検出・別エージェント・入力プレビュー・端末を結び付け、未準備と未登録の ID を拒否し、詳細の取得は明示要求だけに限定する。 */
test("MainQueryService は session skills/custom agents と preview/terminal を解決する", async (t) => {
  const calls: string[] = [];
  const sourceSessions = [
    createSession({ allowedAdditionalDirectories: ["C:/additional"] }),
    createSession({
      id: "session-2",
      provider: "copilot",
      workspacePath: "C:/copilot",
    }),
  ];
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "withmate-main-query-exact-"),
  );
  const dbPath = resolveV6FreshDatabasePath(directory);
  const storage = new SessionStorageV6(dbPath);
  let worker: V6StorageWorkerBundle | undefined;
  /** テスト終了後にワーカーを閉じ、閉鎖に失敗しても DB と一時フォルダーを処分する。 */
  t.after(async () => {
    try {
      await worker?.client.close();
    } finally {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const session of sourceSessions) storage.insertSession(session);
  storage.insertSession(
    createSession({ id: "pending", workspacePath: "C:/not-ready" }),
  );
  storage.beginSessionLifecycleOperation({
    operationId: "pending-create",
    kind: "create",
    input: {},
    targets: [{ id: "pending" }],
  });
  worker = createV6StorageWorkerBundle({ dbPath, userDataPath: directory });
  await worker.initialize();
  const { stores } = worker;
  let fullListRequests = 0;
  const fullSessionRequests: string[] = [];
  const service = new MainQueryService({
    /** 全一覧の取得回数を数え、DB に実際に保存した概要を返す。 */
    getSessionSummaries: () => {
      fullListRequests += 1;
      return storage.listSessionSummaries();
    },
    /** ワーカー経由で利用準備済みの単一セッションの概要を引く。 */
    getReadySessionSummary: (sessionId) =>
      stores.session.getReadySessionSummary(sessionId),
    /** 既知のセッションを単一ページとして返す。 */
    getSessionSummaryPage: () => ({
      entries: sourceSessions.map((session) => createSessionSummary(session)),
      nextCursor: null,
      hasMore: false,
    }),
    /** 既定セッションで選んだ Character の使用情報を返す。 */
    getSessionCharacterUsage: () => [
      { characterId: "char-1", sessionKind: "default" },
    ],
    /** 詳細取得で指定された ID を記録し、フィクスチャの一致するセッションのみ返す。 */
    getSession: (sessionId) => {
      fullSessionRequests.push(sessionId);
      return sourceSessions.find((session) => session.id === sessionId) ?? null;
    },
    /** メッセージ成果物の追加読込を伴わない状態にする。 */
    getSessionMessageArtifact: () => null,
    /** 保存済みの最新ターンがない状態を返す。 */
    getLatestSessionTurn: () => null,
    /** 個別プロバイダーの上書き設定がない条件にする。 */
    getAppSettings: () =>
      ({
        providers: {},
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    /** スキルの探索先ワークスペースを記録し、候補を返さない。 */
    async discoverSessionSkills(workspacePath) {
      calls.push(`skills:${workspacePath}`);
      return [];
    },
    /** カスタムエージェントの探索が使ったワークスペースを記録する。 */
    async discoverSessionCustomAgents(workspacePath) {
      calls.push(`agents:${workspacePath}`);
      return [];
    },
    /** プレビューに渡る本文、ワークスペース、追加ディレクトリを記録する。 */
    async resolveComposerPreview(session, userMessage) {
      calls.push(
        `preview:${session.id}:${session.workspacePath}:${session.allowedAdditionalDirectories.join(",")}:${userMessage}`,
      );
      return { attachments: [], errors: [] };
    },
    /** 実端末は開かず、要求された起動先を記録する。 */
    async launchTerminalAtPath(workspacePath) {
      calls.push(`terminal:${workspacePath}`);
    },
  });

  assert.deepEqual(
    new Set((await service.listSessionSummaries()).map(({ id }) => id)),
    new Set(["session-1", "session-2"]),
  );
  const session = await service.getSession("session-1");
  assert.notEqual(session, sourceSessions[0]);
  assert.equal(session?.workspacePath, "C:/workspace");
  await service.listSessionSkills("session-1");
  await service.listSessionCustomAgents("session-2");
  await service.previewComposerInput("session-1", "@src/main.ts");
  await service.openSessionTerminal("session-1");
  for (const id of ["pending", "missing"]) {
    await assert.rejects(
      service.listSessionSkills(id),
      /session could not be found/i,
    );
    await assert.rejects(
      service.listSessionCustomAgents(id),
      /session could not be found/i,
    );
    await assert.rejects(
      service.previewComposerInput(id, "@src/main.ts"),
      /session could not be found/i,
    );
    await assert.rejects(
      service.openSessionTerminal(id),
      /session could not be found/i,
    );
  }

  assert.deepEqual(calls, [
    "skills:C:/workspace",
    "agents:C:/copilot",
    "preview:session-1:C:/workspace:C:/additional:@src/main.ts",
    "terminal:C:/workspace",
  ]);
  assert.deepEqual(fullSessionRequests, ["session-1"]);
  assert.equal(fullListRequests, 1);
});

// @test-value v2
// kind = "contract"
// claim = "Home summary pageとCharacter usageは取得結果を複製し内部stateを外部から変更させない"
// oracle = { type = "contract", ref = "src-electron/app/main-query-service.ts MainQueryService public query contracts" }
// fault = "取得stateを参照共有したまま返すかHomeへprovider/thread情報を混入する"
// observable = "pageとusageの値、オブジェクト同一性、Home field"
// observation_boundary = "public-boundary"
// scope = "main query service"
// lifecycle = "permanent"
// @end-test-value
/** カーソル付きの概要ページは Home 向けに実行情報を除いて返り、ページ項目と Character 使用情報は元オブジェクトを共有しない。 */
test("MainQueryService は bounded summary page と Character usage を clone して返す", async () => {
  const entry = createSessionSummary({ id: "page-session" });
  const usage = { characterId: "char-page", sessionKind: "default" as const };
  const service = new MainQueryService({
    /** ページの取得とは別の全件一覧には項目を用意しない。 */
    getSessionSummaries: () => [],
    /** このページには個別の利用準備済み概要を問い合わせる必要がない。 */
    getReadySessionSummary: () => null,
    /** 次のカーソルがある一件の概要ページを返す。 */
    getSessionSummaryPage: () => ({
      entries: [entry],
      nextCursor: "cursor-1",
      hasMore: true,
    }),
    /** 返却時の複製を比較できる同じ使用情報オブジェクトを渡す。 */
    getSessionCharacterUsage: () => [usage],
    /** ページと使用情報の取得にはセッション詳細を用意しない。 */
    getSession: () => null,
    /** 一覧の射影にメッセージ成果物を用意しない。 */
    getSessionMessageArtifact: () => null,
    /** 既存ターンのないセッションとして扱う。 */
    getLatestSessionTurn: () => null,
    /** 利用集計にプロバイダー設定の差を持ち込まない。 */
    getAppSettings: () =>
      ({
        providers: {},
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    /** 技能の一覧取得が本テストに候補を持ち込まないようにする。 */
    discoverSessionSkills: async () => [],
    /** カスタムエージェント候補を持たないフィクスチャにする。 */
    discoverSessionCustomAgents: async () => [],
    /** 参照の解決結果が空のプレビューを返せるようにする。 */
    resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
    /** ページ取得のフィクスチャから OS の端末を起動しない。 */
    launchTerminalAtPath: async () => undefined,
  });

  const page = await service.listSessionSummaryPage({
    scope: "recent",
    limit: 1,
  });
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

// @test-value v2
// kind = "contract"
// claim = "添付参照のないdraftのpreviewは空の正常previewで追加discoveryを要求しない"
// oracle = { type = "contract", ref = "src-electron/app/main-query-service.ts" }
// fault = "添付参照のないdraftをdiscoveryへ流して不要な失敗を引き起こす"
// observable = "空previewとSession summary取得回数"
// observation_boundary = "public-boundary"
// scope = "main query service"
// lifecycle = "permanent"
// @end-test-value
/** パス参照のない入力では、全一覧も個別概要も取得せず、プレビュー解決を始めないまま空の結果を返す。 */
test("MainQueryService は path 参照なし draft の preview を早期 return する", async () => {
  let getSessionSummariesCalls = 0;
  let getReadySessionSummaryCalls = 0;
  const service = new MainQueryService({
    /** 早期終了より前に全一覧を取得した場合に検出する。 */
    getSessionSummaries: () => {
      getSessionSummariesCalls += 1;
      return [createSessionSummary()];
    },
    /** パスなしのプレビューで個別概要を引いた場合に検出する。 */
    getReadySessionSummary: () => {
      getReadySessionSummaryCalls += 1;
      return createSessionSummary();
    },
    /** 早期終了テストでページ項目を用意しない。 */
    getSessionSummaryPage: () => ({
      entries: [],
      nextCursor: null,
      hasMore: false,
    }),
    /** Character 使用情報の参照は対象外なので空にする。 */
    getSessionCharacterUsage: () => [],
    /** 個別セッションを要求された場合の基準データを返す。 */
    getSession: () => createSession(),
    /** 入力のない成果物は用意しない。 */
    getSessionMessageArtifact: () => null,
    /** 履歴に関係するターンを用意しない。 */
    getLatestSessionTurn: () => null,
    /** 参照のない入力をプロバイダー固有の設定なしで扱う。 */
    getAppSettings: () =>
      ({
        providers: {},
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    /** スキル候補は入力プレビューに提供しない。 */
    discoverSessionSkills: async () => [],
    /** カスタムエージェントの候補は返さない。 */
    discoverSessionCustomAgents: async () => [],
    /** パスがないのにプレビュー解決を開始すれば失敗させる。 */
    async resolveComposerPreview() {
      throw new Error("path 参照なしでは preview 解決まで進まないはず");
    },
    /** プレビューのフィクスチャに端末起動の副作用を持たせない。 */
    async launchTerminalAtPath() {},
  });

  const preview = await service.previewComposerInput("session-1", "hello");
  assert.deepEqual(preview, { attachments: [], errors: [] });
  assert.equal(getSessionSummariesCalls, 0);
  assert.equal(getReadySessionSummaryCalls, 0);
});

// @test-value v2
// kind = "contract"
// claim = "同じworkspaceでもproviderごとのSkill rootをdiscoveryへ渡す"
// oracle = { type = "contract", ref = "src-electron/app/main-query-service.ts MainQueryService public query contracts" }
// fault = "CopilotとCodexのskill root設定を取り違える"
// observable = "discoveryへ渡されたworkspacePath/skillRootPath"
// observation_boundary = "public-boundary"
// scope = "main query service"
// lifecycle = "permanent"
// @end-test-value
/** 同じワークスペースの Codex と Copilot でも、それぞれのファイル領域にあるスキルディレクトリを探索先に渡す。 */
test("MainQueryService は session provider ごとの skill directory を discovery に渡す", async () => {
  const providerSkillRoots: Array<{
    workspacePath: string;
    skillRootPath: string | null;
  }> = [];
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
  const summaries = [
    createSessionSummary({
      id: "codex-session",
      provider: "codex",
      workspacePath: "C:/workspace",
    }),
    createSessionSummary({
      id: "copilot-session",
      provider: "copilot",
      workspacePath: "C:/workspace",
    }),
  ];
  const service = new MainQueryService({
    /** 二つのプロバイダーのセッション概要を探索元として返す。 */
    getSessionSummaries: () => summaries,
    /** 要求されたセッション ID に対応するプロバイダー付き概要を返す。 */
    getReadySessionSummary: (id) =>
      summaries.find((summary) => summary.id === id) ?? null,
    /** スキル探索とは独立したページ照会を空にする。 */
    getSessionSummaryPage: () => ({
      entries: [],
      nextCursor: null,
      hasMore: false,
    }),
    /** ディレクトリ決定に不要な使用情報は用意しない。 */
    getSessionCharacterUsage: () => [],
    /** スキル探索に詳細セッションを提供しない。 */
    getSession: () => null,
    /** スキルの場所だけを検証し、成果物は用意しない。 */
    getSessionMessageArtifact: () => null,
    /** 実行履歴がない条件でスキル探索先を比較する。 */
    getLatestSessionTurn: () => null,
    /** プロバイダーごとに別のファイル領域を指定した設定を返す。 */
    getAppSettings: () => settings,
    /** 実ファイルを探索せず、渡されたワークスペースとスキルのルートを対で記録する。 */
    async discoverSessionSkills(workspacePath, skillRootPath) {
      providerSkillRoots.push({ workspacePath, skillRootPath });
      return [];
    },
    /** カスタムエージェント側の探索結果は比較対象外とする。 */
    discoverSessionCustomAgents: async () => [],
    /** スキル探索の代替依存に、添付もエラーもないプレビューを用意する。 */
    async resolveComposerPreview() {
      return { attachments: [], errors: [] };
    },
    /** スキル探索用のフィクスチャでは端末を起動しない。 */
    async launchTerminalAtPath() {},
  });

  await service.listSessionSkills("codex-session");
  await service.listSessionSkills("copilot-session");

  assert.deepEqual(providerSkillRoots, [
    {
      workspacePath: "C:/workspace",
      skillRootPath: "C:/provider-files/codex/.codex/skills",
    },
    {
      workspacePath: "C:/workspace",
      skillRootPath: "C:/provider-files/copilot/skills",
    },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "Session一覧には会話詳細を持たないsummaryだけを返す"
// oracle = { type = "contract", ref = "src-electron/app/main-query-service.ts MainQueryService public query contracts" }
// fault = "一覧結果へmessage/stream本文を混入し全履歴を常駐させる"
// observable = "一覧結果のmessages/stream keyの有無"
// observation_boundary = "public-boundary"
// scope = "main query service"
// lifecycle = "permanent"
// @end-test-value
/** 全件一覧が詳細のメッセージやストリームを含まない概要を返すことを確認する。 */
test("MainQueryService は一覧を summary に射影して detail payload を含めない", async () => {
  const service = new MainQueryService({
    /** 一覧の取得元に概要が一件ある状態を作る。 */
    getSessionSummaries: () => [createSessionSummary()],
    /** 一覧取得に個別の準備済み概要は用意しない。 */
    getReadySessionSummary: () => null,
    /** 全件一覧とは区別し、ページ照会は空の結果にする。 */
    getSessionSummaryPage: () => ({
      entries: [],
      nextCursor: null,
      hasMore: false,
    }),
    /** 一覧の内容から Character 使用情報の検証を外す。 */
    getSessionCharacterUsage: () => [],
    /** メッセージとストリームを持つ詳細を別経路に用意する。 */
    getSession: () => createSession(),
    /** 別途取得するメッセージ成果物はないものとする。 */
    getSessionMessageArtifact: () => null,
    /** 一覧の項目に関連ターンがない状態を返す。 */
    getLatestSessionTurn: () => null,
    /** 個別プロバイダーの設定を指定せずに一覧の射影を比較する。 */
    getAppSettings: () =>
      ({
        providers: {},
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    /** 一覧のための技能候補は用意しない。 */
    discoverSessionSkills: async () => [],
    /** カスタムエージェントの一覧を空にする。 */
    discoverSessionCustomAgents: async () => [],
    /** 一覧の検証に使うプレビュー依存に空の結果を返す。 */
    async resolveComposerPreview() {
      return { attachments: [], errors: [] };
    },
    /** 一覧問い合わせでは実際の端末を起動しない。 */
    async launchTerminalAtPath() {},
  });

  const summaries = await service.listSessionSummaries();
  assert.deepEqual(Object.keys(summaries[0] ?? {}).includes("messages"), false);
  assert.deepEqual(Object.keys(summaries[0] ?? {}).includes("stream"), false);
});

// @test-value v2
// kind = "contract"
// claim = "Session詳細は指定Sessionだけを取得してcloneで返す"
// oracle = { type = "contract", ref = "src-electron/app/main-query-service.ts MainQueryService public query contracts" }
// fault = "別Sessionを取得するか取得objectをそのまま渡し永続stateへの変更を許す"
// observable = "取得要求ID、返却Session IDと同一性"
// observation_boundary = "public-boundary"
// scope = "main query service"
// lifecycle = "permanent"
// @end-test-value
/** 指定した ID だけを詳細の保存元に問い合わせ、同じ ID を持つ別オブジェクトを返す。 */
test("MainQueryService は対象 session detail だけを clone して返す", async () => {
  const targetSession = createSession();
  let requestedSessionId: string | null = null;
  const service = new MainQueryService({
    /** 対象セッションの概要を一覧側にも用意する。 */
    getSessionSummaries: () => [createSessionSummary(targetSession)],
    /** 準備済み概要からではなく詳細取得の境界を検証する。 */
    getReadySessionSummary: () => null,
    /** 詳細の取得とページ結果を混同しないようページ側を空にする。 */
    getSessionSummaryPage: () => ({
      entries: [],
      nextCursor: null,
      hasMore: false,
    }),
    /** 個別詳細の検証に Character 使用情報を持ち込まない。 */
    getSessionCharacterUsage: () => [],
    /** 問い合わせた ID を記録し、目的のセッションに一致する場合だけ詳細を返す。 */
    getSession: (sessionId) => {
      requestedSessionId = sessionId;
      return sessionId === targetSession.id ? targetSession : null;
    },
    /** 詳細取得に独立した成果物レコードを追加しない。 */
    getSessionMessageArtifact: () => null,
    /** 詳細の複製の比較に最新ターンを使わない。 */
    getLatestSessionTurn: () => null,
    /** 詳細取得を個別プロバイダー設定がない条件で試す。 */
    getAppSettings: () =>
      ({
        providers: {},
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    /** 詳細取得のフィクスチャにスキル候補を提供しない。 */
    discoverSessionSkills: async () => [],
    /** 詳細の複製だけを検証するため、カスタムエージェント候補は空にする。 */
    discoverSessionCustomAgents: async () => [],
    /** 詳細読み取りとは別のプレビューの戻り値を空にする。 */
    async resolveComposerPreview() {
      return { attachments: [], errors: [] };
    },
    /** 詳細取得のフィクスチャでは端末を実際に開かない。 */
    async launchTerminalAtPath() {},
  });

  const session = await service.getSession("session-1");
  assert.notEqual(session, targetSession);
  assert.equal(session?.id, "session-1");
  assert.equal(requestedSessionId, "session-1");
});
