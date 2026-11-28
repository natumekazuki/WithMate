import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCancelRetryDraftReplace,
  applyRetryDraftRestoreCommand,
  applyRetryDraftReplaceConfirmation,
  applyRetryEditCommand,
  buildRetryDraftRestoreState,
  createCancelRetryDraftReplaceHandler,
  createRetryDraftReplaceConfirmationHandler,
  createRetryEditHandler,
  isRetryActionDisabled,
  resolveRetrySource,
  resolveRetryKind,
  runRetryResendCommand,
  shouldProtectRetryEditDraft,
  shouldShowRetryActions,
} from "../../src/chat/retry-state.js";

/** 前回本文を復元し、末尾にカーソルを置き、確認待ちを解除してアクションドックを展開する状態を組み立てる。 */
test("buildRetryDraftRestoreState は retry 編集復元時の composer state を作る", () => {
  const restoreState = buildRetryDraftRestoreState("前回の依頼");

  assert.deepEqual(restoreState, {
    draft: "前回の依頼",
    caret: 5,
    isRetryDraftReplacePending: false,
    isActionDockPinnedExpanded: true,
  });
});

/** 再送禁止時と本文が未取得のときは送らず、取得済みの本文は空文字列であっても一度だけ渡す。 */
test("runRetryResendCommand は有効な last user message だけ再送する", async () => {
  const sends: string[] = [];

  await runRetryResendCommand({
    isDisabled: true,
    messageText: "前回の依頼",
    /** 禁止状態にもかかわらず本文が送られた場合に記録する。 */
    resendMessage: async (messageText) => {
      sends.push(messageText);
    },
  });
  await runRetryResendCommand({
    isDisabled: false,
    messageText: null,
    /** 本文が未取得なのに送信まで進んだ場合に記録する。 */
    resendMessage: async (messageText) => {
      sends.push(messageText);
    },
  });
  await runRetryResendCommand({
    isDisabled: false,
    messageText: "前回の依頼",
    /** 再送が許された前回本文を、実際の送信の代わりに記録する。 */
    resendMessage: async (messageText) => {
      sends.push(messageText);
    },
  });
  await runRetryResendCommand({
    isDisabled: false,
    messageText: "",
    /** 空文字列を未取得扱いで落としていないことを確認できるよう、送られた本文を記録する。 */
    resendMessage: async (messageText) => {
      sends.push(messageText);
    },
  });

  assert.deepEqual(sends, ["前回の依頼", ""]);
});

/** ドック展開から本文・カーソルの適用、確認待ち解除、再フォーカスまでの呼出し順と値を確認する。 */
test("applyRetryDraftRestoreCommand は retry draft restore state を UI setter に適用する", () => {
  const events: string[] = [];

  applyRetryDraftRestoreCommand({
    messageText: "前回の依頼",
    /** 本文やフォーカス操作の前にドックを開いたことを記録する。 */
    setActionDockPinnedExpanded: (expanded) =>
      events.push(`expanded:${expanded}`),
    /** 復元する下書きの本文を時系列に記録する。 */
    setDraft: (draft) => events.push(`draft:${draft}`),
    /** 復元時に指定されたカーソル位置を記録する。 */
    setCaret: (caret) => events.push(`caret:${caret}`),
    /** カーソルの状態更新に続く同期時の位置を記録する。 */
    syncCaret: (caret) => events.push(`sync:${caret}`),
    /** フォーカスを戻す前に確認待ちを解除したか記録する。 */
    setRetryDraftReplacePending: (pending) => events.push(`pending:${pending}`),
    /** 入力欄へ戻るフォーカスの位置を、最後のイベントとして記録する。 */
    focusComposer: (caret) => events.push(`focus:${caret}`),
  });

  assert.deepEqual(events, [
    "expanded:true",
    "draft:前回の依頼",
    "caret:5",
    "sync:5",
    "pending:false",
    "focus:5",
  ]);
});

/** 禁止中と本文未取得は何もせず、保護対象の下書きでは確認だけを求める。保護不要なら空本文もそのまま復元する。 */
test("applyRetryEditCommand は保護確認または draft 復元を選ぶ", () => {
  const events: string[] = [];

  applyRetryEditCommand({
    isDisabled: true,
    messageText: "前回の依頼",
    shouldProtectDraft: false,
    /** 禁止状態で確認画面が誤って開いた場合に記録する。 */
    requestDraftReplaceConfirmation: () => events.push("confirm"),
    /** 禁止状態ですでにある下書きに本文が渡された場合を検出する。 */
    restoreDraft: (messageText) => events.push(`restore:${messageText}`),
  });
  applyRetryEditCommand({
    isDisabled: false,
    messageText: null,
    shouldProtectDraft: false,
    /** 前回本文が取得できない場合も確認画面へ進まないことを観測する。 */
    requestDraftReplaceConfirmation: () => events.push("confirm"),
    /** 未取得の本文を下書きへ反映しようとした場合を記録する。 */
    restoreDraft: (messageText) => events.push(`restore:${messageText}`),
  });
  applyRetryEditCommand({
    isDisabled: false,
    messageText: "前回の依頼",
    shouldProtectDraft: true,
    /** 既存の下書きを保護するとき、即時復元の代わりに呼ばれる確認を記録する。 */
    requestDraftReplaceConfirmation: () => events.push("confirm"),
    /** 確認する前に保護対象の下書きを上書きする経路を検出する。 */
    restoreDraft: (messageText) => events.push(`restore:${messageText}`),
  });
  applyRetryEditCommand({
    isDisabled: false,
    messageText: "前回の依頼",
    shouldProtectDraft: false,
    /** 保護不要でも不要な確認を求めてしまう場合を記録する。 */
    requestDraftReplaceConfirmation: () => events.push("confirm"),
    /** 保護不要な状態で直接復元した前回本文を記録する。 */
    restoreDraft: (messageText) => events.push(`restore:${messageText}`),
  });
  applyRetryEditCommand({
    isDisabled: false,
    messageText: "",
    shouldProtectDraft: false,
    /** 空本文を復元するときに誤って確認へ進んだ場合を記録する。 */
    requestDraftReplaceConfirmation: () => events.push("confirm"),
    /** 空本文が通常の復元経路に渡されたことを記録する。 */
    restoreDraft: (messageText) => events.push(`restore:${messageText}`),
  });

  assert.deepEqual(events, ["confirm", "restore:前回の依頼", "restore:"]);
});

/** 編集用ハンドラーを起動すると、設定済みの前回本文が確認を挟まず復元される。 */
test("createRetryEditHandler は retry edit handler を作る", () => {
  const events: string[] = [];
  const editLastMessage = createRetryEditHandler({
    isDisabled: false,
    messageText: "前回の依頼",
    shouldProtectDraft: false,
    /** ハンドラーが保護不要の条件を失い確認に進んだ場合に記録する。 */
    requestDraftReplaceConfirmation: () => events.push("confirm"),
    /** ハンドラーの呼び出し時に復元された本文を捕捉する。 */
    restoreDraft: (messageText) => events.push(`restore:${messageText}`),
  });

  editLastMessage();

  assert.deepEqual(events, ["restore:前回の依頼"]);
});

/** 置換を承認しても無効状態や本文未取得なら復元せず、本文が空の場合は有効な復元として扱う。 */
test("applyRetryDraftReplaceConfirmation は有効な retry edit だけ draft を復元する", () => {
  const events: string[] = [];

  applyRetryDraftReplaceConfirmation({
    isDisabled: true,
    messageText: "前回の依頼",
    /** 承認時点でも操作が禁止なら復元が呼ばれないことを記録で確認する。 */
    restoreDraft: (messageText) => events.push(messageText),
  });
  applyRetryDraftReplaceConfirmation({
    isDisabled: false,
    messageText: undefined,
    /** 承認時点で本文が取得できなければ復元が呼ばれないことを確認する。 */
    restoreDraft: (messageText) => events.push(messageText),
  });
  applyRetryDraftReplaceConfirmation({
    isDisabled: false,
    messageText: "前回の依頼",
    /** 承認後に実際に下書きへ渡る前回本文を記録する。 */
    restoreDraft: (messageText) => events.push(messageText),
  });
  applyRetryDraftReplaceConfirmation({
    isDisabled: false,
    messageText: "",
    /** 承認した空本文の復元を、呼出しがなかったケースと区別して記録する。 */
    restoreDraft: (messageText) => events.push(messageText),
  });

  assert.deepEqual(events, ["前回の依頼", ""]);
});

/** 確認用ハンドラーが前回本文の復元を設定どおりに呼ぶことを確認する。 */
test("createRetryDraftReplaceConfirmationHandler は retry draft replace confirmation handler を作る", () => {
  const events: string[] = [];
  const confirmRetryDraftReplace = createRetryDraftReplaceConfirmationHandler({
    isDisabled: false,
    messageText: "前回の依頼",
    /** 確認ボタンに相当する呼出しが復元へ渡した本文を記録する。 */
    restoreDraft: (messageText) => events.push(messageText),
  });

  confirmRetryDraftReplace();

  assert.deepEqual(events, ["前回の依頼"]);
});

/** 置換確認を取り消すと、置換承認待ちフラグを false にする。 */
test("applyCancelRetryDraftReplace は retry draft replace pending を解除する", () => {
  const values: boolean[] = [];

  applyCancelRetryDraftReplace({
    /** 取り消し処理が設定した確認待ちフラグを記録する。 */
    setRetryDraftReplacePending: (pending) => values.push(pending),
  });

  assert.deepEqual(values, [false]);
});

/** 取り消しボタン用のハンドラーを呼ぶと、置換確認の待機が解除される。 */
test("createCancelRetryDraftReplaceHandler は retry draft replace cancel handler を作る", () => {
  const values: boolean[] = [];
  const cancelRetryDraftReplace = createCancelRetryDraftReplaceHandler({
    /** ハンドラーが待機解除の値を状態更新へ渡したことを記録する。 */
    setRetryDraftReplacePending: (pending) => values.push(pending),
  });

  cancelRetryDraftReplace();

  assert.deepEqual(values, [false]);
});

// @test-value v2
// kind = "invariant"
// claim = "retry種別は実行状態と最新の最小turn phaseからinterrupted/failed/canceledを区別する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: terminal state後の再送導線" }
// fault = "正常完了をcanceledとして扱うか取消後の再送導線を落とす"
// observable = "resolveRetryKindのkind"
// observation_boundary = "consumer"
// scope = "retry-terminal-kind"
// lifecycle = "permanent"
// @end-test-value
/** 中断・失敗・キャンセルを別々の再試行理由にし、正常完了と新たな実行中には再試行理由を付けない。 */
test("resolveRetryKind は session state と 最小turn から retry 種別を解決する", () => {
  assert.equal(resolveRetryKind({ runState: "interrupted" }), "interrupted");
  assert.equal(resolveRetryKind({ runState: "error" }), "failed");
  assert.equal(
    resolveRetryKind({ runState: "idle", latestTurnPhase: "canceled" }),
    "canceled",
  );
  assert.equal(
    resolveRetryKind({ runState: "idle", latestTurnPhase: "completed" }),
    null,
  );
  assert.equal(
    resolveRetryKind({ runState: "running", latestTurnPhase: "failed" }),
    null,
  );
  assert.equal(
    resolveRetryKind({ runState: "running", latestTurnPhase: "canceled" }),
    null,
  );
});

// @test-value v2
// kind = "invariant"
// claim = "再送元は最新userと同じSession/message位置の最小turnだけに関連付ける"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: terminal state後の再送導線" }
// fault = "別会話や古いuser位置の取消turnを再送元へ誤関連付けする"
// observable = "retry sourceのkind/lastRequestText/terminalTurnとnull結果"
// observation_boundary = "consumer"
// scope = "retry-owner-sequence"
// lifecycle = "permanent"
// @end-test-value
/** 他 Session や古い依頼の終端記録を使わず、履歴の最新依頼に合う記録を採用し、記録なしでも Session の失敗状態を扱う。 */
test("resolveRetrySource は最後の未完了依頼と同じ session / message seq の terminal event だけを使う", () => {
  const canceled = {
    id: 10,
    sessionId: "session-1",
    createdAt: "2026-08-12T10:00:00.000Z",
    phase: "canceled" as const,
    provider: "codex",
    model: "gpt-5.6",
    reasoningEffort: "medium" as const,
    approvalMode: "never" as const,
    userMessageSeq: 0,
    assistantMessageSeq: 1,
    threadId: "thread-1",
    errorMessage: "canceled",
  };
  const completed = {
    ...canceled,
    id: 11,
    phase: "completed" as const,
    userMessageSeq: 2,
    assistantMessageSeq: 3,
    errorMessage: "",
  };
  const nextMessages = [
    { role: "user" as const, text: "古い依頼" },
    { role: "assistant" as const, text: "キャンセルしたよ" },
    { role: "user" as const, text: "新しい依頼" },
  ];

  assert.deepEqual(
    resolveRetrySource({
      sessionId: "session-1",
      messages: nextMessages.slice(0, 2),
      latestTurn: canceled,
      runState: "idle",
    }),
    {
      kind: "canceled",
      lastRequestText: "古い依頼",
      userMessageSeq: 0,
      terminalTurn: canceled,
    },
  );

  assert.equal(
    resolveRetrySource({
      sessionId: "session-1",
      messages: nextMessages,
      latestTurn: canceled,
      runState: "running",
    }),
    null,
  );

  assert.equal(
    resolveRetrySource({
      sessionId: "session-1",
      messages: [...nextMessages, { role: "assistant", text: "完了したよ" }],
      latestTurn: completed,
      runState: "idle",
    }),
    null,
  );

  assert.equal(
    resolveRetrySource({
      sessionId: "session-1",
      messages: [...nextMessages, { role: "assistant", text: "完了したよ" }],
      latestTurn: completed,
      runState: "idle",
    }),
    null,
  );

  assert.equal(
    resolveRetrySource({
      sessionId: "session-1",
      messages: [...nextMessages, { role: "assistant", text: "完了したよ" }],
      latestTurn: canceled,
      runState: "idle",
    }),
    null,
  );

  assert.equal(
    resolveRetrySource({
      sessionId: "session-1",
      messages: nextMessages,
      latestTurn: { ...canceled, sessionId: "auxiliary-1", userMessageSeq: 2 },
      runState: "idle",
    }),
    null,
  );

  assert.deepEqual(
    resolveRetrySource({
      sessionId: "session-1",
      messages: nextMessages,
      latestTurn: null,
      runState: "error",
    }),
    {
      kind: "failed",
      lastRequestText: "新しい依頼",
      userMessageSeq: 2,
      terminalTurn: null,
    },
  );
});

// @test-value v2
// kind = "invariant"
// claim = "Editは前回依頼とは異なる非空draftだけを置換確認の対象にする"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: terminal state 後の再送導線" }
// fault = "異なるdraftを無確認で上書きするか空draftの復元を阻む"
// observable = "shouldProtectRetryEditDraftのboolean"
// observation_boundary = "consumer"
// scope = "retry-edit-draft-protection"
// lifecycle = "permanent"
// @end-test-value
/** 前回本文と異なる既存下書きだけを保護し、空・同内容・再試行対象なしの場合は確認を要求しない。 */
test("shouldProtectRetryEditDraft は既存 draft の暗黙上書きを避ける", () => {
  const retryState = { lastRequestText: "前回の依頼" };

  assert.equal(shouldProtectRetryEditDraft({ retryState, draft: "" }), false);
  assert.equal(
    shouldProtectRetryEditDraft({ retryState, draft: "前回の依頼" }),
    false,
  );
  assert.equal(
    shouldProtectRetryEditDraft({ retryState, draft: "今の下書き" }),
    true,
  );
  assert.equal(
    shouldProtectRetryEditDraft({ retryState: null, draft: "今の下書き" }),
    false,
  );
});

// @test-value v2
// kind = "invariant"
// claim = "回復操作の表示可否は会話種別によらず前回依頼・編集権限・実行状態で決まる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: terminal state 後の再送導線" }
// fault = "依頼なしやread-onlyや実行中に回復操作を許可する"
// observable = "shouldShowRetryActionsのboolean"
// observation_boundary = "consumer"
// scope = "retry-action-visibility-guard"
// lifecycle = "permanent"
// @end-test-value
/** 失敗した Session に再試行元の本文がある場合だけ操作を表示し、読み取り専用または実行中は表示しない。 */
test("shouldShowRetryActions は mode-neutral な表示 precondition を評価する", () => {
  assert.equal(
    shouldShowRetryActions({
      hasLastUserMessage: true,
      isReadOnly: false,
      runState: "error",
    }),
    true,
  );
  assert.equal(
    shouldShowRetryActions({
      hasLastUserMessage: false,
      isReadOnly: false,
      runState: "error",
    }),
    false,
  );
  assert.equal(
    shouldShowRetryActions({
      hasLastUserMessage: true,
      isReadOnly: true,
      runState: "error",
    }),
    false,
  );
  assert.equal(
    shouldShowRetryActions({
      hasLastUserMessage: true,
      isReadOnly: false,
      runState: "running",
    }),
    false,
  );
});

// @test-value v2
// kind = "invariant"
// claim = "回復状態と前回依頼がある編集可能な非実行中会話だけが再送操作できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: terminal state 後の再送導線" }
// fault = "blockedまたはread-only会話で再送できるか回復対象なしで再送できる"
// observable = "isRetryActionDisabledのboolean"
// observation_boundary = "consumer"
// scope = "retry-action-disabled-guard"
// lifecycle = "permanent"
// @end-test-value
/** 操作を表示できても、Composer のブロック、読み取り専用、本文や再試行状態の欠落、実行中なら無効にする。 */
test("isRetryActionDisabled は shared precondition を評価する", () => {
  const retryState = {
    kind: "failed" as const,
    lastRequestText: "直して",
  };

  assert.equal(
    isRetryActionDisabled({
      retryState,
      hasLastUserMessage: true,
      composerBlocked: false,
      isReadOnly: false,
      runState: "idle",
    }),
    false,
  );
  assert.equal(
    isRetryActionDisabled({
      retryState,
      hasLastUserMessage: true,
      composerBlocked: true,
      isReadOnly: false,
      runState: "idle",
    }),
    true,
  );
  assert.equal(
    isRetryActionDisabled({
      retryState,
      hasLastUserMessage: true,
      composerBlocked: false,
      isReadOnly: true,
      runState: "idle",
    }),
    true,
  );
  assert.equal(
    isRetryActionDisabled({
      retryState: null,
      hasLastUserMessage: true,
      composerBlocked: false,
      isReadOnly: false,
      runState: "idle",
    }),
    true,
  );
  assert.equal(
    isRetryActionDisabled({
      retryState,
      hasLastUserMessage: false,
      composerBlocked: false,
      isReadOnly: false,
      runState: "idle",
    }),
    true,
  );
  assert.equal(
    isRetryActionDisabled({
      retryState,
      hasLastUserMessage: true,
      composerBlocked: false,
      isReadOnly: false,
      runState: "running",
    }),
    true,
  );
});
