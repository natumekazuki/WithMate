import assert from "node:assert/strict";
import test from "node:test";
import { Session as InspectorSession } from "node:inspector/promises";
import { JSDOM } from "jsdom";
import React, {
  createRef,
  useState,
  type ComponentType,
  type ProfilerOnRenderCallback,
} from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SessionMessageColumn,
  shouldAdjustSessionMessageScrollPosition,
  type SessionMessageColumnProps,
} from "../../src/chat/conversation/session-message-column.js";
import { SessionActionDockCompactRow } from "../../src/chat/approval/session-action-dock.js";
import { SessionContextPane } from "../../src/chat/shell/session-context-pane.js";
import {
  SessionComposerExpanded,
  type SessionComposerExpandedProps,
} from "../../src/chat/composer/session-composer.js";
import { SessionChatScreen } from "../../src/chat/shell/session-header.js";
import { StableSessionMessageColumn } from "../../src/chat/chat-window.js";
import { ConversationMessageColumn } from "../../src/chat/conversation-message-column.js";
import { observeSessionResultRead } from "../../src/chat/conversation/observe-session-result-read.js";
import { buildContextPaneProjection } from "../../src/chat/runtime/session-ui-projection.js";
import {
  buildMessageCollapseTargets,
  type MessageCollapseTarget,
} from "../../src/chat/conversation/session-message-collapse.js";
import {
  buildLiveAssistantProjectionKey,
  buildMessageListProjection,
  type MessageListSource,
} from "../../src/chat/auxiliary/auxiliary-session-message-projection.js";
import type { CharacterProfile } from "../../src-shared/character/character-state.js";
import type {
  ElicitationRecord,
  LiveApprovalRequest,
  LiveElicitationRequest,
} from "../../src-shared/session/runtime-state.js";
import type {
  Message,
  MessageArtifact,
} from "../../src-shared/session/session-state.js";
import { resolveSelectionActionOverlayPosition } from "../../src/chat/selection-action-overlay.js";
import { createGlossaryAnnotationMatcher } from "../../src/glossary/glossary-annotation-projection.js";
import { ComposerControllerRegistry } from "../../src/chat/composer-controller.js";
import { buildRuntimeSelectionOptions } from "../../src/settings/runtime-selection-options.js";
import {
  getSessionApprovalChoices,
  getSessionApprovalDisplay,
  resolveSessionApprovalChoice,
} from "../../src-shared/settings/session-approval-choice.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// @test-value v2
// kind = "contract"
// claim = "runtime設定は現在の選択値を正式名の文字で表し、供給された候補と変更通知を保つ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: runtime設定の現在値表示" }
// fault = "選択値の表示名やtitleが追従しない、候補へ未設定値を追加、または変更が別設定へ通知される"
// observable = "実composerのModel pickerと4 selectのaccessible name、現在値表示とtitle、変更callbackの保存値"
// observation_boundary = "component-behavior"
// scope = "Session composer runtime settings"
// lifecycle = "permanent"
// impact = "操作前に現在設定を確認し、選んだ値を次送信用設定へ反映できる"
// distinction = "options生成testや型検査では実composerの表示名・title・変更callbackの接続間違いを検出できない。文字の可視性と収容は実描画で確認する"
// @end-test-value
/** 正式名付きの設定候補を選び直すと、選択値とツールチップが揃い、Modelの候補も供給元の2件に限られる。 */
test("runtime設定は選択値の正式名に追従し、Model名と供給された候補を維持する", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  Object.assign(dom.window.HTMLElement.prototype, {
    /** Reactの入力監視が参照する旧式イベント登録口を用意する。 */
    attachEvent() {},
    /** アンマウント時に対になる旧式イベント解除口を用意する。 */
    detachEvent() {},
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  const changes: string[] = [];
  /** 選択用の値を文字列リテラルの型のまま表示ラベルと組み合わせる。 */
  const option = <T extends string>(value: T, label: string) => ({
    value,
    label,
  });
  /** 候補の選択結果をpropsに戻し、変更後の表示まで同じComposerで追えるようにする。 */
  function Fixture() {
    const [selection, setSelection] = useState<
      Partial<SessionComposerExpandedProps>
    >({});
    /** 通知されたキーと値を記録し、次の描画に反映する。 */
    const change = (key: keyof SessionComposerExpandedProps, value: string) => {
      changes.push(key + ":" + value);
      setSelection((current) => ({ ...current, [key]: value }));
    };
    return React.createElement(
      SessionComposerExpanded,
      createComposerTestProps({
        approvalOptions: getSessionApprovalChoices(),
        sandboxOptions: [
          option("workspace-write", "Workspace Write"),
          option("read-only", "Read Only"),
        ],
        reasoningOptions: [option("low", "Low"), option("high", "High")],
        modelOptions: [
          {
            ...option("gpt-5.4", "GPT-5.4"),
            model: { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: [] },
          },
          {
            ...option("vendor/model-b", "Model B"),
            model: {
              id: "vendor/model-b",
              label: "Model B",
              reasoningEfforts: [],
            },
          },
        ],
        speedOptions: [option("standard", "Standard"), option("fast", "Fast")],
        ...selection,
        /** Approvalの選択を次の描画とイベント履歴に渡す。 */
        onChangeApprovalMode: (value) => change("selectedApprovalMode", value),
        /** Sandboxの選択を対応する設定キーに反映する。 */
        onChangeCodexSandboxMode: (value) =>
          change("selectedCodexSandboxMode", value),
        /** 推論深度の選択をComposerの現在値に戻す。 */
        onChangeReasoningEffort: (value) =>
          change("selectedReasoningEffort", value),
        /** Speedの選択を他の設定とは別に更新する。 */
        onChangeCodexSpeed: (value) => change("selectedCodexSpeed", value),
        /** Modelオブジェクトから選択値となるIDを取り出す。 */
        onChangeModel: (model) => change("selectedModel", model.id),
      }),
    );
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(Fixture)));
    const document = dom.window.document;
    assert.deepEqual(
      [
        ...document.querySelectorAll(
          '.composer-settings select, .composer-settings button[aria-haspopup="listbox"]',
        ),
      ].map((select) => select.getAttribute("aria-label")),
      ["Approval", "Sandbox", "Model", "Reasoning depth", "Speed"],
    );
    const model = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Model"]',
    )!;
    assert.equal(model.querySelector("span")?.textContent, "GPT-5.4");
    assert.equal(model.title, "Model: GPT-5.4");
    const depth = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Reasoning depth"]',
    )!;
    assert.deepEqual(
      [...depth.options].map((item) => item.value),
      ["low", "high"],
    );
    for (const [label, value, title, key] of [
      ["Approval", "auto-review", "Auto Review", "selectedApprovalMode"],
      ["Sandbox", "read-only", "Read Only", "selectedCodexSandboxMode"],
      ["Reasoning depth", "low", "Low", "selectedReasoningEffort"],
      ["Speed", "fast", "Fast", "selectedCodexSpeed"],
    ]) {
      const select = document.querySelector<HTMLSelectElement>(
        'select[aria-label="' + label + '"]',
      )!;
      await act(async () => {
        select.value = value;
        select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
      assert.equal(changes.at(-1), key + ":" + value);
      assert.equal(select.value, value);
      assert.equal(select.title, label + ": " + title);
      assert.equal(select.selectedOptions[0].textContent, title);
    }
    await act(async () => model.click());
    const candidates = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ];
    assert.equal(candidates.length, 2);
    const nextModel = candidates.find((candidate) =>
      candidate.textContent?.includes("Model B"),
    );
    assert.ok(nextModel);
    await act(async () => nextModel.click());
    assert.equal(changes.at(-1), "selectedModel:vendor/model-b");
    assert.equal(model.querySelector("span")?.textContent, "Model B");
    assert.equal(model.title, "Model: Model B");
    assert.equal(changes.length, 5);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Depth省略値はDefaultとして空valueを表示し、SDK非対応モデルでは保存Depthを変えず欄を非表示にする"
// oracle = { type = "contract", ref = "Issue #879 SDK Depth omission and unsupported Depth controls" }
// fault = "空Depthを先頭のSDK値として表示するか、非対応モデルのDepth欄を表示・保存値を置換する"
// observable = "実ComposerのDepth select valueとselected option表示、非対応時の欄不在と選択props"
// observation_boundary = "component-behavior"
// scope = "Composer SDK Depth current-value display"
// lifecycle = "permanent"
// impact = "利用者が表示から判断したDepthと次送信設定が食い違う"
// distinction = "候補生成単体ではnative selectの選択valueと実際の表示文字の一致を検証できない"
// @end-test-value
/** Depthを省略した場合は空値のDefaultを選択表示し、非対応モデルでは保持値を変えずに欄を隠す。 */
test("ComposerのDepthは省略valueとDefault表示を一致させ非対応モデルの欄を隠す", () => {
  const model = {
    id: "sdk-model",
    label: "SDK Model",
    reasoningEfforts: ["low"],
    defaultReasoningEffort: "",
  };
  const input = {
    providerId: "codex",
    providerCatalog: {
      id: "codex",
      label: "Codex",
      defaultModelId: model.id,
      defaultReasoningEffort: "",
      models: [model],
    },
    models: [model],
    selectedModel: model.id,
    selectedCodexSandboxMode: "workspace-write" as const,
    selectedCodexSpeed: "standard" as const,
  };
  const props = createComposerTestProps({ selectedReasoningEffort: "" });
  const options = buildRuntimeSelectionOptions({
    ...input,
    selectedReasoningEffort: props.selectedReasoningEffort,
    reasoningEfforts: model.reasoningEfforts,
  });
  const dom = new JSDOM(
    renderToStaticMarkup(
      React.createElement(SessionComposerExpanded, {
        ...props,
        reasoningOptions: options.reasoningSelectOptions,
      }),
    ),
  );
  try {
    const depth = dom.window.document.querySelector<HTMLSelectElement>(
      ".composer-setting-depth select",
    );
    assert.ok(depth);
    assert.equal(depth.value, props.selectedReasoningEffort);
    assert.equal(depth.selectedOptions[0]?.textContent, "Default");
  } finally {
    dom.window.close();
  }
  const savedProps = createComposerTestProps({
    selectedReasoningEffort: "saved-sdk-depth",
  });
  const unsupported = buildRuntimeSelectionOptions({
    ...input,
    selectedReasoningEffort: savedProps.selectedReasoningEffort,
    reasoningEfforts: [],
  });
  const unsupportedDom = new JSDOM(
    renderToStaticMarkup(
      React.createElement(SessionComposerExpanded, {
        ...savedProps,
        reasoningOptions: unsupported.reasoningSelectOptions,
      }),
    ),
  );
  try {
    assert.equal(
      unsupportedDom.window.document.querySelector(".composer-setting-depth"),
      null,
    );
    assert.equal(savedProps.selectedReasoningEffort, "saved-sdk-depth");
  } finally {
    unsupportedDom.window.close();
  }
});

/** 個別ケースが指定した値だけでComposerの制約や表示を切り替えられるよう、共通の初期propsを用意する。 */
function createComposerTestProps(
  overrides: Partial<SessionComposerExpandedProps> = {},
): SessionComposerExpandedProps {
  return {
    isRunning: false,
    composerBlocked: false,
    canSelectCustomAgent: true,
    showAttachmentControls: true,
    showCustomAgentPicker: true,
    showSkillPicker: true,
    showPromptTemplateButton: true,
    showAdditionalDirectoryControls: true,
    showExecutionModeControls: true,
    isAgentPickerOpen: false,
    isSkillPickerOpen: false,
    isPromptTemplateWorkspaceOpen: false,
    isAdditionalDirectoryListOpen: false,
    selectedCustomAgentLabel: "Agent",
    selectedCustomAgentTitle: "Agent",
    additionalDirectoryCount: 1,
    showJumpToBottom: false,
    isCustomAgentListLoading: false,
    customAgentItems: [
      {
        key: "agent-1",
        value: "agent-1",
        primaryLabel: "Agent",
        secondaryLabel: "Agent description",
        title: "Agent",
        isSelected: true,
      },
    ],
    draft: "",
    composerTextareaRef: createRef<HTMLTextAreaElement>(),
    isComposerDisabled: false,
    isSendDisabled: true,
    composerSendability: {
      primaryFeedback: "",
      secondaryFeedback: [],
      feedbackTone: null,
      shouldShowFeedback: false,
    },
    sendButtonTitle: "Send",
    isComposerBlockedFeedbackActive: false,
    approvalOptions: [{ value: "untrusted", label: "untrusted" }],
    selectedApprovalMode: "untrusted",
    sandboxOptions: [{ value: "workspace-write", label: "workspace-write" }],
    selectedCodexSandboxMode: "workspace-write",
    speedOptions: [],
    selectedCodexSpeed: "standard",
    modelOptions: [
      {
        value: "gpt-5.4",
        label: "GPT-5.4",
        model: { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: [] },
      },
    ],
    selectedModel: "gpt-5.4",
    selectedModelFallbackLabel: "gpt-5.4",
    reasoningOptions: [{ value: "high", label: "high" }],
    selectedReasoningEffort: "high",
    /** ローカルファイルを選ぶ経路は起動しない。 */
    onPickFile() {},
    /** ディレクトリ選択を伴わずに添付メニューを描画する。 */
    onPickFolder() {},
    /** 画像選択の外部ダイアログを開かない。 */
    onPickImage() {},
    /** 添付をSession Filesへ追加する保存処理は行わない。 */
    onAddToSessionFiles() {},
    /** Session Files内のファイル選択を実行しない。 */
    onPickSessionFiles() {},
    /** Session Files内のフォルダー選択を実行しない。 */
    onPickSessionFolder() {},
    /** Session Files内の画像選択を実行しない。 */
    onPickSessionImage() {},
    /** Agentピッカーの開閉は既定fixtureでは追跡しない。 */
    onToggleAgentPicker() {},
    /** Skillsピッカーを開かず設定行を描画する。 */
    onToggleSkillPicker() {},
    /** プロンプトテンプレートの画面遷移を起こさない。 */
    onOpenPromptTemplates() {},
    /** 追加ディレクトリを実際の許可一覧へ登録しない。 */
    onAddAdditionalDirectory() {},
    /** 追加候補を有効と扱い、実ファイルシステムの検査を切り離す。 */
    onValidateAdditionalDirectory: async () => ({ valid: true as const }),
    /** 追加ディレクトリ一覧の開閉はテストごとの上書きに任せる。 */
    onToggleAdditionalDirectoryList() {},
    /** 末尾への移動を起こさない既定の操作口。 */
    onJumpToBottom() {},
    /** カスタムAgentを選択した場合の親更新を行わない。 */
    onSelectCustomAgent() {},
    /** 入力テキストの外部保存なしにComposerを描画する。 */
    onDraftChange() {},
    /** フォーカス通知で外部の状態を変更しない。 */
    onDraftFocus() {},
    /** キー操作は既定fixtureの外部では処理しない。 */
    onDraftKeyDown() {},
    /** 貼り付け内容を取り込まない既定の通知先。 */
    onDraftPaste() {},
    /** テキスト選択に伴う親の状態更新を行わない。 */
    onDraftSelect() {},
    /** IMEの変換開始を外部に伝播しない。 */
    onDraftCompositionStart() {},
    /** IMEの変換確定を既定fixtureの外へ伝播しない。 */
    onDraftCompositionEnd() {},
    /** 送信・取消を外部に実行しない既定の操作口。 */
    onSendOrCancel() {},
    /** Approvalの変更は検証するケースだけで受け取る。 */
    onChangeApprovalMode() {},
    /** Sandboxの設定変更に既定fixtureから副作用を起こさない。 */
    onChangeCodexSandboxMode() {},
    /** Speed設定を永続化しない。 */
    onChangeCodexSpeed() {},
    /** Model切替の通知でテスト外の選択を変更しない。 */
    onChangeModel() {},
    /** Depth変更を個別ケースで差し替えられるよう既定では反映しない。 */
    onChangeReasoningEffort() {},
    ...overrides,
  };
}

// @test-value v2
// kind = "contract"
// claim = "4 ProviderでApprovalは同じフラットな候補を表示し、旧設定を選択扱いせず明示User/Auto Reviewへ切り替えられる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Approvalの選択; docs/design/withmate-auto-review.md#設定と適用範囲" }
// fault = "Providerごとに名称やReviewer階層が違う、未指定や旧制限を勝手に置き換える、User/Auto Reviewの明示選択を捕捉しない"
// observable = "実selectの選択可能値と表示・変更イベントで更新された次Turn設定"
// observation_boundary = "component-behavior"
// scope = "Session composerの共通Approval候補と旧設定からの変更"
// lifecycle = "permanent"
// impact = "次Turnが手動と自動のどちらか利用者が判断・変更できなくなる"
// distinction = "helpers単体ではnative selectのプレースホルダーと変更通知を確認できない"
// @end-test-value
/** 四つのproviderで共通のApproval候補を出し、UserまたはAuto Reviewの明示選択まで旧設定を保つ。 */
test("Approval is flat across providers and keeps legacy settings until a choice is made", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const changes: string[] = [];
  /** providerごとの旧Approval値を初期状態に持ち、実際の選択で次の設定に切り替える。 */
  function Fixture({ provider }: { provider: string }) {
    const [settings, setSettings] = useState({
      provider,
      approvalMode:
        provider === "claude" ? ("plan" as const) : ("on-request" as const),
      codexReviewer: "user" as const,
    } as Parameters<typeof getSessionApprovalDisplay>[0]);
    const selected = getSessionApprovalDisplay(settings);
    const options = getSessionApprovalChoices();
    return React.createElement(
      SessionComposerExpanded,
      createComposerTestProps({
        providerId: provider,
        selectedApprovalMode: selected.value,
        approvalOptions: selected.value
          ? options
          : [{ value: "", label: selected.label, disabled: true }, ...options],
        /** 選択通知を記録し、共通候補を現在のproviderの設定差分へ変換する。 */
        onChangeApprovalMode: (value) => {
          changes.push(value);
          const patch = resolveSessionApprovalChoice(provider, value);
          assert.ok(patch);
          setSettings({ ...settings, ...patch });
        },
      }),
    );
  }
  try {
    for (const provider of ["codex", "claude", "copilot", "opencode"]) {
      const count = changes.length;
      await act(async () =>
        root.render(React.createElement(Fixture, { key: provider, provider })),
      );
      const select = dom.window.document.querySelector<HTMLSelectElement>(
        'select[aria-label="Approval"]',
      )!;
      assert.deepEqual(
        [...select.options]
          .filter((option) => !option.disabled)
          .map((option) => [option.value, option.textContent]),
        [
          ["auto-run", "Auto Run"],
          ["auto-review", "Auto Review"],
          ["user", "User"],
          ["safety-focused", "Safety Focused"],
        ],
      );
      assert.equal(
        select.selectedOptions[0]?.textContent,
        provider === "codex"
          ? "User"
          : provider === "claude"
            ? "Plan"
            : "Settings Default",
      );
      assert.equal(select.selectedOptions[0]?.disabled, provider !== "codex");
      assert.equal(changes.length, count);
      for (const value of ["auto-review", "user"]) {
        await act(async () => {
          select.value = value;
          select.dispatchEvent(
            new dom.window.Event("change", { bubbles: true }),
          );
        });
        assert.equal(select.value, value);
      }
      assert.deepEqual(changes.slice(count), ["auto-review", "user"]);
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "MainとAuxiliaryの実行中Composerは編集可能な入力と単一のSend操作から予約し、終了凍結中は予約を受け付けない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dockの送信と予約" }
// fault = "実行中の入力を無効化する、Sendを現在turn入力へ誤配送する、または凍結中にも予約する"
// observable = "textareaのdisabled、Sendの表示とclickによるowner別の予約callback、freeze後のdisabledとcallback回数"
// observation_boundary = "component-behavior"
// scope = "running-composer-send"
// lifecycle = "permanent"
// impact = "実行中の次要求を入力・送信できず、誤配送や終了中の受付が発生する"
// distinction = "feedback helperや型検査では実際のbutton配線とcontroller凍結購読を確認できない"
// @end-test-value
/** 実行中のMainとAuxiliaryで編集した下書きが直接入力でなくキューに入り、freeze後の追加はできないことを確かめる。 */
test("running Main and Auxiliary Send enqueue through the editable Composer and honor freeze", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const queued: string[] = [];
  let directInputs = 0;
  try {
    for (const kind of ["main", "auxiliary"] as const) {
      const registry = new ComposerControllerRegistry();
      const owner = { kind, id: `${kind}-conversation` };
      registry.setDraft(owner, `${kind} next request`);
      await act(async () =>
        root.render(
          React.createElement(
            SessionComposerExpanded,
            createComposerTestProps({
              isRunning: true,
              canSendInput: false,
              isComposerDisabled: false,
              composerController: { owner, registry },
              /** 送信操作の時点で対象ownerの下書きを取り出しキューに記録する。 */
              onQueueTurn: () => queued.push(registry.capture(owner).draft),
              /** キュー送信でなく実行中の入力が選ばれた回数を数える。 */
              onSendInput: () => {
                ++directInputs;
              },
            }),
          ),
        ),
      );
      assert.equal(
        dom.window.document.querySelector("textarea")!.disabled,
        false,
      );
      const sends = [...dom.window.document.querySelectorAll("button")].filter(
        (button) => button.textContent === "Send",
      );
      assert.equal(sends.length, 1);
      assert.equal(sends[0].disabled, false);
      await act(async () => sends[0].click());
      assert.equal(queued.at(-1), `${kind} next request`);
      assert.equal(directInputs, 0);
      await act(async () => registry.freeze());
      assert.equal(
        dom.window.document.querySelector("textarea")!.disabled,
        true,
      );
      assert.equal(sends[0].disabled, true);
      await act(async () => sends[0].click());
      assert.equal(queued.length, kind === "main" ? 1 : 2);
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  }
});

/** 会話列の表示に必要な名前・アイコン・テーマを持つ固定Characterを返す。 */
function createCharacterProfile(): CharacterProfile {
  return {
    id: "char-1",
    name: "Test Character",
    iconPath: "/icons/test-character.svg",
    description: "for virtualized list red test",
    roleMarkdown: "テストキャラクター",
    notesMarkdown: "",
    updatedAt: "2026-04-29T00:00:00.000Z",
    themeColors: {
      main: "#6f8cff",
      sub: "#6fb8c7",
    },
  };
}

const conversationTestThemeColors = {
  main: "#6f8cff",
  sub: "#6fb8c7",
};

/** 会話列のpropsを実ConversationMessageColumnに接続し、保存済み履歴を含む経路を使う。 */
function ConversationBackedMessageColumn(props: SessionMessageColumnProps) {
  return React.createElement(ConversationMessageColumn, {
    session: {
      id: props.sessionId,
      messages: props.messages,
      characterId: "character",
      character: "Test Character",
      characterIconPath: "",
      characterThemeColors: conversationTestThemeColors,
    },
    baseProps: props,
    enabled: true,
  });
}

/** 仮想スクロールの各位置を識別できる連番本文を、assistantとuser交互に用意する。 */
function createMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "assistant" : "user",
    text: `message ${index + 1}`,
  }));
}

/** 会話本文とは独立に詳細欄を観測できるよう、操作履歴・変更行・実行結果を含む応答を用意する。 */
function createArtifactMessage(): Message {
  return {
    role: "assistant",
    text: "artifact message",
    artifact: {
      title: "artifact result",
      activitySummary: ["updated app"],
      operationTimeline: [
        {
          type: "file_write",
          summary: "updated file",
          details: "details for operation",
        },
      ],
      changedFiles: [
        {
          kind: "edit",
          path: "src/app/SessionWindowApp.tsx",
          summary: "updated app component",
          diffRows: [{ kind: "add", rightNumber: 1, rightText: "new line" }],
        },
      ],
      runChecks: [{ label: "snapshot files", value: "ok" }],
    },
  };
}

/** コマンドとMCPツールが混在する操作グループの表示を試せる応答を返す。 */
function createOperationsArtifactMessage(): Message {
  const message = createArtifactMessage();
  message.artifact!.operationTimeline = [
    {
      type: "command_execution",
      summary: "npm test",
      details: "test output",
    },
    {
      type: "command_execution",
      summary: "npm run typecheck",
      details: "typecheck output",
    },
    {
      type: "mcp_tool_call",
      summary: "filesystem/read",
      details: "mcp output",
    },
    {
      type: "command_execution",
      summary: "npm run build",
      details: "build output",
    },
  ];
  return message;
}

/** 警告と詳細を持ち、選択結果を直接配送するコマンド承認要求を作る。 */
function createLiveApprovalRequest(): LiveApprovalRequest {
  return {
    requestId: "approval-1",
    provider: "codex",
    kind: "command",
    title: "コマンド実行の承認",
    summary: "npm test を実行します",
    details: "approval details",
    warning: "確認してね",
    decisionMode: "direct-decision",
  };
}

/** 既定のブランチ名を持つ必須の回答欄を、入力待ちの質問として用意する。 */
function createLiveElicitationRequest(): LiveElicitationRequest {
  return {
    requestId: "elicitation-1",
    provider: "codex",
    mode: "form",
    message: "対象ブランチを選んでね。",
    fields: [
      {
        type: "text",
        name: "branch",
        title: "Branch",
        required: true,
        defaultValue: "main",
      },
    ],
  };
}

// @test-value v2
// kind = "contract"
// claim = "会話列は応答元providerで固有解析を選び、Codexの保存済み・live・pending応答を通常file linkで表示する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#assistant-file-references" }
// fault = "MessageRichTextへproviderを渡さずCodex応答のpathが操作できない、または他providerとuserへCodex解析を適用する"
// observable = "実SessionMessageColumnの通常Markdown linkとfile reference linkのhref・textContent"
// observation_boundary = "component-behavior"
// scope = "会話列のprovider別response Markdown接続"
// lifecycle = "permanent"
// impact = "生成成果物への導線が欠けるか、別providerの本文を誤解釈する"
// distinction = "parser単体と型検査では会話列の保存済み・live・pending各callerの適用を観測できない。短いSSR入力だけで接続を維持する"
// @end-test-value
/** Codex固有のファイル参照解釈は応答元に従い、保存済み・live・pendingに適用されても他providerやuserに波及しない。 */
test("会話列は応答元providerの構文を保存済み・live・pendingに適用する", () => {
  const text =
    'visualize{"path":"/work/view.html"} [ordinary](/work/plain.md)';
  for (const provider of ["codex", "claude", "copilot", undefined]) {
    for (const state of ["saved", "live", "pending"] as const) {
      const html = renderSessionMessageColumn({
        provider,
        messages:
          state === "saved"
            ? [
                { role: "user", text },
                { role: "assistant", text },
              ]
            : [],
        isRunning: state !== "saved",
        liveRunAssistantText: state === "live" ? text : undefined,
        pendingMessageText: state === "pending" ? text : undefined,
      });
      const dom = new JSDOM(html);
      try {
        const links = [
          ...dom.window.document.querySelectorAll('a[href="/work/view.html"]'),
        ];
        assert.deepEqual(
          links.map((link) => link.textContent),
          provider === "codex" ? ["view.html"] : [],
        );
        assert.equal(
          dom.window.document.querySelectorAll('a[href="/work/plain.md"]')
            .length,
          state === "saved" ? 2 : 1,
        );
      } finally {
        dom.window.close();
      }
    }
  }
});

/** 仮想行や追加表示の初期マークアップを比較できるよう、会話列をDOM環境なしで描画する。 */
function renderSessionMessageColumn(options: {
  messages: Message[];
  provider?: string;
  submissionError?: string;
  submissionUncertain?: boolean;
  pendingResponseMessageKey?: string | null;
  expandedArtifacts?: Record<string, boolean>;
  isRunning?: boolean;
  pendingRunIndicatorAnnouncement?: string;
  isMessageListFollowing?: boolean;
  liveApprovalRequest?: LiveApprovalRequest | null;
  liveElicitationRequest?: LiveElicitationRequest | null;
  liveRunAssistantText?: string;
  liveRunErrorMessage?: string;
  pendingMessageText?: string;
  pendingMessageTextVisible?: boolean;
  pendingMessageGroupId?: string | null;
  withResponseActions?: boolean;
  messageGroups?: SessionMessageColumnProps["messageGroups"];
  messageKeys?: SessionMessageColumnProps["messageKeys"];
  messageCollapseTargets?: SessionMessageColumnProps["messageCollapseTargets"];
  collapsedMessageKeys?: SessionMessageColumnProps["collapsedMessageKeys"];
  messageJumpRequest?: SessionMessageColumnProps["messageJumpRequest"];
  onToggleMessageCollapse?: SessionMessageColumnProps["onToggleMessageCollapse"];
  onToggleAllMessageCollapse?: SessionMessageColumnProps["onToggleAllMessageCollapse"];
  onToggleMessageBookmark?: SessionMessageColumnProps["onToggleMessageBookmark"];
  messageViewMode?: SessionMessageColumnProps["messageViewMode"];
  glossaryAnnotationMatcher?: SessionMessageColumnProps["glossaryAnnotationMatcher"];
  onActivateGlossaryEntry?: SessionMessageColumnProps["onActivateGlossaryEntry"];
}): string {
  return renderToStaticMarkup(
    React.createElement(SessionMessageColumn, {
      sessionId: "session-1",
      provider: options.provider,
      character: createCharacterProfile(),
      messages: options.messages,
      submissionError: options.submissionError,
      submissionUncertain: options.submissionUncertain,
      messageKeys: options.messageKeys,
      pendingResponseMessageKey: options.pendingResponseMessageKey,
      messageGroups: options.messageGroups,
      expandedArtifacts: options.expandedArtifacts ?? {},
      messageListRef: createRef<HTMLDivElement>(),
      isRunning: options.isRunning ?? false,
      pendingRunIndicatorAnnouncement: options.pendingRunIndicatorAnnouncement,
      liveApprovalRequest: options.liveApprovalRequest ?? null,
      approvalActionRequestId: null,
      liveElicitationRequest: options.liveElicitationRequest ?? null,
      elicitationActionRequestId: null,
      liveRunAssistantText: options.liveRunAssistantText ?? "",
      hasLiveRunAssistantText: !!options.liveRunAssistantText,
      liveRunErrorMessage: options.liveRunErrorMessage ?? "",
      pendingMessageText: options.pendingMessageText,
      pendingMessageTextVisible: options.pendingMessageTextVisible,
      pendingMessageGroupId: options.pendingMessageGroupId,
      isMessageListFollowing: options.isMessageListFollowing ?? false,
      /** 静的描画ではスクロール通知を親へ渡さない。 */
      onMessageListScroll() {},
      /** 初期HTMLの比較ではartifactの状態を操作しない。 */
      onToggleArtifact() {},
      /** diff画面を起動せずに会話列の出力を調べる。 */
      onOpenDiff() {},
      /** 承認操作は実行せず要求表示のみを確認できるようにする。 */
      onResolveLiveApproval() {},
      /** 質問への回答を送らず初期マークアップを調べる。 */
      onResolveLiveElicitation() {},
      onOpenPath: undefined,
      onCopyMessageText: options.withResponseActions ? () => {} : undefined,
      onQuoteMessageText: options.withResponseActions ? () => {} : undefined,
      onToggleMessageBookmark: options.onToggleMessageBookmark,
      messageViewMode: options.messageViewMode,
      glossaryAnnotationMatcher: options.glossaryAnnotationMatcher,
      onActivateGlossaryEntry: options.onActivateGlossaryEntry,
    }),
  );
}

// @test-value v2
// kind = "contract"
// claim = "開始前・空応答・部分応答の確定失敗は応答側の同じ欄に理由を一度表示し、生成本文とDetailsを保持する。受付結果不明はFailedにしない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 確定した送信・実行失敗" }
// fault = "応答前の失敗欄が異なる、本文に理由が混入する、部分本文・Detailsを失う、または結果不明をFailedにする"
// observable = "実Columnのassistant行内のalert、本文領域、Show details操作、Failedの有無"
// observation_boundary = "component-behavior"
// scope = "SessionMessageColumn failure presentation"
// lifecycle = "permanent"
// impact = "失敗箇所の探索負担と理由の二重表示、生成内容の誤認を防ぐ"
// distinction = "runtime/storage testでは共通欄への描画と本文操作の境界を検証できない。小さいSSR fixtureで表示契約を維持する"
// @end-test-value
/** 確定した失敗文言が生成本文に混入せず、応答に属する共通の表示欄に置かれる。 */
test("確定失敗は応答側の共通欄で生成本文と分離する", () => {
  const reason = "Selected model is at capacity.\nTry a different model.";
  for (const text of [null, "", "途中までの返答"]) {
    const document = new JSDOM(
      renderSessionMessageColumn({
        messages: [
          { role: "user", text: "request" },
          ...(text === null
            ? []
            : [{ ...createArtifactMessage(), text, runFailure: reason }]),
        ],
        submissionError: text === null ? reason : undefined,
        withResponseActions: true,
      }),
    ).window.document;
    assert.equal(document.querySelectorAll(".session-run-failure").length, 1);
    assert.equal(
      document.querySelector(".message-row.assistant [role=alert]")
        ?.textContent,
      `Failed${reason}`,
    );
    assert.equal(document.body.textContent?.split(reason).length, 2);
    assert.equal(
      document.querySelector(".message-row.user")?.textContent,
      "request",
    );
    if (text !== null) {
      assert.equal(
        document.querySelector(".message-row.assistant [data-message-body]")
          ?.textContent,
        text,
      );
      assert.ok(document.querySelector('button[aria-label="Show details"]'));
    }
  }
  const uncertain = new JSDOM(
    renderSessionMessageColumn({
      messages: [{ role: "user", text: "request" }],
      submissionError: "Acceptance outcome unknown.",
      submissionUncertain: true,
    }),
  ).window.document;
  assert.equal(
    uncertain.querySelector("[role=alert]")?.textContent,
    "Acceptance outcome unknown.",
  );
  assert.equal(uncertain.querySelector(".session-run-failure"), null);
});

// @test-value v2
// kind = "contract"
// claim = "artifact詳細は再open・非表示からの復帰時に再取得し、閉じた間の古い取得結果は後の表示を上書きしない。会話本文は維持する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Persistence; docs/design/desktop-ui.md: assistant message ごとのTurn Summary" }
// fault = "閉じたdetailを再利用して古い操作内容を表示する、遅い取得で新しいdetailを上書きする、または本文を破棄する"
// observable = "実SessionMessageColumnのartifact取得回数・Run Checksの内容・本文"
// observation_boundary = "component-behavior"
// scope = "conversation artifact detail lifecycle"
// lifecycle = "permanent"
// impact = "大きな再取得可能detailの積み上がりと古い実行詳細の誤表示を防ぎ、会話の閲覧状態を保つ"
// distinction = "型検査やページ離脱testでは同じmessageの開閉・非表示・遅延取得順を確認できない。短いdeferred操作でCIの保持負担を限定する"
// @end-test-value
/** 詳細の開き直しで再取得し、後から完了した古い要求が新しい詳細を上書きしない。 */
test("artifactは再openで最新取得し閉じた間の遅いdetailを適用しない", async () => {
  const summary: MessageArtifact = {
    title: "summary",
    activitySummary: [],
    changedFiles: [],
    runChecks: [],
    detailAvailable: true,
  };
  const message: Message = {
    role: "assistant",
    text: "saved body",
    artifact: summary,
  };
  const pending: Array<(detail: MessageArtifact) => void> = [];
  const mounted = await mountSessionMessageColumn({
    messages: [message],
    messageKeys: ["artifact"],
    expandedArtifacts: { artifact: true },
    /** 取得要求を任意の順に完了させられるよう、詳細の解決関数を保存する。 */
    onLoadArtifactDetail: () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  });
  try {
    assert.equal(pending.length, 1);
    await mounted.rerender({ expandedArtifacts: {} });
    await mounted.rerender({ expandedArtifacts: { artifact: true } });
    assert.equal(pending.length, 2);
    await act(async () => {
      pending[1]!({
        ...summary,
        runChecks: [{ label: "Result", value: "latest detail" }],
      });
    });
    assert.match(mounted.container.textContent ?? "", /latest detail/);
    await act(async () => {
      pending[0]!({
        ...summary,
        runChecks: [{ label: "Result", value: "stale detail" }],
      });
    });
    assert.doesNotMatch(mounted.container.textContent ?? "", /stale detail/);
    await mounted.rerender({ expandedArtifacts: {} });
    await mounted.rerender({ expandedArtifacts: { artifact: true } });
    assert.equal(pending.length, 3);
    await act(async () => {
      pending[2]!({
        ...summary,
        runChecks: [
          { label: "Result", value: "collapsed then reopened detail" },
        ],
      });
    });
    assert.match(
      mounted.container.textContent ?? "",
      /collapsed then reopened detail/,
    );
    await mounted.rerender({
      artifactDetailsEnabled: false,
      expandedArtifacts: { artifact: true },
    });
    await mounted.rerender({
      artifactDetailsEnabled: true,
      expandedArtifacts: { artifact: true },
    });
    assert.equal(pending.length, 4);
    await act(async () => {
      pending[3]!({
        ...summary,
        runChecks: [{ label: "Result", value: "reopened detail" }],
      });
    });
    assert.match(mounted.container.textContent ?? "", /reopened detail/);
    assert.match(mounted.container.textContent ?? "", /saved body/);
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "保存応答の既存Detailsを開くと同じTurnの配送状態を取得し、設定と入力状態を独立開閉しながら操作・配送状態をその応答内で確認できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details; user: プロンプト枠は本文、詳細はレスポンス側へ集約" }
// fault = "応答Detailsから入力詳細へ到達できない、別の応答seqで取得する、または既存の実行設定・操作を失う"
// observable = "実SessionMessageColumnのDetails展開前後の取得request、assistant行内のRun Checks・Operations・配送状態"
// observation_boundary = "consumer"
// scope = "SessionMessageColumnからTurnExecutionDetailsへの接続。共通read APIは保存snapshot fixtureで代替"
// lifecycle = "permanent"
// impact = "どの入力で得た応答かを実行設定と同じ場所で確認できなくなる"
// distinction = "単体の入力状態testや型検査では既存レスポンスDetailsへの接続と取得契機を検出できない。短い1会話の開閉だけを検証する"
// @end-test-value
/** 詳細欄に実行設定と配送の完了状態をまとめ、本文と別に確認できる。 */
test("応答Detailsに実行設定と配送状態を集約する", async () => {
  const response = { ...createArtifactMessage(), historyIndex: 9 };
  response.artifact!.runChecks = [
    { label: "provider", value: "Codex" },
    { label: "model", value: "saved-model" },
  ];
  const mounted = await mountSessionMessageColumn({
    messages: [{ role: "user", text: "prompt" }, response],
    messageKeys: ["prompt", "response"],
  });
  const requests: Array<{
    operation: string;
    request: Record<string, unknown>;
  }> = [];
  Object.defineProperty(mounted.dom.window, "withmate", {
    configurable: true,
    value: {
      /** 呼ばれた実行参照操作を記録し、カード一覧と実行明細には異なる結果を返す。 */
      readSessionExecution: async (
        _owner: string,
        operation: string,
        request: Record<string, unknown>,
      ) => {
        requests.push({ operation, request });
        if (operation === "list_sent_instruction_cards")
          return {
            ok: true,
            items: [],
            cursors: { receipts: null, steers: null },
          };
        assert.equal(operation, "get_execution");
        return {
          ok: true,
          receiptId: "start",
          turnId: "42",
          userMessageSeq: 8,
          assistantMessageSeq: 9,
          receiptState: "completed",
          turnState: "completed",
        };
      },
    },
  });
  try {
    const context = {
      ownerSessionId: "main",
      target: { kind: "main", sessionId: "main", incarnationId: "inc" },
    } as const;
    await mounted.rerender({ inputReadContext: context });
    assert.equal(
      requests.filter((read) => read.operation === "get_execution").length,
      0,
    );
    await mounted.rerender({
      inputReadContext: context,
      expandedArtifacts: { response: true },
    });
    const assistant = mounted.container.querySelector(
      ".message-row.assistant",
    )!;
    assert.match(assistant.textContent!, /Run Checks.*Codex.*saved-model/s);
    assert.match(assistant.textContent!, /Operations.*updated file/s);
    assert.deepEqual(
      [...assistant.querySelectorAll("pre")].map((node) => node.textContent),
      ["details for operation"],
    );
    assert.match(
      assistant.textContent!,
      /Receipt StateCompleted.*Turn StateCompleted/s,
    );
    assert.deepEqual(
      requests
        .filter((read) => read.operation === "get_execution")
        .map((read) => read.request.messageSeq),
      [9],
    );
    assert.equal(
      mounted.container.querySelector(".message-row.user")?.textContent,
      "prompt",
    );
    const checks = assistant.querySelector<HTMLDetailsElement>(
      'details[aria-label="Run Checks"]',
    )!;
    const state = assistant.querySelector<HTMLDetailsElement>(
      'details[aria-label="Input State"]',
    )!;
    assert.equal(checks.open, true);
    assert.equal(state.open, true);
    await act(async () => {
      checks.open = false;
      checks.dispatchEvent(new mounted.dom.window.Event("toggle"));
    });
    assert.equal(checks.open, false);
    assert.equal(state.open, true);
    await mounted.rerender({
      inputReadContext: context,
      expandedArtifacts: {},
    });
    await mounted.rerender({
      inputReadContext: context,
      expandedArtifacts: { response: true },
    });
    assert.equal(
      requests.filter((read) => read.operation === "get_execution").length,
      2,
    );
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "artifactのnullと取得失敗は同じ展開・表示期間で一度だけ取得し、再open・再表示・page復帰で再取得できる。本文と失敗の説明を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: assistant message ごとのTurn Summary; docs/design/auxiliary-session.md: Persistence" }
// fault = "本文更新で欠落・失敗済みdetailを再取得するか、取得試行を解放せず再openでも最新detailを取得できない"
// observable = "実SessionMessageColumnの取得回数、Loading detailsの終了、欠落・失敗alert、復帰後のRun Checksと本文"
// observation_boundary = "component-behavior"
// scope = "artifact detail unsuccessful attempt lifetime"
// lifecycle = "permanent"
// impact = "streaming頻度の反復IPCとloading点滅を防ぎ、詳細だけの失敗から会話本文を失わず復帰できる"
// distinction = "成功detailの解放・遅延取得testではnullとrejectの取得寿命を確認できない。2結果の短いDOM操作だけで継続負担を限定する"
// @end-test-value
/** 詳細の欠落と取得失敗はいずれも本文更新で再試行せず、閉じて開き直すと復帰できる。 */
test("artifactの欠落と失敗は本文更新で再取得せず再openで復帰できる", async () => {
  for (const outcome of ["null", "reject"] as const) {
    const summary: MessageArtifact = {
      title: "summary",
      activitySummary: [],
      changedFiles: [],
      runChecks: [],
      detailAvailable: true,
    };
    const message: Message = {
      role: "assistant",
      text: "saved body",
      artifact: summary,
    };
    let attempts = 0;
    const mounted = await mountSessionMessageColumn({
      messages: [message],
      messageKeys: ["artifact"],
      expandedArtifacts: { artifact: true },
      /** 最初の試行に欠落または失敗を返し、復帰時にだけ最新詳細を返す。 */
      onLoadArtifactDetail: async () => {
        ++attempts;
        if (attempts >= 3)
          return {
            ...summary,
            runChecks: [{ label: "Result", value: "latest detail" }],
          };
        if (outcome === "reject") throw new Error("detail load failed");
        return null;
      },
    });
    try {
      assert.equal(attempts, 1);
      const errorText =
        outcome === "null"
          ? /Details are unavailable/
          : /Failed to load details/;
      assert.match(
        mounted.container.querySelector('[role="alert"]')?.textContent ?? "",
        errorText,
      );
      assert.doesNotMatch(
        mounted.container.textContent ?? "",
        /Loading details/,
      );
      for (let delta = 1; delta <= 5; ++delta) {
        await mounted.rerender({
          messages: [{ ...message, text: `saved body ${delta}` }],
        });
      }
      assert.equal(attempts, 1);
      await mounted.rerender({ expandedArtifacts: {} });
      await mounted.rerender({ expandedArtifacts: { artifact: true } });
      assert.equal(attempts, 2);
      assert.match(
        mounted.container.querySelector('[role="alert"]')?.textContent ?? "",
        errorText,
      );
      await mounted.rerender({ artifactDetailsEnabled: false });
      await mounted.rerender({ artifactDetailsEnabled: true });
      assert.equal(attempts, 3);
      assert.match(mounted.container.textContent ?? "", /latest detail/);
      assert.equal(mounted.container.querySelector('[role="alert"]'), null);
      await mounted.rerender({ messages: [], messageKeys: [] });
      await mounted.rerender({
        messages: [message],
        messageKeys: ["artifact"],
      });
      assert.equal(attempts, 4);
      assert.match(mounted.container.textContent ?? "", /latest detail/);
      assert.match(mounted.container.textContent ?? "", /saved body/);
    } finally {
      await mounted.cleanup();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "本文なし成功結果は取得済みDetailsを展開しfocus中にviewport内で表示すると既読になり、未展開・読込中・取得失敗・画面外では未読を保つ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Monitorの自動既読とTurn Summary" }
// fault = "本文なしの成功結果を既読にできない、またはDetailsの未取得summaryや取得失敗を結果閲覧として既読にする"
// observable = "実SessionMessageColumnのDetails開閉・非同期取得・表示位置に対する既読API呼出の会話IDとturn ID"
// observation_boundary = "component-behavior"
// scope = "artifact-only resultのDetails表示と自動既読observer接続"
// lifecycle = "permanent"
// impact = "確認済みのツール結果がMonitorで未読のまま残る、または未閲覧の結果が既読になる"
// distinction = "observer単体は手製DOMであり実componentの詳細取得状態との接続を検出できない。既存mount helperと3つの短い取得経路で確認する"
// @end-test-value
/** 本文がない成功応答は、詳細取得の完了だけでなくフォーカス中に可視となった場合だけ既読になる。 */
test("本文なし成功結果は取得済みDetailsを表示した時だけ既読にする", async () => {
  for (const mode of ["loaded", "missing", "failed"] as const) {
    const detail: MessageArtifact = {
      title: "Tool result",
      activitySummary: ["Found 3 records"],
      changedFiles: [],
      runChecks: [{ label: "Result", value: "Completed" }],
    };
    const pending: Array<{
      resolve: (value: MessageArtifact | null) => void;
      reject: (error: Error) => void;
    }> = [];
    const mounted = await mountSessionMessageColumn({
      messages: [
        {
          role: "assistant",
          text: "",
          artifact:
            mode === "loaded"
              ? detail
              : { ...detail, activitySummary: [], detailAvailable: true },
        },
      ],
      messageKeys: ["artifact-only"],
      /** 詳細取得の完了時点をテストから制御できるよう待機させる。 */
      onLoadArtifactDetail: () =>
        new Promise((resolve, reject) => pending.push({ resolve, reject })),
    });
    let top = 20;
    let focused = true;
    const acknowledgements: Array<[string, number]> = [];
    const window = mounted.dom.window;
    const originalBounds = window.HTMLElement.prototype.getBoundingClientRect;
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList.contains("artifact-block")
        ? createRect({ top, left: 0, width: 400, height: 180 })
        : originalBounds.call(this);
    };
    Object.defineProperty(window.document, "hasFocus", {
      /** 読了判定が参照する文書のフォーカス状態を切り替える。 */
      value: () => focused,
    });
    const list = mounted.messageListRef.current!;
    const dispose = observeSessionResultRead({
      sessionId: "session-1",
      list,
      assistantMessageIndexes: new Map([[8, 0]]),
      api: {
        /** 本文の代わりに詳細の閲覧で既読にする未読ターンを返す。 */
        getUnreadSessionResult: async () => ({
          turnId: 7,
          assistantMessageSeq: 8,
        }),
        /** 対象SessionとTurnの既読通知を記録して成功を返す。 */
        markSessionResultRead: async (id, turnId) => {
          acknowledgements.push([id, turnId]);
          return true;
        },
        /** ターン更新を配送せず、解除可能な購読口だけを提供する。 */
        onSessionTurnUpdated: () => () => {},
      },
    });
    /** 位置やフォーカスの操作後、既読判定に必要なフレームまで待つ。 */
    const settle = (action = () => {}) =>
      act(async () => {
        action();
        await Promise.resolve();
        await new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => resolve()),
        );
      });
    try {
      await settle();
      assert.deepEqual(acknowledgements, []);
      top = 800;
      await mounted.rerender({ expandedArtifacts: { "artifact-only": true } });
      if (mode !== "loaded") {
        top = 20;
        await settle();
        assert.deepEqual(acknowledgements, []);
        await act(async () => {
          if (mode === "missing") pending[0].resolve(null);
          else pending[0].reject(new Error("Details unavailable"));
        });
        await settle();
        assert.ok(mounted.container.querySelector('[role="alert"]'));
        assert.deepEqual(acknowledgements, []);
        await mounted.rerender({ expandedArtifacts: {} });
        await mounted.rerender({
          expandedArtifacts: { "artifact-only": true },
        });
        top = 800;
        await act(async () => pending[1].resolve(detail));
      }
      await settle();
      assert.match(mounted.container.textContent ?? "", /Completed/);
      assert.deepEqual(acknowledgements, []);
      focused = false;
      top = 20;
      await settle(() => {
        list.dispatchEvent(new window.Event("scroll"));
      });
      assert.deepEqual(acknowledgements, []);
      focused = true;
      await settle(() => {
        window.dispatchEvent(new window.Event("focus"));
      });
      assert.deepEqual(acknowledgements, [["session-1", 7]]);
    } finally {
      dispose();
      await mounted.cleanup();
    }
  }
});

/** JSDOMで実際のレイアウトに頼らず、指定した位置と寸法から境界矩形を構成する。 */
function createRect(input: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    left: input.left,
    top: input.top,
    width: input.width,
    height: input.height,
    right: input.left + input.width,
    bottom: input.top + input.height,
    x: input.left,
    y: input.top,
    /** テスト用の矩形をそのままシリアル化可能な値として返す。 */
    toJSON() {
      return this;
    },
  } as DOMRect;
}

/** 描画済みの会話列と再描画・行計測・後片付けの各操作をまとめる。 */
type MountedSessionMessageColumn = {
  container: HTMLElement;
  dom: JSDOM;
  messageListRef: React.RefObject<HTMLDivElement | null>;
  root: Root;
  rerender: (callbacks: {
    sessionId?: string;
    inputReadContext?: SessionMessageColumnProps["inputReadContext"];
    isContentActive?: boolean;
    expandedArtifacts?: Record<string, boolean>;
    artifactDetailsEnabled?: boolean;
    isMessageListFollowing?: boolean;
    messageGroups?: SessionMessageColumnProps["messageGroups"];
    messageKeys?: SessionMessageColumnProps["messageKeys"];
    messageCollapseTargets?: SessionMessageColumnProps["messageCollapseTargets"];
    collapsedMessageKeys?: SessionMessageColumnProps["collapsedMessageKeys"];
    messageJumpRequest?: SessionMessageColumnProps["messageJumpRequest"];
    onToggleMessageCollapse?: SessionMessageColumnProps["onToggleMessageCollapse"];
    onToggleAllMessageCollapse?: SessionMessageColumnProps["onToggleAllMessageCollapse"];
    onToggleMessageBookmark?: SessionMessageColumnProps["onToggleMessageBookmark"];
    messages?: Message[];
    isRunning?: boolean;
    liveRunAssistantText?: string;
    liveElicitationRequest?: LiveElicitationRequest | null;
    onCopyMessageText?: (text: string) => void;
    onQuoteMessageText?: (text: string) => void;
    pendingMessageGroupId?: string | null;
    pendingMessageText?: string;
    messageViewMode?: SessionMessageColumnProps["messageViewMode"];
  }) => Promise<void>;
  resizeMessageRow: (index: number, height: number) => Promise<void>;
  cleanup: () => Promise<void>;
};

/** スクロールと行高を模擬したJSDOMへ会話列をマウントし、DOM上の操作と観測を可能にする。 */
async function mountSessionMessageColumn(options: {
  sessionId?: string;
  inputReadContext?: SessionMessageColumnProps["inputReadContext"];
  messages: Message[];
  onCopyMessageText?: (text: string) => void;
  onQuoteMessageText?: (text: string) => void;
  expandedArtifacts?: Record<string, boolean>;
  artifactDetailsEnabled?: boolean;
  onLoadArtifactDetail?: SessionMessageColumnProps["onLoadArtifactDetail"];
  isContentActive?: boolean;
  component?: ComponentType<SessionMessageColumnProps>;
  isRunning?: boolean;
  liveRunAssistantText?: string;
  liveElicitationRequest?: LiveElicitationRequest | null;
  onResolveLiveElicitation?: SessionMessageColumnProps["onResolveLiveElicitation"];
  messageGroups?: SessionMessageColumnProps["messageGroups"];
  messageKeys?: SessionMessageColumnProps["messageKeys"];
  messageCollapseTargets?: SessionMessageColumnProps["messageCollapseTargets"];
  collapsedMessageKeys?: SessionMessageColumnProps["collapsedMessageKeys"];
  messageJumpRequest?: SessionMessageColumnProps["messageJumpRequest"];
  onToggleMessageCollapse?: SessionMessageColumnProps["onToggleMessageCollapse"];
  onToggleAllMessageCollapse?: SessionMessageColumnProps["onToggleAllMessageCollapse"];
  onToggleMessageBookmark?: SessionMessageColumnProps["onToggleMessageBookmark"];
  pendingMessageGroupId?: string | null;
  pendingMessageText?: string;
  pendingMessageTextVisible?: boolean;
  messageViewMode?: SessionMessageColumnProps["messageViewMode"];
  onRender?: ProfilerOnRenderCallback;
}): Promise<MountedSessionMessageColumn> {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousDOMRect = globalThis.DOMRect;
  const previousEvent = globalThis.Event;
  const previousMouseEvent = globalThis.MouseEvent;
  const previousNavigator = globalThis.navigator;
  const previousRequestAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame",
  );
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
  });
  const container = dom.window.document.getElementById("root") as HTMLElement;
  const messageListRef = createRef<HTMLDivElement>();
  const root = createRoot(container);
  const originalGetBoundingClientRect =
    dom.window.HTMLElement.prototype.getBoundingClientRect;
  const originalAttachEvent = (
    dom.window.HTMLElement.prototype as unknown as { attachEvent?: () => void }
  ).attachEvent;
  const originalDetachEvent = (
    dom.window.HTMLElement.prototype as unknown as { detachEvent?: () => void }
  ).detachEvent;
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    "offsetHeight",
  );
  const originalClientHeight = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    "clientHeight",
  );
  const originalScrollHeight = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    "scrollHeight",
  );
  const originalScrollTo = dom.window.HTMLElement.prototype.scrollTo;
  const originalScrollIntoView =
    dom.window.HTMLElement.prototype.scrollIntoView;
  const originalResizeObserver = dom.window.ResizeObserver;
  const messageRowHeights = new Map<number, number>();
  const resizeObservers: Array<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
  }> = [];

  /** 実ブラウザーの自動通知の代わりに、テストが行高変更を通知できるResizeObserverを提供する。 */
  class TestResizeObserver implements ResizeObserver {
    private readonly registration: (typeof resizeObservers)[number];

    /** 通知先を観測対象の集合と一緒に登録する。 */
    constructor(callback: ResizeObserverCallback) {
      this.registration = { callback, elements: new Set() };
      resizeObservers.push(this.registration);
    }

    /** 指定した要素を以後の行高変更の通知対象に加える。 */
    observe(target: Element): void {
      this.registration.elements.add(target);
    }

    /** 対象の計測が解除された後に通知を送らないようにする。 */
    unobserve(target: Element): void {
      this.registration.elements.delete(target);
    }

    /** observer単位で対象を空にし、その後の変更通知を止める。 */
    disconnect(): void {
      this.registration.elements.clear();
    }

    /** 自動計測による未配送のレコードは持たない。 */
    takeRecords(): ResizeObserverEntry[] {
      return [];
    }
  }

  Object.defineProperty(dom.window, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    /** Reactの旧式イベント登録をJSDOMの通常イベントへ橋渡しする。 */
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.addEventListener(name.replace(/^on/, ""), listener);
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    /** 登録時と同じ名前変換でJSDOMのイベント購読を解除する。 */
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.removeEventListener(name.replace(/^on/, ""), listener);
    },
  });
  dom.window.HTMLElement.prototype.scrollTo = function scrollTo(
    optionsOrX?: ScrollToOptions | number,
    y?: number,
  ): void {
    if (typeof optionsOrX === "number") {
      this.scrollLeft = optionsOrX;
      this.scrollTop = y ?? this.scrollTop;
      return;
    }
    if (typeof optionsOrX?.left === "number") {
      this.scrollLeft = optionsOrX.left;
    }
    if (typeof optionsOrX?.top === "number") {
      this.scrollTop = optionsOrX.top;
    }
  };
  dom.window.HTMLElement.prototype.scrollIntoView =
    function scrollIntoView() {};

  dom.window.HTMLElement.prototype.getBoundingClientRect =
    function getBoundingClientRect() {
      if (this.classList.contains("session-selection-action-overlay")) {
        return createRect({ left: 0, top: 0, width: 960, height: 720 });
      }
      if (this.classList.contains("session-message-list")) {
        return createRect({ left: 0, top: 0, width: 960, height: 720 });
      }
      if (this.classList.contains("session-message-virtual-row")) {
        const index = Number(this.getAttribute("data-index"));
        return createRect({
          left: 0,
          top: 0,
          width: 960,
          height: messageRowHeights.get(index) ?? 168,
        });
      }
      return originalGetBoundingClientRect.call(this);
    };
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    /** 仮想一覧の高さと各行の可変高をテスト用の値で返す。 */
    get() {
      if (this.classList.contains("session-message-list")) {
        return 720;
      }
      if (this.classList.contains("session-message-virtual-row")) {
        const index = Number(this.getAttribute("data-index"));
        return messageRowHeights.get(index) ?? 168;
      }
      return 0;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    /** 仮想一覧についてだけスクロール領域の表示高を返す。 */
    get() {
      return this.classList.contains("session-message-list") ? 720 : 0;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    /** 仮想リスト全体の高さを、アプリが設定したスペーサーのstyleから読み取る。 */
    get() {
      if (!this.classList.contains("session-message-list")) {
        return 0;
      }
      const items = this.querySelector(
        ".session-message-list-window-items",
      ) as HTMLElement | null;
      return Number.parseFloat(items?.style.height ?? "0") || 0;
    },
  });

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: dom.window.Node,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: dom.window.HTMLElement,
  });
  Object.defineProperty(globalThis, "DOMRect", {
    configurable: true,
    value: dom.window.DOMRect,
  });
  Object.defineProperty(globalThis, "Event", {
    configurable: true,
    value: dom.window.Event,
  });
  Object.defineProperty(globalThis, "MouseEvent", {
    configurable: true,
    value: dom.window.MouseEvent,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });

  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: dom.window.requestAnimationFrame.bind(dom.window),
  });

  const MessageColumn = options.component ?? SessionMessageColumn;
  const character = createCharacterProfile();
  const expandedArtifacts = options.expandedArtifacts ?? {};
  /** 同じReact rootを使って、指定されたpropsだけ差し替え会話列を更新する。 */
  const renderMessageColumn = async (callbacks: {
    sessionId?: string;
    inputReadContext?: SessionMessageColumnProps["inputReadContext"];
    isContentActive?: boolean;
    expandedArtifacts?: Record<string, boolean>;
    artifactDetailsEnabled?: boolean;
    isMessageListFollowing?: boolean;
    messageGroups?: SessionMessageColumnProps["messageGroups"];
    messageKeys?: SessionMessageColumnProps["messageKeys"];
    messageCollapseTargets?: SessionMessageColumnProps["messageCollapseTargets"];
    collapsedMessageKeys?: SessionMessageColumnProps["collapsedMessageKeys"];
    messageJumpRequest?: SessionMessageColumnProps["messageJumpRequest"];
    onToggleMessageCollapse?: SessionMessageColumnProps["onToggleMessageCollapse"];
    onToggleAllMessageCollapse?: SessionMessageColumnProps["onToggleAllMessageCollapse"];
    onToggleMessageBookmark?: SessionMessageColumnProps["onToggleMessageBookmark"];
    messages?: Message[];
    isRunning?: boolean;
    liveRunAssistantText?: string;
    liveElicitationRequest?: LiveElicitationRequest | null;
    onCopyMessageText?: (text: string) => void;
    onQuoteMessageText?: (text: string) => void;
    pendingMessageGroupId?: string | null;
    pendingMessageText?: string;
    pendingMessageTextVisible?: boolean;
    messageViewMode?: SessionMessageColumnProps["messageViewMode"];
  }) => {
    await act(async () => {
      const messageColumn = React.createElement(MessageColumn, {
        sessionId: callbacks.sessionId ?? options.sessionId ?? "session-1",
        inputReadContext:
          callbacks.inputReadContext ?? options.inputReadContext,
        character,
        messages: callbacks.messages ?? options.messages,
        messageKeys: callbacks.messageKeys ?? options.messageKeys,
        messageGroups: callbacks.messageGroups ?? options.messageGroups,
        messageCollapseTargets:
          callbacks.messageCollapseTargets ?? options.messageCollapseTargets,
        collapsedMessageKeys:
          callbacks.collapsedMessageKeys ?? options.collapsedMessageKeys,
        messageJumpRequest:
          callbacks.messageJumpRequest ?? options.messageJumpRequest,
        expandedArtifacts: callbacks.expandedArtifacts ?? expandedArtifacts,
        artifactDetailsEnabled:
          callbacks.artifactDetailsEnabled ?? options.artifactDetailsEnabled,
        onLoadArtifactDetail: options.onLoadArtifactDetail,
        messageListRef,
        isRunning: callbacks.isRunning ?? options.isRunning ?? false,
        liveApprovalRequest: null,
        approvalActionRequestId: null,
        liveElicitationRequest:
          callbacks.liveElicitationRequest !== undefined
            ? callbacks.liveElicitationRequest
            : (options.liveElicitationRequest ?? null),
        elicitationActionRequestId: null,
        liveRunAssistantText:
          callbacks.liveRunAssistantText ?? options.liveRunAssistantText ?? "",
        hasLiveRunAssistantText: !!(
          callbacks.liveRunAssistantText ?? options.liveRunAssistantText
        ),
        liveRunErrorMessage: "",
        pendingMessageText:
          callbacks.pendingMessageText ?? options.pendingMessageText,
        pendingMessageTextVisible:
          callbacks.pendingMessageTextVisible ??
          options.pendingMessageTextVisible,
        pendingMessageGroupId:
          callbacks.pendingMessageGroupId ?? options.pendingMessageGroupId,
        isMessageListFollowing: callbacks.isMessageListFollowing ?? false,
        isContentActive:
          callbacks.isContentActive ?? options.isContentActive ?? true,
        /** スクロールを親の追従処理には伝えず、列自身の反応を観測する。 */
        onMessageListScroll() {},
        onToggleMessageCollapse:
          callbacks.onToggleMessageCollapse ?? options.onToggleMessageCollapse,
        onToggleAllMessageCollapse:
          callbacks.onToggleAllMessageCollapse ??
          options.onToggleAllMessageCollapse,
        onToggleMessageBookmark:
          callbacks.onToggleMessageBookmark ?? options.onToggleMessageBookmark,
        /** 初期表示に必要なartifact操作口を、状態変更なしで埋める。 */
        onToggleArtifact() {},
        /** 詳細内のdiff遷移はこのマウント内では実行しない。 */
        onOpenDiff() {},
        /** 承認の既定通知先は処理を行わず必要なケースが差し替える。 */
        onResolveLiveApproval() {},
        onResolveLiveElicitation:
          options.onResolveLiveElicitation ?? (() => {}),
        onOpenPath: undefined,
        onCopyMessageText: callbacks.onCopyMessageText,
        onQuoteMessageText: callbacks.onQuoteMessageText,
        messageViewMode: callbacks.messageViewMode ?? options.messageViewMode,
      });
      const profiledMessageColumn = options.onRender
        ? React.createElement(
            React.Profiler,
            { id: "session-message-column", onRender: options.onRender },
            messageColumn,
          )
        : messageColumn;
      root.render(
        React.createElement(SessionChatScreen, {
          mode: "agent",
          header: null,
          headerSplitter: null,
          isHeaderVisible: false,
          messageColumn: profiledMessageColumn,
          actionDock: null,
          actionDockSplitter: null,
          isActionDockExpanded: false,
          splitter: null,
          rightPane: null,
        }),
      );
    });
  };

  await renderMessageColumn(options);

  return {
    container,
    dom,
    messageListRef,
    root,
    rerender: renderMessageColumn,
    /** マウント済み行の高さを変え、観測中のResizeObserverに通知して次のフレームを待つ。 */
    async resizeMessageRow(index, height) {
      messageRowHeights.set(index, height);
      const row = container.querySelector(
        `.session-message-virtual-row[data-index="${index}"]`,
      );
      assert.ok(row, `message row ${index} が描画されていない`);
      const entry = {
        target: row,
        borderBoxSize: [{ inlineSize: 960, blockSize: height }],
        contentRect: createRect({ left: 0, top: 0, width: 960, height }),
      } as unknown as ResizeObserverEntry;
      await act(async () => {
        for (const observer of resizeObservers) {
          if (observer.elements.has(row)) {
            observer.callback([entry], observer as unknown as ResizeObserver);
          }
        }
        await new Promise<void>((resolve) =>
          dom.window.requestAnimationFrame(() => resolve()),
        );
      });
    },
    /** 入力のフォーカスを外してルートを破棄し、差し替えたDOMとグローバルを復元する。 */
    async cleanup() {
      for (const input of dom.window.document.querySelectorAll<HTMLInputElement>(
        "input, textarea, [contenteditable='true']",
      )) {
        input.blur();
      }
      if (dom.window.document.activeElement instanceof dom.window.HTMLElement) {
        dom.window.document.activeElement.blur();
      }
      await act(async () => {
        root.unmount();
      });
      dom.window.HTMLElement.prototype.getBoundingClientRect =
        originalGetBoundingClientRect;
      if (originalAttachEvent) {
        Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
          configurable: true,
          value: originalAttachEvent,
        });
      } else {
        delete (
          dom.window.HTMLElement.prototype as unknown as {
            attachEvent?: () => void;
          }
        ).attachEvent;
      }
      if (originalDetachEvent) {
        Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
          configurable: true,
          value: originalDetachEvent,
        });
      } else {
        delete (
          dom.window.HTMLElement.prototype as unknown as {
            detachEvent?: () => void;
          }
        ).detachEvent;
      }
      if (originalOffsetHeight) {
        Object.defineProperty(
          dom.window.HTMLElement.prototype,
          "offsetHeight",
          originalOffsetHeight,
        );
      } else {
        delete (
          dom.window.HTMLElement.prototype as unknown as {
            offsetHeight?: number;
          }
        ).offsetHeight;
      }
      if (originalClientHeight) {
        Object.defineProperty(
          dom.window.HTMLElement.prototype,
          "clientHeight",
          originalClientHeight,
        );
      } else {
        delete (
          dom.window.HTMLElement.prototype as unknown as {
            clientHeight?: number;
          }
        ).clientHeight;
      }
      if (originalScrollHeight) {
        Object.defineProperty(
          dom.window.HTMLElement.prototype,
          "scrollHeight",
          originalScrollHeight,
        );
      } else {
        delete (
          dom.window.HTMLElement.prototype as unknown as {
            scrollHeight?: number;
          }
        ).scrollHeight;
      }
      Object.defineProperty(dom.window, "ResizeObserver", {
        configurable: true,
        value: originalResizeObserver,
      });
      dom.window.HTMLElement.prototype.scrollTo = originalScrollTo;
      dom.window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      dom.window.close();
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      });
      Object.defineProperty(globalThis, "Node", {
        configurable: true,
        value: previousNode,
      });
      Object.defineProperty(globalThis, "HTMLElement", {
        configurable: true,
        value: previousHTMLElement,
      });
      Object.defineProperty(globalThis, "DOMRect", {
        configurable: true,
        value: previousDOMRect,
      });
      Object.defineProperty(globalThis, "Event", {
        configurable: true,
        value: previousEvent,
      });
      Object.defineProperty(globalThis, "MouseEvent", {
        configurable: true,
        value: previousMouseEvent,
      });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: previousNavigator,
      });
      if (previousRequestAnimationFrame)
        Object.defineProperty(
          globalThis,
          "requestAnimationFrame",
          previousRequestAnimationFrame,
        );
      else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    },
  };
}

/** 長い履歴でも描画ノード数を絞り、最古の行をマウントせず末尾付近を表示する。 */
test("SessionMessageColumn は全履歴を仮想化し、最新メッセージ周辺だけを描画する", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(100),
    isMessageListFollowing: false,
  });

  const messageRowCount = (html.match(/message-row/g) ?? []).length;
  assert.ok(messageRowCount > 0, "message-row が1件も描画されていない");
  assert.ok(messageRowCount < 100, "100件全て message-row が描画されている");
  assert.doesNotMatch(html, /message 1<\/p>/);
  assert.match(html, /message 100<\/p>/);
  assert.match(html, /session-message-virtual-row/);
  assert.doesNotMatch(html, /以前のメッセージを読み込む/);
});

/** 有効な用語は通常の本文から開けるが、Sourceでは元の文字列を注釈なしで表示する。 */
test("SessionMessageColumn はvalid glossaryを通常messageへだけ投影しSourceでは注釈しない", () => {
  const glossaryAnnotationMatcher = createGlossaryAnnotationMatcher(
    [
      {
        term: "Runtime",
        aliases: [],
        definition: "Runtime definition",
      },
    ],
    "revision-1",
  );
  const messages: Message[] = [
    {
      role: "assistant",
      text: "Runtime",
      artifact: {
        title: "Runtime artifact",
        activitySummary: [],
        operationTimeline: [
          { type: "command_execution", summary: "Runtime", details: "Runtime" },
        ],
        changedFiles: [],
        runChecks: [],
      },
    },
  ];
  const previewHtml = renderSessionMessageColumn({
    messages,
    expandedArtifacts: { "message-0": true },
    glossaryAnnotationMatcher,
    /** 通常表示の用語導線を描画するため、外部遷移を伴わない通知口を渡す。 */
    onActivateGlossaryEntry: () => undefined,
  });
  const sourceHtml = renderSessionMessageColumn({
    messages,
    glossaryAnnotationMatcher,
    /** 同じ用語通知口があってもSourceには導線が出ない条件を作る。 */
    onActivateGlossaryEntry: () => undefined,
    messageViewMode: "source",
  });

  assert.equal(
    (previewHtml.match(/class="glossary-annotation"/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(sourceHtml, /class="glossary-annotation"/);
});

// @test-value v2
// kind = "contract"
// claim = "個別collapse controlは状態と対象本文を支援技術へ公開しkeyboard focusとclickで操作でき、一括shortcutも維持される"
// oracle = { type = "contract", ref = "accepted behavior: accessible name、aria-expanded、aria-controlsと一括shortcutを維持する" }
// fault = "個別controlがkeyboardから到達不能になるかARIAの状態・対象を失う、または一括shortcutが動作しなくなる"
// observable = "個別collapse buttonのaria-label/aria-expanded/aria-controls、focus、click callback、一括shortcutのpreventDefault"
// observation_boundary = "component-behavior"
// scope = "SessionMessageColumn collapse controls"
// lifecycle = "permanent"
// impact = "message本文の開閉とkeyboard shortcutによる一括操作が利用できなくなる"
// distinction = "DOM owner境界ではなく、個別controlのaccessibility contractと一括shortcutの操作経路を検証する"
// @end-test-value
/** 個別と一括の縮小操作をネイティブボタンから実行し、それぞれの対象に反映することを確かめる。 */
test("SessionMessageColumn は個別・一括collapseをnative controlで操作する", async () => {
  const messages: Message[] = [
    { role: "user", text: "first **collapsed** message" },
    { role: "assistant", text: "second message" },
  ];
  const messageKeys = ["session-s-0", "session-s-1"];
  const messageCollapseTargets = buildMessageCollapseTargets(
    messages,
    messages.map((_, messageIndex): MessageListSource => ({
      kind: "session",
      messageIndex,
    })),
    messageKeys,
  );
  let toggledKey: string | null = null;
  let allToggleCount = 0;
  const collapsedMessageKeys = new Set(["session-s-0"]);
  const mounted = await mountSessionMessageColumn({
    messages,
    messageKeys,
    messageCollapseTargets,
    collapsedMessageKeys,
    /** 個別操作に渡った行キーを記録する。 */
    onToggleMessageCollapse: (key) => {
      toggledKey = key;
    },
    /** 一括操作の発火を個別操作とは別に数える。 */
    onToggleAllMessageCollapse: () => {
      allToggleCount += 1;
    },
  });

  try {
    const collapsedBody = mounted.container.querySelector(
      "#message-body-session-s-0",
    );
    assert.ok(collapsedBody);
    assert.equal(collapsedBody.querySelector(".rich-text"), null);
    assert.equal(
      collapsedBody.querySelector(".message-collapsed-preview")?.textContent,
      "first collapsed message",
    );
    const individualButton = mounted.container.querySelector<HTMLButtonElement>(
      "button[aria-label^='Expand message']",
    );
    assert.ok(individualButton);
    assert.equal(individualButton.getAttribute("aria-expanded"), "false");
    assert.equal(
      individualButton.getAttribute("aria-controls"),
      "message-body-session-s-0",
    );
    await act(async () => {
      individualButton.focus();
    });
    assert.equal(mounted.dom.window.document.activeElement, individualButton);
    await act(async () => {
      individualButton.click();
    });
    assert.equal(toggledKey, "session-s-0");

    const shortcutEvent = new mounted.dom.window.KeyboardEvent("keydown", {
      key: "M",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      mounted.dom.window.document.body.dispatchEvent(shortcutEvent);
    });
    assert.equal(allToggleCount, 1);
    assert.equal(shortcutEvent.defaultPrevented, true);
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "本文のない保存済み応答は折りたたんでも代替文を出さず、失敗・Details・開閉のフォーカスと実際の本文を保持する。展開後は表示中の失敗結果を既読にできる"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#rendering-policy; docs/design/desktop-ui.md の確定した送信・実行失敗とMonitorの自動既読" }
// fault = "空のpreviewを作る、失敗を消す、開閉時にfocusや参照先を失う、実本文を消す、または空の本文を開閉したときに誤って既読にする/できない"
// observable = "開閉ボタンのname/expanded/controlsとactiveElement、空の本文、Failed・Details、別messageの実preview、表示済み失敗に対する開閉前後の既読API呼出"
// observation_boundary = "component-behavior"
// scope = "SessionMessageColumn のMain・Aux共通折りたたみ表示"
// lifecycle = "permanent"
// distinction = "plain-text projectionや手製DOMのobserver単体では、実Columnでの開閉control・既読の接続を観測できない"
// @end-test-value
/** 空本文の失敗に代替本文を作らず、実際の生成本文がある場合も失敗欄から分けておく。 */
test("SessionMessageColumn は空の失敗本文を埋めず、実本文と別表示を保つ", async () => {
  const messages: Message[] = [
    { ...createArtifactMessage(), text: "", runFailure: "Fixture failure" },
    { role: "assistant", text: "No content" },
  ];
  const messageKeys = ["empty", "literal"];
  const messageCollapseTargets = buildMessageCollapseTargets(
    messages,
    [
      { kind: "session", messageIndex: 0 },
      {
        kind: "auxiliary",
        sessionId: "aux-fixture",
        messageIndex: 0,
        artifact: undefined,
      },
    ],
    messageKeys,
  );
  const collapsedMessageKeys = new Set(["literal"]);
  const mounted = await mountSessionMessageColumn({
    messages,
    messageKeys,
    messageCollapseTargets,
    collapsedMessageKeys,
    expandedArtifacts: { empty: true },
    /** 失敗応答で縮小操作をしたときの対象キーを記録する。 */
    onToggleMessageCollapse: (key) => {
      if (collapsedMessageKeys.has(key)) collapsedMessageKeys.delete(key);
      else collapsedMessageKeys.add(key);
    },
  });
  let stopObserve: (() => void) | undefined;
  try {
    const body = mounted.container.querySelector("#message-body-empty");
    const row = body?.closest("article");
    const button = row?.querySelector<HTMLButtonElement>(
      "button[aria-label='Collapse message']",
    );
    assert.ok(body && row && button);
    assert.equal(
      row.querySelector(".session-run-failure strong")?.textContent,
      "Failed",
    );
    assert.equal(
      row.querySelector(".session-run-failure p")?.textContent,
      "Fixture failure",
    );
    assert.ok(row.querySelector("#artifact-panel-empty"));
    await act(async () => {
      button.focus();
      button.click();
    });
    await mounted.rerender({
      collapsedMessageKeys: new Set(collapsedMessageKeys),
    });
    assert.equal(mounted.dom.window.document.activeElement, button);
    assert.equal(button.getAttribute("aria-label"), "Expand message");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    const collapsedBody = mounted.dom.window.document.getElementById(
      button.getAttribute("aria-controls") ?? "",
    );
    assert.equal(collapsedBody?.id, body.id);
    assert.equal(collapsedBody.textContent, "");
    assert.equal(
      collapsedBody.querySelector(".message-collapsed-preview"),
      null,
    );
    assert.ok(
      row
        .querySelector(".session-run-failure")
        ?.textContent?.includes("Fixture failure"),
    );
    assert.ok(row.querySelector("#artifact-panel-empty"));
    assert.equal(
      mounted.container.querySelector(
        "#message-body-literal .message-collapsed-preview",
      )?.textContent,
      "No content",
    );

    const { window } = mounted.dom;
    const shownFailure = row.querySelector<HTMLElement>(
      ".session-run-failure",
    )!;
    shownFailure.getBoundingClientRect = () =>
      createRect({ top: 20, left: 0, width: 400, height: 80 });
    Object.defineProperty(window.document, "hasFocus", {
      /** 失敗応答を閲覧中として扱い、既読の判定からフォーカス要因を外す。 */ value:
        () => true,
    });
    const acknowledgements: Array<[string, number]> = [];
    stopObserve = observeSessionResultRead({
      sessionId: "session-1",
      list: mounted.messageListRef.current!,
      assistantMessageIndexes: new Map([[0, 0]]),
      api: {
        /** 失敗応答に対応する未読結果の識別子を返す。 */
        getUnreadSessionResult: async () => ({
          turnId: 7,
          assistantMessageSeq: 0,
        }),
        /** 既読になったSessionとTurnを記録する。 */
        markSessionResultRead: async (id, turnId) => {
          acknowledgements.push([id, turnId]);
          return true;
        },
        /** 更新イベントを追加せず、購読と解除の形だけ満たす。 */
        onSessionTurnUpdated: () => () => {},
      },
    });
    /** 既読の非同期監視が次の描画フレームまで進むのを待つ。 */
    const flushFrame = () =>
      act(async () => {
        await Promise.resolve();
        await new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => resolve()),
        );
      });
    await flushFrame();
    assert.deepEqual(acknowledgements, []);
    await act(async () => button.click());
    await mounted.rerender({
      collapsedMessageKeys: new Set(collapsedMessageKeys),
    });
    await flushFrame();
    assert.deepEqual(acknowledgements, [["session-1", 7]]);
  } finally {
    stopObserve?.();
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "persisted message のbookmark controlは状態をaccessible nameとaria-pressedへ公開し、clickでsource targetを返す"
// oracle = { type = "contract", ref = "docs/features/message-bookmark-filter.md: 本文のbookmark control" }
// fault = "bookmark controlを表示しない、状態を支援技術へ公開しない、または対象messageを誤って返す"
// observable = "native buttonのaria-label/aria-pressedとonToggleMessageBookmarkへ渡るtarget"
// observation_boundary = "component-behavior"
// scope = "SessionMessageColumn bookmark control"
// lifecycle = "permanent"
// impact = "bookmarkを追加・解除できず、本文とMessages filterの状態が更新できない"
// distinction = "static markupだけでなくmount後のclickとtarget identityを確認し、typecheck/buildでは得られない操作契約を補う"
// @end-test-value
/** ブックマークがネイティブボタンで切り替わり、通知が対象メッセージを指すことを確かめる。 */
test("SessionMessageColumn はbookmark controlをnative buttonで操作する", async () => {
  const messages: Message[] = [
    { role: "assistant", text: "bookmark target", isBookmarked: true },
  ];
  const messageKeys = ["session-s-0"];
  const messageCollapseTargets = buildMessageCollapseTargets(
    messages,
    [{ kind: "session", messageIndex: 0 }],
    messageKeys,
  );
  let toggledKey: string | null = null;
  let toggledState: boolean | null = null;
  let toggledSource: MessageCollapseTarget["source"] | null = null;
  const mounted = await mountSessionMessageColumn({
    messages,
    messageKeys,
    messageCollapseTargets,
    /** 操作対象を記録し、次の描画でブックマーク状態を反映する。 */
    onToggleMessageBookmark: (target) => {
      toggledKey = target.key;
      toggledState = target.isBookmarked;
      toggledSource = target.source;
    },
  });

  try {
    const button = mounted.container.querySelector<HTMLButtonElement>(
      "button.message-bookmark-toggle",
    );
    assert.ok(button);
    assert.equal(button.getAttribute("aria-label"), "Remove bookmark");
    assert.equal(button.getAttribute("aria-pressed"), "true");
    await act(async () => {
      button.click();
    });
    assert.equal(toggledKey, "session-s-0");
    assert.equal(toggledState, true);
    assert.deepEqual(toggledSource, { kind: "session", messageIndex: 0 });

    const unbookmarkedMessages: Message[] = [
      { role: "assistant", text: "bookmark target" },
    ];
    await mounted.rerender({
      messages: unbookmarkedMessages,
      messageCollapseTargets: buildMessageCollapseTargets(
        unbookmarkedMessages,
        [{ kind: "session", messageIndex: 0 }],
        messageKeys,
      ),
    });
    const addButton = mounted.container.querySelector<HTMLButtonElement>(
      "button.message-bookmark-toggle",
    );
    assert.ok(addButton);
    assert.equal(addButton.getAttribute("aria-label"), "Add bookmark");
    assert.equal(addButton.getAttribute("aria-pressed"), "false");
    toggledKey = null;
    toggledSource = null;
    await act(async () => {
      addButton.click();
    });
    assert.equal(toggledKey, "session-s-0");
    assert.equal(toggledState, false);
    assert.deepEqual(toggledSource, { kind: "session", messageIndex: 0 });
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v1
// kind = "regression"
// claim = "個別collapse controlとmessage本文は同じtext wrapperに属し、Detailsはそのwrapperの外側に残る"
// oracle = { type = "contract", ref = "accepted behavior: 個別の縮小・展開controlはMessage本文領域だけをownerにする" }
// failure_mode = "collapse controlのoverlay ownerがmessage card全体になり、展開したDetails上へcontrolが追従する"
// scope = "SessionMessageColumn message text owner boundary"
// lifecycle = "permanent"
// distinction = "個別・一括操作の状態遷移ではなく、本文とDetailsのDOM owner境界を検証する"
// @end-test-value
/** 縮小ボタンは本文の操作として置き、別のDetailsを縮小の持ち主にしない。 */
test("SessionMessageColumn は個別collapse controlを本文wrapper内に保ちDetailsをownerに含めない", async () => {
  const messages = [createArtifactMessage()];
  messages[0]!.text = "long message ".repeat(80);
  const messageKeys = ["session-s-0"];
  const messageCollapseTargets = buildMessageCollapseTargets(
    messages,
    [{ kind: "session", messageIndex: 0 }],
    messageKeys,
  );
  const mounted = await mountSessionMessageColumn({
    messages,
    messageKeys,
    messageCollapseTargets,
    expandedArtifacts: { "session-1-0": true },
    /** 親の更新を起こさず、縮小ボタンのDOM上の所属だけを調べる。 */
    onToggleMessageCollapse: () => undefined,
  });

  try {
    const card = mounted.container.querySelector(".message-card");
    const textWrapper = card?.querySelector(".message-text-wrapper");
    const collapseControl = card?.querySelector(".message-collapse-control");
    const messageBody = card?.querySelector("[data-message-body='true']");
    const artifactShell = card?.querySelector(".artifact-shell");

    assert.ok(textWrapper);
    assert.equal(collapseControl?.parentElement, textWrapper);
    assert.equal(messageBody?.parentElement, textWrapper);
    assert.equal(textWrapper.querySelector(".artifact-shell"), null);
    assert.equal(artifactShell?.parentElement, textWrapper.parentElement);
  } finally {
    await mounted.cleanup();
  }
});

/** 検索中は縮小済みの一致本文を一時表示し、検索を終えれば元の縮小に戻す。 */
test("SessionMessageColumn はfind中だけ縮小messageを一時展開する", async () => {
  const messages: Message[] = [
    { role: "assistant", text: "**needle** remains searchable" },
  ];
  const messageKeys = ["session-s-0"];
  const messageCollapseTargets = buildMessageCollapseTargets(
    messages,
    [{ kind: "session", messageIndex: 0 }],
    messageKeys,
  );
  const mounted = await mountSessionMessageColumn({
    messages,
    messageKeys,
    messageCollapseTargets,
    collapsedMessageKeys: new Set(messageKeys),
  });

  try {
    assert.ok(mounted.container.querySelector(".message-collapsed-preview"));
    await act(async () => {
      mounted.dom.window.dispatchEvent(
        new mounted.dom.window.KeyboardEvent("keydown", {
          key: "f",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    const input = mounted.container.querySelector<HTMLInputElement>(
      "input[aria-label='Find in current content']",
    );
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      mounted.dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    await act(async () => {
      setInputValue.call(input, "needle");
      const propertyChange = new mounted.dom.window.Event("propertychange", {
        bubbles: true,
      });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
    });
    assert.equal(
      mounted.container.querySelector(".message-collapsed-preview"),
      null,
    );
    assert.ok(
      mounted.container.querySelector("#message-body-session-s-0 > .rich-text"),
    );
  } finally {
    await mounted.cleanup();
  }
});

/** 仮想化で初期描画から外れた最古の行も、上方向へのスクロールで到達できる。 */
test("SessionMessageColumn は上方向へスクロールして先頭メッセージへ到達できる", async () => {
  const mounted = await mountSessionMessageColumn({
    messages: createMessages(100),
  });

  try {
    const messageList = mounted.messageListRef.current;
    assert.ok(messageList);
    assert.doesNotMatch(
      mounted.container.textContent ?? "",
      /message 1(?:\D|$)/,
    );

    await act(async () => {
      messageList.scrollTop = 0;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });

    assert.match(mounted.container.textContent ?? "", /message 1(?:\D|$)/);
  } finally {
    await mounted.cleanup();
  }
});

/** Inspectorの精密カバレッジで検索用の本文投影の呼出し回数を計測する。 */
async function startSearchProjectionCounter() {
  const inspector = new InspectorSession();
  inspector.connect();
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.startPreciseCoverage", {
    callCount: true,
    detailed: false,
  });
  return {
    /** 前の読取り以降に実行された検索本文投影だけを集計する。 */
    async take() {
      const { result } = await inspector.post("Profiler.takePreciseCoverage");
      return result
        .filter((script) => script.url.includes("/message-search."))
        .flatMap((script) => script.functions)
        .filter((fn) => fn.functionName === "projectMessageRenderedSearchText")
        .reduce((count, fn) => count + fn.ranges[0].count, 0);
    },
    /** 精密カバレッジを停止し、テスト専用のInspector接続を閉じる。 */
    async stop() {
      await inspector.post("Profiler.stopPreciseCoverage");
      inspector.disconnect();
    },
  };
}

/** Findをキーボードで開き、入力値変更と仮想一覧の通知を実DOMイベントで発火する。 */
async function setMessageFindQuery(
  mounted: MountedSessionMessageColumn,
  query: string,
) {
  await act(async () => {
    mounted.dom.window.dispatchEvent(
      new mounted.dom.window.KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        bubbles: true,
      }),
    );
  });
  const input = mounted.container.querySelector<HTMLInputElement>(
    "input[aria-label='Find in current content']",
  );
  assert.ok(input);
  const setValue = Object.getOwnPropertyDescriptor(
    mounted.dom.window.HTMLInputElement.prototype,
    "value",
  )?.set;
  assert.ok(setValue);
  await act(async () => {
    setValue.call(input, query);
    const event = new mounted.dom.window.Event("propertychange", {
      bubbles: true,
    });
    Object.defineProperty(event, "propertyName", { value: "value" });
    input.dispatchEvent(event);
  });
  await act(async () => {
    mounted.container
      .querySelector(".session-message-list")
      ?.dispatchEvent(new mounted.dom.window.Event("scroll"));
  });
}

/** JSDOMにHighlight APIの記録役を設置し、検索が登録したDOM範囲を取得できるようにする。 */
function installMessageFindHighlights(mounted: MountedSessionMessageColumn) {
  /** Highlight名ごとに追加された範囲を保持するブラウザーAPIの代役。 */
  class TestHighlight {
    readonly ranges: Range[] = [];
    /** 渡された範囲を保存し、実APIと同じく自身を返す。 */
    add(range: Range) {
      this.ranges.push(range);
      return this;
    }
  }
  const highlights = new Map<string, TestHighlight>();
  Object.defineProperty(mounted.dom.window, "CSS", {
    configurable: true,
    value: { highlights },
  });
  Object.defineProperty(mounted.dom.window, "Highlight", {
    configurable: true,
    value: TestHighlight,
  });
  return highlights;
}

// @test-value v2
// kind = "contract"
// claim = "PreviewとSourceで検索順が違っても同一anchor内の各原文出現とentity・escapeの変換前後を対応付け選択を往復維持する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/913" }
// fault = "表示mode切替で数値ordinalを持ち越す、同じ強調要素内の別出現へ移る、またはentity・escapeのtoken長差で別のraw出現を選ぶ"
// observable = "Find現在位置、強調anchor、SourceのCSS Highlightの原文offsetと文字列"
// observation_boundary = "component-behavior"
// scope = "local Findの表示mode切替"
// lifecycle = "permanent"
// impact = "利用者が選んだURL内や変換された表示文字の出現をSourceで確認できない"
// distinction = "shared範囲helperはReact選択とmode変更を通らない。各3出現だけで順序逆転・同一要素・token長差を検証する"
// @end-test-value
/** PreviewとSourceで見かけの順序が変わっても、同じ元Markdownの出現を選択し続ける。 */
test("chat Find preserves each raw occurrence across Preview and Source order changes", async () => {
  const text = "[表示](C:/needle/needle.md) needle";
  const mounted = await mountSessionMessageColumn({
    messages: [{ role: "assistant", text }],
  });
  const highlights = installMessageFindHighlights(mounted);
  /** Findの件数欄から表示中の位置と総数だけを読む。 */
  const count = () =>
    mounted.container.querySelector(".session-content-find-count")?.firstChild
      ?.textContent;
  /** ネイティブの次候補ボタンを操作して現在位置を進める。 */
  const next = async () =>
    act(async () =>
      mounted.container
        .querySelector<HTMLButtonElement>("button[aria-label='Next match']")!
        .click(),
    );
  try {
    await setMessageFindQuery(mounted, "needle");
    assert.equal(count(), "1/3");
    assert.equal(
      highlights.get("withmate-find-current")?.ranges[0]?.toString(),
      "needle",
    );
    await next();
    const anchor = mounted.container.querySelector(
      ".message-find-source-target",
    );
    assert.equal(anchor?.tagName, "A");
    for (const [previewOrdinal, sourceOrdinal, offset] of [
      [2, 1, text.indexOf("needle")],
      [3, 2, text.indexOf("needle", text.indexOf("needle") + 1)],
    ]) {
      assert.equal(count(), `${previewOrdinal}/3`);
      assert.equal(
        mounted.container.querySelector(".message-find-source-target")
          ?.textContent,
        "表示",
      );
      await mounted.rerender({ messageViewMode: "source" });
      assert.equal(count(), `${sourceOrdinal}/3`);
      const range = highlights.get("withmate-find-current")?.ranges[0];
      assert.equal(range?.toString(), "needle");
      assert.equal(range?.startOffset, offset);
      await mounted.rerender({ messageViewMode: "preview" });
      assert.equal(count(), `${previewOrdinal}/3`);
      assert.equal(
        mounted.container.querySelector(".message-find-source-target")?.tagName,
        "A",
      );
      if (previewOrdinal === 2) {
        const beforeNext = mounted.container.querySelector(
          ".message-find-source-target",
        );
        await next();
        assert.equal(
          mounted.container.querySelector(".message-find-source-target"),
          beforeNext,
        );
      }
    }
  } finally {
    await mounted.cleanup();
  }
  for (const [text, query, sourceOffset] of [
    ["[label](a&) &amp; &", "&", 12],
    ["[label](a*) \\* *", "*", 13],
  ] as const) {
    const mounted = await mountSessionMessageColumn({
      messages: [{ role: "assistant", text }],
    });
    const highlights = installMessageFindHighlights(mounted);
    /** 別の一致順のケースでも位置表示を同じDOM境界で読む。 */
    const count = () =>
      mounted.container.querySelector(".session-content-find-count")?.firstChild
        ?.textContent;
    try {
      await setMessageFindQuery(mounted, query);
      assert.equal(count(), "1/3");
      assert.equal(
        highlights.get("withmate-find-current")?.ranges[0]?.toString(),
        query,
      );
      await mounted.rerender({ messageViewMode: "source" });
      assert.equal(count(), "2/3", text);
      const sourceRange = highlights.get("withmate-find-current")?.ranges[0];
      assert.equal(sourceRange?.startOffset, sourceOffset, text);
      assert.equal(sourceRange?.toString(), query);
      await mounted.rerender({ messageViewMode: "preview" });
      assert.equal(count(), "1/3", text);
      assert.equal(
        highlights.get("withmate-find-current")?.ranges[0]?.toString(),
        query,
      );
    } finally {
      await mounted.cleanup();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "原文検索は引用内の参照定義も各出現を一度数え最初の表示参照へ移動し、画像と水平線は対応要素、未参照定義と非表示画像は所属messageを強調する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/913" }
// fault = "参照先の数だけ件数を増やす、未参照原文や非text表示先を捨てる、または空の引用・装飾要素や無関係の表示文字を強調する"
// observable = "Find件数、強調要素のlabel・画像shell class・水平線tag・message body属性と所属行"
// observation_boundary = "component-behavior"
// scope = "local Findのreference、画像、水平線、表示先なしの強調"
// lifecycle = "permanent"
// impact = "画像pathや未参照定義の一致を見失うか誤った場所を一致と理解する"
// distinction = "parser metadata単体ではcolumnの結果選択とfallbackを確認できない。小さい3messageで一対多と非text表示先・非表示祖先の境界を通す"
// @end-test-value
/** Sourceにしかない一致は、最初の参照・画像外枠・メッセージ本体の順に適切な移動先を選ぶ。 */
test("chat Find targets first reference, image shell and message fallback", async () => {
  const previousIntersectionObserver = globalThis.IntersectionObserver;
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class {
      /** IntersectionObserverの登録では可視性イベントを自動配送しない。 */
      observe() {}
      /** 可視性を通知しないobserverなので個別解除でも状態を作らない。 */
      unobserve() {}
      /** 外部監視を持たないobserverの終了口。 */
      disconnect() {}
    },
  });
  const mounted = await mountSessionMessageColumn({
    messages: [
      {
        role: "assistant",
        text: "[first][r] [second][r]\n\n> [r]: C:/needle/needle.md\n\n[unused]: C:/orphan.md",
      },
      { role: "assistant", text: "**![picture](C:/image-path.png)**" },
      { role: "assistant", text: "**![x](javascript:omitted)**\n\n***" },
    ],
  });
  /** 元文一致の移動先として付与された要素を得る。 */
  const target = () =>
    mounted.container.querySelector(".message-find-source-target");
  /** 元文一致を含む位置と総数をFind欄から読む。 */
  const count = () =>
    mounted.container.querySelector(".session-content-find-count")?.firstChild
      ?.textContent;
  try {
    await setMessageFindQuery(mounted, "needle");
    assert.equal(count(), "1/2");
    assert.equal(target()?.tagName, "A");
    assert.equal(target()?.textContent, "first");
    await act(async () =>
      mounted.container
        .querySelector<HTMLButtonElement>("button[aria-label='Next match']")!
        .click(),
    );
    assert.equal(count(), "2/2");
    assert.equal(target()?.textContent, "first");
    await setMessageFindQuery(mounted, "image-path");
    assert.equal(count(), "1/1");
    assert.ok(target()?.classList.contains("message-image-shell"));
    assert.equal(
      target()
        ?.closest(".session-message-virtual-row")
        ?.getAttribute("data-index"),
      "1",
    );
    await setMessageFindQuery(mounted, "orphan");
    assert.equal(count(), "1/1");
    assert.equal(target()?.getAttribute("data-message-body"), "true");
    assert.equal(
      target()
        ?.closest(".session-message-virtual-row")
        ?.getAttribute("data-index"),
      "0",
    );
    await setMessageFindQuery(mounted, "omitted");
    assert.equal(count(), "1/1");
    assert.equal(target()?.getAttribute("data-message-body"), "true");
    assert.equal(
      target()
        ?.closest(".session-message-virtual-row")
        ?.getAttribute("data-index"),
      "2",
    );
    await setMessageFindQuery(mounted, "***");
    assert.equal(count(), "1/1");
    assert.equal(target()?.tagName, "HR");
  } finally {
    await mounted.cleanup();
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      value: previousIntersectionObserver,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "数式エラーと通常本文に同じ語がある場合、Previewの表示一致は本文を強調し原文一致は数式全体を示してSourceでも同じ出現を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md; docs/design/message-rich-text.md#search-targets" }
// fault = "数式エラー文字をDOM表示検索へ混ぜ、本文の選択を数式内へずらすか原文一致を見失う"
// observable = "Find件数・説明、CSS Highlightの文字と親段落、数式target、Sourceの原文offset"
// observation_boundary = "component-behavior"
// scope = "local Findの不正math fenceと本文の選択"
// lifecycle = "permanent"
// impact = "未完成の数式を含む応答でも利用者が選んだ本文と数式を取り違えず確認できる"
// distinction = "projection照合だけでは現在選択のDOM ordinalと要素強調・Source切替の接続を確認できない。短い1messageで2出現を辿る"
// @end-test-value
/** 数式のエラー表示を通常の可視本文の一致範囲と混同しない。 */
test("chat Find separates math errors from visible text highlights", async () => {
  const text = "before\n\n```math\n\\frac{needle\n```\n\nafter needle";
  const mounted = await mountSessionMessageColumn({
    messages: [{ role: "assistant", text }],
  });
  const highlights = installMessageFindHighlights(mounted);
  /** 数式エラーを含む場合の位置表示から補足文言を除いて読む。 */
  const count = () =>
    mounted.container.querySelector(".session-content-find-count")?.firstChild
      ?.textContent;
  try {
    await setMessageFindQuery(mounted, "needle");
    assert.equal(count(), "1/2");
    const range = highlights.get("withmate-find-current")?.ranges[0];
    assert.equal(range?.toString(), "needle");
    assert.equal(
      range?.startContainer.parentElement?.closest("p")?.textContent,
      "after needle",
    );
    await act(async () =>
      mounted.container
        .querySelector<HTMLButtonElement>("button[aria-label='Next match']")!
        .click(),
    );
    assert.equal(count(), "2/2");
    assert.equal(
      mounted.container.querySelector(".session-content-find-description")
        ?.textContent,
      "Source Match",
    );
    assert.ok(
      mounted.container.querySelector(
        ".message-find-source-target .katex-error",
      ),
    );
    await mounted.rerender({ messageViewMode: "source" });
    assert.equal(count(), "1/2");
    assert.equal(
      highlights.get("withmate-find-current")?.ranges[0]?.startOffset,
      text.indexOf("needle"),
    );
    await mounted.rerender({ messageViewMode: "preview" });
    assert.equal(count(), "2/2");
    assert.ok(
      mounted.container.querySelector(
        ".message-find-source-target .katex-error",
      ),
    );
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "paged Findは保存領域の総hitに未保存末尾とpendingだけを加算し、globalordinalを移動して保存hitの本文pageへ進み、Closeでqueryをcancelする"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 全履歴Findの総件数・live末尾・取消" }
// fault = "loaded保存hitを重複加算する、64件pageを全件と表示する、遠いordinalで誤った本文を読み込む、またはCloseでcancelしない"
// observable = "Find barの件数、onLoadMessagePageのhistory index、queryのoffset/stamp、cancel requestId"
// observation_boundary = "component-behavior"
// scope = "paged-conversation-find"
// lifecycle = "permanent"
// impact = "大きな保存履歴と未保存送信・待機本文を一つのFindで正確に探索できる"
// distinction = "query hook testは実際のFind bar、loaded本文と保存件数の重複排除、pendingの順序を通らない"
// @end-test-value
/** ページ検索の保存済み総数を使い、現在ページの重複を除いて未保存末尾とpendingだけを加える。 */
test("paged Find counts global saved hits and only unsaved tail and pending", async () => {
  const requests: Array<
    Parameters<NonNullable<SessionMessageColumnProps["searchConversation"]>>[0]
  > = [];
  const loaded: number[] = [];
  const cancelled: string[] = [];
  const messages: Message[] = [
    { role: "user", text: "saved needle", historyIndex: 999 },
    { role: "user", text: "unsaved needle", historyIndex: 1000 },
  ];
  /** 保存済み検索のスタブと手元にある未保存末尾を同じ列に供給する。 */
  function PagedFind(props: SessionMessageColumnProps) {
    return React.createElement(SessionMessageColumn, {
      ...props,
      searchTailMessages: messages,
      /** リクエストを記録し、全130件の保存済み一致を要求されたオフセットから返す。 */
      searchConversation: async (request) => {
        requests.push(request);
        const offset = request.offset ?? 0;
        return {
          status: "complete",
          stamp: {
            generationId: "generation",
            ownerIdentity: "owner",
            contentRevision: 1,
            requestId: request.requestId,
          },
          incarnationId: "incarnation",
          messageCount: 1000,
          totalCount: 130,
          offset,
          items: Array.from(
            { length: Math.min(64, 130 - offset) },
            (_, index) => ({
              messageIndex: offset + index + 10,
              occurrenceIndex: 0,
            }),
          ),
        };
      },
      /** 一致へ移動するために要求された履歴ページの位置を記録する。 */
      onLoadMessagePage: async (index) => {
        loaded.push(index);
      },
      /** 古い検索を取り消すときの要求IDを残す。 */
      cancelConversationQuery: async (request) => {
        cancelled.push(request.requestId);
      },
    });
  }
  const mounted = await mountSessionMessageColumn({
    messages,
    component: PagedFind,
    isRunning: true,
    pendingMessageText: "pending needle",
  });
  try {
    await setMessageFindQuery(mounted, "needle");
    /** 保存済み結果と未保存結果を合成した位置・総数を読む。 */
    const count = () =>
      mounted.container.querySelector(".session-content-find-count")
        ?.textContent;
    assert.equal(count(), "1/132");
    assert.equal(loaded.at(-1), 10);
    const previous = mounted.container.querySelector<HTMLButtonElement>(
      "button[aria-label='Previous match']",
    );
    assert.ok(previous);
    await act(async () => previous.click());
    assert.equal(count(), "132/132");
    await act(async () => previous.click());
    assert.equal(count(), "131/132");
    assert.equal(loaded.at(-1), 1000);
    await act(async () => previous.click());
    assert.equal(count(), "130/132");
    assert.equal(loaded.at(-1), 139);
    assert.ok(
      requests.some(
        (request) =>
          request.offset === 128 &&
          request.stamp?.requestId === requests[0].requestId,
      ),
    );
    await act(async () => {
      mounted.container
        .querySelector<HTMLInputElement>(
          "input[aria-label='Find in current content']",
        )
        ?.blur();
      mounted.container
        .querySelector<HTMLButtonElement>("button[aria-label='Close find']")
        ?.click();
    });
    assert.deepEqual(cancelled, [requests[0].requestId]);
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Preview検索は原文リンク先の一致をanchor強調とFind説明で示し、表示一致を二重計上せず通常link操作と文字Highlightを保つ"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/887" }
// fault = "原文一致を数えない、別messageのanchorを強調する、表示本文を二重に数える、または検索が通常link操作を妨げる"
// observable = "Findの件数と短い説明、強調anchorの所属message、CSS Highlight、linkのopen callback"
// observation_boundary = "component-behavior"
// scope = "SessionMessageColumnのlocal Findと原文一致表示"
// lifecycle = "permanent"
// impact = "リンク先だけにあるファイル名を検索し、見つかった根拠と通常本文を同時に確認できる"
// distinction = "shared matcherではReactの結果選択・要素強調・link操作・Closeの接続を確認できない。短い2messageで操作境界を検証する"
// @end-test-value
/** リンク先URLだけの一致はSource Matchとして案内し、Markdown表示を置き換えたり可視一致を重複計上したりしない。 */
test("chat Find shows raw-only link matches without replacing Markdown or duplicating visible hits", async () => {
  /** 可視本文のハイライト登録を元文のみの一致と区別して観測する代替実装。 */
  class TestHighlight {
    readonly ranges: Range[] = [];
    /** 可視本文の範囲が登録されたことを記録する。 */
    add(range: Range) {
      this.ranges.push(range);
      return this;
    }
  }
  const text = "ordinary needle [filename](C:/users/admin/documents/sample.md)";
  const opened: string[] = [];
  /** 実会話列のリンク操作を、開いたパスを検査できる通知先に接続する。 */
  function Column(props: SessionMessageColumnProps) {
    return React.createElement(SessionMessageColumn, {
      ...props,
      /** リンク操作で選ばれたパスを外部起動せず記録する。 */
      onOpenPath: async (path) => {
        opened.push(path);
      },
    });
  }
  const mounted = await mountSessionMessageColumn({
    messages: [
      { role: "assistant", text },
      { role: "user", text: "Another [label](C:/second/sample.md)" },
    ],
    component: Column,
  });
  const highlights = new Map<string, TestHighlight>();
  Object.defineProperty(mounted.dom.window, "CSS", {
    configurable: true,
    value: { highlights },
  });
  Object.defineProperty(mounted.dom.window, "Highlight", {
    configurable: true,
    value: TestHighlight,
  });
  /** 補足メッセージを除いた現在位置と総数を取得する。 */
  const count = () =>
    mounted.container.querySelector(".session-content-find-count")?.firstChild
      ?.textContent;
  /** リンク全体が元文一致の移動先になったかを調べる。 */
  const target = () =>
    mounted.container.querySelector(".message-find-source-target");
  /** 可視本文以外の一致に添えられる説明を読む。 */
  const description = () =>
    mounted.container.querySelector(".session-content-find-count span")
      ?.textContent;
  try {
    await setMessageFindQuery(mounted, "sample.md");
    assert.equal(count(), "1/2");
    assert.equal(description(), "Source Match");
    assert.equal(target()?.tagName, "A");
    assert.equal(
      target()
        ?.closest(".session-message-virtual-row")
        ?.getAttribute("data-index"),
      "0",
    );
    assert.equal(
      target()?.getAttribute("href"),
      "C:/users/admin/documents/sample.md",
    );
    assert.equal(
      mounted.container.querySelector(".rich-text a")?.textContent,
      "filename",
    );
    assert.equal(
      highlights.get("withmate-find-current")?.ranges.length ?? 0,
      0,
    );
    await act(async () => (target() as HTMLAnchorElement).click());
    assert.equal(opened.length, 1);
    assert.match(opened[0], /sample.md/);
    await act(async () =>
      mounted.container
        .querySelector<HTMLButtonElement>("button[aria-label='Next match']")!
        .click(),
    );
    assert.equal(count(), "2/2");
    assert.equal(
      target()
        ?.closest(".session-message-virtual-row")
        ?.getAttribute("data-index"),
      "1",
    );
    await act(async () =>
      mounted.container
        .querySelector<HTMLButtonElement>(
          "button[aria-label='Previous match']",
        )!
        .click(),
    );
    assert.equal(count(), "1/2");
    await setMessageFindQuery(mounted, "filename");
    assert.equal(count(), "1/1");
    assert.equal(target(), null);
    assert.equal(
      highlights.get("withmate-find-current")?.ranges[0]?.toString(),
      "filename",
    );
    await setMessageFindQuery(mounted, "needle");
    assert.equal(count(), "1/1");
    assert.equal(
      highlights.get("withmate-find-current")?.ranges[0]?.toString(),
      "needle",
    );
    await setMessageFindQuery(mounted, "sample.md");
    await mounted.rerender({ messageViewMode: "source" });
    assert.equal(count(), "1/2");
    assert.equal(target(), null);
    assert.equal(
      highlights.get("withmate-find-current")?.ranges[0]?.toString(),
      "sample.md",
    );
    await mounted.rerender({ messageViewMode: "preview" });
    assert.equal(target()?.tagName, "A");
    await act(async () => {
      mounted.container
        .querySelector<HTMLInputElement>(
          "input[aria-label='Find in current content']",
        )!
        .blur();
      mounted.container
        .querySelector<HTMLButtonElement>("button[aria-label='Close find']")!
        .click();
    });
    assert.equal(target(), null);
    assert.equal(
      mounted.container.querySelector(".rich-text a")?.textContent,
      "filename",
    );
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "原文一致への移動後はDOM更新で読取位置を強制せず、別の一致を選択すれば再び移動できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 全履歴Findと結果への移動" }
// fault = "一致選択後の本文更新や仮想行変更のたびに同じ原文一致へスクロールする"
// observable = "原文一致選択時とDOM更新後のscrollTop、強調要素と現在位置"
// observation_boundary = "component-behavior"
// scope = "SessionMessageColumnの原文一致とDOM更新"
// lifecycle = "permanent"
// impact = "検索結果を選択したまま会話を読む位置がstreaming中に戻される"
// distinction = "共有matcherのtestではDOM更新と選択移動の接続を確認できない"
// @end-test-value
/** Source Matchへ移動した後でDOMが変わっても、読み進めた位置を奪わない。 */
test("chat Find preserves the reading position on DOM updates after navigating to a source match", async () => {
  const mounted = await mountSessionMessageColumn({
    messages: [
      { role: "assistant", text: "[first](C:/one/sample.md)" },
      { role: "assistant", text: "[second](C:/two/sample.md)" },
    ],
    isRunning: true,
    liveRunAssistantText: "streaming response",
  });
  const originalRect =
    mounted.dom.window.HTMLElement.prototype.getBoundingClientRect;
  mounted.dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.matches("a.message-find-source-target")
      ? createRect({ left: 0, top: 1500, width: 200, height: 40 })
      : originalRect.call(this);
  };
  /** DOM更新を挟んで同じFind上の位置を保っているか読む。 */
  const count = () =>
    mounted.container.querySelector(".session-content-find-count")?.firstChild
      ?.textContent;
  const list = mounted.messageListRef.current!;
  try {
    await setMessageFindQuery(mounted, "sample.md");
    await act(
      async () =>
        new Promise<void>((resolve) =>
          mounted.dom.window.requestAnimationFrame(() => resolve()),
        ),
    );
    assert.equal(count(), "1/2");
    assert.ok(list.scrollTop > 0);
    list.scrollTop = 100;
    await act(async () => {
      const node = mounted.dom.window.document.createElement("span");
      node.textContent = "unrelated update";
      mounted.messageListRef.current!.appendChild(node);
    });
    await act(
      async () =>
        new Promise<void>((resolve) =>
          mounted.dom.window.requestAnimationFrame(() => resolve()),
        ),
    );
    assert.equal(list.scrollTop, 100);
    await mounted.rerender({
      isRunning: true,
      liveRunAssistantText: "streaming response updated",
    });
    await act(
      async () =>
        new Promise<void>((resolve) =>
          mounted.dom.window.requestAnimationFrame(() => resolve()),
        ),
    );
    assert.equal(list.scrollTop, 100);
    await act(async () =>
      mounted.container
        .querySelector<HTMLButtonElement>("button[aria-label='Next match']")!
        .click(),
    );
    await act(
      async () =>
        new Promise<void>((resolve) =>
          mounted.dom.window.requestAnimationFrame(() => resolve()),
        ),
    );
    assert.equal(count(), "2/2");
    assert.ok(list.scrollTop > 100);
    assert.equal(
      mounted.container.querySelector(".message-find-source-target")
        ?.textContent,
      "second",
    );
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Main/Auxiliaryのpaged Findは保存原文一致・未保存tail・pendingを各1回数え、要素強調と履歴page移動を対応させ、tailとpendingのmode切替選択を維持する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/887; docs/design/desktop-ui.md: 全履歴Find" }
// fault = "保存結果ordinalを表示一致ordinalと誤解する、loaded保存本文を加算する、または循環移動やmode切替でtail/pending原文一致の選択を失う"
// observable = "Find件数と循環移動順、強調anchorのlabelとpending所属、onLoadMessagePageのhistory index"
// observation_boundary = "component-behavior"
// scope = "SessionMessageColumnのpaged保存検索とtail/pending合流"
// lifecycle = "permanent"
// impact = "Main/Auxiliaryどちらでも保存前後のリンク先を一続きの検索結果として辿れる"
// distinction = "worker testはrendererの未保存合流とpending表示を通らない。明示した保存API結果で2ownerの接続を検証する"
// @end-test-value
/** MainとAuxiliaryの両方で、保存済み・未保存末尾・pendingの元文一致を結合して辿れる。 */
test("paged raw Find merges saved, tail and pending matches for Main and Auxiliary", async () => {
  for (const sessionId of ["main", "auxiliary"]) {
    const loaded: number[] = [];
    const messages: Message[] = [
      {
        role: "assistant",
        text: "[saved](C:/saved/sample.md)",
        historyIndex: 49,
      },
      { role: "user", text: "[tail](C:/tail/sample.md)", historyIndex: 50 },
    ];
    /** 検索ownerと未保存分を列へ明示し、保存済み検索のスタブを接続する。 */
    function Column(props: SessionMessageColumnProps) {
      return React.createElement(SessionMessageColumn, {
        ...props,
        searchTailMessages: messages,
        conversationQueryOwner: sessionId,
        /** 同じownerの保存済み履歴にある49番目の一致を一件だけ返す。 */
        searchConversation: async (request) => ({
          status: "complete",
          stamp: {
            generationId: "generation",
            ownerIdentity: sessionId,
            contentRevision: 1,
            requestId: request.requestId,
          },
          incarnationId: "incarnation",
          messageCount: 50,
          totalCount: 1,
          offset: 0,
          items: [{ messageIndex: 49, occurrenceIndex: 0 }],
        }),
        /** 保存済み一致に到達するとき要求された履歴位置を記録する。 */
        onLoadMessagePage: async (index) => {
          loaded.push(index);
        },
      });
    }
    const mounted = await mountSessionMessageColumn({
      sessionId,
      messages,
      component: Column,
      isRunning: true,
      pendingMessageText: "[pending](C:/pending/sample.md)",
    });
    /** 三種類の履歴を結合したFindの位置と総数を読む。 */
    const count = () =>
      mounted.container.querySelector(".session-content-find-count")?.firstChild
        ?.textContent;
    /** ソース上の一致として選ばれた描画要素を取得する。 */
    const target = () =>
      mounted.container.querySelector(".message-find-source-target");
    try {
      await setMessageFindQuery(mounted, "sample.md");
      assert.equal(count(), "1/3", sessionId);
      assert.equal(target()?.textContent, "saved");
      assert.equal(loaded.at(-1), 49);
      const next = mounted.container.querySelector<HTMLButtonElement>(
        "button[aria-label='Next match']",
      )!;
      await act(async () => next.click());
      assert.equal(count(), "2/3");
      assert.equal(target()?.textContent, "tail");
      assert.equal(loaded.at(-1), 50);
      await mounted.rerender({ messageViewMode: "source" });
      assert.equal(count(), "2/3");
      await mounted.rerender({ messageViewMode: "preview" });
      assert.equal(count(), "2/3");
      await act(async () => next.click());
      assert.equal(count(), "3/3");
      assert.equal(target()?.textContent, "pending");
      assert.ok(target()?.closest("[data-pending-message-body='true']"));
      await mounted.rerender({ messageViewMode: "source" });
      assert.equal(count(), "3/3");
      await mounted.rerender({ messageViewMode: "preview" });
      assert.equal(count(), "3/3");
      await act(async () => next.click());
      assert.equal(count(), "1/3");
      assert.equal(target()?.textContent, "saved");
    } finally {
      await mounted.cleanup();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "MainとAuxiliaryの保存Findはmode切替で原文範囲anchorを初回要求へ渡し返されたglobal ordinalのpageと選択へ移る"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/913" }
// fault = "anchorを渡さず旧ordinalを使うかanchorOrdinalを無視して最初の保存pageを選ぶ"
// observable = "searchConversationのanchorとoffset/stamp、Find現在位置、Source Highlight、読み込んだhistory index"
// observation_boundary = "component-behavior"
// scope = "paged Findの保存原文出現とmode切替"
// lifecycle = "permanent"
// impact = "長い履歴の選択中URLをSourceで確認すると別の保存結果へ移る"
// distinction = "local切替testは保存APIとglobal ordinal page取得を通らない。2ownerと64件境界だけをcanned保存結果で検証する"
// @end-test-value
/** 両ownerでモード切替時に元文アンカーを引き継ぎ、サーバーが返す全体順位へ移動する。 */
test("paged Find uses raw anchors and returned global ordinals across modes for both owners", async () => {
  for (const sessionId of ["main", "auxiliary"]) {
    const text = "[label](C:/needle.md) needle";
    const messages: Message[] = [{ role: "assistant", text, historyIndex: 49 }];
    const requests: Array<
      Parameters<
        NonNullable<SessionMessageColumnProps["searchConversation"]>
      >[0]
    > = [];
    const loaded: number[] = [];
    /** MainとAuxiliaryを同じページング契約の異なるownerとして描画する。 */
    function Column(props: SessionMessageColumnProps) {
      return React.createElement(SessionMessageColumn, {
        ...props,
        conversationQueryOwner: sessionId,
        /** モード別の一致順とアンカー順位を返し、元文アンカーの送信も記録する。 */
        searchConversation: async (request) => {
          requests.push(request);
          const offset = request.offset ?? 0;
          const source = request.mode === "source";
          return {
            status: "complete",
            stamp: {
              generationId: "generation",
              ownerIdentity: sessionId,
              contentRevision: 1,
              requestId: request.requestId,
            },
            incarnationId: "incarnation",
            messageCount: 1000,
            totalCount: 130,
            offset,
            ...(!request.stamp && request.anchor
              ? { anchorOrdinal: source ? 65 : 1 }
              : {}),
            items: Array.from(
              { length: Math.min(64, 130 - offset) },
              (_, index) => {
                const ordinal = offset + index;
                return source
                  ? {
                      messageIndex: ordinal === 65 ? 49 : ordinal + 100,
                      occurrenceIndex: 0,
                    }
                  : {
                      messageIndex: ordinal < 2 ? 49 : ordinal + 100,
                      occurrenceIndex: ordinal === 1 ? 1 : 0,
                    };
              },
            ),
          };
        },
        /** モード切替に伴い要求されたページ位置を記録する。 */
        onLoadMessagePage: async (index) => {
          loaded.push(index);
        },
      });
    }
    const mounted = await mountSessionMessageColumn({
      sessionId,
      messages,
      component: Column,
    });
    const highlights = installMessageFindHighlights(mounted);
    /** 各モードで返された全体順位をFindの位置表示から読む。 */
    const count = () =>
      mounted.container.querySelector(".session-content-find-count")?.firstChild
        ?.textContent;
    try {
      await setMessageFindQuery(mounted, "needle");
      await act(async () =>
        mounted.container
          .querySelector<HTMLButtonElement>("button[aria-label='Next match']")!
          .click(),
      );
      assert.equal(count(), "2/130");
      await mounted.rerender({ messageViewMode: "source" });
      const firstSource = requests.find(
        (request) => request.mode === "source" && !request.stamp,
      );
      assert.deepEqual(firstSource?.anchor, {
        messageIndex: 49,
        startOffset: text.indexOf("needle"),
        endOffset: text.indexOf("needle") + 6,
      });
      assert.equal(count(), "66/130", sessionId);
      assert.ok(
        requests.some(
          (request) =>
            request.mode === "source" &&
            request.offset === 64 &&
            request.stamp?.requestId === firstSource?.requestId,
        ),
      );
      assert.equal(loaded.at(-1), 49);
      assert.equal(
        highlights.get("withmate-find-current")?.ranges[0]?.startOffset,
        text.indexOf("needle"),
      );
      await mounted.rerender({ messageViewMode: "preview" });
      assert.equal(count(), "2/130");
      assert.equal(
        mounted.container.querySelector(".message-find-source-target")?.tagName,
        "A",
      );
    } finally {
      await mounted.cleanup();
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "検索queryを保ったPreviewのlive更新は確定履歴を再解析せず、変更されたlive本文だけを検索投影する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/737#issuecomment-5979140173 PERF-737-A" }
// fault = "ConversationMessageColumnのlive投影でmessages配列が変わるたびに確定履歴もMarkdown検索解析される"
// observable = "共通検索投影関数のV8呼出回数、検索件数、結果移動とCSS Highlightの文字列"
// observation_boundary = "component-behavior"
// scope = "ConversationMessageColumnから共通検索へのlive更新"
// lifecycle = "permanent"
// impact = "検索を続けながら応答を読む際の同期解析負荷が、変更のない履歴量に比例して増える"
// distinction = "既存DOM・型・build確認では再解析を検出できない。既存mount fixtureとV8 coverageで5更新だけを観測し、製品側の計測APIやmockを追加しない"
// @end-test-value
/** liveの末尾が伸びても確定済み本文は再投影せず、更新箇所だけを再解析する。 */
test("ConversationMessageColumn の検索はlive末尾更新だけを再解析する", async (t) => {
  const messages = Array.from({ length: 40 }, (_, index): Message => ({
    role: "user",
    text: `history ${index} needle [label](https://destination.example)`,
  }));
  const mounted = await mountSessionMessageColumn({
    messages,
    component: ConversationBackedMessageColumn,
    isRunning: true,
    liveRunAssistantText: "live needle 0",
  });
  const counter = await startSearchProjectionCounter();
  try {
    /** 再解析後にハイライトが新しい本文へ移ったことを範囲で確認するための代替実装。 */
    class TestHighlight {
      readonly ranges: Range[] = [];
      /** ライブ更新後に生成されたハイライト範囲を記録する。 */
      add(range: Range) {
        this.ranges.push(range);
        return this;
      }
    }
    const highlights = new Map<string, TestHighlight>();
    Object.defineProperty(mounted.dom.window, "CSS", {
      configurable: true,
      value: { highlights },
    });
    Object.defineProperty(mounted.dom.window, "Highlight", {
      configurable: true,
      value: TestHighlight,
    });
    await setMessageFindQuery(mounted, "needle");
    assert.equal(await counter.take(), 41);
    assert.equal(
      mounted.container.querySelector(".session-content-find-count")
        ?.textContent,
      "1/41",
    );
    for (let tick = 1; tick <= 5; tick += 1) {
      await mounted.rerender({
        isRunning: true,
        liveRunAssistantText: `live needle ${tick}`,
      });
    }
    const parseCount = await counter.take();
    t.diagnostic(
      `40確定履歴・query=needle・Preview・5 live更新: 検索Markdown解析 ${parseCount}回`,
    );
    assert.equal(parseCount, 5);
    assert.equal(
      mounted.container.querySelector(".session-content-find-count")
        ?.textContent,
      "1/41",
    );
    assert.equal(
      highlights.get("withmate-find-current")?.ranges[0]?.toString(),
      "needle",
    );
    const next = mounted.container.querySelector<HTMLButtonElement>(
      "button[aria-label='Next match']",
    );
    assert.ok(next);
    await act(async () => next.click());
    await act(async () => {
      mounted.container
        .querySelector(".session-message-list")
        ?.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });
    assert.equal(
      mounted.container.querySelector(".session-content-find-count")
        ?.textContent,
      "2/41",
    );
    assert.equal(
      highlights.get("withmate-find-current")?.ranges[0]?.toString(),
      "needle",
    );
    await setMessageFindQuery(mounted, "live needle");
    assert.equal(await counter.take(), 0);
    assert.equal(
      mounted.container.querySelector(".session-content-find-count")
        ?.textContent,
      "1/1",
    );
    assert.equal(
      highlights.get("withmate-find-current")?.ranges[0]?.toString(),
      "live needle",
    );
    await mounted.rerender({
      messages: [...messages, { role: "assistant", text: "settled needle" }],
      isRunning: false,
      liveRunAssistantText: "",
    });
    // 確定時は新しい履歴の検索本文とcollapse previewが各1回、この投影関数を使う。
    assert.equal(await counter.take(), 2);
    assert.equal(
      mounted.container.querySelector(".session-content-find-count")
        ?.textContent,
      "0/0",
    );
    await setMessageFindQuery(mounted, "settled needle");
    assert.equal(await counter.take(), 0);
    assert.equal(
      mounted.container.querySelector(".session-content-find-count")
        ?.textContent,
      "1/1",
    );
    assert.equal(
      highlights.get("withmate-find-current")?.ranges[0]?.toString(),
      "settled needle",
    );
  } finally {
    await counter.stop();
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "検索本文の再利用はkeyと本文に一致する現在の会話だけを対象とし、Source中の本文変更・owner切替・履歴離脱・query空を越えて古い投影を再利用しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/737#issuecomment-5979140173 PERF-737-A; https://github.com/natumekazuki/WithMate/issues/887" }
// fault = "配列再生成・並べ替えで全文再解析する、同じkeyやSource中に変更した本文を見落とす、離脱履歴や別ownerを保持し続ける"
// observable = "SessionMessageColumnの検索件数と、各入力変更による共通検索投影関数のV8呼出回数"
// observation_boundary = "component-behavior"
// scope = "検索投影の本文・key・owner・現在履歴の寿命"
// lifecycle = "permanent"
// impact = "検索結果が古い本文と不一致になり、会話反復切替や履歴入替で不要な本文保持が増え続ける"
// distinction = "既存検索testは一回の件数・移動・highlightを担う。このtestは3件以内の入力遷移だけで再利用と破棄を観測し、型やDOMの単発確認では判別できない寿命を確認する"
// @end-test-value
/** 検索投影は本文とキーが同じ現在履歴でだけ再利用し、履歴離脱・owner切替・空検索を越えて残さない。 */
test("SessionMessageColumn の検索投影は本文・key・owner・現在履歴に追従する", async () => {
  const first: Message = { role: "assistant", text: "**needle** first" };
  const second: Message = {
    role: "user",
    text: "[other](https://needle.example)",
  };
  const mounted = await mountSessionMessageColumn({
    messages: [first, second],
    messageKeys: ["first", "second"],
  });
  const counter = await startSearchProjectionCounter();
  /** 投影を差し替える各段階で、画面が示す一致位置と総数を読む。 */
  const count = () =>
    mounted.container.querySelector(".session-content-find-count")?.firstChild
      ?.textContent;
  try {
    await setMessageFindQuery(mounted, "needle");
    assert.equal(await counter.take(), 2);
    assert.equal(count(), "1/2");

    // 新しいmessage objectと配列でも、keyと本文の組は変わらない。
    await mounted.rerender({
      messages: [{ ...second }, { ...first }],
      messageKeys: ["second", "first"],
    });
    assert.equal(await counter.take(), 0);
    assert.equal(count(), "1/2");
    const changed: Message = { ...first, text: "**absent** first" };
    assert.equal(first.text.length, changed.text.length);
    await mounted.rerender({
      messages: [second, changed],
      messageKeys: ["second", "first"],
    });
    assert.equal(await counter.take(), 1);
    assert.equal(count(), "1/1");
    const third: Message = { role: "assistant", text: "needle third" };
    const keys = ["second", "first", "third"];
    let messages = [second, changed, third];
    await mounted.rerender({ messages, messageKeys: keys });
    assert.equal(await counter.take(), 1);
    assert.equal(count(), "1/2");

    await mounted.rerender({
      messages,
      messageKeys: keys,
      messageViewMode: "source",
    });
    assert.equal(await counter.take(), 0);
    assert.equal(count(), "1/2");
    messages = [
      { ...second, text: "[new](https://needle.example)" },
      changed,
      third,
    ];
    await mounted.rerender({
      messages,
      messageKeys: keys,
      messageViewMode: "source",
    });
    assert.equal(await counter.take(), 0);
    await mounted.rerender({
      messages,
      messageKeys: keys,
      messageViewMode: "preview",
    });
    assert.equal(await counter.take(), 1);
    assert.equal(count(), "1/2");

    await mounted.rerender({
      messages: messages.slice(0, 2),
      messageKeys: keys.slice(0, 2),
    });
    assert.equal(await counter.take(), 0);
    assert.equal(count(), "1/1");
    await mounted.rerender({ messages, messageKeys: keys });
    assert.equal(await counter.take(), 1);
    assert.equal(count(), "1/2");
    await mounted.rerender({
      sessionId: "another-owner",
      messages,
      messageKeys: keys,
    });
    assert.equal(await counter.take(), 3);
    assert.equal(count(), "1/2");
    await mounted.rerender({
      sessionId: "session-1",
      messages,
      messageKeys: keys,
    });
    assert.equal(await counter.take(), 3);

    await setMessageFindQuery(mounted, "");
    assert.equal(await counter.take(), 0);
    assert.equal(count(), "0/0");
    await setMessageFindQuery(mounted, "needle");
    assert.equal(await counter.take(), 3);
    assert.equal(count(), "1/2");
  } finally {
    await counter.stop();
    await mounted.cleanup();
  }
});

/** Findを開始すると、仮想範囲外にある最初の一致をマウントしてそこへ移動する。 */
test("SessionMessageColumn は検索開始時に未mountの最初の一致へ移動する", async () => {
  /** 仮想行のマウント後に初めて登録される一致範囲を観測する。 */
  class TestHighlight {
    readonly ranges: Range[] = [];

    /** 初期化時の範囲は空で、登録は後から行われることを確認する。 */
    constructor(...ranges: Range[]) {
      assert.equal(ranges.length, 0);
    }

    /** 行へ移動した後の一致範囲を捕捉する。 */
    add(range: Range) {
      this.ranges.push(range);
      return this;
    }
  }

  const messages = createMessages(100);
  messages[0] = {
    role: "assistant",
    text: "only early needle and another needle",
  };
  const mounted = await mountSessionMessageColumn({ messages });

  try {
    const highlights = new Map<string, TestHighlight>();
    Object.defineProperty(mounted.dom.window, "CSS", {
      configurable: true,
      value: { highlights },
    });
    Object.defineProperty(mounted.dom.window, "Highlight", {
      configurable: true,
      value: TestHighlight,
    });
    const messageList = mounted.messageListRef.current;
    assert.ok(messageList);
    const initialScrollTop = messageList.scrollTop;
    assert.doesNotMatch(
      mounted.container.textContent ?? "",
      /only early needle/,
    );

    await act(async () => {
      mounted.dom.window.dispatchEvent(
        new mounted.dom.window.KeyboardEvent("keydown", {
          key: "f",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    const input = mounted.container.querySelector<HTMLInputElement>(
      "input[aria-label='Find in current content']",
    );
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      mounted.dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    await act(async () => {
      setInputValue.call(input, "needle");
      const propertyChange = new mounted.dom.window.Event("propertychange", {
        bubbles: true,
      });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
    });

    assert.ok(messageList.scrollTop < initialScrollTop);
    await act(async () => {
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });
    assert.match(mounted.container.textContent ?? "", /only early needle/);
    assert.deepEqual(
      highlights
        .get("withmate-find-match")
        ?.ranges.map((range) => range.toString()),
      ["needle", "needle"],
    );
    assert.deepEqual(
      highlights
        .get("withmate-find-current")
        ?.ranges.map((range) => range.startOffset),
      [11],
    );
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "質問で分割された本文のFindはsource/previewの一致番号を維持して前後の本文を強調・移動し、質問解決後も検索できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 全履歴Findのsource/preview検索意味とglobal ordinal" }
// fault = "最初の本文断片しか検索しない、フォームの文字を数える、または置換中の質問分だけ後続本文の一致番号をずらす"
// observable = "Find件数、CSS HighlightのRange内容と現在Rangeの所属本文、前後移動時のscrollIntoView対象"
// observation_boundary = "component-behavior"
// scope = "inline question message Find"
// lifecycle = "permanent"
// impact = "質問以降の検索結果に到達できず、会話の情報を見失う"
// distinction = "既存Find testは質問による本文分割と質問原文の置換を通らない。2質問形式と2表示modeの短いDOM操作で公開検索契約を守る"
// @end-test-value
/** 質問カードを挟む本文は本文内の出現順で辿り、質問を解決した後も同じ一致を保つ。 */
test("質問前後のFindは本文の一致番号で強調・移動し解決後も保持する", async () => {
  /** 質問の前後どちらに現在一致が付いたかをDOM範囲で観測する。 */
  class TestHighlight {
    readonly ranges: Range[] = [];
    /** 本文の現在一致と全一致が持つ範囲をそれぞれ記録する。 */
    add(range: Range) {
      this.ranges.push(range);
      return this;
    }
  }
  for (const kind of ["tool", "source"] as const) {
    for (const messageViewMode of ["preview", "source"] as const) {
      const before = "Before **needle**\n\n";
      const question = kind === "source" ? "Which needle?\n\n" : "";
      const text = `${before}${question}After **needle**`;
      const request: LiveElicitationRequest = {
        ...createLiveElicitationRequest(),
        kind: "question",
        fields: [
          {
            type: "text",
            name: "answer",
            title: "Which needle?",
            required: true,
          },
        ],
      };
      /** 実行中と確定後の本文に同一キーを割り当てて質問前後の連続性を調べる。 */
      function Column(props: SessionMessageColumnProps) {
        return React.createElement(SessionMessageColumn, {
          ...props,
          messageKeys: ["body"],
          pendingResponseMessageKey: props.isRunning ? "body" : null,
        });
      }
      const message: Message = {
        role: "assistant",
        text,
        elicitationRecords: [
          {
            requestId: request.requestId,
            kind: "question",
            message: "needle",
            fields: [{ title: "Which needle?", options: ["needle option"] }],
            textRange: {
              start: before.length,
              end: before.length + question.length,
            },
            status: "pending",
          },
        ],
      };
      const mounted = await mountSessionMessageColumn({
        component: Column,
        messages: [message],
        isRunning: true,
        liveElicitationRequest: request,
        messageViewMode,
      });
      try {
        const highlights = new Map<string, TestHighlight>();
        Object.defineProperty(mounted.dom.window, "CSS", {
          configurable: true,
          value: { highlights },
        });
        Object.defineProperty(mounted.dom.window, "Highlight", {
          configurable: true,
          value: TestHighlight,
        });
        let scrolledText = "";
        mounted.dom.window.HTMLElement.prototype.scrollIntoView = function () {
          scrolledText = this.closest(".rich-text")?.textContent ?? "";
        };
        await setMessageFindQuery(mounted, "needle");
        const total = kind === "source" ? 3 : 2;
        assert.equal(
          mounted.container.querySelector(".session-content-find-count")
            ?.textContent,
          `1/${total}`,
        );
        assert.deepEqual(
          highlights
            .get("withmate-find-match")
            ?.ranges.map((range) => range.toString()),
          ["needle", "needle"],
        );
        assert.match(scrolledText, /Before/);
        const next = mounted.container.querySelector<HTMLButtonElement>(
          "button[aria-label='Next match']",
        )!;
        const previous = mounted.container.querySelector<HTMLButtonElement>(
          "button[aria-label='Previous match']",
        )!;
        for (let step = 1; step < total; step += 1)
          await act(async () => next.click());
        /** 現在一致とスクロール先が、質問より後ろの本文を指すことを確認する。 */
        const assertAfter = () => {
          assert.equal(
            mounted.container.querySelector(".session-content-find-count")
              ?.textContent,
            `${total}/${total}`,
          );
          const range = highlights.get("withmate-find-current")?.ranges[0];
          assert.equal(range?.toString(), "needle");
          assert.ok(range);
          const prefix = mounted.dom.window.document.createRange();
          prefix.selectNodeContents(
            range.startContainer.parentElement!.closest(".rich-text")!,
          );
          prefix.setEnd(range.startContainer, range.startOffset);
          assert.match(prefix.toString(), /After/);
          assert.match(scrolledText, /After/);
        };
        assertAfter();
        for (let step = 1; step < total; step += 1)
          await act(async () => previous.click());
        assert.match(scrolledText, /Before/);
        for (let step = 1; step < total; step += 1)
          await act(async () => next.click());
        await mounted.rerender({
          isRunning: false,
          liveElicitationRequest: null,
          messages: [
            {
              ...message,
              elicitationRecords: message.elicitationRecords!.map((record) => ({
                ...record,
                status: "answered",
              })),
            },
          ],
        });
        assertAfter();
        assert.equal(
          highlights.get("withmate-find-match")?.ranges.length,
          total,
        );
      } finally {
        await mounted.cleanup();
      }
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "承認の要約や詳細と本文に同じ検索語があっても、Findの件数・強調・前後移動は本文の一致だけを対象にする"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Rendering PolicyとStreaming projectionの検索契約" }
// fault = "承認の要約または閉じた詳細がDOM検索へ混入し、本文の一致番号と強調・移動先がずれる"
// observable = "Find件数、CSS HighlightのRange内容と所属text、前後移動時のscroll対象、詳細開閉・承認解除後の一致"
// observation_boundary = "component-behavior"
// scope = "SessionMessageColumnのPreview／Sourceにおけるinline承認と本文Find"
// lifecycle = "permanent"
// impact = "利用者が本文の検索結果へ移動できず、非表示の承認詳細を現在位置として選んでしまう"
// distinction = "既存の質問Findは操作面が本文DOMの外にあり、承認を含むMarkdown内の検索境界を通らない。既存DOM fixtureで2表示modeの短い操作を確認する"
// @end-test-value
/** 承認詳細を開閉し要求を解除しても、Findは承認欄ではなく本文の一致のみを辿る。 */
test("承認の詳細開閉と解除を通してFindは本文の一致だけを辿る", async () => {
  /** 承認パネルの状態により本文のハイライト範囲がずれていないか観測する。 */
  class TestHighlight {
    readonly ranges: Range[] = [];
    /** 登録された範囲を保存し、承認欄がFind対象に入っていないか検査できるようにする。 */
    add(range: Range) {
      this.ranges.push(range);
      return this;
    }
  }
  for (const messageViewMode of ["preview", "source"] as const) {
    const before = "Before needle\n\n";
    const text = `${before}After needle`;
    let request: LiveApprovalRequest | null = {
      ...createLiveApprovalRequest(),
      textPosition: before.length,
      summary: "needle command",
      details: "needle hidden details",
    };
    /** 同じ応答キーへ入力中のコマンド承認を割り当てる。 */
    function Column(props: SessionMessageColumnProps) {
      return React.createElement(SessionMessageColumn, {
        ...props,
        pendingResponseMessageKey: "response",
        liveApprovalRequest: request,
      });
    }
    const mounted = await mountSessionMessageColumn({
      component: Column,
      messages: [{ role: "assistant", text }],
      messageKeys: ["response"],
      isRunning: true,
      liveRunAssistantText: text,
      messageViewMode,
    });
    try {
      const highlights = new Map<string, TestHighlight>();
      Object.defineProperty(mounted.dom.window, "CSS", {
        configurable: true,
        value: { highlights },
      });
      Object.defineProperty(mounted.dom.window, "Highlight", {
        configurable: true,
        value: TestHighlight,
      });
      let scrolledText = "";
      mounted.dom.window.HTMLElement.prototype.scrollIntoView = function () {
        scrolledText = this.textContent ?? "";
      };
      await setMessageFindQuery(mounted, "needle");
      /** 表示順位・現在範囲と移動先の本文を組み合わせて照合する。 */
      const assertCurrent = (ordinal: number, expectedText: RegExp) => {
        assert.equal(
          mounted.container.querySelector(".session-content-find-count")
            ?.textContent,
          `${ordinal}/2`,
        );
        assert.deepEqual(
          highlights
            .get("withmate-find-match")
            ?.ranges.map((range) => range.toString()),
          ["needle", "needle"],
        );
        const current = highlights.get("withmate-find-current")?.ranges[0];
        assert.equal(current?.toString(), "needle");
        assert.match(current?.startContainer.textContent ?? "", expectedText);
        assert.match(scrolledText, expectedText);
      };
      assertCurrent(1, /Before needle/);
      const next = mounted.container.querySelector<HTMLButtonElement>(
        "button[aria-label='Next match']",
      )!;
      const previous = mounted.container.querySelector<HTMLButtonElement>(
        "button[aria-label='Previous match']",
      )!;
      await act(async () => next.click());
      assertCurrent(2, /After needle/);
      await act(async () => previous.click());
      assertCurrent(1, /Before needle/);
      await act(async () => next.click());
      assertCurrent(2, /After needle/);
      const toggle = mounted.container.querySelector<HTMLButtonElement>(
        "[aria-label='Show approval details']",
      )!;
      const details = mounted.container.querySelector<HTMLElement>(
        ".live-approval-details",
      )!;
      assert.equal(details.hidden, true);
      await act(async () => toggle.click());
      assert.equal(details.hidden, false);
      assertCurrent(2, /After needle/);
      await act(async () => toggle.click());
      assert.equal(details.hidden, true);
      assertCurrent(2, /After needle/);
      request = null;
      await mounted.rerender({});
      assertCurrent(2, /After needle/);
    } finally {
      await mounted.cleanup();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "同じmessageの表示一致・原文一致の次にpending一致へ移動し、message削除後は残るpendingへ現在位置をclampする"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/887" }
// fault = "表示と原文の別出現を失う、pendingを誤順序で数える、または結果減少後に選択を失う"
// observable = "件数、現在highlightの所属node、原文一致の強調anchor、message削除後の件数とhighlight"
// observation_boundary = "component-behavior"
// scope = "local chat Findの混在順序と現在位置clamp"
// lifecycle = "permanent"
// impact = "保存前後のチャット検索で結果の前後関係と移動先を維持する"
// distinction = "matcher単体はpendingとの合流とReact再描画後のclampを通らない。短い1messageとpendingの遷移を検証する"
// @end-test-value
/** PreviewとSourceで未保存のpendingまで順に数え、件数が減ったとき現在位置を末尾の有効範囲に収める。 */
test("SessionMessageColumn の検索は表示・原文とpendingを順に数え現在位置をclampする", async () => {
  /** モード切替時に取り直された全一致と現在一致の範囲を捕捉する。 */
  class TestHighlight {
    readonly ranges: Range[] = [];

    /** 構築時には範囲を渡さず後から登録する前提を確認する。 */
    constructor(...ranges: Range[]) {
      assert.equal(ranges.length, 0);
    }

    /** 現在の表示モードから登録された本文範囲を保持する。 */
    add(range: Range) {
      this.ranges.push(range);
      return this;
    }
  }

  const linkMessage: Message = {
    role: "assistant",
    text: "[needle](https://needle.example/path)",
  };
  const mounted = await mountSessionMessageColumn({
    isRunning: true,
    messages: [linkMessage],
    pendingMessageText: "pending needle",
  });

  try {
    const highlights = new Map<string, TestHighlight>();
    Object.defineProperty(mounted.dom.window, "CSS", {
      configurable: true,
      value: { highlights },
    });
    Object.defineProperty(mounted.dom.window, "Highlight", {
      configurable: true,
      value: TestHighlight,
    });
    await act(async () => {
      mounted.dom.window.dispatchEvent(
        new mounted.dom.window.KeyboardEvent("keydown", {
          key: "f",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    const input = mounted.container.querySelector<HTMLInputElement>(
      "input[aria-label='Find in current content']",
    );
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      mounted.dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    await act(async () => {
      setInputValue.call(input, "needle");
      const propertyChange = new mounted.dom.window.Event("propertychange", {
        bubbles: true,
      });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
    });

    assert.equal(
      mounted.container.querySelector(".session-content-find-count")
        ?.textContent,
      "1/3",
    );
    assert.equal(highlights.get("withmate-find-match")?.ranges.length, 2);
    assert.equal(
      highlights.get("withmate-find-current")?.ranges[0]?.startContainer
        .parentElement?.tagName,
      "A",
    );

    const nextButton = mounted.container.querySelector<HTMLButtonElement>(
      "button[aria-label='Next match']",
    );
    assert.ok(nextButton);
    await act(async () => {
      nextButton.click();
    });
    assert.equal(
      mounted.container.querySelector(".session-content-find-count")?.firstChild
        ?.textContent,
      "2/3",
    );
    assert.equal(
      mounted.container.querySelector(".message-find-source-target")?.tagName,
      "A",
    );
    assert.equal(
      mounted.container.querySelector(".session-content-find-count span")
        ?.textContent,
      "Source Match",
    );
    assert.equal(
      highlights.get("withmate-find-current")?.ranges.length ?? 0,
      0,
    );
    await act(async () => nextButton.click());
    assert.equal(
      mounted.container.querySelector(".session-content-find-count")
        ?.textContent,
      "3/3",
    );
    assert.equal(
      highlights.get("withmate-find-current")?.ranges[0]?.startContainer
        .parentElement?.tagName,
      "P",
    );

    await mounted.rerender({
      messages: [],
      pendingMessageText: "pending needle",
    });
    assert.equal(
      mounted.container.querySelector(".session-content-find-count")
        ?.textContent,
      "1/1",
    );
    assert.equal(highlights.get("withmate-find-current")?.ranges.length, 1);
  } finally {
    await mounted.cleanup();
  }
});

/** Source検索はリンクラベルだけでなく元Markdownに書かれたURLも一致として扱う。 */
test("SessionMessageColumn の Source 検索は link URL を含む元 Markdown を対象にする", async () => {
  /** URL一致がSource本文のどこへ付くかをハイライト範囲で観測する。 */
  class TestHighlight {
    readonly ranges: Range[] = [];

    /** URL検索で空のハイライトから範囲登録を始めることを確認する。 */
    constructor(...ranges: Range[]) {
      assert.equal(ranges.length, 0);
    }

    /** 元Markdown上で登録された範囲を検査用に残す。 */
    add(range: Range) {
      this.ranges.push(range);
      return this;
    }
  }

  const mounted = await mountSessionMessageColumn({
    messages: [
      { role: "assistant", text: "[label](https://example.test/source-path)" },
    ],
    messageViewMode: "source",
  });

  try {
    const highlights = new Map<string, TestHighlight>();
    Object.defineProperty(mounted.dom.window, "CSS", {
      configurable: true,
      value: { highlights },
    });
    Object.defineProperty(mounted.dom.window, "Highlight", {
      configurable: true,
      value: TestHighlight,
    });
    await act(async () => {
      mounted.dom.window.dispatchEvent(
        new mounted.dom.window.KeyboardEvent("keydown", {
          key: "f",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    const input = mounted.container.querySelector<HTMLInputElement>(
      "input[aria-label='Find in current content']",
    );
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      mounted.dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    await act(async () => {
      setInputValue.call(input, "example.test/source-path");
      const propertyChange = new mounted.dom.window.Event("propertychange", {
        bubbles: true,
      });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
    });

    assert.equal(
      mounted.container.querySelector(".session-content-find-count")
        ?.textContent,
      "1/1",
    );
    assert.equal(
      highlights.get("withmate-find-current")?.ranges[0]?.toString(),
      "example.test/source-path",
    );
  } finally {
    await mounted.cleanup();
  }
});

/** Auxiliary groupの途中に表示するpendingを、会話の画面順で履歴と一緒に数える。 */
test("SessionMessageColumn の検索は Auxiliary group 内のpendingを画面表示順に数える", async () => {
  /** グループ内pendingと後続履歴のハイライトを個別に捕捉する。 */
  class TestHighlight {
    readonly ranges: Range[] = [];

    /** グループの検索範囲が初期引数で混入していないことを確認する。 */
    constructor(...ranges: Range[]) {
      assert.equal(ranges.length, 0);
    }

    /** 会話順に登録された範囲を検査用に蓄積する。 */
    add(range: Range) {
      this.ranges.push(range);
      return this;
    }
  }

  const mounted = await mountSessionMessageColumn({
    isRunning: true,
    messages: [
      { role: "assistant", text: "main needle" },
      { role: "user", text: "aux needle", accent: true },
      { role: "assistant", text: "later needle" },
    ],
    messageGroups: [null, { id: "aux-1", label: "Auxiliary" }, null],
    pendingMessageText: "pending needle",
    pendingMessageGroupId: "aux-1",
  });

  try {
    const highlights = new Map<string, TestHighlight>();
    Object.defineProperty(mounted.dom.window, "CSS", {
      configurable: true,
      value: { highlights },
    });
    Object.defineProperty(mounted.dom.window, "Highlight", {
      configurable: true,
      value: TestHighlight,
    });
    await act(async () => {
      mounted.dom.window.dispatchEvent(
        new mounted.dom.window.KeyboardEvent("keydown", {
          key: "f",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    const input = mounted.container.querySelector<HTMLInputElement>(
      "input[aria-label='Find in current content']",
    );
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      mounted.dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    await act(async () => {
      setInputValue.call(input, "needle");
      const propertyChange = new mounted.dom.window.Event("propertychange", {
        bubbles: true,
      });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
    });

    const nextButton = mounted.container.querySelector<HTMLButtonElement>(
      "button[aria-label='Next match']",
    );
    assert.ok(nextButton);
    await act(async () => nextButton.click());
    await act(async () => nextButton.click());

    assert.equal(
      mounted.container.querySelector(".session-content-find-count")
        ?.textContent,
      "3/4",
    );
    const pendingRange = highlights.get("withmate-find-current")?.ranges[0];
    assert.ok(pendingRange);
    assert.ok(
      pendingRange.startContainer.parentElement?.closest(
        "[data-pending-message-body='true']",
      ),
      "3件目は後続main messageではなくgroup内pendingを指す",
    );

    await act(async () => nextButton.click());
    assert.equal(
      mounted.container.querySelector(".session-content-find-count")
        ?.textContent,
      "4/4",
    );
    const laterRange = highlights.get("withmate-find-current")?.ranges[0];
    assert.equal(
      laterRange?.startContainer.parentElement?.closest<HTMLElement>(
        ".session-message-virtual-row",
      )?.dataset.index,
      "2",
    );
  } finally {
    await mounted.cleanup();
  }
});

/** 一致数が上限を超えても表示する最初の5000範囲を画面順に選び、その中にグループ内pendingを含める。 */
test("SessionMessageColumn の検索は5000件highlight budgetへgroup内pendingを表示順に含める", async () => {
  /** 上限が適用された集合から、pendingに届いた範囲を検査する。 */
  class TestHighlight {
    readonly ranges: Range[] = [];

    /** 空の集合からハイライト上限の計数を始める。 */
    constructor(...ranges: Range[]) {
      assert.equal(ranges.length, 0);
    }

    /** 実際に上限内で登録された範囲だけを保持する。 */
    add(range: Range) {
      this.ranges.push(range);
      return this;
    }
  }

  const mounted = await mountSessionMessageColumn({
    isRunning: true,
    messages: [
      { role: "user", text: "x", accent: true },
      { role: "assistant", text: "x".repeat(6_000) },
    ],
    messageGroups: [{ id: "aux-1", label: "Auxiliary" }, null],
    pendingMessageText: "x",
    pendingMessageGroupId: "aux-1",
  });

  try {
    const highlights = new Map<string, TestHighlight>();
    Object.defineProperty(mounted.dom.window, "CSS", {
      configurable: true,
      value: { highlights },
    });
    Object.defineProperty(mounted.dom.window, "Highlight", {
      configurable: true,
      value: TestHighlight,
    });
    await act(async () => {
      mounted.dom.window.dispatchEvent(
        new mounted.dom.window.KeyboardEvent("keydown", {
          key: "f",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    const input = mounted.container.querySelector<HTMLInputElement>(
      "input[aria-label='Find in current content']",
    );
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      mounted.dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    await act(async () => {
      setInputValue.call(input, "x");
      const propertyChange = new mounted.dom.window.Event("propertychange", {
        bubbles: true,
      });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
    });

    assert.equal(
      mounted.container.querySelector(".session-content-find-count")
        ?.textContent,
      "1/6002",
    );
    const allMatches = highlights.get("withmate-find-match")?.ranges ?? [];
    assert.equal(allMatches.length, 5_000);
    assert.ok(
      allMatches.some((range) =>
        range.startContainer.parentElement?.closest(
          "[data-pending-message-body='true']",
        ),
      ),
      "semantic順で2件目のpendingを先頭5000件highlightへ含める",
    );
  } finally {
    await mounted.cleanup();
  }
});

/** 表示範囲より上の行が再計測で伸びても、同じ読書位置を保つ。 */
test("SessionMessageColumn は上側rowの可変高再計測後も表示位置を維持する", async () => {
  const mounted = await mountSessionMessageColumn({
    messages: createMessages(100),
  });

  try {
    const messageList = mounted.messageListRef.current;
    assert.ok(messageList);
    await act(async () => {
      messageList.scrollTop = 0;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
      messageList.scrollTop = 4_000;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
      await new Promise((resolve) =>
        mounted.dom.window.setTimeout(resolve, 180),
      );
    });
    const renderedRows = Array.from(
      mounted.container.querySelectorAll<HTMLElement>(
        ".session-message-virtual-row",
      ),
    );
    const rowAboveViewport = renderedRows.find((row) => {
      const start = Number.parseFloat(
        row.style.top ||
          (row.style.transform.match(/translate3d\(0,\s*([^p]+)px/)?.[1] ??
            row.style.transform.match(/translateY\(([^p]+)px\)/)?.[1] ??
            "0"),
      );
      return start < messageList.scrollTop;
    });
    assert.ok(rowAboveViewport);
    const rowIndex = Number(rowAboveViewport.dataset.index);
    const scrollTopBeforeResize = messageList.scrollTop;

    await mounted.resizeMessageRow(rowIndex, 268);

    assert.equal(messageList.scrollTop, scrollTopBeforeResize + 100);
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "再計測のscroll補正判定は行末がviewport上端と一致する行を含み、上端を跨ぐ行と下側の行は対象にしない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: message list follow mode" }
// fault = "viewport先頭を跨ぐanchor行の増減を全量scrollTopへ加算して段落位置をずらす"
// observable = "境界前後の行に対する補正可否"
// observation_boundary = "implementation"
// scope = "virtual message row measurement adjustment boundary"
// lifecycle = "permanent"
// impact = "読みかけの行の高さ増減を全量補正すると閲覧位置がずれる"
// distinction = "DOM testでは到達しにくい行末とviewport上端の一致・1px差を小さい判定testで確認する"
// @end-test-value
/** 上方向へ移動中でも、下端が表示先頭以前にある行だけをアンカー補正の対象にする。 */
test("SessionMessageColumn は上方向scroll中も上側rowのvisible anchorを補正する", () => {
  assert.equal(
    shouldAdjustSessionMessageScrollPosition({
      itemEnd: 4_000,
      scrollOffset: 4_000,
    }),
    true,
  );
  assert.equal(
    shouldAdjustSessionMessageScrollPosition({
      itemEnd: 4_001,
      scrollOffset: 4_000,
    }),
    false,
  );
  assert.equal(
    shouldAdjustSessionMessageScrollPosition({
      itemEnd: 5_000,
      scrollOffset: 4_000,
    }),
    false,
  );
});

/** 行の追加だけで末尾に飛ばず、追従するかどうかを管理する側に委ねる。 */
test("SessionMessageColumn はappend時の末尾移動をfollow ownerへ委ねる", async () => {
  const initialMessages = createMessages(20);
  const mounted = await mountSessionMessageColumn({
    messages: initialMessages,
  });

  try {
    const messageList = mounted.messageListRef.current;
    assert.ok(messageList);
    await act(async () => {
      messageList.scrollTop =
        messageList.scrollHeight - messageList.clientHeight;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });
    const followingScrollTop = messageList.scrollTop;
    const appendedMessages = [
      ...initialMessages,
      { role: "assistant" as const, text: "appended at end" },
    ];

    await mounted.rerender({
      isMessageListFollowing: true,
      messages: appendedMessages,
    });
    await act(async () => {
      await new Promise<void>((resolve) =>
        mounted.dom.window.requestAnimationFrame(() => resolve()),
      );
    });

    assert.equal(messageList.scrollTop, followingScrollTop);
    assert.match(mounted.container.textContent ?? "", /appended at end/);

    await act(async () => {
      messageList.scrollTop = 300;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });
    const nonFollowingScrollTop = messageList.scrollTop;

    await mounted.rerender({
      messages: [
        ...appendedMessages,
        { role: "user", text: "append while reading history" },
      ],
    });

    assert.equal(messageList.scrollTop, nonFollowingScrollTop);
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "同じ仮想範囲内の連続scrollは、表示済みMarkdown本文を再計算しない"
// fault = "scroll offsetだけの変更を各本文のrenderへ伝播し、履歴閲覧中に不要なMarkdown解析を繰り返す"
// observable = "初回には実Markdown preview関数が呼ばれ、同じ範囲の連続scrollでは呼出しが0である"
// observation_boundary = "implementation"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: memo化したMessageRichTextとstableなMarkdown component" }
// scope = "100件の履歴、同じ仮想範囲内でのscroll offset更新"
// lifecycle = "permanent"
// impact = "長い履歴のscrollごとにMarkdown本文が再計算されると操作が重くなる"
// distinction = "列全体のProfiler更新数は仮想範囲管理も数えるため、本文の再計算を直接区別できない"
// @end-test-value
/** 同じ仮想範囲のスクロールは行のマークダウンを再描画しない。 */
test("SessionMessageColumn は同じ仮想範囲内の連続scrollでmessageを再描画しない", async () => {
  const inspector = new InspectorSession();
  inspector.connect();
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.startPreciseCoverage", {
    callCount: true,
    detailed: false,
  });
  /** 精密カバレッジから前回取得後のMarkdown描画回数を集計する。 */
  const takeMarkdownRenderCount = async () => {
    const { result } = await inspector.post("Profiler.takePreciseCoverage");
    return result
      .filter((script) => script.url.includes("/MessageRichText."))
      .flatMap((script) => script.functions)
      .filter((fn) => fn.functionName === "MessageMarkdownPreview")
      .reduce((count, fn) => count + fn.ranges[0].count, 0);
  };
  const messages = Array.from({ length: 100 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `message ${index + 1}`,
  }));
  const mounted = await mountSessionMessageColumn({
    messages,
  });

  try {
    assert.ok((await takeMarkdownRenderCount()) > 0);
    const messageList = mounted.messageListRef.current;
    assert.ok(messageList);
    await act(async () => {
      messageList.scrollTop = 3_000;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });
    await takeMarkdownRenderCount();

    for (const scrollTop of [3_002, 3_004, 3_006, 3_008, 3_010]) {
      await act(async () => {
        messageList.scrollTop = scrollTop;
        messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
      });
    }

    assert.equal(await takeMarkdownRenderCount(), 0);
  } finally {
    await inspector.post("Profiler.stopPreciseCoverage");
    inspector.disconnect();
    await mounted.cleanup();
  }
});

/** 列を一度非表示にして再表示しても、列自身は末尾へ移動しない。 */
test("SessionMessageColumn は非表示から復帰したとき独自に末尾へ移動しない", async () => {
  const mounted = await mountSessionMessageColumn({
    messages: createMessages(100),
  });

  try {
    const messageList = mounted.messageListRef.current;
    assert.ok(messageList);

    await mounted.rerender({
      isContentActive: false,
      isMessageListFollowing: false,
    });
    messageList.scrollTop = 0;

    await mounted.rerender({
      isContentActive: true,
      isMessageListFollowing: false,
    });

    assert.equal(messageList.scrollTop, 0);
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "StableSessionMessageColumnはcallbackの再生成だけで既存messageを再描画しない"
// oracle = { type = "contract", ref = "Issue #714: 親callback更新時も既存Markdown画像を保持する" }
// fault = "callback参照の更新だけでmemoized message columnが再描画され、既存messageの本文評価や画像lifecycleがやり直される"
// observable = "既存Message.text getterの読み取り回数"
// observation_boundary = "component-behavior"
// scope = "StableSessionMessageColumnのcallback安定化境界"
// lifecycle = "permanent"
// impact = "composer入力時の無関係な親更新で表示済み会話の画像が再mountされる"
// distinction = "ConversationMessageColumnのprojection生成を通した回帰とは別に、共通stable boundary単体のmemo動作を観測する"
// @end-test-value
/** コピーのコールバックだけを交換しても、安定化した列の既存本文は再描画しない。 */
test("StableSessionMessageColumn は callback の再生成だけでは既存 message を再描画しない", async () => {
  let messageTextReadCount = 0;
  const message = {
    role: "assistant" as const,
    /** 描画経路がメッセージ本文を参照した回数を観測する。 */
    get text() {
      messageTextReadCount += 1;
      return "stable assistant message";
    },
  };
  const mounted = await mountSessionMessageColumn({
    messages: [message],
    component: StableSessionMessageColumn,
    /** 本文再描画の計測を始めるため、初回のコピー通知口を置く。 */
    onCopyMessageText() {},
  });

  try {
    const initialReadCount = messageTextReadCount;
    assert.ok(initialReadCount > 0);

    await mounted.rerender({
      /** 処理内容は変えずに関数の同一性だけを変更する。 */ onCopyMessageText() {},
    });

    assert.equal(messageTextReadCount, initialReadCount);
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "ConversationMessageColumnは親callbackの再生成だけで既存messageの本文を再評価しない"
// oracle = { type = "contract", ref = "Issue #714: ConversationMessageColumnから共通SessionMessageColumnへの既存Markdown保持" }
// fault = "ConversationMessageColumnが生成するcharacter・Set・callbackが親更新だけでSessionMessageColumnへ伝播し、既存messageのMarkdown処理が再実行される"
// observable = "既存Message.text getterの読み取り回数"
// observation_boundary = "component-behavior"
// scope = "ConversationMessageColumnの共通stable boundary"
// lifecycle = "permanent"
// impact = "composer入力時に表示済み会話のMarkdown画像が再mountされ、loading状態や表示位置が失われる"
// distinction = "StableSessionMessageColumn単体の確認とは別に、実際のConversationMessageColumn componentでprojection・character・Set生成を通した親更新を観測する"
// @end-test-value
/** ConversationMessageColumnでも、通知関数の再生成だけでは既存本文の評価を繰り返さない。 */
test("ConversationMessageColumn は callback 再生成だけでは既存 message を再評価しない", async () => {
  let messageTextReadCount = 0;
  const message = {
    role: "assistant" as const,
    /** 親の会話列が本文を評価した回数を取得と同時に数える。 */
    get text() {
      messageTextReadCount += 1;
      return "stable conversation message";
    },
  };
  const mounted = await mountSessionMessageColumn({
    messages: [message],
    component: ConversationBackedMessageColumn,
    /** 後で同じ役割の新しい関数に置き換える初期コピー通知口。 */
    onCopyMessageText() {},
  });

  try {
    const initialReadCount = messageTextReadCount;
    assert.ok(initialReadCount > 0);

    await mounted.rerender({
      /** 本文の入力を固定して別のコピー関数を渡す。 */ onCopyMessageText() {},
    });

    assert.equal(messageTextReadCount, initialReadCount);
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "閲覧中は本文更新の前後で同じ末尾復帰buttonを提供し、操作後に会話listへfocusを戻し、追従中はbuttonを隠す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: message list follow mode" }
// fault = "本文更新で末尾復帰buttonの操作名や内容が変わる、操作callbackが動かない、復帰後のfocusがlistに戻らない、または追従中も表示する"
// observable = "本文更新前後のbutton数・accessible name・textContent・icon数・callback回数・document.activeElement"
// observation_boundary = "component-behavior"
// scope = "session-message-following"
// lifecycle = "permanent"
// impact = "履歴を読みながら新着へ戻る経路とkeyboardでの閲覧継続を保証する"
// distinction = "hookの追従状態testでは検証できない実buttonとfocusを既存DOM fixtureで確認する"
// @end-test-value
/** 本文が更新されても末尾復帰ボタンは同じノードであり、操作すると会話にフォーカスを戻す。 */
test("SessionMessageColumn は本文更新前後で同じ末尾復帰buttonと会話へのfocusを提供する", async () => {
  let jumps = 0;
  const mounted = await mountSessionMessageColumn({
    messages: createMessages(3),
    /** 末尾復帰を親へ通知した回数を見られる会話列を描画する。 */
    component: (props) =>
      React.createElement(SessionMessageColumn, {
        ...props,
        /** 末尾ボタンが発火した回数を記録する。 */
        onJumpToBottom: () => {
          jumps += 1;
        },
      }),
  });
  try {
    const buttons = mounted.container.querySelectorAll<HTMLButtonElement>(
      ".message-list-jump-bottom-button",
    );
    assert.equal(buttons.length, 1);
    const button = buttons[0]!;
    assert.equal(button.type, "button");
    assert.equal(button.tabIndex, 0);
    assert.equal(button.getAttribute("aria-label"), "Jump to latest");
    assert.equal(button.textContent, "");
    assert.equal(button.querySelectorAll("svg").length, 1);
    await mounted.rerender({ messages: createMessages(4) });
    assert.equal(
      mounted.container.querySelectorAll(".message-list-jump-bottom-button")
        .length,
      1,
    );
    assert.equal(
      mounted.container.querySelector(".message-list-jump-bottom-button"),
      button,
    );
    assert.equal(button.getAttribute("aria-label"), "Jump to latest");
    assert.equal(button.textContent, "");
    assert.equal(button.querySelectorAll("svg").length, 1);
    button.focus();
    await act(async () => button.click());
    assert.equal(jumps, 1);
    assert.equal(
      mounted.dom.window.document.activeElement,
      mounted.messageListRef.current,
    );
    await mounted.rerender({ isMessageListFollowing: true });
    assert.equal(
      mounted.container.querySelector(".message-list-jump-bottom-button"),
      null,
    );
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "overflowする仮想会話の未mount行へのanchor requestは実測位置からoffsetを復元し、非表示からの復帰と上側行・anchor行自身の行高再計測で位置を失わない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: message list follow mode" }
// fault = "再表示時の遅いjumpや再計測がanchor offsetを上書きする"
// observable = "rowのviewport offsetとlist.scrollTop"
// observation_boundary = "component-behavior"
// scope = "100行の仮想会話、clampしたscroll、disabledからの再表示、ResizeObserverとRAFを跨ぐanchor補正。非表示中の測定通知・cache保持自体は検証せず、Previewの配線と実CSS折返しはbrowser確認対象"
// lifecycle = "permanent"
// impact = "履歴の復帰先を行先頭へずらさず、再計測後も読んでいた段落を維持する"
// distinction = "cache testのrequest handoffとは異なり、virtualizerがDOMへ投影する行位置、scroll上限と後続の測定通知を通す"
// @end-test-value
/** 非表示から再計測した仮想行に、前の可視アンカーとその相対オフセットを復元する。 */
test("SessionMessageColumn は再計測した行へanchor offsetを復元する", async () => {
  const messageKeys = Array.from(
    { length: 100 },
    (_, index) => `message-${index}`,
  );
  const mounted = await mountSessionMessageColumn({
    messages: createMessages(100),
    messageKeys,
  });
  const originalRect =
    mounted.dom.window.HTMLElement.prototype.getBoundingClientRect;
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    mounted.dom.window.HTMLElement.prototype,
    "offsetHeight",
  )!;
  let hidden = false;
  try {
    const list = mounted.messageListRef.current!;
    let scrollTop = list.scrollTop;
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      /** テストが模擬している一覧の現在のスクロール位置を返す。 */
      get: () => scrollTop,
      /** ブラウザーと同じく範囲内に補正し、位置が変わった場合だけスクロールイベントを配送する。 */
      set: (value: number) => {
        const next = Math.max(
          0,
          Math.min(value, Math.max(0, list.scrollHeight - list.clientHeight)),
        );
        if (next === scrollTop) return;
        scrollTop = next;
        queueMicrotask(() =>
          list.dispatchEvent(new mounted.dom.window.Event("scroll")),
        );
      },
    });
    mounted.dom.window.HTMLElement.prototype.getBoundingClientRect =
      function () {
        if (this.classList.contains("session-message-virtual-row")) {
          if (hidden)
            return createRect({ left: 0, top: 0, width: 0, height: 0 });
          const start = Number.parseFloat(
            this.style.top ||
              this.style.transform.match(/translate3d\(0,\s*([^p]+)px/)?.[1] ||
              this.style.transform.match(/translateY\(([^p]+)px\)/)?.[1] ||
              "0",
          );
          return createRect({
            left: 0,
            top: start - list.scrollTop,
            width: 960,
            height: this.offsetHeight,
          });
        }
        return originalRect.call(this);
      };
    Object.defineProperty(
      mounted.dom.window.HTMLElement.prototype,
      "offsetHeight",
      {
        configurable: true,
        /** 非表示の仮想行を高さゼロとし、表示中は元の高さ処理に委ねる。 */
        get() {
          return hidden &&
            this.classList.contains("session-message-virtual-row")
            ? 0
            : originalOffsetHeight.get!.call(this);
        },
      },
    );
    /** 復元処理のタイマーと後続の描画フレームが進むのを待つ。 */
    const settle = async () =>
      act(async () => {
        await new Promise((resolve) =>
          mounted.dom.window.setTimeout(resolve, 180),
        );
        for (let frame = 0; frame < 3; frame += 1)
          await new Promise((resolve) =>
            mounted.dom.window.requestAnimationFrame(resolve),
          );
      });
    assert.ok(
      list.scrollHeight > list.clientHeight + 6_000,
      "fixture has a reachable overflowing anchor",
    );
    assert.equal(
      mounted.container.querySelector(
        ".session-message-virtual-row[data-index='31']",
      ),
      null,
      "target starts outside the committed virtual range",
    );
    await mounted.rerender({
      messageKeys,
      messageJumpRequest: {
        sessionId: "session-1",
        key: "message-31",
        offset: -18,
        requestId: 1,
      },
    });
    await settle();
    /** 選ばれたアンカー行と一覧上端との相対距離を測る。 */
    const anchorOffset = () => {
      const row = mounted.container.querySelector<HTMLElement>(
        ".session-message-virtual-row[data-index='31']",
      );
      assert.ok(row, "anchor is mounted after the virtualizer jump");
      return row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    };
    assert.equal(anchorOffset(), -18);
    assert.ok(list.scrollTop <= list.scrollHeight - list.clientHeight);
    const visibleScrollHeight = list.scrollHeight;
    hidden = true;
    await mounted.rerender({
      isContentActive: false,
      artifactDetailsEnabled: false,
    });
    await settle();
    hidden = false;
    await mounted.rerender({
      isContentActive: true,
      artifactDetailsEnabled: true,
      messageKeys,
      messageJumpRequest: {
        sessionId: "session-1",
        key: "message-31",
        offset: -18,
        requestId: 2,
      },
    });
    await settle();
    assert.equal(
      anchorOffset(),
      -18,
      "re-enabling the column restores its reading position after a hidden layout",
    );
    assert.equal(list.scrollHeight, visibleScrollHeight);
    await mounted.resizeMessageRow(30, 300);
    await settle();
    assert.equal(
      anchorOffset(),
      -18,
      "late measurement must not replace the restored reading offset",
    );
    const readingScrollTop = list.scrollTop;
    await mounted.resizeMessageRow(31, 268);
    await settle();
    assert.equal(
      anchorOffset(),
      -18,
      "the partially clipped anchor row can grow without moving its top offset",
    );
    assert.equal(list.scrollTop, readingScrollTop);
    await mounted.resizeMessageRow(31, 120);
    await settle();
    assert.equal(
      anchorOffset(),
      -18,
      "the partially clipped anchor row can shrink without moving its top offset",
    );
    assert.equal(list.scrollTop, readingScrollTop);
  } finally {
    mounted.dom.window.HTMLElement.prototype.getBoundingClientRect =
      originalRect;
    Object.defineProperty(
      mounted.dom.window.HTMLElement.prototype,
      "offsetHeight",
      originalOffsetHeight,
    );
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "応答Detailsは操作ごとの失敗・exit code・error・truncationとpartial出力を一緒に表示し、古い操作の欠損を成功として表示しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Turn Summary Operations" }
// fault = "出力があるfailed操作の結果を落とすか、古い操作へ成功/exit code 0を補完する"
// observable = "artifact-operation-body内のFailed、Exit code、error alert、Output Truncated、出力previewと旧操作本文"
// observation_boundary = "component-behavior"
// scope = "message-details-individual-operation-result"
// lifecycle = "permanent"
// impact = "通常履歴の操作結果と出力完全性を誤認する"
// distinction = "projectionの値や型検査では実際のDetailsに結果が表示されることを検証できない"
// @end-test-value
/** 個別の操作結果を詳細欄で分けて表示し、新しい項目がない旧形式も扱う。 */
test("Details keeps individual operation results and legacy missing fields", () => {
  const message = createArtifactMessage();
  message.artifact!.operationTimeline = [
    {
      type: "command_execution",
      summary: "npm test",
      status: "failed",
      exitCode: 2,
      error: { message: "Command failed" },
      truncated: true,
      details: "partial stdout",
    },
    {
      type: "command_execution",
      summary: "legacy command",
      details: "saved output",
    },
  ];
  const dom = new JSDOM(
    renderSessionMessageColumn({
      messages: [message],
      expandedArtifacts: { "session-1-0": true },
    }),
  );
  const operations = dom.window.document.querySelectorAll(
    ".artifact-operation-body",
  );
  assert.match(operations[0].textContent ?? "", /Failed/);
  assert.match(operations[0].textContent ?? "", /Exit Code: 2/);
  assert.equal(
    operations[0].querySelector('[role="alert"]')?.textContent,
    "Command failed",
  );
  assert.match(operations[0].textContent ?? "", /Output Truncated/);
  assert.equal(
    operations[0].querySelector("pre")?.textContent,
    "partial stdout",
  );
  assert.equal(operations[1].textContent, "legacy commandsaved output");
  dom.window.close();
});

/** Changed Filesを出さずRun Checksを残し、操作履歴は閉じた一つのグループへまとめる。 */
test("SessionMessageColumn はChanged Filesを描画せずRun Checksを維持し、Operationsを1groupで初期closedにする", () => {
  const html = renderSessionMessageColumn({
    messages: [createOperationsArtifactMessage()],
    expandedArtifacts: { "session-1-0": true },
  });
  const dom = new JSDOM(html);
  const operationsGroup = dom.window.document.querySelector<HTMLDetailsElement>(
    ".artifact-operations-fold",
  );
  const operationFolds = Array.from(
    operationsGroup?.querySelectorAll<HTMLDetailsElement>(
      ".artifact-operation-fold",
    ) ?? [],
  );

  assert.match(html, /artifact-panel-session-1-0/);
  assert.doesNotMatch(html, /Changed Files/);
  assert.doesNotMatch(html, /src\/App\.tsx/);
  assert.doesNotMatch(html, /Open Diff/);
  assert.match(html, /snapshot files/);
  assert.ok(operationsGroup);
  assert.equal(
    operationsGroup.querySelector(".artifact-fold-summary-copy span")
      ?.textContent,
    "4 operations",
  );
  assert.equal(operationsGroup.open, false);
  assert.equal(
    operationsGroup.querySelector("summary")?.getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(operationFolds.length, 4);
  assert.deepEqual(
    operationFolds.map(
      (operation) =>
        operation.querySelector(".artifact-operation-type")?.textContent,
    ),
    ["Command", "Command", "MCP", "Command"],
  );
  assert.deepEqual(
    operationFolds.map(
      (operation) =>
        operation.querySelector(".artifact-operation-summary-text")
          ?.textContent,
    ),
    ["npm test", "npm run typecheck", "filesystem/read", "npm run build"],
  );
  for (const operation of operationFolds) {
    assert.equal(operation.open, false);
    assert.equal(
      operation.querySelector("summary")?.getAttribute("aria-expanded"),
      "false",
    );
  }
});

/** 操作履歴と個別項目をそれぞれ開閉でき、長文の詳細もグループ外には出ない。 */
test("SessionMessageColumn はOperationsと個別operationを開閉でき、長文operationをgroup内部へ保持する", async () => {
  const message = createArtifactMessage();
  message.artifact!.operationTimeline = [
    {
      type: "command_execution",
      summary: "npm test",
      details: Array.from(
        { length: 120 },
        (_, index) => `output line ${index + 1}`,
      ).join("\n"),
    },
  ];
  const mounted = await mountSessionMessageColumn({
    messages: [message],
    expandedArtifacts: { "session-1-0": true },
  });

  try {
    const operationsGroup = mounted.container.querySelector<HTMLDetailsElement>(
      ".artifact-operations-fold",
    );
    const operationGroup = mounted.container.querySelector<HTMLDetailsElement>(
      ".artifact-operation-fold",
    );
    assert.ok(operationsGroup);
    assert.ok(operationGroup);
    const operationsSummary = operationsGroup.querySelector("summary");
    const operationSummary = operationGroup.querySelector("summary");
    assert.ok(operationsSummary);
    assert.ok(operationSummary);
    assert.equal(operationsGroup.open, false);
    assert.equal(operationGroup.open, false);
    assert.equal(operationsSummary.textContent?.includes("1 operation"), true);
    assert.equal(
      operationsSummary.getAttribute("aria-controls"),
      operationsGroup.querySelector(".artifact-operations-body")?.id,
    );
    assert.equal(
      operationSummary.getAttribute("aria-controls"),
      operationGroup.querySelector(".artifact-operation-body")?.id,
    );

    await act(async () => {
      operationsGroup.open = true;
      operationsGroup.dispatchEvent(new mounted.dom.window.Event("toggle"));
    });
    assert.equal(operationsGroup.open, true);
    assert.equal(
      operationsGroup.querySelector("summary")?.getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(operationGroup.open, false);
    assert.match(
      operationsGroup.querySelector(".artifact-operations-body")?.textContent ??
        "",
      /output line 120/,
    );

    await act(async () => {
      operationGroup.open = true;
      operationGroup.dispatchEvent(new mounted.dom.window.Event("toggle"));
    });
    assert.equal(operationGroup.open, true);
    assert.equal(
      operationGroup.querySelector("summary")?.getAttribute("aria-expanded"),
      "true",
    );

    await act(async () => {
      operationGroup.open = false;
      operationGroup.dispatchEvent(new mounted.dom.window.Event("toggle"));
    });
    assert.equal(operationGroup.open, false);
    assert.equal(
      operationGroup.querySelector("summary")?.getAttribute("aria-expanded"),
      "false",
    );

    await act(async () => {
      operationsGroup.open = false;
      operationsGroup.dispatchEvent(new mounted.dom.window.Event("toggle"));
    });
    assert.equal(operationsGroup.open, false);
    assert.equal(
      operationsGroup.querySelector("summary")?.getAttribute("aria-expanded"),
      "false",
    );
  } finally {
    await mounted.cleanup();
  }
});

/** 仮想化で行が一度アンマウントされても、操作グループと個別項目の開閉状態が戻る。 */
test("SessionMessageColumn はvirtualizationでrowが再mountしてもOperationsとoperationの開閉状態を維持する", async () => {
  const messages = Array.from({ length: 30 }, (_, index) =>
    index === 0
      ? createOperationsArtifactMessage()
      : { role: "user" as const, text: `message ${index + 1}` },
  );
  const mounted = await mountSessionMessageColumn({
    messages,
    expandedArtifacts: { "session-1-0": true },
  });

  try {
    const messageList = mounted.messageListRef.current;
    assert.ok(messageList);
    await act(async () => {
      messageList.scrollTop = 0;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });

    const initialOperationsGroup =
      mounted.container.querySelector<HTMLDetailsElement>(
        ".artifact-operations-fold",
      );
    assert.ok(initialOperationsGroup);
    await act(async () => {
      initialOperationsGroup.open = true;
      initialOperationsGroup.dispatchEvent(
        new mounted.dom.window.Event("toggle"),
      );
    });
    const initialOperationGroup =
      mounted.container.querySelector<HTMLDetailsElement>(
        ".artifact-operation-fold",
      );
    assert.ok(initialOperationGroup);
    await act(async () => {
      initialOperationGroup.open = true;
      initialOperationGroup.dispatchEvent(
        new mounted.dom.window.Event("toggle"),
      );
    });
    assert.equal(initialOperationsGroup.open, true);
    assert.equal(initialOperationGroup.open, true);

    await act(async () => {
      messageList.scrollTop = messageList.scrollHeight;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });
    assert.equal(
      mounted.container.querySelector(".artifact-operations-fold"),
      null,
    );

    await act(async () => {
      messageList.scrollTop = 0;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });
    const remountedOperationsGroup =
      mounted.container.querySelector<HTMLDetailsElement>(
        ".artifact-operations-fold",
      );
    const remountedOperationGroup =
      mounted.container.querySelector<HTMLDetailsElement>(
        ".artifact-operation-fold",
      );
    assert.ok(remountedOperationsGroup);
    assert.ok(remountedOperationGroup);
    assert.equal(remountedOperationsGroup.open, true);
    assert.equal(
      remountedOperationsGroup
        .querySelector("summary")
        ?.getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(remountedOperationGroup.open, true);
    assert.equal(
      remountedOperationGroup
        .querySelector("summary")
        ?.getAttribute("aria-expanded"),
      "true",
    );
  } finally {
    await mounted.cleanup();
  }
});

/** 選択ツールバーは画面とActionDockの境界を使って上下を選び、横方向を収める。 */
test("selection action geometry は viewport と ActionDock 境界内で flip と左右 clamp を行う", () => {
  const overlayRect = createRect({ left: 0, top: 0, width: 360, height: 640 });
  const sourceRect = createRect({ left: 12, top: 80, width: 336, height: 500 });
  const actionDockRect = createRect({
    left: 12,
    top: 580,
    width: 336,
    height: 48,
  });
  const toolbarRect = { width: 112, height: 32 };

  const nearDock = resolveSelectionActionOverlayPosition({
    anchorRect: createRect({ left: 150, top: 566, width: 60, height: 12 }),
    actionDockRect,
    overlayRect,
    sourceRect,
    toolbarRect,
  });
  assert.deepEqual(nearDock, { left: 124, maxWidth: 320, top: 526 });
  assert.ok(
    (nearDock?.top as number) + toolbarRect.height < actionDockRect.top,
  );

  const leftEdge = resolveSelectionActionOverlayPosition({
    anchorRect: createRect({ left: -20, top: 120, width: 20, height: 20 }),
    actionDockRect,
    overlayRect,
    sourceRect,
    toolbarRect,
  });
  assert.equal(leftEdge?.left, 20);

  const rightEdge = resolveSelectionActionOverlayPosition({
    anchorRect: createRect({ left: 350, top: 120, width: 20, height: 20 }),
    actionDockRect,
    overlayRect,
    sourceRect,
    toolbarRect,
  });
  assert.equal(rightEdge?.left, 228);
});

/** 本文に選択範囲がない初期表示では応答アクションを描画しない。 */
test("SessionMessageColumn は未選択時に response action を描画しない", () => {
  const html = renderSessionMessageColumn({
    messages: [
      { role: "assistant", text: "assistant result" },
      { role: "user", text: "user prompt" },
    ],
    withResponseActions: true,
  });

  assert.doesNotMatch(html, /message-response-actions/);
  assert.doesNotMatch(html, />Copy</);
  assert.doesNotMatch(html, />Quote</);
  assert.match(html, /data-message-text-actions="true"/);
  assert.equal(
    (html.match(/data-message-text-actions="true"/g) ?? []).length,
    1,
  );
});

// @test-value v2
// kind = "invariant"
// claim = "本文選択がない会話操作ではselection toolbar用のviewport矩形を読まない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: UI Implementation Boundary" }
// fault = "未選択のscrollやDOM更新でもtoolbar位置のlayout計測を行う"
// observable = "message listのgetBoundingClientRect呼び出し回数"
// observation_boundary = "component-behavior"
// scope = "SessionMessageColumn selection response actions"
// lifecycle = "permanent"
// impact = "通常の会話閲覧・streaming時に不要な同期layout計測が発生する"
// distinction = "既存testはtoolbarの有無を検証するが、未選択時のgeometry readを観測しない"
// @end-test-value
/** アクションが利用可能でも未選択なら、選択やスクロールのイベントで矩形を取得しない。 */
test("SessionMessageColumn は未選択時にselection toolbarの矩形を計測しない", async () => {
  const mounted = await mountSessionMessageColumn({
    messages: [{ role: "assistant", text: "assistant result" }],
    /** コピー操作を有効にしたまま、実際のコピーなしで計測の有無を観測する。 */
    onCopyMessageText: () => {},
  });
  try {
    const messageList = mounted.messageListRef.current;
    assert.ok(messageList);
    let geometryReads = 0;
    Object.defineProperty(messageList, "getBoundingClientRect", {
      configurable: true,
      /** 一覧の境界矩形を参照した回数を数えて、それが不要な場合の検出に使う。 */
      value: () => {
        geometryReads += 1;
        return createRect({ left: 0, top: 0, width: 500, height: 500 });
      },
    });
    await act(async () => {
      mounted.dom.window.document.dispatchEvent(
        new mounted.dom.window.Event("selectionchange"),
      );
      messageList.dispatchEvent(
        new mounted.dom.window.Event("scroll", { bubbles: true }),
      );
    });
    assert.equal(geometryReads, 0);
  } finally {
    await mounted.cleanup();
  }
});

/** 保存されたassistant本文は、実行の終端状態によらず選択アクションの対象として残す。 */
test("SessionMessageColumn は保持された assistant text を run の終了状態に関係なく response action 対象にする", () => {
  const states = [
    { label: "cancel前", isRunning: true, liveRunErrorMessage: "" },
    {
      label: "cancel後",
      isRunning: false,
      liveRunErrorMessage: "キャンセルしました",
    },
    {
      label: "failed",
      isRunning: false,
      liveRunErrorMessage: "実行に失敗しました",
    },
    { label: "running", isRunning: true, liveRunErrorMessage: "" },
    { label: "通常完了", isRunning: false, liveRunErrorMessage: "" },
  ];

  for (const state of states) {
    const html = renderSessionMessageColumn({
      messages: [
        { role: "assistant", text: `${state.label}の保持済みresponse` },
      ],
      isRunning: state.isRunning,
      liveRunErrorMessage: state.liveRunErrorMessage,
      withResponseActions: true,
    });

    assert.equal(
      (html.match(/data-message-text-actions="true"/g) ?? []).length,
      1,
      `${state.label}でも保持された assistant text を操作対象にする`,
    );
  }
});

/** 確定前のpending本文も選択アクションの対象に含まれる。 */
test("SessionMessageColumn は pending response text も response action 対象にする", () => {
  const html = renderSessionMessageColumn({
    messages: [{ role: "user", text: "prompt" }],
    isRunning: true,
    pendingMessageText: "途中まで生成されたresponse",
    withResponseActions: true,
  });

  const dom = new JSDOM(html);
  const pendingBody = dom.window.document.querySelector(
    "[data-pending-message-body='true']",
  );
  assert.ok(pendingBody);
  assert.equal(pendingBody.getAttribute("data-message-body"), "true");
  assert.equal(pendingBody.getAttribute("data-message-text-actions"), "true");
});

// @test-value v2
// kind = "contract"
// claim = "選択範囲がassistant本文内にあるときresponse action toolbarを表示し、対象外本文では除去する。Source切替時は既存toolbarを除去し、Source本文を新たに選択した場合は再表示する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#rendering-policy: Source選択 / assistant responseの選択action" }
// fault = "user message選択でtoolbarが残る、Source切替後の既存toolbarが残る、Source本文の新規選択でtoolbarが再表示されない、copy/quote actionが選択本文を受け取れない"
// observable = "mounted SessionMessageColumn DOMとselectionchange・resize・scrollによるtoolbarの表示・除去、Source本文の再選択後のtoolbar、copy/quote callback"
// observation_boundary = "component-behavior"
// scope = "SessionMessageColumn selection response actions"
// lifecycle = "permanent"
// impact = "assistant response text actionの到達性と非対象messageへの誤表示を防ぐ"
// distinction = "selection eventの実DOM遷移を検証し、static markupやtypecheckではselection ownerとlifecycleを確認しない"
// @end-test-value
/** 適格な本文選択にだけツールバーを出し、コピー・引用の対象を選択文字列に限定する。 */
test("SessionMessageColumn は選択範囲にだけ response action toolbar を表示する", async () => {
  const copiedTexts: string[] = [];
  const quotedTexts: string[] = [];
  const assistantMessage =
    "assistant result text\n\n```text\nnested code text\n```";
  const mounted = await mountSessionMessageColumn({
    messages: [
      { role: "assistant", text: assistantMessage },
      { role: "user", text: "user prompt text" },
    ],
    /** クリップボードを変更せずコピー通知の文字列を捕捉する。 */
    onCopyMessageText: (text) => copiedTexts.push(text),
    /** 下書きを変更せず引用通知に渡った文字列を記録する。 */
    onQuoteMessageText: (text) => quotedTexts.push(text),
  });

  try {
    const { container, dom, messageListRef } = mounted;
    const messageList = messageListRef.current;
    assert.ok(messageList);
    Object.defineProperty(messageList, "getBoundingClientRect", {
      configurable: true,
      /** ツールバーが収まるべき会話領域を固定の矩形で表す。 */
      value: () => createRect({ left: 0, top: 0, width: 500, height: 500 }),
    });

    let selectedText = "";
    let isCollapsed = true;
    let anchorRect = createRect({ left: 100, top: 100, width: 60, height: 20 });
    let selectionNode: Node = container;
    let resolveSelectionNode: (() => Node | null) | null = null;
    const selection = {
      /** テストが選択を解除した状態かどうかを返す。 */
      get isCollapsed() {
        return isCollapsed;
      },
      /** 選択中のときだけ一つの範囲を返す形に揃える。 */
      get rangeCount() {
        return isCollapsed ? 0 : 1;
      },
      /** 選択範囲の文章上の位置と幾何情報を模擬する。 */
      getRangeAt() {
        return {
          /** 対象ノードを再描画後に取得し直せる場合はそのノードを返す。 */
          get commonAncestorContainer() {
            return resolveSelectionNode?.() ?? selectionNode;
          },
          /** 選択全体の位置としてテストが指定した矩形を返す。 */
          getBoundingClientRect: () => anchorRect,
          /** 断片矩形を取得する経路でも同じ選択位置を使う。 */
          getClientRects: () => [anchorRect],
        };
      },
      /** APIがコピーや引用に使う選択文字列を返す。 */
      toString() {
        return selectedText;
      },
    } as unknown as Selection;
    Object.defineProperty(dom.window, "getSelection", {
      configurable: true,
      /** ウィンドウ選択をテストが差し替え可能な選択オブジェクトへ接続する。 */
      value: () => selection,
    });

    /** 選択対象・文字列・位置を更新し、選択変更を本文の処理に通知する。 */
    const selectText = async (
      body: Element,
      text: string,
      rect: DOMRect,
      targetSelector?: string,
    ) => {
      const target = targetSelector
        ? body.querySelector(targetSelector)
        : (body.querySelector(".message-paragraph") ??
          body.querySelector(".message-body"));
      const textNode = target?.firstChild;
      assert.ok(textNode);
      selectionNode = textNode;
      resolveSelectionNode = targetSelector
        ? () =>
            container
              .querySelector("[data-message-text-actions='true']")
              ?.querySelector(targetSelector)?.firstChild ?? null
        : null;
      selectedText = text;
      isCollapsed = false;
      anchorRect = rect;
      await act(async () => {
        dom.window.document.dispatchEvent(
          new dom.window.Event("selectionchange"),
        );
      });
    };
    /** 選択内容を空に戻してツールバーに選択解除を通知する。 */
    const clearSelection = async () => {
      isCollapsed = true;
      selectedText = "";
      await act(async () => {
        dom.window.document.dispatchEvent(
          new dom.window.Event("selectionchange"),
        );
      });
    };

    /** 選択アクションが有効なassistant本文ノードを取得する。 */
    const getAssistantBody = () => {
      const body = container.querySelector(
        '[data-message-text-actions="true"]',
      );
      assert.ok(body);
      return body;
    };
    let assistantBody = getAssistantBody();
    await selectText(assistantBody, "  assistant result\n", anchorRect);

    let toolbar = container.querySelector(
      ".message-response-actions",
    ) as HTMLElement | null;
    assert.ok(toolbar);
    assert.ok(
      toolbar.parentElement?.classList.contains(
        "session-selection-action-overlay",
      ),
    );
    assert.equal(toolbar.style.left, "74px");
    assert.equal(toolbar.style.top, "60px");

    const copyButton = Array.from(toolbar.querySelectorAll("button")).find(
      (button) => button.textContent === "Copy",
    ) as HTMLButtonElement | undefined;
    const quoteButton = Array.from(toolbar.querySelectorAll("button")).find(
      (button) => button.textContent === "Quote",
    ) as HTMLButtonElement | undefined;
    assert.ok(copyButton);
    assert.ok(quoteButton);

    await act(async () => {
      copyButton.click();
      quoteButton.click();
    });
    assert.deepEqual(copiedTexts, ["  assistant result\n"]);
    assert.deepEqual(quotedTexts, ["  assistant result\n"]);

    const userBody = Array.from(
      container.querySelectorAll('[data-message-body="true"]'),
    ).find((body) => body.getAttribute("data-message-text-actions") !== "true");
    assert.ok(userBody);
    await selectText(
      userBody,
      "user prompt",
      createRect({ left: 120, top: 140, width: 60, height: 20 }),
    );
    assert.equal(container.querySelector(".message-response-actions"), null);

    await selectText(
      assistantBody,
      "result text",
      createRect({ left: 200, top: 220, width: 80, height: 20 }),
    );
    toolbar = container.querySelector(
      ".message-response-actions",
    ) as HTMLElement | null;
    assert.ok(toolbar);
    assert.equal(toolbar.style.left, "184px");
    assert.equal(toolbar.style.top, "180px");

    anchorRect = createRect({ left: 240, top: 260, width: 80, height: 20 });
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("resize"));
    });
    toolbar = container.querySelector(
      ".message-response-actions",
    ) as HTMLElement | null;
    assert.ok(toolbar);
    assert.equal(toolbar.style.left, "224px");
    assert.equal(toolbar.style.top, "220px");

    assistantBody = getAssistantBody();
    await selectText(
      assistantBody,
      "nested code text",
      createRect({ left: 180, top: 280, width: 80, height: 20 }),
      ".message-code-block code",
    );
    assistantBody = getAssistantBody();
    const nestedScrollOwner = assistantBody.querySelector(
      ".message-code-block",
    );
    assert.ok(nestedScrollOwner);
    anchorRect = createRect({ left: 120, top: 280, width: 80, height: 20 });
    await act(async () => {
      nestedScrollOwner.dispatchEvent(
        new dom.window.Event("scroll", { bubbles: false }),
      );
    });
    toolbar = container.querySelector(
      ".message-response-actions",
    ) as HTMLElement | null;
    assert.ok(toolbar);
    assert.equal(toolbar.style.left, "104px");
    assert.equal(toolbar.style.top, "240px");

    anchorRect = createRect({ left: 520, top: 520, width: 40, height: 20 });
    await act(async () => {
      messageList.dispatchEvent(new dom.window.Event("scroll"));
    });
    assert.equal(container.querySelector(".message-response-actions"), null);

    assistantBody = getAssistantBody();
    await selectText(
      assistantBody,
      "assistant result",
      createRect({ left: 100, top: 100, width: 60, height: 20 }),
    );
    assert.ok(container.querySelector(".message-response-actions"));
    await mounted.rerender({
      messageViewMode: "source",
      /** Sourceへ切り替えた後もコピー対象が同じ記録に入るようにする。 */
      onCopyMessageText: (text) => copiedTexts.push(text),
      /** Source本文の選択から得た引用を既存の履歴に記録する。 */
      onQuoteMessageText: (text) => quotedTexts.push(text),
    });
    assert.equal(container.querySelector(".message-response-actions"), null);
    assert.equal(
      container.querySelector("[data-message-text-actions='true']")
        ?.textContent,
      assistantMessage,
    );

    const currentAssistantBody = container.querySelector(
      "[data-message-text-actions='true']",
    );
    assert.ok(currentAssistantBody);
    await selectText(
      currentAssistantBody,
      "assistant result",
      createRect({ left: 100, top: 100, width: 60, height: 20 }),
    );
    const sourceToolbar = container.querySelector(
      ".message-response-actions",
    ) as HTMLElement | null;
    assert.ok(sourceToolbar);
    const sourceCopyButton = Array.from(
      sourceToolbar.querySelectorAll("button"),
    ).find((button) => button.textContent === "Copy") as
      HTMLButtonElement | undefined;
    const sourceQuoteButton = Array.from(
      sourceToolbar.querySelectorAll("button"),
    ).find((button) => button.textContent === "Quote") as
      HTMLButtonElement | undefined;
    assert.ok(sourceCopyButton);
    assert.ok(sourceQuoteButton);
    await act(async () => {
      sourceCopyButton.click();
      sourceQuoteButton.click();
    });
    assert.deepEqual(copiedTexts, ["  assistant result\n", "assistant result"]);
    assert.deepEqual(quotedTexts, ["  assistant result\n", "assistant result"]);
    await mounted.rerender({
      messages: [],
      /** 本文を除去するケースでもコピー操作の設定自体は有効にしておく。 */
      onCopyMessageText: (text) => copiedTexts.push(text),
      /** 本文の除去と引用通知口の設定変更が混ざらないようにする。 */
      onQuoteMessageText: (text) => quotedTexts.push(text),
      messageViewMode: "source",
    });
    await act(async () => Promise.resolve());
    assert.equal(container.querySelector(".message-response-actions"), null);
    await clearSelection();
  } finally {
    await mounted.cleanup();
  }
});

/** Auxiliaryのトランスクリプトは別欄に分けず会話一覧のグループとして描画する。 */
test("SessionMessageColumn は Auxiliary transcript group を message list 内に描画する", () => {
  const html = renderSessionMessageColumn({
    messages: [
      { role: "user", text: "aux prompt", accent: true },
      { role: "assistant", text: "aux response", accent: true },
    ],
    messageGroups: [
      { id: "aux-1", label: "Auxiliary" },
      { id: "aux-1", label: "Auxiliary" },
    ],
  });

  assert.match(html, /auxiliary-message-group-label/);
  assert.match(html, /auxiliary-message-group-item/);
  assert.match(
    html,
    /session-message-virtual-row auxiliary-message-group-continues/,
  );
  assert.match(html, />Auxiliary</);
  assert.doesNotMatch(html, />Closed</);
  assert.ok(
    html.indexOf("auxiliary-message-group-label") < html.indexOf("aux prompt"),
    "Auxiliary group label は対象 transcript の先頭 message より前に描画する",
  );
});

/** Source表示では通常行とpending行の両方に加工前のMarkdownを出す。 */
test("SessionMessageColumn の Source は通常 message と pending の元 Markdown を表示する", () => {
  const messageSource =
    "> quote\n- [label](https://example.test/path)\n- `code`";
  const pendingSource = "pending  line\n\nnext";
  const html = renderSessionMessageColumn({
    messages: [{ role: "assistant", text: messageSource }],
    isRunning: true,
    pendingMessageText: pendingSource,
    messageViewMode: "source",
  });
  const dom = new JSDOM(html);
  const sources = [
    dom.window.document.querySelector(
      "[data-message-body='true'] > .message-body",
    ),
    dom.window.document.querySelector(
      "[data-pending-message-body='true'] > .message-body",
    ),
  ];

  assert.deepEqual(
    sources.map((element) => element?.textContent),
    [messageSource, pendingSource],
  );
  assert.equal(
    dom.window.document.querySelector("[data-message-body='true'] a"),
    null,
  );
});

// @test-value v2
// kind = "contract"
// claim = "pending rowとlive approval/elicitationは既存messageの後、bottom anchorの前へ一度ずつ維持される"
// oracle = { type = "contract", ref = "src/chat/conversation/session-message-column.tsx" }
// fault = "実行中のrequest UIを既存messageの途中へ挿入するか末尾のpending/approvalを失う"
// observable = "pending row、承認groupのaccessible name、approval/elicitation custom content、既存messageとanchorのDOM順"
// observation_boundary = "component-behavior"
// scope = "session-message-live-request-tail"
// lifecycle = "permanent"
// impact = "実行中requestへの承認・入力操作が会話末尾で見つからなくなる"
// distinction = "Main transcriptの大量messageを含む末尾位置と各live requestの内容を同時に確認する"
// @end-test-value
/** 仮想ウィンドウの末尾でpendingと進行中の承認・質問への導線を維持する。 */
test("SessionMessageColumn は pending と live approval\/elicitation を message window の末尾で維持する", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(100),
    isRunning: true,
    liveApprovalRequest: createLiveApprovalRequest(),
    liveElicitationRequest: createLiveElicitationRequest(),
  });

  assert.match(html, /pending-row/);
  const approval = new JSDOM(html).window.document.querySelector(
    '[role="group"][aria-label="Approval required"]',
  );
  assert.ok(approval);
  assert.match(approval.textContent ?? "", /npm test を実行します/);
  assert.match(html, /対象ブランチを選んでね。/);
  assert.match(html, /Branch/);
  assert.ok(
    html.indexOf("message 100") < html.indexOf("pending-row"),
    "pending row は既存メッセージの後に描画する",
  );
  assert.ok(
    html.indexOf("pending-row") < html.indexOf("message-list-bottom-anchor"),
    "pending row は bottom anchor より前に描画する",
  );
});

// @test-value v2
// kind = "contract"
// claim = "承認要求はページング有無によらず受信時の本文位置付近で操作でき、後続本文より前に保たれ、解決・終了後は会話本文だけを保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#approval-requests" }
// fault = "承認が会話の外や後続本文の末尾へ流れる、本文更新で操作中のcardが置換される、別requestへ判断を送る、または解決・終了後も古い承認操作が残る"
// observable = "応答行内の本文と承認cardのDOM順、許可・拒否callbackのrequestとdecision、解決・終了後の本文と操作面"
// observation_boundary = "component-behavior"
// scope = "SessionMessageColumnのページングと未投影・投影済み応答における承認操作"
// lifecycle = "permanent"
// impact = "利用者が実行中の会話から承認を見つけられず、古い要求や別の要求へ判断する誤操作につながる"
// distinction = "既存のcard単体testでは会話内の配置を、末尾SSR testではページングと解決時の操作遷移を検出できない。既存DOM fixtureの4組合せで確認する"
// @end-test-value
/** 承認は届いた応答位置に表示され、そこで選択した判断を通知して閉じられる。 */
test("SessionMessageColumn は承認を受信時の応答位置で操作して閉じる", async () => {
  for (const paged of [false, true]) {
    for (const projected of [false, true]) {
      const decisions: Array<
        Parameters<SessionMessageColumnProps["onResolveLiveApproval"]>
      > = [];
      const explanation = "操作前の説明";
      let request: LiveApprovalRequest | null = {
        ...createLiveApprovalRequest(),
        textPosition: explanation.length,
      };
      const messages: Message[] = [{ role: "user", text: "依頼" }];
      if (projected) messages.push({ role: "assistant", text: explanation });
      /** ページングの有無と投影済み行の有無を切り替えて同じ承認経路を使う。 */
      function Column(props: SessionMessageColumnProps) {
        return React.createElement(SessionMessageColumn, {
          ...props,
          conversationPaging: paged
            ? {
                loading: false,
                error: "",
                /** ページ再試行を起こさず、ページング中の列で承認の配置を比較する。 */ onRetry() {},
              }
            : undefined,
          pendingResponseMessageKey: projected ? "response" : null,
          liveApprovalRequest: request,
          /** 選んだ承認判断を引数ごと記録し、配送内容を検査できるようにする。 */
          onResolveLiveApproval: (...args) => decisions.push(args),
        });
      }
      const mounted = await mountSessionMessageColumn({
        component: Column,
        messages,
        messageKeys: projected ? ["prompt", "response"] : ["prompt"],
        isRunning: true,
        liveRunAssistantText: explanation,
      });
      try {
        const { container, dom } = mounted;
        const card = container.querySelector<HTMLElement>(
          '[aria-label="Approval required"]',
        );
        assert.ok(card);
        assert.equal(
          container.querySelectorAll('[aria-label="Approval required"]').length,
          1,
        );
        const response = card.closest(
          ".session-message-list .message-row.assistant",
        );
        assert.ok(response, "承認はメッセージ一覧内の応答に属する");
        const body = [...response.querySelectorAll("p")].find(
          (node) => node.textContent === explanation,
        );
        assert.ok(body);
        assert.ok(
          body.compareDocumentPosition(card) &
            dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
        );
        assert.match(card.textContent ?? "", /npm test を実行します/);
        assert.match(card.textContent ?? "", /確認してね/);
        const allow = [...card.querySelectorAll("button")].find(
          (button) => button.textContent === "Allow Once",
        );
        assert.ok(allow);
        allow.focus();
        const continued = `${explanation}\n\n後続の説明`;
        await mounted.rerender({
          messages: projected
            ? [
                { role: "user", text: "依頼" },
                { role: "assistant", text: continued },
              ]
            : messages,
          liveRunAssistantText: continued,
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 120));
        });
        const following = [...response.querySelectorAll("p")].find(
          (node) => node.textContent === "後続の説明",
        );
        assert.ok(following);
        assert.ok(
          card.compareDocumentPosition(following) &
            dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
        );
        assert.equal(
          container.querySelector('[aria-label="Approval required"]'),
          card,
        );
        assert.equal(dom.window.document.activeElement, allow);
        await act(async () => allow.click());
        assert.deepEqual(decisions, [[request, "approve"]]);

        request = null;
        await mounted.rerender({});
        assert.equal(
          container.querySelector('[aria-label="Approval required"]'),
          null,
        );
        assert.match(container.textContent ?? "", /操作前の説明/);
        assert.equal(
          container.textContent?.includes("npm test を実行します"),
          false,
        );

        request = {
          ...createLiveApprovalRequest(),
          requestId: "approval-2",
          summary: "次の操作",
          textPosition: continued.length,
        };
        await mounted.rerender({});
        const reject = [
          ...container.querySelectorAll<HTMLButtonElement>(
            '[aria-label="Approval required"] button',
          ),
        ].find((button) => button.textContent === "Reject");
        assert.ok(reject);
        await act(async () => reject.click());
        assert.deepEqual(decisions.at(-1), [request, "deny"]);
        await mounted.rerender({
          isRunning: false,
          messages: [{ role: "assistant", text: explanation }],
          messageKeys: ["response"],
          liveRunAssistantText: "",
        });
        assert.equal(
          container.querySelector('[aria-label="Approval required"]'),
          null,
          "終了後はstale requestを操作面へ戻さない",
        );
        assert.match(container.textContent ?? "", /操作前の説明/);
      } finally {
        await mounted.cleanup();
      }
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "同じ承認要求を空本文へ表示した後に本文が届いても、詳細の開状態とkeyboard focusを保持して同じ要求を判断できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#approval-requestsとdocs/design/ui-design-guidelines.mdの操作位置・focus維持" }
// fault = "空本文から非空本文への遷移で承認cardが再mountされ、詳細が閉じるかfocusが外れる"
// observable = "詳細toggleとcardのDOM同一性、aria-expanded、詳細のhidden、document.activeElement、許可callbackのrequestとdecision"
// observation_boundary = "component-behavior"
// scope = "SessionMessageColumnの未投影／投影済み応答とPreview／Sourceにおける空本文からの承認操作"
// lifecycle = "permanent"
// impact = "詳細を読んでいる途中に内容と操作位置を失い、keyboardで承認判断を継続できなくなる"
// distinction = "既存の承認位置testは初めから本文があり、card単体testは本文rendererの親切替を通らない。既存DOM fixtureの4条件で状態とfocusを直接確認する"
// @end-test-value
/** 空の応答に届いた承認は、後から本文が到着しても詳細の開閉状態と操作フォーカスを失わない。 */
test("空本文への承認は本文到着後も詳細とfocusを保持する", async () => {
  for (const projected of [false, true]) {
    for (const messageViewMode of ["preview", "source"] as const) {
      const request = { ...createLiveApprovalRequest(), textPosition: 0 };
      const decisions: Array<
        Parameters<SessionMessageColumnProps["onResolveLiveApproval"]>
      > = [];
      const messages: Message[] = projected
        ? [{ role: "assistant", text: "" }]
        : [];
      /** 同じ応答キーに承認を接続し、本文到着前後で同じ列を使う。 */
      function Column(props: SessionMessageColumnProps) {
        return React.createElement(SessionMessageColumn, {
          ...props,
          pendingResponseMessageKey: projected ? "response" : null,
          liveApprovalRequest: request,
          /** 本文が到着してから操作した承認の結果を記録する。 */
          onResolveLiveApproval: (...args) => decisions.push(args),
        });
      }
      const mounted = await mountSessionMessageColumn({
        component: Column,
        messages,
        messageKeys: projected ? ["response"] : [],
        isRunning: true,
        liveRunAssistantText: "",
        messageViewMode,
      });
      try {
        const { container, dom } = mounted;
        const card = container.querySelector<HTMLElement>(
          "[aria-label='Approval required']",
        )!;
        const toggle = card.querySelector<HTMLButtonElement>(
          "[aria-label='Show approval details']",
        )!;
        await act(async () => toggle.click());
        toggle.focus();
        assert.equal(toggle.getAttribute("aria-expanded"), "true");
        const text = "Subsequent assistant text";
        await mounted.rerender({
          messages: projected ? [{ role: "assistant", text }] : messages,
          liveRunAssistantText: text,
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 120));
        });
        assert.equal(
          container.querySelector("[aria-label='Approval required']") === card,
          true,
        );
        assert.equal(
          card.querySelector("[aria-label='Hide approval details']") === toggle,
          true,
        );
        assert.equal(toggle.getAttribute("aria-expanded"), "true");
        assert.equal(
          card.querySelector<HTMLElement>(".live-approval-details")?.hidden,
          false,
        );
        assert.equal(dom.window.document.activeElement === toggle, true);
        assert.match(container.textContent ?? "", /Subsequent assistant text/);
        const allow = [
          ...card.querySelectorAll<HTMLButtonElement>("button"),
        ].find((button) => button.textContent === "Allow Once")!;
        await act(async () => allow.click());
        assert.deepEqual(decisions, [[request, "approve"]]);
      } finally {
        await mounted.cleanup();
      }
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "同一承認の詳細とfocusは、同じturnの質問の追加・更新・解決を通して保持され、質問回答と次の承認判断を継続できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#approval-requests; docs/design/ui-design-guidelines.md#操作とアクセシビリティ" }
// fault = "質問による本文分割の変化で承認が再mountされ、詳細やfocusが失われる、または質問と承認の応答先を取り違える"
// observable = "承認cardと詳細toggleのDOM同一性、aria-expanded、詳細のhidden、activeElement、質問回答と許可・拒否callback、新しい承認の初期状態"
// observation_boundary = "component-behavior"
// scope = "SessionMessageColumnの未投影／投影済み応答とPreview／Sourceにおける承認と質問の同時表示"
// lifecycle = "permanent"
// impact = "質問が届くたびに閲覧中の詳細とkeyboard操作位置を失い、承認判断の継続が妨げられる"
// distinction = "既存の空本文・本文更新testでは質問による描画ownerの分割と結合を通らない。既存DOM fixtureで同時要求の操作継続性を検証し、型検査や静的描画では分からない再mountを検出する"
// @end-test-value
/** 質問が追加・更新・解決されても、共存する承認カードの詳細とフォーカスを維持する。 */
test("質問の追加・更新・解決でも同じ承認の詳細とfocusを保持する", async () => {
  for (const projected of [false, true]) {
    for (const messageViewMode of ["preview", "source"] as const) {
      const text = "Before approval\n\nAfter approval";
      let approval: LiveApprovalRequest | null = {
        ...createLiveApprovalRequest(),
        textPosition: "Before approval".length,
      };
      const question: LiveElicitationRequest = {
        ...createLiveElicitationRequest(),
        kind: "question",
      };
      let questions: LiveElicitationRequest[] = [];
      let records: ElicitationRecord[] = [];
      const decisions: Array<
        Parameters<SessionMessageColumnProps["onResolveLiveApproval"]>
      > = [];
      const answers: Array<
        Parameters<SessionMessageColumnProps["onResolveLiveElicitation"]>
      > = [];
      /** 同じ応答に承認と変化する質問を渡して互いの表示状態を比較する。 */
      function Column(props: SessionMessageColumnProps) {
        return React.createElement(SessionMessageColumn, {
          ...props,
          pendingResponseMessageKey: projected ? "response" : null,
          liveApprovalRequest: approval,
          liveElicitationRequests: questions,
          liveElicitationRecords: records,
          /** 質問と混線していないか調べるため、承認操作の引数を別に採取する。 */
          onResolveLiveApproval: (...args) => decisions.push(args),
          /** 質問への回答を承認の判断とは別の履歴へ記録する。 */
          onResolveLiveElicitation: (...args) => answers.push(args),
        });
      }
      const mounted = await mountSessionMessageColumn({
        component: Column,
        messages: projected ? [{ role: "assistant", text }] : [],
        messageKeys: projected ? ["response"] : [],
        isRunning: true,
        liveRunAssistantText: text,
        messageViewMode,
      });
      try {
        const { container, dom } = mounted;
        const card = container.querySelector<HTMLElement>(
          "[aria-label='Approval required']",
        )!;
        const toggle = card.querySelector<HTMLButtonElement>(
          "[aria-label='Show approval details']",
        )!;
        await act(async () => toggle.click());
        toggle.focus();
        /** 再描画後も同じ承認カードと詳細ボタンが残り、展開状態とフォーカスも続くことを確認する。 */
        const expectContinuity = async () => {
          await mounted.rerender({});
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 120));
          });
          assert.equal(
            container.querySelector("[aria-label='Approval required']") ===
              card,
            true,
          );
          assert.equal(
            card.querySelector("[aria-label='Hide approval details']") ===
              toggle,
            true,
          );
          assert.equal(toggle.getAttribute("aria-expanded"), "true");
          assert.equal(
            card.querySelector<HTMLElement>(".live-approval-details")?.hidden,
            false,
          );
          assert.equal(dom.window.document.activeElement === toggle, true);
        };
        questions = [question];
        records = [
          {
            requestId: question.requestId,
            kind: "question",
            message: question.message,
            fields: [{ title: "Branch" }],
            textRange: { start: text.length, end: text.length },
            status: "pending",
          },
        ];
        await expectContinuity();
        assert.equal(
          container.querySelectorAll(".live-elicitation-card").length,
          1,
        );
        records = [
          {
            ...records[0],
            textRange: { start: 0, end: "Before approval".length },
          },
        ];
        await expectContinuity();
        const submit = [
          ...container.querySelectorAll<HTMLButtonElement>(
            ".live-elicitation-card button",
          ),
        ].find((button) => button.textContent === "Submit")!;
        await act(async () => submit.click());
        assert.equal(answers.length, 1);
        assert.equal(answers[0][0], question);
        assert.equal(answers[0][1].action, "accept");
        questions = [];
        records = [{ ...records[0], status: "answered" }];
        await expectContinuity();
        assert.equal(
          container.querySelectorAll(".live-elicitation-card").length,
          0,
        );
        assert.match(
          container.querySelector(".elicitation-record")?.textContent ?? "",
          /Branch/,
        );
        const allow = [
          ...card.querySelectorAll<HTMLButtonElement>("button"),
        ].find((button) => button.textContent === "Allow Once")!;
        await act(async () => allow.click());
        assert.deepEqual(decisions, [[approval, "approve"]]);
        approval = null;
        await mounted.rerender({});
        assert.equal(
          container.querySelector("[aria-label='Approval required']"),
          null,
        );
        approval = {
          ...createLiveApprovalRequest(),
          requestId: "approval-2",
          textPosition: text.length,
        };
        await mounted.rerender({});
        const next = container.querySelector<HTMLElement>(
          "[aria-label='Approval required']",
        )!;
        assert.equal(next === card, false);
        assert.equal(
          next.querySelector("[aria-expanded]")?.getAttribute("aria-expanded"),
          "false",
        );
        const reject = [
          ...next.querySelectorAll<HTMLButtonElement>("button"),
        ].find((button) => button.textContent === "Reject")!;
        await act(async () => reject.click());
        assert.deepEqual(decisions.at(-1), [approval, "deny"]);
      } finally {
        await mounted.cleanup();
      }
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "承認はMarkdownのblockを分断せず受信位置付近へ入り、参照linkと後続本文を保ち、Sourceや縮小済み応答でも操作できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#approval-requests" }
// fault = "code fence途中へcardを挿入して本文を壊す、参照定義との分割でlinkを失う、またはSourceやcollapseで承認を隠す"
// observable = "code block・link・承認card・後続段落のDOM順序、元source本文と承認control"
// observation_boundary = "component-behavior"
// scope = "SessionMessageColumnから実Markdown rendererへの承認挿入"
// lifecycle = "permanent"
// impact = "実行内容の説明を読めなくなるか、承認待ちを解消できなくなる"
// distinction = "本文とcardの平文順序testではMarkdown構造・参照解決・表示切替を検証できない。短い1応答のPreviewとSourceで確認する"
// @end-test-value
/** 承認はMarkdownブロックの途中を壊さない位置に挿入され、Sourceでも縮小済みの応答でも操作できる。 */
test("承認はMarkdownのblock境界へ入りSourceと縮小済み応答でも操作できる", async () => {
  const text =
    "事前説明\n\n```ts\nconst answer = 42;\n```\n\n[後続link][target]\n\n[target]: https://example.com";
  const position = text.indexOf("answer");
  const messages: Message[] = [{ role: "assistant", text }];
  const mounted = await mountSessionMessageColumn({
    /** 同じ応答キーで、承認の本文内位置を明示して描画する。 */
    component: (props: SessionMessageColumnProps) =>
      React.createElement(SessionMessageColumn, {
        ...props,
        liveApprovalRequest: {
          ...createLiveApprovalRequest(),
          textPosition: position,
        },
        pendingResponseMessageKey: "response",
      }),
    messages,
    messageKeys: ["response"],
    isRunning: true,
    liveRunAssistantText: text,
    messageCollapseTargets: buildMessageCollapseTargets(
      messages,
      [{ kind: "session", messageIndex: 0 }],
      ["response"],
    ),
    collapsedMessageKeys: new Set(["response"]),
  });
  try {
    const { container, dom } = mounted;
    const code = container.querySelector(".message-code-block code");
    const card = container.querySelector('[aria-label="Approval required"]');
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href="https://example.com"]',
    );
    assert.ok(code && card && link);
    assert.equal(code.textContent?.trim(), "const answer = 42;");
    assert.ok(
      code.compareDocumentPosition(card) &
        dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    assert.ok(
      card.compareDocumentPosition(link) &
        dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    assert.equal(container.querySelector(".message-collapsed-preview"), null);
    await mounted.rerender({ messageViewMode: "source" });
    const source = [...container.querySelectorAll(".message-source-text")];
    assert.equal(source.map((node) => node.textContent).join(""), text);
    const sourceCard = container.querySelector(
      '[aria-label="Approval required"]',
    );
    assert.ok(sourceCard);
    assert.ok(
      source[0].compareDocumentPosition(sourceCard) &
        dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    assert.ok(
      sourceCard.compareDocumentPosition(source[1]) &
        dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const decisions = [
      ...sourceCard.querySelectorAll<HTMLButtonElement>("button"),
    ].filter(
      (button) =>
        button.textContent === "Allow Once" || button.textContent === "Reject",
    );
    assert.deepEqual(
      decisions.map((button) => button.textContent),
      ["Allow Once", "Reject"],
    );
    assert.ok(decisions.every((button) => !button.disabled));
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "投影済みの実行中assistant本文と処理中bubbleを同じレスポンス枠に表示する"
// oracle = { type = "contract", ref = "Issue #742: 完了条件; docs/design/desktop-ui.md: pending中のlive activity / streaming response" }
// fault = "streaming本文と処理中bubbleが別のassistant行に分かれ、avatarと本文を重複して見せる"
// observable = "assistant本文を持つmessage row内の処理中bubble、avatar、本文の出現回数"
// observation_boundary = "component-behavior"
// scope = "session-message-streaming-response"
// lifecycle = "permanent"
// impact = "返答と処理状態の所属が分からず、別の応答が始まったように誤認する"
// distinction = "内容未到着の応答枠を確認するtestと異なり、本文投影後の同一枠を確認する"
// @end-test-value
/** 投影済みの実行中本文を再利用しながら、末尾の処理中バブルは別に表示する。 */
test("SessionMessageColumn は projection 済みの実行中 assistant text と末尾の処理中bubbleを表示する", () => {
  const liveAssistant = {
    sessionId: "session-1",
    threadId: "thread-1",
    messageIndex: 100,
    text: "ストリーミング中の返答",
  };
  const projection = buildMessageListProjection(
    createMessages(100),
    [],
    "session-1",
    { liveAssistant },
  );
  const html = renderSessionMessageColumn({
    messages: projection.messages,
    messageKeys: projection.keys,
    pendingResponseMessageKey: buildLiveAssistantProjectionKey(
      liveAssistant.sessionId,
      liveAssistant.threadId,
      liveAssistant.messageIndex,
    ),
    isRunning: true,
    liveRunAssistantText: "ストリーミング中の返答",
  });

  const document = new JSDOM(html).window.document;
  const responseBody = [
    ...document.querySelectorAll("[data-message-body='true']"),
  ].find((body) => body.textContent?.includes("ストリーミング中の返答"));
  const responseRow = responseBody?.closest(".message-row.assistant");
  assert.ok(responseRow);
  assert.equal(responseRow.querySelectorAll(".message-avatar").length, 1);
  assert.equal(
    responseRow.querySelectorAll(".pending-run-indicator").length,
    1,
  );
  assert.equal(document.querySelectorAll(".pending-row").length, 0);
  assert.equal((html.match(/ストリーミング中の返答/g) ?? []).length, 1);
  assert.ok(
    html.indexOf("message 100") < html.indexOf("ストリーミング中の返答"),
    "projection 済みの live assistant text は既存メッセージの後に描画する",
  );
  assert.ok(
    html.indexOf("ストリーミング中の返答") <
      html.indexOf("message-list-bottom-anchor"),
    "projection 済みの live assistant text は bottom anchor より前に描画する",
  );
  assert.ok(
    html.indexOf("ストリーミング中の返答") <
      html.indexOf("pending-run-indicator"),
  );
  assert.ok(
    html.indexOf("pending-run-indicator") <
      html.indexOf("message-list-bottom-anchor"),
  );
});

// @test-value v2
// kind = "contract"
// claim = "MainまたはAuxiliaryの応答は本文未到着・streaming・保存済み本文との不一致でも一つの応答枠に処理中表示を保ち、終了後と次のrunでは前の応答を処理中にしない"
// oracle = { type = "contract", ref = "Issue #742: 完了条件" }
// fault = "保存済み本文がlive本文と異なると別のpending行へ戻るか、run終了後もindicatorや重複本文が残るか、次のrunで前の応答へindicatorが付く"
// observable = "ConversationMessageColumnの投影を通した各状態の応答枠内indicator数、avatar数、本文と独立pending行の数"
// observation_boundary = "component-behavior"
// scope = "session-message-streaming-terminal-transition"
// lifecycle = "permanent"
// impact = "利用者が応答終了を判断できず、同じ返答を別のメッセージと誤認する"
// distinction = "同じmounted conversationで実投影とbridge保持を通す小規模な状態遷移検証。型検査や単体projection検証ではDOM内の所属・重複を検出できない。provider別の終端通知生成は対象外"
// @end-test-value
/** ライブと保存本文が一時的に一致しなくても、各実行終端まで応答枠を入れ替えない。 */
test("ConversationMessageColumn は本文不一致を含む応答遷移から各終端まで同じ応答枠を維持する", async () => {
  for (const messageSourceKind of ["session", "auxiliary"] as const) {
    for (const { terminal, text: finalText } of [
      { terminal: "completed", text: "完了した返答" },
      { terminal: "failed", text: "途中までの返答" },
      { terminal: "canceled", text: "途中までの返答" },
    ]) {
      /** 現在の実行情報と履歴を会話列へ渡し、遷移ごとの応答枠を観測する。 */
      function Column(props: SessionMessageColumnProps) {
        return React.createElement(ConversationMessageColumn, {
          session: {
            id: messageSourceKind,
            messages: props.messages,
            runState: props.isRunning ? "running" : terminal,
          },
          messageSourceKind,
          baseProps: props,
          enabled: true,
        });
      }
      const userMessage: Message = { role: "user", text: "依頼" };
      const mounted = await mountSessionMessageColumn({
        component: Column,
        messages: [userMessage],
        isRunning: true,
        liveRunAssistantText: "",
      });
      try {
        assert.equal(
          mounted.container.querySelectorAll(".pending-run-indicator").length,
          1,
          terminal,
        );
        assert.equal(
          mounted.container.querySelectorAll(".pending-row .message-avatar")
            .length,
          1,
        );
        await mounted.rerender({
          messages: [userMessage],
          isRunning: true,
          liveRunAssistantText: "streaming response",
        });
        assert.equal(
          mounted.container.querySelectorAll(".message-row.assistant").length,
          1,
        );
        assert.equal(
          mounted.container.querySelectorAll(".pending-row").length,
          0,
        );
        for (const liveRunAssistantText of ["streaming response", ""]) {
          await mounted.rerender({
            messages: [userMessage, { role: "assistant", text: finalText }],
            isRunning: true,
            liveRunAssistantText,
          });
          const response = mounted.container.querySelector(
            ".message-row.assistant:not(.pending-row)",
          );
          assert.ok(response);
          assert.equal(
            response.querySelectorAll(".pending-run-indicator").length,
            1,
            `${messageSourceKind}/${terminal}/${liveRunAssistantText}`,
          );
          assert.equal(
            mounted.container.querySelectorAll(".pending-run-indicator").length,
            1,
          );
          assert.equal(
            mounted.container.querySelectorAll(".pending-row").length,
            0,
          );
          assert.equal(
            mounted.container.querySelectorAll(
              ".message-row.assistant .message-avatar",
            ).length,
            1,
          );
          assert.equal(
            mounted.container.querySelectorAll(
              ".message-row.assistant [data-message-body='true']",
            )[0]?.textContent,
            finalText,
          );
        }
        await mounted.rerender({
          messages: [userMessage, { role: "assistant", text: finalText }],
          isRunning: false,
          liveRunAssistantText: "",
        });
        assert.equal(
          mounted.container.querySelectorAll(".pending-run-indicator").length,
          0,
          terminal,
        );
        assert.equal(
          mounted.container.querySelectorAll(".pending-row").length,
          0,
          terminal,
        );
        assert.equal(
          mounted.container.querySelectorAll(".message-row.assistant").length,
          1,
          terminal,
        );
        assert.equal(
          (
            mounted.container.textContent?.match(new RegExp(finalText, "g")) ??
            []
          ).length,
          1,
          terminal,
        );
        await mounted.rerender({
          messages: [
            userMessage,
            { role: "assistant", text: finalText },
            { role: "user", text: "次の依頼" },
          ],
          isRunning: true,
          liveRunAssistantText: "",
        });
        assert.equal(
          mounted.container.querySelectorAll(
            ".pending-row .pending-run-indicator",
          ).length,
          1,
        );
        assert.equal(
          mounted.container.querySelectorAll(
            ".message-row.assistant:not(.pending-row) .pending-run-indicator",
          ).length,
          0,
        );
        assert.equal(
          (
            mounted.container.textContent?.match(new RegExp(finalText, "g")) ??
            []
          ).length,
          1,
        );
      } finally {
        await mounted.cleanup();
      }
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "実行開始直後から内容未到着でも会話末尾に処理中bubbleとaccessible statusを表示する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: pending中のlive activity / streaming response" }
// fault = "最初のassistant本文やrequestが到着するまで実行状態の行が表示されない"
// observable = "最後のmessage、pending indicator、bottom anchorのDOM順とstatus announcement"
// observation_boundary = "component-behavior"
// scope = "session-message-empty-running-tail"
// lifecycle = "permanent"
// impact = "送信直後に処理が開始されたか分からず、応答待ちの状態を見失う"
// distinction = "本文やrequestを持つ応答枠のtestと異なり、run開始直後の空状態を確認する"
// @end-test-value
/** 実行開始時にまだ本文が届いていなくても、処理中であることを末尾のバブルで示す。 */
test("SessionMessageColumn は内容未到着でも末尾に処理中bubbleを描画する", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(1),
    isRunning: true,
    pendingRunIndicatorAnnouncement: "Preparing a response",
  });

  assert.match(html, /pending-message-card/);
  assert.match(html, /typing-dots pending-run-indicator-dots/);
  assert.match(html, /role="status"[^>]*>Preparing a response<\/span>/);
  assert.equal(
    new JSDOM(html).window.document.querySelectorAll(
      ".pending-row .message-avatar",
    ).length,
    1,
  );
  assert.ok(html.indexOf("message 1") < html.indexOf("pending-row"));
  assert.ok(
    html.indexOf("pending-row") < html.indexOf("message-list-bottom-anchor"),
  );
});

// @test-value v2
// kind = "contract"
// claim = "MainとAuxiliaryの実行中応答内のelicitationは、履歴スクロール後も同一requestの未送信回答を保持して送信し、新しいrequestには持ち越さない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: pending中のlive activity / streaming response" }
// fault = "仮想化で入力formが再mountされて選択が初期値へ戻り、意図しない回答を送信するか、request終了後も応答行を保持し続ける"
// observable = "実projectionを通した履歴の往復scroll後のselect値と送信payload、次requestの初期値、request終了後の仮想rowの解放"
// observation_boundary = "component-behavior"
// scope = "conversation-elicitation-virtualization"
// lifecycle = "permanent"
// impact = "過去の会話を参照しただけで入力が失われ、別のブランチへの操作など誤った回答につながる"
// distinction = "既存のpending配置testは入力状態と仮想範囲の往復を扱わない。2種類の会話で実DOM操作と送信結果を検証し、全履歴の常時mountによる代替も検出する"
// @end-test-value
/** 仮想スクロールで入力中の質問を画面外へ出しても、送っていない回答を失わない。 */
test("ConversationMessageColumn は履歴スクロールを挟んでも elicitation の未送信回答を保持する", async () => {
  for (const messageSourceKind of ["session", "auxiliary"] as const) {
    /** MainとAuxiliary双方を実ConversationMessageColumnへ接続し、同じスクロール操作を比較する。 */
    function Column(props: SessionMessageColumnProps) {
      return React.createElement(ConversationMessageColumn, {
        session: {
          id: messageSourceKind,
          messages: props.messages,
          runState: "running",
        },
        messageSourceKind,
        baseProps: props,
        enabled: true,
      });
    }
    const request: LiveElicitationRequest = {
      ...createLiveElicitationRequest(),
      fields: [
        {
          type: "select",
          name: "branch",
          title: "Branch",
          required: true,
          defaultValue: "main",
          options: [
            { value: "main", label: "main" },
            { value: "feature/review-draft", label: "feature/review-draft" },
          ],
        },
      ],
    };
    const responses: Array<
      Parameters<SessionMessageColumnProps["onResolveLiveElicitation"]>
    > = [];
    const mounted = await mountSessionMessageColumn({
      component: Column,
      messages: createMessages(100),
      isRunning: true,
      liveRunAssistantText: "対象ブランチの確認が必要です。",
      liveElicitationRequest: request,
      /** 再表示後に選択・送信された回答と対象要求を記録する。 */
      onResolveLiveElicitation: (...args) => responses.push(args),
    });
    try {
      const { container, dom } = mounted;
      const messageList = container.querySelector<HTMLDivElement>(
        ".session-message-list",
      );
      assert.ok(messageList);
      /** ホイールとスクロールを発火し、対象行が仮想範囲から出入りできるようにする。 */
      const scrollTo = async (top: number) => {
        await act(async () => {
          messageList.dispatchEvent(
            new dom.window.WheelEvent("wheel", {
              deltaY: top - messageList.scrollTop,
              bubbles: true,
            }),
          );
          messageList.scrollTop = top;
          messageList.dispatchEvent(
            new dom.window.Event("scroll", { bubbles: true }),
          );
        });
      };
      /** 再マウントされた質問から現在の選択欄を取得する。 */
      const getSelect = () => {
        const select = container.querySelector<HTMLSelectElement>(
          ".message-row.assistant .live-elicitation-card select",
        );
        assert.ok(select, messageSourceKind);
        return select;
      };
      const select = getSelect();
      assert.equal(select.value, "main");
      await act(async () => {
        select.value = "feature/review-draft";
        select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
      await scrollTo(0);
      assert.ok(
        container.querySelector('.session-message-virtual-row[data-index="0"]'),
      );
      assert.ok(
        container.querySelectorAll(".session-message-virtual-row").length < 30,
        "履歴全体を常時mountしない",
      );
      await scrollTo(messageList.scrollHeight - messageList.clientHeight);
      assert.equal(
        getSelect().value,
        "feature/review-draft",
        messageSourceKind,
      );
      assert.equal(
        container.querySelectorAll(".live-elicitation-card").length,
        1,
      );
      assert.equal(container.querySelectorAll(".pending-row").length, 0);
      const submit = [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".live-elicitation-card button",
        ),
      ].find((button) => button.textContent === "Submit");
      assert.ok(submit);
      await act(async () => submit.click());
      assert.deepEqual(responses, [
        [
          request,
          { action: "accept", content: { branch: "feature/review-draft" } },
        ],
      ]);

      await mounted.rerender({
        liveElicitationRequest: { ...request, requestId: "elicitation-2" },
      });
      assert.equal(
        getSelect().value,
        "main",
        "異なるrequestには回答を持ち越さない",
      );
      await scrollTo(0);
      await mounted.rerender({ liveElicitationRequest: null });
      assert.equal(
        container.querySelectorAll(".live-elicitation-card").length,
        0,
      );
      assert.equal(
        container.querySelector(
          '.session-message-virtual-row[data-index="100"]',
        ),
        null,
        "入力待ちが終われば通常の仮想化へ戻す",
      );
    } finally {
      await mounted.cleanup();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "質問の会話pageを離れて戻っても同じrequestの未送信回答を保持し、質問は元の会話位置で送信できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Elicitationの入力待ち" }
// fault = "最新pageから過去pageへ移動した際に未送信回答を初期値へ戻す"
// observable = "過去pageでのフォーム非表示と最新pageへ戻ったDOM内select値、Submit応答payload"
// observation_boundary = "component-behavior"
// scope = "conversation-paging-elicitation"
// lifecycle = "permanent"
// impact = "履歴を参照しただけで操作対象の回答が初期化される誤送信を防ぐ"
// distinction = "既存scroll testはmessagesのpage交換とpending rowの消滅を通らない"
// @end-test-value
/** 表示する履歴ページを入れ替えても、入力待ち質問の回答を保持する。 */
test("SessionMessageColumn はpage交換でも入力待ち回答を保持する", async () => {
  const request: LiveElicitationRequest = {
    ...createLiveElicitationRequest(),
    fields: [
      {
        type: "select",
        name: "branch",
        title: "Branch",
        required: true,
        defaultValue: "main",
        options: [
          { value: "main", label: "main" },
          { value: "feature", label: "feature" },
        ],
      },
    ],
  };
  const responses: Array<
    Parameters<SessionMessageColumnProps["onResolveLiveElicitation"]>
  > = [];
  const paging = {
    loading: false,
    error: "",
    /** ページ交換後も再試行の副作用なしでページング可能な列を用意する。 */ onRetry() {},
  };
  /** 同じページング状態を会話列へ渡して、履歴だけを交換できるようにする。 */
  function Column(props: SessionMessageColumnProps) {
    return React.createElement(SessionMessageColumn, {
      ...props,
      conversationPaging: paging,
    });
  }
  const mounted = await mountSessionMessageColumn({
    component: Column,
    messages: createMessages(60),
    isRunning: true,
    liveElicitationRequest: request,
    /** ページをまたいで保持された回答を引数ごと記録する。 */
    onResolveLiveElicitation: (...args) => responses.push(args),
  });
  try {
    const select = mounted.container.querySelector<HTMLSelectElement>(
      ".live-elicitation-card select",
    );
    assert.ok(select);
    await act(async () => {
      select.value = "feature";
      select.dispatchEvent(
        new mounted.dom.window.Event("change", { bubbles: true }),
      );
    });
    await mounted.rerender({
      messages: createMessages(60).map((message) => ({
        ...message,
        text: `Earlier ${message.text}`,
      })),
      isRunning: false,
    });
    assert.equal(
      mounted.container.querySelector(".live-elicitation-card"),
      null,
      "過去pageの先頭へ質問を移動しない",
    );
    await mounted.rerender({ messages: createMessages(60), isRunning: true });
    const after = mounted.container.querySelector<HTMLSelectElement>(
      ".live-elicitation-card select",
    );
    assert.ok(after);
    assert.equal(after.value, "feature");
    const submit = [
      ...mounted.container.querySelectorAll<HTMLButtonElement>(
        ".live-elicitation-card button",
      ),
    ].find((button) => button.textContent === "Submit");
    assert.ok(submit);
    await act(async () => submit.click());
    assert.deepEqual(responses, [
      [request, { action: "accept", content: { branch: "feature" } }],
    ]);
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "canonical会話のelicitation送信中は履歴の往復でも実行buttonのspinnerを保持し、失敗後は同じ要求の操作へ戻る"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#ボタン; docs/design/desktop-ui.md: Elicitationの入力待ち" }
// fault = "表示面の再描画で実行actionを失う、非実行buttonもspinnerになる、または送信失敗後にbusyが残る"
// observable = "resolve APIのpayload、履歴scroll前後のspinner所属とdisabled、失敗後の操作可能性とerror"
// observation_boundary = "consumer"
// scope = "canonical-elicitation-action-feedback"
// lifecycle = "permanent"
// impact = "回答受付の完了を誤認した再操作や、失敗後に再送できない状態を防ぐ"
// distinction = "request propsだけのcomponent testではconversationのaction保持と非同期失敗からの復帰を通らない。実hookと仮想化された表示を小さいfixtureで接続する"
// @end-test-value
/** 質問を送信して応答待ちの間は履歴を往復しても待機表示が続き、失敗した時点で解除される。 */
test("ConversationMessageColumn は送信actionの待機表示を履歴往復と失敗まで維持する", async () => {
  const request = { ...createLiveElicitationRequest(), fields: [] };
  let rejectResponse!: (error: Error) => void;
  const responses: Array<
    Parameters<SessionMessageColumnProps["onResolveLiveElicitation"]>
  > = [];
  const api = {
    /** 質問の対象と送信内容を記録し、送信失敗を後から発生させられるよう待機する。 */
    resolveLiveElicitation: async (
      ...args: [
        string,
        string,
        Parameters<SessionMessageColumnProps["onResolveLiveElicitation"]>[1],
      ]
    ) => {
      assert.equal(args[0], "session-feedback");
      assert.equal(args[1], request.requestId);
      responses.push([request, args[2]]);
      await new Promise<void>((_resolve, reject) => {
        rejectResponse = reject;
      });
    },
  };
  /** 実会話列を遅延する回答APIと実行中リクエストへ接続する。 */
  function Column(props: SessionMessageColumnProps) {
    return React.createElement(ConversationMessageColumn, {
      session: {
        id: "session-feedback",
        messages: props.messages,
        runState: "running",
      },
      baseProps: props,
      enabled: true,
      api,
      liveRun: {
        sessionId: "session-feedback",
        threadId: "thread-feedback",
        assistantText: "Review the requested input.",
        steps: [],
        backgroundTasks: [],
        usage: null,
        errorMessage: "",
        approvalRequest: null,
        elicitationRequest: request,
      },
    });
  }
  const mounted = await mountSessionMessageColumn({
    component: Column,
    messages: createMessages(100),
    isRunning: true,
    liveRunAssistantText: "Review the requested input.",
    liveElicitationRequest: request,
  });
  try {
    const { container, dom } = mounted;
    const list = container.querySelector<HTMLDivElement>(
      ".session-message-list",
    )!;
    /** 履歴を往復してDOMが変わった後も、現在描画されている回答操作を読み直す。 */
    const controls = () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          ".live-elicitation-card button",
        ),
      );
    await act(async () =>
      controls()
        .find((button) => button.textContent === "Submit")!
        .click(),
    );
    assert.deepEqual(responses, [[request, { action: "accept" }]]);
    for (const top of [0, list.scrollHeight - list.clientHeight]) {
      await act(async () => {
        list.dispatchEvent(
          new dom.window.WheelEvent("wheel", {
            deltaY: top - list.scrollTop,
            bubbles: true,
          }),
        );
        list.scrollTop = top;
        list.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
      });
    }
    const submit = controls().find(
      (button) => button.textContent === "Submit",
    )!;
    assert.ok(submit.querySelector(".button-content-spinner"));
    assert.equal(submit.getAttribute("aria-busy"), "true");
    assert.equal(
      container.querySelectorAll(
        ".live-elicitation-card .button-content-spinner",
      ).length,
      1,
    );
    assert.ok(controls().every((button) => button.disabled));
    await act(async () =>
      rejectResponse(new Error("Response was not accepted.")),
    );
    assert.ok(controls().every((button) => !button.disabled));
    assert.equal(
      container.querySelectorAll(
        ".live-elicitation-card .button-content-spinner",
      ).length,
      0,
    );
    assert.match(container.textContent ?? "", /Response was not accepted\./);
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "MainとAuxiliaryの実会話投影で質問を該当位置へ一度だけ表示し、回答後と保存履歴で元本文と構造化候補を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#question-forms" }
// fault = "共通質問componentへの配線漏れにより末尾へ重複表示するか、後続本文や解決済みの質問を失う"
// observable = "実ConversationMessageColumnの質問前後のDOM順序、フォーム数、解決後および保存履歴の本文・候補"
// observation_boundary = "component-behavior"
// scope = "Main/Auxiliary inline question integration"
// lifecycle = "permanent"
// impact = "会話中の質問位置と文脈が変わり、質問に回答できない"
// distinction = "InlineResponseContent単体の描画はconversationのowner判定とlive recordの受け渡しを通らない"
// @end-test-value
/** MainとAuxiliaryの本文で質問範囲を対応付け、回答後は質問を含む本文表示へ戻す。 */
test("Main/Auxiliaryの会話へ質問範囲を接続し回答後に本文へ戻す", async () => {
  for (const messageSourceKind of ["session", "auxiliary"] as const) {
    const request: LiveElicitationRequest = {
      ...createLiveElicitationRequest(),
      kind: "question",
      fields: [
        {
          type: "select",
          name: "branch",
          title: "Which branch?",
          required: true,
          allowFreeText: true,
          options: [
            { label: "Main", value: "Main" },
            { label: "Feature", value: "Feature" },
          ],
        },
      ],
    };
    const record: ElicitationRecord = {
      requestId: request.requestId,
      kind: "question",
      message: "Question",
      fields: [{ title: "Which branch?", options: ["Main", "Feature"] }],
      textRange: { start: 8, end: 21 },
      status: "answered",
    };
    /** 実行中は質問記録を回答の有無に応じて切り替え、終端後はライブ記録を外す。 */
    function Column(props: SessionMessageColumnProps) {
      return React.createElement(ConversationMessageColumn, {
        session: {
          id: messageSourceKind,
          messages: props.messages,
          runState: "running",
        },
        messageSourceKind,
        enabled: true,
        baseProps: {
          ...props,
          liveElicitationRecords: props.isRunning
            ? [
                {
                  ...record,
                  status: props.liveElicitationRequest ? "pending" : "answered",
                },
              ]
            : [],
        },
      });
    }
    const mounted = await mountSessionMessageColumn({
      component: Column,
      messages: [{ role: "user", text: "Start" }],
      isRunning: true,
      liveRunAssistantText: "Before\n\nWhich branch?\n\nAfter",
      liveElicitationRequest: request,
    });
    try {
      const body = mounted.container.querySelector(
        ".message-row.assistant [data-message-body]",
      );
      assert.ok(body);
      assert.deepEqual(
        [...body.children].map((node) => node.textContent?.trim()),
        ["Before", "Which branch?MainFeatureCloseSubmit", "After"],
      );
      assert.equal(
        mounted.container.querySelectorAll(".live-elicitation-card").length,
        1,
      );
      await mounted.rerender({ liveElicitationRequest: null });
      const resolvedBody = mounted.container.querySelector(
        ".message-row.assistant [data-message-body]",
      );
      assert.ok(resolvedBody);
      assert.equal(resolvedBody.querySelectorAll("input,button").length, 0);
      assert.match(
        resolvedBody.textContent ?? "",
        /Before\s*Which branch\?\s*MainFeature\s*After/,
      );
      await mounted.rerender({
        isRunning: false,
        liveRunAssistantText: "",
        liveElicitationRequest: null,
        messages: [
          {
            role: "assistant",
            text: "Before\n\nWhich branch?\n\nAfter",
            elicitationRecords: [record],
          },
        ],
      });
      const history = mounted.container.querySelector(
        ".message-row.assistant [data-message-body]",
      );
      assert.ok(history);
      assert.match(
        history.textContent ?? "",
        /Before\s*Which branch\?\s*MainFeature\s*After/,
      );
      assert.equal(history.textContent?.split("Which branch?").length, 2);
      assert.deepEqual(
        [...history.querySelectorAll(".elicitation-record-options li")].map(
          (node) => node.textContent,
        ),
        ["Main", "Feature"],
      );
      assert.equal(
        history.querySelectorAll("input,button,select,textarea").length,
        0,
      );
    } finally {
      await mounted.cleanup();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "質問内に表示できる受付済み回答だけを重複する入力行から隠し未確認や未取得の入力は維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#question-forms" }
// fault = "質問内に回答がないまま元の入力を隠す、または質問と入力を二重表示する"
// observable = "対応する質問の回答と各入力状態におけるuser row"
// observation_boundary = "component-behavior"
// scope = "Codex question response history projection"
// lifecycle = "permanent"
// impact = "回答を閲覧できなくなるか、同じ回答が会話内に重複する"
// distinction = "入力storageのtestだけでは現在pageでの質問と回答の表示関係を検証できない"
// @end-test-value
/** 質問にひも付く入力は、対応する確定回答が画面に見えるときだけ非表示にする。 */
test("question-linked input is hidden only when its confirmed answer is visible", async () => {
  const question: Message = {
    role: "assistant",
    text: "Question",
    elicitationRecords: [
      {
        requestId: "q",
        kind: "question",
        message: "Question",
        fields: [
          { title: "Question", answer: { selected: [], text: ["A response"] } },
        ],
        status: "answered",
      },
    ],
  };
  const input: Message = {
    role: "user",
    text: "A response",
    turnInput: {
      turnId: "1",
      nativeTurnId: "n",
      state: "confirmed",
      questionRequestId: "q",
      attachments: [],
    },
  };
  const mounted = await mountSessionMessageColumn({
    messages: [input, question],
    isRunning: false,
  });
  try {
    assert.equal(
      mounted.container.querySelectorAll(".message-row.user").length,
      0,
    );
    assert.match(mounted.container.textContent ?? "", /A response/);
    await mounted.rerender({
      messages: [
        { ...input, turnInput: { ...input.turnInput!, state: "unknown" } },
        question,
      ],
    });
    assert.equal(
      mounted.container.querySelectorAll(".message-row.user").length,
      1,
    );
    await mounted.rerender({ messages: [input] });
    assert.equal(
      mounted.container.querySelectorAll(".message-row.user").length,
      1,
    );
  } finally {
    await mounted.cleanup();
  }
});

/** pending本文が先に利用可能なら、実行開始直後からassistant行を表示する。 */
test("SessionMessageColumn は pending message text があれば実行開始直後の assistant row を描画する", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(1),
    isRunning: true,
    pendingMessageText: "応答を準備しています",
  });

  assert.match(html, /pending-row/);
  assert.match(html, /応答を準備しています/);
  assert.ok(
    html.indexOf("message 1") < html.indexOf("pending-row"),
    "pending row は既存メッセージの後に描画する",
  );
});

// @test-value v2
// kind = "contract"
// claim = "pending message textのconsumer可視性だけを切り替え、built-in待機文を省略しても処理中bubble・custom text・approval・error・実本文を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: pending中のlive activity / streaming response" }
// fault = "built-in待機文を本文へ表示する、custom textを隠す、または同じrunのbubble/approval/error/live assistant textまで消す"
// observable = "応答枠と本文textの独立した有無、approval/error/live assistant textのDOM"
// observation_boundary = "component-behavior"
// scope = "session-message-pending-text-visibility"
// lifecycle = "permanent"
// impact = "既定待機説明の重複を抑えながらrun状態、request、生成内容を失わない"
// distinction = "text visibilityだけをfalseにし、run stateとlive request payloadは各入力へ独立して与える"
// @end-test-value
/** 組み込みのpending文言だけを省略し、カスタム文言と実行内容は表示に残す。 */
test("SessionMessageColumn は built-in pending text を省略しても custom と実行内容を保持する", () => {
  const builtInHiddenHtml = renderSessionMessageColumn({
    messages: createMessages(1),
    isRunning: true,
    pendingMessageText: "Preparing a response",
    pendingMessageTextVisible: false,
  });
  assert.match(builtInHiddenHtml, /pending-row/);
  assert.match(builtInHiddenHtml, /typing-dots pending-run-indicator-dots/);
  assert.doesNotMatch(builtInHiddenHtml, /Preparing a response/);

  const customVisibleHtml = renderSessionMessageColumn({
    messages: createMessages(1),
    isRunning: true,
    pendingMessageText: "Custom waiting copy",
    pendingMessageTextVisible: true,
  });
  assert.match(customVisibleHtml, /pending-row/);
  assert.match(customVisibleHtml, /Custom waiting copy/);

  const approvalHtml = renderSessionMessageColumn({
    messages: createMessages(1),
    isRunning: true,
    liveApprovalRequest: createLiveApprovalRequest(),
    pendingMessageText: "Preparing a response",
    pendingMessageTextVisible: false,
  });
  const approval = new JSDOM(approvalHtml).window.document.querySelector(
    '.pending-row [role="group"][aria-label="Approval required"]',
  );
  assert.ok(approval);
  assert.match(approval.textContent ?? "", /npm test を実行します/);
  assert.doesNotMatch(approvalHtml, /Preparing a response/);

  const errorHtml = renderSessionMessageColumn({
    messages: createMessages(1),
    isRunning: true,
    liveRunErrorMessage: "Run failed",
    pendingMessageText: "Preparing a response",
    pendingMessageTextVisible: false,
  });
  assert.match(errorHtml, /Run failed/);
  assert.equal(
    new JSDOM(errorHtml).window.document.querySelector(
      ".pending-row .pending-run-error-note",
    )?.textContent,
    "Run failed",
  );
  assert.doesNotMatch(errorHtml, /Preparing a response/);

  const assistantHtml = renderSessionMessageColumn({
    messages: [
      ...createMessages(1),
      { role: "assistant", text: "Live assistant response" },
    ],
    isRunning: true,
    liveRunAssistantText: "Live assistant response",
    messageKeys: ["previous-response", "current-response"],
    pendingResponseMessageKey: "current-response",
    pendingMessageText: "Preparing a response",
    pendingMessageTextVisible: false,
  });
  assert.match(assistantHtml, /Live assistant response/);
  const assistantDocument = new JSDOM(assistantHtml).window.document;
  assert.equal(assistantDocument.querySelectorAll(".pending-row").length, 0);
  assert.ok(
    [...assistantDocument.querySelectorAll(".message-row.assistant")].some(
      (row) =>
        row.textContent?.includes("Live assistant response") &&
        row.querySelector(".pending-run-indicator"),
    ),
  );
  assert.doesNotMatch(assistantHtml, /Preparing a response/);
});

/** Auxiliaryの実行中pending行は、親の会話末尾ではなく対応するグループの中に置く。 */
test("SessionMessageColumn は Auxiliary 実行中の pending row を group 内に描画する", () => {
  const html = renderSessionMessageColumn({
    messages: [
      { role: "assistant", text: "main response" },
      { role: "user", text: "aux prompt", accent: true },
      { role: "assistant", text: "later main response" },
    ],
    messageGroups: [null, { id: "aux-1", label: "Auxiliary" }, null],
    isRunning: true,
    pendingMessageText: "応答を準備しています",
    pendingMessageGroupId: "aux-1",
  });

  assert.match(
    html,
    /auxiliary-message-group-item auxiliary-message-group-end/,
  );
  assert.ok(
    html.indexOf("aux prompt") < html.indexOf("応答を準備しています"),
    "pending row は Auxiliary prompt の後に描画する",
  );
  assert.ok(
    html.indexOf("応答を準備しています") < html.indexOf("later main response"),
    "pending row は後続 main message より前の Auxiliary group 内に描画する",
  );
});

// @test-value v2
// kind = "contract"
// claim = "Mainと複数Auxiliaryを混在投影しても、保存済み本文と異なるlive応答の処理中状態は対象会話の指定位置にだけ表示される"
// oracle = { type = "contract", ref = "Issue #742: 完了条件; docs/design/desktop-ui.md: pending中のlive activity / streaming response" }
// fault = "本文一致または最後のassistantを選ぶため別会話・同じ会話の後続応答へindicatorが付くか、独立pending行とavatarが増える"
// observable = "指定位置の保存済み応答枠内と全体のindicator数、assistant avatar数、独立pending行数"
// observation_boundary = "component-behavior"
// scope = "auxiliary-streaming-response-group"
// lifecycle = "permanent"
// impact = "処理中の対象会話を取り違え、別のassistant応答が始まったように見える"
// distinction = "単一conversationの状態遷移testと異なり、実projectionで複数sourceを挿入した位置の所属を少数fixtureで検証する。型検査とprojection単体testでは表示側の取り違えを検出できない"
// @end-test-value
/** 同じライブ文字列が各履歴にあっても、応答の置換対象はMainと各Auxiliaryの投影キーで選ぶ。 */
test("SessionMessageColumn は本文が異なるMain/Auxiliary応答を投影keyで識別する", () => {
  /** owner固有の保存本文と全ownerに共通するライブ文字列を組み合わせる。 */
  const messagesFor = (id: string): Message[] => [
    { role: "user", text: `${id} prompt` },
    { role: "assistant", text: `${id} saved response` },
    { role: "assistant", text: "live response" },
  ];
  for (const targetId of ["session-1", "aux-1", "aux-2"]) {
    const liveAssistant = {
      sessionId: targetId,
      threadId: "thread-1",
      messageIndex: 1,
      text: "live response",
    };
    const projection = buildMessageListProjection(
      messagesFor("session-1"),
      ["aux-1", "aux-2"].map((id) => ({
        id,
        messages: messagesFor(id),
        displayAfterMessageIndex: 1,
        createdAt: "2026-09-27T00:00:00Z",
      })),
      "session-1",
      { liveAssistant },
    );
    const html = renderSessionMessageColumn({
      messages: projection.messages,
      messageKeys: projection.keys,
      messageGroups: projection.groups,
      pendingResponseMessageKey: buildLiveAssistantProjectionKey(
        targetId,
        liveAssistant.threadId,
        liveAssistant.messageIndex,
      ),
      isRunning: true,
      liveRunAssistantText: liveAssistant.text,
      pendingMessageGroupId: targetId === "session-1" ? null : targetId,
    });
    const document = new JSDOM(html).window.document;
    const response = [
      ...document.querySelectorAll(".message-row.assistant"),
    ].find(
      (row) =>
        row.querySelector("[data-message-body='true']")?.textContent ===
        `${targetId} saved response`,
    );
    assert.ok(response, targetId);
    assert.equal(
      response.querySelectorAll(".pending-run-indicator").length,
      1,
      targetId,
    );
    assert.equal(
      document.querySelectorAll(".pending-run-indicator").length,
      1,
      targetId,
    );
    assert.equal(
      document.querySelectorAll(".message-row.assistant .message-avatar")
        .length,
      6,
      targetId,
    );
    assert.equal(document.querySelectorAll(".pending-row").length, 0, targetId);
  }
});

/** 対応するAuxiliaryグループが仮想ウィンドウの外なら、pendingを暫定的に会話末尾へ表示する。 */
test("SessionMessageColumn は pending 対象の Auxiliary group が window 外なら末尾に fallback 描画する", () => {
  const messages = createMessages(100);
  messages[0] = {
    role: "user",
    text: "aux prompt outside window",
    accent: true,
  };
  const messageGroups: SessionMessageColumnProps["messageGroups"] = Array.from(
    { length: 100 },
    () => null,
  );
  messageGroups[0] = { id: "aux-1", label: "Auxiliary" };

  const html = renderSessionMessageColumn({
    messages,
    messageGroups,
    isRunning: true,
    pendingMessageText: "応答を準備しています",
    pendingMessageGroupId: "aux-1",
  });

  assert.doesNotMatch(html, /aux prompt outside window/);
  assert.match(html, /応答を準備しています/);
  assert.ok(
    html.indexOf("message 100") < html.indexOf("応答を準備しています"),
    "対象 group が描画 window 外なら pending row は通常どおり末尾に描画する",
  );
});

// @test-value v2
// kind = "contract"
// claim = "SessionComposerExpandedのidle DOMはattachment/view操作、closedなattachment menu、Add Directory/Add Directory By Path/Dirs、target dock、Cancel予約slot、settingsとSendの構成を維持し、Hide/reopen導線を置かず、Cancel slotを非activeで保つ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock / Add Directory By Path" }
// fault = "idle表示でattachment/view action・closedなattachment menu・Add Directory/Add Directory By Path/Dirs・target dock・Cancel slot・SendのDOM配置が崩れる、Hide/reopen導線が混入する、Cancel slotがactiveまたはbuttonを持つ、Sendがsettings group内へ移動する"
// observable = "parsed SessionComposerExpandedのidle DOMにおけるattachment toolbar、closedなattachment menu、Skill直後のAdd Directory/Add Directory By Path/Dirs、composer-toolbar-view-actions、Hide/reopen導線の不在、target/Cancel slot、composer-control-row内のsettings groupとその外側のSend button"
// observation_boundary = "component-behavior"
// scope = "expanded ActionDock idle layout and Cancel slot"
// lifecycle = "permanent"
// impact = "SessionComposerExpandedのidle DOMで主操作とCancel予約領域の位置を維持し、誤操作可能なCancelを表示しない"
// distinction = "CSS declaration testは共有slotの幅を確認し、running component testはactiveなCancelとdisabled Sendを確認し、このtestはSessionComposerExpanded単体のidle DOMを確認する"
// @end-test-value
/** 展開時はHideを出さず、設定を変える欄とは別のグループにSendを置く。 */
test("SessionComposerExpanded は Hide を描画せず、Send を設定グループの外へ配置する", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionComposerExpanded, {
      isRunning: false,
      targetDock: React.createElement(
        "span",
        { className: "test-target-dock" },
        "Main / Auxiliary",
      ),
      composerBlocked: false,
      canSelectCustomAgent: true,
      showCustomAgentPicker: true,
      showSkillPicker: true,
      showMessageViewModeControls: true,
      messageViewMode: "source",
      isAgentPickerOpen: false,
      isSkillPickerOpen: false,
      isAdditionalDirectoryListOpen: false,
      selectedCustomAgentLabel: "Agent",
      selectedCustomAgentTitle: "Agent",
      additionalDirectoryCount: 0,
      showJumpToBottom: true,
      isCustomAgentListLoading: false,
      customAgentItems: [],
      draft: "",
      composerTextareaRef: createRef<HTMLTextAreaElement>(),
      isComposerDisabled: false,
      isSendDisabled: true,
      composerSendability: {
        primaryFeedback: "",
        secondaryFeedback: [],
        feedbackTone: null,
        shouldShowFeedback: false,
      },
      sendButtonTitle: "送信できないよ。",
      isComposerBlockedFeedbackActive: false,
      approvalOptions: [{ value: "untrusted", label: "untrusted" }],
      selectedApprovalMode: "untrusted",
      speedOptions: [],
      selectedCodexSpeed: "standard",
      sandboxOptions: [{ value: "workspace-write", label: "workspace-write" }],
      selectedCodexSandboxMode: "workspace-write",
      modelOptions: [
        {
          value: "gpt-5.4",
          label: "GPT-5.4",
          model: { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: [] },
        },
      ],
      selectedModel: "gpt-5.4",
      selectedModelFallbackLabel: "gpt-5.4",
      reasoningOptions: [{ value: "high", label: "high" }],
      selectedReasoningEffort: "high",
      /** 位置の確認だけなのでファイル選択を起動しない。 */
      onPickFile() {},
      /** 添付のフォルダー選択を実際には開かない。 */
      onPickFolder() {},
      /** 画像選択の外部ダイアログを起動しない。 */
      onPickImage() {},
      /** Agentピッカーの開閉状態はこの静的描画では変えない。 */
      onToggleAgentPicker() {},
      /** Skillピッカーの開閉をレイアウト確認から切り離す。 */
      onToggleSkillPicker() {},
      /** 追加ディレクトリの登録処理を伴わず操作欄を描画する。 */
      onAddAdditionalDirectory() {},
      /** 追加先を検証可能な前提にしてファイル操作の依存を外す。 */
      onValidateAdditionalDirectory: async () => ({ valid: true as const }),
      /** 追加ディレクトリ一覧を操作せず初期の配置を調べる。 */
      onToggleAdditionalDirectoryList() {},
      /** 末尾ジャンプの実行処理を持たずボタン位置を確認する。 */
      onJumpToBottom() {},
      /** カスタムAgentによる選択変更は発生させない。 */
      onSelectCustomAgent() {},
      /** 配置確認では入力値の親への反映を行わない。 */
      onDraftChange() {},
      /** フォーカスの親通知に副作用を持たせない。 */
      onDraftFocus() {},
      /** 下書き欄のキー操作はこの配置検査では実行しない。 */
      onDraftKeyDown() {},
      /** テキスト選択の反映を伴わず入力欄を描画する。 */
      onDraftSelect() {},
      /** 変換開始側の通知口を用意するがIME操作は行わない。 */
      onDraftCompositionStart() {},
      /** 変換終了側にも副作用のない通知口を置く。 */
      onDraftCompositionEnd() {},
      /** 操作は実行せず、Sendが置かれるグループだけ検査する。 */
      onSendOrCancel() {},
      /** Approval更新を行わず設定グループを描画する。 */
      onChangeApprovalMode() {},
      /** Codex Speedの保存を置き換え、表示だけを確認する。 */
      onChangeCodexSpeed() {},
      /** Sandbox切替を設定値に反映しない表示用の通知先。 */
      onChangeCodexSandboxMode() {},
      /** Model選択を反映せず初期の設定欄を描画する。 */
      onChangeModel() {},
      /** 推論深度の変更を伴わず欄の配置を確認する。 */
      onChangeReasoningEffort() {},
      /** 表示モード変更を起こさず初期表示用の操作を提供する。 */
      onMessageViewModeChange() {},
    }),
  );

  const renderedDocument = new JSDOM(html).window.document;
  const composer = renderedDocument.querySelector(".composer");
  const attachmentToolbar = renderedDocument.querySelector(
    ".composer-attachments-toolbar",
  );
  const attachmentMenu = attachmentToolbar?.querySelector(
    ".composer-attachment-menu-shell",
  );
  const attachmentButton = attachmentMenu?.querySelector(
    "button.composer-attachment-trigger",
  );
  const attachmentPanel = renderedDocument.querySelector(
    "#composer-attachment-menu",
  );
  const skillButton = Array.from(
    attachmentToolbar?.querySelectorAll("button") ?? [],
  ).find((button) => button.textContent?.trim() === "Skill");
  const additionalDirectoryToolbar = attachmentToolbar?.querySelector(
    ".composer-additional-directory-toolbar",
  );
  const addGroup = additionalDirectoryToolbar?.querySelector(
    '[role="group"][aria-label="Add directory"]',
  );
  const addDirectoryButton = addGroup?.querySelector("button:nth-child(1)");
  const addPathButton = addGroup?.querySelector("button:nth-child(2)");
  const directoriesButton = additionalDirectoryToolbar?.querySelector(
    "button.composer-directory-list-button",
  );
  const viewActions = renderedDocument.querySelector(
    ".composer-toolbar-view-actions",
  );
  const cancelSlot = viewActions?.querySelector(
    ":scope > .session-action-dock-cancel-slot",
  );
  const targetSlot = viewActions?.querySelector(
    ":scope > .composer-target-dock-slot",
  );
  const jumpButton = viewActions?.querySelector(
    "button.message-jump-bottom-button",
  );
  const viewModeGroup = viewActions?.querySelector(
    ".composer-message-view-mode",
  );
  const previewButton = viewModeGroup?.querySelector("button:nth-child(1)");
  const sourceButton = viewModeGroup?.querySelector("button:nth-child(2)");
  const composerInputRow = renderedDocument.querySelector(
    ".composer-input-row",
  );
  const controlRow = renderedDocument.querySelector(".composer-control-row");
  const settingsGroup = controlRow?.querySelector(
    ":scope > .composer-settings",
  );
  const sendButton = controlRow?.querySelector<HTMLButtonElement>(
    ":scope > .composer-send-control > button.session-send-button",
  );
  assert.ok(composer);
  assert.ok(attachmentToolbar);
  assert.ok(attachmentMenu);
  assert.ok(attachmentButton);
  assert.ok(skillButton);
  assert.ok(additionalDirectoryToolbar);
  assert.ok(addDirectoryButton);
  assert.ok(addPathButton);
  assert.ok(directoriesButton);
  assert.ok(viewActions);
  assert.ok(cancelSlot);
  assert.ok(targetSlot);
  assert.ok(jumpButton);
  assert.ok(viewModeGroup);
  assert.ok(previewButton);
  assert.ok(sourceButton);
  assert.ok(composerInputRow);
  assert.ok(controlRow);
  assert.ok(settingsGroup);
  assert.ok(sendButton);
  assert.equal(composer.firstElementChild, attachmentToolbar);
  assert.equal(attachmentToolbar.nextElementSibling, composerInputRow);
  assert.equal(attachmentMenu.parentElement, attachmentToolbar);
  assert.equal(attachmentButton.parentElement, attachmentMenu);
  assert.equal(attachmentPanel, null);
  assert.equal(skillButton.nextElementSibling, additionalDirectoryToolbar);
  assert.match(attachmentButton.textContent ?? "", /Attach/);
  assert.equal(addDirectoryButton.textContent, "Add Directory");
  assert.equal(addPathButton.textContent, "Add Directory By Path");
  assert.equal(
    directoriesButton.getAttribute("aria-label"),
    "Additional Directories: 0",
  );
  assert.equal(directoriesButton.textContent, "0");
  assert.equal(addGroup?.nextElementSibling, directoriesButton);
  assert.ok(
    (additionalDirectoryToolbar.compareDocumentPosition(viewActions) & 4) !== 0,
  );
  assert.ok((attachmentMenu.compareDocumentPosition(viewActions) & 4) !== 0);
  assert.equal(viewActions.firstElementChild, cancelSlot);
  assert.equal(cancelSlot.nextElementSibling, targetSlot);
  assert.equal(cancelSlot.classList.contains("is-active"), false);
  assert.equal(cancelSlot.getAttribute("aria-hidden"), "true");
  assert.equal(cancelSlot.querySelector("button"), null);
  const forbiddenDockHitArea = Array.from(
    composer.querySelectorAll('button, [role="button"], a, [tabindex]'),
  ).find((element) => {
    const accessibleText = [
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
    ]
      .filter(Boolean)
      .join(" ");
    return /\b(?:hide|reopen)\b/i.test(accessibleText);
  });
  assert.equal(forbiddenDockHitArea, undefined);
  assert.equal(targetSlot.textContent, "Main / Auxiliary");
  assert.equal(jumpButton.textContent, "Jump To Latest");
  assert.equal(
    viewModeGroup.getAttribute("aria-label"),
    "Message display mode",
  );
  assert.equal(previewButton.getAttribute("aria-pressed"), "false");
  assert.equal(sourceButton.getAttribute("aria-pressed"), "true");
  assert.equal(controlRow.firstElementChild, settingsGroup);
  assert.equal(settingsGroup.nextElementSibling, sendButton.parentElement);
  assert.equal(settingsGroup.contains(sendButton), false);
  assert.equal(sendButton.textContent, "Send");
  assert.equal(sendButton.disabled, true);
});

// @test-value v2
// kind = "contract"
// claim = "queue受付を提供しないComposerではrunning中のSendとApproval/Sandbox/Model/Depthを変更不可にし、Cancelの配置とidle/read-onlyの操作制約を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock" }
// fault = "queue受付のないComposerでCancel/Sendのrunning状態が誤る、設定がrunning中に変更できる、またはread-onlyでも変更できる"
// observable = "running/idle/read-onlyのCancel slot、Send disabled/title、Approval/Sandbox/Depth selectとModel triggerのdisabled属性"
// observation_boundary = "component-behavior"
// scope = "expanded ActionDock primary action without onQueueTurn"
// lifecycle = "permanent"
// impact = "queue受付のない状態で実行中の設定変更を防ぎ、CancelとSendの位置を維持する"
// distinction = "queue受付未提供のComposer単体の描画属性を確認し、queue対応Appの次送信用設定やMain側の捕捉/保存の検査と区別する"
// @end-test-value
/** 実行操作に続く右端に末尾移動と表示切替を置き、実行中の設定変更は無効にする。 */
test("SessionComposerExpanded は実行中の操作後に jump button と表示切替を右側 group へ描画する", () => {
  /** 同一の展開Composerを実行中・待機中・ブロック中で描き分ける。 */
  const renderComposer = (isRunning: boolean, composerBlocked = false) =>
    renderToStaticMarkup(
      React.createElement(SessionComposerExpanded, {
        isRunning,
        targetDock: React.createElement(
          "span",
          { className: "test-target-dock" },
          "Main / Auxiliary",
        ),
        composerBlocked,
        canSelectCustomAgent: true,
        showCustomAgentPicker: true,
        showSkillPicker: true,
        showMessageViewModeControls: true,
        messageViewMode: "preview",
        isAgentPickerOpen: false,
        isSkillPickerOpen: false,
        isAdditionalDirectoryListOpen: false,
        selectedCustomAgentLabel: "Agent",
        selectedCustomAgentTitle: "Agent",
        additionalDirectoryCount: 0,
        showJumpToBottom: true,
        isCustomAgentListLoading: false,
        customAgentItems: [],
        draft: "実行中の下書き",
        composerTextareaRef: createRef<HTMLTextAreaElement>(),
        isComposerDisabled: false,
        isSendDisabled: false,
        composerSendability: {
          primaryFeedback: "",
          secondaryFeedback: [],
          feedbackTone: null,
          shouldShowFeedback: false,
        },
        sendButtonTitle: "実行をキャンセル",
        isComposerBlockedFeedbackActive: false,
        approvalOptions: [{ value: "untrusted", label: "untrusted" }],
        selectedApprovalMode: "untrusted",
        speedOptions: [],
        selectedCodexSpeed: "standard",
        sandboxOptions: [
          { value: "workspace-write", label: "workspace-write" },
        ],
        selectedCodexSandboxMode: "workspace-write",
        modelOptions: [
          {
            value: "gpt-5.4",
            label: "GPT-5.4",
            model: { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: [] },
          },
        ],
        selectedModel: "gpt-5.4",
        selectedModelFallbackLabel: "gpt-5.4",
        reasoningOptions: [{ value: "high", label: "high" }],
        selectedReasoningEffort: "high",
        /** 実行状態ごとの配置比較でファイルピッカーは起動しない。 */
        onPickFile() {},
        /** フォルダー選択は行わず、操作可能性だけを比較する。 */
        onPickFolder() {},
        /** 画像選択処理を外し、実行状態だけを描画条件にする。 */
        onPickImage() {},
        /** 実行中のAgent選択通知に副作用を持たせない。 */
        onToggleAgentPicker() {},
        /** 実行状態の比較ではSkillピッカーを実際に切り替えない。 */
        onToggleSkillPicker() {},
        /** 実行中かどうかを比較する際、追加ディレクトリは登録しない。 */
        onAddAdditionalDirectory() {},
        /** 同じ有効な検証結果を各実行状態に供給する。 */
        onValidateAdditionalDirectory: async () => ({ valid: true as const }),
        /** ディレクトリ一覧の開閉処理を描画結果の比較から切り離す。 */
        onToggleAdditionalDirectoryList() {},
        /** 末尾ジャンプの実処理ではなく右側グループでの位置を確認する。 */
        onJumpToBottom() {},
        /** カスタムAgentの状態は稼働条件の比較中に更新しない。 */
        onSelectCustomAgent() {},
        /** 実行状態の比較から下書き本文の親更新を除く。 */
        onDraftChange() {},
        /** フォーカス時の親の応答を固定して配置だけを比較する。 */
        onDraftFocus() {},
        /** キー入力の副作用を持たないComposerを描画する。 */
        onDraftKeyDown() {},
        /** 下書き選択の通知をどの稼働状態でも無視する。 */
        onDraftSelect() {},
        /** IMEの変換開始を起こさず実行状態を比較する。 */
        onDraftCompositionStart() {},
        /** IME確定側の通知も実行状態へ影響させない。 */
        onDraftCompositionEnd() {},
        /** SendまたはCancelの実行なしにボタンの表示を比較する。 */
        onSendOrCancel() {},
        /** Approvalは更新せず、実行中に無効化されるかを調べる。 */
        onChangeApprovalMode() {},
        /** Speedの変更処理を外して表示順を観測する。 */
        onChangeCodexSpeed() {},
        /** Sandboxの値は据え置き、selectの無効状態を確認する。 */
        onChangeCodexSandboxMode() {},
        /** Model更新は行わず実行中にボタンを使えるかだけ調べる。 */
        onChangeModel() {},
        /** 深度値の変更を行わずselectが無効になるか調べる。 */
        onChangeReasoningEffort() {},
        /** 表示切替の副作用なしで右側グループのモード操作を描画する。 */
        onMessageViewModeChange() {},
      }),
    );
  const html = renderComposer(true);

  assert.match(html, /Jump To Latest/);
  assert.ok(html.indexOf("Attach") < html.indexOf("Jump To Latest"));
  assert.ok(html.indexOf("Jump To Latest") < html.indexOf("Preview"));
  assert.match(
    html,
    /composer-toolbar-view-actions[\s\S]*Jump To Latest[\s\S]*Message display mode/,
  );

  const renderedDocument = new JSDOM(html).window.document;
  const toolbar = renderedDocument.querySelector(
    ".composer-attachments-toolbar",
  );
  const viewActions = renderedDocument.querySelector(
    ".composer-toolbar-view-actions",
  );
  const cancelSlot = viewActions?.querySelector(
    ":scope > .session-action-dock-cancel-slot",
  );
  const cancelButton = cancelSlot?.querySelector<HTMLButtonElement>(
    ":scope > button.session-send-button.danger",
  );
  const targetSlot = viewActions?.querySelector(
    ":scope > .composer-target-dock-slot",
  );
  const controlRow = renderedDocument.querySelector(".composer-control-row");
  const sendButton = controlRow?.querySelector<HTMLButtonElement>(
    ":scope > .composer-send-control > button.session-send-button",
  );
  assert.ok(toolbar);
  assert.ok(viewActions);
  assert.ok(cancelSlot);
  assert.ok(cancelButton);
  assert.ok(targetSlot);
  assert.ok(controlRow);
  assert.ok(sendButton);
  assert.equal(viewActions.firstElementChild, cancelSlot);
  assert.equal(cancelSlot.nextElementSibling, targetSlot);
  assert.equal(cancelSlot.classList.contains("is-active"), true);
  assert.equal(cancelSlot.hasAttribute("aria-hidden"), false);
  assert.equal(cancelButton.textContent, "Cancel");
  assert.equal(cancelButton.disabled, false);
  assert.equal(targetSlot.textContent, "Main / Auxiliary");
  assert.equal(sendButton.textContent, "Send");
  assert.equal(sendButton.disabled, true);
  assert.ok(
    sendButton.getAttribute("title"),
    "running中のSendはblocked reason titleを持つ",
  );
  assert.equal(sendButton.classList.contains("danger"), false);
  assert.equal(
    controlRow.querySelectorAll(
      ":scope > .composer-send-control > button.session-send-button",
    ).length,
    1,
  );
  /** 実行中の設定行から対象クラスに属するネイティブselectを探す。 */
  const runningSelect = (className: string) =>
    controlRow.querySelector<HTMLSelectElement>(`.${className} select`);
  assert.equal(runningSelect("composer-setting-approval")?.disabled, true);
  assert.equal(runningSelect("composer-setting-sandbox")?.disabled, true);
  assert.equal(
    controlRow.querySelector<HTMLButtonElement>(
      '.composer-setting-model button[aria-label="Model"]',
    )?.disabled,
    true,
  );
  assert.equal(runningSelect("composer-setting-depth")?.disabled, true);

  const idleHtml = renderComposer(false);
  const idleDocument = new JSDOM(idleHtml).window.document;
  const idleViewActions = idleDocument.querySelector(
    ".composer-toolbar-view-actions",
  );
  const idleCancelSlot = idleViewActions?.querySelector(
    ":scope > .session-action-dock-cancel-slot",
  );
  const idleTargetSlot = idleViewActions?.querySelector(
    ":scope > .composer-target-dock-slot",
  );
  const idleControlRow = idleDocument.querySelector(".composer-control-row");
  const idleSendButton = idleControlRow?.querySelector<HTMLButtonElement>(
    ":scope > .composer-send-control > button.session-send-button",
  );
  assert.ok(idleViewActions);
  assert.ok(idleCancelSlot);
  assert.ok(idleTargetSlot);
  assert.ok(idleControlRow);
  assert.ok(idleSendButton);
  assert.equal(idleCancelSlot.classList.contains("is-active"), false);
  assert.equal(idleCancelSlot.getAttribute("aria-hidden"), "true");
  assert.equal(idleCancelSlot.querySelector("button"), null);
  assert.equal(idleCancelSlot.nextElementSibling, idleTargetSlot);
  assert.equal(idleSendButton.disabled, false);
  assert.equal(
    idleControlRow.querySelector<HTMLButtonElement>(
      '.composer-setting-model button[aria-label="Model"]',
    )?.disabled,
    false,
  );
  assert.equal(
    idleControlRow.querySelector<HTMLSelectElement>(
      ".composer-setting-depth select",
    )?.disabled,
    false,
  );

  const readOnlyDocument = new JSDOM(renderComposer(true, true)).window
    .document;
  assert.equal(
    readOnlyDocument.querySelector<HTMLButtonElement>(
      '.composer-setting-model button[aria-label="Model"]',
    )?.disabled,
    true,
  );
  assert.equal(
    readOnlyDocument.querySelector<HTMLSelectElement>(
      ".composer-setting-depth select",
    )?.disabled,
    true,
  );
});

// @test-value v2
// kind = "contract"
// claim = "SessionComposerExpandedは送信受付待ちにSendを無効化し、理由をtitleとstatusで伝え、常設文言の代わりにspinnerとaria-busyで示す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Send disabled理由とtitle; docs/design/ui-design-guidelines.md: ボタン" }
// fault = "busy中のSendが理由と異なるtitleや常設helper feedbackを表示する、spinnerまたはaria-busyが欠ける、または送信を許可する"
// observable = "Send buttonのdisabled・aria-busy・title・spinner、textareaのaria-busy、status announcement、feedback DOM"
// observation_boundary = "component-behavior"
// scope = "expanded composer send admission pending"
// lifecycle = "permanent"
// impact = "送信直後の待機状態を簡潔な視覚表示とaccessible statusで示し、同じbusy説明の重複表示を防ぐ"
// distinction = "sendability state testはbusy/error併存判定を確認し、このtestはSessionComposerExpandedへの表示投影を確認する"
// @end-test-value
/** 送信がbusyの間は通常のSend操作の代わりに進行表示とステータスを出す。 */
test("SessionComposerExpanded は busy 中の Send を spinner と status にする", () => {
  const busyReason = "Message submission is in progress.";
  const html = renderToStaticMarkup(
    React.createElement(
      SessionComposerExpanded,
      createComposerTestProps({
        draft: "hello",
        isSendDisabled: true,
        queueTurnBusy: true,
        composerSendability: {
          isBusy: true,
          busyReason,
          primaryFeedback: "",
          secondaryFeedback: [],
          feedbackTone: null,
          shouldShowFeedback: false,
        },
        sendButtonTitle: busyReason,
      }),
    ),
  );

  const renderedDocument = new JSDOM(html).window.document;
  const sendButton = renderedDocument.querySelector<HTMLButtonElement>(
    ".composer-control-row .composer-send-control > button.session-send-button",
  );
  const textarea = renderedDocument.querySelector<HTMLTextAreaElement>(
    ".composer-input-row textarea",
  );
  const status = renderedDocument.querySelector('[role="status"]');
  assert.ok(sendButton);
  assert.ok(textarea);
  assert.ok(status);
  assert.equal(sendButton.disabled, true);
  assert.equal(sendButton.getAttribute("aria-busy"), "true");
  assert.ok(sendButton.getAttribute("title")?.startsWith(busyReason));
  assert.ok(
    sendButton.querySelector(".loading-indicator-spinner[aria-hidden='true']"),
  );
  assert.equal(sendButton.textContent, "Send");
  assert.equal(textarea.getAttribute("aria-busy"), "true");
  assert.equal(status.textContent, busyReason);
  assert.equal(
    renderedDocument.querySelector(".composer-sendability-feedback"),
    null,
  );
});

// @test-value v2
// kind = "contract"
// claim = "idleのcompact ActionDockはpreview/source切替とjumpを表示し、send・draftの重複UIを表示しない"
// oracle = { type = "contract", ref = "src/chat/approval/session-action-dock.tsx" }
// fault = "idle状態でもSendまたはdraftを複製するか、preview/source・jump affordanceを失う"
// observable = "Jump To Latest、Preview/Source、expand label、Send/draftのDOM有無"
// observation_boundary = "component-behavior"
// scope = "compact-action-dock-idle"
// lifecycle = "permanent"
// impact = "同じ操作をMain composerと重複表示し、compact dockの対象切替を妨げる"
// distinction = "running compact表示のpending/cancel契約とは分離してidle表示の重複抑止を確認する"
// @end-test-value
/** 待機時の折りたたみ行には表示モードと末尾移動を残すが、Sendや下書きは出さない。 */
test("SessionActionDockCompactRow は通常時に preview/source と jump を表示し Send と下書きを表示しない", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionActionDockCompactRow, {
      isRunning: false,
      showJumpToBottom: true,
      showMessageViewModeControls: true,
      messageViewMode: "preview",
      /** 折りたたみ時の初期表示確認では展開しない。 */
      onExpand() {},
      /** 末尾移動のボタンは描画するがスクロール処理は走らせない。 */
      onJumpToBottom() {},
      /** 通常時に取消が実行されない構成で配置を確認する。 */
      onCancel() {},
      /** PreviewとSourceの切替状態を他の表示に反映しない。 */
      onMessageViewModeChange() {},
    }),
  );

  assert.match(html, /Jump To Latest/);
  const document = new JSDOM(html).window.document;
  assert.deepEqual(
    [...document.querySelectorAll(".composer-message-view-mode button")].map(
      (button) => button.textContent,
    ),
    ["Preview", "Source"],
  );
  assert.match(
    html,
    /class="session-action-dock-compact-meta session-action-dock-compact-expand-button"/,
  );
  assert.match(html, /aria-label="Expand action dock"/);
  assert.equal(document.querySelector(".session-send-button"), null);
  assert.doesNotMatch(html, /Draft|下書きなし/);
});

// @test-value v2
// kind = "contract"
// claim = "compact ActionDockはidle、会話通知あり、runningの全状態で同じmeta領域から展開でき、会話通知は展開buttonではなく操作列に置く"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock" }
// fault = "runningか会話通知の有無でmeta領域のbuttonが消える、実行状態によって同じ領域から展開できない、または会話通知が展開buttonへ入り押すとDockを開くだけになる"
// observable = "各状態のbuttonのaccessible name、展開button内の要素不在、操作列内の会話通知、click後のonExpand呼出回数"
// observation_boundary = "component-behavior"
// scope = "compact ActionDock expand interaction"
// lifecycle = "permanent"
// impact = "実行中だけmeta領域から再展開できず、状態によって開閉操作が変わる"
// distinction = "既存の静的DOM testとは異なり、React上で各状態のmeta領域をclickして同一callbackを確認する"
// @end-test-value
/** 実行状態によらずmeta領域から展開できることをクリックで確認する。 */
test("SessionActionDockCompactRow は状態によらずmeta領域から展開する", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: dom.window.HTMLElement,
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: dom.window.Node,
  });
  let root: Root | null = null;
  let expandCount = 0;

  try {
    root = createRoot(
      dom.window.document.getElementById("root") as HTMLElement,
    );
    for (const [isRunning, hasAttention] of [
      [false, false],
      [false, true],
      [true, true],
    ] as const) {
      await act(async () => {
        root?.render(
          React.createElement(SessionActionDockCompactRow, {
            isRunning,
            attentionControl: hasAttention
              ? React.createElement(
                  "button",
                  { type: "button", className: "test-attention" },
                  "Main: New messages. Show Chat",
                )
              : null,
            showJumpToBottom: false,
            /** meta領域から展開が通知された回数を数える。 */
            onExpand: () => {
              expandCount += 1;
            },
            /** 末尾移動に副作用を持たせず展開操作を検証する。 */
            onJumpToBottom() {},
            /** 取消処理を起こさずメタ領域のクリックとの分離を調べる。 */
            onCancel() {},
          }),
        );
      });
      const row = dom.window.document.querySelector(
        ".session-action-dock-compact-row",
      );
      const button = row?.querySelector<HTMLButtonElement>(
        ".session-action-dock-compact-expand-button",
      );
      assert.ok(button);
      assert.equal(button.getAttribute("aria-label"), "Expand action dock");
      assert.equal(button.type, "button");
      assert.equal(button.tabIndex, 0);
      assert.equal(
        row?.querySelectorAll(".session-action-dock-compact-expand-button")
          .length,
        1,
      );
      assert.equal(button.childElementCount, 0);
      assert.equal(
        row?.querySelectorAll(
          ".session-action-dock-compact-actions > .test-attention",
        ).length,
        hasAttention ? 1 : 0,
      );
      await act(async () => button.click());
      assert.equal(expandCount, isRunning ? 3 : hasAttention ? 2 : 1);
    }
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      value: previousHTMLElement,
    });
    Object.defineProperty(globalThis, "Node", {
      configurable: true,
      value: previousNode,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "compact ActionDockは実行中に会話通知、Cancel、Main / Auxiliary、jump操作を同じ列に維持し、会話通知は先頭に置く"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock" }
// fault = "実行中のcompact ActionDockから会話通知、Cancel、Main / Auxiliary、jump操作が欠けるか、会話通知が先頭にない、またはCancelがtarget slotの直前にない"
// observable = "SessionActionDockCompactRowの実行中DOMにおける会話通知、jump button、Cancel、target slot、操作列のDOM順"
// observation_boundary = "component-behavior"
// scope = "compact ActionDock running presentation"
// lifecycle = "permanent"
// impact = "実行中のcompact ActionDockで停止操作と会話対象の切替位置を見失わない"
// distinction = "同一React treeのidle/running遷移は別testで確認し、このtestは実行中の操作列を確認する"
// @end-test-value
/** 折りたたみ中でも実行中なら末尾移動と取消を操作できる表示にする。 */
test("SessionActionDockCompactRow は実行中に jump button と Cancel を描画する", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionActionDockCompactRow, {
      isRunning: true,
      targetDock: React.createElement(
        "span",
        { className: "test-target-dock" },
        "Main / Auxiliary",
      ),
      attentionControl: React.createElement(
        "button",
        { type: "button", className: "test-attention" },
        "Main: New messages. Show Chat",
      ),
      showJumpToBottom: true,
      cancelButtonTitle: "実行をキャンセル",
      /** 実行中の折りたたみ行からはダミーの展開先を使う。 */
      onExpand() {},
      /** 実行中のジャンプ操作は行わずボタンの存在を確認する。 */
      onJumpToBottom() {},
      /** Cancelの実行を伴わず表示の契約を検査する。 */
      onCancel() {},
    }),
  );

  assert.match(html, /session-action-dock-compact-actions/);
  assert.ok(html.indexOf("Cancel") < html.indexOf("Jump To Latest"));
  const renderedDocument = new JSDOM(html).window.document;
  assert.equal(
    renderedDocument.querySelector(".session-send-button")?.textContent,
    "Cancel",
  );
  const actions = renderedDocument.querySelector(
    ".session-action-dock-compact-actions",
  );
  assert.ok(actions);
  const cancelSlot = actions?.querySelector(
    ":scope > .session-action-dock-cancel-slot",
  );
  const targetSlot = actions?.querySelector(
    ":scope > .session-action-dock-target-slot",
  );
  assert.ok(cancelSlot);
  assert.ok(targetSlot);
  assert.equal(actions.firstElementChild?.className, "test-attention");
  assert.equal(actions.firstElementChild?.nextElementSibling, cancelSlot);
  assert.equal(cancelSlot.nextElementSibling, targetSlot);
  assert.equal(targetSlot.textContent, "Main / Auxiliary");
});

// @test-value v2
// kind = "contract"
// claim = "compact ActionDockはidleとrunningの双方向遷移でもCancel予約slotをMain / Auxiliary直前に保つ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock" }
// fault = "idleまたはrunningでslotが消えるか、双方向の実行状態切替でCancelがMain / Auxiliary直前以外へ移動する、active状態・aria・Cancel buttonのenabled状態が崩れる"
// observable = "React stateをidle/runningへ双方向に更新したSessionActionDockCompactRowのslot順序、target内容、class、aria、Cancel button"
// observation_boundary = "component-behavior"
// scope = "compact ActionDock Cancel slot"
// lifecycle = "permanent"
// impact = "compactとexpandedでCancelの相対位置を揃え、target切替とrun状態変更による操作位置の横ずれを双方向に防ぐ"
// distinction = "CSS declaration testは固定幅を確認し、component testはReact state更新後もslotのDOM位置とtarget内容を確認する"
// @end-test-value
/** 実行状態や対象ラベルが変わっても、Cancelに予約した枠をMain／Auxiliaryの直前に維持する。 */
test("SessionActionDockCompactRow は実行状態が変わっても Main / Auxiliary 直前の Cancel 予約slotを維持する", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      pretendToBeVisual: true,
    },
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: dom.window.HTMLElement,
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: dom.window.Node,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  let root: Root | null = null;
  let setRunning: React.Dispatch<React.SetStateAction<boolean>> | null = null;
  let setTargetLabel: React.Dispatch<React.SetStateAction<string>> | null =
    null;
  /** 同じ折りたたみ行の実行状態と対象ラベルを別々に更新できるfixture。 */
  function Harness() {
    const [isRunning, updateRunning] = React.useState(false);
    const [targetLabel, updateTargetLabel] = React.useState("Main / Auxiliary");
    setRunning = updateRunning;
    setTargetLabel = updateTargetLabel;
    return React.createElement(SessionActionDockCompactRow, {
      isRunning,
      targetDock: React.createElement(
        "span",
        { className: "test-target-dock" },
        targetLabel,
      ),
      showJumpToBottom: true,
      cancelButtonTitle: "実行をキャンセル",
      /** 状態遷移中に展開で行の種類を変更しない。 */
      onExpand() {},
      /** 予約枠の検査にスクロール操作を混ぜない。 */
      onJumpToBottom() {},
      /** Cancel表示の遷移を検査し、実行自体は中止しない。 */
      onCancel() {},
    });
  }

  /** 予約枠の順序と対象表示を確認し、実行状態に応じたCancelの有無も判定する。 */
  const assertSlot = (
    slot: Element | null,
    isRunning: boolean,
    targetLabel: string,
  ) => {
    assert.ok(slot);
    const parent = slot.parentElement;
    assert.ok(
      parent?.classList.contains("session-action-dock-compact-actions"),
    );
    assert.equal(parent?.firstElementChild, slot);
    assert.equal(
      slot.nextElementSibling?.classList.contains(
        "session-action-dock-target-slot",
      ),
      true,
    );
    assert.equal(slot.nextElementSibling?.textContent, targetLabel);
    assert.equal(slot.classList.contains("is-active"), isRunning);
    if (isRunning) {
      const cancelButton = slot.querySelector<HTMLButtonElement>("button");
      assert.equal(slot.hasAttribute("aria-hidden"), false);
      assert.equal(cancelButton?.textContent, "Cancel");
      assert.equal(cancelButton?.disabled, false);
    } else {
      assert.equal(slot.getAttribute("aria-hidden"), "true");
      assert.equal(slot.querySelector("button"), null);
    }
  };

  try {
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(React.createElement(Harness));
    });
    const container = dom.window.document.getElementById("root") as HTMLElement;
    const idleSlot = container.querySelector(
      ".session-action-dock-cancel-slot",
    );
    assertSlot(idleSlot, false, "Main / Auxiliary");
    assert.ok(setRunning);
    assert.ok(setTargetLabel);

    await act(async () => {
      setRunning?.(true);
      setTargetLabel?.("Auxiliary");
    });
    const runningSlot = container.querySelector(
      ".session-action-dock-cancel-slot",
    );
    assertSlot(runningSlot, true, "Auxiliary");

    await act(async () => {
      setRunning?.(false);
      setTargetLabel?.("Main / Auxiliary");
    });
    const restoredSlot = container.querySelector(
      ".session-action-dock-cancel-slot",
    );
    assertSlot(restoredSlot, false, "Main / Auxiliary");
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      value: previousHTMLElement,
    });
    Object.defineProperty(globalThis, "Node", {
      configurable: true,
      value: previousNode,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: previousNavigator,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "queue受付を提供しないComposerのModelとDepthはrunning・blocked・freezeのいずれかで値を保持したまま変更不可となる"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/776; docs/design/desktop-ui.md: runtime settings" }
// fault = "queue受付のないComposerで実行中のModel/Depthが編集可能になる、blocked/freeze制限が消える、または無効化で選択値が変わる"
// observable = "実Composer DOMのModel triggerとDepth selectのdisabled、現在値の表示名とtitle"
// observation_boundary = "component-behavior"
// scope = "session-composer-model-depth-availability without onQueueTurn"
// lifecycle = "permanent"
// impact = "queue受付のない実行中の設定変更、利用制限中の編集、idleでの設定変更不能を防ぐ"
// distinction = "queue受付未提供のcomponent条件で各制限の独立性を8組合せで確認する。queue対応Appのrunning編集可は別境界のtestが担う"
// @end-test-value
/** ModelとDepthの保持値を変えず、操作ごとに許可・制限を独立して適用する。 */
test("SessionComposerExpanded は Model/Depth の値を保持し各利用制限を独立に適用する", () => {
  for (const isRunning of [false, true]) {
    for (const composerBlocked of [false, true]) {
      for (const frozen of [false, true]) {
        const registry = new ComposerControllerRegistry();
        if (frozen) registry.freeze();
        const html = renderToStaticMarkup(
          React.createElement(
            SessionComposerExpanded,
            createComposerTestProps({
              isRunning,
              composerBlocked,
              composerController: {
                owner: { kind: "main", id: "main-1" },
                registry,
              },
              modelOptions: [
                {
                  value: "gpt-5.4-mini",
                  label: "GPT-5.4 Mini",
                  model: {
                    id: "gpt-5.4-mini",
                    label: "GPT-5.4 Mini",
                    reasoningEfforts: [],
                  },
                },
                {
                  value: "gpt-5.4",
                  label: "GPT-5.4",
                  model: {
                    id: "gpt-5.4",
                    label: "GPT-5.4",
                    reasoningEfforts: [],
                  },
                },
              ],
              reasoningOptions: [
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
              ],
            }),
          ),
        );
        const dom = new JSDOM(html);
        try {
          const context = JSON.stringify({
            isRunning,
            composerBlocked,
            frozen,
          });
          const model = dom.window.document.querySelector<HTMLButtonElement>(
            'button[aria-label="Model"]',
          );
          assert.ok(model, context);
          assert.equal(
            model.disabled,
            isRunning || composerBlocked || frozen,
            context,
          );
          assert.equal(
            model.querySelector("span")?.textContent,
            "GPT-5.4",
            context,
          );
          assert.equal(model.title, "Model: GPT-5.4", context);
          const depth = dom.window.document.querySelector<HTMLSelectElement>(
            ".composer-setting-depth select",
          );
          assert.ok(depth, context);
          assert.equal(
            depth.disabled,
            isRunning || composerBlocked || frozen,
            context,
          );
          assert.equal(depth.value, "high", context);
          assert.equal(depth.selectedOptions[0]?.textContent, "High", context);
        } finally {
          dom.window.close();
        }
      }
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "freeze済みComposerは入力・添付・Agent/Skill/Template・directory・Model/Depthの操作をdisabledにし、open要求が残っていてもAgent候補を表示せず、空欄shortcutの強制feedbackを表示する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: close/app quit flush; docs/design/desktop-ui.md: composer feedback" }
// fault = "終了flush中に入力・picker・template・directory・Model/Depth操作が実行可能なまま残る、Agent候補を表示する、または空欄shortcutのMessage is empty表示が失われる"
// observable = "freeze済みComposerのtextarea・操作button・Depth selectのdisabled属性、Agent triggerのaria-expandedと候補listbox不在、composer-sendability-feedbackの本文・textarea aria-describedby"
// observation_boundary = "component-behavior"
// scope = "frozen composer mutation controls and forced sendability feedback"
// lifecycle = "permanent"
// impact = "flush中に捨てられる入力操作を利用者へ実行可能と見せず、keyboard送信を抑止した理由を表示する"
// distinction = "これは実Appのflush開始・非同期picker適用ではなく、共通ComposerのUI契約を確認する。controller通知・main handlerの統合挙動はintegration testで確認する"
// @end-test-value
/** freeze中には設定変更を無効化し、明示されたブロック理由を表示する。 */
test("SessionComposerExpanded はfreeze中の変更操作を無効化し、強制blocked feedbackを表示する", () => {
  const registry = new ComposerControllerRegistry();
  const owner = { kind: "auxiliary" as const, id: "aux-1" };
  registry.setPreview(owner, {
    attachments: [
      {
        id: "attachment-1",
        kind: "file",
        source: "text",
        absolutePath: "C:/workspace/README.md",
        displayPath: "README.md",
        workspaceRelativePath: "README.md",
        isOutsideWorkspace: false,
      },
    ],
    errors: [],
  });
  registry.freeze();
  const html = renderToStaticMarkup(
    React.createElement(
      SessionComposerExpanded,
      createComposerTestProps({
        composerController: { owner, registry },
        forceComposerBlockedFeedback: true,
        isAgentPickerOpen: true,
      }),
    ),
  );
  const renderedDocument = new JSDOM(html).window.document;
  for (const selector of [
    ".composer-attachments-toolbar button",
    'button[aria-label="Custom Agent: Agent"]',
    'button[title="Skill"]',
    'button[title="Template"]',
    ".composer-additional-directory-toolbar button",
    '.composer-setting-model button[aria-label="Model"]',
    ".composer-setting-depth select",
  ]) {
    const controls = Array.from(
      renderedDocument.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
        selector,
      ),
    );
    assert.ok(controls.length > 0, selector);
    assert.ok(
      controls.every((control) => control.disabled),
      selector,
    );
  }
  const agentTrigger = renderedDocument.querySelector(
    'button[aria-label="Custom Agent: Agent"]',
  );
  assert.equal(agentTrigger?.getAttribute("aria-expanded"), "false");
  assert.equal(
    renderedDocument.querySelector(
      '[role="listbox"][aria-label="Custom Agent Options"]',
    ),
    null,
  );
  const feedback = renderedDocument.querySelector(
    "#composer-sendability-feedback",
  );
  const textarea = renderedDocument.querySelector("textarea");
  assert.equal(textarea?.disabled, true);
  assert.equal(feedback?.textContent, "Message is empty.");
  assert.match(
    textarea?.getAttribute("aria-describedby") ?? "",
    /composer-sendability-feedback/,
  );
});

// @test-value v2
// kind = "contract"
// claim = "latest commandがないright paneはempty shellを維持する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "latest commandがない状態でempty shellが表示されない"
// observable = "right paneのempty shell markup"
// observation_boundary = "component-behavior"
// scope = "session-context-pane-empty-command"
// lifecycle = "permanent"
// @end-test-value
/** 最後のコマンドが取得できないときも、コンテキストペインの空の枠を残す。 */
test("SessionContextPane は latest command がないとき empty shell を維持する", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionContextPane, {
      activeContextPaneTab: "latest-command",
      availableContextPaneTabs: ["latest-command"],
      contextPaneProjection: buildContextPaneProjection({
        activeContextPaneTab: "latest-command",
        latestCommandView: null,
        backgroundTasks: [],
      }),
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
      /** タブの切替を起こさず、コマンドなしの初期表示だけを調べる。 */
      onCycleContextPaneTab() {},
    }),
  );

  assert.match(html, /command-monitor-empty-shell/);
});
