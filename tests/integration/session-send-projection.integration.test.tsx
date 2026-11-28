import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { ComposerControllerRegistry } from "../../src/chat/composer-controller.js";
import { createStaticTextConversationMessageColumnProps } from "../../src/chat/chat-window-adapter.js";
import { useConversationMessageColumn } from "../../src/chat/conversation-message-column.js";
import { useMainSessionRuntime } from "../../src/chat/runtime/use-main-session-runtime.js";
import { useAuxiliaryWorkspace } from "../../src/chat/use-auxiliary-workspace.js";
import type { OwnedLiveSessionRunState } from "../../src/chat/runtime/session-live-run-state.js";
import { useAuxiliaryDraftPersistence } from "../../src/chat/auxiliary/use-auxiliary-draft-persistence.js";
import type { AuxiliaryDraftRecord } from "../../src-shared/auxiliary/auxiliary-draft-contract.js";

/** 送信受付や保存済み会話を任意の順に応答させるため、保留中の Promise と成功・失敗の操作を返す。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** 実ランタイムと会話列のフックを JSDOM に接続し、Main と Auxiliary を独立した下書き・受付通知で操作できる検証環境を用意する。 */
async function setup() {
  const dom = new JSDOM("<div id='root'></div>", {
    url: "https://withmate.test",
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  let api!: WithMateWindowApi;
  runInNewContext(
    readFileSync(
      new URL(
        "../../scripts/benchmarks/benchmark-composer-input-preload.cjs",
        import.meta.url,
      ),
      "utf8",
    ),
    {
      /** ベンチマーク用 preload に、検証環境の API 公開用ブリッジを渡す。 */
      require: () => ({
        contextBridge: {
          /** Main と二つの Auxiliary を含む公開 API を捕捉し、受付と保存応答を差し替えられるようにする。 */ exposeInMainWorld:
            (_key: string, value: WithMateWindowApi) => {
              api = value;
            },
        },
      }),
      process: { argv: ["--benchmark-auxiliary-count=2"] },
      Buffer,
    },
  );
  const registry = new ComposerControllerRegistry();
  const drafts = new Map<string, AuxiliaryDraftRecord>();
  api.getAuxiliaryDraft = async (id) => {
    if (drafts.has(id)) return drafts.get(id)!;
    const session = await api.getAuxiliarySession(id);
    if (!session) return null;
    const record = {
      auxiliarySessionId: id,
      parentSessionId: session.parentSessionId,
      incarnation: session.createdAt,
      durableRevision: 0,
      text: session.composerDraft,
      updatedAt: session.updatedAt,
    };
    drafts.set(id, record);
    return record;
  };
  api.getAuxiliarySessionStatus = async (id) => {
    const session = await api.getAuxiliarySession(id);
    return session
      ? {
          id,
          parentSessionId: session.parentSessionId,
          createdAt: session.createdAt,
          incarnation: session.createdAt,
          runState: session.runState,
        }
      : null;
  };
  api.saveAuxiliaryDraft = async (request) => {
    const current = drafts.get(request.auxiliarySessionId);
    if (
      !current ||
      current.incarnation !== request.incarnation ||
      current.durableRevision !== request.expectedDurableRevision
    )
      return { outcome: "stale" };
    const record = {
      ...current,
      text: request.text,
      durableRevision: current.durableRevision + 1,
      updatedAt: request.updatedAt,
    };
    drafts.set(record.auxiliarySessionId, record);
    return { outcome: "saved", ack: record };
  };
  let listener:
    Parameters<WithMateWindowApi["subscribeLiveSessionRun"]>[0] | undefined;
  const queueListeners = new Set<(id: string) => void>();
  api.onSessionTurnQueueChanged = (next) => {
    queueListeners.add(next);
    return () => {
      queueListeners.delete(next);
    };
  };
  api.subscribeLiveSessionRun = (next) => {
    listener = next;
    return () => {
      listener = undefined;
    };
  };
  const baseProps = createStaticTextConversationMessageColumnProps({
    sessionId: "benchmark-main",
    characterId: "character",
    characterName: "Mate",
    characterIconPath: "",
    messages: [],
    messageListRef: React.createRef(),
    isRunning: false,
  });
  let current!: ReturnType<typeof Probe>;
  /** Main と選択中の Auxiliary に対して実ランタイム・下書き永続化・会話列投影を組み立て、現在の実行状態を会話ごとに割り当てる。 */
  function Probe() {
    const main = useMainSessionRuntime({
      api,
      selectedId: "benchmark-main",
      composerRegistry: registry,
    });
    const auxiliary = useAuxiliaryWorkspace({
      api,
      parentSessionId: "benchmark-main",
    });
    const persistence = useAuxiliaryDraftPersistence({
      api,
      composerRegistry: registry,
      touchRecency: auxiliary.touchRecency,
      /** Composer レジストリを参照して下書きの変更が凍結中かを判定する。 */ isFrozen:
        () => registry.isFrozen,
    });
    const [live, setLive] = useState<OwnedLiveSessionRunState>({
      ownerSessionId: null,
      state: null,
    });
    const mainColumn = useConversationMessageColumn({
      session: main.sessions[0] ?? null,
      baseProps: {
        ...baseProps,
        onTurnReceiptsObserved: main.observeTurnReceipts,
      },
      enabled: true,
      api,
      liveRun: live.ownerSessionId === "benchmark-main" ? live.state : null,
    });
    const auxiliaryColumn = useConversationMessageColumn({
      session: auxiliary.selectedSession
        ? {
            ...auxiliary.selectedSession,
            incarnationId: auxiliary.selectedSession.createdAt,
          }
        : null,
      baseProps: {
        ...baseProps,
        onTurnReceiptsObserved: main.observeTurnReceipts,
      },
      enabled: true,
      api,
      messageSourceKind: "auxiliary",
      liveRun: live.ownerSessionId === auxiliary.selectedId ? live.state : null,
    });
    return {
      main,
      auxiliary,
      persistence,
      live,
      setLive,
      mainColumn,
      auxiliaryColumn,
    };
  }
  /** 描画ごとにフックの検証用ハンドルを更新する。実際の会話 UI は描画しない。 */
  function View() {
    current = Probe();
    return null;
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => {
    root.render(<View />);
  });
  return {
    api,
    registry,
    /** 再描画後のランタイムと会話列を取得する。 */
    get current() {
      return current;
    },
    /** 選択している Auxiliary の実行状態を購読者へ配信する。 */
    emit(state: OwnedLiveSessionRunState["state"]) {
      listener?.(current.auxiliary.selectedId!, state);
    },
    /** 指定 Session のキュー変更を、登録済み購読者へ通知する。 */
    emitQueue(id = "benchmark-main") {
      queueListeners.forEach((listener) => listener(id));
    },
    /** Main の下書きを設定し、実ランタイムにキュー送信を要求する。 */
    sendMain(text: string) {
      const session = current.main.sessions[0];
      const owner = { kind: "main" as const, id: session.id };
      registry.setDraft(owner, text);
      return current.main.runMainSessionTurn({
        sessionId: session.id,
        selectedSession: session,
        request: {
          userMessage: text,
          clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94bc",
          submitSource: "composer",
          executionOptions: captureSessionExecutionOptions(session),
        },
        composerOwner: owner,
        clearDraft: true,
        queueTurn: true,
        shouldCollapseActionDock: false,
        selectedSessionRunState: session.runState,
        blockedReason: null,
        isReadOnly: false,
        /** 実ワークスペースを参照せず、Main の送信経路の検証に進める。 */
        validateWorkspace: async () => true,
        /** 送信後のドック格納はこのフック検証では行わない。 */ collapseActionDock() {},
        /** Main の送信ログは検証対象にしない。 */ log() {},
      });
    },
    /** Auxiliary の下書きを先に永続化し、その版を使って共通ランタイムにキュー送信を依頼する。 */
    async sendAuxiliary(text: string) {
      const session = current.auxiliary.selectedSession!;
      const owner = { kind: "auxiliary" as const, id: session.id };
      registry.setDraft(owner, text);
      const draftOwner = current.persistence.getOwner(session)!;
      const saving = draftOwner.enqueue(text);
      await draftOwner.flush();
      await saving;
      return current.main.runMainSessionTurn({
        sessionId: session.id,
        selectedSession: {
          ...current.main.sessions[0],
          id: session.id,
          incarnationId: session.createdAt,
        },
        request: {
          userMessage: text,
          clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94bd",
          submitSource: "composer",
          executionOptions: captureSessionExecutionOptions(session),
          displayAnchorParentMessageCount: 4,
        },
        composerOwner: owner,
        auxiliaryDraftOwner: draftOwner,
        queueTurn: true,
        clearDraft: true,
        shouldCollapseActionDock: false,
        selectedSessionRunState: session.runState,
        blockedReason: null,
        isReadOnly: false,
        /** Auxiliary の送信に必要なワークスペース有効性を固定して返す。 */
        validateWorkspace: async () => true,
        /** Auxiliary 送信でも実際のドックの格納は行わない。 */ collapseActionDock() {},
        /** Auxiliary の送信ログは保存しない。 */ log() {},
      });
    },
    /** テスト用 React ルートと DOM を閉じ、一時的に差し替えたグローバルを元の状態に戻す。 */
    async unmount() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "MainとAuxiliaryのdurable受付はACK前のdraftを保持し、starting receiptを独立投影してcanonical到着後も本文・Bookmark・後続実行設定を維持する"
// oracle = { type = "contract", ref = "Issue #801: common durable admission and canonical queue projection; docs/features/message-bookmark-filter.md" }
// fault = "未ACK本文を送信済みにする、owner間でqueueを混ぜる、canonical更新で本文を重複させる、または後続Bookmark/実行設定を旧snapshotで戻す"
// observable = "両columnのmessages、ACK前後draft、canonical本文件数とBookmark、Auxiliaryのmodel選択"
// observation_boundary = "consumer"
// scope = "main-auxiliary-durable-queue-projection"
// lifecycle = "permanent"
// impact = "受付本文の消失・重複・会話混入とBookmarkの巻戻りを防ぐ"
// distinction = "実runtime/workspace/queue購読hookへ接続してACKとcanonicalの順序を検証する"
// @end-test-value
/** Main と Auxiliary が受付前に下書きを残し、受付後は各会話にだけ本文を投影することを確かめる。保存済み会話との合流で本文が重複せず、後続の Bookmark と実行設定も維持されることを検証する。 */
test("MainとAuxiliaryのqueue受付は独立してcanonicalへ接続する", async () => {
  const view = await setup();
  try {
    const main = view.current.main.sessions[0];
    const auxiliary = view.current.auxiliary.selectedSession!;
    const receipts = new Map<string, SessionTurnQueueReceipt>();
    const runs = new Map<
      string,
      ReturnType<typeof deferred<SessionTurnQueueReceipt>>
    >();
    const requests = new Map<
      string,
      Parameters<WithMateWindowApi["enqueueSessionTurn"]>[1]
    >();
    view.api.listSessionTurnQueue = async (id) =>
      receipts.has(id) && receipts.get(id)!.state !== "completed"
        ? [receipts.get(id)!]
        : [];
    view.api.getSessionTurnQueueReceipt = async (id) =>
      receipts.get(id) ?? null;
    view.api.enqueueSessionTurn = (id, request) => {
      requests.set(id, request);
      const pending = deferred<SessionTurnQueueReceipt>();
      runs.set(id, pending);
      return pending.promise;
    };
    let mainOperation!: ReturnType<typeof view.sendMain>;
    let auxiliaryOperation!: ReturnType<typeof view.sendAuxiliary>;
    await act(async () => {
      mainOperation = view.sendMain("main prompt");
      auxiliaryOperation = view.sendAuxiliary("auxiliary prompt");
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.deepEqual(
      structuredClone(view.current.mainColumn?.messages),
      structuredClone(main.messages),
    );
    assert.deepEqual(
      structuredClone(view.current.auxiliaryColumn?.messages),
      structuredClone(auxiliary.messages),
    );
    assert.equal(
      view.registry.get({ kind: "main", id: main.id }).draft,
      "main prompt",
    );
    assert.equal(
      view.registry.get({ kind: "auxiliary", id: auxiliary.id }).draft,
      "auxiliary prompt",
    );
    await act(async () => {
      for (const [id, request] of requests) {
        const receipt: SessionTurnQueueReceipt = {
          sessionId: id,
          incarnationId: request.incarnationId,
          id: id + "-queue",
          requestId: request.clientRequestId!,
          sequence: 1,
          queuePosition: 1,
          state: "starting",
          captured: {
            request: { ...request, clientRequestId: request.clientRequestId! },
            attachments: [],
            provider: main.provider,
            workspacePath: main.workspacePath,
          },
          turnId: null,
          userMessageSeq: null,
          reason: null,
          releasedAt: null,
          createdAt: main.updatedAt,
          updatedAt: main.updatedAt,
        };
        receipts.set(id, receipt);
        runs.get(id)!.resolve(receipt);
      }
      await Promise.all([mainOperation, auxiliaryOperation]);
      view.emitQueue(main.id);
      view.emitQueue(auxiliary.id);
    });
    assert.equal(view.current.mainColumn?.messages.at(-1)?.text, "main prompt");
    assert.equal(
      view.current.auxiliaryColumn?.messages.at(-1)?.text,
      "auxiliary prompt",
    );
    assert.equal(view.registry.get({ kind: "main", id: main.id }).draft, "");
    assert.equal(
      view.registry.get({ kind: "auxiliary", id: auxiliary.id }).draft,
      "",
    );
    const bookmarked = {
      role: "assistant" as const,
      text: "bookmarked before",
      isBookmarked: true,
    };
    const canonicalAuxiliary = deferred<AuxiliarySession>();
    await act(async () => {
      const savedMain = {
        ...main,
        messages: [
          bookmarked,
          ...main.messages,
          { role: "user" as const, text: "main prompt" },
          { role: "assistant" as const, text: "main answer" },
        ],
      };
      view.api.getSession = async () => savedMain;
      view.current.main.retryRead();
      view.current.auxiliary
        .getBinding(auxiliary.id)
        .setExecutionSelection({ ...auxiliary, model: "model-c" });
      view.api.getAuxiliarySession = () => canonicalAuxiliary.promise;
      view.emit(null);
      view.current.auxiliary
        .getBinding(auxiliary.id)
        .setMessageBookmark(0, true);
      canonicalAuxiliary.resolve({
        ...auxiliary,
        messages: [
          ...auxiliary.messages,
          { role: "user", text: "auxiliary prompt" },
          { role: "assistant", text: "auxiliary answer" },
        ],
      });
      for (const [id, receipt] of receipts)
        receipts.set(id, {
          ...receipt,
          state: "completed",
          userMessageSeq:
            id === main.id
              ? main.messages.length + 1
              : auxiliary.messages.length,
          turnId: id + "-turn",
        });
      view.emitQueue(main.id);
      view.emitQueue(auxiliary.id);
    });
    for (const [column, prompt, answer] of [
      [view.current.mainColumn, "main prompt", "main answer"],
      [view.current.auxiliaryColumn, "auxiliary prompt", "auxiliary answer"],
    ] as const) {
      assert.equal(
        column?.messages.filter((message) => message.text === prompt).length,
        1,
      );
      assert.equal(column?.messages.at(-1)?.text, answer);
    }
    assert.equal(
      view.current.mainColumn?.messages.find(
        (message) => message.text === bookmarked.text,
      )?.isBookmarked,
      true,
    );
    assert.equal(view.current.auxiliaryColumn?.messages[0]?.isBookmarked, true);
    assert.equal(view.current.auxiliary.selectedSession?.model, "model-c");
  } finally {
    await view.unmount();
  }
});

// @test-value v2
// kind = "contract"
// claim = "送信の受付に失敗応答とreceipt不在を観測しても、後続queue更新から元要求を確認できたら同じ受付に接続し、新しいdraftは保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window: 受付応答・自動照会・回復" }
// fault = "遅い受付を照会不能のままにする、別receiptで不明を解除する、または受付認識時に新しいdraftを消す"
// observable = "実runtimeの受付状態、Main conversationの本文、draftとenqueue呼出数"
// observation_boundary = "consumer"
// scope = "same-window late durable receipt reconciliation"
// lifecycle = "permanent"
// impact = "受付済みTurnをもう一度送るよう案内したり、無関係な受付で回復を閉じると実行や入力を見失う"
// distinction = "自動照会が正常にreceiptを返すcaseと異なり、不明遷移後の実queue通知・readからだけ結果が届く"
// @end-test-value
/** 受付確認が一旦不明になった Main 送信について、別世代の受付票では解消せず、元要求と一致する遅延受付で再送せずに回復し新しい下書きも保つことを確かめる。 */
test("late matching queue receipt ends recovery without replaying the input", async () => {
  const view = await setup();
  try {
    const main = view.current.main.sessions[0];
    const owner = { kind: "main" as const, id: main.id };
    let submitted!: Parameters<WithMateWindowApi["enqueueSessionTurn"]>[1];
    let sends = 0;
    let visibleReceipts: SessionTurnQueueReceipt[] = [];
    view.api.enqueueSessionTurn = async (_id, input) => {
      submitted = input;
      sends += 1;
      throw new Error("ack lost");
    };
    view.api.getSessionTurnQueueReceipt = async () => null;
    view.api.listSessionTurnQueue = async () => visibleReceipts;
    await act(async () => {
      await assert.rejects(
        view.sendMain("late prompt"),
        /acceptance could not be confirmed/,
      );
    });
    assert.equal(view.current.main.hasUncertainTurnFor(main.id), true);
    const captured = {
      request: { ...submitted, clientRequestId: submitted.clientRequestId! },
      attachments: [],
      provider: main.provider,
      workspacePath: main.workspacePath,
    };
    const matching: SessionTurnQueueReceipt = {
      sessionId: main.id,
      incarnationId: submitted.incarnationId,
      id: "late-queue",
      requestId: submitted.clientRequestId!,
      sequence: 1,
      queuePosition: 1,
      state: "starting",
      captured,
      accepted: captured,
      turnId: null,
      userMessageSeq: null,
      reason: null,
      releasedAt: null,
      createdAt: main.updatedAt,
      updatedAt: main.updatedAt,
    };
    await act(async () => {
      view.registry.setDraft(owner, "new draft");
      visibleReceipts = [{ ...matching, incarnationId: "old-incarnation" }];
      view.emitQueue(main.id);
    });
    assert.equal(view.current.main.hasUncertainTurnFor(main.id), true);
    await act(async () => {
      visibleReceipts = [matching];
      view.emitQueue(main.id);
    });
    assert.equal(view.current.main.hasUncertainTurnFor(main.id), false);
    assert.equal(
      view.current.mainColumn?.messages.filter(
        (message) => message.text === "late prompt",
      ).length,
      1,
    );
    assert.equal(view.registry.get(owner).draft, "new draft");
    assert.equal(sends, 1);
  } finally {
    await view.unmount();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryの受付待機と不明は会話切替・再取得後も別状態で、元ownerの新draftを保護しながら同IDで受付とqueue投影を回復する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window: 受付応答・自動照会・回復" }
// fault = "照会中に受付不明を表示する、切替で保留・不明を忘れる、新IDで再送する、別会話へ反映する、または後続draftを消す"
// observable = "対象別の保留・不明状態、再試行request列、元owner draft、回復後column本文"
// observation_boundary = "consumer"
// scope = "auxiliary-durable-acceptance-races"
// lifecycle = "permanent"
// impact = "結果不明時の二重実行と入力消失を防ぐ"
// distinction = "acceptance class単体と異なり実workspace切替とqueue購読まで検証する"
// @end-test-value
/** Auxiliary の保留と受付不明が会話切替や再読み込み後も元の会話だけに残り、同じ要求で明示再試行すると新しい下書きを消さず本文が一件表示されることを確かめる。 */
test("Auxiliaryは切替後も不明受付の元IDと新draftを保護して回復する", async () => {
  const view = await setup();
  try {
    const initial = view.current.auxiliary.selectedSession!;
    const otherId = view.current.auxiliary.summaries.find(
      (item) => item.id !== initial.id,
    )!.id;
    const run = deferred<SessionTurnQueueReceipt>();
    const started = deferred<void>();
    const lookup = deferred<SessionTurnQueueReceipt | null>();
    const lookupStarted = deferred<void>();
    const requests: Parameters<WithMateWindowApi["enqueueSessionTurn"]>[1][] =
      [];
    let receipt: SessionTurnQueueReceipt | null = null;
    view.api.listSessionTurnQueue = async (id) =>
      id === initial.id && receipt ? [receipt] : [];
    view.api.getSessionTurnQueueReceipt = async (_id, requestId) => {
      assert.equal(requestId, requests[0]?.clientRequestId);
      lookupStarted.resolve();
      return lookup.promise;
    };
    view.api.enqueueSessionTurn = (_id, request) => {
      requests.push(request);
      started.resolve();
      return run.promise;
    };
    let operation!: ReturnType<typeof view.sendAuxiliary>;
    await act(async () => {
      operation = view.sendAuxiliary("retry prompt");
      await started.promise;
    });
    assert.deepEqual(
      structuredClone(view.current.auxiliaryColumn?.messages),
      structuredClone(initial.messages),
    );
    assert.equal(view.current.main.hasPendingSubmitFor(initial.id), true);
    assert.equal(view.current.main.hasUncertainTurnFor(initial.id), false);
    await act(async () => {
      view.current.auxiliary.selectSession(otherId);
    });
    const rejected = assert.rejects(
      operation,
      /acceptance could not be confirmed/,
    );
    await act(async () => {
      run.reject(new Error("disconnected"));
      await lookupStarted.promise;
    });
    assert.equal(view.current.main.hasPendingSubmitFor(initial.id), true);
    assert.equal(view.current.main.hasPendingSubmitFor(otherId), false);
    assert.equal(view.current.main.hasUncertainTurnFor(initial.id), false);
    await act(async () => {
      lookup.resolve(null);
      await rejected;
    });
    assert.equal(view.current.main.hasPendingSubmitFor(initial.id), false);
    assert.equal(view.current.main.hasUncertainTurnFor(initial.id), true);
    assert.equal(view.current.main.hasUncertainTurnFor(otherId), false);
    await act(async () => {
      view.current.main.retryRead();
      view.current.auxiliary.selectSession(initial.id);
      view.emit(null);
    });
    assert.equal(view.current.main.hasUncertainTurnFor(initial.id), true);
    await act(async () => {
      await view.current.persistence.changeDraft(initial, "new draft", 9);
    });
    const original = requests[0];
    view.api.enqueueSessionTurn = async (_id, request) => {
      requests.push(request);
      receipt = {
        sessionId: initial.id,
        incarnationId: original.incarnationId,
        id: "aux-queue",
        requestId: original.clientRequestId!,
        sequence: 1,
        queuePosition: 1,
        state: "starting",
        captured: {
          request: { ...request, clientRequestId: request.clientRequestId! },
          attachments: [],
          provider: initial.provider,
          workspacePath: "workspace",
        },
        turnId: null,
        userMessageSeq: null,
        reason: null,
        releasedAt: null,
        createdAt: initial.updatedAt,
        updatedAt: initial.updatedAt,
      };
      return receipt;
    };
    await act(async () => {
      await view.current.main.retryOriginalTurn(initial.id);
      view.emitQueue(initial.id);
    });
    assert.deepEqual(requests, [original, original]);
    assert.equal(view.current.main.hasUncertainTurnFor(initial.id), false);
    assert.equal(
      view.registry.get({ kind: "auxiliary", id: initial.id }).draft,
      "new draft",
    );
    assert.equal(
      view.current.auxiliaryColumn?.messages.filter(
        (message) => message.text === "retry prompt",
      ).length,
      1,
    );
  } finally {
    await view.unmount();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Main送信runtimeはACK待機中のdraftを保持し、受付結果不明でも同じComposer ownerの新入力を上書きしない"
// oracle = { type = "contract", ref = "Issue #801: durable ACK and uncertain acceptance" }
// fault = "runtimeがACK前にdraftを消し、旧rejectで新しいdraftを旧送信文に戻す"
// observable = "実ComposerControllerRegistryのdraft、要求開始時のIDと本文、reject後の実会話column"
// observation_boundary = "consumer"
// scope = "Main runtime rejected request and Composer owner revision"
// lifecycle = "permanent"
// impact = "遅い送信失敗が同一ownerの後続編集を失わせる"
// distinction = "controller単体では検出できないruntimeのcaptureとdurable受付待機、結果不明の接続を検証する"
// @end-test-value
/** Main の受付待ちで下書きが残り、送信後の編集を遅れて届いた拒否で巻き戻さず、会話も実行中にはならないことを確かめる。 */
test("Main runtimeの旧rejectは同じComposer ownerの新入力を上書きしない", async () => {
  const view = await setup();
  try {
    const initial = view.current.main.sessions[0];
    const owner = { kind: "main" as const, id: initial.id };
    const started = deferred<void>();
    const run = deferred<SessionTurnQueueReceipt>();
    view.api.enqueueSessionTurn = (id, request) => {
      assert.equal(id, initial.id);
      assert.equal(request.userMessage, "old prompt");
      started.resolve();
      return run.promise;
    };
    let operation!: ReturnType<typeof view.sendMain>;
    await act(async () => {
      operation = view.sendMain("old prompt");
      await started.promise;
    });
    assert.equal(view.registry.capture(owner).draft, "old prompt");
    view.registry.setDraft(owner, "new draft");
    assert.equal(view.registry.capture(owner).draft, "new draft");
    await act(async () => {
      const rejected = assert.rejects(
        operation,
        /acceptance could not be confirmed/,
      );
      run.reject(new Error("old request rejected"));
      await rejected;
    });
    assert.equal(view.registry.capture(owner).draft, "new draft");
    assert.deepEqual(
      structuredClone(view.current.mainColumn?.messages),
      structuredClone(initial.messages),
    );
    assert.equal(view.current.mainColumn?.isRunning, false);
  } finally {
    await view.unmount();
  }
});

// @test-value v2
// kind = "contract"
// claim = "同じ会話の直接Steerと通常Sendは同じ草稿を二重送信しない。Main/Auxiliary共通durable受付は旧rejectで新入力を上書きせず、未確定とcanonical失敗を区別する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window: 受付応答・自動照会・回復; docs/design/auxiliary-session.md#送信受付の共通反映" }
// fault = "直前のSteerのbusy描画前に同じ草稿を通常queueへ送る、旧受付rejectで新入力を上書きする、受付待機中に送信済み本文や受付不明を示す、またはcanonical失敗を未受付と混同する"
// observable = "実SessionWindowAppのtextarea値、送信APIの対象IDと本文、同じ描画間隔で直接Steerと通常Sendを操作したときの各IPC呼出、要求待機中とsettle後の対象会話の本文数、応答側の理由、不明時の診断、modal alertの不在"
// observation_boundary = "component-behavior"
// scope = "SessionWindowApp common durable admission and canonical Provider failure"
// lifecycle = "permanent"
// impact = "送信失敗時の後続入力消失、送信済み本文・途中応答の消失、旧入力の復活による再送を防ぐ"
// distinction = "実AppでReactの描画を挟まないSteer→Sendの競合、Main/Auxiliary両Sendのdurable ACKとcanonical通知、同一owner編集後の旧rejectを検証。Provider実通信・永続化・OS操作は対象にしない"
// @end-test-value
/** 実 Session Window で追加入力と通常送信を同じ描画間隔に操作しても二重送信を抑え、遅い受付拒否は新しい下書きを保ち、受付後の Provider 失敗は送信本文と途中応答を保持することを確かめる。 */
test(
  "Session Windowはdurable受付の旧rejectから新入力を保護し、canonical Provider失敗の本文を保持する",
  { timeout: 30_000 },
  async () => {
    const dom = new JSDOM("<!doctype html><div id='root'></div>", {
      url: "http://withmate.test/session.html?sessionId=benchmark-main",
      pretendToBeVisual: true,
    });
    const globals = {
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement,
      HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
      localStorage: dom.window.localStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
      /** 仮想リストの描画待ちを JSDOM のタイマーで処理する。 */
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 0),
      /** 予約済みの描画タイマーを取り消す。 */
      cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
        clearTimeout(id),
      ResizeObserver: class {
        observe /** 実レイアウトのサイズ通知を送らず、観測の登録に応じる。 */() {}
        disconnect /** サイズ監視の終了を受け付ける。 */() {}
        unobserve /** 個別要素の監視解除を受け付ける。 */() {}
      },
      IntersectionObserver: class {
        observe /** 実際の交差判定を行わず観測の登録に応じる。 */() {}
        disconnect /** 交差監視の終了を受け付ける。 */() {}
        unobserve /** 個別要素の交差監視解除を受け付ける。 */() {}
      },
    };
    const originals = new Map(
      Object.keys(globals).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    );
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value,
      });
    Object.defineProperty(dom.window, "matchMedia", {
      /** メディアクエリが一致しない固定の結果を返す。 */ value: () => ({
        matches: false,
        /** メディア条件の変更購読を受け付けるが通知はしない。 */ addEventListener() {},
        /** メディア条件の購読解除を受け付ける。 */ removeEventListener() {},
      }),
    });
    Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
      /** 表示位置への移動は JSDOM のレイアウトに反映しない。 */ value() {},
    });
    // JSDOMで会話のvirtual rowを描画するためのviewport。OS/browserのlayout検証ではない。
    Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
      /** 会話の仮想行を描画できる固定のクライアント領域の高さを返す。 */ get() {
        return 720;
      },
    });
    Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
      /** 仮想行の検証で参照する要素の占有高さを固定する。 */ get() {
        return 720;
      },
    });
    dom.window.HTMLElement.prototype.scrollTo = function (
      options?: ScrollToOptions | number,
      y?: number,
    ) {
      this.scrollTop =
        typeof options === "number"
          ? (y ?? this.scrollTop)
          : (options?.top ?? this.scrollTop);
    };
    let api!: WithMateWindowApi;
    runInNewContext(
      readFileSync(
        new URL(
          "../../scripts/benchmarks/benchmark-composer-input-preload.cjs",
          import.meta.url,
        ),
        "utf8",
      ),
      {
        /** Auxiliary が一つある preload fixture に公開用ブリッジを渡す。 */
        require: () => ({
          contextBridge: {
            /** 公開 API を捕捉し、現在の Main と Auxiliary の保存状態を検証から供給できるようにする。 */ exposeInMainWorld:
              (_key: string, value: WithMateWindowApi) => {
                api = value;
              },
          },
        }),
        process: { argv: ["--benchmark-auxiliary-count=1"] },
        Buffer,
      },
    );
    const getModelCatalog = api.getModelCatalog;
    api.getModelCatalog = async (request) => {
      const snapshot = await getModelCatalog(request);
      return snapshot
        ? { ...snapshot, workspacePath: request?.workspacePath }
        : snapshot;
    };
    const initialMain = await api.getSession("benchmark-main");
    const initialAuxiliary = await api.getAuxiliarySession("benchmark-aux-1");
    assert.ok(initialMain);
    assert.ok(initialAuxiliary);
    let main = initialMain;
    let auxiliary = initialAuxiliary;
    let auxiliaryDraft: AuxiliaryDraftRecord = {
      auxiliarySessionId: auxiliary.id,
      parentSessionId: auxiliary.parentSessionId,
      incarnation: auxiliary.createdAt,
      durableRevision: 0,
      text: auxiliary.composerDraft,
      updatedAt: auxiliary.updatedAt,
    };
    api.getSession = async (id) => (id === main.id ? main : null);
    api.getAuxiliarySession = async (id) =>
      id === auxiliary.id ? auxiliary : null;
    api.getAuxiliarySessionStatus = async () => ({
      id: auxiliary.id,
      parentSessionId: auxiliary.parentSessionId,
      createdAt: auxiliary.createdAt,
      incarnation: auxiliary.createdAt,
      runState: auxiliary.runState,
    });
    api.getAuxiliaryDraft = async () => ({ ...auxiliaryDraft });
    api.saveAuxiliaryDraft = async (request) => {
      if (
        request.expectedDurableRevision !== auxiliaryDraft.durableRevision ||
        request.incarnation !== auxiliaryDraft.incarnation
      )
        return { outcome: "stale" };
      auxiliaryDraft = {
        ...auxiliaryDraft,
        text: request.text,
        durableRevision: auxiliaryDraft.durableRevision + 1,
        updatedAt: request.updatedAt,
      };
      return { outcome: "saved", ack: auxiliaryDraft };
    };
    const receipts = new Map<string, SessionTurnQueueReceipt>();
    api.getSessionTurnQueueReceipt = async () => null;
    api.listSessionTurnQueue = async (id) =>
      receipts.has(id) ? [receipts.get(id)!] : [];
    const queueListeners = new Set<(id: string) => void>();
    api.onSessionTurnQueueChanged = (listener) => {
      queueListeners.add(listener);
      return () => {
        queueListeners.delete(listener);
      };
    };
    /** 保存した受付票が変わったことを、該当 Session の ID とともに通知する。 */
    const notifyQueue = (id: string) =>
      queueListeners.forEach((listener) => listener(id));
    const liveListeners = new Set<
      Parameters<WithMateWindowApi["subscribeLiveSessionRun"]>[0]
    >();
    api.subscribeLiveSessionRun = (listener) => {
      liveListeners.add(listener);
      return () => {
        liveListeners.delete(listener);
      };
    };
    /** 該当 Session のライブ実行が終了したことを null で通知する。 */
    const emitTerminal = (id: string) =>
      liveListeners.forEach((listener) => listener(id, null));
    const invalidationListeners = new Set<{
      listener: Parameters<
        WithMateWindowApi["subscribeSessionInvalidation"]
      >[0];
    }>();
    api.subscribeSessionInvalidation = (listener) => {
      const registration = { listener };
      invalidationListeners.add(registration);
      return () => {
        invalidationListeners.delete(registration);
      };
    };
    /** Main の保存済みスナップショットを更新したことを購読者へ通知する。 */
    const notifyMain = () =>
      invalidationListeners.forEach(({ listener }) =>
        listener({ scope: "ids", sessionIds: [main.id] }),
      );
    const alerts: string[] = [];
    dom.window.alert = (message) => {
      alerts.push(String(message));
    };
    Object.defineProperty(dom.window, "withmate", { value: api });
    const { createRoot } = await import("react-dom/client");
    const cssImports = registerHooks({
      /** 実画面を Node で読み込めるよう CSS だけを空モジュールに差し替える。 */ load(
        url,
        context,
        next,
      ) {
        return url.endsWith(".css")
          ? { format: "module", shortCircuit: true, source: "" }
          : next(url, context);
      },
    });
    const { default: App } =
      await import("../../src/app/SessionWindowApp.js").finally(() =>
        cssImports.deregister(),
      );
    const root = createRoot(dom.window.document.getElementById("root")!);
    /** ショートカット対象である Composer の入力欄を取得し、描画されていなければ失敗させる。 */
    const textarea = () => {
      const element = dom.window.document.querySelector<HTMLTextAreaElement>(
        'textarea[data-shortcut-scope="composer"]',
      );
      assert.ok(element);
      return element;
    };
    /** 有効な Composer を使って編集イベントを送り、指定した文字列が表示されるまで確認する。 */
    const input = async (text: string) => {
      assert.equal(textarea().disabled, false);
      await act(async () => {
        const element = textarea();
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(element, text);
        element.setSelectionRange(text.length, text.length);
        element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      assert.equal(textarea().value, text);
    };
    /** 押せる状態の通常送信ボタンを確認してクリックする。 */
    const send = () => {
      const button = dom.window.document.querySelector<HTMLButtonElement>(
        ".composer-control-row .session-send-button",
      );
      assert.ok(button);
      assert.equal(button.disabled, false);
      button.click();
    };
    /** 指定会話の発話者別に、描画されたメッセージ本文を順に取得する。 */
    const messageTexts = (pane: string, role: "user" | "assistant") =>
      Array.from(
        dom.window.document.querySelectorAll(
          `${pane} .message-row.${role} .rich-text`,
        ),
      ).map((element) => element.textContent ?? "");
    try {
      await act(async () => {
        root.render(<App />);
      });
      // 直接入力のショートカットと通常の送信ボタンは、先に開始した操作の
      // 処理中状態が React に反映される前に実行される場合がある。
      main = { ...main, status: "running", runState: "running" };
      const directResult = deferred<{ turnId: string }>();
      const directCalls: string[] = [];
      const normalCalls: string[] = [];
      api.steerSessionTurn = async (id, request) => {
        assert.equal(id, main.id);
        assert.equal(request.expectedTurnId, "native-current");
        directCalls.push(request.userMessage);
        return directResult.promise;
      };
      api.enqueueSessionTurn = async (_id, request) => {
        normalCalls.push(request.userMessage);
        return { state: "rejected", reason: "Fixture: duplicate send." };
      };
      await act(async () => {
        notifyMain();
        for (const listener of liveListeners)
          listener(main.id, {
            sessionId: main.id,
            threadId: "native-thread",
            runState: "running",
            sessionTurnId: "withmate-current",
            turnId: "native-current",
            inputAvailable: true,
            assistantText: "Current answer",
            steps: [],
            backgroundTasks: [],
            usage: null,
            errorMessage: "",
            approvalRequest: null,
            elicitationRequest: null,
          });
      });
      await input("one direct instruction");
      await act(async () => {
        textarea().dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        send();
      });
      assert.deepEqual(directCalls, ["one direct instruction"]);
      assert.deepEqual(
        normalCalls,
        [],
        "a busy DOM commit must not be the only guard against queuing the same captured draft",
      );
      assert.equal(textarea().value, "one direct instruction");
      await act(async () => {
        directResult.resolve({ turnId: "native-current" });
      });
      assert.equal(textarea().value, "");
      await act(async () => {
        main = { ...main, status: "saved", runState: "idle" };
        emitTerminal(main.id);
        notifyMain();
      });
      for (const target of ["Main", "Auxiliary"] as const) {
        if (target === "Auxiliary") {
          const opener = dom.window.document.querySelector<HTMLButtonElement>(
            'button[aria-label="Open Auxiliary"]',
          );
          assert.ok(opener);
          await act(async () => {
            opener.click();
          });
          const switcher = Array.from(
            dom.window.document.querySelectorAll<HTMLButtonElement>(
              ".concurrent-chat-target-dock button",
            ),
          ).find((button) => button.textContent === target);
          assert.ok(switcher);
          await act(async () => {
            switcher.click();
          });
        }
        const id = target === "Main" ? main.id : auxiliary.id;
        const pane =
          target === "Main"
            ? "#session-main-chat-pane"
            : "#session-auxiliary-chat-pane";
        const outcomes =
          target === "Main"
            ? (["provider-error"] as const)
            : (["reject", "provider-error"] as const);
        for (const outcome of outcomes) {
          const prompt = `${target} ${outcome} prompt`;
          const newInput = `${target} next draft`;
          const partial = `${target} partial answer`;
          const failureNotice = `${target} provider execution failed`;
          const started = deferred<void>();
          const result = deferred<SessionTurnQueueReceipt>();
          const requests: Array<{ id: string; text: string }> = [];
          api.enqueueSessionTurn = async (sessionId, request) => {
            requests.push({ id: sessionId, text: request.userMessage });
            started.resolve();
            if (outcome === "reject") return result.promise;
            if (target === "Main") {
              main = {
                ...main,
                status: "running",
                runState: "running",
                messages: [
                  ...main.messages,
                  { role: "user", text: request.userMessage },
                ],
              };
              notifyMain();
            } else {
              assert.equal(
                request.auxiliaryDraftIncarnation,
                auxiliaryDraft.incarnation,
              );
              assert.equal(
                request.auxiliaryDraftDurableRevision,
                auxiliaryDraft.durableRevision,
              );
              auxiliaryDraft = {
                ...auxiliaryDraft,
                text: "",
                durableRevision: auxiliaryDraft.durableRevision + 1,
              };
              auxiliary = {
                ...auxiliary,
                runState: "running",
                messages: [
                  ...auxiliary.messages,
                  { role: "user", text: request.userMessage },
                ],
              };
              emitTerminal(id);
            }
            const receipt: SessionTurnQueueReceipt = {
              sessionId,
              incarnationId: request.incarnationId,
              id: request.clientRequestId!,
              requestId: request.clientRequestId!,
              sequence: 1,
              queuePosition: 1,
              state: "running",
              captured: {
                request: {
                  ...request,
                  clientRequestId: request.clientRequestId!,
                },
                attachments: [],
                provider: main.provider,
                workspacePath: main.workspacePath,
              },
              turnId: "turn",
              userMessageSeq:
                (target === "Main" ? main : auxiliary).messages.length - 1,
              reason: null,
              releasedAt: null,
              createdAt: main.updatedAt,
              updatedAt: main.updatedAt,
            };
            receipts.set(id, receipt);
            notifyQueue(id);
            return receipt;
          };
          await input(prompt);
          await act(async () => {
            send();
            await started.promise;
          });
          assert.deepEqual(requests, [{ id, text: prompt }]);
          if (outcome === "reject") {
            assert.equal(
              textarea().value,
              prompt,
              "unacknowledged input remains in the composer",
            );
            assert.equal(
              messageTexts(pane, "user").filter((text) => text === prompt)
                .length,
              0,
              "pending send does not add a conversation row",
            );
            assert.equal(
              dom.window.document.querySelector(".composer-turn-recovery"),
              null,
              "pending send is not uncertain",
            );
            assert.equal(
              dom.window.document.querySelector<HTMLButtonElement>(
                ".composer-send-control .session-send-button",
              )?.disabled,
              true,
            );
            await input(newInput);
            const error = new Error(`${target} request rejected`);
            await act(async () => {
              result.reject(error);
            });
            assert.equal(
              textarea().value,
              newInput,
              `${target}: old rejection must not restore over a later edit`,
            );
            assert.equal(
              messageTexts(pane, "user").filter((text) => text === prompt)
                .length,
              1,
              "uncertain admission retains the submitted bubble",
            );
            assert.match(
              dom.window.document.querySelector(
                `${pane} .pending-run-error-note`,
              )?.textContent ?? "",
              /acceptance could not be confirmed/,
            );
            api.enqueueSessionTurn = async () => ({
              state: "rejected",
              reason: "Original turn was not accepted.",
            });
            await act(async () => {
              const retry = Array.from(
                dom.window.document.querySelectorAll<HTMLButtonElement>(
                  "button",
                ),
              ).find((button) => button.textContent === "Retry Original Turn");
              assert.ok(retry);
              retry.click();
            });
            assert.equal(textarea().value, newInput);
            assert.equal(
              messageTexts(pane, "user").filter((text) => text === prompt)
                .length,
              1,
              "explicit rejection retains the submitted bubble without duplication",
            );
            assert.equal(
              dom.window.document.querySelector(
                `${pane} .message-row.assistant .session-run-failure p`,
              )?.textContent,
              "Original turn was not accepted.",
            );
          } else {
            assert.equal(textarea().value, "");
            assert.equal(
              messageTexts(pane, "user").filter((text) => text === prompt)
                .length,
              1,
            );
            await act(async () => {
              if (target === "Main") {
                main = {
                  ...main,
                  status: "idle",
                  runState: "error",
                  messages: [
                    ...main.messages,
                    {
                      role: "assistant",
                      text: partial,
                      runFailure: failureNotice,
                    },
                  ],
                };
                notifyMain();
              } else {
                auxiliary = {
                  ...auxiliary,
                  runState: "error",
                  composerDraft: "",
                  messages: [
                    ...auxiliary.messages,
                    {
                      role: "assistant",
                      text: partial,
                      runFailure: failureNotice,
                    },
                  ],
                };
                emitTerminal(id);
              }
              receipts.set(id, {
                ...receipts.get(id)!,
                state: "failed",
                reason: failureNotice,
              });
              notifyQueue(id);
            });
            /** 受付後の失敗で送信文と途中応答が一度ずつ残り、失敗理由は応答本文と別表示になり、送信済み下書きは復元されないことを確かめる。 */
            const assertFailedBody = () => {
              assert.equal(
                messageTexts(pane, "user").filter((text) => text === prompt)
                  .length,
                1,
              );
              const answers = messageTexts(pane, "assistant");
              assert.equal(
                answers.filter((text) => text === partial).length,
                1,
              );
              assert.equal(
                answers.some((text) => text.includes(failureNotice)),
                false,
                "the failure reason is not part of the generated answer",
              );
              const failures = Array.from(
                dom.window.document.querySelectorAll(
                  `${pane} .message-row.assistant .session-run-failure p`,
                ),
              );
              assert.equal(
                failures.filter(
                  (element) => element.textContent === failureNotice,
                ).length,
                1,
              );
              assert.equal(
                dom.window.document.querySelector(
                  `${pane} .message-row.user .session-run-failure`,
                ),
                null,
              );
              assert.equal(
                textarea().value,
                "",
                `${target}: resolved Provider failure must not restore the sent draft`,
              );
            };
            assertFailedBody();
            await act(async () => {
              emitTerminal(id);
            });
            assertFailedBody();
          }
        }
      }
      assert.deepEqual(
        alerts,
        [],
        "explicit rejection is reported in the affected conversation without a modal alert",
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  },
);
