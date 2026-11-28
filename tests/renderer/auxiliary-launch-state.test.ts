import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import {
  applyAuxiliaryLaunchDialogState,
  canCancelAuxiliaryLaunchCreation,
  blocksAuxiliaryLaunchRetry,
  isAuxiliaryLaunchCreationActive,
  matchesAuxiliaryLaunchCreationRequest,
  AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK,
  AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK,
  AUXILIARY_LAUNCH_START_FAILED_FEEDBACK,
  buildCreateAuxiliarySessionInput,
  buildAuxiliaryLaunchProviderItems,
  createAuxiliaryLaunchDialogCloseHandler,
  createAuxiliaryLaunchDialogOpenHandler,
  createAuxiliaryLaunchProviderSelectHandler,
  resolveAuxiliaryLaunchFeedbackResetState,
  resolveAuxiliaryLaunchOpenState,
  resolveAuxiliaryLaunchCloseState,
  resolveAuxiliaryLaunchSessionDefaults,
  resolveAuxiliaryLaunchProviderSelectionState,
  resolveAuxiliaryLaunchInitialState,
  resolveAuxiliaryLaunchProviderId,
  resolveAuxiliaryLaunchStartError,
  resolveAuxiliaryLaunchStartProvider,
  resolveAuxiliaryLaunchStartErrorState,
  resolveAuxiliaryLaunchStartErrorFeedback,
} from "../../src/chat/auxiliary-launch-state.js";

/** モデル掲載の有無を指定できる Provider を作り、起動候補の絞り込みに使う。 */
function makeProvider(
  id: string,
  label: string,
  options: { hasModel?: boolean } = {},
): ModelCatalogProvider {
  const hasModel = options.hasModel ?? true;
  return {
    id,
    label,
    defaultModelId: hasModel ? "gpt-5.4-mini" : "",
    defaultReasoningEffort: "high",
    models: hasModel
      ? [
          {
            id: "gpt-5.4-mini",
            label: "GPT 5.4 mini",
            reasoningEfforts: ["high"],
          },
        ]
      : [],
  };
}

/** Auxiliary 起動の選択、作成要求の照合、ダイアログ状態と各操作の接続を検査する。 */
describe("auxiliary-launch-state", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "作成中のAuxiliaryだけを取消可能として表示する"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#ui-flow" }
  // fault = "commit済みまたは結果不明の作成へ取消操作を表示し、別状態の会話へ誤操作する"
  // observable = "canCancelAuxiliaryLaunchCreationの各状態判定"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-launch-dialog"
  // lifecycle = "permanent"
  // distinction = "UIの取消可能状態を公開state helperの契約として確認する"
  // @end-test-value
  /** 準備中とキュー待ちだけを取り消せる。コミット開始後や結果不明、状態未設定には取消を許さない。 */
  it("作成中の状態だけを取消可能と判定する", () => {
    assert.equal(canCancelAuxiliaryLaunchCreation("preparing"), true);
    assert.equal(canCancelAuxiliaryLaunchCreation("queued"), true);
    assert.equal(canCancelAuxiliaryLaunchCreation("committing"), false);
    assert.equal(canCancelAuxiliaryLaunchCreation("committed"), false);
    assert.equal(canCancelAuxiliaryLaunchCreation("cancelled"), false);
    assert.equal(canCancelAuxiliaryLaunchCreation("expired"), false);
    assert.equal(canCancelAuxiliaryLaunchCreation("failed"), false);
    assert.equal(canCancelAuxiliaryLaunchCreation("unknown"), false);
    assert.equal(canCancelAuxiliaryLaunchCreation(null), false);
    assert.equal(canCancelAuxiliaryLaunchCreation(undefined), false);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "作成結果を同一parent内でもrequestIdとcreation contextで照合する"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
  // fault = "遅延した旧requestの作成結果を新しいAuxiliary作成へ混入する"
  // observable = "matchesAuxiliaryLaunchCreationRequestの照合結果"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-launch-result-application"
  // lifecycle = "permanent"
  // distinction = "provider作成処理ではなくrendererのstale result drop境界を確認する"
  // @end-test-value
  /** 親 Session、要求 ID、作成世代、親のインカネーションがそろった結果だけを採用し、結果不明と失敗の再試行可否を区別する。 */
  it("作成結果はrequestIdとcreation contextが一致した場合だけ照合成功とする", () => {
    const request = {
      parentSessionId: "session-1",
      clientRequestId: "request-1",
      creationContext: {
        generationId: "generation-1",
        parentIncarnationId: "incarnation-1",
      },
    };
    const session = {
      parentSessionId: "session-1",
      clientRequestId: "request-1",
      creationContext: request.creationContext,
    };
    assert.equal(matchesAuxiliaryLaunchCreationRequest(session, request), true);
    assert.equal(
      matchesAuxiliaryLaunchCreationRequest(
        { ...session, clientRequestId: "request-2" },
        request,
      ),
      false,
    );
    assert.equal(
      matchesAuxiliaryLaunchCreationRequest(
        { ...session, parentSessionId: "session-2" },
        request,
      ),
      false,
    );
    assert.equal(
      matchesAuxiliaryLaunchCreationRequest(
        {
          ...session,
          creationContext: {
            ...request.creationContext,
            generationId: "generation-2",
          },
        },
        request,
      ),
      false,
    );
    assert.equal(
      matchesAuxiliaryLaunchCreationRequest(
        {
          ...session,
          creationContext: {
            ...request.creationContext,
            parentIncarnationId: "incarnation-2",
          },
        },
        request,
      ),
      false,
    );
    assert.equal(isAuxiliaryLaunchCreationActive("committing"), true);
    assert.equal(isAuxiliaryLaunchCreationActive("committed"), false);
    assert.equal(blocksAuxiliaryLaunchRetry("unknown"), true);
    assert.equal(blocksAuxiliaryLaunchRetry("failed"), false);
  });

  /** モデルのある候補だけを残し、元の順序のまま ID と表示名から選択項目を作る。 */
  it("provider filter と item 化を provider 条件で行う", () => {
    const providers: ModelCatalogProvider[] = [
      makeProvider("a", "A", { hasModel: false }),
      makeProvider("b", "B"),
      makeProvider("c", "C", { hasModel: false }),
      makeProvider("d", "D"),
    ];
    const items = buildAuxiliaryLaunchProviderItems(
      providers,
      (provider) => provider.models.length > 0,
    );

    assert.deepEqual(items, [
      { id: "b", label: "B" },
      { id: "d", label: "D" },
    ]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliary作成入力はparent/providerと選択済みlaunch defaultsを保持して構築される"
  // oracle = { type = "contract", ref = "src/chat/auxiliary-launch-state.ts: buildCreateAuxiliarySessionInput" }
  // fault = "providerまたはruntime optionを落とし、選択したモデル設定と異なるAuxiliaryを作成する"
  // observable = "buildCreateAuxiliarySessionInputの返却input"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-launch-input"
  // lifecycle = "permanent"
  // distinction = "作成入力のfield mappingをUI表示ではなく作成API境界で確認する"
  // @end-test-value
  /** 作成要求に親と Provider を指定し、選択済みのモデル、推論、承認、サンドボックス、速度とエージェントを渡す。 */
  it("create input は parent/provider と launch defaults を引き継ぐ", () => {
    assert.deepEqual(
      buildCreateAuxiliarySessionInput({
        parentSessionId: "session-1",
        provider: "codex",
        defaults: {
          model: "gpt-5.4-mini",
          reasoningEffort: "high",
          approvalMode: "never",
          codexSandboxMode: "read-only",
          codexSpeed: "fast",
          customAgentName: "planner",
        },
      }),
      {
        parentSessionId: "session-1",
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "high",
        approvalMode: "never",
        codexSandboxMode: "read-only",
        codexSpeed: "fast",
        customAgentName: "planner",
      },
    );
  });

  /** 起動設定を引き継がない場合は親と Provider だけを指定し、モデル等へ具体値を補わない。 */
  it("create input は defaults がないとき optional field を undefined にする", () => {
    assert.deepEqual(
      buildCreateAuxiliarySessionInput({
        parentSessionId: "session-1",
        provider: "codex",
        defaults: null,
      }),
      {
        parentSessionId: "session-1",
        provider: "codex",
        model: undefined,
        reasoningEffort: undefined,
        approvalMode: undefined,
        codexSandboxMode: undefined,
        customAgentName: undefined,
      },
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Auxiliaryのlaunch defaultsは同一providerの場合だけ再利用される"
  // oracle = { type = "contract", ref = "src/chat/auxiliary-launch-state.ts: resolveAuxiliaryLaunchSessionDefaults" }
  // fault = "異なるproviderのruntime optionを引き継ぎ、対象providerに不正なモデル設定を渡す"
  // observable = "provider一致・不一致・defaults nullの返却値"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-launch-defaults"
  // lifecycle = "permanent"
  // distinction = "provider境界の再利用条件をprovider selectionのUI testと分離して確認する"
  // @end-test-value
  /** 同じ Provider の既存設定だけを再利用し、不一致または設定なしなら引き継がない。 */
  it("launch defaults は同じ provider の場合だけ引き継ぐ", () => {
    const defaults = {
      model: "gpt-5.4-mini",
      reasoningEffort: "high" as const,
      approvalMode: "never" as const,
      codexSandboxMode: "read-only" as const,
      codexSpeed: "fast" as const,
      customAgentName: "planner",
    };

    assert.deepEqual(
      resolveAuxiliaryLaunchSessionDefaults({
        providerId: "codex",
        defaultsProviderId: "codex",
        defaults,
      }),
      defaults,
    );
    assert.equal(
      resolveAuxiliaryLaunchSessionDefaults({
        providerId: "copilot",
        defaultsProviderId: "codex",
        defaults,
      }),
      null,
    );
    assert.equal(
      resolveAuxiliaryLaunchSessionDefaults({
        providerId: "codex",
        defaultsProviderId: "codex",
        defaults: null,
      }),
      null,
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "latest-session作成ではrenderer由来のruntime optionを作成入力へ混入させない"
  // oracle = { type = "contract", ref = "src/chat/auxiliary-launch-state.ts: buildCreateAuxiliarySessionInput" }
  // fault = "rendererの偽装runtime optionを保存し、Main側のlatest-session選択契約を迂回する"
  // observable = "runtimeSelection latest-session時の返却input"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-latest-session-launch"
  // lifecycle = "permanent"
  // distinction = "通常のdefaults mappingでは検出できないlatest-sessionのoption遮断を確認する"
  // @end-test-value
  /** 最新 Session を参照するときは、renderer に別の設定値があっても Main への要求を参照指定だけに制限する。 */
  it("latest-session 選択では runtime option を renderer から送らない", () => {
    assert.deepEqual(
      buildCreateAuxiliarySessionInput({
        parentSessionId: "session-1",
        provider: "codex",
        runtimeSelection: "latest-session",
        defaults: {
          model: "forged-model",
          reasoningEffort: "low",
          approvalMode: "never",
          codexSandboxMode: "danger-full-access",
          codexSpeed: "standard",
          customAgentName: "forged-agent",
        },
      }),
      {
        parentSessionId: "session-1",
        provider: "codex",
        runtimeSelection: "latest-session",
      },
    );
  });

  /** Provider 未選択と起動抑止が重なる場合、具体的な抑止理由を表示する。 */
  it("start error は blocked feedback を provider 未選択より優先する", () => {
    const error = resolveAuxiliaryLaunchStartError({
      providerId: null,
      blockedFeedback: "blocked",
    });

    assert.equal(error?.message, "blocked");
  });

  /** 起動を抑止する別の理由がなければ、Provider を選択していないことをエラーで案内する。 */
  it("start error は provider 未選択 error を返す", () => {
    const error = resolveAuxiliaryLaunchStartError({
      providerId: null,
    });

    assert.equal(error?.message, AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK);
  });

  /** Provider が選択済みで抑止理由がなければ、起動エラーを返さない。 */
  it("start error は開始可能なとき null を返す", () => {
    assert.equal(
      resolveAuxiliaryLaunchStartError({
        providerId: "codex",
        blockedFeedback: null,
      }),
      null,
    );
  });

  /** 起動できる場合は ready と選択中の Provider ID を合わせて返す。 */
  it("start provider resolution は開始可能な provider id を返す", () => {
    assert.deepEqual(
      resolveAuxiliaryLaunchStartProvider({
        providerId: "codex",
        blockedFeedback: null,
      }),
      {
        status: "ready",
        providerId: "codex",
      },
    );
  });

  /** 起動先を解決できないときの blocked 結果には、一般の未選択理由でなく入力された抑止理由を入れる。 */
  it("start provider resolution は blocked feedback を provider 未選択より優先する", () => {
    const result = resolveAuxiliaryLaunchStartProvider({
      providerId: null,
      blockedFeedback: "blocked",
    });

    assert.equal(result.status, "blocked");
    assert.equal(
      result.status === "blocked" ? result.error.message : null,
      "blocked",
    );
  });

  /** Provider 不在で起動処理に進まず、blocked 結果に選択を促すエラーを含める。 */
  it("start provider resolution は provider 未選択を blocked にする", () => {
    const result = resolveAuxiliaryLaunchStartProvider({
      providerId: null,
    });

    assert.equal(result.status, "blocked");
    assert.equal(
      result.status === "blocked" ? result.error.message : null,
      AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK,
    );
  });

  /** 現在の Provider が候補内にあればその選択を保ち、候補にない場合は候補順の先頭を選ぶ。 */
  it("resolve 初期 provider は current provider を優先し、なければ先頭を使う", () => {
    const items = [
      { id: "b", label: "B" },
      { id: "d", label: "D" },
    ];

    assert.equal(resolveAuxiliaryLaunchProviderId(items, "d"), "d");
    assert.equal(resolveAuxiliaryLaunchProviderId(items, "missing"), "b");
  });

  /** 候補から現在値または先頭を初期選択し、どちらの場合も不要なフィードバックは出さない。 */
  it("初期 state は provider 解決と feedback を同時に返す", () => {
    const items = [
      { id: "b", label: "B" },
      { id: "d", label: "D" },
    ];

    assert.deepEqual(resolveAuxiliaryLaunchInitialState(items, "d"), {
      providerId: "d",
      feedback: "",
    });
    assert.deepEqual(resolveAuxiliaryLaunchInitialState(items, "missing"), {
      providerId: "b",
      feedback: "",
    });
  });

  /** ダイアログを閉じる状態には、前回のフィードバックを消す指定も含める。 */
  it("close state は dialog close と feedback empty を返す", () => {
    assert.deepEqual(resolveAuxiliaryLaunchCloseState(), {
      open: false,
      feedback: "",
    });
  });

  /** 選択変更では新しい Provider ID を採用し、旧選択のフィードバックを消す。 */
  it("provider 選択 state は providerId を引き継ぎ feedback empty を返す", () => {
    assert.deepEqual(
      resolveAuxiliaryLaunchProviderSelectionState("selected-id"),
      {
        providerId: "selected-id",
        feedback: "",
      },
    );
  });

  /** 例外のメッセージを保持し、Error でない値には既定の失敗通知を使う。 */
  it("start error feedback は Error message を優先し fallback 文言を返す", () => {
    assert.equal(
      resolveAuxiliaryLaunchStartErrorFeedback(new Error("failed")),
      "failed",
    );
    assert.equal(
      resolveAuxiliaryLaunchStartErrorFeedback("failed"),
      AUXILIARY_LAUNCH_START_FAILED_FEEDBACK,
    );
  });

  /** ダイアログを開くときは現在値か先頭候補を選び、初期通知は空にする。 */
  it("open state は provider 解決結果と feedback を反映し open を返す", () => {
    const items = [
      { id: "b", label: "B" },
      { id: "d", label: "D" },
    ];

    assert.deepEqual(resolveAuxiliaryLaunchOpenState(items, "d"), {
      open: true,
      providerId: "d",
      feedback: "",
    });
    assert.deepEqual(resolveAuxiliaryLaunchOpenState(items, "missing"), {
      open: true,
      providerId: "b",
      feedback: "",
    });
  });

  /** 通知のリセットは、フィードバックを空にする差分だけを返す。 */
  it("feedback reset state は feedback 空文字を返す", () => {
    assert.deepEqual(resolveAuxiliaryLaunchFeedbackResetState(), {
      feedback: "",
    });
  });

  /** 起動失敗は、ダイアログの表示や選択を変えずフィードバックだけを更新する。 */
  it("start error state は feedback のみを返す", () => {
    assert.deepEqual(
      resolveAuxiliaryLaunchStartErrorState(new Error("failed")),
      {
        feedback: "failed",
      },
    );
    assert.deepEqual(resolveAuxiliaryLaunchStartErrorState("failed"), {
      feedback: AUXILIARY_LAUNCH_START_FAILED_FEEDBACK,
    });
  });

  /** 許可されたときだけ開く操作に候補と選択値を渡し、拒否時にはコールバックを呼ばない。 */
  it("open handler は開始可能な場合だけ dialog open callback を呼ぶ", () => {
    const events: string[] = [];
    const providers = [{ id: "codex", label: "Codex" }];
    const open = createAuxiliaryLaunchDialogOpenHandler({
      /** 起動ダイアログの表示条件を満たすケースを作る。 */
      canOpen: () => true,
      providers,
      /** 開く操作に渡す既存の選択値を Codex に固定する。 */
      getSelectedProviderId: () => "codex",
      /** 開く操作に前回の選択と候補一覧が届いたことを、ID の並びとして記録する。 */
      openAuxiliaryLaunchDialog: (params) => {
        events.push(
          `${params.selectedProviderId}:${params.providers.map((provider) => provider.id).join(",")}`,
        );
      },
    });
    const blockedOpen = createAuxiliaryLaunchDialogOpenHandler({
      /** 同じ候補を持ちながらダイアログの表示条件だけを満たさないケースを作る。 */
      canOpen: () => false,
      providers,
      /** 拒否の原因が選択値の違いでないよう、許可ケースと同じ選択を用意する。 */
      getSelectedProviderId: () => "codex",
      /** 表示拒否なのにコールバックが呼ばれた場合、その誤呼出を記録する。 */
      openAuxiliaryLaunchDialog: () => {
        events.push("blocked");
      },
    });

    open();
    blockedOpen();

    assert.deepEqual(events, ["codex:codex"]);
  });

  /** 閉じられるときだけコールバックが一度呼ばれ、閉じられない状態では実行されないことを確認する。 */
  it("close handler は close 可能な場合だけ dialog close callback を呼ぶ", () => {
    const events: string[] = [];
    const close = createAuxiliaryLaunchDialogCloseHandler({
      /** 閉じる操作を受け付ける状態を返す。 */
      canClose: () => true,
      /** 許可された閉じるコールバックが実行されたことを記録する。 */
      closeAuxiliaryLaunchDialog: () => events.push("close"),
    });
    const blockedClose = createAuxiliaryLaunchDialogCloseHandler({
      /** 閉じる操作が許可されない状態を返す。 */
      canClose: () => false,
      /** 閉じる操作が拒否されたのに実行された場合を識別する。 */
      closeAuxiliaryLaunchDialog: () => events.push("blocked"),
    });

    close();
    blockedClose();

    assert.deepEqual(events, ["close"]);
  });

  /** 選択ハンドラーは受け取った Provider ID を変更せず選択先に渡す。 */
  it("provider select handler は provider id を select callback へ渡す", () => {
    const values: string[] = [];
    const selectProvider = createAuxiliaryLaunchProviderSelectHandler({
      /** 実際に選択操作へ渡った ID を、順序を保って記録する。 */
      selectAuxiliaryLaunchProvider: (providerId) => values.push(providerId),
    });

    selectProvider("copilot");

    assert.deepEqual(values, ["copilot"]);
  });

  /** 表示と通知だけを更新する差分では、既存の選択 Provider を変えない。 */
  it("apply した patch は指定フィールドのみ更新する", () => {
    let open = false;
    let providerId: string | null = "keep-provider";
    let feedback = "initial";

    applyAuxiliaryLaunchDialogState(
      (nextOpen) => {
        open = nextOpen;
      },
      (nextProviderId) => {
        providerId = nextProviderId;
      },
      (nextFeedback) => {
        feedback = nextFeedback;
      },
      { open: true, feedback: "" },
    );

    assert.equal(open, true);
    assert.equal(providerId, "keep-provider");
    assert.equal(feedback, "");
  });

  /** 候補一覧が空なら、現在の Provider を候補に加えず選択を未設定にする。 */
  it("provider が空のときは resolveAuxiliaryLaunchProviderId が null を返す", () => {
    const emptyItems: Array<{ id: string; label: string }> = [];

    assert.equal(resolveAuxiliaryLaunchProviderId(emptyItems, "codex"), null);
  });

  /** 起動可能な Provider がない初期状態では、未選択とともに候補がない旨を通知する。 */
  it("provider が空のときは初期 state の feedback が空 provider 用になる", () => {
    const emptyItems: Array<{ id: string; label: string }> = [];

    assert.deepEqual(resolveAuxiliaryLaunchInitialState(emptyItems, "codex"), {
      providerId: null,
      feedback: AUXILIARY_LAUNCH_NO_PROVIDER_FEEDBACK,
    });
  });
});
