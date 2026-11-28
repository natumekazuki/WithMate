import { readStylesheet } from "../support/read-stylesheet.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ChatDockSplitter,
  ConcurrentChatSplitter,
  ChatAdditionalDirectoryList,
  ChatSkillPickerPanel,
  ChatWindow,
  ChatWindowStatusScreen,
  filterChatSkillItems,
  type ChatWindowProps,
} from "../../src/chat/chat-window.js";
import {
  createHiddenControlsTextChatComposerProps,
  createStaticChatHeaderProps,
  createStaticTextChatCompactActionDockProps,
  createStaticTextConversationMessageColumnProps,
} from "../../src/chat/chat-window-adapter.js";
import { SessionChatScreen } from "../../src/chat/shell/session-header.js";
import { SessionSwitcher } from "../../src/chat/session-switcher.js";
import { ComposerControllerRegistry } from "../../src/chat/composer-controller.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import {
  DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
  getShortcutDispatcher,
  SHORTCUT_COMMAND_IDS,
  updateShortcutBinding,
} from "../../src/settings/shortcut-registry.js";

/** 検証対象でない UI の操作に副作用を起こさない共通スタブ。 */
const noop = () => {};

/** Chat の描画に必要なメディアクエリを固定した JSDOM を用意する。 */
function createChatDom(...args: ConstructorParameters<typeof JSDOM>) {
  const dom = new JSDOM(...args);
  dom.window.matchMedia = (query) =>
    Object.assign(new dom.window.EventTarget(), {
      matches: false,
      media: query,
      onchange: null,
      addListener: noop,
      removeListener: noop,
    });
  return dom;
}

// @test-value v2
// kind = "contract"
// claim = "Main一覧は自分の実行中Turnの確定所属だけにリングを出し、別枠閲覧・子だけの実行・予約・完了では移動や残留をしない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#main-conversation-switcher" }
// fault = "子のrunStateまたは閲覧先でリングを出す、ALLにも出す、受付や完了を処理中と数える"
// observable = "実ChatWindowの候補行の処理中リングと状態名、閲覧選択、Main入力・応答の可視本文"
// observation_boundary = "component-behavior"
// scope = "Main自身のlive Turnとキュー受付を人工IPCへ与えたSession Window"
// lifecycle = "permanent"
// impact = "利用者が応答中の会話を誤認して別スレッドの続きを送る"
// distinction = "共有Switcherの外観や並び順の単体確認ではMain実行・受理・表示所属の接合を検知できない"
// @end-test-value
/** 表示先や子セッションの状態とは独立に、実行する Main の発言所属だけへ処理中のリングを付ける。 */
test("Main switcher rings only the executing Main frame independently of selection and child state", async () => {
  const dom = createChatDom("<!doctype html><div id='root'></div>", {
    pretendToBeVisual: true,
  });
  const matchMedia = dom.window.matchMedia;
  dom.window.matchMedia = (query) =>
    Object.assign(matchMedia(query), {
      matches: query.includes("prefers-reduced-motion"),
    });
  /** 仮想行の寸法を固定値で扱うためのリサイズ監視スタブ。 */
  class TestResizeObserver {
    /** 行の登録時には実際のサイズ変化を通知しない。 */ observe() {}
    /** 行の監視解除で外部状態を変更しない。 */ unobserve() {}
    /** 描画破棄時には監視元への接続がないので処理しない。 */ disconnect() {}
  }
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
    ResizeObserver: TestResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  dom.window.HTMLElement.prototype.scrollIntoView = noop;
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value: noop },
    detachEvent: { configurable: true, value: noop },
    offsetHeight: {
      /** 仮想行と描画領域を別の高さとして測定させる。 */ get(
        this: HTMLElement,
      ) {
        return this.classList.contains("session-message-virtual-row")
          ? 72
          : 720;
      },
    },
    offsetWidth: {
      /** スイッチャーと本文に必要な固定のビューポート幅を返す。 */ get: () =>
        850,
    },
    clientHeight: { /** 初期表示に十分な高さを固定する。 */ get: () => 720 },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const props = createChatWindowProps({ messages: [] });
  const main = {
    kind: "main" as const,
    sessionId: "main",
    incarnationId: "main-inc",
  };
  const a = { kind: "main" as const, sessionId: "a", incarnationId: "a-inc" };
  const b = { kind: "main" as const, sessionId: "b", incarnationId: "b-inc" };
  /** 子の表示名と処理中フラグを独立に指定できる会話候補を作る。 */
  const thread = (target: typeof a, title: string, isProcessing = false) => ({
    target,
    title,
    isProcessing,
    inboundTurnIds: [],
    sentMessageIndexes: [],
    messageIndexes: [],
  });
  const projection = {
    ok: true,
    initialMessageIndexes: [],
    children: [thread(a, "Peer Alpha"), thread(b, "Peer Beta", true)],
  };
  const request = {
    clientRequestId: "draft-a",
    userMessage: "Affinity input",
    mainConversationFrame: a,
    executionOptions: {
      model: "model",
      reasoningEffort: "medium",
      approvalMode: "on-request",
      codexSandboxMode: "read-only",
      codexSpeed: "standard",
      codexReviewer: "user",
      customAgentName: "",
    },
  } as const;
  const captured = {
    request,
    provider: "codex",
    workspacePath: "fixture",
    attachments: [],
    origin: {
      kind: "gui" as const,
      operation: "send" as const,
      targetSessionId: main.sessionId,
      targetIncarnationId: main.incarnationId,
    },
  };
  const item: SessionTurnQueueReceipt = {
    sessionId: main.sessionId,
    incarnationId: main.incarnationId,
    id: "receipt-a",
    requestId: request.clientRequestId,
    state: "queued",
    sequence: 1,
    queuePosition: 1,
    captured,
    accepted: captured,
    turnId: null,
    userMessageSeq: null,
    reason: null,
    releasedAt: null,
    createdAt: "",
    updatedAt: "",
  };
  let receipts: SessionTurnQueueReceipt[] = [];
  let terminal: SessionTurnQueueReceipt | null = null;
  let changed: ((id: string) => void) | undefined;
  let live: LiveSessionRunState | null = null;
  const api = {
    /** 会話の所属だけを既知の投影から返し、そのほかの実行情報は空にする。 */
    readSessionExecution: async (_owner: string, operation: string) =>
      operation === "read_conversation_threads"
        ? projection
        : { ok: true, items: [], nextCursor: null },
    /** Main の保存済み本文を空にし、待機列とライブ応答だけを観測する。 */
    getConversationPage: async () => ({
      sessionId: main.sessionId,
      incarnationId: main.incarnationId,
      startIndex: 0,
      totalCount: 0,
      messages: [],
    }),
    /** 待機・実行への変更を反映した最新の受付一覧を返す。 */
    listSessionTurnQueue: async () => receipts,
    /** 終端に到達した項目だけ、その要求 ID に対応する受付を返す。 */
    getSessionTurnQueueReceipt: async (_id: string, requestId: string) =>
      terminal?.requestId === requestId ? terminal : null,
    /** 待機列の更新通知を発行できるよう購読を捕捉し、解除時に取り除く。 */
    onSessionTurnQueueChanged: (listener: (id: string) => void) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
  };
  Object.defineProperty(dom.window, "withmate", { value: api });
  /** Main のライブ状態と選択候補を使って、実際の Chat ウィンドウを描画する。 */
  const render = () =>
    React.createElement(ChatWindow, {
      ...props,
      concurrentChats: {
        main: {
          ...props.messageColumnProps,
          sessionId: main.sessionId,
          inputReadContext: { ownerSessionId: main.sessionId, target: main },
        },
        mainSession: {
          id: main.sessionId,
          incarnationId: main.incarnationId,
          runState: "running",
          messages: [],
        },
        mainLiveRun: live,
        auxiliary: null,
        target: "main",
        widthRatio: 0,
        auxiliaryItems: [],
        selectedAuxiliaryId: null,
        onSelectAuxiliary: noop,
        onTargetChange: noop,
        onWidthRatioChange: noop,
        api,
      },
    });
  /** Main の発言所属を選択する現在のスイッチャーを取得する。 */
  const switcher = () =>
    dom.window.document.querySelector<HTMLButtonElement>(
      ".main-thread-header .session-switcher-current",
    )!;
  /** スイッチャーが開いていれば所属候補を選択肢として取得する。 */
  const readOptions = () =>
    Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".main-thread-header [role=option]",
      ),
    );
  /** 処理状態や補助情報を含めず、候補の表示名だけを読む。 */
  const label = (node: HTMLButtonElement) =>
    node.querySelector(".session-switcher-option-label")?.textContent?.trim();
  /** 処理中リングが付いた候補の表示名を集める。 */
  const optionsWithRing = () =>
    readOptions()
      .filter((node) => node.querySelector(".session-switcher-processing-ring"))
      .map(label);
  /** 必要なら一覧を開き、指定した表示名の所属をクリックする。 */
  const select = async (title: string) => {
    if (readOptions().length === 0) await act(async () => switcher().click());
    const option = readOptions().find((node) => label(node) === title);
    assert.ok(option);
    await act(async () => option.click());
  };
  const active: LiveSessionRunState = {
    sessionId: main.sessionId,
    sessionTurnId: "10",
    runState: "running",
    threadId: "provider",
    assistantText: "Delayed response for Alpha",
    steps: [],
    backgroundTasks: [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
    queueReceipt: {
      id: item.id,
      incarnationId: item.incarnationId,
      userMessageSeq: 0,
    },
  };
  /** 遅延して表示されるライブ応答を、上限付きで待つ。 */
  const waitForPresentedResponse = async () => {
    for (let attempts = 0; attempts < 12; attempts += 1) {
      if (dom.window.document.body.textContent?.includes(active.assistantText))
        return;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
    assert.match(
      dom.window.document.body.textContent ?? "",
      /Delayed response for Alpha/,
    );
  };
  try {
    await act(async () => root.render(render()));
    await act(async () => switcher().click());
    assert.deepEqual(optionsWithRing(), [], "Beta alone is running");
    receipts = [item];
    await act(async () => changed?.(main.sessionId));
    assert.deepEqual(
      optionsWithRing(),
      [],
      "a queued prompt is not an executing Turn",
    );
    await select("Peer Beta");
    receipts = [{ ...item, state: "running", turnId: "10", userMessageSeq: 0 }];
    live = active;
    await act(async () => {
      changed?.(main.sessionId);
      root.render(render());
    });
    assert.doesNotMatch(
      dom.window.document.body.textContent ?? "",
      /Affinity input|Delayed response for Alpha/,
    );
    await act(async () => switcher().click());
    assert.deepEqual(optionsWithRing(), ["Peer Alpha"]);
    assert.equal(
      readOptions().find((node) => node.textContent?.includes("Peer Alpha"))
        ?.title,
      "Processing",
    );
    assert.equal(
      readOptions()
        .find((node) => node.textContent?.includes("Peer Beta"))
        ?.getAttribute("aria-selected"),
      "true",
    );
    await select("Peer Alpha");
    assert.match(dom.window.document.body.textContent ?? "", /Affinity input/);
    await waitForPresentedResponse();
    await select("ALL");
    await waitForPresentedResponse();
    assert.equal(
      (
        dom.window.document.body.textContent?.match(
          /Delayed response for Alpha/g,
        ) ?? []
      ).length,
      1,
    );
    await act(async () => switcher().click());
    assert.deepEqual(optionsWithRing(), ["Peer Alpha"]);
    live = { ...active, runState: "idle", assistantText: "" };
    terminal = { ...receipts[0], state: "completed" };
    receipts = [];
    await act(async () => {
      changed?.(main.sessionId);
      root.render(render());
    });
    assert.deepEqual(
      optionsWithRing(),
      [],
      "completed Main must lose its ring even before its summary refreshes",
    );
    live = {
      ...active,
      sessionTurnId: "11",
      queueReceipt: undefined,
      assistantText: "Initial response",
    };
    await act(async () => root.render(render()));
    assert.deepEqual(optionsWithRing(), [props.headerProps.taskTitle]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "queue対応Composerは実行中も次依頼の作成操作と設定選択を使え、read-only/close凍結なら変更を拒否する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dockの次依頼編集と実行設定" }
// fault = "runningだけで入力作成を抑止する、または凍結・read-onlyでも設定やtoolbar操作を許す"
// observable = "実Composerのbutton/select disabled、toolbar callback、Approvalの選択callback"
// observation_boundary = "component-behavior"
// scope = "queue Composer preparation controls"
// lifecycle = "permanent"
// impact = "実行待ちに次依頼を準備できなくなるか、終了処理中やread-onlyの入力を変更できる"
// distinction = "backend selection testsではComposerのnative control抑止とcallback到達を検出できない"
// @end-test-value
/** 実行中は次の依頼を準備でき、閲覧専用や凍結時は同じ操作を無効化する。 */
test("実行中のqueue Composerで次依頼を準備し、read-onlyと凍結は編集を止める", async () => {
  const dom = createChatDom(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { pretendToBeVisual: true },
  );
  const globals = [
    "window",
    "document",
    "HTMLElement",
    "Node",
    "navigator",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const previous = globals.map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  const values = [
    dom.window,
    dom.window.document,
    dom.window.HTMLElement,
    dom.window.Node,
    dom.window.navigator,
    true,
  ];
  globals.forEach((key, index) =>
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: values[index],
    }),
  );
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    /** 入力のフォーカス取得で React の旧イベント互換処理を通しても副作用を起こさない。 */ value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    /** 入力のフォーカス解除で実環境固有のイベント解除を要求しない。 */ value() {},
  });
  const registry = new ComposerControllerRegistry();
  const events: string[] = [];
  const props = createChatWindowProps({ messages: [] });
  props.composerProps = {
    ...props.composerProps,
    isRunning: true,
    onQueueTurn: noop,
    composerController: {
      owner: { kind: "main", id: "main" },
      registry,
      initialDraft: "next request",
    },
    canSelectCustomAgent: true,
    showAttachmentControls: true,
    showCustomAgentPicker: true,
    showSkillPicker: true,
    showPromptTemplateButton: true,
    showAdditionalDirectoryControls: true,
    showExecutionModeControls: true,
    selectedApprovalMode: "safety-focused",
    approvalOptions: [
      { value: "safety-focused", label: "Safety Focused" },
      { value: "auto-run", label: "Auto Run" },
    ],
    sandboxOptions: [{ value: "workspace-write", label: "Workspace Write" }],
    speedOptions: [{ value: "standard", label: "Standard" }],
    /** テンプレート起動が実操作から呼ばれたことを記録する。 */
    onOpenPromptTemplates: () => events.push("template"),
    /** スキル選択を開く操作の到達を記録する。 */ onToggleSkillPicker: () =>
      events.push("skill"),
    /** カスタムエージェント選択ボタンの呼び出しを記録する。 */
    onToggleAgentPicker: () => events.push("agent"),
    /** ディレクトリ追加を後続依頼の準備中にも行えるか記録する。 */ onAddAdditionalDirectory:
      () => {
        events.push("directory");
      },
    /** 追加したディレクトリは有効なものとして扱う。 */
    onValidateAdditionalDirectory: async () => ({ valid: true }),
    /** 承認モードの選択値が Composer から届いたことを記録する。 */
    onChangeApprovalMode: (value) => events.push(value),
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  /** 表示モードや取消を除いた、入力作成と実行設定の操作群を取得する。 */
  const controls = () =>
    [
      ...dom.window.document.querySelectorAll<
        HTMLButtonElement | HTMLSelectElement
      >(
        ".composer-attachments-toolbar button:not(.composer-message-view-mode-button), .composer-settings select",
      ),
    ].filter(
      (element) =>
        element.getAttribute("aria-label") !== "Additional Directories: 0" &&
        !element.closest(".session-action-dock-cancel-slot"),
    );
  try {
    await act(async () => root.render(React.createElement(ChatWindow, props)));
    assert.ok(controls().length >= 10);
    assert.ok(controls().every((element) => !element.disabled));
    for (const label of ["Template", "Skill", "Agent", "Add Directory"]) {
      const button = [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((element) => element.textContent === label)!;
      await act(async () => button.click());
    }
    assert.deepEqual(events, ["template", "skill", "agent", "directory"]);
    const approval = dom.window.document.querySelector<HTMLSelectElement>(
      '[aria-label="Approval"]',
    )!;
    await act(async () => {
      approval.value = "auto-run";
      approval.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(events.at(-1), "auto-run");
    props.composerProps.composerBlocked = true;
    await act(async () => root.render(React.createElement(ChatWindow, props)));
    assert.ok(controls().every((element) => element.disabled));
    props.composerProps.composerBlocked = false;
    await act(async () => root.render(React.createElement(ChatWindow, props)));
    await act(async () => registry.freeze());
    assert.ok(controls().every((element) => element.disabled));
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!
        .disabled,
      true,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((key, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Prompt/Terminal切替はPreview/Sourceの右に置かれ、非表示入力をinertにしてdraft・selection・Terminal subtreeを保持し、compactから同じPromptを選んでもfocusし、quota入口を表示中の操作列へ1件だけ配置し、Attachとエラー詳細は非表示化で閉じ、Main/Auxiliary切替はAttachとModelを閉じる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock Prompt / Terminal切替" }
// fault = "mode切替で入力やTerminal subtreeを再mountする、非表示入力を操作可能に残す、Prompt復帰時にfocus・selectionを失う、quota入口を非表示面へ置くか複数mountする、非表示または別ownerのComposerのpickerや診断を開いたまま残すか診断内容を失う"
// observable = "switchのDOM順序・aria-pressed、入力surfaceのinert、textarea同一性・値・selection・focus、Terminal subtreeの同一性、quota入口の所属surfaceと件数、Attachのaria-expandedとmenuの有無、Model comboboxの有無、エラー詳細dialogの有無と再open時の本文"
// observation_boundary = "component-behavior"
// scope = "chat-window-action-dock-mode"
// lifecycle = "permanent"
// impact = "切替で作業中の入力を失うか、見えていない入力先を操作する。pickerの閉鎖は非表示または別会話の設定・添付先を操作しないための継続契約である"
// distinction = "registry testとは異なり実ChatWindowのmode button操作と保持境界を確認し、pointer外側dismissを通さず非表示化によるAttach閉鎖を確認する。PTY process自体の保持は主張しない"
// @end-test-value
/** ドックを切り替えても入力と Terminal の要素を保持し、表示に合わせてフォーカスと補助操作を切り替える。 */
test("Prompt/Terminal切替は両入力を保持し、Promptへfocusを戻す", async () => {
  const dom = createChatDom(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  const globals = [
    "window",
    "document",
    "HTMLElement",
    "Node",
    "navigator",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const previous = globals.map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  const values = [
    dom.window,
    dom.window.document,
    dom.window.HTMLElement,
    dom.window.Node,
    dom.window.navigator,
    true,
  ];
  globals.forEach((key, index) =>
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: values[index],
    }),
  );
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    /** JSDOM の入力フォーカスが旧イベント API を要求しても登録処理を行わない。 */ value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    /** 旧イベント API の解除を無操作にして、実際のフォーカス遷移を検証する。 */ value() {},
  });
  let root: Root | null = null;
  const registry = new ComposerControllerRegistry();
  /** 入力モード、ドック展開、Main と Auxiliary の切り替えを状態付きで再現する。 */
  function Harness() {
    const [mode, setMode] = React.useState<"prompt" | "terminal">("prompt");
    const [expanded, setExpanded] = React.useState(true);
    const [auxiliary, setAuxiliary] = React.useState(false);
    const props = createChatWindowProps({ messages: [] });
    props.composerProps.draft = "draft to retain";
    props.composerProps.showAttachmentControls = true;
    props.composerProps.submissionError =
      "Submission failed; retain this diagnostic.";
    props.composerProps.composerController = {
      owner: auxiliary
        ? { kind: "auxiliary", id: "auxiliary" }
        : { kind: "main", id: "main" },
      registry,
      initialDraft: "draft to retain",
    };
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "button",
        {
          "data-collapse-dock": true,
          /** 表示中のドックを本体のモード変更と別に折りたたむ。 */ onClick:
            () => setExpanded(false),
        },
        "Collapse dock",
      ),
      React.createElement(
        "button",
        {
          "data-switch-owner": true,
          /** 現在の Composer の所有者を別会話に変更する。 */ onClick: () =>
            setAuxiliary((value) => !value),
        },
        "Switch owner",
      ),
      React.createElement(ChatWindow, {
        ...props,
        isActionDockExpanded: expanded,
        actionDockModeControl: {
          mode,
          /** 選んだ入力モードへ遷移し、折りたたまれていればドックを展開する。 */ onChange:
            (value) => {
              setMode(value);
              setExpanded(true);
            },
        },
        terminalContent: React.createElement(
          "div",
          { "data-terminal-subtree": true },
          "Terminal",
        ),
        providerQuota: React.createElement(
          "button",
          { "aria-label": "Quota details" },
          "i",
        ),
      }),
    );
  }
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root")!);
      root.render(React.createElement(Harness));
    });
    const document = dom.window.document;
    const promptSurface = document.querySelector<HTMLElement>(
      ".session-action-dock-expanded-content",
    )!;
    const terminalSurface = document.querySelector<HTMLElement>(
      ".session-action-dock-terminal-content",
    )!;
    const terminal = document.querySelector("[data-terminal-subtree]")!;
    const textarea = promptSurface.querySelector("textarea")!;
    /** 使用枠の操作が一つだけ存在し、表示中で inert でない操作列にあることを確認する。 */
    const assertQuotaSurface = (surface: Element) => {
      const buttons = document.querySelectorAll('[aria-label="Quota details"]');
      assert.equal(buttons.length, 1);
      assert.ok(surface.contains(buttons[0]));
      assert.equal(buttons[0].closest("[inert]"), null);
    };
    assertQuotaSurface(
      promptSurface.querySelector(".composer-attachments-toolbar")!,
    );
    textarea.focus();
    textarea.setSelectionRange(2, 7);
    const switchGroup = promptSurface.querySelector(
      '[aria-label="Action dock mode"]',
    )!;
    assert.equal(
      switchGroup.previousElementSibling?.textContent,
      "PreviewSource",
    );
    const buttons = switchGroup.querySelectorAll("button");
    assert.equal(buttons[0].getAttribute("aria-pressed"), "true");
    assert.equal(terminalSurface.hasAttribute("inert"), true);
    const attach = promptSurface.querySelector<HTMLButtonElement>(
      '[aria-label="Attach"]',
    )!;
    await act(async () => attach.click());
    assert.equal(attach.getAttribute("aria-expanded"), "true");
    assert.ok(document.querySelector(".composer-attachment-menu"));
    await act(async () => buttons[1].click());
    assert.equal(document.querySelector(".composer-attachment-menu"), null);
    assert.equal(attach.getAttribute("aria-expanded"), "false");
    assert.equal(promptSurface.hasAttribute("inert"), true);
    assert.equal(terminalSurface.hasAttribute("inert"), false);
    assertQuotaSurface(
      terminalSurface.querySelector(".session-action-dock-compact-row")!,
    );
    assert.equal(document.querySelector("[data-terminal-subtree]"), terminal);
    assert.equal(
      terminalSurface
        .querySelectorAll('[aria-label="Action dock mode"] button')[1]
        .getAttribute("aria-pressed"),
      "true",
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>("[data-collapse-dock]")!
        .click(),
    );
    assertQuotaSurface(
      document.querySelector(".session-action-dock-compact-content")!,
    );
    const compactTerminal = document.querySelector<HTMLButtonElement>(
      '.session-action-dock-compact-content [aria-label="Action dock mode"] button:last-child',
    )!;
    await act(async () => compactTerminal.click());
    assert.equal(terminalSurface.hasAttribute("inert"), false);
    assert.equal(
      terminalSurface.querySelector('[aria-label="Action dock mode"]'),
      terminalSurface.querySelector('[aria-label="Message display mode"]')
        ?.nextElementSibling,
    );
    assert.equal(document.querySelector("[data-terminal-subtree]"), terminal);
    await act(async () =>
      terminalSurface
        .querySelector<HTMLButtonElement>(
          '[aria-label="Action dock mode"] button',
        )!
        .click(),
    );
    assert.equal(promptSurface.hasAttribute("inert"), false);
    assert.equal(document.querySelector(".composer-attachment-menu"), null);
    assertQuotaSurface(
      promptSurface.querySelector(".composer-attachments-toolbar")!,
    );
    assert.equal(terminalSurface.hasAttribute("inert"), true);
    assert.equal(promptSurface.querySelector("textarea"), textarea);
    assert.equal(textarea.value, "draft to retain");
    assert.equal(textarea.selectionStart, 2);
    assert.equal(textarea.selectionEnd, 7);
    assert.equal(document.activeElement, textarea);
    assert.equal(document.querySelector("[data-terminal-subtree]"), terminal);
    await act(async () => attach.click());
    assert.equal(attach.getAttribute("aria-expanded"), "true");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>("[data-collapse-dock]")!
        .click(),
    );
    assert.equal(document.querySelector(".composer-attachment-menu"), null);
    const compactPrompt = document.querySelector<HTMLButtonElement>(
      '.session-action-dock-compact-content [aria-label="Action dock mode"] button',
    )!;
    compactPrompt.focus();
    await act(async () => compactPrompt.click());
    assert.equal(attach.getAttribute("aria-expanded"), "false");
    assert.equal(document.querySelector(".composer-attachment-menu"), null);
    assert.equal(document.activeElement, textarea);
    assert.equal(textarea.selectionStart, 2);
    assert.equal(textarea.selectionEnd, 7);
    /** テスト用の操作から実際に入力対象を切り替える。 */
    const switchOwner = async () =>
      act(async () =>
        document
          .querySelector<HTMLButtonElement>("[data-switch-owner]")!
          .click(),
      );
    await act(async () => attach.click());
    assert.equal(attach.getAttribute("aria-expanded"), "true");
    await switchOwner();
    assert.equal(document.querySelector(".composer-attachment-menu"), null);
    await switchOwner();
    assert.equal(attach.getAttribute("aria-expanded"), "false");
    const model = promptSurface.querySelector<HTMLButtonElement>(
      '[aria-label="Model"]',
    )!;
    await act(async () => model.click());
    assert.ok(document.querySelector('[role="combobox"]'));
    await switchOwner();
    assert.equal(document.querySelector('[role="combobox"]'), null);
    await switchOwner();
    assert.equal(document.querySelector('[role="combobox"]'), null);
    const details = promptSurface.querySelector<HTMLButtonElement>(
      '[aria-label="Message Submission Error Details"]',
    )!;
    await act(async () => details.click());
    assert.ok(
      document.querySelector(
        '[role="dialog"][aria-label="Message Submission Error Details"]',
      ),
    );
    await act(async () => buttons[1].click());
    assert.equal(
      document.querySelector(
        '[role="dialog"][aria-label="Message Submission Error Details"]',
      ),
      null,
    );
    await act(async () =>
      terminalSurface
        .querySelector<HTMLButtonElement>(
          '[aria-label="Action dock mode"] button',
        )!
        .click(),
    );
    assert.equal(details.getAttribute("aria-expanded"), "false");
    await act(async () => details.click());
    assert.match(
      document.querySelector(
        '[role="dialog"][aria-label="Message Submission Error Details"]',
      )!.textContent!,
      /Submission failed; retain this diagnostic/,
    );
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    globals.forEach((key, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});

/** 静的なヘッダー、発言列、入力とドックを共通の初期状態から用意する。 */
function createChatWindowProps(
  overrides: Partial<ChatWindowProps["messageColumnProps"]> = {},
): ChatWindowProps {
  const draft = "";
  return {
    mode: "agent",
    headerSplitter: null,
    actionDockSplitter: null,
    rightPane: null,
    splitter: null,
    isHeaderExpanded: true,
    headerProps: createStaticChatHeaderProps({
      taskTitle: "Test chat",
      isRunning: false,
    }),
    messageColumnProps: createStaticTextConversationMessageColumnProps({
      sessionId: "chat-1",
      characterId: "character-1",
      characterName: "Character",
      characterIconPath: "",
      messages: [
        { role: "mate", text: "[label](https://example.test/source)" },
      ],
      messageListRef: React.createRef<HTMLDivElement>(),
      isRunning: false,
      onQuoteMessageText: noop,
      ...overrides,
    }),
    isActionDockExpanded: true,
    composerProps: createHiddenControlsTextChatComposerProps({
      draft,
      isRunning: false,
      feedback: "",
      composerTextareaRef: React.createRef<HTMLTextAreaElement>(),
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
    }),
    compactActionDockProps: createStaticTextChatCompactActionDockProps({}),
  };
}

/** 同じ画像参照を含む二つの列を同時表示し、挿入される下書きを公開する。 */
function ConcurrentImageChatHarness({
  baseProps,
}: {
  baseProps: ChatWindowProps;
}) {
  const [draft, setDraft] = React.useState("");
  const mainMessageListRef = React.useRef<HTMLDivElement>(null);
  const auxiliaryMessageListRef = React.useRef<HTMLDivElement>(null);
  const messages = baseProps.messageColumnProps.messages;
  /** 列ごとの会話 ID とスクロール領域に、同一の発言内容を割り当てる。 */
  const createColumnProps = (
    sessionId: string,
    messageListRef: React.RefObject<HTMLDivElement | null>,
  ) => ({
    ...baseProps.messageColumnProps,
    sessionId,
    messages,
    messageListRef,
    /** 画像プレビュー操作から外部のパスを実際に開かない。 */
    onOpenPath: (_target: string) => undefined,
  });

  return React.createElement(
    React.Fragment,
    null,
    React.createElement("output", { "data-draft-state": true }, draft),
    React.createElement(ChatWindow, {
      ...baseProps,
      composerProps: {
        ...baseProps.composerProps,
        draft,
        /** 画像参照を差し込んだ直後の入力文を描画に反映する。 */
        onDraftChange: (value: string) => setDraft(value),
      },
      concurrentChats: {
        mainSession: { id: "main", messages },
        auxiliarySession: { id: "auxiliary", messages },
        main: createColumnProps("main", mainMessageListRef),
        auxiliary: createColumnProps("auxiliary", auxiliaryMessageListRef),
        selectedAuxiliaryId: "auxiliary",
        auxiliaryItems: [
          { id: "auxiliary", label: "Auxiliary", preview: "Auxiliary" },
        ],
        target: "main",
        widthRatio: 0.5,
        scrollToLatestOnSend: true,
        /** この二列テストでは別の Auxiliary を選ばない。 */
        onSelectAuxiliary() {},
        /** 画像操作中の送信先を Main に固定する。 */
        onTargetChange() {},
        /** 二列の幅比率は固定したまま各列の動作を観測する。 */
        onWidthRatioChange() {},
      },
    }),
  );
}

/** 準備中の文言が Session 共通シェル内のライブ領域へ描画されることを確かめる。 */
test("ChatWindowStatusScreen は Session 共通 shell で状態表示をレンダリングする", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatWindowStatusScreen, {
      message: "準備しています。",
    }),
  );

  assert.match(html, /<main class="page-shell session-page">/);
  assert.match(
    html,
    /<section class="session-work-surface chat-panel" aria-live="polite">/,
  );
  assert.match(html, /<p class="session-message-empty">準備しています。<\/p>/);
  assert.doesNotMatch(html, /session-plain/);
});

// @test-value v2
// kind = "contract"
// claim = "中央Preview中のcompact ActionDockでも前回依頼のResend/EditをDock内に提供する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: terminal state 後の再送導線" }
// fault = "Previewかcompact表示で回復操作を隠すかDock外へ切り離す"
// observable = "Previewとcompact Dock内の対象付きaccessible nameを持つResend/Edit button"
// observation_boundary = "component-behavior"
// scope = "chat-window-compact-preview-recovery"
// lifecycle = "permanent"
// @end-test-value
/** 中央にプレビューを開いてドックを畳んでも、前回依頼の再送と編集を利用できる。 */
test("ChatWindow は preview と compact ActionDock 内に recovery actions を維持する", () => {
  const props = createChatWindowProps();
  props.mainContent = React.createElement("div", null, "File Preview");
  props.recoveryActions = {
    retryState: { kind: "interrupted", lastRequestText: "Retry this request" },
    requestKey: "main:incarnation:0",
    targetLabel: "Main",
    isRetryActionDisabled: false,
    isRetryEditDisabled: false,
    isRetryDraftReplacePending: false,
    /** 静的に表示する再送ボタンから実際の Send を発行しない。 */
    onResendLastMessage() {},
    /** 編集ボタンの描画だけを確かめ、下書きの内容は置き換えない。 */ onEditLastMessage() {},
    /** 再送用の本文への置き換え確定処理は、この描画には必要ない。 */ onConfirmRetryDraftReplace() {},
    /** 置換確認を取り消す操作はこの静的テストでは実行しない。 */ onCancelRetryDraftReplace() {},
  };
  props.isActionDockExpanded = false;

  const html = renderToStaticMarkup(React.createElement(ChatWindow, props));

  assert.match(
    html,
    /id="session-action-dock"[^>]*class="session-action-dock-slot is-compact"/,
  );
  const dom = new JSDOM(html);
  const dock = dom.window.document.querySelector("#session-action-dock")!;
  assert.ok(
    dock.querySelector('[aria-label="Main: Previous Request Actions"]'),
  );
  assert.ok(
    dock.querySelector('button[aria-label="Main: Resend Previous Request"]'),
  );
  assert.ok(
    dock.querySelector('button[aria-label="Main: Edit Previous Request"]'),
  );
  dom.window.close();
});

// @test-value v2
// kind = "contract"
// claim = "会話が隠れている間の会話通知は、Prompt展開・compact・Terminal展開と実行中・停止中のどの組合せでも、表示中の操作列の先頭に1つだけ全状態を含む名前で描画され、読み上げは単一のlive regionに限られ、会話表示中は可視通知を出さない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/896: 表示場所・状態の扱いを共通化する; 支援技術への通知を一元化する" }
// fault = "停止中のTerminal展開など特定のDockモードで通知が欠落する、モードや実行状態で通知の位置が変わる、非表示の行にも通知を重複描画する、代表表示で別の状態を名前から落とす、live regionを複数置く、または会話が見えているのに通知を出す"
// observable = "各組合せのChatWindow静的DOMにおける会話通知buttonの件数・所属する表示中Dock行・操作列内の先頭位置・accessible name・title、通知用live regionの件数と文言"
// observation_boundary = "component-behavior"
// scope = "chat-window conversation attention placement"
// lifecycle = "permanent"
// impact = "Graph全体表示やPreview中に承認・質問を見落とす、またはDockの状態で通知の探し場所が変わる"
// distinction = "SessionActionDockCompactRow単体testではChatWindowが表示中の行だけへ通知を渡すことと停止中Terminal展開の経路を観測できない"
// @end-test-value
/** 会話が非表示のときだけ、全ドックモードで統合通知を操作列の先頭と単一のライブ領域へ配置する。 */
test("ChatWindow は会話非表示時の通知を全Dockモードで表示中の操作列の先頭に1つだけ置く", () => {
  const label = "Main: Approval required, New messages. Show Chat";
  for (const [mode, expanded] of [
    ["prompt", true],
    ["prompt", false],
    ["terminal", true],
  ] as const) {
    for (const isRunning of [false, true]) {
      for (const isConversationHidden of [true, false]) {
        const props = createChatWindowProps();
        props.mainContent = isConversationHidden
          ? React.createElement("div", null, "File Preview")
          : undefined;
        props.isActionDockExpanded = expanded;
        props.actionDockModeControl = { mode, onChange: noop };
        props.terminalContent = React.createElement("div", {
          className: "test-terminal",
        });
        props.composerProps = { ...props.composerProps, isRunning };
        props.compactActionDockProps = {
          ...props.compactActionDockProps,
          isRunning,
        };
        props.conversationAttention = {
          targetLabel: "Main",
          entries: [
            { kind: "new-messages", key: "main:new-messages" },
            { kind: "approval", key: "main:approval:1" },
          ],
          isConversationHidden,
          onShowConversation: noop,
        };
        const dom = new JSDOM(
          renderToStaticMarkup(React.createElement(ChatWindow, props)),
        );
        const document = dom.window.document;
        const buttons = document.querySelectorAll(
          ".conversation-attention-button",
        );
        const context = `${mode} expanded=${expanded} running=${isRunning} hidden=${isConversationHidden}`;
        const statuses = [
          ...document.querySelectorAll("#session-action-dock [role='status']"),
        ].filter((status) => status.textContent?.includes("Approval required"));
        if (!isConversationHidden) {
          assert.equal(buttons.length, 0, context);
          assert.equal(statuses.length, 0, context);
          dom.window.close();
          continue;
        }
        assert.equal(buttons.length, 1, context);
        const button = buttons[0]!;
        assert.equal(button.getAttribute("aria-label"), label, context);
        assert.equal(button.getAttribute("title"), label, context);
        assert.ok(
          button.closest(".session-action-dock-content.is-active"),
          context,
        );
        assert.equal(button.parentElement?.firstElementChild, button, context);
        assert.match(
          button.parentElement?.className ?? "",
          /composer-toolbar-view-actions|session-action-dock-compact-actions/,
          context,
        );
        assert.equal(statuses.length, 1, context);
        assert.equal(
          statuses[0]!.textContent,
          "Main: Approval required, New messages. Show the chat from the Action Dock to respond.",
          context,
        );
        dom.window.close();
      }
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "ChatWindowはcompact ActionDock時にも共通error領域と関連controlを描画する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/731: validation・回復説明を保持し、pendingとerrorを混同しない" }
// fault = "compact ActionDock時にerror surfaceまたはtextareaのinvalid関連付けが欠落するか、busy表示を誤って混ぜる"
// observable = "chat-error-surface、alert、textarea aria-describedby/aria-invalidとbusy不在、ActionDockのDOM順序"
// observation_boundary = "component-behavior"
// scope = "chat-window-error-surface"
// lifecycle = "permanent"
// impact = "path validation errorの原因と回復位置を利用者・支援技術へ伝えられなくなる"
// distinction = "単一のerror message表示ではなく、関連controlとlayout順序を同時に検証する"
// @end-test-value
/** ドックを畳んでも共通のエラーを入力欄の説明へ結び付け、待機状態とは区別する。 */
test("ChatWindow は compact ActionDock 時も共通エラー領域を描画する", () => {
  const props = createChatWindowProps();
  props.isActionDockExpanded = false;
  props.composerProps = {
    ...props.composerProps,
    composerSendability: {
      primaryFeedback: "Path not found: C:/missing",
      secondaryFeedback: ["Expected a file: C:/directory"],
      feedbackTone: "blocked",
      shouldShowFeedback: true,
    },
  };
  props.errorNotices = [
    {
      id: "composer-sendability",
      message: "Path not found: C:/missing",
      details: ["Expected a file: C:/directory"],
      relatedControl: "composer",
    },
  ];

  const html = renderToStaticMarkup(React.createElement(ChatWindow, props));

  assert.match(
    html,
    /class="chat-error-surface" role="region" aria-label="Chat error"/,
  );
  assert.match(html, /class="chat-error-notice" role="alert"/);
  assert.match(html, /Path not found: C:\/missing/);
  assert.match(html, /Expected a file: C:\/directory/);
  assert.match(
    html,
    /<textarea[^>]*aria-describedby="[^"]+-notice-0"[^>]*aria-invalid="true"/,
  );
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)?.[0] ?? "", /aria-busy/);
  assert.doesNotMatch(html, /Message submission is in progress/);
  const sendButton = new JSDOM(html).window.document.querySelector(
    ".session-send-button",
  );
  assert.ok(sendButton);
  assert.notEqual(sendButton.getAttribute("aria-busy"), "true");
  assert.equal(sendButton.querySelector(".loading-indicator-spinner"), null);
  assert.doesNotMatch(html, /class="composer-sendability-feedback blocked"/);
  assert.match(
    html,
    /id="session-action-dock"[^>]*class="session-action-dock-slot is-compact"/,
  );
  assert.ok(
    html.indexOf("session-central-surface") <
      html.indexOf("chat-error-surface"),
  );
  assert.ok(
    html.indexOf("chat-error-surface") <
      html.indexOf("session-action-dock-slot"),
  );
});

// @test-value v2
// kind = "contract"
// claim = "ChatWindowは送信待機中にSendのspinnerとcomposerのbusy statusを示し、errorとして表示しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/731" }
// fault = "送信中をerrorとして表示するか、Sendのspinner・busy statusを欠落させる"
// observable = "Send spinner、textarea aria-busy、status announcement、error surfaceの不在"
// observation_boundary = "component-behavior"
// scope = "chat-window-submit-pending"
// lifecycle = "permanent"
// impact = "利用者が送信処理中と失敗を区別できず、重複操作や誤った再試行を招く"
// distinction = "error surface testと異なり、送信中のspinnerと非表示statusを同一renderで確認する"
// @end-test-value
/** 送信待機にはボタンのスピナーと読み上げ用の状態を使い、エラーを描画しない。 */
test("ChatWindow は submit pending を非表示の busy status として通知し、エラー表示しない", () => {
  const props = createChatWindowProps({ messages: [] });
  props.composerProps = {
    ...props.composerProps,
    isComposerDisabled: true,
    queueTurnBusy: true,
    composerSendability: {
      isBusy: true,
      busyReason: "Message submission is in progress.",
      primaryFeedback: "",
      secondaryFeedback: [],
      feedbackTone: null,
      shouldShowFeedback: false,
    },
  };

  const html = renderToStaticMarkup(React.createElement(ChatWindow, props));

  assert.match(html, /<textarea[^>]*disabled=""[^>]*aria-busy="true"/);
  assert.match(
    html,
    /class="visually-hidden" role="status"[^>]*>Message submission is in progress\.<\/span>/,
  );
  const sendButton = new JSDOM(html).window.document.querySelector(
    ".session-send-button",
  );
  assert.equal(sendButton?.getAttribute("aria-busy"), "true");
  assert.ok(
    sendButton?.querySelector(".loading-indicator-spinner[aria-hidden='true']"),
  );
  assert.doesNotMatch(html, /chat-error-surface/);
  assert.doesNotMatch(html, /composer-sendability-feedback/);
});

/** Workspace の所有側で指定した閉じるボタンと再確認操作を共通エラーに描画する。 */
test("ChatWindow の共通エラー領域は owner が指定したdismissと回復操作を表示する", () => {
  const props = createChatWindowProps();
  props.errorNotices = [
    {
      id: "workspace-unavailable",
      message: "Workspace unavailable.",
      dismissLabel: "Workspaceエラーを閉じる",
      onDismiss: noop,
      actionLabel: "Recheck",
      onAction: noop,
    },
  ];

  const html = renderToStaticMarkup(React.createElement(ChatWindow, props));

  assert.match(
    html,
    /class="drawer-toggle compact secondary"[^>]*>Recheck<\/button>/,
  );
  assert.match(html, /aria-label="Workspaceエラーを閉じる"/);
});

// @test-value v2
// kind = "contract"
// claim = "ChatWindowはAdditional Directories一覧の開閉状態と対象Directoryを表示へ接続する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window: Additional Directories一覧をtoggleで開閉する" }
// fault = "一覧の入力をChatWindowへ接続せず、開いた一覧が表示されないか閉じた一覧が残る"
// observable = "開閉それぞれのrenderにおける一覧sectionの有無と対象Directory名"
// observation_boundary = "component-behavior"
// scope = "chat-window-additional-directories"
// lifecycle = "permanent"
// impact = "利用者が追加したDirectory一覧を確認または閉じられなくなる"
// distinction = "一覧component単体では検出できないChatWindowからのprops接続を確認する"
// @end-test-value
/** 追加ディレクトリの開閉を反映し、開いたときだけディレクトリ名と親パスを表示する。 */
test("ChatWindow は追加Directory一覧の開閉と対象を表示へ接続する", () => {
  const props = createChatWindowProps();
  props.isActionDockExpanded = false;
  props.additionalDirectoryListProps = {
    isOpen: true,
    items: [
      {
        key: "C:/shared/docs",
        path: "C:/shared/docs",
        primaryLabel: "docs",
        secondaryLabel: "C:/shared",
        title: "C:/shared/docs",
        canRemove: true,
      },
    ],
    isInteractionDisabled: false,
    onRemove: noop,
  };

  for (const isOpen of [true, false]) {
    props.additionalDirectoryListProps.isOpen = isOpen;
    const dom = new JSDOM(
      renderToStaticMarkup(React.createElement(ChatWindow, props)),
    );
    const list = dom.window.document.querySelector(
      'section[aria-label="Additional directories"]',
    );
    if (isOpen) {
      assert.ok(list);
      assert.equal(
        list.querySelector(".chat-additional-directory-primary")?.textContent,
        "docs",
      );
      assert.equal(
        list.querySelector(".chat-additional-directory-secondary")?.textContent,
        "C:/shared",
      );
    } else {
      assert.equal(list, null);
    }
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "追加Directory一覧は削除可能項目とreadonly項目を区別し、interaction disabledを各controlへ投影する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: AgentのFile Explorerと追加済みDirectory一覧の認可境界" }
// fault = "readonly項目を削除可能にするか、disabled状態とaccessible labelを失う"
// observable = "remove buttonのdisabled属性と対象付きaria-label、削除不可itemにbuttonがないこと"
// observation_boundary = "component-behavior"
// scope = "chat-additional-directory-list"
// lifecycle = "permanent"
// impact = "ユーザーが許可されないdirectoryを削除したり状態を判断できなくなる"
// distinction = "item単位のcanRemoveと一覧全体のinteraction disabledを同時に確認する"
// @end-test-value
/** 削除可能なディレクトリにのみボタンを出し、操作無効時はそのボタンも無効にする。 */
test("ChatAdditionalDirectoryList は削除可否とdisabled状態を投影する", () => {
  const props: React.ComponentProps<typeof ChatAdditionalDirectoryList> = {
    isOpen: true,
    items: [
      {
        key: "C:/shared/removable",
        path: "C:/shared/removable",
        primaryLabel: "removable",
        secondaryLabel: "C:/shared",
        title: "C:/shared/removable",
        canRemove: true,
      },
      {
        key: "C:/shared/allowed",
        path: "C:/shared/allowed",
        primaryLabel: "allowed",
        secondaryLabel: "C:/shared",
        title: "C:/shared/allowed",
        canRemove: false,
      },
    ],
    isInteractionDisabled: true,
    onRemove: noop,
  };

  for (const isInteractionDisabled of [true, false]) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        React.createElement(ChatAdditionalDirectoryList, {
          ...props,
          isInteractionDisabled,
        }),
      ),
    );
    const removable = dom.window.document.querySelector(
      '[title="C:/shared/removable"]',
    );
    const readonly = dom.window.document.querySelector(
      '[title="C:/shared/allowed"]',
    );
    assert.ok(removable && readonly);
    const removeButton = removable.querySelector("button");
    assert.ok(removeButton);
    assert.equal(removeButton.disabled, isInteractionDisabled);
    assert.equal(removeButton.getAttribute("aria-label"), "removable: Remove");
    assert.equal(readonly.querySelector("button"), null);
    dom.window.close();
  }
});

/** スキル選択をドック内部ではなく中央作業面の選択リストとして配置する。 */
test("ChatWindow は Skill 候補を中央 work surface overlayとして描画する", () => {
  const props = createChatWindowProps();
  props.skillPickerProps = {
    isOpen: true,
    isLoading: false,
    items: [
      {
        key: "skill-review",
        skillId: "review",
        primaryLabel: "review",
        secondaryLabel: "Workspace",
        title: "review",
      },
    ],
    onSelectSkill: noop,
    onDismiss: noop,
  };

  const html = renderToStaticMarkup(React.createElement(ChatWindow, props));

  assert.match(html, /class="chat-skill-picker-layer"/);
  assert.match(html, /role="listbox"/);
  assert.ok(
    html.indexOf("chat-skill-picker-layer") <
      html.indexOf("session-action-dock-slot"),
  );
});

// @test-value v2
// kind = "contract"
// claim = "Skill pickerはloadingとerrorを別の状態表示として描画する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗: 読込spinner/status/busyと取得失敗を分離する" }
// fault = "読み込み中を空状態またはerrorと誤表示し、spinner・busy state・error labelを失う"
// observable = "status aria-busy、spinner、error state classのDOM"
// observation_boundary = "component-behavior"
// scope = "chat-skill-picker-state"
// lifecycle = "permanent"
// impact = "候補取得の進行状況と失敗理由を利用者へ正しく伝えられなくなる"
// distinction = "同一panelのloadingとerrorをrenderして状態境界を確認する"
// @end-test-value
/** スキル一覧の取得中には busy の状態を、取得失敗には個別のエラーを描画する。 */
test("ChatSkillPickerPanel は loading・error状態を区別する", () => {
  const commonProps = {
    isOpen: true,
    items: [],
    onSelectSkill: noop,
    onDismiss: noop,
  };
  const loadingHtml = renderToStaticMarkup(
    React.createElement(ChatSkillPickerPanel, {
      ...commonProps,
      isLoading: true,
    }),
  );
  const errorHtml = renderToStaticMarkup(
    React.createElement(ChatSkillPickerPanel, {
      ...commonProps,
      isLoading: false,
      errorMessage: "Skill error",
    }),
  );

  assert.match(loadingHtml, /role="status"/);
  assert.match(loadingHtml, /aria-busy="true"/);
  assert.match(loadingHtml, /loading-indicator-spinner/);
  assert.match(loadingHtml, /class="surface-close-button"/);
  assert.match(loadingHtml, /aria-label="Close skill picker"/);
  assert.match(errorHtml, /class="chat-skill-picker-state error">Skill error/);
});

/** スキル名と説明なら検索に一致し、単なる取得元ラベルは対象外にする。 */
test("Skill候補検索はnameとdescriptionを対象にしsource labelを対象にしない", () => {
  const items = [
    {
      key: "skill-a",
      skillId: "a",
      primaryLabel: "Audit",
      secondaryLabel: "Provider · Review completed work",
      title: "Audit",
      searchText: "Audit\nReview completed work",
    },
    {
      key: "skill-b",
      skillId: "b",
      primaryLabel: "Commit",
      secondaryLabel: "Workspace · Create a commit note",
      title: "Commit",
      searchText: "Commit\nCreate a commit note",
    },
  ];

  assert.deepEqual(filterChatSkillItems(items, "audit"), [items[0]]);
  assert.deepEqual(filterChatSkillItems(items, "commit note"), [items[1]]);
  assert.deepEqual(filterChatSkillItems(items, "provider"), []);
  assert.equal(filterChatSkillItems(items, "missing").length, 0);
});

// @test-value v2
// kind = "contract"
// claim = "Skill panelは同じ候補の再取得でfocusを保持し、矢印で候補を移動しEnterで選択、Escapeで取消し、閉じると起点へfocusを戻す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock Skill picker; docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "候補のkeyboard操作または終了後のfocus復帰が機能しないか、同じ候補の再取得で候補が消えてfocusを失う"
// observable = "候補callback、開閉状態、検索入力値とactiveElement"
// observation_boundary = "component-behavior"
// scope = "ChatWindow Skill picker keyboard interaction"
// lifecycle = "permanent"
// impact = "keyboard利用者がSkillを選択または取消して入力へ戻れなくなる"
// distinction = "候補filterのunit testではChatWindow内のfocus移動とcallback接続を確認できない"
// @end-test-value
/** 候補の再取得中もフォーカスを保持し、選択または取消で起点のボタンに戻す。 */
test("ChatWindow の Skill panel は矢印・Enter・Escapeとfocus復帰を扱う", async () => {
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousResizeObserver = globalThis.ResizeObserver;
  const dom = createChatDom(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      pretendToBeVisual: true,
    },
  );
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  /** 候補一覧を描画するために、実サイズ監視を不要にする JSDOM 用の実装。 */
  class TestResizeObserver {
    /** 候補一覧の高さを測定する要求を受けてもサイズ通知は発生させない。 */
    observe() {}
    /** 候補を閉じても監視先の寸法を変更しない。 */
    unobserve() {}
    /** マウント解除時の監視終了には処理を要しない。 */
    disconnect() {}
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    /** 検索入力のフォーカスに必要な React の旧イベント登録を受け入れる。 */
    value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    /** フォーカス解除時の旧イベント解除を無操作にする。 */
    value() {},
  });
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
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });

  const selected: string[] = [];
  let dismissCount = 0;
  let root: Root | null = null;
  const items = [
    {
      key: "skill-a",
      skillId: "a",
      primaryLabel: "A",
      secondaryLabel: "Workspace · First description",
      title: "A",
      searchText: "A\nFirst description",
    },
    {
      key: "skill-b",
      skillId: "b",
      primaryLabel: "B",
      secondaryLabel: "Provider · Second description",
      title: "B",
      searchText: "B\nSecond description",
    },
  ];

  /** 同じ候補を保持したまま読込・失敗を切り替え、操作結果を記録する。 */
  function SkillPickerHarness({
    loading = false,
    errorMessage,
  }: {
    loading?: boolean;
    errorMessage?: string;
  }) {
    const [isOpen, setIsOpen] = React.useState(false);
    const props = createChatWindowProps();
    props.composerProps = {
      ...props.composerProps,
      showSkillPicker: true,
      isSkillPickerOpen: isOpen,
      /** ドックのスキルボタンに合わせてパネルを開閉する。 */
      onToggleSkillPicker: () => setIsOpen((current) => !current),
    };
    props.skillPickerProps = {
      isOpen,
      isLoading: loading,
      errorMessage,
      items,
      /** 選択されたスキルを記録してパネルを閉じる。 */
      onSelectSkill: (skillId) => {
        selected.push(skillId);
        setIsOpen(false);
      },
      /** キーボードからの取消を数え、パネルを閉じる。 */
      onDismiss: () => {
        dismissCount += 1;
        setIsOpen(false);
      },
    };
    return React.createElement(ChatWindow, props);
  }

  try {
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(React.createElement(SkillPickerHarness, {}));
    });
    const skillButton = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Skill");
    assert.ok(skillButton);

    await act(async () => skillButton.click());
    const searchInput = dom.window.document.querySelector<HTMLInputElement>(
      ".chat-skill-picker-search",
    );
    assert.ok(searchInput);
    assert.equal(dom.window.document.activeElement, searchInput);

    const options = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>(
        "[role='option']",
      ),
    );
    assert.equal(options.length, 2);

    await act(async () => {
      searchInput.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      );
    });
    assert.equal(dom.window.document.activeElement, options[0]);

    await act(async () =>
      root?.render(React.createElement(SkillPickerHarness, { loading: true })),
    );
    assert.equal(dom.window.document.activeElement, options[0]);
    await act(async () =>
      root?.render(
        React.createElement(SkillPickerHarness, {
          errorMessage: "Skill refresh failed",
        }),
      ),
    );
    assert.equal(dom.window.document.activeElement, options[0]);

    await act(async () => {
      options[0]?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      );
    });
    assert.deepEqual(selected, ["a"]);
    assert.equal(
      dom.window.document.querySelector(".chat-skill-picker-panel"),
      null,
    );
    assert.equal(dom.window.document.activeElement, skillButton);

    await act(async () => skillButton.click());
    const reopenedSearchInput =
      dom.window.document.querySelector<HTMLInputElement>(
        ".chat-skill-picker-search",
      );
    assert.ok(reopenedSearchInput);
    assert.equal(reopenedSearchInput.value, "");
    await act(async () => {
      reopenedSearchInput.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
    });
    assert.equal(dismissCount, 1);
    assert.equal(dom.window.document.activeElement, skillButton);
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
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: previousResizeObserver,
    });
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

// @test-value v2
// kind = "contract"
// claim = "compact dockの空白clickは展開し、内包する操作ボタンとexpanded dockのclickは展開を併発しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock" }
// fault = "Cancel予約領域や操作間の余白から展開できない、またはCancel・target・表示切替等の操作にも展開が混入する"
// observable = "dock各領域と内包buttonのclick後のcallback列、表示modeのaria-pressed"
// observation_boundary = "component-behavior"
// scope = "ChatWindow compact dock click routing"
// lifecycle = "permanent"
// impact = "クリック位置によって余白が反応しない、または別操作でdockが開き会話表示領域が変わる"
// distinction = "単体の展開button testでは検出できないdock外周のevent伝播と内包操作の優先を実際のChatWindowで検証する"
// @end-test-value
/** コンパクトドックの空白は展開し、内包ボタンのクリックはそのボタン固有の操作だけを行う。 */
test("ChatWindow はcompact dockの空白全体から展開し内包する操作を優先する", async () => {
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousResizeObserver = globalThis.ResizeObserver;
  const dom = createChatDom(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { pretendToBeVisual: true },
  );
  /** コンパクト領域の操作を描画するため、JSDOM に存在しない監視 API を補う。 */
  class TestResizeObserver {
    /** ドックのサイズ監視を要求してもコールバックを発火しない。 */ observe() {}
    /** 監視していない要素の登録解除は状態を変更しない。 */ unobserve() {}
    /** ドックの描画解除時に外部接続を保持しない。 */ disconnect() {}
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    /** 展開後の入力フォーカスを旧イベント登録の副作用から分離する。 */ value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    /** フォーカスを離れた際の旧イベント解除を無操作にする。 */ value() {},
  });
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
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | null = null;
  const events: string[] = [];
  const props = createChatWindowProps({ messages: [] });
  props.isActionDockExpanded = false;
  props.compactActionDockProps = {
    ...props.compactActionDockProps,
    showJumpToBottom: true,
    /** コンパクト領域そのものによる展開を記録する。 */
    onExpand: () => events.push("expand"),
    /** 取消ボタンのイベントが展開操作と重ならないか記録する。 */
    onCancel: () => events.push("cancel"),
    /** 末尾移動がドック展開を併発しないことをイベントから確認する。 */
    onJumpToBottom: () => events.push("jump"),
  };

  try {
    root = createRoot(
      dom.window.document.getElementById("root") as HTMLElement,
    );
    for (const isRunning of [false, true]) {
      props.compactActionDockProps.isRunning = isRunning;
      await act(async () =>
        root?.render(React.createElement(ChatWindow, props)),
      );
      const dock = dom.window.document.querySelector<HTMLElement>(
        ".session-action-dock",
      );
      assert.ok(dock);
      const compact = dock.querySelector<HTMLElement>(
        ".session-action-dock-compact-content",
      );
      assert.ok(compact);

      const blankRegions = [
        dock,
        compact,
        compact.querySelector<HTMLElement>(".session-action-dock-compact-row"),
        compact.querySelector<HTMLElement>(
          ".session-action-dock-compact-actions",
        ),
        compact.querySelector<HTMLElement>(
          ".session-action-dock-compact-expand-button",
        ),
      ];
      if (!isRunning) {
        blankRegions.push(
          compact.querySelector<HTMLElement>(
            ".session-action-dock-cancel-slot",
          ),
        );
      }
      for (const region of blankRegions) {
        assert.ok(region);
        events.length = 0;
        await act(async () => region.click());
        assert.deepEqual(events, ["expand"]);
      }

      const jumpButton = compact.querySelector<HTMLButtonElement>(
        ".message-jump-bottom-button",
      );
      assert.ok(jumpButton);
      events.length = 0;
      await act(async () => jumpButton.click());
      assert.deepEqual(events, ["jump"]);
      if (isRunning) {
        const cancelButton = compact.querySelector<HTMLButtonElement>(
          ".session-action-dock-cancel-slot button",
        );
        assert.ok(cancelButton);
        events.length = 0;
        await act(async () => cancelButton.click());
        assert.deepEqual(events, ["cancel"]);
      }
      for (const mode of ["Source", "Preview"]) {
        const button: HTMLButtonElement | undefined = [
          ...compact.querySelectorAll<HTMLButtonElement>(
            ".composer-message-view-mode-button",
          ),
        ].find((candidate) => candidate.textContent === mode);
        assert.ok(button);
        events.length = 0;
        await act(async () => button.click());
        assert.equal(button.getAttribute("aria-pressed"), "true");
        assert.deepEqual(events, []);
      }
    }

    props.concurrentChats = {
      main: props.messageColumnProps,
      auxiliary: null,
      auxiliarySession: { id: "auxiliary", runState: "running" },
      selectedAuxiliaryId: "auxiliary",
      auxiliaryItems: [],
      target: "main",
      widthRatio: 0,
      onSelectAuxiliary: noop,
      /** コンパクト表示の会話切替が指定対象だけを通知するよう記録する。 */
      onTargetChange: (target) => events.push(target),
      onWidthRatioChange: noop,
    };
    await act(async () => root?.render(React.createElement(ChatWindow, props)));
    const auxiliaryTargetButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-action-dock-compact-content [aria-label='Chat target'] button",
      ),
    ].find((button) => button.textContent === "Auxiliary");
    assert.ok(auxiliaryTargetButton);
    events.length = 0;
    await act(async () => auxiliaryTargetButton.click());
    assert.deepEqual(events, ["auxiliary"]);

    props.isActionDockExpanded = true;
    await act(async () => root?.render(React.createElement(ChatWindow, props)));
    events.length = 0;
    const expandedDock = dom.window.document.querySelector<HTMLElement>(
      ".session-action-dock",
    );
    assert.ok(expandedDock);
    await act(async () => expandedDock.click());
    assert.deepEqual(events, []);
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
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: previousResizeObserver,
    });
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

// @test-value v2
// kind = "contract"
// claim = "Preview/Sourceのbuttonとshortcutはdock間で選択と本文表現を共有し、切替時に旧文字選択を解除する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock Preview / Source" }
// fault = "buttonとshortcutで異なるmodeを保持するか、旧本文の文字選択を保持する"
// observable = "本文のlinkまたはsource文字列、dock buttonのaria-pressed、selection rangeCount"
// observation_boundary = "component-behavior"
// scope = "ChatWindow共有本文modeの操作routing"
// lifecycle = "permanent"
// impact = "選択した表現と読む本文が一致しないか、古い選択からCopy/Quoteしてしまう"
// distinction = "transition hook単体ではdockのbuttonとshortcut registryの接続を検証できない"
// @end-test-value
/** 表示切替ボタンとショートカットで共有表示モードを更新し、変更前の選択範囲を残さない。 */
test("ChatWindow は button とshortcutで共有表示modeを双方向に切り替える", async () => {
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousResizeObserver = globalThis.ResizeObserver;
  const dom = createChatDom(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      pretendToBeVisual: true,
    },
  );
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  /** 表示モードの動作を実レイアウトの監視なしで試すためのスタブ。 */
  class TestResizeObserver {
    /** 表示切替で寸法監視を始めてもブラウザーからの通知は発生させない。 */
    observe() {}
    /** 表示領域を外した際に監視の状態を残さない。 */
    unobserve() {}
    /** テストの終了で解放すべきブラウザー監視はない。 */
    disconnect() {}
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    /** 編集欄へ入力フォーカスを移すときのイベント登録を受け入れる。 */
    value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    /** 入力欄を離れる際に JSDOM にない旧イベント解除を補う。 */
    value() {},
  });
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
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });

  let root: Root | null = null;
  try {
    let expandCallCount = 0;
    const props = createChatWindowProps({
      messages: [],
      isRunning: true,
      pendingMessageText: "[label](https://example.test/source)",
    });
    props.isActionDockExpanded = false;
    props.compactActionDockProps = {
      ...props.compactActionDockProps,
      /** コンパクトの展開操作を反映した状態で同じ Chat を描画し直す。 */
      onExpand: () => {
        expandCallCount += 1;
      },
    };
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(React.createElement(ChatWindow, props));
    });
    const sourceButton = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-action-dock-compact-content .composer-message-view-mode-button",
      ),
    ).find((button) => button.textContent === "Source");
    assert.ok(sourceButton);
    assert.ok(
      dom.window.document.querySelector("[data-pending-message-body='true'] a"),
    );

    const composerTextarea =
      dom.window.document.querySelector<HTMLTextAreaElement>("textarea");
    assert.ok(composerTextarea);
    composerTextarea.focus();
    const editingShortcutEvent = new dom.window.KeyboardEvent("keydown", {
      key: "K",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => composerTextarea.dispatchEvent(editingShortcutEvent));
    assert.equal(editingShortcutEvent.defaultPrevented, false);
    assert.ok(
      dom.window.document.querySelector("[data-pending-message-body='true'] a"),
    );

    const expandButton = dom.window.document.querySelector<HTMLButtonElement>(
      ".session-action-dock-compact-content .session-action-dock-compact-expand-button",
    );
    assert.ok(expandButton);
    await act(async () => expandButton.click());
    assert.equal(expandCallCount, 1);

    await act(async () => sourceButton.click());

    const source = dom.window.document.querySelector(
      "[data-pending-message-body='true'] > .message-body",
    );
    assert.equal(source?.textContent, "[label](https://example.test/source)");
    assert.equal(
      dom.window.document.querySelector("[data-pending-message-body='true'] a"),
      null,
    );
    assert.equal(sourceButton.getAttribute("aria-pressed"), "true");
    assert.equal(
      dom.window.document
        .querySelector<HTMLButtonElement>(
          ".session-action-dock-expanded-content .composer-message-view-mode-button:last-child",
        )
        ?.getAttribute("aria-pressed"),
      "true",
    );

    const sourceText = source?.firstChild;
    assert.ok(sourceText);
    const selection = dom.window.getSelection();
    assert.ok(selection);
    const range = dom.window.document.createRange();
    range.selectNodeContents(sourceText);
    selection.addRange(range);
    assert.equal(selection.rangeCount, 1);

    const shortcutEvent = new dom.window.KeyboardEvent("keydown", {
      key: "K",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () =>
      dom.window.document.body.dispatchEvent(shortcutEvent),
    );
    assert.equal(shortcutEvent.defaultPrevented, true);
    assert.equal(selection.rangeCount, 0);
    assert.ok(
      dom.window.document.querySelector("[data-pending-message-body='true'] a"),
    );
    assert.equal(sourceButton.getAttribute("aria-pressed"), "false");
    assert.equal(
      dom.window.document
        .querySelector<HTMLButtonElement>(
          ".session-action-dock-expanded-content .composer-message-view-mode-button:first-child",
        )
        ?.getAttribute("aria-pressed"),
      "true",
    );

    const secondShortcutEvent = new dom.window.KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () =>
      dom.window.document.body.dispatchEvent(secondShortcutEvent),
    );
    assert.equal(secondShortcutEvent.defaultPrevented, true);
    assert.equal(
      dom.window.document.querySelector(
        "[data-pending-message-body='true'] > .message-body",
      )?.textContent,
      "[label](https://example.test/source)",
    );
    assert.equal(sourceButton.getAttribute("aria-pressed"), "true");

    const rapidShortcutEvents = [0, 1].map(
      () =>
        new dom.window.KeyboardEvent("keydown", {
          key: "k",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
    );
    await act(async () => {
      for (const event of rapidShortcutEvents) {
        dom.window.document.body.dispatchEvent(event);
      }
    });
    assert.ok(rapidShortcutEvents.every((event) => event.defaultPrevented));
    assert.equal(
      dom.window.document.querySelector(
        "[data-pending-message-body='true'] > .message-body",
      )?.textContent,
      "[label](https://example.test/source)",
    );
    assert.equal(sourceButton.getAttribute("aria-pressed"), "true");
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
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: previousResizeObserver,
    });
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

/** 引用が使えない会話では装飾表示とソース表示の切替も描画しない。 */
test("ChatWindow は Quote 非対応 chat に表示 mode controls を出さない", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ChatWindow,
      createChatWindowProps({
        onQuoteMessageText: undefined,
      }),
    ),
  );

  assert.doesNotMatch(html, /Message display mode/);
  assert.doesNotMatch(html, />Source<\/button>/);
});

/** サイズ変更を受け取る処理がない場合は、スプリッターを操作要素にしない。 */
test("ChatDockSplitter は resize handler がない場合に静的 splitter をレンダリングする", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatDockSplitter, { edge: "right" }),
  );

  assert.equal(
    html,
    '<div class="session-dock-splitter edge-right is-static" aria-hidden="true"></div>',
  );
});

// @test-value v2
// kind = "contract"
// claim = "resize handlerがあるChatDockSplitterは操作可能なbuttonとしてedgeを示す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window: 左右paneのサイズ調整" }
// fault = "操作可能splitterを静的なdivへ落とし、edgeのaccessible labelやtitleを失う"
// observable = "button type、edge class、aria-label、titleのrender結果"
// observation_boundary = "component-behavior"
// scope = "chat-dock-splitter-resize"
// lifecycle = "permanent"
// impact = "paneのサイズ変更操作がkeyboard・pointer双方で発見できなくなる"
// distinction = "resize handler有りのinteractive状態を静的splitter testと分離して確認する"
// @end-test-value
/** ドラッグ可能なスプリッターを操作ボタンとして認識できる属性を描画する。 */
test("ChatDockSplitter は resize handler がある場合に操作可能 splitter をレンダリングする", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatDockSplitter, {
      edge: "right",
      isActive: true,
      /** このケースでは操作可能性を描画するためだけにドラッグ処理を付ける。 */
      onPointerDown() {},
    }),
  );

  assert.match(
    html,
    /<button class="session-dock-splitter edge-right is-active" type="button"/,
  );
  assert.match(html, /aria-label="Resize Right pane"/);
  assert.match(html, /title="Drag to resize Right pane"/);
});

// @test-value v2
// kind = "contract"
// claim = "ChatDockSplitterはedgeごとのcollapse/expand状態とdrag affordanceをaccessible属性へ投影する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window: Header・ActionDock・左右paneの開閉と再表示affordance" }
// fault = "expanded stateとaria-expanded/controlsまたはchevron directionが不一致になる"
// observable = "各edgeのaria-label、aria-controls、aria-expanded、direction class、drag hint"
// observation_boundary = "component-behavior"
// scope = "chat-dock-splitter-affordance"
// lifecycle = "permanent"
// impact = "paneの表示状態を理解・切り替えられず、操作対象を誤る"
// distinction = "right・bottom・topの異なる状態を一つの表示結果に縮約せず確認する"
// @end-test-value
/** 各辺でパネルを開く・閉じる案内と、ドラッグ可能かどうかの情報を出す。 */
test("ChatDockSplitter は各辺の表示状態を切り替える affordance を示す", () => {
  const expandedHtml = renderToStaticMarkup(
    React.createElement(ChatDockSplitter, {
      edge: "right",
      isPanelExpanded: true,
      /** 開閉表示に加え、ポインターでサイズ変更もできる入口を構成する。 */
      onPointerDown() {},
      /** 描画された左側の開閉操作に実際の状態変更は行わせない。 */
      onTogglePanel() {},
    }),
  );
  const collapsedHtml = renderToStaticMarkup(
    React.createElement(ChatDockSplitter, {
      edge: "bottom",
      isPanelExpanded: false,
      /** 右側の開閉操作の表示に必要なだけのコールバック。 */
      onTogglePanel() {},
    }),
  );
  const fixedHeaderHtml = renderToStaticMarkup(
    React.createElement(ChatDockSplitter, {
      edge: "top",
      isPanelExpanded: true,
      /** ドックの開閉案内を描画するための切り替えコールバック。 */
      onTogglePanel() {},
    }),
  );

  assert.match(expandedHtml, /aria-label="Collapse Right pane"/);
  assert.match(expandedHtml, /aria-controls="session-right-pane"/);
  assert.match(expandedHtml, /aria-expanded="true"/);
  assert.match(expandedHtml, /Click to collapse Right pane; drag to resize/);
  assert.match(expandedHtml, /session-dock-splitter-chevron direction-right/);
  assert.match(expandedHtml, /<svg viewBox="0 0 12 12" focusable="false">/);
  assert.match(expandedHtml, /<path d="M4 2.5 8 6 4 9.5"><\/path>/);

  assert.match(
    collapsedHtml,
    /class="session-dock-splitter edge-bottom is-toggle-only is-collapsed"/,
  );
  assert.match(collapsedHtml, /aria-label="Expand Action Dock"/);
  assert.match(collapsedHtml, /aria-controls="session-action-dock"/);
  assert.match(collapsedHtml, /aria-expanded="false"/);
  assert.match(collapsedHtml, /session-dock-splitter-chevron direction-up/);

  assert.match(
    fixedHeaderHtml,
    /class="session-dock-splitter edge-top is-toggle-only"/,
  );
  assert.match(fixedHeaderHtml, /aria-label="Collapse Header"/);
  assert.match(fixedHeaderHtml, /aria-controls="session-header-dock"/);
  assert.match(fixedHeaderHtml, /aria-expanded="true"/);
  assert.match(fixedHeaderHtml, /session-dock-splitter-chevron direction-up/);
  assert.match(fixedHeaderHtml, /title="Click to collapse Header"/);
  assert.doesNotMatch(fixedHeaderHtml, /Drag to resize/);
});

// @test-value v2
// kind = "contract"
// claim = "SessionChatScreenの閉じたdockは非表示かつ操作不可で、選択中のmainContentとcomposerは保持される"
// oracle = { type = "contract", ref = "session dock visibility and main content selection" }
// fault = "閉じたdockが操作可能、またはファイル表示への切替でcomposerやpane内容が失われる"
// observable = "render済みHTMLのaria-hidden/inert属性とmainContent、composer、pane内容"
// observation_boundary = "component-behavior"
// scope = "SessionChatScreen visibility"
// lifecycle = "permanent"
// @end-test-value
/** 左右パネルを閉じても要素は残し、中央選択と Composer を変えず操作対象からだけ外す。 */
test("SessionChatScreen は左右ペインを mounted のまま非表示・操作不可にする", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionChatScreen, {
      mode: "agent",
      header: null,
      headerSplitter: React.createElement(
        "button",
        { type: "button" },
        "Header Toggle",
      ),
      isHeaderVisible: false,
      messageColumn: React.createElement("div", null, "Messages"),
      mainContent: React.createElement("div", null, "File Preview"),
      actionDock: React.createElement("div", null, "Composer"),
      actionDockSplitter: React.createElement(
        "button",
        { type: "button" },
        "Dock Toggle",
      ),
      isActionDockExpanded: false,
      splitter: React.createElement("button", { type: "button" }, "Toggle"),
      rightPane: React.createElement("aside", null, "Latest Command"),
      isRightPaneVisible: false,
    }),
  );

  assert.match(html, /class="page-shell session-page session-chat-layout/);
  assert.match(
    html,
    /id="session-header-dock"[^>]*class="session-header-dock-slot is-hidden"[^>]*aria-hidden="true"/,
  );
  assert.match(
    html,
    /id="session-action-dock"[^>]*class="session-action-dock-slot is-compact"/,
  );
  assert.match(
    html,
    /id="session-left-pane" class="session-left-pane-slot is-hidden" aria-hidden="true" inert=""/,
  );
  assert.match(
    html,
    /id="session-right-pane" class="session-right-pane-slot is-hidden" aria-hidden="true" inert=""/,
  );
  assert.match(
    html,
    /class="session-central-surface" hidden=""><div>Messages<\/div><\/div>/,
  );
  assert.match(
    html,
    /class="session-central-surface"><div>File Preview<\/div><\/div>/,
  );
  assert.match(html, /<div>Composer<\/div>/);
  assert.match(html, /Latest Command/);
});

// @test-value v2
// kind = "contract"
// claim = "SessionChatScreenは左ペインのCollapseと再表示で同じchild instanceとstateを保持する"
// oracle = { type = "contract", ref = "accepted behavior: preserve the complete left pane state while collapsed in the same Window" }
// fault = "左ペインのCollapseでchildがunmountされ、再表示時にtab、tree、Git結果などのlocal stateが初期化される"
// scope = "SessionChatScreen left pane visibility lifecycle"
// lifecycle = "permanent"
// distinction = "Sessionやroot ownerの変更ではなく、同じWindow内の表示切替だけを検証する"
// observable = "同じchildのstate値とmount回数"
// observation_boundary = "component-behavior"
// @end-test-value
/** 左パネルを畳んで再び開く間も、子を再作成せず内部状態を維持する。 */
test("SessionChatScreen は左ペインのCollapse後もchild stateを保持する", async () => {
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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

  /** マウントをまたいだかをボタンのカウント値で観測できる子パネル。 */
  function StatefulLeftPane() {
    const [count, setCount] = React.useState(0);
    return React.createElement(
      "button",
      {
        type: "button",
        "data-left-pane-state": "true",
        /** 既存の子インスタンスに保持されるカウントを一つ増やす。 */
        onClick: () => setCount((current) => current + 1),
      },
      `state:${count}`,
    );
  }
  /** 同じ左パネルを持つシェルを、表示フラグだけ変えて組み立てる。 */
  const renderScreen = (visible: boolean) =>
    React.createElement(SessionChatScreen, {
      mode: "agent" as const,
      header: null,
      headerSplitter: null,
      isHeaderVisible: true,
      messageColumn: React.createElement("div", null, "Messages"),
      rightPane: null,
      actionDock: React.createElement("div", null, "Composer"),
      actionDockSplitter: null,
      isActionDockExpanded: true,
      splitter: null,
      leftPane: React.createElement(StatefulLeftPane),
      isLeftPaneVisible: visible,
    });

  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(renderScreen(true));
    });
    const button = dom.window.document.querySelector<HTMLButtonElement>(
      "[data-left-pane-state='true']",
    );
    assert.ok(button);
    await act(async () => button.click());
    assert.equal(button.textContent, "state:1");

    await act(async () => root?.render(renderScreen(false)));
    assert.equal(
      dom.window.document
        .getElementById("session-left-pane")
        ?.getAttribute("aria-hidden"),
      "true",
    );
    assert.equal(
      dom.window.document.querySelector("[data-left-pane-state='true']"),
      button,
    );
    assert.equal(button.textContent, "state:1");

    await act(async () => root?.render(renderScreen(true)));
    assert.equal(
      dom.window.document.querySelector("[data-left-pane-state='true']"),
      button,
    );
    assert.equal(button.textContent, "state:1");
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
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
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "未選択Auxiliaryの通常空labelはblankを保ちつつ、switcherと作成入口のaccessible nameを維持する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗: 正常0件の本文は空にし、操作とaccessible nameを残す" }
// fault = "Auxiliary未選択時に通常空の可視labelを表示するか、switcherまたはAdd Auxiliaryの識別名を失う"
// observable = "未選択switcherの可視text、current buttonのaria-label、Add Auxiliary buttonのaria-labelと表示記号"
// observation_boundary = "component-behavior"
// scope = "chat-window-auxiliary-empty-switcher"
// lifecycle = "permanent"
// impact = "空のAuxiliary paneが説明文で埋まり、または支援技術から作成操作を識別できなくなる"
// distinction = "空labelの表示だけでなく、同じDOM上のswitcher識別名と作成入口を同時に確認する"
// @end-test-value
/** Auxiliary 未選択時は可視名を表示せず、支援技術向けの切替・作成名は維持する。 */
test("ChatWindow は未選択Auxiliaryの可視labelを空にして作成入口の識別名を保つ", () => {
  const props = createChatWindowProps({ messages: [] });
  const html = renderToStaticMarkup(
    React.createElement(ChatWindow, {
      ...props,
      concurrentChats: {
        main: props.messageColumnProps,
        auxiliary: null,
        selectedAuxiliaryId: null,
        auxiliaryItems: [],
        target: "main",
        widthRatio: 0.45,
        /** 作成入口を表示するだけで Auxiliary の作成処理は呼び出さない。 */
        onAddAuxiliary() {},
        /** 未選択の Auxiliary 候補の表示だけを検査する。 */
        onSelectAuxiliary() {},
        /** 送信先は切り替えず、必要な操作名があることを観測する。 */
        onTargetChange() {},
        /** レイアウトを実際に変える処理を伴わず未選択の表示を検査する。 */
        onWidthRatioChange() {},
      },
    }),
  );
  const dom = new JSDOM(html);
  const switcher = dom.window.document.querySelector<HTMLElement>(
    ".concurrent-chat-session-switcher",
  );
  assert.ok(switcher);
  const current = switcher.querySelector<HTMLButtonElement>(
    ".session-switcher-current",
  );
  assert.ok(current);
  assert.equal(current.textContent, "");
  assert.equal(current.getAttribute("aria-label"), "Auxiliary conversation");
  const addButton = switcher.querySelector<HTMLButtonElement>(
    "button[aria-label='Add Auxiliary']",
  );
  assert.ok(addButton);
  assert.equal(addButton.textContent, "+");
  dom.window.close();
});

// @test-value v2
// kind = "contract"
// claim = "splitterはpointerdownでfocusを取得し、resize handlerが既定動作を取消してもfocusを元の入力へ残さず、activate callbackを通知する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: dockのpointer・keyboard操作と端末入力の独立" }
// fault = "resizeのpreventDefaultによってsplitterへfocusが移らず、その後のkeyboard操作が元の入力へ配送される"
// observable = "pointerdown後のdocument.activeElementとpointerdown・click時のactivate callback"
// observation_boundary = "component-behavior"
// scope = "ChatDockSplitter pointer focus"
// lifecycle = "permanent"
// impact = "端末からsplitterへ操作対象を変えた後のEnterや矢印キーがshell入力になる"
// distinction = "型検査や静的button markupは、pointer操作で既定focusが取消された場合のfocus移動を保証しない。JSDOMの軽量なfocus検証を既存test内に保持する"
// @end-test-value
/** ポインターによる既定動作を停止してもスプリッターがフォーカスを得て、活性化を通知する。 */
test("ChatDockSplitter はpointer操作でfocusを取得してactivateを通知する", async () => {
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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
  const activations: string[] = [];
  try {
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(
        React.createElement(
          "div",
          null,
          React.createElement(ChatDockSplitter, {
            edge: "left",
            /** 横のスプリッターが活性化されたことを記録する。 */
            onActivate: () => activations.push("side"),
            /** ドラッグ開始側が既定動作を止める状況を再現する。 */
            onPointerDown: (event) => event.preventDefault(),
            /** 開閉の状態変更は発生させず、ポインター操作を検証する。 */
            onTogglePanel() {},
          }),
          React.createElement(ChatDockSplitter, {
            edge: "bottom",
            /** ドックのスプリッターを操作した経路を別のイベントとして記録する。 */
            onActivate: () => activations.push("dock"),
            /** ドックの開閉自体はフォーカス取得の検証では実行しない。 */
            onTogglePanel() {},
          }),
        ),
      );
    });
    const leftSplitter =
      dom.window.document.querySelector<HTMLButtonElement>(".edge-left");
    const bottomSplitter =
      dom.window.document.querySelector<HTMLButtonElement>(".edge-bottom");
    assert.ok(leftSplitter);
    assert.ok(bottomSplitter);
    bottomSplitter.focus();
    assert.equal(dom.window.document.activeElement, bottomSplitter);

    await act(async () => {
      leftSplitter.dispatchEvent(
        new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
    });
    assert.equal(dom.window.document.activeElement, leftSplitter);
    await act(async () => bottomSplitter.click());

    assert.deepEqual(activations, ["side", "dock"]);
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
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

// @test-value v2
// kind = "contract"
// claim = "Concurrent chat columns は保存幅が最小領域を下回っても実幅に合わせて補正し、利用可能幅不足では単体表示へ切り替え、比率の両端では送信先と独立して片側を全幅表示する"
// oracle = { type = "contract", ref = "issue-710-concurrent-column-minimums" }
// fault = "保存されたAuxiliary幅がMain/Auxiliaryの最小幅を侵食する、または両方を表示できない幅で通常レイアウトを維持する"
// observable = "columnsのgridTemplateColumnsとis-single-chat class"
// observation_boundary = "component-behavior"
// scope = "SessionChatScreen concurrent columns"
// lifecycle = "permanent"
// @end-test-value
/** 二列の幅を最小領域に合わせ、総幅が足りなければ単列にし、両端の比率では明示した片側を開く。 */
test("SessionChatScreen はConcurrent columnsの実幅不足を補正する", async () => {
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousResizeObserver = globalThis.ResizeObserver;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { pretendToBeVisual: true },
  );
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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
  let resizeCallback: (() => void) | null = null;
  /** 実測幅を切り替えた後、測定し直すタイミングを制御する監視スタブ。 */
  class TestResizeObserver {
    /** サイズ変更を手動で通知するため、登録されたコールバックを保持する。 */
    constructor(callback: () => void) {
      resizeCallback = callback;
    }
    /** 監視が始まってもテストが指定するまで再測定は起こさない。 */
    observe() {}
    /** 監視終了時にブラウザーの監視解除を行う必要はない。 */
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  Object.defineProperty(dom.window, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  let root: Root | null = null;
  /** 送信先を Main に固定したまま、幅比率だけ変えた二列画面を組み立てる。 */
  const screen = (ratio: number) =>
    React.createElement(SessionChatScreen, {
      mode: "agent",
      header: null,
      headerSplitter: null,
      isHeaderVisible: true,
      messageColumn: React.createElement("div", null, "Main"),
      auxiliaryMessageColumn: React.createElement("div", null, "Auxiliary"),
      auxiliarySplitter: React.createElement(
        "button",
        { type: "button" },
        "Splitter",
      ),
      isAuxiliaryVisible: true,
      auxiliaryWidthRatio: ratio,
      concurrentTarget: "main",
      actionDock: null,
      actionDockSplitter: null,
      isActionDockExpanded: true,
      rightPane: null,
      splitter: null,
    });
  try {
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(screen(0.1));
    });
    const columns = dom.window.document.querySelector<HTMLElement>(
      ".session-concurrent-chat-columns",
    );
    assert.ok(columns);
    const main = columns.querySelector<HTMLElement>(
      ".session-concurrent-chat-main",
    );
    const auxiliary = columns.querySelector<HTMLElement>(
      ".session-concurrent-chat-auxiliary",
    );
    assert.ok(main);
    assert.ok(auxiliary);
    main.style.setProperty("--session-region-min-width", "360px");
    auxiliary.style.setProperty("--session-region-min-width", "360px");
    columns.style.setProperty("--session-dock-splitter-size", "8px");
    Object.defineProperty(columns, "getBoundingClientRect", {
      configurable: true,
      /** 両列の最小幅を満たす総幅を測定した状態にする。 */
      value: () => ({
        width: 800,
        height: 300,
        top: 0,
        left: 0,
        right: 800,
        bottom: 300,
      }),
    });
    await act(async () => resizeCallback?.());
    assert.doesNotMatch(columns.style.gridTemplateColumns, /0\.1fr/);
    assert.match(columns.style.gridTemplateColumns, /0\.45/);
    Object.defineProperty(columns, "getBoundingClientRect", {
      configurable: true,
      /** 両列の最小幅を満たせない測定値を返す。 */
      value: () => ({
        width: 700,
        height: 300,
        top: 0,
        left: 0,
        right: 700,
        bottom: 300,
      }),
    });
    await act(async () => resizeCallback?.());
    assert.ok(columns.classList.contains("is-single-chat"));
    await act(async () => root!.render(screen(1)));
    assert.equal(
      columns.style.gridTemplateColumns,
      "minmax(0, 0fr) var(--session-dock-splitter-size) minmax(0, 1fr)",
    );
    assert.equal(main.getAttribute("aria-hidden"), "true");
    assert.equal(auxiliary.getAttribute("aria-hidden"), "false");
    assert.equal(columns.classList.contains("is-single-chat"), false);
    await act(async () => root!.render(screen(0)));
    assert.equal(
      columns.style.gridTemplateColumns,
      "minmax(0, 1fr) var(--session-dock-splitter-size) minmax(0, 0fr)",
    );
    assert.equal(main.getAttribute("aria-hidden"), "false");
    assert.equal(auxiliary.getAttribute("aria-hidden"), "true");
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
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: previousResizeObserver,
    });
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

// @test-value v2
// kind = "contract"
// claim = "Concurrent chat shell は実行状態によらずMain/Auxiliaryのラベル・accessible nameと選択対象を維持し、対象切替、本文のある非対象Main列のoverlay、空列でのoverlay不在、Auxiliary一覧を同じWindowへ投影する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Main / Auxiliaryのtarget切替button; docs/design/auxiliary-session.md: UI flow" }
// fault = "実行状態によって操作対象の名前や選択状態が変わる、対象切替や一覧が中央列へ接続されない、または空列が不要に暗くなる"
// observable = "Main/Auxiliaryの実行状態4通りと選択対象2通りでのexpanded/compact操作対象ボタンのラベル・accessible name・aria-pressedとcallback、本文のある非対象Main列内のoverlayと空列での不在、一覧triggerと会話列"
// observation_boundary = "component-behavior"
// scope = "concurrent-chat-shell"
// lifecycle = "permanent"
// @end-test-value
/** 同時表示中の対象会話と両方のラベルを保持し、本文がある非対象列に切替入口を表示する。 */
test("ChatWindow は concurrent chat shell の操作対象と切り替え導線を描画する", async () => {
  const props = createChatWindowProps();
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousResizeObserver = globalThis.ResizeObserver;
  const dom = createChatDom(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      pretendToBeVisual: true,
    },
  );
  /** 並列会話を描画する間の寸法通知を固定する。 */
  class TestResizeObserver {
    /** Main と Auxiliary の監視先を増やしても寸法通知を発行しない。 */
    observe() {}
    /** 列の監視解除はレイアウトを変更しない。 */
    unobserve() {}
    /** 同時表示の後処理で監視先への接続を残さない。 */
    disconnect() {}
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    /** 会話切替後の入力フォーカスで旧イベント登録を要求しても実行しない。 */ value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    /** 入力対象が変わっても旧イベントの解除に実ブラウザーを必要としない。 */ value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    /** テストの仮想行ではブラウザーのスクロールは発生させない。 */ value() {},
  });
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
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | null = null;
  const targetChanges: Array<"main" | "auxiliary"> = [];
  const concurrentChats: NonNullable<ChatWindowProps["concurrentChats"]> = {
    main: props.messageColumnProps,
    auxiliary: props.messageColumnProps,
    mainSession: { id: "main", runState: "running" },
    auxiliarySession: { id: "aux-b", runState: "idle" },
    mainLiveRun: {
      sessionId: "main",
      threadId: "thread-main",
      assistantText: "",
      steps: [],
      backgroundTasks: [],
      usage: null,
      errorMessage: "",
      approvalRequest: null,
      elicitationRequest: null,
    },
    auxiliaryLiveRun: {
      sessionId: "aux-b",
      threadId: "thread-aux-b",
      assistantText: "",
      steps: [],
      backgroundTasks: [],
      usage: null,
      errorMessage: "",
      approvalRequest: null,
      elicitationRequest: null,
    },
    selectedAuxiliaryId: "aux-b",
    auxiliaryItems: [
      { id: "aux-a", label: "A", preview: "first preview", icon: "✦" },
      { id: "aux-b", label: "B", preview: "second preview", icon: "✧" },
    ],
    target: "auxiliary",
    widthRatio: 0.45,
    /** 選択済みの Auxiliary は固定し、送信先の切り替えだけを観測する。 */
    onSelectAuxiliary() {},
    /** 同時表示のどの会話を操作対象にしたか記録する。 */
    onTargetChange: (target) => targetChanges.push(target),
    /** このケースで確認しない列のサイズ変更を省略する。 */
    onWidthRatioChange() {},
  };
  try {
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(
        React.createElement(ChatWindow, {
          ...props,
          concurrentChats,
        }),
      );
    });

    const container = dom.window.document.getElementById("root") as HTMLElement;
    const html = container.innerHTML;
    assert.match(html, /Chat target/);
    const targetButtons = [
      ...container.querySelectorAll(
        ".composer-target-dock-slot .concurrent-chat-target-dock button",
      ),
    ];
    assert.deepEqual(
      targetButtons.map((button) => button.textContent),
      ["Main", "Auxiliary"],
    );
    assert.ok(
      targetButtons.every((button) =>
        button.querySelector('svg[aria-hidden="true"]'),
      ),
    );
    assert.doesNotMatch(html, /action-dock-mode-badge/);
    assert.match(html, /concurrent-chat-target-overlay/);
    assert.equal(
      (html.match(/concurrent-chat-target-overlay/g) ?? []).length,
      1,
    );
    assert.ok(
      container.querySelector(
        ".composer-target-dock-slot .concurrent-chat-target-dock",
      ),
    );
    assert.equal(
      container.querySelector(".concurrent-chat-target-dock-slot"),
      null,
    );
    assert.ok(
      container.querySelector(
        ".session-concurrent-chat-main .concurrent-chat-target-overlay",
      ),
    );
    assert.equal(
      container.querySelector(
        ".session-concurrent-chat-auxiliary .concurrent-chat-target-overlay",
      ),
      null,
    );
    assert.match(html, /Auxiliary conversation/);
    assert.match(html, /session-auxiliary-chat-pane/);
    assert.match(html, /aria-controls="session-auxiliary-chat-pane"/);

    for (const mainRunning of [false, true]) {
      for (const auxiliaryRunning of [false, true]) {
        for (const target of ["main", "auxiliary"] as const) {
          for (const isActionDockExpanded of [false, true]) {
            await act(async () => {
              root?.render(
                React.createElement(ChatWindow, {
                  ...props,
                  isActionDockExpanded,
                  concurrentChats: {
                    ...concurrentChats,
                    target,
                    mainSession: {
                      id: "main",
                      runState: mainRunning ? "running" : "idle",
                    },
                    auxiliarySession: {
                      id: "aux-b",
                      runState: auxiliaryRunning ? "running" : "idle",
                    },
                    mainLiveRun: mainRunning
                      ? concurrentChats.mainLiveRun
                      : null,
                    auxiliaryLiveRun: auxiliaryRunning
                      ? concurrentChats.auxiliaryLiveRun
                      : null,
                  },
                }),
              );
            });
            const targetDock = container.querySelector(
              ".session-action-dock-content.is-active [aria-label='Chat target']",
            );
            assert.ok(targetDock);
            const targetButtons = [
              ...targetDock.querySelectorAll<HTMLButtonElement>("button"),
            ];
            assert.deepEqual(
              targetButtons.map((button) => button.textContent),
              ["Main", "Auxiliary"],
            );
            assert.deepEqual(
              targetButtons.map(
                (button) =>
                  button.getAttribute("aria-label") ?? button.textContent,
              ),
              ["Main", "Auxiliary"],
            );
            assert.deepEqual(
              targetButtons.map((button) =>
                button.getAttribute("aria-pressed"),
              ),
              [String(target === "main"), String(target === "auxiliary")],
            );
            assert.equal(
              targetButtons[target === "main" ? 0 : 1].className,
              "is-active",
            );
            targetChanges.length = 0;
            await act(async () => targetButtons[0].click());
            await act(async () => targetButtons[1].click());
            assert.deepEqual(targetChanges, ["main", "auxiliary"]);
          }
        }
      }
    }

    const emptyChats = {
      ...concurrentChats,
      main: {
        ...concurrentChats.main,
        messages: [],
        isRunning: false,
        hasLiveRunAssistantText: false,
        liveRunErrorMessage: "",
      },
      auxiliary: {
        ...concurrentChats.auxiliary!,
        messages: [],
        isRunning: false,
        hasLiveRunAssistantText: false,
        liveRunErrorMessage: "",
      },
    };
    await act(async () => {
      root?.render(
        React.createElement(ChatWindow, {
          ...props,
          concurrentChats: { ...emptyChats, target: "main" },
        }),
      );
    });
    assert.equal(
      container.querySelector(
        ".session-concurrent-chat-auxiliary .concurrent-chat-target-overlay",
      ),
      null,
    );
    await act(async () => {
      root?.render(
        React.createElement(ChatWindow, {
          ...props,
          concurrentChats: { ...emptyChats, target: "auxiliary" },
        }),
      );
    });
    assert.equal(
      container.querySelector(
        ".session-concurrent-chat-main .concurrent-chat-target-overlay",
      ),
      null,
    );
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
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: previousResizeObserver,
    });
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

// @test-value v2
// kind = "contract"
// claim = "Concurrent ChatのCollapseは折りたたみ対象がない間はdisabledで、Auxiliary追加は切り替えUI内に表示され既存Auxiliaryの有無に関係なく作成不可ならdisabledになり、対象messageが追加されるとCollapseがenabledになって対象messageを縮小する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 表示言語・操作・状態; Home Window" }
// fault = "対象messageがない状態でCollapseを操作できる、Auxiliary追加が切り替えUIから欠落する、作成不可でも追加buttonが有効になる、対象追加後もCollapseがdisabledのままになる、またはクリックしても対象messageが縮小されない"
// observable = "Collapse buttonのdisabled状態、Auxiliary切り替えUI内の追加buttonの表示・disabled状態とclick callback、click後のmessage card縮小状態とExpand label"
// observation_boundary = "component-behavior"
// scope = "ChatWindow concurrent collapse and Auxiliary switcher add action"
// lifecycle = "permanent"
// impact = "利用可能な操作だけを有効化し、Main/Auxiliaryの表示内容をActionDockから一貫して操作できる"
// distinction = "静的render確認では列側の非同期control projectionとclick後のmessage縮小状態を同時に確認できない"
// @end-test-value
/** 折りたためる発言があるときだけ Collapse を有効にし、Auxiliary の作成制限を切替一覧に反映する。 */
test("ChatWindowのCollapseは対象messageの有無に応じてdisabledを切り替え、クリックで縮小する", async () => {
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousResizeObserver = globalThis.ResizeObserver;
  const dom = createChatDom(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      pretendToBeVisual: true,
    },
  );
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    /** 本文の仮想表示に計測される外枠の高さを一定にする。 */ get: () => 600,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    /** 発言列の幅を一定にして、折りたたみ可能な本文を配置する。 */ get: () =>
      800,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    /** スクロール領域の内側に与える高さを固定する。 */ get: () => 600,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    /** レイアウトによる表示項目の変化を除くため、内側の幅を固定する。 */ get: () =>
      800,
  });
  /** 折りたたみ表示で使う寸法監視を実ブラウザーに依存させない。 */
  class TestResizeObserver {
    /** 折りたたみ対象の要素を監視しても変更イベントを出さない。 */
    observe() {}
    /** 要素から監視を外してもテスト用の寸法を維持する。 */
    unobserve() {}
    /** JSDOM で始動していない監視は破棄時に何もしない。 */
    disconnect() {}
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    /** 新しい発言の入力にフォーカスしても旧イベントを実登録しない。 */ value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    /** 入力欄を離れた際の旧イベント解除を受け入れる。 */ value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    /** 折りたたみの検証では、仮想行へのスクロールを発生させない。 */ value() {},
  });
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
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  let root: Root | null = null;
  const props = createChatWindowProps({ messages: [] });
  const auxiliaryActions: string[] = [];
  /** 作成可否と既存 Auxiliary の選択を変えられる同時表示を組み立てる。 */
  const buildConcurrentChats = (
    messages: ChatWindowProps["messageColumnProps"]["messages"],
    isAddAuxiliaryDisabled = false,
    auxiliaryItems: readonly { id: string; label: string }[] = [],
  ) => ({
    mainSession: { id: "main", messages },
    auxiliarySession: null,
    main: { ...props.messageColumnProps, messages },
    auxiliary: null,
    selectedAuxiliaryId: null,
    auxiliaryItems,
    target: "main" as const,
    widthRatio: 0.45,
    /** 新しい Auxiliary への作成要求を、表示の可否とは別に記録する。 */
    onAddAuxiliary: () => auxiliaryActions.push("add"),
    isAddAuxiliaryDisabled,
    /** このケースでは一覧の選び直しを状態に反映しない。 */
    onSelectAuxiliary() {},
    /** 入力送信先は固定し、発言の折りたたみだけを操作する。 */
    onTargetChange() {},
    /** 列幅を変更せず、同じ領域で折りたたみ対象の変化を検証する。 */
    onWidthRatioChange() {},
  });

  try {
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(
        React.createElement(ChatWindow, {
          ...props,
          concurrentChats: buildConcurrentChats([]),
        }),
      );
    });
    const container = dom.window.document.getElementById("root") as HTMLElement;
    let collapseButton = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Collapse");
    assert.ok(collapseButton);
    assert.equal(collapseButton.disabled, true);
    const auxiliaryAddButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Add Auxiliary']",
    );
    assert.ok(auxiliaryAddButton);
    assert.ok(auxiliaryAddButton.closest(".session-switcher-current-group"));
    assert.equal(auxiliaryAddButton.closest("[aria-hidden='true']"), null);
    assert.equal(auxiliaryAddButton.closest("[inert]"), null);
    assert.equal(auxiliaryAddButton.disabled, false);
    await act(async () => auxiliaryAddButton.click());
    assert.deepEqual(auxiliaryActions, ["add"]);

    await act(async () => {
      root?.render(
        React.createElement(ChatWindow, {
          ...props,
          concurrentChats: buildConcurrentChats([], false, [
            { id: "aux-a", label: "Auxiliary A" },
          ]),
        }),
      );
    });
    const existingAuxiliaryAddButton =
      container.querySelector<HTMLButtonElement>(
        "button[aria-label='Add Auxiliary']",
      );
    assert.ok(existingAuxiliaryAddButton);
    assert.equal(existingAuxiliaryAddButton.disabled, false);
    await act(async () => existingAuxiliaryAddButton.click());
    assert.deepEqual(auxiliaryActions, ["add", "add"]);

    await act(async () => {
      root?.render(
        React.createElement(ChatWindow, {
          ...props,
          concurrentChats: buildConcurrentChats([], true, [
            { id: "aux-a", label: "Auxiliary A" },
          ]),
        }),
      );
    });
    const existingDisabledAuxiliaryAddButton =
      container.querySelector<HTMLButtonElement>(
        "button[aria-label='Add Auxiliary']",
      );
    assert.ok(existingDisabledAuxiliaryAddButton);
    assert.equal(existingDisabledAuxiliaryAddButton.disabled, true);

    await act(async () => {
      root?.render(
        React.createElement(ChatWindow, {
          ...props,
          concurrentChats: buildConcurrentChats([], true),
        }),
      );
    });
    const disabledAuxiliaryAddButton =
      container.querySelector<HTMLButtonElement>(
        "button[aria-label='Add Auxiliary']",
      );
    assert.ok(disabledAuxiliaryAddButton);
    assert.equal(disabledAuxiliaryAddButton.disabled, true);

    const messages = [{ role: "assistant" as const, text: "完了したmessage" }];
    await act(async () => {
      root?.render(
        React.createElement(ChatWindow, {
          ...props,
          concurrentChats: buildConcurrentChats(messages),
        }),
      );
    });
    collapseButton = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Collapse");
    assert.ok(collapseButton);
    assert.equal(collapseButton.disabled, false);

    assert.ok(container.querySelector(".message-card.assistant"));
    await act(async () => collapseButton?.click());
    assert.ok(
      container.querySelector(
        ".message-card.assistant.is-collapsed .message-collapsed-preview",
      ),
    );
    const expandedButton = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Expand");
    assert.ok(expandedButton);
    assert.equal(expandedButton.disabled, false);
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
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: previousResizeObserver,
    });
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryは幅0でgrid trackと表示領域を閉じ、switcherと追加操作を隠し、splitterの再展開導線を残す"
// oracle = { type = "contract", ref = "issue-710-zero-width-auxiliary" }
// fault = "Auxiliaryを幅0にしてもgrid trackや操作可能な表示領域が残る、switcherまたは追加buttonが表示される、またはsplitterの再展開導線が提示されない"
// observable = "Auxiliary grid trackの0fr、Auxiliary columnのaria-hidden/inert、shell内のswitcherと追加buttonの不在、Auxiliary splitterのaria-expanded"
// impact = "幅0でもAuxiliaryの表示や操作が残ると、Mainの全幅化とAuxiliaryの操作不可という公開UI契約に反し、誤操作可能な導線を残す"
// distinction = "typecheck/buildやsplitter単体testでは、ChatWindow経由の0幅DOMとAuxiliary操作要素の不在を同時に確認できない"
// observation_boundary = "component-behavior"
// scope = "concurrent-chat-shell"
// lifecycle = "permanent"
// @end-test-value
/** Auxiliary が幅ゼロなら列の内容と操作を隠し、スプリッターから再表示できるようにする。 */
test("ChatWindow はAuxiliaryを幅0で完全に閉じsplitterの再展開導線を残す", () => {
  const props = createChatWindowProps();
  const html = renderToStaticMarkup(
    React.createElement(ChatWindow, {
      ...props,
      concurrentChats: {
        main: props.messageColumnProps,
        auxiliary: props.messageColumnProps,
        selectedAuxiliaryId: "aux-a",
        auxiliaryItems: [{ id: "aux-a", label: "A" }],
        target: "main",
        widthRatio: 0,
        /** 閉じた列の作成入口が描画されないかを、作成処理を行わず確認する。 */
        onAddAuxiliary() {},
        /** Auxiliary の切替処理ではなく閉じた列の表示構造を検証する。 */
        onSelectAuxiliary() {},
        /** 列を閉じる状態と送信先を別に扱い、送信先は切り替えない。 */
        onTargetChange() {},
        /** 幅ゼロを描画に渡し、幅の保存は発生させない。 */
        onWidthRatioChange() {},
      },
    }),
  );

  const dom = new JSDOM(html);
  assert.equal(html.includes("--session-auxiliary-header-min-width"), false);
  const columns = dom.window.document.querySelector<HTMLElement>(
    ".session-concurrent-chat-columns",
  );
  assert.ok(columns);
  assert.match(columns.getAttribute("style") ?? "", /minmax\(0, 0fr\)/);
  const auxiliaryColumn = dom.window.document.querySelector<HTMLElement>(
    ".session-concurrent-chat-auxiliary",
  );
  assert.ok(auxiliaryColumn);
  assert.equal(auxiliaryColumn.getAttribute("aria-hidden"), "true");
  assert.equal(auxiliaryColumn.hasAttribute("inert"), true);
  assert.equal(
    dom.window.document.querySelector(".concurrent-chat-session-switcher"),
    null,
  );
  assert.equal(
    dom.window.document.querySelector("button[aria-label='Add Auxiliary']"),
    null,
  );
  const auxiliarySplitter =
    dom.window.document.querySelector<HTMLButtonElement>(
      ".concurrent-chat-splitter[aria-label='Open Auxiliary']",
    );
  assert.ok(auxiliarySplitter);
  assert.equal(auxiliarySplitter.getAttribute("aria-expanded"), "false");
  dom.window.close();
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryの読込エラー中もsummary switcherが使え、取得済み本文は同じ会話の再取得中・失敗後も保持される"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#scope; docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "Auxiliaryの読込エラーでswitcherを失うか、取得済み本文を待機表示・エラーと差し替えて閲覧位置を失う"
// observable = "switcherと別Auxiliary選択、対象ボタン、各状態のerror region、取得済み本文DOMの同一性"
// observation_boundary = "component-behavior"
// scope = "concurrent-chat-shell"
// lifecycle = "permanent"
// @end-test-value
/** Auxiliary の詳細取得に失敗しても選択肢を維持し、既に取得した同じ会話の本文は読み直しで消さない。 */
test("ChatWindow はAuxiliary detail error中もsummary switcherを維持する", async () => {
  const props = createChatWindowProps();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousResizeObserver = globalThis.ResizeObserver;
  const dom = createChatDom(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { pretendToBeVisual: true },
  );
  /** Auxiliary の再取得と表示を確認する間のリサイズ監視スタブ。 */
  class TestResizeObserver {
    /** 本文のサイズ監視で通知を発生させない。 */ observe() {}
    /** 列の監視対象の離脱を無操作で受け入れる。 */ unobserve() {}
    /** 詳細読取の検証後に外部の監視登録を残さない。 */ disconnect() {}
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    /** Auxiliary の切替後にフォーカスを取っても旧イベント登録の副作用を起こさない。 */ value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    /** 入力フォーカスが外れたときの旧イベント解除を無操作にする。 */ value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    /** 詳細データの再取得とエラー表示の検証では、仮想行のスクロールを動かさない。 */ value() {},
  });
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
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    /** グローバルから要求された描画フレームを JSDOM のタイマーで進める。 */ value:
      (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0),
  });
  Object.defineProperty(dom.window, "requestAnimationFrame", {
    configurable: true,
    /** DOM ウィンドウからのフレーム要求にも同じタイマーを使う。 */ value: (
      callback: FrameRequestCallback,
    ) => dom.window.setTimeout(callback, 0),
  });
  let root: Root | null = null;
  const selected: string[] = [];
  try {
    /** Auxiliary の選択肢を維持したまま、取得待ち・成功・失敗の状態を差し替える。 */
    const renderAuxiliary = (
      state: Partial<NonNullable<ChatWindowProps["concurrentChats"]>>,
    ) =>
      root?.render(
        React.createElement(ChatWindow, {
          ...props,
          concurrentChats: {
            main: props.messageColumnProps,
            auxiliary: null,
            selectedAuxiliaryId: "aux-a",
            auxiliaryItems: [
              { id: "aux-a", label: "A", preview: "first" },
              { id: "aux-b", label: "B", preview: "second" },
            ],
            target: "main",
            widthRatio: 0.5,
            error: "Auxiliary detail failed",
            /** 詳細取得の結果に関係なく選べる Auxiliary の ID を記録する。 */
            onSelectAuxiliary: (id) => selected.push(id),
            /** 取得済み本文の確認と送信先変更を切り離す。 */
            onTargetChange() {},
            /** 列の幅は固定し、詳細取得だけを変化させる。 */
            onWidthRatioChange() {},
            ...state,
          },
        }),
      );
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      renderAuxiliary({});
    });

    assert.ok(
      dom.window.document.querySelector(
        "[aria-label='Auxiliary conversation']",
      ),
    );
    assert.match(
      dom.window.document.body.textContent ?? "",
      /Auxiliary detail failed/,
    );
    assert.ok(
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".concurrent-chat-target-dock button",
        ),
      ].some((button) => button.textContent === "Main"),
    );
    assert.ok(
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".concurrent-chat-target-dock button",
        ),
      ].some((button) => button.textContent === "Auxiliary"),
    );
    assert.equal(
      dom.window.document.querySelector(".concurrent-chat-state")?.textContent,
      "Auxiliary detail failed",
    );
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".session-switcher-current",
    );
    assert.ok(trigger);
    await act(async () => trigger.click());
    const optionB = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        "[role='option']",
      ),
    ].find((option) => option.textContent?.includes("B"));
    assert.ok(optionB);
    await act(async () => optionB.click());
    assert.deepEqual(selected, ["aux-b"]);

    const auxiliary = {
      ...props.messageColumnProps,
      sessionId: "aux-b",
      messages: [
        { role: "assistant" as const, text: "Saved Auxiliary message" },
      ],
    };
    const loaded = {
      auxiliary,
      auxiliarySession: { id: "aux-b", messages: auxiliary.messages },
      selectedAuxiliaryId: "aux-b",
    };
    /** Auxiliary の会話本文として公開される領域を取得する。 */
    const body = () =>
      dom.window.document.querySelector(
        '#session-auxiliary-chat-pane [role="region"][aria-label="Conversation messages"]',
      );
    await act(async () => renderAuxiliary({ ...loaded, error: null }));
    const retained = body();
    assert.ok(retained);
    assert.equal(retained.getAttribute("data-message-count"), "1");
    await act(async () =>
      renderAuxiliary({ ...loaded, loading: true, error: null }),
    );
    assert.equal(body(), retained);
    await act(async () =>
      renderAuxiliary({ ...loaded, error: "Auxiliary refresh failed" }),
    );
    assert.equal(body(), retained);
    assert.match(
      dom.window.document.querySelector(
        '#session-auxiliary-chat-pane [role="alert"]',
      )?.textContent ?? "",
      /Auxiliary refresh failed/,
    );
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
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: previousResizeObserver,
    });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: previousRequestAnimationFrame,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "MainとAuxiliaryの末尾移動button・別々のshortcutは指定列だけ追従へ戻し、入力focusと送信対象を保つ。取得済みAuxiliaryの再取得中・失敗後は使え、非表示・未取得列やPreview・Terminal・IME・repeatでは実行しない。送信は列ごとのcaptureから受付完了通知まで移動を待つ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Auxiliary Session; docs/features/keyboard-shortcuts.md: command scope; docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "末尾移動先を送信対象で決める、非表示列に配送する、またはfocus・送信対象・送信時追従を変更する"
// observable = "両列のscrollTop、button clickとkeydownの結果、activeElement、target変更callback、composer送信callback"
// observation_boundary = "component-behavior"
// scope = "concurrent-chat-shell"
// lifecycle = "permanent"
// impact = "利用者が意図した列の最新messageへ戻れないか、別列の閲覧位置や入力先を失う"
// distinction = "registryのキー設定testでは実ChatWindowの指定列routing・scroll owner・focusを検証できない。既存button/送信fixtureを共用する"
// @end-test-value
/** 各列の末尾移動を独立に配送し、隠れた列や他モードでは発火させず、送信時は受付完了まで待つ。 */
test("ChatWindow はMain/Auxiliaryの末尾移動buttonとshortcutを独立して配送する", async () => {
  const props = createChatWindowProps({
    messages: [{ role: "assistant", text: "message" }],
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousResizeObserver = globalThis.ResizeObserver;
  const dom = createChatDom(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { pretendToBeVisual: true },
  );
  const resizeCallbacks = new Map<Element, () => void>();
  /** 幅不足による単列化を再現できるよう、要素別に寸法通知を捕捉する。 */
  class TestResizeObserver {
    /** 監視先を登録する際に使う寸法変更コールバックを保存する。 */
    constructor(private readonly callback: () => void) {}
    /** 観測する列の要素に再測定の操作を対応付ける。 */
    observe(element: Element) {
      resizeCallbacks.set(element, this.callback);
    }
    /** 外れた要素への再測定操作を取り除く。 */
    unobserve(element: Element) {
      resizeCallbacks.delete(element);
    }
    /** 要素単位で通知を管理するため、接続全体の終了は実ブラウザーに委ねない。 */
    disconnect() {}
  }
  Object.defineProperty(dom.window, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    /** 操作列を移動しても旧イベント登録が不要な DOM として扱う。 */ value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    /** ショートカット後のフォーカス移動で旧イベント解除を実行しない。 */ value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    /** 対象要素を含むメッセージ列だけを、観測可能な末尾位置へ移動する。 */
    value(this: HTMLElement) {
      let parent = this.parentElement;
      while (parent && !parent.classList.contains("session-message-list")) {
        parent = parent.parentElement;
      }
      if (parent) {
        parent.scrollTop = Math.max(
          0,
          parent.scrollHeight - parent.clientHeight,
        );
      }
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
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    /** React 側が要求するフレームを JSDOM のタイマーで発火する。 */ value: (
      callback: FrameRequestCallback,
    ) => dom.window.setTimeout(callback, 0),
  });
  Object.defineProperty(dom.window, "requestAnimationFrame", {
    configurable: true,
    /** ウィンドウ側から要求されるフレームもタイマーで実行する。 */ value: (
      callback: FrameRequestCallback,
    ) => dom.window.setTimeout(callback, 0),
  });
  let root: Root | null = null;
  let sendCount = 0;
  let target: "main" | "auxiliary" = "main";
  let targetChangeCount = 0;
  let widthRatio = 0.5;
  let hasAuxiliary = true;
  let auxiliaryLoading = false;
  let auxiliaryError: string | null = null;
  let mainContentReady = true;
  let preview = false;
  const captureMessageListSendRef = React.createRef<
    ((sessionId: string) => () => void) | null
  >();
  let acceptSend: (() => void) | undefined;
  /** 現在の表示モード、幅、送信対象と取得状態から同じ Chat を再描画する。 */
  const renderChatWindow = () =>
    React.createElement(ChatWindow, {
      ...props,
      mainContent: preview
        ? React.createElement("div", null, "Preview")
        : undefined,
      composerProps: {
        ...props.composerProps,
        draft: "send this",
        isSendDisabled: false,
        /** 送信要求時に対象列の追従操作を捕捉し、受付相当の実行はテスト側に残す。 */
        onSendOrCancel: () => {
          sendCount += 1;
          acceptSend = captureMessageListSendRef.current?.(
            target === "main" ? "main" : "aux",
          );
        },
      },
      concurrentChats: {
        main: props.messageColumnProps,
        auxiliary: hasAuxiliary ? props.messageColumnProps : null,
        mainContentReady,
        loading: auxiliaryLoading,
        error: auxiliaryError,
        mainSession: {
          id: "main",
          messages: props.messageColumnProps.messages,
        },
        auxiliarySession: {
          id: "aux",
          messages: props.messageColumnProps.messages,
        },
        selectedAuxiliaryId: "aux",
        auxiliaryItems: [
          { id: "aux", label: "Auxiliary", preview: "Auxiliary" },
        ],
        target,
        widthRatio,
        scrollToLatestOnSend: true,
        captureMessageListSendRef,
        /** 別 Auxiliary の選択処理はこのスクロール検証では変更しない。 */
        onSelectAuxiliary() {},
        /** 末尾移動やショートカットが送信先を変えていないかを呼び出し件数で観測する。 */
        onTargetChange() {
          targetChangeCount += 1;
        },
        /** 幅比率はテスト側から切り替えるため、保存を実行しない。 */
        onWidthRatioChange() {},
      },
    });
  try {
    const settings = updateShortcutBinding(
      updateShortcutBinding(
        DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
        SHORTCUT_COMMAND_IDS.mainScrollToBottom,
        "windows",
        { key: "b", ctrlKey: true, shiftKey: true },
      ),
      SHORTCUT_COMMAND_IDS.auxiliaryScrollToBottom,
      "windows",
      { key: "n", ctrlKey: true, shiftKey: true },
    );
    getShortcutDispatcher()!.setSettings(settings);
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(renderChatWindow());
    });
    const messageList = dom.window.document.querySelector<HTMLDivElement>(
      ".session-concurrent-chat-main .session-message-list",
    );
    assert.ok(messageList);
    Object.defineProperties(messageList, {
      scrollHeight: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 40 },
    });
    await act(async () => {
      messageList.dispatchEvent(
        new dom.window.WheelEvent("wheel", { deltaY: -1 }),
      );
      dom.window.document
        .querySelector<HTMLDivElement>(
          ".session-concurrent-chat-auxiliary .session-message-list",
        )!
        .dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -1 }));
    });
    messageList.scrollTop = 10;
    await act(async () =>
      messageList.dispatchEvent(
        new dom.window.Event("scroll", { bubbles: true }),
      ),
    );
    const mainJumpButton = dom.window.document.querySelector<HTMLButtonElement>(
      ".session-concurrent-chat-main .message-list-jump-bottom-button",
    );
    const auxiliaryJumpButton =
      dom.window.document.querySelector<HTMLButtonElement>(
        ".session-concurrent-chat-auxiliary .message-list-jump-bottom-button",
      );
    assert.ok(mainJumpButton);
    assert.ok(auxiliaryJumpButton);
    assert.equal(
      dom.window.document.querySelector(
        ".session-action-dock .message-jump-bottom-button",
      ),
      null,
    );

    const auxiliaryMessageList =
      dom.window.document.querySelector<HTMLDivElement>(
        ".session-concurrent-chat-auxiliary .session-message-list",
      );
    assert.ok(auxiliaryMessageList);
    Object.defineProperties(auxiliaryMessageList, {
      scrollHeight: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 40 },
    });
    auxiliaryMessageList.scrollTop = 10;
    await act(async () => auxiliaryJumpButton.click());
    assert.equal(auxiliaryMessageList.scrollTop, 60);

    await act(async () => mainJumpButton.click());
    assert.equal(messageList.scrollTop, 60);
    await act(async () =>
      messageList.dispatchEvent(
        new dom.window.WheelEvent("wheel", { deltaY: -1 }),
      ),
    );
    messageList.scrollTop = 10;
    await act(async () =>
      messageList.dispatchEvent(
        new dom.window.Event("scroll", { bubbles: true }),
      ),
    );

    const sendButton = dom.window.document.querySelector<HTMLButtonElement>(
      ".session-action-dock-expanded-content .session-send-button",
    );
    assert.ok(sendButton);
    await act(async () => sendButton.click());
    assert.equal(sendCount, 1);
    assert.equal(messageList.scrollTop, 10);
    await act(async () => acceptSend?.());
    assert.equal(messageList.scrollTop, 60);

    target = "auxiliary";
    await act(async () => root?.render(renderChatWindow()));
    await act(async () =>
      auxiliaryMessageList.dispatchEvent(
        new dom.window.WheelEvent("wheel", { deltaY: -1 }),
      ),
    );
    auxiliaryMessageList.scrollTop = 10;
    await act(async () =>
      auxiliaryMessageList.dispatchEvent(
        new dom.window.Event("scroll", { bubbles: true }),
      ),
    );
    const auxiliarySendButton =
      dom.window.document.querySelector<HTMLButtonElement>(
        ".session-action-dock-expanded-content .session-send-button",
      );
    assert.ok(auxiliarySendButton);
    await act(async () => auxiliarySendButton.click());
    assert.equal(sendCount, 2);
    assert.equal(auxiliaryMessageList.scrollTop, 10);
    await act(async () => acceptSend?.());
    assert.equal(auxiliaryMessageList.scrollTop, 60);

    const composer = dom.window.document.querySelector<HTMLTextAreaElement>(
      ".session-action-dock-expanded-content textarea",
    )!;
    composer.focus();
    /** 両列の位置を末尾から離し、利用者がスクロールした状態へ戻す。 */
    const resetScroll = async () => {
      messageList.scrollTop = 10;
      auxiliaryMessageList.scrollTop = 10;
      await act(async () => {
        messageList.dispatchEvent(
          new dom.window.WheelEvent("wheel", { deltaY: -1 }),
        );
        auxiliaryMessageList.dispatchEvent(
          new dom.window.WheelEvent("wheel", { deltaY: -1 }),
        );
        messageList.dispatchEvent(
          new dom.window.Event("scroll", { bubbles: true }),
        );
        auxiliaryMessageList.dispatchEvent(
          new dom.window.Event("scroll", { bubbles: true }),
        );
      });
    };
    /** 指定キーと修飾キーを入力欄などへ届け、ショートカットで既定動作が止まったか返す。 */
    const press = async (
      key: string,
      options: KeyboardEventInit = {},
      element: HTMLElement = composer,
    ) => {
      const event = new dom.window.KeyboardEvent("keydown", {
        key,
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        ...options,
      });
      await act(async () => element.dispatchEvent(event));
      return event.defaultPrevented;
    };
    await resetScroll();
    assert.equal(await press("b"), true);
    assert.equal(messageList.scrollTop, 60);
    assert.equal(auxiliaryMessageList.scrollTop, 10);
    target = "main";
    await act(async () => root?.render(renderChatWindow()));
    await resetScroll();
    assert.equal(await press("n"), true);
    assert.equal(messageList.scrollTop, 10);
    assert.equal(auxiliaryMessageList.scrollTop, 60);
    assert.equal(targetChangeCount, 0);
    assert.equal(dom.window.document.activeElement, composer);
    assert.equal(sendCount, 2);

    const columns = dom.window.document.querySelector<HTMLElement>(
      ".session-concurrent-chat-columns",
    )!;
    const mainColumn = columns.querySelector<HTMLElement>(
      ".session-concurrent-chat-main",
    )!;
    const auxiliaryColumn = columns.querySelector<HTMLElement>(
      ".session-concurrent-chat-auxiliary",
    )!;
    mainColumn.style.setProperty("--session-region-min-width", "360px");
    auxiliaryColumn.style.setProperty("--session-region-min-width", "360px");
    columns.style.setProperty("--session-dock-splitter-size", "8px");
    let columnWidth = 700;
    Object.defineProperty(columns, "getBoundingClientRect", {
      configurable: true,
      /** 総幅を可変にして、対象列が単列レイアウトで非表示になる条件を作る。 */
      value: () => ({
        width: columnWidth,
        height: 300,
        top: 0,
        left: 0,
        right: columnWidth,
        bottom: 300,
      }),
    });
    await act(async () => resizeCallbacks.get(columns)?.());
    assert.equal(columns.classList.contains("is-single-chat"), true);
    for (const visibleTarget of ["main", "auxiliary"] as const) {
      target = visibleTarget;
      await act(async () => root?.render(renderChatWindow()));
      await resetScroll();
      const hiddenColumn = target === "main" ? auxiliaryColumn : mainColumn;
      const visibleColumn = target === "main" ? mainColumn : auxiliaryColumn;
      assert.equal(hiddenColumn.hasAttribute("inert"), true);
      assert.equal(hiddenColumn.getAttribute("aria-hidden"), "true");
      assert.equal(visibleColumn.hasAttribute("inert"), false);
      assert.equal(visibleColumn.getAttribute("aria-hidden"), "false");
      assert.equal(await press(target === "main" ? "n" : "b"), false);
      assert.equal(messageList.scrollTop, 10);
      assert.equal(auxiliaryMessageList.scrollTop, 10);
      assert.equal(await press(target === "main" ? "b" : "n"), true);
      assert.equal(messageList.scrollTop, target === "main" ? 60 : 10);
      assert.equal(
        auxiliaryMessageList.scrollTop,
        target === "auxiliary" ? 60 : 10,
      );
    }
    columnWidth = 800;
    await act(async () => resizeCallbacks.get(columns)?.());
    assert.equal(columns.classList.contains("is-single-chat"), false);
    assert.equal(mainColumn.hasAttribute("inert"), false);
    assert.equal(auxiliaryColumn.hasAttribute("inert"), false);
    await resetScroll();
    assert.equal(await press("b"), true);
    assert.equal(await press("n"), true);
    assert.equal(messageList.scrollTop, 60);
    assert.equal(auxiliaryMessageList.scrollTop, 60);
    assert.equal(dom.window.document.activeElement, composer);
    assert.equal(targetChangeCount, 0);
    assert.equal(sendCount, 2);

    await resetScroll();
    for (const key of ["b", "n"]) {
      assert.equal(await press(key, { isComposing: true }), false);
      assert.equal(await press(key, { repeat: true }), false);
    }
    const terminal = dom.window.document.createElement("textarea");
    terminal.dataset.shortcutScope = "terminal";
    dom.window.document.body.append(terminal);
    for (const key of ["b", "n"])
      assert.equal(await press(key, {}, terminal), false);
    assert.equal(messageList.scrollTop, 10);
    assert.equal(auxiliaryMessageList.scrollTop, 10);
    terminal.remove();

    preview = true;
    await act(async () => root?.render(renderChatWindow()));
    for (const key of ["b", "n"]) assert.equal(await press(key), false);
    preview = false;
    widthRatio = 0;
    await act(async () => root?.render(renderChatWindow()));
    assert.equal(await press("n"), false);
    widthRatio = 1;
    await act(async () => root?.render(renderChatWindow()));
    assert.equal(await press("b"), false);
    widthRatio = 0.5;
    mainContentReady = false;
    await act(async () => root?.render(renderChatWindow()));
    assert.equal(await press("b"), false);
    mainContentReady = true;
    auxiliaryLoading = true;
    await act(async () => root?.render(renderChatWindow()));
    assert.equal(await press("n"), true);
    auxiliaryLoading = false;
    auxiliaryError = "Read failed";
    await act(async () => root?.render(renderChatWindow()));
    assert.equal(await press("n"), true);
    hasAuxiliary = false;
    await act(async () => root?.render(renderChatWindow()));
    assert.equal(await press("n"), false);
    auxiliaryError = null;
    auxiliaryLoading = true;
    await act(async () => root?.render(renderChatWindow()));
    assert.equal(await press("n"), false);
    const currentMainList = dom.window.document.querySelector<HTMLDivElement>(
      ".session-concurrent-chat-main .session-message-list",
    )!;
    Object.defineProperties(currentMainList, {
      scrollHeight: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 40 },
    });
    currentMainList.scrollTop = 10;
    assert.equal(await press("b"), true);
    assert.equal(currentMainList.scrollTop, 60);
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
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: previousResizeObserver,
    });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: previousRequestAnimationFrame,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "ChatWindowのMain/Auxiliary会話経路はcomposer入力による親更新後も表示済み画像のDOMとready状態を保持する"
// oracle = { type = "contract", ref = "src/chat/chat-window.tsx" }
// fault = "composer入力でConversationMessageColumnが既存画像を再mountし、画像DOMまたはready状態が失われてloadingへ戻る"
// observable = "Main/Auxiliaryのmessage-image HTMLElement identity、画像buttonのdisabled状態、親draft state marker、message-image-loadingの不在"
// observation_boundary = "component-behavior"
// scope = "ChatWindowのMain/Auxiliary ConversationMessageColumn会話経路"
// lifecycle = "permanent"
// impact = "入力中に表示済み会話が点滅せず、画像の再読込と周辺レイアウトの揺れを防ぐ"
// distinction = "getter評価回数やstable boundary単体ではなく、ChatWindowからMain/Auxiliary両列を通した実画像DOMとload後の状態を親draft更新前後で観測する"
// @end-test-value
/** Composer の入力が親を再描画しても、両列の表示済み画像を再マウントせず、読み込み済み状態を維持する。 */
test("ChatWindow はcomposer入力後もMain/Auxiliaryの表示済み画像DOMとready状態を保持する", async () => {
  const props = createChatWindowProps({
    messages: [
      { role: "assistant", text: "![cached](data:image/png;base64,AAAA)" },
    ],
  });
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousInputEvent = globalThis.InputEvent;
  const previousEvent = globalThis.Event;
  const previousNavigator = globalThis.navigator;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousResizeObserver = globalThis.ResizeObserver;
  const dom = createChatDom(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { pretendToBeVisual: true },
  );
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  /** 画像の読み込みと入力更新を実サイズ監視に依存させない。 */
  class TestResizeObserver {
    /** 画像を含む仮想行を観測してもブラウザーの寸法通知を発行しない。 */ observe() {}
    /** 仮想行から監視を外す要求は DOM を更新しない。 */ unobserve() {}
    /** 画像を保持する条件を検査した後に外部のサイズ監視を残さない。 */ disconnect() {}
  }
  const originalGetBoundingClientRect =
    dom.window.HTMLElement.prototype.getBoundingClientRect;
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
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    /** React の旧式入力イベント登録を、JSDOM の通常イベントへつなぐ。 */
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.addEventListener(name.replace(/^on/, ""), listener);
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    /** 旧式 API を通して追加した入力イベントを、同じ名前で解除する。 */
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.removeEventListener(name.replace(/^on/, ""), listener);
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    /** 入力操作で画像の表示位置を実スクロールに依存させない。 */ value() {},
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect =
    function getBoundingClientRect() {
      if (this.classList.contains("session-message-list")) {
        return {
          left: 0,
          top: 0,
          width: 960,
          height: 720,
          right: 960,
          bottom: 720,
          x: 0,
          y: 0,
          /** 発言列の矩形を JSON 化する場合も同じ測定値を返す。 */
          toJSON() {
            return this;
          },
        } as DOMRect;
      }
      if (this.classList.contains("session-message-virtual-row")) {
        return {
          left: 0,
          top: 0,
          width: 960,
          height: 168,
          right: 960,
          bottom: 168,
          x: 0,
          y: 0,
          /** 仮想行の矩形をオブジェクトとして返し、実レイアウトを不要にする。 */
          toJSON() {
            return this;
          },
        } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    };
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    /** 発言列と仮想行の外側の高さを別々に返す。 */
    get() {
      if (this.classList.contains("session-message-list")) return 720;
      if (this.classList.contains("session-message-virtual-row")) return 168;
      return 0;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    /** 表示中の発言列だけに、画像が入る表示領域の高さを持たせる。 */
    get() {
      return this.classList.contains("session-message-list") ? 720 : 0;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    /** 仮想配置後の項目の高さを発言列のスクロール全長として返す。 */
    get() {
      if (!this.classList.contains("session-message-list")) return 0;
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
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: dom.window.HTMLElement,
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: dom.window.Node,
  });
  Object.defineProperty(globalThis, "InputEvent", {
    configurable: true,
    value: dom.window.InputEvent,
  });
  Object.defineProperty(globalThis, "Event", {
    configurable: true,
    value: dom.window.Event,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    /** 入力更新後のグローバルの描画予約をタイマーで実行する。 */ value: (
      callback: FrameRequestCallback,
    ) => dom.window.setTimeout(callback, 0),
  });
  Object.defineProperty(dom.window, "requestAnimationFrame", {
    configurable: true,
    /** 画像列のウィンドウ内で予定したフレームを同じ方式で進める。 */ value: (
      callback: FrameRequestCallback,
    ) => dom.window.setTimeout(callback, 0),
  });
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(
        React.createElement(ConcurrentImageChatHarness, { baseProps: props }),
      );
    });

    const mainImage = dom.window.document.querySelector<HTMLImageElement>(
      ".session-concurrent-chat-main .message-image",
    );
    const auxiliaryImage = dom.window.document.querySelector<HTMLImageElement>(
      ".session-concurrent-chat-auxiliary .message-image",
    );
    const mainButton = mainImage?.closest<HTMLButtonElement>(
      ".message-image-trigger",
    );
    const auxiliaryButton = auxiliaryImage?.closest<HTMLButtonElement>(
      ".message-image-trigger",
    );
    assert.ok(mainImage);
    assert.ok(auxiliaryImage);
    assert.ok(mainButton);
    assert.ok(auxiliaryButton);

    await act(async () => {
      mainImage.dispatchEvent(new dom.window.Event("load"));
      auxiliaryImage.dispatchEvent(new dom.window.Event("load"));
    });
    assert.equal(mainButton.disabled, false);
    assert.equal(auxiliaryButton.disabled, false);

    const draft =
      dom.window.document.querySelector<HTMLTextAreaElement>("textarea");
    const setDraftValue = Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    assert.ok(draft);
    assert.ok(setDraftValue);
    draft.focus();
    await act(async () => {
      setDraftValue.call(draft, "typed prompt");
      const propertyChange = new dom.window.Event("propertychange", {
        bubbles: true,
      });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      draft.dispatchEvent(propertyChange);
      draft.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "typed prompt",
        }),
      );
    });

    assert.equal(draft.value, "typed prompt");
    assert.equal(
      dom.window.document.querySelector("[data-draft-state]")?.textContent,
      "typed prompt",
    );
    assert.equal(
      dom.window.document.querySelector<HTMLImageElement>(
        ".session-concurrent-chat-main .message-image",
      ),
      mainImage,
    );
    assert.equal(
      dom.window.document.querySelector<HTMLImageElement>(
        ".session-concurrent-chat-auxiliary .message-image",
      ),
      auxiliaryImage,
    );
    assert.equal(mainButton.disabled, false);
    assert.equal(auxiliaryButton.disabled, false);
    assert.equal(
      dom.window.document.querySelector(
        ".session-concurrent-chat-main .message-image-loading",
      ),
      null,
    );
    assert.equal(
      dom.window.document.querySelector(
        ".session-concurrent-chat-auxiliary .message-image-loading",
      ),
      null,
    );
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
    Object.defineProperty(globalThis, "InputEvent", {
      configurable: true,
      value: previousInputEvent,
    });
    Object.defineProperty(globalThis, "Event", {
      configurable: true,
      value: previousEvent,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: previousNavigator,
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: previousResizeObserver,
    });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: previousRequestAnimationFrame,
    });
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.HTMLElement.prototype.getBoundingClientRect =
      originalGetBoundingClientRect;
    if (originalOffsetHeight) {
      Object.defineProperty(
        dom.window.HTMLElement.prototype,
        "offsetHeight",
        originalOffsetHeight,
      );
    } else {
      delete (
        dom.window.HTMLElement.prototype as unknown as { offsetHeight?: number }
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
        dom.window.HTMLElement.prototype as unknown as { clientHeight?: number }
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
        dom.window.HTMLElement.prototype as unknown as { scrollHeight?: number }
      ).scrollHeight;
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Concurrent splitterはドラッグ中の表示幅を局所更新し、pointer完了時だけ最小幅で補正した幅を通知する。両端の片側全幅、cancel確定、クリックとの分離を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Auxiliary Session (Issue #710)" }
// fault = "drag中に保存ownerへ中間値を通知する、表示幅が更新されない、最小幅を割る、片側全幅へ切り替わらない、またはpointer完了を確定callbackへ伝えない"
// observable = "drag中のcolumnsのgridTemplateColumns、onWidthRatioChangeの値とpointer完了callback回数"
// observation_boundary = "component-behavior"
// scope = "concurrent-chat-shell"
// lifecycle = "permanent"
// @end-test-value
/** ドラッグ中は幅表示だけを変え、終了・取消で補正済み比率を確定し、クリックの開閉操作とは分ける。 */
test("ConcurrentChatSplitter は drag と collapse click を分離する", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    /** グローバルのフレームをタイマーで進め、ドラッグ中に幅を確認できるようにする。 */ value:
      (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0),
  });
  Object.defineProperty(dom.window, "requestAnimationFrame", {
    configurable: true,
    /** ウィンドウ内で次のフレームに予約された寸法更新もタイマーで進める。 */ value:
      (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0),
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    /** JSDOM にないポインター捕捉を受け入れ、ドラッグの処理を継続させる。 */ value() {},
  });
  let root: Root | null = null;
  const ratios: number[] = [];
  let commits = 0;
  try {
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(
        React.createElement(
          "div",
          { style: { width: "1000px" } },
          React.createElement("div", {
            className: "session-concurrent-chat-main",
          }),
          React.createElement(ConcurrentChatSplitter, {
            widthRatio: 0.1,
            /** 比率通知を記録し、ドラッグ途中では保存側へ値が渡らないか確認する。 */
            onWidthRatioChange: (ratio: number) => ratios.push(ratio),
            /** 比率の確定通知を数え、ポインター操作の終了と取消を検証する。 */
            onWidthRatioCommit: () => {
              commits += 1;
            },
          }),
          React.createElement("div", {
            className: "session-concurrent-chat-auxiliary",
          }),
        ),
      );
    });
    const splitter = dom.window.document.querySelector<HTMLButtonElement>(
      ".concurrent-chat-splitter",
    );
    assert.ok(splitter);
    dom.window.document
      .querySelector<HTMLElement>(".session-concurrent-chat-main")
      ?.style.setProperty("--session-region-min-width", "360px");
    dom.window.document
      .querySelector<HTMLElement>(".session-concurrent-chat-auxiliary")
      ?.style.setProperty("--session-region-min-width", "360px");
    Object.defineProperty(splitter.parentElement, "getBoundingClientRect", {
      configurable: true,
      /** 座標から列の幅比率を計算できるよう、全体領域の矩形を固定する。 */
      value: () => ({
        width: 1000,
        height: 300,
        top: 0,
        left: 0,
        right: 1000,
        bottom: 300,
      }),
    });
    Object.defineProperty(splitter, "getBoundingClientRect", {
      configurable: true,
      /** ドラッグ開始時のハンドル位置と幅を測定用に固定する。 */
      value: () => ({
        width: 20,
        height: 300,
        top: 0,
        left: 500,
        right: 520,
        bottom: 300,
      }),
    });
    /** 同一ポインター ID と指定座標で、開始から終了までのイベント列を作る。 */
    const pointerEvent = (type: string, clientX: number) => {
      const event = new dom.window.Event(type, { bubbles: true });
      Object.defineProperties(event, {
        button: { value: 0 },
        clientX: { value: clientX },
        clientY: { value: 0 },
        pointerId: { value: 1 },
      });
      return event;
    };
    await act(async () => {
      splitter.dispatchEvent(pointerEvent("pointerdown", 500));
      splitter.dispatchEvent(pointerEvent("pointermove", 510));
    });
    assert.equal(
      ratios.length,
      0,
      "intermediate geometry must not update the saved width owner",
    );
    assert.equal(commits, 0);
    assert.equal(
      splitter.parentElement?.style.gridTemplateColumns,
      `minmax(0, ${1 - 360 / 980}fr) var(--session-dock-splitter-size) minmax(0, ${360 / 980}fr)`,
    );
    await act(async () => {
      splitter.dispatchEvent(pointerEvent("pointerup", 510));
    });
    assert.ok(ratios.length > 0);
    assert.equal(ratios.at(-1), 360 / 980);
    assert.equal(commits, 1);
    await act(async () => {
      splitter.dispatchEvent(pointerEvent("pointerdown", 500));
      splitter.dispatchEvent(pointerEvent("pointermove", 490));
      splitter.dispatchEvent(pointerEvent("pointercancel", 490));
    });
    assert.equal(commits, 2);
    assert.ok(Math.abs(ratios.at(-1)! - 370 / 980) < 1e-9);
    await act(async () => {
      splitter.dispatchEvent(pointerEvent("pointerdown", 510));
      splitter.dispatchEvent(pointerEvent("pointermove", 490));
      splitter.dispatchEvent(pointerEvent("pointerup", 490));
    });
    assert.ok(Math.abs(ratios.at(-1)! - 380 / 980) < 1e-9);

    await act(async () => {
      splitter.dispatchEvent(pointerEvent("pointerdown", 510));
      splitter.dispatchEvent(pointerEvent("pointermove", 1010));
      splitter.dispatchEvent(pointerEvent("pointerup", 1010));
    });
    assert.equal(ratios.at(-1), 0);
    await act(async () => {
      splitter.dispatchEvent(pointerEvent("pointerdown", 510));
      splitter.dispatchEvent(pointerEvent("pointermove", -200));
      splitter.dispatchEvent(pointerEvent("pointerup", -200));
      splitter.click();
    });
    assert.equal(ratios.at(-1), 1);

    await act(async () => {
      splitter.dispatchEvent(pointerEvent("pointerdown", 510));
      splitter.dispatchEvent(pointerEvent("pointerup", 510));
      splitter.click();
    });
    assert.equal(ratios.at(-1), 0);
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
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: previousRequestAnimationFrame,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Concurrent splitterは幅0からのドラッグやキーで開かず、左右どちらを閉じてもクリックで両側表示へ戻し、変更確定をcallbackへ伝える"
// oracle = { type = "contract", ref = "issue-710-zero-width-splitter-drag" }
// fault = "幅0のAuxiliaryがpointer dragやキーで意図せず開く、クリックで既定幅へ戻らない、または変更確定を伝えない"
// observable = "幅0からのpointer drag／keyboard操作／clickによる比率とcommit callback回数"
// observation_boundary = "component-behavior"
// scope = "concurrent-chat-shell"
// lifecycle = "permanent"
// @end-test-value
/** 左右の折りたたみ幅からはクリックだけで既定比率に戻し、ドラッグやキー入力では開かない。 */
test("ConcurrentChatSplitter は幅0をclickだけで既定幅へ戻す", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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
  Object.defineProperty(dom.window.HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    /** 閉じた列に対してもポインター捕捉要求はエラーにしない。 */ value() {},
  });
  let root: Root | null = null;
  const ratios: number[] = [];
  let commits = 0;
  try {
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(
        React.createElement(
          "div",
          { style: { width: "1000px" } },
          React.createElement("div", {
            className: "session-concurrent-chat-main",
          }),
          React.createElement(ConcurrentChatSplitter, {
            widthRatio: 0,
            /** 閉じた Auxiliary を操作したときに通知された幅を記録する。 */
            onWidthRatioChange: (ratio: number) => ratios.push(ratio),
            /** 閉じた Auxiliary がクリックで復帰したときの確定回数を観測する。 */
            onWidthRatioCommit: () => {
              commits += 1;
            },
          }),
          React.createElement("div", {
            className: "session-concurrent-chat-auxiliary",
          }),
        ),
      );
    });
    const splitter = dom.window.document.querySelector<HTMLButtonElement>(
      ".concurrent-chat-splitter",
    );
    assert.ok(splitter);
    dom.window.document
      .querySelector<HTMLElement>(".session-concurrent-chat-main")
      ?.style.setProperty("--session-region-min-width", "360px");
    dom.window.document
      .querySelector<HTMLElement>(".session-concurrent-chat-auxiliary")
      ?.style.setProperty("--session-region-min-width", "360px");
    Object.defineProperty(splitter.parentElement, "getBoundingClientRect", {
      configurable: true,
      /** 折りたたみ状態の列全体に一貫した測定値を提供する。 */
      value: () => ({
        width: 1000,
        height: 300,
        top: 0,
        left: 0,
        right: 1000,
        bottom: 300,
      }),
    });
    /** 幅ゼロの列へドラッグを試すポインターイベントを組み立てる。 */
    const pointerEvent = (type: string, clientX: number) => {
      const event = new dom.window.Event(type, { bubbles: true });
      Object.defineProperties(event, {
        button: { value: 0 },
        clientX: { value: clientX },
        clientY: { value: 0 },
        pointerId: { value: 1 },
      });
      return event;
    };
    await act(async () => {
      splitter.dispatchEvent(pointerEvent("pointerdown", 500));
      splitter.dispatchEvent(pointerEvent("pointermove", 480));
      splitter.dispatchEvent(pointerEvent("pointerup", 480));
    });
    assert.equal(ratios.length, 0);
    await act(async () =>
      splitter.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(ratios.length, 0);
    assert.equal(commits, 1);
    await act(async () => {
      splitter.dispatchEvent(pointerEvent("pointerdown", 500));
      splitter.dispatchEvent(pointerEvent("pointerup", 500));
      splitter.click();
    });
    assert.equal(ratios.at(-1), 0.5);
    assert.equal(commits, 2);
    await act(async () =>
      root!.render(
        React.createElement(
          "div",
          { style: { width: "1000px" } },
          React.createElement("div", {
            className: "session-concurrent-chat-main",
          }),
          React.createElement(ConcurrentChatSplitter, {
            widthRatio: 0.5,
            /** 開いた状態へ切り替えた後も比率通知を同じ記録に集める。 */
            onWidthRatioChange: (ratio: number) => ratios.push(ratio),
            /** 展開後の操作による確定通知を数える。 */
            onWidthRatioCommit: () => {
              commits += 1;
            },
          }),
          React.createElement("div", {
            className: "session-concurrent-chat-auxiliary",
          }),
        ),
      ),
    );
    const expandedSplitter =
      dom.window.document.querySelector<HTMLButtonElement>(
        ".concurrent-chat-splitter",
      );
    assert.ok(expandedSplitter);
    await act(async () =>
      expandedSplitter.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(commits, 3);
    assert.ok(ratios.at(-1)! > 0.5);
    await act(async () =>
      root!.render(
        React.createElement(ConcurrentChatSplitter, {
          widthRatio: 1,
          /** 反対側の Main を復帰させた場合にも比率を記録する。 */
          onWidthRatioChange: (ratio: number) => ratios.push(ratio),
          /** Main 側の再展開でも変更が確定したか調べる。 */
          onWidthRatioCommit: () => {
            commits += 1;
          },
        }),
      ),
    );
    const restoreMain = dom.window.document.querySelector<HTMLButtonElement>(
      '[aria-label="Open Main"]',
    );
    assert.ok(restoreMain);
    const before = ratios.length;
    await act(async () => restoreMain.click());
    assert.equal(ratios.length, before + 1);
    assert.equal(ratios.at(-1), 0.5);
    assert.equal(commits, 4);
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
// claim = "共通switcherは実行と未読を選択と独立して示し、検索中の矢印・IME入力、検索0件、候補確定・outside click・Escape後のfocus復帰と候補消滅時のpopover閉鎖を扱う"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#main-conversation-switcher; docs/design/auxiliary-session.md: UI flow" }
// fault = "実行リングや未読を未表示にする、未読をタイトル以外や選択状態と混同する、非視覚的な状態が欠ける、または検索・選択・取消・focus復帰を壊す"
// observable = "リングの所属と状態説明、タイトルの未読マーカーとoptionのaria-selected、検索0件時のDOM、空labelのaccessible name、選択callback、popoverの表示状態、document.activeElement"
// observation_boundary = "component-behavior"
// scope = "session-switcher"
// lifecycle = "permanent"
// @end-test-value
/** 選択・未読・処理中を区別し、絞り込み・確定・取消・候補消滅の後の表示とフォーカスを確かめる。 */
test("SessionSwitcher は検索・確定・取消操作とfocus復帰を扱う", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousEvent = globalThis.Event;
  const previousInputEvent = globalThis.InputEvent;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div><div id="outside"></div></body></html>',
  );
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    /** 検索入力がフォーカスを受ける際の旧イベント登録には処理を要しない。 */ value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    /** 検索入力から起点ボタンへ移る際に旧イベント解除を許容する。 */ value() {},
  });
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
  Object.defineProperty(globalThis, "Event", {
    configurable: true,
    value: dom.window.Event,
  });
  Object.defineProperty(globalThis, "InputEvent", {
    configurable: true,
    value: dom.window.InputEvent,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    /** グローバルのフレーム予約をタイマーで進め、ポップオーバーのフォーカスを反映する。 */ value:
      (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0),
  });
  Object.defineProperty(dom.window, "requestAnimationFrame", {
    configurable: true,
    /** DOM ウィンドウで予約されたフレームもタイマーで進める。 */ value: (
      callback: FrameRequestCallback,
    ) => dom.window.setTimeout(callback, 0),
  });
  let root: Root | null = null;
  const selected: string[] = [];
  try {
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(
        React.createElement(SessionSwitcher, {
          ariaLabel: "Auxiliary conversation",
          options: [
            {
              id: "a",
              label: "Alpha",
              preview: "first",
              isProcessing: true,
              hasUnreadResult: true,
              icon: React.createElement("span", null, "A"),
            },
            {
              id: "b",
              label: "Beta",
              preview: "second",
              hasUnreadResult: true,
              icon: React.createElement("span", null, "B"),
            },
          ],
          selectedId: "a",
          searchable: true,
          /** 移動後の外部状態を変えず、候補内のキーボード操作を観測する。 */
          onMove() {},
          /** 確定された会話の ID を記録する。 */
          onSelect: (id: string) => selected.push(id),
        }),
      );
    });
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".session-switcher-current",
    );
    assert.ok(trigger);
    await act(async () => trigger.click());
    const search = dom.window.document.querySelector<HTMLInputElement>(
      ".session-switcher-search",
    );
    assert.ok(search);
    assert.equal(
      dom.window.document.querySelectorAll('[role="option"]').length,
      2,
    );
    const initialOptions = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        '[role="option"]',
      ),
    ];
    assert.ok(
      trigger.querySelector(
        ".session-switcher-icon > .session-switcher-processing-ring",
      ),
    );
    assert.equal(
      trigger.getAttribute("aria-description"),
      "Processing; Unread Result",
    );
    assert.deepEqual(
      [...trigger.querySelectorAll(".has-unread-result")].map(
        (item) => item.textContent,
      ),
      ["Alpha"],
    );
    assert.ok(
      initialOptions[0]?.querySelector(
        ".session-switcher-icon > .session-switcher-processing-ring",
      ),
    );
    assert.equal(
      initialOptions[1]?.querySelector(".session-switcher-processing-ring"),
      null,
    );
    for (const [index, label] of ["Alpha", "Beta"].entries()) {
      assert.equal(
        initialOptions[index].getAttribute("aria-description"),
        index === 0 ? "Processing; Unread Result" : "Unread Result",
      );
      assert.equal(
        initialOptions[index].getAttribute("aria-selected"),
        String(index === 0),
      );
      assert.deepEqual(
        [...initialOptions[index].querySelectorAll(".has-unread-result")].map(
          (item) => item.textContent,
        ),
        [label],
      );
    }
    assert.equal(initialOptions[0]?.getAttribute("title"), "Processing");
    assert.equal(initialOptions[1]?.getAttribute("title"), null);
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(search, "beta");
      search.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "beta",
        }),
      );
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
    const filteredOptions = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        '[role="option"]',
      ),
    ];
    assert.equal(filteredOptions.length, 1);
    assert.equal(
      filteredOptions[0]?.querySelector(".session-switcher-option-label")
        ?.textContent,
      "Beta",
    );
    assert.equal(
      filteredOptions[0]?.querySelector(".session-switcher-processing-ring"),
      null,
    );
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(search, "missing");
      search.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "missing",
        }),
      );
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
    assert.equal(
      dom.window.document.querySelectorAll('[role="option"]').length,
      0,
    );
    assert.equal(
      dom.window.document.querySelector(".session-switcher-empty"),
      null,
    );
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(search, "beta");
      search.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "beta",
        }),
      );
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
    await act(async () =>
      search.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      ),
    );
    assert.equal(
      dom.window.document.activeElement,
      dom.window.document.querySelector('[role="option"]'),
    );
    await act(async () => trigger.click());
    await act(async () => trigger.click());
    await act(async () =>
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          isComposing: true,
        }),
      ),
    );
    assert.ok(dom.window.document.querySelector('[role="listbox"]'));
    await act(async () =>
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    assert.equal(dom.window.document.querySelector('[role="listbox"]'), null);
    await act(async () => trigger.click());
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(
          '[role="option"][aria-selected="false"]',
        )
        ?.click(),
    );
    assert.deepEqual(selected, ["b"]);
    assert.equal(dom.window.document.querySelector('[role="listbox"]'), null);
    await act(async () => trigger.click());
    await act(async () =>
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    assert.equal(dom.window.document.querySelector('[role="listbox"]'), null);
    assert.equal(dom.window.document.activeElement, trigger);
    await act(async () => trigger.click());
    await act(async () =>
      dom.window.document
        .getElementById("outside")
        ?.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })),
    );
    assert.equal(dom.window.document.querySelector('[role="listbox"]'), null);

    await act(async () => {
      root?.render(
        React.createElement(SessionSwitcher, {
          ariaLabel: "Auxiliary conversation",
          options: [
            {
              id: "unnamed",
              label: "",
              isProcessing: true,
              hasUnreadResult: true,
              icon: React.createElement("span", null, "?"),
            },
          ],
          selectedId: "unnamed",
          /** 表示ラベルのない Auxiliary では実際の移動を行わない。 */
          onMove() {},
          /** 選択名が空のときは識別名だけを調べ、確定操作を記録しない。 */
          onSelect() {},
        }),
      );
    });
    const unnamedTrigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".session-switcher-current",
    );
    assert.ok(unnamedTrigger);
    assert.equal(
      unnamedTrigger.getAttribute("aria-label"),
      "Auxiliary conversation",
    );
    assert.equal(
      unnamedTrigger.getAttribute("aria-description"),
      "Processing; Unread Result",
    );
    await act(async () => unnamedTrigger.click());
    const unnamedOption =
      dom.window.document.querySelector<HTMLButtonElement>('[role="option"]');
    assert.ok(unnamedOption);
    assert.equal(
      unnamedOption.getAttribute("aria-label"),
      "Auxiliary conversation",
    );
    assert.equal(
      unnamedOption.getAttribute("aria-description"),
      "Processing; Unread Result",
    );

    assert.ok(dom.window.document.querySelector('[role="listbox"]'));
    await act(async () => {
      root?.render(
        React.createElement(SessionSwitcher, {
          ariaLabel: "Auxiliary conversation",
          options: [],
          selectedId: "",
          searchable: true,
          /** 候補が消えたケースでは外部の位置変更は行わない。 */
          onMove() {},
          /** 候補がなくなったポップオーバーでは新しい会話を選ばない。 */
          onSelect() {},
        }),
      );
    });
    assert.equal(dom.window.document.querySelector('[role="listbox"]'), null);
    const emptyTrigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".session-switcher-current",
    );
    assert.ok(emptyTrigger);
    assert.equal(emptyTrigger.disabled, true);
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
    Object.defineProperty(globalThis, "Event", {
      configurable: true,
      value: previousEvent,
    });
    Object.defineProperty(globalThis, "InputEvent", {
      configurable: true,
      value: previousInputEvent,
    });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: previousRequestAnimationFrame,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "確定高さの変更と局所的なdock高さ更新のどちらでも、中央の残余高さが160px未満なら非表示・操作不可とし、160pxへの復帰で会話stateとscroll位置を保つ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 中央表示最低高" }
// fault = "最低高境界が逆転する、局所高さ更新を監視せず古い中央表示を使う、または非表示時のunmountで会話stateやscroll位置を失う"
// observable = "prop変更と局所CSS属性変更前後のaria-hidden、child instance、state、scrollTop、局所変更したCSS高さ"
// observation_boundary = "component-behavior"
// scope = "SessionChatScreen central visibility lifecycle"
// lifecycle = "permanent"
// impact = "ActionDockを広げた後の会話継続位置と操作可能状態を守る"
// distinction = "CSS描画寸法は対象外とし、寸法通知やprop確定なしの局所CSS更新を実componentへ渡す。native MutationObserverを通る表示判定と会話state保持は型検査やCSSのstatic checkで代替できず、小規模なJSDOM操作で確認する"
// @end-test-value
/** 中央の高さが 160px を下回ると操作対象から外し、復帰したときも子とスクロール位置を保持する。 */
test("SessionChatScreen は中央160px境界で非表示と復帰を切り替えて状態を保持する", async () => {
  const previousActEnvironment = (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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

  Object.defineProperty(dom.window, "innerWidth", {
    value: 1600,
    configurable: true,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    /** 中央の残り高さを計算する親の測定値を 800px に固定する。 */ get() {
      return 800;
    },
  });
  const style = dom.window.document.createElement("style");
  style.textContent =
    ".session-message-stack { --session-region-min-height: 160px; }";
  dom.window.document.head.append(style);

  /** 中央の表示変更で再マウントされなかったかを検出する、内部状態を持つ子コンポーネント。 */
  function StatefulCentral() {
    const [count, setCount] = React.useState(0);
    return React.createElement(
      "button",
      {
        type: "button",
        "data-central-state": "true",
        /** 中央部を一度操作し、非表示化後にも残るカウントを増やす。 */
        onClick: () => setCount((current) => current + 1),
      },
      `state:${count}`,
    );
  }
  /** 操作ドックの確定高さだけを切り替え、同じ中央コンポーネントを持つ画面を組み立てる。 */
  const renderScreen = (height: number) =>
    React.createElement(SessionChatScreen, {
      mode: "agent" as const,
      header: null,
      headerSplitter: null,
      isHeaderVisible: true,
      messageColumn: React.createElement(StatefulCentral),
      rightPane: null,
      style: {
        "--session-action-dock-height": `${height}px`,
        "--session-header-dock-row-height": "48px",
        "--session-dock-splitter-size": "20px",
      } as React.CSSProperties,
      actionDock: React.createElement("div", null, "Composer"),
      actionDockSplitter: null,
      isActionDockExpanded: true,
      splitter: null,
    });

  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(
        dom.window.document.getElementById("root") as HTMLElement,
      );
      root.render(renderScreen(552));
    });
    const button = dom.window.document.querySelector<HTMLButtonElement>(
      "[data-central-state='true']",
    );
    assert.ok(button);
    assert.equal(
      dom.window.document
        .querySelector(".session-message-stack")
        ?.getAttribute("aria-hidden"),
      "false",
    );
    const central = dom.window.document.querySelector<HTMLElement>(
      ".session-message-stack",
    )!;
    central.scrollTop = 42;
    await act(async () => button.click());
    assert.equal(button.textContent, "state:1");

    await act(async () => root?.render(renderScreen(553)));
    assert.equal(
      dom.window.document
        .querySelector(".session-message-stack")
        ?.getAttribute("aria-hidden"),
      "true",
    );
    assert.ok(central.hasAttribute("inert"));
    assert.ok(
      dom.window.document.querySelector(
        ".session-chat-layout.is-central-collapsed",
      ),
    );
    assert.equal(
      dom.window.document.querySelector("[data-central-state='true']"),
      button,
    );
    assert.equal(button.textContent, "state:1");

    await act(async () => root?.render(renderScreen(552)));
    assert.equal(
      dom.window.document.querySelector("[data-central-state='true']"),
      button,
    );
    assert.equal(button.textContent, "state:1");
    assert.equal(central.getAttribute("aria-hidden"), "false");
    assert.equal(central.scrollTop, 42);
    assert.equal(central.hasAttribute("inert"), false);
    const layout = dom.window.document.querySelector<HTMLElement>(
      ".session-chat-layout",
    )!;
    await act(async () => {
      layout.style.setProperty("--session-action-dock-height", "553px");
    });
    assert.equal(central.getAttribute("aria-hidden"), "true");
    assert.ok(central.hasAttribute("inert"));
    await act(async () => {
      layout.style.setProperty("--session-action-dock-height", "552px");
    });
    assert.equal(central.getAttribute("aria-hidden"), "false");
    assert.equal(central.hasAttribute("inert"), false);
    assert.equal(
      dom.window.document.querySelector("[data-central-state='true']"),
      button,
    );
    assert.equal(button.textContent, "state:1");
    assert.equal(central.scrollTop, 42);
    Object.defineProperty(dom.window, "innerWidth", {
      value: 1200,
      configurable: true,
    });
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("resize")),
    );
    assert.equal(central.getAttribute("aria-hidden"), "true");
    await act(async () => root?.render(renderScreen(512)));
    assert.equal(central.getAttribute("aria-hidden"), "false");
    assert.equal(button.textContent, "state:1");
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
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
    dom.window.close();
  }
});
