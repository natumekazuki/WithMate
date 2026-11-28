import assert from "node:assert/strict";
import { it } from "node:test";

import {
  buildNewSession,
  getSessionIncarnationId,
  type Session,
} from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import {
  SessionRuntimeFixture as SessionRuntimeService,
  type SessionRuntimeFixtureDeps as SessionRuntimeServiceDeps,
} from "./session-runtime-fixture.js";
import type { RunSessionTurnInput } from "../../src-electron/providers/provider-runtime.js";
import { createSessionPersistenceAssembly } from "../../src-electron/session/session-persistence-assembly.js";
import { CurrentExecutionSelections } from "../../src-electron/session/current-execution-selections.js";

const providerCatalog: ModelCatalogProvider = {
  id: "codex",
  label: "Codex",
  defaultModelId: "model-a",
  defaultReasoningEffort: "high",
  models: [
    { id: "model-a", label: "Model A", reasoningEfforts: ["high"] },
    { id: "model-b", label: "Model B", reasoningEfforts: ["medium"] },
  ],
};

/** 開始時に設定を捕捉する runtime を組み立て、保存・プロンプト・Provider 実行・turn 投影の各入力を独立に観測できるようにする。 */
function makeService(
  observe: {
    composed: RunSessionTurnInput[];
    executed: RunSessionTurnInput[];
    turn: Array<Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]>;
    persisted: Session[];
  },
  overrides: Partial<SessionRuntimeServiceDeps> = {},
) {
  const stored = buildNewSession({
    taskTitle: "Execution options",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    provider: "codex",
    approvalMode: "untrusted",
    model: "model-a",
    reasoningEffort: "high",
    characterId: "character-1",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: { main: "#111111", sub: "#222222" },
  });
  let current = stored;
  const adapter = {
    /** 合成段階へ渡る捕捉入力を記録し、実 Provider に依存しないプロンプトを返す。 */
    composePrompt(input: RunSessionTurnInput) {
      observe.composed.push(input);
      return {
        systemBodyText: "system",
        inputBodyText: "input",
        logicalPrompt: {
          systemText: "system",
          inputText: "input",
          composedText: "system\ninput",
        },
        imagePaths: [],
        additionalDirectories: [],
      };
    },
    /** Provider quota 情報をこのダブルでは取得しない。 */
    async getProviderQuotaTelemetry() {
      return null;
    },
    /** 個別スレッドの無効化では外部に接続しない。 */
    async invalidateSessionThread() {},
    /** 一括無効化にも実 Provider 状態を用意しない。 */
    async invalidateAllSessionThreads() {},
    /** 実行時の Provider 入力を記録し、固定の thread と応答を返す。 */
    async runSessionTurn(input: RunSessionTurnInput) {
      observe.executed.push(input);
      return {
        threadId: "thread-1",
        assistantText: "done",

        usage: null,
      };
    },
  };
  const service = new SessionRuntimeService({
    /** 開始・終了の後に reader が見る最新の永続 Session を返す。 */
    getSession: () => current,
    /** 保存済みの Model・深さ・承認が送信時の選択と異なる状況を保ち、その保存結果を記録する。 */
    upsertSession(next) {
      current = {
        ...next,
        model: stored.model,
        reasoningEffort: stored.reasoningEffort,
        approvalMode: stored.approvalMode,
      };
      observe.persisted.push(current);
      return current;
    },
    /** 添付の解決結果を空で確定させ、実行設定だけを比較できるようにする。 */
    resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
    /** 特に差し替えないケースには無効化設定のない既定値を供給する。 */
    getAppSettings: () => normalizeAppSettings({}),
    /** 基準の二つの Model を持つ固定カタログを解決する。 */
    resolveProviderCatalog: () => ({
      snapshot: { providers: [providerCatalog] },
      provider: providerCatalog,
    }),
    /** Provider への実アクセスを記録用ダブルへ置き換える。 */
    getProviderCodingAdapter: () => adapter,
    /** 開始 turn の保存入力を記録し、更新で使う固定 ID を付ける。 */
    createSessionTurn(input) {
      observe.turn.push(input);
      return { id: 1, ...input };
    },
    /** 更新と終了に渡した最小 turn も開始と同じ観測列へ追加する。 */
    updateSessionTurn(_id, input) {
      observe.turn.push(input);
    },
    /** Live 表示の記録は turn 入力比較には不要なので保存しない。 */
    setLiveSessionRun() {},
    /** 外部の live 状態を用意せず、実行 fixture の内部進行を使う。 */
    getLiveSessionRun: () => null,
    /** 承認が必要になっても外部操作を待たず拒否する。 */
    waitForApprovalDecision: () => "deny",
    /** Elicitation が来ても応答 UI を開かず取消にする。 */
    waitForElicitationResponse: () => ({ action: "cancel" }),
    /** Quota の更新で外部テレメトリを変更しない。 */
    setProviderQuotaTelemetry() {},
    /** セッションコンテキストのテレメトリは保存しない。 */
    setSessionContextTelemetry() {},
    /** Provider のスレッドを実際には無効化しない。 */
    invalidateProviderSessionThread() {},
    /** Quota のバックグラウンド取得は予約しない。 */
    scheduleProviderQuotaTelemetryRefresh() {},
    /** Live run の変化を renderer には通知しない。 */
    broadcastLiveSessionRun() {},
    /** 実承認キューを持たないダブルで解決処理を省く。 */
    resolvePendingApprovalRequest() {},
    /** 実 Elicitation キューが存在しないため解決処理を省く。 */
    resolvePendingElicitationRequest() {},
    ...overrides,
  });
  return { service, stored, adapter };
}

/** 実設定保存 assembly と現在選択をつなぎ、DB へ送る checkpoint と親子の実行状態をメモリだけで観測する。 */
function makePersistence(
  runtime: SessionRuntimeService,
  stored: Session,
  auxiliaryOptions: Map<string, SessionExecutionOptions>,
  catalog = providerCatalog,
) {
  let cached = [stored];
  const selections = new CurrentExecutionSelections();
  const checkpoints: SessionExecutionOptions[] = [];
  const persistence = createSessionPersistenceAssembly({
    owner: {
      /** 固定 fixture の所有世代を有効として処理を通す。 */
      assertActive() {},
    },
    storage: {
      /** 設定保存の入力を保持し、受理した設定と同じ組が永続境界へ届くか比較できるようにする。 */
      setSessionExecutionOptions(
        _id: string,
        _owner: string,
        options: SessionExecutionOptions,
      ) {
        checkpoints.push(options);
      },
      /** 一覧再取得にはメモリ上の summary を流用する。 */
      listSessionSummaries: () => cached,
    } as never,
    pinStorage: {} as never,
    cache: {
      /** 現在の一覧キャッシュを assembly に公開する。 */
      getSessions: () => cached,
      /** 再投影した一覧を次の ID 解決に使う。 */
      setSessions: (next) => {
        cached = next;
      },
      /** キャッシュから指定 ID を探し、見つからない場合は null を返す。 */
      getSession: (id) => cached.find((entry) => entry.id === id) ?? null,
      /** 保存済み Session に会話別の次送信用選択を重ねる。 */
      overlayCurrentExecutionOptions: (session) => selections.apply(session),
      /** 受理された実行設定をその会話の次送信用選択として覚える。 */
      rememberExecutionOptions: (session, options) =>
        selections.remember(session, options),
    },
    runtime: {
      /** Main 実行に加え、子を含む確認のときだけ当該 Main に設定した Auxiliary の稼働を反映する。 */
      isSessionRunInFlight: (id, scope = "with-auxiliary") =>
        runtime.isRunInFlight(id) ||
        (id === stored.id &&
          scope === "with-auxiliary" &&
          auxiliaryOptions.size > 0),
    },
    auxiliary: {
      /** 実体のある Auxiliary を作らず、稼働判定は runtime 側の Map だけで制御する。 */
      listAuxiliarySessionRuntimeIdentities: () => [],
    },
    settings: {
      /** 選択保存に必要なアプリ設定として既定値を渡す。 */
      getAppSettings: () => normalizeAppSettings({}),
      /** テストが指定した Provider と Model 候補で設定を検証させる。 */
      getModelCatalogSnapshot: () => ({ providers: [catalog] }),
    },
    character: {
      /** 実行設定の変更に Character 定義の取得を持ち込まない。 */
      createCharacterRuntimeSnapshot: () => null,
    },
    effects: {
      /** 設定保存用のダブルには破棄するコンテキストテレメトリがない。 */
      clearSessionContextTelemetry() {},

      /** 設定の照合だけを行うため Provider の実スレッドには触れない。 */
      invalidateProviderSessionThread() {},
      /** 実 Agent runtime binding を作らず、副作用を発生させない。 */
      revokeSessionAgentRuntimeBindings() {},
      /** 親削除を拒む条件を調べるため実ウィンドウ制御を行わない。 */
      closeSessionWindow() {},
      /** ダブルには破棄する Session ウィンドウがない。 */
      discardSessionWindow() {},
      /** 一覧変更を renderer に送らず、キャッシュを直接比較する。 */
      broadcastSessions() {},
    },
  });
  return {
    persistence,
    selections,
    checkpoints,
    /** 次送信用設定をテストする唯一の Main の投影を読む。 */
    getCached: () => cached[0]!,
  };
}

// @test-value v2
// kind = "contract"
// claim = "ClaudeのAuto Run中のReviewerは通常更新では保持し、確認済みのApproval変更だけ両方を一括保存する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes" }
// fault = "未確認でReviewerを変更する、古い確認を受理する、または確認済み変更を保存できない"
// observable = "persistence assemblyの更新拒否・ACK、checkpointと現在選択のApproval／Reviewer"
// observation_boundary = "component-behavior"
// scope = "Claude legacy update and explicit shared Approval choice through current selection and persistence"
// lifecycle = "permanent"
// impact = "選択を受理したように見せた後で次turnが実行不能になる"
// distinction = "送信時validationとSQLite単体testは保存済みneverのReviewer保持との合成を通らない"
// @end-test-value
/** Claude の自動走行から移る際は保持される Reviewer を含めて組合せを審査し、古い確認では保存せず、現在の承認モードに対する確認後だけ保存と選択を揃える。 */
it("ClaudeのReviewer保持後も組合せを検証して選択とcheckpointを一致させる", async () => {
  const observe = {
    composed: [] as RunSessionTurnInput[],
    executed: [] as RunSessionTurnInput[],
    turn: [] as Array<
      Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]
    >,
    persisted: [] as Session[],
  };
  const { service: runtime, stored } = makeService(observe);
  const session: Session = {
    ...stored,
    provider: "claude",
    approvalMode: "never",
    codexReviewer: "auto-review",
  };
  const { persistence, checkpoints, getCached } = makePersistence(
    runtime,
    session,
    new Map(),
    { ...providerCatalog, id: "claude" },
  );
  const captured = captureSessionExecutionOptions(session);
  await assert.rejects(
    persistence.setSessionExecutionOptions(
      session.id,
      getSessionIncarnationId(session),
      {
        ...captured,
        approvalMode: "plan",
        codexReviewer: "user",
      },
    ),
    /reviewer is not supported with this approval mode/,
  );
  assert.equal(checkpoints.length, 0);
  assert.deepEqual(captureSessionExecutionOptions(getCached()), captured);
  await assert.rejects(
    persistence.setSessionExecutionOptions(
      session.id,
      getSessionIncarnationId(session),
      {
        ...captured,
        approvalMode: "plan",
        codexReviewer: "user",
      },
      { previousApprovalMode: "on-request" },
    ),
    /no longer valid/,
  );
  assert.equal(checkpoints.length, 0);
  assert.deepEqual(
    await persistence.setSessionExecutionOptions(
      session.id,
      getSessionIncarnationId(session),
      {
        ...captured,
        approvalMode: "plan",
        codexReviewer: "user",
      },
      { previousApprovalMode: "never" },
    ),
    { status: "accepted", checkpointSaved: true },
  );
  assert.equal(checkpoints.at(-1)?.approvalMode, "plan");
  assert.equal(checkpoints.at(-1)?.codexReviewer, "user");
  assert.deepEqual(captureSessionExecutionOptions(getCached()), {
    ...captured,
    approvalMode: "plan",
    codexReviewer: "user",
  });
  await persistence.setSessionExecutionOptions(
    session.id,
    getSessionIncarnationId(session),
    {
      ...captured,
      approvalMode: "on-request",
      codexReviewer: "auto-review",
    },
  );
  await persistence.setSessionExecutionOptions(
    session.id,
    getSessionIncarnationId(session),
    captured,
  );
  await persistence.setSessionExecutionOptions(
    session.id,
    getSessionIncarnationId(session),
    {
      ...captured,
      approvalMode: "on-request",
      codexReviewer: "user",
    },
  );
  assert.equal(checkpoints.at(-1)?.codexReviewer, "auto-review");
  await persistence.setSessionExecutionOptions(
    session.id,
    getSessionIncarnationId(session),
    {
      ...captured,
      approvalMode: "on-request",
      codexReviewer: "user",
    },
  );
  await persistence.setSessionExecutionOptions(
    session.id,
    getSessionIncarnationId(session),
    {
      ...captured,
      approvalMode: "plan",
      codexReviewer: "user",
    },
  );
  assert.equal(checkpoints.at(-1)?.approvalMode, "plan");
  assert.equal(checkpoints.at(-1)?.codexReviewer, "user");
  await persistence.setSessionExecutionOptions(
    session.id,
    getSessionIncarnationId(session),
    captured,
  );
  await assert.rejects(
    persistence.setSessionExecutionOptions(
      session.id,
      getSessionIncarnationId(session),
      {
        ...captured,
        approvalMode: "on-request",
        codexReviewer: "auto-review",
      },
      undefined,
      "user",
    ),
    /Approval choice does not match/,
  );
  assert.deepEqual(
    await persistence.setSessionExecutionOptions(
      session.id,
      getSessionIncarnationId(session),
      {
        ...captured,
        approvalMode: "on-request",
        codexReviewer: "user",
      },
      undefined,
      "user",
    ),
    { status: "accepted", checkpointSaved: true },
  );
  assert.deepEqual(checkpoints.at(-1), {
    ...captured,
    approvalMode: "on-request",
    codexReviewer: "user",
  });
});

// @test-value v2
// kind = "contract"
// claim = "Copilot/OpenCodeの旧Reviewerは明示選択なしには変わらず、UserとAuto Reviewを明示した場合だけ次Turn用設定へ確定する"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#設定と適用範囲; docs/design/provider-adapter.md#approval-modes" }
// fault = "旧設定を暗黙に明示Userへ変える、明示選択を保存しない、無関係なApprovalへの変更で保存したReviewerを上書きする"
// observable = "SessionPersistenceServiceの次Turn用現在選択とcheckpointに届く保存設定"
// observation_boundary = "component-behavior"
// scope = "Mainの明示Approval更新と既存設定の非明示更新"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "旧Sessionの共通Settings適用が変わるか明示したReviewerが効かない"
// distinction = "SQLiteの再読込や実行ゲートだけではSession所有の更新時に明示マークが付く条件を検出できない"
// @end-test-value
/** Copilot と OpenCode の旧 Reviewer は通常更新で明示扱いにならず、共有選択を指定した場合だけ選択と checkpoint に反映される。 */
it("only an explicit shared choice updates the stored Copilot and OpenCode reviewer preference", async () => {
  for (const provider of ["copilot", "opencode"]) {
    const observe = {
      composed: [] as RunSessionTurnInput[],
      executed: [] as RunSessionTurnInput[],
      turn: [] as Array<
        Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]
      >,
      persisted: [] as Session[],
    };
    const { service: runtime, stored } = makeService(observe);
    const session: Session = {
      ...stored,
      provider,
      approvalMode: "on-request",
      codexReviewer: "user",
    };
    const { persistence, checkpoints, getCached } = makePersistence(
      runtime,
      session,
      new Map(),
      { ...providerCatalog, id: provider },
    );
    const legacy = captureSessionExecutionOptions(session);
    /** 同じ Session の incarnation に対し、共有承認の明示選択を付ける場合と付けない場合を同じ入口から試す。 */
    const update = (
      options: SessionExecutionOptions,
      choice?: "user" | "auto-review" | "safety-focused",
    ) =>
      persistence.setSessionExecutionOptions(
        session.id,
        getSessionIncarnationId(session),
        options,
        undefined,
        choice,
      );
    /** 最新 checkpoint とキャッシュから捕捉した設定が同じ期待値に揃うかを比較する。 */
    const assertSaved = (options: SessionExecutionOptions) => {
      assert.deepEqual(checkpoints.at(-1), options);
      assert.deepEqual(captureSessionExecutionOptions(getCached()), options);
    };
    await update({
      ...legacy,
      codexReviewer: "auto-review",
      withMateReviewerExplicit: true,
    });
    assertSaved(legacy);
    const user = { ...legacy, withMateReviewerExplicit: true } as const;
    await update(user, "user");
    assertSaved(user);
    const automatic = { ...user, codexReviewer: "auto-review" } as const;
    await update(automatic, "auto-review");
    assertSaved(automatic);
    const safety = { ...automatic, approvalMode: "safety-focused" } as const;
    await update({ ...safety, codexReviewer: "user" }, "safety-focused");
    assertSaved(safety);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "待機Mainは複数Auxiliary実行中でも権限等の選択を受理し次turnへ渡すが、親削除を拒否し別会話の現在選択を保持する"
// oracle = { type = "contract", ref = "Issue #800; docs/design/electron-session-store.md#実行設定と-send" }
// fault = "子を含むguardでMain選択を拒否する、子を含む削除guardを弱める、または次turnへ古い選択を渡す"
// observable = "assemblyの選択受理結果、checkpoint、削除拒否、会話別CurrentExecutionSelectionsとProvider/turnの実行設定"
// observation_boundary = "component-behavior"
// scope = "Main execution options through persistence assembly and SessionRuntimeService; simulated Auxiliary in-flight registry"
// lifecycle = "permanent"
// impact = "待機中Mainの権限変更と次送信が阻害される、または実行中の子を親削除で失う"
// distinction = "既存runtime testの送信値固定と異なり、子実行中の選択受理から次turnのProvider入力までを結合する。小さいin-memory fixtureでDB/外部Providerを要しない"
// @end-test-value
/** 稼働中の子が一つでも二つでも Main の次送信設定は保存され、その子の選択を変えずに親削除を拒否する。 */
it("Auxiliary実行中のMain選択を次turnへ渡し親削除を保護する", async () => {
  const observe = {
    composed: [] as RunSessionTurnInput[],
    executed: [] as RunSessionTurnInput[],
    turn: [] as Array<
      Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]
    >,
    persisted: [] as Session[],
  };
  const { service: runtime, stored } = makeService(observe);
  const auxiliaryOptions = new Map<string, SessionExecutionOptions>();
  const { persistence, selections, checkpoints, getCached } = makePersistence(
    runtime,
    stored,
    auxiliaryOptions,
  );
  const capturedAuxiliaryOptions = captureSessionExecutionOptions(stored);
  for (const count of [1, 2]) {
    auxiliaryOptions.set(`aux-${count}`, capturedAuxiliaryOptions);
    const otherConversation = { ...stored, id: `aux-${count}` };
    selections.remember(otherConversation, capturedAuxiliaryOptions);
    const chosen: SessionExecutionOptions = {
      ...captureSessionExecutionOptions(stored),
      approvalMode: "never",
      codexSandboxMode: count === 1 ? "read-only" : "danger-full-access",
      codexSpeed: "fast",
      codexReviewer: "auto-review",
      customAgentName: "reviewer",
    };
    assert.deepEqual(
      await persistence.setSessionExecutionOptions(
        stored.id,
        getSessionIncarnationId(stored),
        chosen,
      ),
      {
        status: "accepted",
        checkpointSaved: true,
      },
    );
    assert.deepEqual(checkpoints.at(-1), chosen);
    assert.deepEqual(captureSessionExecutionOptions(getCached()), chosen);
    await assert.rejects(
      persistence.deleteSession(stored.id),
      /running Crew cannot be deleted/,
    );
    await runtime.runSessionTurn(stored.id, {
      userMessage: `run with ${count} auxiliaries`,
      executionOptions: captureSessionExecutionOptions(
        selections.apply(stored),
      ),
    });
    assert.deepEqual(observe.executed.at(-1)?.executionOptions, chosen);
    const turn = observe.turn.findLast((entry) => entry.phase === "running");
    assert.equal(turn?.approvalMode, chosen.approvalMode);
    assert.equal(turn?.sandboxMode, chosen.codexSandboxMode);
    for (let index = 1; index <= count; index += 1) {
      assert.deepEqual(
        captureSessionExecutionOptions(
          selections.apply({ ...stored, id: `aux-${index}` }),
        ),
        capturedAuxiliaryOptions,
      );
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Mainのstarting/running/取消終了待ちでも次送信用の設定選択を受理し、開始時に捕捉したProviderと最小turnの実行設定は変更しない"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md: 実行設定と Send; docs/design/desktop-ui.md: 次送信用の現在選択" }
// fault = "実行中の次送信用選択を拒否する、または現在選択から進行中turnの実行設定を再取得する"
// observable = "各phaseのsetSessionExecutionOptions ACKとcheckpoint、現在選択、Provider入力と最小turnの捕捉設定"
// observation_boundary = "component-behavior"
// scope = "Main current selection and captured execution options across real SessionRuntimeService lifecycle with controlled provider/preview"
// lifecycle = "permanent"
// impact = "次送信用の選択を妨げず、進行中turnを別の権限や設定へ変えてしまうことを防ぐ"
// distinction = "renderer選択testや単一phaseのruntime testでは、開始準備・Provider待ち・取消終了待ちの実lifecycleを通した設定捕捉を確認できない。短いcancel graceと手動gateで外部Providerを不要にする"
// @end-test-value
/** 開始準備・Provider 実行・取消後の終了待ちで次送信用選択を受理しても、進行中 turn に保存・実行する捕捉値は変わらない。 */
it("Mainの各実行phaseで次送信用設定を選べるが、進行中turnの捕捉値は変わらない", async () => {
  const observe = {
    composed: [] as RunSessionTurnInput[],
    executed: [] as RunSessionTurnInput[],
    turn: [] as Array<
      Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]
    >,
    persisted: [] as Session[],
  };
  let releasePreview!: () => void;
  let previewEntered!: () => void;
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  const previewStarted = new Promise<void>((resolve) => {
    previewEntered = resolve;
  });
  let releaseProvider!: () => void;
  let providerEntered!: () => void;
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const providerStarted = new Promise<void>((resolve) => {
    providerEntered = resolve;
  });
  const {
    service: runtime,
    stored,
    adapter,
  } = makeService(observe, {
    providerCancelGraceMs: 1,
    /** プレビュー解決へ入ったことを通知し、開始準備が終わる時点をテストから制御する。 */
    resolveComposerPreview: async () => {
      previewEntered();
      await previewGate;
      return { attachments: [], errors: [] };
    },
  });
  const runProvider = adapter.runSessionTurn.bind(adapter);
  adapter.runSessionTurn = async (input) => {
    providerEntered();
    await providerGate;
    return runProvider(input);
  };
  const { persistence, selections, checkpoints } = makePersistence(
    runtime,
    stored,
    new Map(),
  );
  const original = captureSessionExecutionOptions(stored);
  const changes: SessionExecutionOptions[] = [
    { ...original, approvalMode: "never" },
    { ...original, codexSandboxMode: "read-only" },
    { ...original, codexSpeed: "fast" },
    { ...original, codexReviewer: "auto-review" },
    { ...original, customAgentName: "reviewer" },
  ];
  /** 稼働中の phase ごとにすべての設定変更を受理し、選択と追加 checkpoint が順に一致するか検査する。 */
  const assertNextSelectionAccepted = async () => {
    assert.equal(runtime.isRunInFlight(stored.id), true);
    const before = checkpoints.length;
    for (const changed of changes) {
      assert.deepEqual(
        await persistence.setSessionExecutionOptions(
          stored.id,
          getSessionIncarnationId(stored),
          changed,
        ),
        {
          status: "accepted",
          checkpointSaved: true,
        },
      );
      assert.deepEqual(
        captureSessionExecutionOptions(selections.apply(stored)),
        changed,
      );
    }
    assert.deepEqual(checkpoints.slice(before), changes);
  };
  const run = runtime.runSessionTurn(stored.id, {
    userMessage: "run",
    executionOptions: original,
  });
  try {
    await previewStarted;
    await assertNextSelectionAccepted();
    releasePreview();
    await providerStarted;
    await assertNextSelectionAccepted();
    runtime.cancelRun(stored.id);
    await run;
    await assertNextSelectionAccepted();
  } finally {
    releasePreview();
    releaseProvider();
    await run;
  }
  for (
    let attempt = 0;
    attempt < 100 && runtime.isRunInFlight(stored.id);
    attempt += 1
  ) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(runtime.isRunInFlight(stored.id), false);
  assert.equal(observe.executed.length, 1);
  assert.deepEqual(observe.executed[0]?.executionOptions, original);
  const capturedTurn = observe.turn.find((entry) => entry.phase === "running");
  assert.ok(capturedTurn);
  assert.equal(capturedTurn.approvalMode, original.approvalMode);
  assert.equal(capturedTurn.sandboxMode, original.codexSandboxMode);
  assert.deepEqual(
    await persistence.setSessionExecutionOptions(
      stored.id,
      getSessionIncarnationId(stored),
      changes[0]!,
    ),
    {
      status: "accepted",
      checkpointSaved: true,
    },
  );
});

// @test-value v2
// kind = "invariant"
// claim = "送信時に選んだ model/depth/approval は、開始・終了保存が古いSession設定を返しても同一turnのProviderと最小turnへ伝わる"
// oracle = { type = "contract", ref = "Issue #738 turn execution options boundary" }
// fault = "保存済みSession設定または保存戻り値からturn実行設定を再取得する"
// observable = "provider inputのexecutionOptionsとrunning/terminal turn fields"
// observation_boundary = "component-behavior"
// scope = "SessionRuntimeService turn execution"
// lifecycle = "permanent"
// impact = "表示選択と異なるmodelやapprovalでProviderを実行し、turnに誤設定が残る"
// distinction = "既存のSession永続化・Provider単体testでは保存戻り値と送信値の不一致を観測しない"
// @end-test-value
/** 保存結果が元の Model を返しても、送信時の凍結済み設定が Provider と開始・完了 turn に渡る。 */
it("turn送信値を保存済み設定と独立にProviderと最小turnへ固定する", async () => {
  const observe = {
    composed: [] as RunSessionTurnInput[],
    executed: [] as RunSessionTurnInput[],
    turn: [] as Array<
      Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]
    >,
    persisted: [] as Session[],
  };
  const { service, stored } = makeService(observe);
  const selected = Object.freeze({
    ...captureSessionExecutionOptions(stored),
    model: "model-b",
    reasoningEffort: "medium" as const,
    approvalMode: "never" as const,
  });

  await service.runSessionTurn(stored.id, {
    userMessage: "run",
    executionOptions: selected,
  });
  for (
    let attempt = 0;
    attempt < 20 && !observe.turn.some((entry) => entry.phase === "completed");
    attempt += 1
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(observe.persisted[0]?.model, "model-a");
  assert.deepEqual(observe.executed[0]?.executionOptions, selected);
  assert.equal(observe.executed[0]?.session.model, "model-a");
  assert.equal(Object.isFrozen(observe.executed[0]?.executionOptions), true);
  for (const phase of ["running", "completed"] as const) {
    const turn = observe.turn.find((entry) => entry.phase === phase);
    assert.equal(turn?.model, "model-b");
    assert.equal(turn?.reasoningEffort, "medium");
    assert.equal(turn?.approvalMode, "never");
  }
});

// @test-value v2
// kind = "invariant"
// claim = "空modelはProvider起動とturn開始保存の前に拒否される"
// oracle = { type = "contract", ref = "accepted behavior: Send requires a selected model" }
// fault = "空modelをDB値やdefaultに置換して実行する"
// observable = "runSessionTurn rejection、provider call数、保存数"
// observation_boundary = "component-behavior"
// scope = "SessionRuntimeService turn selection validation"
// lifecycle = "permanent"
// impact = "利用者が選ばなかったmodel/depthで実行される"
// distinction = "型検査ではIPC実行時の空文字を検証できない"
// @end-test-value
/** 空白だけの Model ではプロンプト合成・実行・Session 保存・turn 保存をどれも始めない。 */
it("空modelを保存とProvider起動前に拒否する", async () => {
  const observe = {
    composed: [] as RunSessionTurnInput[],
    executed: [] as RunSessionTurnInput[],
    turn: [] as Array<
      Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]
    >,
    persisted: [] as Session[],
  };
  const { service, stored } = makeService(observe);
  const selected = captureSessionExecutionOptions(stored);
  await assert.rejects(
    service.runSessionTurn(stored.id, {
      userMessage: "run",
      executionOptions: { ...selected, model: " " },
    }),
    /selected model is invalid/,
  );
  assert.equal(observe.persisted.length, 0);
  assert.equal(observe.composed.length, 0);
  assert.equal(observe.executed.length, 0);
  assert.equal(observe.turn.length, 0);
});

// @test-value v2
// kind = "contract"
// claim = "保存済み現在選択でも無効Modelの新規turnを拒否し、再有効化後は同Modelを実行できる"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md#model-availability" }
// fault = "保存済み選択を理由に無効化を迂回するか、別Modelに置換して実行する"
// observable = "runSessionTurnの拒否、開始保存とProvider呼出し件数、再有効化後のModel"
// observation_boundary = "public-boundary"
// scope = "共通Runtimeの実行前Model検証"
// lifecycle = "permanent"
// impact = "ユーザーが無効化したModelへ送信される"
// distinction = "共有helperや受付testは実行開始の設定再取得を通らない"
// @end-test-value
/** 現在選択の Model が無効なら開始前に止め、設定から無効化を解除すると同じ要求で別 Model にせず実行する。 */
it("現在選択の無効Modelを実行前に拒否し再有効化後に同Modelを実行する", async () => {
  const observe = {
    composed: [] as RunSessionTurnInput[],
    executed: [] as RunSessionTurnInput[],
    turn: [] as Array<
      Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]
    >,
    persisted: [] as Session[],
  };
  const settings = normalizeAppSettings({
    modelAvailability: {
      codex: { disabledServiceIds: [], disabledModelIds: ["model-a"] },
    },
  });
  const { service, stored } = makeService(observe, {
    /** 再有効化が次回実行で読めるよう、同じ可変設定を返す。 */
    getAppSettings: () => settings,
  });
  const request = {
    userMessage: "run",
    executionOptions: captureSessionExecutionOptions(stored),
  };
  await assert.rejects(service.runSessionTurn(stored.id, request), /disabled/);
  assert.equal(observe.persisted.length, 0);
  assert.equal(observe.executed.length, 0);
  assert.equal(observe.turn.length, 0);
  settings.modelAvailability = {};
  await service.runSessionTurn(stored.id, request);
  assert.equal(observe.executed[0]?.executionOptions.model, "model-a");
});

// @test-value v2
// kind = "contract"
// claim = "discoveryにない保存modelと任意depthを送信時の値のままproviderへ渡す"
// oracle = { type = "contract", ref = "accepted behavior: discovery updates never replace captured selections" }
// fault = "最新候補にないmodelやdepthを拒否または既定値へ置換する"
// observable = "providerとturn保存へ渡されたmodelとdepth"
// observation_boundary = "public-boundary"
// scope = "SessionRuntimeService captured selection execution"
// lifecycle = "permanent"
// impact = "選択が候補から消えた会話を勝手に別modelで実行することを防ぐ"
// distinction = "共有helperの値保持だけでなくSendからproviderまでの値を小さいfixtureで確認する"
// @end-test-value
/** 候補一覧から失われた Model と SDK 固有の深さを既定値に置き換えず、Provider 入力と turn 保存に使う。 */
it("discoveryから消えたmodelとdepthもcaptured値を実行する", async () => {
  const observe = {
    composed: [] as RunSessionTurnInput[],
    executed: [] as RunSessionTurnInput[],
    turn: [] as Array<
      Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]
    >,
    persisted: [] as Session[],
  };
  const { service, stored } = makeService(observe);
  const selected = {
    ...captureSessionExecutionOptions(stored),
    model: "saved-model",
    reasoningEffort: "sdk-native-depth",
  };
  await service.runSessionTurn(stored.id, {
    userMessage: "run",
    executionOptions: selected,
  });
  assert.deepEqual(observe.executed[0]?.executionOptions, selected);
  assert.equal(observe.turn[0]?.model, "saved-model");
  assert.equal(observe.turn[0]?.reasoningEffort, "sdk-native-depth");
});
