import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { DEFAULT_CODEX_REVIEWER } from "../../src-shared/settings/codex-reviewer.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src-shared/settings/codex-sandbox-mode.js";
import { DEFAULT_CODEX_SPEED } from "../../src-shared/settings/codex-speed.js";
import { UNKNOWN_CHARACTER_OWNER_ID } from "../../src-shared/character/character-owner.js";
import {
  resolveModelSelection,
  type ModelCatalogProvider,
} from "../../src-shared/settings/model-catalog.js";
import {
  applyCopilotCustomAgentSelection,
  applySessionModelMetadataUpdate,
  buildNewSession,
  buildSessionSummarySignature,
  CURRENT_SESSION_SCHEMA_VERSION,
  isReadOnlySession,
  normalizeSession,
  parseSetSessionPinnedRequest,
  selectHydrationTarget,
  type SessionSummary,
} from "../../src-shared/session/session-state.js";

const COPILOT_PROVIDER_CATALOG: ModelCatalogProvider = {
  id: "copilot",
  label: "GitHub Copilot",
  defaultModelId: "gpt-4.1",
  defaultReasoningEffort: "high",
  models: [
    {
      id: "gpt-4.1",
      label: "GPT-4.1",
      reasoningEfforts: ["low", "medium", "high"],
    },
    {
      id: "gpt-4.1-mini",
      label: "GPT-4.1 mini",
      reasoningEfforts: ["low", "medium"],
    },
  ],
};

const CODEX_PROVIDER_CATALOG: ModelCatalogProvider = {
  id: "codex",
  label: "OpenAI Codex",
  defaultModelId: "gpt-5.4",
  defaultReasoningEffort: "high",
  models: [
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      reasoningEfforts: ["medium", "high", "xhigh"],
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 mini",
      reasoningEfforts: ["low", "medium", "high"],
    },
  ],
};

/** 指定 Provider で新規 Session を構成し、Provider に対応した初期モデルと必要なら指定 ID を使う。 */
function createSession(provider: string, id?: string) {
  return buildNewSession({
    id,
    provider,
    taskTitle: `${provider} session`,
    workspaceLabel: "workspace",
    workspacePath: "F:/repo",
    branch: "main",
    characterId: "char-a",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
    model: provider === "copilot" ? "gpt-4.1" : "gpt-5.4",
    reasoningEffort: "high",
  });
}

/** 新規・閲覧専用 Session の境界、ピン要求の検証、Copilot のカスタムエージェント変更を確認する。 */
describe("session-state custom agent selection", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "pin要求は空でないtrim済みSession IDとboolean値だけを受理する"
  // oracle = { type = "contract", ref = "src-shared/session/session-state.ts#SetSessionPinnedRequest" }
  // fault = "空IDやboolean以外のpin値が永続更新の入口を通過する"
  // observable = "parseSetSessionPinnedRequestの戻り値と不正入力時の例外"
  // observation_boundary = "public-boundary"
  // scope = "Session pin入力検証"
  // lifecycle = "permanent"
  // distinction = "unknownなIPC入力の拒否はTypeScriptの型だけでは確認できない"
  // @end-test-value
  /** ピン更新では ID の前後の空白を除去し、空 ID や文字列のピン値は例外にする。 */
  it("pin requestはtrim済みIDとbooleanだけを受理する", () => {
    assert.deepEqual(
      parseSetSessionPinnedRequest({
        sessionId: " session-1 ",
        isPinned: true,
      }),
      { sessionId: "session-1", isPinned: true },
    );
    assert.throws(
      () => parseSetSessionPinnedRequest({ sessionId: "", isPinned: true }),
      /Invalid session pin request/,
    );
    assert.throws(
      () =>
        parseSetSessionPinnedRequest({
          sessionId: "session-1",
          isPinned: "true",
        }),
      /Invalid session pin request/,
    );
  });

  /** 指定 ID の新規 Session は V5・未ピン・編集可能で作り、旧スキーマや明示的な閲覧専用は更新できない扱いにする。 */
  it("新規 session は V5 schema version で作成し、V4 以前は閲覧専用として扱う", () => {
    const session = createSession("codex", "launch-fixed");

    assert.equal(session.id, "launch-fixed");
    assert.equal(CURRENT_SESSION_SCHEMA_VERSION, 5);
    assert.equal(session.sourceSchemaVersion, 5);
    assert.equal(session.isPinned, false);
    assert.equal(isReadOnlySession(session), false);
    assert.equal(
      isReadOnlySession({ ...session, sourceSchemaVersion: 4 }),
      true,
    );
    assert.equal(
      isReadOnlySession({
        ...session,
        accessMode: "legacy_readonly",
        sourceSchemaVersion: 5,
      }),
      true,
    );
  });

  /** Copilot のエージェント変更は新しい名前と更新時刻を反映し、再開用のスレッド ID は保持する。 */
  it("Copilot custom agent 切り替え時は threadId を維持する", () => {
    const session = {
      ...buildNewSession({
        provider: "copilot",
        taskTitle: "copilot",
        workspaceLabel: "workspace",
        workspacePath: "F:/repo",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
        customAgentName: "reviewer",
      }),
      threadId: "thread-keep",
    };

    const next = applyCopilotCustomAgentSelection(
      session,
      "planner",
      "2026-03-29 12:00",
    );

    assert.equal(next.customAgentName, "planner");
    assert.equal(next.threadId, "thread-keep");
    assert.equal(next.updatedAt, "2026-03-29 12:00");
  });
});

/** Session の用途識別と、Character 所有者を誤って復元しないための正規化を確認する。 */
describe("session-state session kind", () => {
  /** 新規作成時に指定した Character 作成用途を、既定用途へ置き換えず保持する。 */
  it("character-authoring session kind を新規 session に保持する", () => {
    const session = buildNewSession({
      provider: "codex",
      taskTitle: "authoring",
      workspaceLabel: "workspace",
      workspacePath: "F:/repo",
      branch: "main",
      sessionKind: "character-authoring",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    assert.equal(session.sessionKind, "character-authoring");
  });

  /** Character の ID と snapshot の所有者が一致しないときは、Session の所有者を維持して古い snapshot とスレッドを捨てる。 */
  it("Character ID と runtime snapshot owner が異なる Session は owner を維持して snapshot と thread を破棄する", () => {
    const session = createSession("codex");

    const normalized = normalizeSession({
      ...session,
      threadId: "stale-thread",
      characterRuntimeSnapshot: {
        characterId: "char-b",
        name: "B",
        description: "",
        iconFilePath: "",
        theme: { main: "#6f8cff", sub: "#6fb8c7" },
        definitionMarkdown: "# Character\nB",
        definitionSha256: "char-b-sha256",
        definitionByteSize: 13,
        snapshotAt: "2026-08-01T00:00:00.000Z",
      },
    });

    assert.equal(normalized?.characterId, "char-a");
    assert.equal(normalized?.characterRuntimeSnapshot, null);
    assert.equal(normalized?.threadId, "");
  });

  /** 新規作成と復元で所有者 ID の空白を除去し、不明な旧所有者を表示名で補わず古いスレッドを無効化する。 */
  it("Character owner を trim し、欠損した legacy owner を表示名から推測しない", () => {
    const base = createSession("codex");
    const built = buildNewSession({
      ...base,
      characterId: " char-a ",
    });

    assert.equal(built.characterId, "char-a");
    assert.throws(
      () => buildNewSession({ ...base, characterId: "   " }),
      /characterId/,
    );
    assert.throws(
      () =>
        buildNewSession({ ...base, characterId: UNKNOWN_CHARACTER_OWNER_ID }),
      /characterId/,
    );

    const normalized = normalizeSession({
      ...built,
      characterId: " char-a ",
      characterRuntimeSnapshot: {
        characterId: " char-a ",
        name: "A",
        description: "",
        iconFilePath: "",
        theme: { main: "#6f8cff", sub: "#6fb8c7" },
        definitionMarkdown: "# Character\nA",
        definitionSha256: "char-a-sha256",
        definitionByteSize: 13,
        snapshotAt: "2026-08-01T00:00:00.000Z",
      },
    });
    assert.equal(normalized?.characterId, "char-a");
    assert.equal(normalized?.characterRuntimeSnapshot?.characterId, "char-a");

    const recovered = normalizeSession({
      ...built,
      characterId: " ",
      character: "Display Name",
      characterRuntimeSnapshot: null,
      threadId: "stale-thread",
    });
    assert.equal(recovered?.characterId, UNKNOWN_CHARACTER_OWNER_ID);
    assert.notEqual(recovered?.characterId, "Display Name");
    assert.equal(recovered?.threadId, "");
  });
});

/** 復元とカタログに基づくモデル変更で、推論強度や既存スレッドの保持を検査する。 */
describe("session-state model selection", () => {
  /** 保存済みの max と ultra の推論強度を、読み込み時に別の既定値へ置き換えない。 */
  it("max / ultra を session 復元時に保持する", () => {
    for (const reasoningEffort of ["max", "ultra"] as const) {
      const session = normalizeSession({
        ...createSession("codex"),
        reasoningEffort,
      });

      assert.equal(session?.reasoningEffort, reasoningEffort);
    }
  });

  /** Copilot のモデル変更でカタログ解決済みの設定・改訂番号・時刻を保存し、以前のスレッド ID は変えない。 */
  it("Copilot session の model 更新時は threadId を維持して正規化後の設定を保存する", () => {
    const session = {
      ...createSession("copilot"),
      threadId: "thread-keep",
    };
    const selection = resolveModelSelection(
      COPILOT_PROVIDER_CATALOG,
      "gpt-4.1-mini",
      "medium",
    );

    const next = applySessionModelMetadataUpdate(
      session,
      selection,
      7,
      "2026-03-29 12:30",
    );

    assert.equal(next.threadId, "thread-keep");
    assert.equal(next.model, "gpt-4.1-mini");
    assert.equal(next.reasoningEffort, "medium");
    assert.equal(next.catalogRevision, 7);
    assert.equal(next.updatedAt, "2026-03-29 12:30");
  });

  /** Copilot でモデルを変えず推論強度だけ下げた場合も、スレッド ID を保って改訂番号と時刻を更新する。 */
  it("Copilot session の reasoning 更新時も threadId を維持する", () => {
    const session = {
      ...createSession("copilot"),
      threadId: "thread-keep",
    };
    const selection = resolveModelSelection(
      COPILOT_PROVIDER_CATALOG,
      session.model,
      "low",
    );

    const next = applySessionModelMetadataUpdate(
      session,
      selection,
      8,
      "2026-03-29 12:45",
    );

    assert.equal(next.threadId, "thread-keep");
    assert.equal(next.model, "gpt-4.1");
    assert.equal(next.reasoningEffort, "low");
    assert.equal(next.catalogRevision, 8);
    assert.equal(next.updatedAt, "2026-03-29 12:45");
  });

  /** Codex で別モデルと推論強度を選んでも、会話継続用のスレッド ID を捨てない。 */
  it("Codex session の model 更新時も threadId を維持する", () => {
    const session = {
      ...createSession("codex"),
      threadId: "thread-keep",
    };
    const selection = resolveModelSelection(
      CODEX_PROVIDER_CATALOG,
      "gpt-5.4-mini",
      "low",
    );

    const next = applySessionModelMetadataUpdate(
      session,
      selection,
      9,
      "2026-03-29 13:00",
    );

    assert.equal(next.threadId, "thread-keep");
    assert.equal(next.model, "gpt-5.4-mini");
    assert.equal(next.reasoningEffort, "low");
    assert.equal(next.catalogRevision, 9);
    assert.equal(next.updatedAt, "2026-03-29 13:00");
  });

  /** 既知の Provider 以外でも、解決したモデル設定と時刻を反映し、既存のスレッド ID を保持する。 */
  it("対象外 provider の session でも threadId を維持する", () => {
    const session = {
      ...createSession("other-provider"),
      threadId: "thread-reset",
    };
    const selection = resolveModelSelection(
      CODEX_PROVIDER_CATALOG,
      "gpt-5.4",
      "medium",
    );

    const next = applySessionModelMetadataUpdate(
      session,
      selection,
      10,
      "2026-03-29 13:15",
    );

    assert.equal(next.threadId, "thread-reset");
    assert.equal(next.model, "gpt-5.4");
    assert.equal(next.reasoningEffort, "medium");
    assert.equal(next.catalogRevision, 10);
    assert.equal(next.updatedAt, "2026-03-29 13:15");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSessionSummarySignature / selectHydrationTarget
// ─────────────────────────────────────────────────────────────────────────────

/** 一覧署名と詳細の更新判定に必要な Session Summary を、差し替え可能な既定値で用意する。 */
function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-1",
    taskTitle: "task",
    status: "idle",
    updatedAt: "2026-04-15 12:00",
    isPinned: false,
    accessMode: "active",
    sourceSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "workspace",
    workspacePath: "/repo",
    branch: "main",
    sessionKind: "default",
    characterId: "char-1",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#000", sub: "#fff" },
    runState: "idle",
    approvalMode: DEFAULT_APPROVAL_MODE,
    codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
    codexSpeed: DEFAULT_CODEX_SPEED,
    codexReviewer: DEFAULT_CODEX_REVIEWER,
    model: "gpt-5.4",
    reasoningEffort: "high",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    ...overrides,
  };
}

/** 一覧通知から詳細の再取得要否を判定できる署名の安定性と変更検出を確認する。 */
describe("buildSessionSummarySignature", () => {
  /** 同じ Summary から繰り返し計算した署名が変動しないことを確認する。 */
  it("同一 summary は同じ signature を返す", () => {
    const s = makeSummary();
    assert.equal(
      buildSessionSummarySignature(s),
      buildSessionSummarySignature(s),
    );
  });

  /** 更新時刻だけが変わった場合も、署名の差として検出する。 */
  it("updatedAt が異なれば signature も異なる", () => {
    const a = makeSummary({ updatedAt: "2026-04-15 12:00" });
    const b = makeSummary({ updatedAt: "2026-04-15 12:01" });
    assert.notEqual(
      buildSessionSummarySignature(a),
      buildSessionSummarySignature(b),
    );
  });

  /** ピンの切替を更新時刻に頼らず署名に反映する。 */
  it("pin stateが異なればsignatureも異なる", () => {
    const a = makeSummary({ isPinned: false });
    const b = makeSummary({ isPinned: true });
    assert.notEqual(
      buildSessionSummarySignature(a),
      buildSessionSummarySignature(b),
    );
  });

  /** ほかの属性が同じでも、アイドルから保存済みへの状態変更を署名で区別する。 */
  it("status が異なれば signature も異なる", () => {
    const a = makeSummary({ status: "idle" });
    const b = makeSummary({ status: "saved" });
    assert.notEqual(
      buildSessionSummarySignature(a),
      buildSessionSummarySignature(b),
    );
  });

  /** 同じ表示内容を持つ別 Session を、ID の違いで異なる署名にする。 */
  it("id が異なれば signature も異なる", () => {
    const a = makeSummary({ id: "session-1" });
    const b = makeSummary({ id: "session-2" });
    assert.notEqual(
      buildSessionSummarySignature(a),
      buildSessionSummarySignature(b),
    );
  });

  /** 配色以外が同じ Summary でも、テーマ変更後の署名を以前のものと区別する。 */
  it("characterThemeColors が異なれば signature も異なる", () => {
    const a = makeSummary({
      characterThemeColors: { main: "#000", sub: "#fff" },
    });
    const b = makeSummary({
      characterThemeColors: { main: "#111", sub: "#fff" },
    });
    assert.notEqual(
      buildSessionSummarySignature(a),
      buildSessionSummarySignature(b),
    );
  });
});

/** 一覧通知で選択中の Session を再取得すべき場合と、更新不要な場合を区別する。 */
describe("selectHydrationTarget — hydration 判定", () => {
  /** 前回の署名がなければ、一覧にある選択対象の Session ID を詳細の初回取得先として返す。 */
  it("初回（lastSummarySignature=null）は必ず hydrate target を返す（完了条件 1）", () => {
    const s = makeSummary({ id: "session-1" });
    const result = selectHydrationTarget([s], "session-1", null);
    assert.ok(result !== null, "初回 hydrate は target を返すべき");
    assert.equal(result.sessionId, "session-1");
  });

  /** 他 Session だけが更新された通知では、選択中の詳細を再取得しない。 */
  it("selected session の summary が変わっていない場合は null を返す（完了条件 2: unrelated update）", () => {
    const selected = makeSummary({
      id: "session-1",
      updatedAt: "2026-04-15 12:00",
    });
    const other = makeSummary({
      id: "session-2",
      updatedAt: "2026-04-15 12:01",
    });

    // selected session を一度 hydrate し signature を記録
    const firstTarget = selectHydrationTarget(
      [selected, other],
      "session-1",
      null,
    );
    assert.ok(firstTarget !== null);

    // other session だけが更新された次の subscription update
    const otherUpdated = { ...other, updatedAt: "2026-04-15 12:02" };
    const secondTarget = selectHydrationTarget(
      [selected, otherUpdated],
      "session-1",
      firstTarget.summarySignature,
    );

    assert.equal(
      secondTarget,
      null,
      "selected session が変わっていなければ null を返すべき",
    );
  });

  /** 選択中の Session の時刻と状態が変われば、以前の署名に対して同じ Session の再取得を要求する。 */
  it("selected session 自身の summary が変わった場合は hydrate target を返す（完了条件 3）", () => {
    const before = makeSummary({
      id: "session-1",
      updatedAt: "2026-04-15 12:00",
      status: "running",
    });
    const firstTarget = selectHydrationTarget([before], "session-1", null);
    assert.ok(firstTarget !== null);

    const after = {
      ...before,
      updatedAt: "2026-04-15 12:05",
      status: "saved" as const,
    };
    const secondTarget = selectHydrationTarget(
      [after],
      "session-1",
      firstTarget.summarySignature,
    );

    assert.ok(
      secondTarget !== null,
      "selected session の summary が変われば target を返すべき",
    );
    assert.equal(secondTarget.sessionId, "session-1");
  });

  /** Session が選択されていなければ、一覧に候補があっても詳細を取得しない。 */
  it("targetSessionId が null の場合は null を返す", () => {
    const s = makeSummary();
    assert.equal(selectHydrationTarget([s], null, null), null);
  });

  /** 選択対象が一覧から見つからない場合、他の Session を代わりに取得しない。 */
  it("targetSessionId が一覧にない場合は null を返す", () => {
    const s = makeSummary({ id: "session-2" });
    assert.equal(selectHydrationTarget([s], "session-1", null), null);
  });
});
