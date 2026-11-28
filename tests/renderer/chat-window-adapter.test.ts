import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildLiveSessionContextPaneProps,
  buildLiveSessionCompactActionDockProps,
  buildLiveSessionComposerDockProps,
  buildLiveSessionComposerProps,
  buildLiveSessionMessageColumnProps,
  buildLiveSessionSplitterProps,
  buildStaticTextChatComposerCapabilityProps,
  createStaticChatCharacterProfile,
  createStaticChatComposerSendability,
  createHiddenControlsTextChatComposerProps,
  createIdleChatMessageColumnProps,
  createStaticChatCompactActionDockProps,
  createStaticChatHeaderProps,
  createStaticTextChatCompactActionDockProps,
  isStaticChatSendDisabled,
  staticTextChatRuntimeComposerCapabilityDefaults,
  toConversationMessages,
} from "../../src/chat/chat-window-adapter.js";
import { buildAuxiliaryAwareRuntimeOptionChangeHandler } from "../../src/chat/auxiliary-runtime-option-routing.js";
import {
  buildAuxiliaryAwareSendOrCancelHandler,
  buildSessionStopTarget,
  resolveAuxiliaryAwareSendOrCancelAction,
  resolveSelectedSessionIsRunning,
  resolveSelectedSessionRunState,
} from "../../src/chat/send-or-cancel.js";
import {
  ChatWindow,
  type ChatWindowProps,
} from "../../src/chat/chat-window.js";
import { buildLiveSessionWindowShellProps } from "../../src/chat/live-session-window-props.js";
import { createSessionFilesActions } from "../../src/chat/session-files-actions.js";

/** 表示値だけを検査するケースに、副作用のない操作コールバックを渡す。 */
const noop = () => {};

// @test-value v2
// kind = "contract"
// claim = "Session FolderのExplorerと外部Terminalを対象込みのaccessible nameとtooltipで識別できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window" }
// fault = "icon操作からSession Folderという対象や外部Terminalという操作種別を失う"
// observable = "各buttonのaria-labelとtitle"
// observation_boundary = "component-behavior"
// scope = "Session Folder header actions"
// lifecycle = "permanent"
// impact = "Workspaceや内蔵Terminalと取り違えずに操作を選べる"
// distinction = "型検査では検出できない対象込みの操作名を、builder組込みtestとは独立して確認する"
// @end-test-value
/** Session Folderを開く二つの操作で、対象と操作種別が読み上げ名とツールチップに残ることを確認する。 */
test("createSessionFilesActions は共通の session files action group を描画する", () => {
  const html = renderToStaticMarkup(
    createSessionFilesActions({
      onOpenExplorer: noop,
      onOpenTerminal: noop,
    }),
  );

  assert.match(
    html,
    /aria-label="Open Session Folder In Explorer" title="Open Session Folder In Explorer"/,
  );
  assert.match(
    html,
    /aria-label="Open External Terminal In Session Folder" title="Open External Terminal In Session Folder"/,
  );
});

/** AuxiliaryとMainがともに実行中なら、Auxiliaryの停止だけを発行する。 */
test("buildAuxiliaryAwareSendOrCancelHandler は auxiliary が running のときに優先 cancel する", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareSendOrCancelHandler({
    shouldSendAuxiliary: true,
    isAuxiliarySessionRunning: true,
    isSelectedSessionRunning: true,
    preferAuxiliarySendOverSelectedCancel: true,
    /** Auxiliaryへ停止が送られたことを記録する。 */
    onCancelAuxiliaryRun: () => {
      calls.push("cancel-aux");
    },
    /** 実行中のAuxiliaryへの誤送信を検出する。 */
    onSendAuxiliary: () => {
      calls.push("send-aux");
    },
    /** Mainへ停止が誤配信された場合に記録する。 */
    onCancelSelectedSessionRun: () => {
      calls.push("cancel-main");
    },
    /** Mainへの送信が選ばれた場合に記録する。 */
    onSendSelectedSession: () => {
      calls.push("send-main");
    },
  });

  handler();
  assert.deepEqual(calls, ["cancel-aux"]);
});

/** 両方が実行中なら、実行中のAuxiliaryを止める操作を選ぶ。 */
test("resolveAuxiliaryAwareSendOrCancelAction は auxiliary running を最優先する", () => {
  assert.equal(
    resolveAuxiliaryAwareSendOrCancelAction({
      shouldSendAuxiliary: true,
      isAuxiliarySessionRunning: true,
      isSelectedSessionRunning: true,
      preferAuxiliarySendOverSelectedCancel: true,
    }),
    "cancel-auxiliary",
  );
});

/** Auxiliary優先指定で入力先が待機中なら、Mainが実行中でもAuxiliaryへの送信を選ぶ。 */
test("resolveAuxiliaryAwareSendOrCancelAction は auxiliary 優先なら selected cancel より auxiliary send を返す", () => {
  assert.equal(
    resolveAuxiliaryAwareSendOrCancelAction({
      shouldSendAuxiliary: true,
      isAuxiliarySessionRunning: false,
      isSelectedSessionRunning: true,
      preferAuxiliarySendOverSelectedCancel: true,
    }),
    "send-auxiliary",
  );
});

/** 優先指定がなければ、Mainの停止を待機中Auxiliaryへの送信より優先する。 */
test("resolveAuxiliaryAwareSendOrCancelAction は selected running を auxiliary send より優先できる", () => {
  assert.equal(
    resolveAuxiliaryAwareSendOrCancelAction({
      shouldSendAuxiliary: true,
      isAuxiliarySessionRunning: false,
      isSelectedSessionRunning: true,
    }),
    "cancel-selected",
  );
});

/** Auxiliary宛てではなくMainが実行中なら、Mainの停止を選ぶ。 */
test("resolveAuxiliaryAwareSendOrCancelAction は auxiliary がなく selected running なら selected cancel を返す", () => {
  assert.equal(
    resolveAuxiliaryAwareSendOrCancelAction({
      shouldSendAuxiliary: false,
      isAuxiliarySessionRunning: false,
      isSelectedSessionRunning: true,
    }),
    "cancel-selected",
  );
});

/** どちらの会話にも停止すべき実行がなければ、Mainへの送信を選ぶ。 */
test("resolveAuxiliaryAwareSendOrCancelAction は auxiliary も running selected もなければ selected send を返す", () => {
  assert.equal(
    resolveAuxiliaryAwareSendOrCancelAction({
      shouldSendAuxiliary: false,
      isAuxiliarySessionRunning: false,
      isSelectedSessionRunning: false,
    }),
    "send-selected",
  );
});

// @test-value v2
// kind = "contract"
// claim = "表示中のowner世代と一致する保存Turnまたは正確な開始receiptだけをGUI Cancelの対象にする"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/975 — 項目4" }
// fault = "別世代のlive／receiptを採用するか、Turn IDがない場合にSessionだけでStopを組み立てる"
// observable = "表示済みownerと実行から作成したStop対象値または対象なし"
// observation_boundary = "implementation"
// scope = "Main/Aux共通の表示済み実行からStop対象を選ぶprojection"
// lifecycle = "permanent"
// distinction = "IPC側の拒否に加え、rendererが読取中・切替中に対象を推定しない契約を検証する"
// @end-test-value
/** 同じ世代の保存ターンを優先し、ターンがない開始段階だけ一致する受付証で停止する。 */
test("GUI Cancel uses the saved Turn or claim only from the selected incarnation", () => {
  const owner = { sessionId: "session", incarnationId: "generation" };
  const claim = { ...owner, receiptId: "starting" };
  const stale = { incarnationId: "old", turnId: "old-turn" };
  assert.equal(
    buildSessionStopTarget(owner, stale, { ...claim, incarnationId: "old" }),
    null,
  );
  assert.equal(buildSessionStopTarget(owner, {}), null);
  assert.deepEqual(buildSessionStopTarget(owner, stale, claim), {
    request: { ...owner, execution: { kind: "receipt", id: "starting" } },
    receiptId: "starting",
  });
  assert.deepEqual(
    buildSessionStopTarget(
      owner,
      { ...owner, turnId: "turn", receiptId: "starting" },
      claim,
    ),
    {
      request: { ...owner, execution: { kind: "turn", id: "turn" } },
      receiptId: "starting",
    },
  );
});

/** Sessionが待機中と確定していれば、古いライブ通知が残っても実行中にしない。 */
test("resolveSelectedSessionRunState は session runState を live run より優先する", () => {
  assert.equal(
    resolveSelectedSessionRunState({
      runState: "idle",
      hasLiveRun: true,
    }),
    "idle",
  );
});

/** Sessionの実行状態が得られない場合だけ、ライブ通知やターン情報から実行中を補う。 */
test("resolveSelectedSessionRunState は runState 未取得時に live run / turnRunning で running にする", () => {
  assert.equal(
    resolveSelectedSessionRunState({
      runState: null,
      hasLiveRun: true,
    }),
    "running",
  );
  assert.equal(
    resolveSelectedSessionRunState({
      runState: undefined,
      isTurnRunning: true,
    }),
    "running",
  );
});

/** 実行中のスナップショットか進行中のターンがある場合は、選択セッションを実行中とみなす。 */
test("resolveSelectedSessionIsRunning は runState と turnRunning を見る", () => {
  assert.equal(resolveSelectedSessionIsRunning({ runState: "running" }), true);
  assert.equal(
    resolveSelectedSessionIsRunning({ runState: "idle", isTurnRunning: true }),
    true,
  );
  assert.equal(resolveSelectedSessionIsRunning({ runState: "idle" }), false);
});

/** Auxiliary宛てを優先するときはMainを停止せず、新しい要求をAuxiliaryへ送る。 */
test("buildAuxiliaryAwareSendOrCancelHandler は auxiliary 優先なら selected running より auxiliary send を使う", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareSendOrCancelHandler({
    shouldSendAuxiliary: true,
    isAuxiliarySessionRunning: false,
    isSelectedSessionRunning: true,
    preferAuxiliarySendOverSelectedCancel: true,
    /** 待機中Auxiliaryの停止が呼ばれたときに履歴へ残す。 */
    onCancelAuxiliaryRun: () => {
      calls.push("cancel-aux");
    },
    /** 優先指定で選択されたAuxiliaryへの送信を記録する。 */
    onSendAuxiliary: () => {
      calls.push("send-aux");
    },
    /** Auxiliaryへの送信よりMainの停止が選ばれた場合に記録する。 */
    onCancelSelectedSessionRun: () => {
      calls.push("cancel-main");
    },
    /** 優先先以外のMainへ送信された場合に記録する。 */
    onSendSelectedSession: () => {
      calls.push("send-main");
    },
  });

  handler();
  assert.deepEqual(calls, ["send-aux"]);
});

/** Mainの停止を優先する構成では、待機中Auxiliaryへ送信しない。 */
test("buildAuxiliaryAwareSendOrCancelHandler は selected running 優先なら auxiliary send より selected cancel を使う", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareSendOrCancelHandler({
    shouldSendAuxiliary: true,
    isAuxiliarySessionRunning: false,
    isSelectedSessionRunning: true,
    /** Auxiliaryの停止を誤って発行した場合に履歴へ残す。 */
    onCancelAuxiliaryRun: () => {
      calls.push("cancel-aux");
    },
    /** Main停止の代わりにAuxiliaryへ送信されたときに記録する。 */
    onSendAuxiliary: () => {
      calls.push("send-aux");
    },
    /** 優先対象のMainへ停止が届いたことを控える。 */
    onCancelSelectedSessionRun: () => {
      calls.push("cancel-main");
    },
    /** Mainの実行中に新規送信が発生した場合に記録する。 */
    onSendSelectedSession: () => {
      calls.push("send-main");
    },
  });

  handler();
  assert.deepEqual(calls, ["cancel-main"]);
});

/** Mainが待機中なら、Auxiliaryを宛先とする送信を選ぶ。 */
test("buildAuxiliaryAwareSendOrCancelHandler は selected idle なら auxiliary send を使う", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareSendOrCancelHandler({
    shouldSendAuxiliary: true,
    isAuxiliarySessionRunning: false,
    isSelectedSessionRunning: false,
    /** 待機中のAuxiliaryへ誤って停止が送られた場合に控える。 */
    onCancelAuxiliaryRun: () => {
      calls.push("cancel-aux");
    },
    /** Auxiliaryが送信先になったことを記録する。 */
    onSendAuxiliary: () => {
      calls.push("send-aux");
    },
    /** 待機中Mainの停止が選ばれた場合に控える。 */
    onCancelSelectedSessionRun: () => {
      calls.push("cancel-main");
    },
    /** Auxiliaryを選択した状態でMain送信が選ばれたら検出する。 */
    onSendSelectedSession: () => {
      calls.push("send-main");
    },
  });

  handler();
  assert.deepEqual(calls, ["send-aux"]);
});

/** Auxiliaryへ送らない場合、実行中のMainを停止する。 */
test("buildAuxiliaryAwareSendOrCancelHandler は auxiliary がなく main running のとき main cancel を使う", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareSendOrCancelHandler({
    shouldSendAuxiliary: false,
    isAuxiliarySessionRunning: false,
    isSelectedSessionRunning: true,
    /** Auxiliaryのない状態でその停止を選んだときに記録する。 */
    onCancelAuxiliaryRun: () => {
      calls.push("cancel-aux");
    },
    /** Auxiliaryのない状態でその送信を選んだときに記録する。 */
    onSendAuxiliary: () => {
      calls.push("send-aux");
    },
    /** 実行中のMainを停止したことを記録する。 */
    onCancelSelectedSessionRun: () => {
      calls.push("cancel-main");
    },
    /** Main停止ではなく送信した場合も履歴へ加える。 */
    onSendSelectedSession: () => {
      calls.push("send-main");
    },
  });

  handler();
  assert.deepEqual(calls, ["cancel-main"]);
});

/** Auxiliaryの選択も実行中のMainもなければ、通常のMain送信にする。 */
test("buildAuxiliaryAwareSendOrCancelHandler は auxiliary/main どちらもないとき main send を使う", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareSendOrCancelHandler({
    shouldSendAuxiliary: false,
    isAuxiliarySessionRunning: false,
    isSelectedSessionRunning: false,
    /** 送信可能な状態でAuxiliaryの停止を選んだら控える。 */
    onCancelAuxiliaryRun: () => {
      calls.push("cancel-aux");
    },
    /** 存在しないAuxiliaryに送信した場合に記録する。 */
    onSendAuxiliary: () => {
      calls.push("send-aux");
    },
    /** 停止対象がないMainを止めようとしたら記録する。 */
    onCancelSelectedSessionRun: () => {
      calls.push("cancel-main");
    },
    /** 通常のMain送信が選ばれたことを履歴へ加える。 */
    onSendSelectedSession: () => {
      calls.push("send-main");
    },
  });

  handler();
  assert.deepEqual(calls, ["send-main"]);
});

/** Auxiliary選択中にモデル変更を行うと、その値はAuxiliaryにだけ渡す。 */
test("buildAuxiliaryAwareRuntimeOptionChangeHandler は auxiliary があるとき auxiliary handler を使う", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareRuntimeOptionChangeHandler<string>({
    shouldUseAuxiliary: true,
    /** Auxiliaryのモデル更新先で受け取ったIDを控える。 */
    onAuxiliaryChange: (value) => {
      calls.push(`aux:${value}`);
    },
    /** 同じモデルがMainにも渡された場合に記録する。 */
    onSelectedSessionChange: (value) => {
      calls.push(`main:${value}`);
    },
  });

  handler("codex-4");
  assert.deepEqual(calls, ["aux:codex-4"]);
});

/** Auxiliaryを選択していない場合、モデル変更をMainだけへ渡す。 */
test("buildAuxiliaryAwareRuntimeOptionChangeHandler は auxiliary がないとき main handler を使う", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareRuntimeOptionChangeHandler<string>({
    shouldUseAuxiliary: false,
    /** 選択していないAuxiliaryへ値が流れた場合に記録する。 */
    onAuxiliaryChange: (value) => {
      calls.push(`aux:${value}`);
    },
    /** モデルの選択値をMainが受け取ったことを記録する。 */
    onSelectedSessionChange: (value) => {
      calls.push(`main:${value}`);
    },
  });

  handler("codex-4");
  assert.deepEqual(calls, ["main:codex-4"]);
});

/** モデルIDだけでなく推論深度も型を保ったままAuxiliaryの更新先へ渡す。 */
test("buildAuxiliaryAwareRuntimeOptionChangeHandler は reasoningEffort 型も generic で扱える", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareRuntimeOptionChangeHandler<
    "low" | "medium" | "high"
  >({
    shouldUseAuxiliary: true,
    /** Auxiliaryが受け取った推論深度を記録する。 */
    onAuxiliaryChange: (value) => {
      calls.push(`aux:${value}`);
    },
    /** 推論深度が誤ってMainへ渡された場合に控える。 */
    onSelectedSessionChange: (value) => {
      calls.push(`main:${value}`);
    },
  });

  handler("high");
  assert.deepEqual(calls, ["aux:high"]);
});

/** 静的会話のアダプターに渡す最小のMateプロフィールを作る。 */
function createCharacter(): ChatWindowProps["messageColumnProps"]["character"] {
  return createStaticChatCharacterProfile({ id: "mate", name: "Mate" });
}

// @test-value v2
// kind = "invariant"
// claim = "静的会話headerはtitleを保持し実行Session用rename/terminal/delete操作を公開しない"
// oracle = { type = "contract", ref = "src/chat/chat-window-adapter.ts" }
// fault = "静的会話に実行Session向け管理操作を混入する"
// observable = "titleDraftとshowRenameButton/showTerminalButton/showDeleteButton"
// observation_boundary = "consumer"
// scope = "static-header-capabilities"
// lifecycle = "permanent"
// @end-test-value
/** 静的会話はタイトルを初期表示しても、セッション固有の改名・端末・削除を公開しない。 */
test("createStaticChatHeaderProps は操作を隠す header 既定値を補う", () => {
  const headerProps = createStaticChatHeaderProps({
    taskTitle: "メイトーク",
    isRunning: false,
  });

  assert.equal(headerProps.taskTitle, "メイトーク");
  assert.equal(headerProps.titleDraft, "メイトーク");
  assert.equal(headerProps.isEditingTitle, false);
  assert.equal(headerProps.showRenameButton, false);
  assert.equal(headerProps.showTerminalButton, false);
  assert.equal(headerProps.showDeleteButton, false);
});

// @test-value v2
// kind = "invariant"
// claim = "live session message column projection が bookmark toggle callback を共通propsへ保持する"
// oracle = { type = "contract", ref = "docs/features/message-bookmark-filter.md: UI仕様" }
// fault = "buildLiveSessionMessageColumnProps が入力された onToggleMessageBookmark を返却propsから落とす"
// observable = "返却された message column props の onToggleMessageBookmark"
// observation_boundary = "component-behavior"
// scope = "chat-window-adapter-message-bookmark"
// lifecycle = "permanent"
// distinction = "TypeScript の optional property 検査では検出できない adapter のcallback転送漏れを直接確認する"
// @end-test-value
/** ライブ会話の表示と空応答の扱いを投影し、コピー・引用・ブックマークのコールバックを保つ。 */
test("buildLiveSessionMessageColumnProps は live message props を共通形式で組み立てる", () => {
  const messageListRef = React.createRef<HTMLDivElement>();
  /** コピー操作の参照を入力と返却値で比較するための目印。 */
  const onCopyMessageText = () => {};
  /** 引用操作が差し替わっていないことを確認するための目印。 */
  const onQuoteMessageText = () => {};
  /** ブックマーク切替が返却値から落ちないことを確かめる参照。 */
  const onToggleMessageBookmark = () => {};
  const messageColumnInput = {
    sessionId: "session-id",
    character: createCharacter(),
    messages: [{ role: "assistant", text: "こんにちは" }],
    expandedArtifacts: {},
    messageListRef,
    isRunning: false,
    liveApprovalRequest: null,
    approvalActionRequestId: null,
    liveElicitationRequest: null,
    elicitationActionRequestId: null,
    liveRunAssistantText: "生成中",
    pendingMessageText: "Preparing a response",
    pendingMessageTextVisible: false,
    liveRunErrorMessage: "",
    isMessageListFollowing: true,
    /** メッセージのスクロールは入力値を満たすだけで、実際には行わない。 */
    onMessageListScroll: () => {},
    /** この投影テストでは成果物を展開しない。 */
    onToggleArtifact: () => {},
    /** 成果物の詳細は不要なため、空の応答を返す。 */
    onLoadArtifactDetail: async () => null,
    /** 差分を開かずメッセージ列の投影だけを検査する。 */
    onOpenDiff: () => {},
    /** 承認を解決する実行は行わない。 */
    onResolveLiveApproval: () => {},
    /** 追加確認に応答する経路は観測対象外とする。 */
    onResolveLiveElicitation: () => {},
    /** パスの表示内容や開封結果は、このコールバックでは調べない。 */
    onOpenPath: () => {},
    onCopyMessageText,
    onQuoteMessageText,
    onToggleMessageBookmark,
  } satisfies Parameters<typeof buildLiveSessionMessageColumnProps>[0];
  const composerMessageColumnProps =
    buildLiveSessionMessageColumnProps(messageColumnInput);
  const explicitEmptyMessageColumnProps = buildLiveSessionMessageColumnProps({
    ...messageColumnInput,
    hasLiveRunAssistantText: false,
  });

  assert.equal(composerMessageColumnProps.sessionId, "session-id");
  assert.equal(composerMessageColumnProps.liveRunAssistantText, "生成中");
  assert.equal(composerMessageColumnProps.hasLiveRunAssistantText, true);
  assert.equal(
    composerMessageColumnProps.pendingMessageText,
    "Preparing a response",
  );
  assert.equal(composerMessageColumnProps.pendingMessageTextVisible, false);
  assert.equal(explicitEmptyMessageColumnProps.hasLiveRunAssistantText, false);
  assert.equal(composerMessageColumnProps.onCopyMessageText, onCopyMessageText);
  assert.equal(
    composerMessageColumnProps.onQuoteMessageText,
    onQuoteMessageText,
  );
  assert.equal(
    composerMessageColumnProps.onToggleMessageBookmark,
    onToggleMessageBookmark,
  );
});

// @test-value v2
// kind = "contract"
// claim = "live session composer adapterはownerが指定した操作capabilityを保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#ui-implementation-boundary: provider差分はcapabilityとして注入する" }
// fault = "明示された操作capabilityを共通既定値で上書きし、非対応操作を表示または対応操作を隠す"
// observable = "enabled/disabledそれぞれの入力に対する返却composer propsの5表示flag"
// observation_boundary = "component-behavior"
// scope = "chat-window-adapter.live-composer"
// lifecycle = "permanent"
// distinction = "adapterの表示capability projectionをDOMではなく共通props値で確認する"
// @end-test-value
/** 入力の所有者が許可・禁止した五つの操作群を、そのままComposerの表示可否へ渡す。 */
test("buildLiveSessionComposerProps は owner の操作capabilityを保持する", () => {
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  const input: Parameters<typeof buildLiveSessionComposerProps>[0] = {
    isRunning: false,
    composerBlocked: false,
    canSelectCustomAgent: false,
    isAgentPickerOpen: false,
    isSkillPickerOpen: false,
    isAdditionalDirectoryListOpen: false,
    selectedCustomAgentLabel: "Agent",
    selectedCustomAgentTitle: "",
    additionalDirectoryCount: 0,
    showJumpToBottom: false,
    isCustomAgentListLoading: false,
    customAgentItems: [],
    draft: "",
    composerTextareaRef,
    isComposerDisabled: false,
    isSendDisabled: true,
    composerSendability: {
      primaryFeedback: "",
      secondaryFeedback: [],
      feedbackTone: null,
      shouldShowFeedback: false,
    },
    sendButtonTitle: undefined,
    isComposerBlockedFeedbackActive: false,
    approvalOptions: [{ value: "never", label: "never" }],
    selectedApprovalMode: "never",
    speedOptions: [],
    selectedCodexSpeed: "standard",
    sandboxOptions: [],
    selectedCodexSandboxMode: "workspace-write",
    modelOptions: [
      {
        value: "gpt-test",
        label: "GPT Test",
        model: { id: "gpt-test", label: "GPT Test", reasoningEfforts: [] },
      },
    ],
    selectedModel: "gpt-test",
    selectedModelFallbackLabel: "GPT Test",
    reasoningOptions: [{ value: "low", label: "low" }],
    selectedReasoningEffort: "low",
    /** 添付操作の表示フラグだけを調べ、ファイル選択は行わない。 */
    onPickFile: () => {},
    /** 添付先フォルダーのダイアログは出さない。 */
    onPickFolder: () => {},
    /** 画像の選択は呼び出さず、添付グループの表示だけを読む。 */
    onPickImage: () => {},
    /** エージェント候補の表示可否を確認し、一覧は開かない。 */
    onToggleAgentPicker: () => {},
    /** スキルの操作可否の入力だけを渡し、パネルは切り替えない。 */
    onToggleSkillPicker: () => {},
    /** 追加ディレクトリを実際には登録せず、操作グループの表示を検査する。 */
    onAddAdditionalDirectory: () => {},
    /** ディレクトリ検証は正常として、許可フラグと独立にする。 */
    onValidateAdditionalDirectory: async () => ({ valid: true }),
    /** ディレクトリ一覧の開閉状態は変更しない。 */
    onToggleAdditionalDirectoryList: () => {},
    /** 最新位置へのスクロールはこのテストの対象外。 */
    onJumpToBottom: () => {},
    /** 選択されたエージェントは変更せず、候補操作の表示だけを検査する。 */
    onSelectCustomAgent: () => {},
    /** 本文の編集は行わず、操作グループの投影を確かめる。 */
    onDraftChange: () => {},
    /** この表示確認では入力欄へフォーカスしない。 */
    onDraftFocus: () => {},
    /** キーボード操作による状態更新は実行しない。 */
    onDraftKeyDown: () => {},
    /** キャレット位置や選択範囲は更新しない。 */
    onDraftSelect: () => {},
    /** 表示設定の確認ではIME変換の開始を処理しない。 */
    onDraftCompositionStart: () => {},
    /** 表示設定の確認ではIME変換の確定を処理しない。 */
    onDraftCompositionEnd: () => {},
    /** 操作可否の投影だけを行い、送信や停止は発行しない。 */
    onSendOrCancel: () => {},
    /** 承認モードの保存操作は実行しない。 */
    onChangeApprovalMode: () => {},
    /** 速度の選択肢を実際には変更しない。 */
    onChangeCodexSpeed: () => {},
    /** 環境を開く権限の選択値はこのスタブから変更しない。 */
    onChangeCodexSandboxMode: () => {},
    /** モデルの選択内容は保持し、変更処理を行わない。 */
    onChangeModel: () => {},
    /** 推論深度の変更を試さず、実行設定群の表示だけを読む。 */
    onChangeReasoningEffort: () => {},
  };

  for (const enabled of [false, true]) {
    const composerProps = buildLiveSessionComposerProps({
      ...input,
      showAttachmentControls: enabled,
      showAdditionalDirectoryControls: enabled,
      showExecutionModeControls: enabled,
      showCustomAgentPicker: enabled,
      showSkillPicker: enabled,
    });
    assert.equal(composerProps.showAttachmentControls, enabled);
    assert.equal(composerProps.showAdditionalDirectoryControls, enabled);
    assert.equal(composerProps.showExecutionModeControls, enabled);
    assert.equal(composerProps.showCustomAgentPicker, enabled);
    assert.equal(composerProps.showSkillPicker, enabled);
  }
});

/** 静的チャットの一般的な既定値は、拡張入力と実行設定の操作をすべて隠す。 */
test("buildStaticTextChatComposerCapabilityProps は静的 chat の controls を既定で隠す", () => {
  const composerProps = buildStaticTextChatComposerCapabilityProps();

  assert.equal(composerProps.showAttachmentControls, false);
  assert.equal(composerProps.showAdditionalDirectoryControls, false);
  assert.equal(composerProps.showExecutionModeControls, false);
  assert.equal(composerProps.showCustomAgentPicker, false);
  assert.equal(composerProps.showSkillPicker, false);
});

/** 実行機能付きの静的チャットでは添付と実行設定を出し、エージェントとスキルは隠したままにする。 */
test("staticTextChatRuntimeComposerCapabilityDefaults は runtime controls だけを表示する", () => {
  assert.equal(
    staticTextChatRuntimeComposerCapabilityDefaults.showAttachmentControls,
    true,
  );
  assert.equal(
    staticTextChatRuntimeComposerCapabilityDefaults.showAdditionalDirectoryControls,
    true,
  );
  assert.equal(
    staticTextChatRuntimeComposerCapabilityDefaults.showExecutionModeControls,
    true,
  );
  assert.equal(
    staticTextChatRuntimeComposerCapabilityDefaults.showCustomAgentPicker,
    false,
  );
  assert.equal(
    staticTextChatRuntimeComposerCapabilityDefaults.showSkillPicker,
    false,
  );
});

// @test-value v2
// kind = "contract"
// claim = "buildLiveSessionComposerDockPropsはcomposerとcompact ActionDockへ共通のjump・send・cancel情報を投影する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock" }
// fault = "composerとcompact ActionDockで末尾移動、送信・cancelのpropsが不一致になる"
// observable = "composer.showJumpToBottomとcompactActionDockのshowJumpToBottom・cancelButtonTitle・callback identity"
// observation_boundary = "public-boundary"
// scope = "live-session-composer-dock-adapter"
// lifecycle = "permanent"
// @end-test-value
/** 展開中の入力欄と縮小したドックで末尾移動を共有し、停止ラベルとコールバックを縮小側へ渡す。 */
test("buildLiveSessionComposerDockProps は composer と compact dock の共通 props を対応付ける", () => {
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  /** どちらのドックも同じ末尾移動を使うことを参照で確かめる。 */
  const onJumpToBottom = () => {};
  /** 縮小ドックの停止が元の送信・停止処理につながることを参照で確かめる。 */
  const onSendOrCancel = () => {};
  /** 縮小ドックの展開に、所有者が渡した操作を使うことを照合する。 */
  const onExpandActionDock = () => {};
  const props = buildLiveSessionComposerDockProps({
    isRunning: true,
    composerBlocked: false,
    canSelectCustomAgent: true,
    isAgentPickerOpen: false,
    isSkillPickerOpen: false,
    isAdditionalDirectoryListOpen: false,
    selectedCustomAgentLabel: "Agent",
    selectedCustomAgentTitle: "",
    additionalDirectoryCount: 2,
    isMessageListFollowing: false,
    isCustomAgentListLoading: false,
    customAgentItems: [],
    draft: "draft",
    composerTextareaRef,
    isComposerDisabled: false,
    isSendDisabled: false,
    composerSendability: {
      primaryFeedback: "",
      secondaryFeedback: [],
      feedbackTone: null,
      shouldShowFeedback: false,
    },
    sendButtonTitle: "Stop",
    isComposerBlockedFeedbackActive: false,
    approvalOptions: [{ value: "never", label: "never" }],
    selectedApprovalMode: "never",
    speedOptions: [],
    selectedCodexSpeed: "standard",
    sandboxOptions: [],
    selectedCodexSandboxMode: "workspace-write",
    modelOptions: [
      {
        value: "gpt-test",
        label: "GPT Test",
        model: { id: "gpt-test", label: "GPT Test", reasoningEfforts: [] },
      },
    ],
    selectedModel: "gpt-test",
    selectedModelFallbackLabel: "GPT Test",
    reasoningOptions: [{ value: "low", label: "low" }],
    selectedReasoningEffort: "low",
    /** ドックの構成確認のため、ファイル選択を行わない。 */
    onPickFile: () => {},
    /** フォルダー添付はこのドックの検査対象外とする。 */
    onPickFolder: () => {},
    /** 画像添付用の操作を満たすが、画像は開かない。 */
    onPickImage: () => {},
    /** 共通操作の参照を調べるため、エージェント選択UIは操作しない。 */
    onToggleAgentPicker: () => {},
    /** 比較対象をドック間の操作に絞り、スキル一覧は開かない。 */
    onToggleSkillPicker: () => {},
    /** 追加ディレクトリの登録先を呼ばない。 */
    onAddAdditionalDirectory: () => {},
    /** ディレクトリ入力が有効な構成を固定し、ドックの投影を検査する。 */
    onValidateAdditionalDirectory: async () => ({ valid: true }),
    /** ディレクトリ一覧を操作しない状態でプロパティを組み立てる。 */
    onToggleAdditionalDirectoryList: () => {},
    onExpandActionDock,
    onJumpToBottom,
    /** 縮小ドックの機能確認ではエージェントを選ばない。 */
    onSelectCustomAgent: () => {},
    /** 縮小・展開のプロパティ比較では下書きを変更しない。 */
    onDraftChange: () => {},
    /** 展開後の入力欄へフォーカスする処理は実行しない。 */
    onDraftFocus: () => {},
    /** このケースでは下書き専用のキーバインドを動かさない。 */
    onDraftKeyDown: () => {},
    /** 入力位置の同期は行わず、ドックの操作だけを比較する。 */
    onDraftSelect: () => {},
    /** IME変換を開始しない条件で共通のドックを組み立てる。 */
    onDraftCompositionStart: () => {},
    /** 入力中のIME変換を確定する処理は使用しない。 */
    onDraftCompositionEnd: () => {},
    onSendOrCancel,
    /** 承認設定を保存せず、表示の受け渡しだけを調べる。 */
    onChangeApprovalMode: () => {},
    /** ドックの構成を組み立てるためだけに速度設定操作を渡す。 */
    onChangeCodexSpeed: () => {},
    /** サンドボックス設定の実際の変更は行わない。 */
    onChangeCodexSandboxMode: () => {},
    /** モデル変更を副作用のないスタブにする。 */
    onChangeModel: () => {},
    /** このケースでは展開と停止の接続だけを調べ、推論深度は切り替えない。 */
    onChangeReasoningEffort: () => {},
  });

  assert.equal(props.composer.showJumpToBottom, true);
  assert.equal("onCollapse" in props.composer, false);
  assert.equal(props.compactActionDock.showJumpToBottom, true);
  assert.equal(props.compactActionDock.cancelButtonTitle, "Stop");
  assert.equal(props.compactActionDock.onExpand, onExpandActionDock);
  assert.equal(props.compactActionDock.onJumpToBottom, onJumpToBottom);
  assert.equal(props.compactActionDock.onCancel, onSendOrCancel);
});

/** 右ペインのリサイズ中・展開中の表示と、ポインターおよび開閉の操作を共通スプリッターへ渡す。 */
test("buildLiveSessionSplitterProps は context rail resize state を反映する", () => {
  /** リサイズを始める入力がそのまま返るか比較するための参照。 */
  const onPointerDown = () => {};
  /** 右ペインの開閉操作を取り違えないよう、独立した参照を渡す。 */
  const onToggle = () => {};
  const splitterProps = buildLiveSessionSplitterProps({
    isContextRailResizing: true,
    isContextRailVisible: true,
    onStartContextRailResize: onPointerDown,
    onToggleContextRailVisibility: onToggle,
  });

  assert.equal(splitterProps.isActive, true);
  assert.equal(splitterProps.isPanelExpanded, true);
  assert.equal(splitterProps.onPointerDown, onPointerDown);
  assert.equal(splitterProps.onTogglePanel, onToggle);
});

// @test-value v2
// kind = "contract"
// claim = "AgentとAuxiliaryのmodeを共通shellへ反映し、右ペインの内容と操作をChatWindowへ渡す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Agent / Auxiliary shared chat screen" }
// fault = "mode classや右ペイン入力が失われ、対応する共通画面を表示できない"
// observable = "shellのclassName、mainContent、rightPanePropsとChatWindow内のLatest Command表示"
// observation_boundary = "component-behavior"
// scope = "live-session-window-shell"
// lifecycle = "permanent"
// @end-test-value
/** AgentとAuxiliaryの表示モード、中央のプレビュー、右ペインの内容を共通シェルへ反映する。 */
test("buildLiveSessionWindowShellProps は mode と auxiliary class を含む shell を組み立てる", () => {
  const headerProps = createStaticChatHeaderProps({
    taskTitle: "agent session",
    isRunning: false,
  });
  const messageColumnProps = createIdleChatMessageColumnProps({
    sessionId: "session-id",
    character: createCharacter(),
    messages: [],
    messageListRef: React.createRef<HTMLDivElement>(),
    isRunning: false,
  });
  const composerProps = createHiddenControlsTextChatComposerProps({
    draft: "",
    composerTextareaRef: React.createRef<HTMLTextAreaElement>(),
    isRunning: false,
    feedback: "",
    modelOptions: [
      {
        value: "gpt-test",
        label: "GPT Test",
        model: { id: "gpt-test", label: "GPT Test", reasoningEfforts: [] },
      },
    ],
    selectedModel: "gpt-test",
    selectedModelFallbackLabel: "GPT Test",
    reasoningOptions: [{ value: "low", label: "low" }],
    selectedReasoningEffort: "low",
    onDraftChange: noop,
    onDraftKeyDown: noop,
    onSendOrCancel: noop,
    onChangeModel: noop,
    onChangeReasoningEffort: noop,
  });
  const compactActionDockProps = createStaticChatCompactActionDockProps({
    isRunning: false,
    onCancel: noop,
  });
  const rightPaneProps = buildLiveSessionContextPaneProps({
    activeContextPaneTab: "latest-command",
    availableContextPaneTabs: ["latest-command"],
    contextPaneProjection: {
      activeTab: "latest-command",
      badgeLabel: "",
      toneClassName: "",
      latestCommandToneClassName: "",
      latestCommandStatusLabel: "",
      latestCommandSourceCopy: "",
      reasoningToneClassName: "",
      tasksToneClassName: "",
    },
    latestCommandView: null,
    runningDetailsEntries: [],
    liveRunReasoningText: "",
    backgroundTasks: [],
    selectedSessionLiveRunErrorMessage: "",
    isSelectedSessionRunning: false,
    isCopilotSession: false,
    selectedCopilotRemainingPercentLabel: "",
    selectedCopilotRemainingRequestsLabel: "",
    selectedCopilotQuotaResetLabel: "",
    selectedSessionContextTelemetry: null,
    selectedSessionContextTelemetryProjection: {
      summaryLabel: "",
      currentTokensLabel: "",
      tokenLimitLabel: "",
      messagesLengthLabel: "",
      systemTokensLabel: "",
      conversationTokensLabel: "",
    },
    onCycleContextPaneTab: noop,
  });

  const agentProps = buildLiveSessionWindowShellProps({
    mode: "agent",
    isHeaderExpanded: false,
    workbenchRef: React.createRef<HTMLDivElement>(),
    headerProps,
    messageColumnProps,
    mainContent: React.createElement("div", null, "Preview"),
    isActionDockExpanded: true,
    composerProps,
    compactActionDockProps,
    splitterProps: {
      isActive: false,
      isPanelExpanded: true,
      onPointerDown: noop,
      onTogglePanel: noop,
    },
    skillPickerProps: undefined,
    isRightPaneVisible: true,
    rightPaneProps,
    modals: React.createElement("div"),
  });
  const auxiliaryProps = buildLiveSessionWindowShellProps({
    mode: "agent",
    baseClassName: "theme-accent",
    isHeaderExpanded: false,
    workbenchRef: React.createRef<HTMLDivElement>(),
    headerProps,
    messageColumnProps,
    isActionDockExpanded: true,
    composerProps,
    compactActionDockProps,
    splitterProps: {
      isActive: false,
      isPanelExpanded: true,
      onPointerDown: noop,
      onTogglePanel: noop,
    },
    skillPickerProps: undefined,
    isRightPaneVisible: true,
    rightPaneProps,
    modals: React.createElement("div"),
    isAuxiliaryMode: true,
  });

  assert.equal(agentProps.mode, "agent");
  assert.equal(agentProps.messageColumnProps.isContentActive, false);
  assert.equal(auxiliaryProps.messageColumnProps.isContentActive, true);
  assert.equal(agentProps.className, "");
  assert.equal(auxiliaryProps.className, "theme-accent auxiliary-session-mode");
  assert.match(renderToStaticMarkup(agentProps.mainContent), /Preview/);
  assert.match(
    renderToStaticMarkup(React.createElement(ChatWindow, agentProps)),
    /Latest Command/,
  );
  assert.equal(auxiliaryProps.rightPaneProps, rightPaneProps);
});

// @test-value v2
// kind = "contract"
// claim = "live sessionのright pane propsは共通形式でcallbackと表示文言を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window" }
// fault = "right paneの表示情報またはtab操作callbackがprojectionから欠落する"
// observable = "生成されたright pane propsの表示文言とtab callback"
// observation_boundary = "public-boundary"
// scope = "live-session-context-pane-props"
// lifecycle = "permanent"
// @end-test-value
/** 最新コマンドの進行状態・失敗文言とタブ切替を、右ペイン共通のプロパティに保つ。 */
test("buildLiveSessionContextPaneProps は right pane props を共通形式で保持する", () => {
  /** 右ペインを巡回する操作が差し替わっていないか確認するための参照。 */
  const onCycleContextPaneTab = () => {};
  const props = buildLiveSessionContextPaneProps({
    activeContextPaneTab: "latest-command",
    availableContextPaneTabs: ["latest-command"],
    contextPaneProjection: {
      activeTab: "latest-command",
      badgeLabel: "Running",
      toneClassName: "is-running",
      latestCommandToneClassName: "command-running",
      latestCommandStatusLabel: "Command running",
      latestCommandSourceCopy: "npm test",
      reasoningToneClassName: "",
      tasksToneClassName: "",
    },
    latestCommandView: null,
    runningDetailsEntries: [],
    liveRunReasoningText: "",
    backgroundTasks: [],
    selectedSessionLiveRunErrorMessage: "Command failed",
    isSelectedSessionRunning: true,
    isCopilotSession: false,
    selectedCopilotRemainingPercentLabel: "",
    selectedCopilotRemainingRequestsLabel: "",
    selectedCopilotQuotaResetLabel: "",
    selectedSessionContextTelemetry: null,
    selectedSessionContextTelemetryProjection: {
      summaryLabel: "",
      currentTokensLabel: "",
      tokenLimitLabel: "",
      messagesLengthLabel: "",
      systemTokensLabel: "",
      conversationTokensLabel: "",
    },
    onCycleContextPaneTab,
  });

  assert.equal(props.activeContextPaneTab, "latest-command");
  assert.deepEqual(props.availableContextPaneTabs, ["latest-command"]);
  assert.equal(props.contextPaneProjection.activeTab, "latest-command");
  assert.equal(props.contextPaneProjection.badgeLabel, "Running");
  assert.equal(
    props.contextPaneProjection.latestCommandStatusLabel,
    "Command running",
  );
  assert.equal(props.contextPaneProjection.latestCommandSourceCopy, "npm test");
  assert.equal(props.selectedSessionLiveRunErrorMessage, "Command failed");
  assert.equal(props.isSelectedSessionRunning, true);
  assert.equal(props.onCycleContextPaneTab, onCycleContextPaneTab);
});

/** 静的な会話のユーザー以外の発言を、共通表示ではアシスタント側に揃える。 */
test("toConversationMessages は user 以外を assistant として共通 message に変換する", () => {
  assert.deepEqual(
    toConversationMessages([
      { role: "user", text: "おはよう" },
      { role: "mate", text: "やあ" },
    ]),
    [
      { role: "user", text: "おはよう" },
      { role: "assistant", text: "やあ" },
    ],
  );
});

// @test-value v2
// kind = "contract"
// claim = "hidden-controls text chatはidle時の入力と送信を許可しownerのfeedbackと送信labelを保持する"
// oracle = { type = "contract", ref = "src/chat/chat-window-adapter.ts#createHiddenControlsTextChatComposerProps" }
// fault = "idleの入力や送信を拒否するかownerのfeedbackと送信labelを失う"
// observable = "composerのblocked/running/disabled/placeholder/sendButtonTitle/feedback"
// observation_boundary = "public-boundary"
// scope = "hidden controls text chat idle projection"
// lifecycle = "permanent"
// impact = "text chatで入力・送信できないか誤った操作説明になる"
// distinction = "型検査ではadapterが返す値とowner入力の対応を検出できない"
// @end-test-value
/** 操作群を隠した静的チャットでも、待機中の入力と送信、所有者の文言と通知を保持する。 */
test("createHiddenControlsTextChatComposerProps は text chat 用の送信可否と feedback を補う", () => {
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  const composerProps = createHiddenControlsTextChatComposerProps({
    draft: "おはよう",
    placeholder: "今日はどうする？",
    composerTextareaRef,
    isRunning: false,
    feedback: "準備できています",
    sendButtonTitleWhenEnabled: "メッセージを送信",
    modelOptions: [
      {
        value: "gpt-test",
        label: "GPT Test",
        model: { id: "gpt-test", label: "GPT Test", reasoningEfforts: [] },
      },
    ],
    selectedModel: "gpt-test",
    selectedModelFallbackLabel: "GPT Test",
    reasoningOptions: [{ value: "low", label: "low" }],
    selectedReasoningEffort: "low",
    onDraftChange: noop,
    onDraftKeyDown: noop,
    onSendOrCancel: noop,
    onChangeModel: noop,
    onChangeReasoningEffort: noop,
  });

  assert.equal(composerProps.composerBlocked, false);
  assert.equal(composerProps.isRunning, false);
  assert.equal(composerProps.isComposerDisabled, false);
  assert.equal(composerProps.isSendDisabled, false);
  assert.equal(composerProps.placeholder, "今日はどうする？");
  assert.equal(composerProps.sendButtonTitle, "メッセージを送信");
  assert.deepEqual(composerProps.composerSendability, {
    primaryFeedback: "準備できています",
    secondaryFeedback: [],
    feedbackTone: "helper",
    shouldShowFeedback: true,
  });
});

// @test-value v2
// kind = "contract"
// claim = "cancelを提供しないhidden-controls text chatは実行中の入力と送信を止めCancel表示には切り替えない"
// oracle = { type = "contract", ref = "src/chat/chat-window-adapter.ts#createHiddenControlsTextChatComposerProps" }
// fault = "実行中に再送できるか未提供のCancel操作を表示する"
// observable = "composerのisRunning/composerBlocked/isComposerDisabled/isSendDisabled"
// observation_boundary = "public-boundary"
// scope = "hidden controls text chat running projection"
// lifecycle = "permanent"
// impact = "重複実行または機能しないCancel操作を招く"
// distinction = "型検査ではrunning状態の表示と操作制約の組合せを検出できない"
// @end-test-value
/** 停止機能を持たない静的チャットでは、実行中に入力と送信を止めても停止表示にしない。 */
test("createHiddenControlsTextChatComposerProps は running 中も cancel 表示へ切り替えない", () => {
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  const composerProps = createHiddenControlsTextChatComposerProps({
    draft: "おはよう",
    placeholder: "今日はどうする？",
    composerTextareaRef,
    isRunning: true,
    feedback: "",
    modelOptions: [
      {
        value: "gpt-test",
        label: "GPT Test",
        model: { id: "gpt-test", label: "GPT Test", reasoningEfforts: [] },
      },
    ],
    selectedModel: "gpt-test",
    selectedModelFallbackLabel: "GPT Test",
    reasoningOptions: [{ value: "low", label: "low" }],
    selectedReasoningEffort: "low",
    onDraftChange: noop,
    onDraftKeyDown: noop,
    onSendOrCancel: noop,
    onChangeModel: noop,
    onChangeReasoningEffort: noop,
  });

  assert.equal(composerProps.isRunning, false);
  assert.equal(composerProps.composerBlocked, true);
  assert.equal(composerProps.isComposerDisabled, true);
  assert.equal(composerProps.isSendDisabled, true);
});

// @test-value v2
// kind = "contract"
// claim = "hidden-controls text chatは明示した共通操作を再表示しcustom agentとskill操作は隠す"
// oracle = { type = "contract", ref = "src/chat/chat-window-adapter.ts#createHiddenControlsTextChatComposerProps" }
// fault = "ownerが指定した共通操作を隠すか未提供のcustom agentとskill操作を公開する"
// observable = "attachment/additionalDirectory/executionMode/customAgent/skillの表示flagとapproval/sandbox候補"
// observation_boundary = "public-boundary"
// scope = "hidden controls text chat capability projection"
// lifecycle = "permanent"
// impact = "必要な共通操作が使えないか未提供操作を利用可能に見せる"
// distinction = "型検査では実際のcapability flagの値を検出できない"
// @end-test-value
/** 明示的に許可した添付、追加ディレクトリ、実行設定だけを再表示し、候補値を保つ。 */
test("createHiddenControlsTextChatComposerProps は必要な共通操作だけを再表示できる", () => {
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  const composerProps = createHiddenControlsTextChatComposerProps({
    draft: "おはよう",
    placeholder: "今日はどうする？",
    composerTextareaRef,
    isRunning: false,
    feedback: "",
    modelOptions: [
      {
        value: "gpt-test",
        label: "GPT Test",
        model: { id: "gpt-test", label: "GPT Test", reasoningEfforts: [] },
      },
    ],
    selectedModel: "gpt-test",
    selectedModelFallbackLabel: "GPT Test",
    reasoningOptions: [{ value: "low", label: "low" }],
    selectedReasoningEffort: "low",
    onDraftChange: noop,
    onDraftKeyDown: noop,
    onSendOrCancel: noop,
    onChangeModel: noop,
    onChangeReasoningEffort: noop,
    showAttachmentControls: true,
    showAdditionalDirectoryControls: true,
    showExecutionModeControls: true,
    approvalOptions: [{ value: "untrusted", label: "untrusted" }],
    selectedApprovalMode: "untrusted",
    sandboxOptions: [{ value: "workspace-write", label: "workspace-write" }],
    selectedCodexSandboxMode: "workspace-write",
  });

  assert.equal(composerProps.showAttachmentControls, true);
  assert.equal(composerProps.showAdditionalDirectoryControls, true);
  assert.equal(composerProps.showExecutionModeControls, true);
  assert.equal(composerProps.showCustomAgentPicker, false);
  assert.equal(composerProps.showSkillPicker, false);
  assert.equal(composerProps.approvalOptions[0]?.value, "untrusted");
  assert.equal(composerProps.sandboxOptions[0]?.value, "workspace-write");
});

/** 空白だけの下書きと実行中は送信不可とし、補助文が空ならフィードバックを表示しない。 */
test("static chat sendability helper は running と空白 draft を送信不可にする", () => {
  assert.equal(
    isStaticChatSendDisabled({ draft: "こんにちは", isRunning: false }),
    false,
  );
  assert.equal(
    isStaticChatSendDisabled({ draft: "   ", isRunning: false }),
    true,
  );
  assert.equal(
    isStaticChatSendDisabled({ draft: "こんにちは", isRunning: true }),
    true,
  );

  assert.deepEqual(
    createStaticChatComposerSendability("入力してから送信してね。"),
    {
      primaryFeedback: "入力してから送信してね。",
      secondaryFeedback: [],
      feedbackTone: "helper",
      shouldShowFeedback: true,
    },
  );
  assert.deepEqual(createStaticChatComposerSendability(""), {
    primaryFeedback: "",
    secondaryFeedback: [],
    feedbackTone: null,
    shouldShowFeedback: false,
  });
});

/** 静的な縮小ドックには待機中の状態と、安全に呼べる既定の停止操作を用意する。 */
test("createStaticTextChatCompactActionDockProps は text chat 用の compact dock を補う", () => {
  const compactProps = createStaticTextChatCompactActionDockProps({});

  assert.equal(compactProps.isRunning, false);
  assert.equal(typeof compactProps.onCancel, "function");
});
