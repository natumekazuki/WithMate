import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WorkspaceDirectoryValidationService } from "../../src-electron/files/workspace-directory-validation-service.js";
import { createWithMateWindowApi } from "../../src-electron/preload/preload-api.js";
import { selectAdditionalDirectoryPath } from "../../src/chat/composer/session-composer-paths.js";
import { SessionTurnQueuePreflightRejectedError } from "../../src-electron/app/main-session-turn-queue-facade.js";

/** preload を通じて Instructions 専用チャネルを実行し、不正な識別情報や呼び出し元を処理の委譲前に拒否することを確認する。 */
test("Instructions IPC accepts only the owning incarnation and main frame", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const frame = {};
  const sender = {
    mainFrame: frame,
    /** 同じ WebContents を使い回すため、呼び出し元は生存中と見なす。 */ isDestroyed:
      () => false,
    session: {},
  };
  const owner = {
    webContents: sender,
    /** 所有 Window の交換だけを検証するため、元の Window は破棄済みと報告しない。 */ isDestroyed:
      () => false,
  };
  const calls: unknown[][] = [];
  let event: { sender: typeof sender; senderFrame: object | null } = {
    sender,
    senderFrame: frame,
  };
  let currentOwner: typeof owner | null = owner;
  let eventWindow: typeof owner | null = owner;
  let finishRead: ((value: string) => void) | undefined;
  let deferRead = false;
  const { deps } = createDeps({
    /** IPC の送信元に対応する Window を切り替え、所有 Window と一致しない場合を再現する。 */
    resolveEventWindow: () => eventWindow,
    /** Main の ID と incarnation が一致する場合だけ、その時点の所有 Window を返す。 */
    resolveOwningSessionWindow: (id: string, incarnation: string) =>
      id === "main" && incarnation === "main-v1" ? currentOwner : null,
    /** 対象を記録し、必要なら完了を保留して、読み取り中の Window 交換を再現する。 */
    getSessionInstructions: (target: unknown) => {
      calls.push(["get", target]);
      return deferRead
        ? new Promise<string>((resolve) => {
            finishRead = resolve;
          })
        : "既存😀";
    },
    /** 更新先と本文を記録し、空文字や絵文字も UTF-8 のバイト数で返す。 */
    setSessionInstructions: (target: unknown, body: string) => {
      calls.push(["set", target, body]);
      return { byteLength: Buffer.byteLength(body) };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const api = createWithMateWindowApi({
    /** preload の invoke を登録済みハンドラーへ接続し、その時点の IPC event を渡す。 */
    invoke: (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!(event, ...args),
  } as never);
  const main = {
    kind: "main",
    sessionId: "main",
    incarnationId: "main-v1",
  } as const;
  const auxiliary = {
    kind: "auxiliary",
    sessionId: "aux",
    incarnationId: "created-at",
    mainSessionId: "main",
    mainIncarnationId: "main-v1",
  } as const;
  assert.equal(await api.getSessionInstructions(main), "既存😀");
  assert.deepEqual(await api.setSessionInstructions(auxiliary, " 本文😀\n"), {
    byteLength: 12,
  });
  assert.deepEqual(await api.setSessionInstructions(main, ""), {
    byteLength: 0,
  });
  assert.deepEqual(calls, [
    ["get", main],
    ["set", auxiliary, " 本文😀\n"],
    ["set", main, ""],
  ]);

  // 両チャネルとも、余分なフィールド、識別情報の欠落、置き換わった Main の incarnation を拒否する。
  for (const target of [
    { ...main, body: "extra" },
    { ...main, sessionId: " " },
    { ...main, incarnationId: "main-v2" },
    { ...auxiliary, mainIncarnationId: undefined },
    { ...auxiliary, mainSessionId: "other" },
  ]) {
    await assert.rejects(async () =>
      handlers.get("withmate:get-session-instructions")!(event, target),
    );
    await assert.rejects(async () =>
      handlers.get("withmate:set-session-instructions")!(event, target, ""),
    );
  }
  // サブフレーム、フレームの欠落、無関係な Window からの呼び出しはストレージまで到達しない。
  for (const senderFrame of [{}, null]) {
    event = { sender, senderFrame };
    await assert.rejects(
      () => api.getSessionInstructions(auxiliary),
      /owning Session Window/,
    );
    await assert.rejects(
      () => api.setSessionInstructions(auxiliary, ""),
      /owning Session Window/,
    );
  }
  event = { sender, senderFrame: frame };
  eventWindow = { ...owner };
  await assert.rejects(
    () => api.getSessionInstructions(main),
    /owning Session Window/,
  );
  await assert.rejects(
    () => api.setSessionInstructions(main, ""),
    /owning Session Window/,
  );
  assert.equal(calls.length, 3);

  // 所有 Window が置き換わった後に遅れて読み取りが完了しても、本文を開示してはならない。
  eventWindow = owner;
  deferRead = true;
  const pending = api.getSessionInstructions(auxiliary);
  assert.ok(finishRead);
  currentOwner = { ...owner };
  finishRead("private body");
  await assert.rejects(pending, /owning Session Window/);
  assert.deepEqual(calls.at(-1), ["get", auxiliary]);
});

// @test-value v2
// kind = "contract"
// claim = "enqueue IPCは専用preflight rejectだけをstructured未受付replyにしgeneric保存errorを伝播する"
// oracle = { type = "contract", ref = "src-electron/ipc/session-runtime.ts enqueue known reject handling" }
// fault = "generic storage errorをrejectedへ変換し受付結果不明を未受付として返す"
// observable = "専用型の返却state/reasonとgeneric errorのreject同一性"
// observation_boundary = "public-boundary"
// scope = "Main queue IPC known preflight rejection"
// lifecycle = "permanent"
// impact = "Rendererが受付済み要求を未受付と誤認し再送や下書き復元を行う"
// distinction = "facade分類testはIPCを跨ぐstructured replyへの変換を確認しない"
// @end-test-value
/** 受付前の専用例外だけを未受付に変換し、結果不明の保存例外は同一のエラーとして伝播することを確かめる。 */
test("enqueue IPCはtyped preflight rejectだけを未受付replyへ変換する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const owner = createWindowStub("file:///session.html?sessionId=session-1");
  let failure: Error = new SessionTurnQueuePreflightRejectedError(
    "workspace unavailable",
  );
  const { deps } = createDeps({
    /** 両方の失敗で同じ所有 Window から IPC が来たものとして扱う。 */ resolveEventWindow:
      () => owner,
    /** テスト対象の Session ID にだけ所有 Window を割り当てる。 */
    resolveSessionWindow: (id: string) => (id === "session-1" ? owner : null),
    queue: {
      /** 同じ enqueue を使い、差し替えた例外をそのまま投げる。 */ enqueueSessionTurn:
        async () => {
          throw failure;
        },
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  /** 同じ incarnation の受付を呼び出し、失敗の応答形式だけを比較する。 */
  const invoke = () =>
    handlers.get("withmate:enqueue-session-turn")?.({}, "session-1", {
      incarnationId: "owner-1",
    }) as Promise<unknown>;
  assert.deepEqual(await invoke(), {
    state: "rejected",
    reason: "workspace unavailable",
  });
  failure = new Error("storage commit reply unknown");
  await assert.rejects(invoke(), (error) => error === failure);
});

// @test-value v2
// kind = "security"
// claim = "受付・照会・一覧・取消・Send Inputのqueue IPCはMainとAuxの実IDを保持しowning parent Session Window以外を依存呼出し前に拒否する"
// oracle = { type = "contract", ref = "src-electron/ipc/session-runtime.ts queue handlers" }
// fault = "Auxの親と異なるWindowへqueue本文/receiptアクセスを許可するかtargetを親IDに置換する"
// observable = "Main/Aux ownerの返却payloadと実target引数、非owner要求の拒否と依存件数"
// observation_boundary = "public-boundary"
// scope = "Main durable queue IPC owner authorization"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// distinction = "facade/service testはElectron senderとMain Session Windowの対応を認可しない"
// @end-test-value
/** 親 Window のみが Main と Auxiliary の予約を操作でき、認可後も各操作の対象 ID と引数を保持することを確認する。 */
test("queue IPCはowning Main Windowに限定し引数を保持する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const owner = createWindowStub("file:///session.html?sessionId=session-1");
  const other = createWindowStub("file:///session.html?sessionId=other");
  let eventWindow = owner;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const methods = [
    "enqueueSessionTurn",
    "getSessionTurnQueueReceipt",
    "listSessionTurnQueue",
    "listSessionTurnQueueReceipts",
    "cancelQueuedSessionTurn",
    "sendQueuedSessionInput",
  ];
  const queue = Object.fromEntries(
    methods.map((method) => [
      method,
      async (...args: unknown[]) => {
        const payload = { method, args };
        calls.push(payload);
        return payload;
      },
    ]),
  );
  const { deps } = createDeps({
    queue,
    /** 所有 Window と無関係な Window を行き来できるよう、現在の呼び出し元を返す。 */ resolveEventWindow:
      () => eventWindow,
    /** 既知の Auxiliary だけを真の親 Session に結び、未知の ID を区別できるようにする。 */
    getAuxiliarySessionStatus: async (id: string) =>
      id === "aux-1" ? { id, parentSessionId: "session-1" } : null,
    /** 予約を所有する Main の Window だけを検索結果に出す。 */
    resolveSessionWindow: (id: string) => (id === "session-1" ? owner : null),
  });
  registerMainIpcHandlers(ipcMain, deps);
  const request = {
    incarnationId: "owner-1",
    clientRequestId: "request-1",
    userMessage: "Inspect",
  };
  const cases = [
    ["withmate:enqueue-session-turn", "enqueueSessionTurn", [request]],
    [
      "withmate:get-session-turn-queue-receipt",
      "getSessionTurnQueueReceipt",
      ["request-1"],
    ],
    ["withmate:list-session-turn-queue", "listSessionTurnQueue", []],
    [
      "withmate:list-session-turn-queue-receipts",
      "listSessionTurnQueueReceipts",
      [{ cursor: 4, limit: 20 }],
    ],
    [
      "withmate:cancel-queued-session-turn",
      "cancelQueuedSessionTurn",
      ["item-1"],
    ],
    [
      "withmate:send-queued-session-input",
      "sendQueuedSessionInput",
      ["item-1", "turn-1"],
    ],
  ] as const;
  for (const [channel, method, args] of cases) {
    assert.deepEqual(await handlers.get(channel)?.({}, "session-1", ...args), {
      method,
      args: ["session-1", ...args],
    });
    assert.deepEqual(await handlers.get(channel)?.({}, "aux-1", ...args), {
      method,
      args: ["aux-1", ...args],
    });
  }
  for (const window of [
    other,
    createWindowStub("file:///home.html"),
    createWindowStub("file:///settings.html"),
  ]) {
    eventWindow = window;
    for (const [channel, , args] of cases) {
      await assert.rejects(
        async () => handlers.get(channel)?.({}, "session-1", ...args),
        /target Session window/,
      );
      await assert.rejects(
        async () => handlers.get(channel)?.({}, "aux-1", ...args),
        /target Session window/,
      );
    }
  }
  eventWindow = owner;
  for (const [channel, , args] of cases) {
    await assert.rejects(
      async () => handlers.get(channel)?.({}, "unknown-aux", ...args),
      /target Session window/,
    );
  }
  assert.equal(calls.length, 2 * cases.length);
});

// @test-value v2
// kind = "security"
// claim = "3 queue readは非同期取得中にWindow ownerが失効した場合receiptと履歴を返さない"
// oracle = { type = "contract", ref = "src-electron/ipc/session-runtime.ts queue query after-await authorization" }
// fault = "取得開始時の認可だけで失効Windowへ遅延receipt/queue履歴を返す"
// observable = "依存取得済みの各readがowner交換後にrejectすること"
// observation_boundary = "public-boundary"
// scope = "Main durable queue IPC delayed read authorization"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// distinction = "即時非owner拒否testではawaitを跨ぐWindow owner変更を検知できない"
// @end-test-value
/** 予約の一覧・履歴・個別照会で、Window 交換後には取得済みの結果を返さないことを確認する。 */
test("queue readは遅い結果の返却前にWindow ownerを再認可する", async () => {
  for (const [channel, method, args] of [
    [
      "withmate:get-session-turn-queue-receipt",
      "getSessionTurnQueueReceipt",
      ["request-1"],
    ],
    ["withmate:list-session-turn-queue", "listSessionTurnQueue", []],
    [
      "withmate:list-session-turn-queue-receipts",
      "listSessionTurnQueueReceipts",
      [{ cursor: 4, limit: 20 }],
    ],
  ] as const) {
    const { ipcMain, handlers } = createIpcMainStub();
    const owner = createWindowStub("file:///session.html?sessionId=session-1");
    let currentOwner = owner;
    let complete!: (value: unknown) => void;
    let reads = 0;
    const result = new Promise<unknown>((resolve) => {
      complete = resolve;
    });
    const queue = {
      /** 照会開始を記録し、所有 Window の交換まで照会結果を保留する。 */ [method]:
        async () => {
          reads += 1;
          return result;
        },
    };
    const { deps } = createDeps({
      queue,
      /** 照会を開始した元の Window を送信元として維持する。 */ resolveEventWindow:
        () => owner,
      /** 読み取り中に置き換わり得る Session Window を現在値から返す。 */
      resolveSessionWindow: (id: string) =>
        id === "session-1" ? currentOwner : null,
    });
    registerMainIpcHandlers(ipcMain, deps);
    const pending = handlers.get(channel)?.(
      {},
      "session-1",
      ...args,
    ) as Promise<unknown>;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, 1);
    currentOwner = createWindowStub("file:///session.html?sessionId=session-1");
    complete({ privateReceipt: "must not leak" });
    await assert.rejects(pending, /target Session window/);
  }
});

// @test-value v2
// kind = "security"
// claim = "最新turnはMainまたはAuxiliaryの親owner Windowだけへ返し、対象外Windowからはstorageを読まない"
// oracle = { type = "contract", ref = "src-electron/ipc/session-query.ts getLatestSessionTurn authorization" }
// fault = "Auxiliaryの親ownerを認可しないか、対象外Windowへturn実行情報を公開する"
// observable = "Main/Auxiliary読取結果、storageへ渡るID、非owner要求の拒否とread回数"
// observation_boundary = "public-boundary"
// scope = "latest session turn IPC authorization"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
/** 最新 turn の対象 ID を変えずに読み取り、所有 Main Window 以外の要求は読み取り前に拒否することを確かめる。 */
test("最新turn IPCはMainとAuxiliaryの親owner Windowだけへ返す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const owner = createWindowStub("file:///session.html?sessionId=parent");
  const other = createWindowStub("file:///session.html?sessionId=other");
  let sender = owner;
  const reads: string[] = [];
  const { deps } = createDeps({
    /** 比較のため、現在選んだ送信元 Window を返す。 */
    resolveEventWindow: () => sender,
    /** 親 Session に一致した場合だけ最新 turn の読み取りを所有する Window を返す。 */
    resolveSessionWindow: (id: string) => (id === "parent" ? owner : null),
    /** Auxiliary の最新 turn では親 Window を認可に使い、Main は自分自身を所有者とする。 */
    getConversationOwnerSessionId: async (id: string) =>
      id === "aux" ? "parent" : id,
    /** 実際に読んだ対象 ID を記録し、Main と Auxiliary で異なる turn を返す。 */
    getLatestSessionTurn: async (id: string) => {
      reads.push(id);
      return {
        id: id === "parent" ? 1 : 2,
        sessionId: id,
        phase: "canceled",
        errorMessage: "canceled",
      };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const read = handlers.get(WITHMATE_GET_LATEST_SESSION_TURN_CHANNEL)!;
  for (const [id, turnId] of [
    ["parent", 1],
    ["aux", 2],
  ] as const) {
    assert.deepEqual(await read({}, id), {
      id: turnId,
      sessionId: id,
      phase: "canceled",
      errorMessage: "canceled",
    });
  }
  sender = other;
  await assert.rejects(async () => read({}, "parent"), /target Session window/);
  await assert.rejects(async () => read({}, "aux"), /target Session window/);
  assert.deepEqual(reads, ["parent", "aux"]);
});

// @test-value v2
// kind = "security"
// claim = "最新turnの遅い読取中にMain WindowまたはAuxiliaryの親ownerが変われば取得結果を公開しない"
// oracle = { type = "contract", ref = "src-electron/ipc/session-query.ts getLatestSessionTurn before/after authorization" }
// fault = "read前だけ認可し、owner変更後も旧Windowへturnを返す"
// observable = "実際に開始・完了したstorage readの後にIPCが拒否されること"
// observation_boundary = "public-boundary"
// scope = "latest session turn asynchronous owner authorization"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
/** Main の Window 交換または Auxiliary の親変更が読み取り中に起きると、完了済みの最新 turn を返さないことを確かめる。 */
test("最新turn IPCは遅いreadの完了後にownerを再認可する", async () => {
  for (const target of ["parent", "aux"] as const) {
    const { ipcMain, handlers } = createIpcMainStub();
    const owner = createWindowStub("file:///session.html?sessionId=parent");
    const replacement = createWindowStub(
      "file:///session.html?sessionId=replacement",
    );
    let currentWindow = owner;
    let auxiliaryParent = "parent";
    let signalStarted!: () => void;
    let releaseRead!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readFinished = false;
    const { deps } = createDeps({
      /** 遅い読み取りを始めた元の Window を呼び出し元として返し続ける。 */
      resolveEventWindow: () => owner,
      /** 元の親の Window 交換と別の親への切り替えを両方再現できるようにする。 */
      resolveSessionWindow: (id: string) =>
        id === "parent" ? currentWindow : replacement,
      /** Auxiliary の親だけを途中で変更可能にし、Main の認可経路と区別する。 */
      getConversationOwnerSessionId: async (id: string) =>
        id === "aux" ? auxiliaryParent : id,
      /** 指定対象で読み取り開始を通知し、認可の前提が変更されるまで完了を待つ。 */
      getLatestSessionTurn: async (id: string) => {
        assert.equal(id, target);
        signalStarted();
        await paused;
        readFinished = true;
        return { id: 3, sessionId: id, phase: "completed" };
      },
    });
    registerMainIpcHandlers(ipcMain, deps);
    const pending = handlers.get(WITHMATE_GET_LATEST_SESSION_TURN_CHANNEL)!(
      {},
      target,
    ) as Promise<unknown>;
    await started;
    if (target === "parent") currentWindow = replacement;
    else auxiliaryParent = "replacement";
    releaseRead();
    await assert.rejects(pending, /target Session window/);
    assert.equal(readFinished, true);
  }
});

// @test-value v2
// kind = "contract"
// claim = "会話page・全履歴検索・navigatorはMainまたはAuxiliaryの親Session Windowだけが要求できる"
// oracle = { type = "contract", ref = "src-electron/ipc/session-query.ts: registerSessionQueryHandlers / authorizeConversation" }
// fault = "Auxiliaryを親へ解決せず認可するか、対象外Windowの要求を会話readへ渡す"
// observable = "owner Windowのpage/search/navigator結果とread呼出回数、対象外Windowのrejection"
// observation_boundary = "public-boundary"
// scope = "conversation-read-ipc-authorization"
// lifecycle = "permanent"
// impact = "対象外Windowへの会話履歴公開を防ぐ"
// distinction = "既存のdetail read認可testは独立したpage/search/navigator commandを通らない。小さいIPC stubで3commandの権限を保持する"
// @end-test-value
/** 会話ページ・検索・ナビゲーターの独立した入口すべてで、親 Window だけが Auxiliary の結果を取得できることを確かめる。 */
test("会話page/search/navigatorは親owner Windowだけが取得できる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub(
    "http://localhost:5173/?mode=agent&sessionId=parent",
  );
  const otherWindow = createWindowStub("http://localhost:5173/");
  let eventWindow = ownerWindow;
  const reads: string[] = [];
  const page = {
    sessionId: "aux",
    incarnationId: "created",
    messages: [],
    startIndex: 0,
    totalCount: 0,
  };
  const queryPage = {
    status: "complete",
    stamp: {
      generationId: "generation",
      ownerIdentity: "aux",
      contentRevision: 1,
      requestId: "find-1",
    },
    incarnationId: "created",
    messageCount: 4,
    totalCount: 1,
    offset: 0,
    items: [{ messageIndex: 3, occurrenceIndex: 0 }],
  };
  const navPage = {
    ...queryPage,
    stamp: { ...queryPage.stamp, requestId: "nav-1" },
    totalCount: 0,
    items: [],
  };
  const { deps } = createDeps({
    /** 対象外の Window から同じ入口を呼べるよう、送信元の現在値を返す。 */
    resolveEventWindow: () => eventWindow,
    /** 会話を所有する親 Session ID にだけ Window を割り当てる。 */
    resolveSessionWindow: (id: string) =>
      id === "parent" ? ownerWindow : null,
    /** 直近の会話ページを取得する認可で、Auxiliary の所有者を親 Session として返す。 */
    getConversationOwnerSessionId: async (id: string) =>
      id === "aux" ? "parent" : id,
    /** ページ読み取りに実際に渡った ID を記録し、検証用の空ページを返す。 */
    getConversationPage: async (id: string) => {
      reads.push(`page:${id}`);
      return page;
    },
    /** 検索・ナビゲーターが親の認可を使って指定の Auxiliary を読むよう、両操作の接続先を返す。 */
    resolveConversationQueryOwner: async (id: string) => ({
      ownerSessionId: "parent",
      /** このケースでは query owner の世代を失効させない。 */ isCurrent: () =>
        true,
      /** 照会を取り消さないケースなので、取消操作を副作用なしで受け付ける。 */ cancel:
        () => undefined,
      /** 検索へ届いた対象 ID を記録して、検索結果を返す。 */
      search: async () => {
        reads.push(`search:${id}`);
        return queryPage;
      },
      /** ナビゲーターへ届いた対象 ID を記録して、検索とは異なる結果を返す。 */
      navigate: async () => {
        reads.push(`navigator:${id}`);
        return navPage;
      },
    }),
  });
  registerMainIpcHandlers(ipcMain, deps);
  assert.deepEqual(
    await handlers.get(WITHMATE_GET_CONVERSATION_PAGE_CHANNEL)?.({}, "aux", {
      startIndex: 0,
    }),
    page,
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_SEARCH_CONVERSATION_CHANNEL)?.({}, "aux", {
      requestId: "find-1",
      producerId: "find",
      query: "x",
      mode: "source",
    }),
    queryPage,
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_CONVERSATION_NAVIGATOR_CHANNEL)?.(
      {},
      "aux",
      { requestId: "nav-1", producerId: "nav", filter: "all" },
    ),
    navPage,
  );
  eventWindow = otherWindow;
  for (const channel of [
    WITHMATE_GET_CONVERSATION_PAGE_CHANNEL,
    WITHMATE_SEARCH_CONVERSATION_CHANNEL,
    WITHMATE_LIST_CONVERSATION_NAVIGATOR_CHANNEL,
  ]) {
    await assert.rejects(
      () =>
        handlers.get(channel)?.({}, "aux", {
          requestId: "other",
          producerId: "other",
          query: "x",
          mode: "source",
          filter: "all",
        }) as Promise<unknown>,
      /target Session window/,
    );
  }
  assert.deepEqual(reads, ["page:aux", "search:aux", "navigator:aux"]);
});

import type { IpcMain } from "electron";

// @test-value v2
// kind = "security"
// claim = "検索実行中にstorage ownerまたは送信元Session Windowが変わると旧結果を公開しない"
// oracle = { type = "contract", ref = "src-electron/ipc/session-query.ts query response current and authorization fence" }
// fault = "検索開始時だけownerを確認して失効したownerの結果を返す"
// observable = "read完了後のinvalidated応答またはowner Window認可拒否"
// observation_boundary = "public-boundary"
// scope = "conversation IPC asynchronous response fence"
// lifecycle = "permanent"
// impact = "reset/reopenやWindow置換後に旧会話結果を公開しない"
// distinction = "storage stampと型検査だけではMain Window authorityの非同期変更を検出できない"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
/** 検索の完了を待つ間に保存側所有者が失効した場合と、Window が置き換わった場合を異なる応答で区別する。 */
test("会話queryは検索完了時にもownerとWindowを照合する", async () => {
  for (const change of ["storage", "window"] as const) {
    const { ipcMain, handlers } = createIpcMainStub();
    const sender = createWindowStub("file:///session.html?sessionId=parent");
    const replacement = createWindowStub(
      "file:///session.html?sessionId=parent",
    );
    let currentWindow = sender;
    let ownerCurrent = true;
    let started!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps } = createDeps({
      /** 要求を発行した元の Window を送信元とする。 */
      resolveEventWindow: () => sender,
      /** 検索中に置き換え可能な所有 Window を返す。 */ resolveSessionWindow:
        () => currentWindow,
      /** テストから有効性を切り替えられる検索の所有者を返す。 */
      resolveConversationQueryOwner: async () => ({
        ownerSessionId: "parent",
        /** 保存側の世代が検索完了前に失効したかを、変数の現在値から返す。 */ isCurrent:
          () => ownerCurrent,
        /** このケースは取消経路を使わないため、何も取り消さない。 */ cancel:
          () => undefined,
        /** Window または保存側の状態を変更できるよう、検索の完了を明示的な解放まで待つ。 */
        search: async () => {
          started();
          await pause;
          return { status: "cancelled" };
        },
      }),
    });
    registerMainIpcHandlers(ipcMain, deps);
    const pending = handlers.get(WITHMATE_SEARCH_CONVERSATION_CHANNEL)!(
      {},
      "parent",
      { requestId: "q", producerId: "find", query: "x", mode: "source" },
    );
    await ready;
    if (change === "storage") ownerCurrent = false;
    else currentWindow = replacement;
    release();
    if (change === "storage")
      assert.deepEqual(await pending, { status: "invalidated" });
    else await assert.rejects(async () => pending, /target Session window/);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Window破棄と明示取消はqueryのproducer枠を解放し、無制限producer admissionは拒否する"
// oracle = { type = "contract", ref = "src-electron/ipc/session-query.ts sender lifecycle and producer budget" }
// fault = "Window破棄または明示取消でproducer枠が残るかproducer上限を適用せずMain状態が増える"
// observable = "17番目producerの拒否、取消後のadmission、破棄時取消件数、再admission時のbackend producer identity"
// observation_boundary = "public-boundary"
// scope = "conversation IPC window lifecycle budget"
// lifecycle = "permanent"
// impact = "閉じたWindowのCPU仕事と無制限Main producer状態を保持しない"
// distinction = "storage側のqueue制限ではMainの認可lookup中slotやwebContents lifecycleを制御できない"
// @end-test-value
/** producer の枠が上限を超えて増えず、取消と Window 破棄で枠を回収し、新しい識別子で再受付できることを確認する。 */
test("会話queryはWindow破棄と明示取消でproducer予算を解放する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const window = createWindowStub("file:///session.html?sessionId=parent");
  let destroyed!: () => void;
  const event = {
    sender: {
      /** Window 破棄イベントのリスナーを捕捉し、実際に Electron を起動せず後始末を発火する。 */ once: (
        name: string,
        listener: () => void,
      ) => {
        assert.equal(name, "destroyed");
        destroyed = listener;
      },
    },
  };
  const producers: string[] = [];
  const cancelled: string[] = [];
  const { deps } = createDeps({
    /** producer の追加を単一の送信元に集約して上限を調べる。 */
    resolveEventWindow: () => window,
    /** 呼び出し元と同じ Window を親の所有者として返し、認可自体は変更しない。 */ resolveSessionWindow:
      () => window,
    /** 保存側に渡った producer 識別子と取消対象を測る検索インターフェースを返す。 */
    resolveConversationQueryOwner: async () => ({
      ownerSessionId: "parent",
      /** 枠の回収だけを検証するため、保存側の所有者は有効なまま保つ。 */ isCurrent:
        () => true,
      /** 保存側に割り当てられた producer の識別子を記録し、再受付前後で比較できるようにする。 */
      search: async (request: { producerId: string }) => {
        producers.push(request.producerId);
        return { status: "cancelled" };
      },
      /** 明示取消と Window 破棄が実際に取り消した producer を記録する。 */
      cancel: (request: { producerId: string }) => {
        cancelled.push(request.producerId);
      },
    }),
  });
  registerMainIpcHandlers(ipcMain, deps);
  const search = handlers.get(WITHMATE_SEARCH_CONVERSATION_CHANNEL)!;
  const request = {
    requestId: "one",
    producerId: "producer-0",
    query: "x",
    mode: "source",
  };
  await assert.rejects(
    async () =>
      search(event, "parent", { ...request, producerId: "x".repeat(129) }),
    /identity is invalid/,
  );
  for (let index = 0; index < 16; index++)
    await search(event, "parent", {
      ...request,
      producerId: `producer-${index}`,
    });
  await assert.rejects(
    async () => search(event, "parent", { ...request, producerId: "overflow" }),
    /producer limit/,
  );
  await handlers.get(WITHMATE_CANCEL_CONVERSATION_QUERY_CHANNEL)!(
    event,
    request,
  );
  await search(event, "parent", { ...request, producerId: "overflow" });
  destroyed();
  assert.deepEqual(cancelled, producers);
  await search(event, "parent", request);
  assert.notEqual(producers[17], producers[0]);
});

// @test-value v2
// kind = "contract"
// claim = "検索IPCはraw-source anchorのsafe integerと非空区間を検証し、正常anchorとanchor省略の継続pageを同じproducerへ渡す"
// oracle = { type = "contract", ref = "src-shared/session/conversation-page.ts: ConversationSearchAnchor" }
// fault = "不正anchorをownerへ渡すかanchorを欠落させるか継続pageでproducerを取消する"
// observable = "IPC rejection、owner searchへ渡されたanchorとproducer、cancel呼出件数"
// observation_boundary = "public-boundary"
// scope = "conversation-search-ipc-anchor"
// lifecycle = "permanent"
// impact = "外部入力の数値境界を守り、mode切替後もページ取得を継続できる"
// distinction = "storage testではIPCのvalidationとsignatureによるproducer継続を通らず、型検査は不正runtime入力を拒否できない"
// @end-test-value
/** 不正な anchor を処理前に拒否し、anchor を省略した継続ページでも同じ producer を維持することを確認する。 */
test("会話検索IPCはanchorを検証して継続pageのproducerを保つ", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const window = createWindowStub("file:///session.html?sessionId=parent");
  const calls: Array<{ producerId: string; anchor?: unknown }> = [];
  let cancellations = 0;
  const { deps } = createDeps({
    /** anchor の形式検証中は送信元を同じ Window に保つ。 */
    resolveEventWindow: () => window,
    /** 親の解決結果を送信元と一致させ、anchor 以外の認可条件を満たす。 */ resolveSessionWindow:
      () => window,
    /** anchor と producer の転送内容を観測する検索経路を返す。 */
    resolveConversationQueryOwner: async () => ({
      ownerSessionId: "parent",
      /** 継続ページの間に保存側の世代が変わらない前提とする。 */ isCurrent:
        () => true,
      /** 正常な anchor と継続要求を記録し、保存層へ渡る内容を比較できるようにする。 */
      search: async (request: { producerId: string; anchor?: unknown }) => {
        calls.push(request);
        return { status: "cancelled" };
      },
      /** 継続ページが既存 producer を取り消したか判定するため取消回数を数える。 */
      cancel: () => {
        cancellations++;
      },
    }),
  });
  registerMainIpcHandlers(ipcMain, deps);
  const search = handlers.get(WITHMATE_SEARCH_CONVERSATION_CHANNEL)!;
  const request = {
    requestId: "anchor",
    producerId: "find",
    query: "needle",
    mode: "source",
  };
  for (const anchor of [
    null,
    {},
    { messageIndex: -1, startOffset: 0, endOffset: 1 },
    { messageIndex: 0, startOffset: 0.5, endOffset: 1 },
    { messageIndex: 0, startOffset: 0, endOffset: Number.MAX_SAFE_INTEGER + 1 },
    { messageIndex: 0, startOffset: 1, endOffset: 1 },
  ]) {
    await assert.rejects(
      async () => search({}, "parent", { ...request, anchor }),
      /anchor is invalid/,
    );
  }
  assert.equal(calls.length, 0);
  const anchor = { messageIndex: 10, startOffset: 0, endOffset: 6 };
  await search({}, "parent", { ...request, anchor });
  await search({}, "parent", {
    ...request,
    offset: 64,
    stamp: {
      generationId: "generation",
      ownerIdentity: "owner",
      contentRevision: 0,
      requestId: request.requestId,
    },
  });
  assert.deepEqual(calls[0].anchor, anchor);
  assert.equal(calls[1].anchor, undefined);
  assert.equal(calls[0].producerId, calls[1].producerId);
  assert.equal(cancellations, 0);
});

// @test-value v2
// kind = "invariant"
// claim = "owner lookup中に新queryまたは取消が到着した場合、旧queryはstorageへdispatchしない"
// oracle = { type = "contract", ref = "src-electron/ipc/session-query.ts query admission latest/cancel" }
// fault = "lookup後にlatestを検査せず古い検索をstorageへ流す"
// observable = "旧queryのcancelled応答とstorage dispatch requestId"
// observation_boundary = "public-boundary"
// scope = "conversation IPC admission race"
// lifecycle = "permanent"
// impact = "入力更新や検索close後に不要な全履歴検索がDBとCPUを占有することを防ぐ"
// distinction = "storage testではMainの非同期認可lookup前に到着する取消を観測できない"
// @end-test-value
/** 所有者を照会している間に新しい検索または取消が届けば、古い要求を保存層へ送らないことを確かめる。 */
test("会話queryはlookup中のlatest更新と取消をdispatch前に反映する", async () => {
  for (const action of ["replace", "cancel"] as const) {
    const { ipcMain, handlers } = createIpcMainStub();
    const ownerWindow = createWindowStub(
      "file:///session.html?sessionId=parent",
    );
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatched: string[] = [];
    let lookups = 0;
    const { deps } = createDeps({
      /** 新旧の検索と取消を同じ Window の操作として解決する。 */
      resolveEventWindow: () => ownerWindow,
      /** 検索対象の所有者を送信元と一致させ、受付順による影響だけを調べる。 */
      resolveSessionWindow: () => ownerWindow,
      /** 最初の所有者解決だけを止め、その間に同じ producer へ新しい操作を送れるようにする。 */
      resolveConversationQueryOwner: async () => {
        if (++lookups === 1) await paused;
        return {
          ownerSessionId: "parent",
          /** 保存側の世代は失効させず、要求の新旧判定だけを検証する。 */ isCurrent:
            () => true,
          /** 保存層の取消は観測せず、検索が配送されたかだけを調べる。 */ cancel:
            () => undefined,
          /** 保存側へ配送された要求 ID を記録し、古い検索が混ざらないことを観測する。 */
          search: async (request: { requestId: string }) => {
            dispatched.push(request.requestId);
            return { status: "cancelled" };
          },
        };
      },
    });
    registerMainIpcHandlers(ipcMain, deps);
    const search = handlers.get(WITHMATE_SEARCH_CONVERSATION_CHANNEL)!;
    const request = {
      requestId: "old",
      producerId: "find",
      query: "x",
      mode: "source",
    };
    const old = search({}, "parent", request);
    if (action === "replace")
      await search({}, "parent", { ...request, requestId: "new" });
    else
      await handlers.get(WITHMATE_CANCEL_CONVERSATION_QUERY_CHANNEL)!(
        {},
        request,
      );
    release();
    assert.deepEqual(await old, { status: "cancelled" });
    assert.deepEqual(dispatched, action === "replace" ? ["new"] : []);
  }
});

// @test-value v2
// kind = "security"
// claim = "query取消はsender所有producerだけに作用し、owner失効後のlookup結果はdispatchしない"
// oracle = { type = "contract", ref = "src-electron/ipc/session-query.ts sender isolation and owner snapshot fence" }
// fault = "別Windowのproducerを取消するか旧storage ownerを検索に使う"
// observable = "backend producerIdの分離、取消件数、失効応答とdispatch件数"
// observation_boundary = "public-boundary"
// scope = "conversation IPC sender and owner isolation"
// lifecycle = "permanent"
// impact = "別Windowの検索妨害とDB reset/reopen後の旧ownerへの読取を防ぐ"
// distinction = "store generation testではWindow sender認可と非同期Main snapshotを扱わない"
// risk_tags = ["authorization"]
// @end-test-value
/** 同じ producer 名を使う別 Window の取消を分離し、失効した保存側の所有者へは検索を配送しないことを確認する。 */
test("会話queryはsenderごとにproducerを隔離しowner失効を拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const first = createWindowStub("file:///session.html?sessionId=first");
  const second = createWindowStub("file:///session.html?sessionId=second");
  let sender = first;
  let current = true;
  const producers: string[] = [];
  const cancellations: string[] = [];
  const { deps } = createDeps({
    /** 操作ごとに切り替えられる呼び出し元 Window を返す。 */
    resolveEventWindow: () => sender,
    /** 二つの Session ID を異なる所有 Window に結びつける。 */
    resolveSessionWindow: (id: string) => (id === "first" ? first : second),
    /** 指定 Session の検索を、その時点の保存側有効性と記録先に結びつける。 */
    resolveConversationQueryOwner: async (id: string) => ({
      ownerSessionId: id,
      /** 保存側の世代をテスト中に無効化し、配送前の確認を再現する。 */ isCurrent:
        () => current,
      /** IPC が保存側に割り当てた producer 識別子を記録し、Window 間の分離を確認可能にする。 */
      search: async (request: { producerId: string }) => {
        producers.push(request.producerId);
        return { status: "cancelled" };
      },
      /** 保存先へ届いた取消だけを記録し、別 Window の producer に及んでいないかを調べる。 */
      cancel: (request: { producerId: string }) => {
        cancellations.push(request.producerId);
      },
    }),
  });
  registerMainIpcHandlers(ipcMain, deps);
  const request = {
    requestId: "same",
    producerId: "find",
    query: "x",
    mode: "source",
  };
  const search = handlers.get(WITHMATE_SEARCH_CONVERSATION_CHANNEL)!;
  await search({}, "first", request);
  sender = second;
  await handlers.get(WITHMATE_CANCEL_CONVERSATION_QUERY_CHANNEL)!({}, request);
  assert.deepEqual(cancellations, []);
  await search({}, "second", request);
  assert.notEqual(producers[0], producers[1]);
  await handlers.get(WITHMATE_CANCEL_CONVERSATION_QUERY_CHANNEL)!({}, request);
  assert.deepEqual(cancellations, [producers[1]]);
  current = false;
  assert.deepEqual(
    await search({}, "second", { ...request, requestId: "reopened" }),
    { status: "invalidated" },
  );
  assert.equal(producers.length, 2);
});

import { registerMainIpcHandlers } from "../../src-electron/ipc/register-main-ipc.js";
import {
  WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL,
  WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_GET_AUXILIARY_CREATION_CONTEXT_CHANNEL,
  WITHMATE_CANCEL_AUXILIARY_CREATION_CHANNEL,
  WITHMATE_GET_AUXILIARY_CREATION_CHANNEL,
  WITHMATE_CREATE_CHARACTER_CHANNEL,
  WITHMATE_CREATE_MATE_CHANNEL,
  WITHMATE_CREATE_SESSION_CHANNEL,
  WITHMATE_CREATE_PROMPT_TEMPLATE_CHANNEL,
  WITHMATE_DELETE_SESSION_CHANNEL,
  WITHMATE_DELETE_PROMPT_TEMPLATE_CHANNEL,
  WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL,
  WITHMATE_GET_LATEST_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_GET_CONVERSATION_PAGE_CHANNEL,
  WITHMATE_GET_LATEST_SESSION_TURN_CHANNEL,
  WITHMATE_SEARCH_CONVERSATION_CHANNEL,
  WITHMATE_LIST_CONVERSATION_NAVIGATOR_CHANNEL,
  WITHMATE_CANCEL_CONVERSATION_QUERY_CHANNEL,
  WITHMATE_GET_AUXILIARY_DRAFT_CHANNEL,
  WITHMATE_GET_AUXILIARY_SESSION_STATUS_CHANNEL,
  WITHMATE_GET_CHARACTER_CHANNEL,
  WITHMATE_GET_APP_SETTINGS_CHANNEL,
  WITHMATE_GET_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_GET_MATE_STATE_CHANNEL,
  WITHMATE_LIST_CHARACTERS_CHANNEL,
  WITHMATE_LIST_AUXILIARY_SESSIONS_CHANNEL,
  WITHMATE_LIST_OPEN_AUXILIARY_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_LIST_SESSION_SUMMARY_PAGE_CHANNEL,
  WITHMATE_LIST_SESSION_CHARACTER_USAGE_CHANNEL,
  WITHMATE_GET_SESSION_GLOSSARY_PROJECTION_CHANNEL,
  WITHMATE_SEARCH_SESSION_GLOSSARY_CHANNEL,
  WITHMATE_LIST_PROMPT_TEMPLATES_CHANNEL,
  WITHMATE_LIST_SESSION_FILE_ROOTS_CHANNEL,
  WITHMATE_LIST_SESSION_FILE_PINS_CHANNEL,
  WITHMATE_PIN_SESSION_FILE_CHANNEL,
  WITHMATE_UNPIN_SESSION_FILE_CHANNEL,
  WITHMATE_LIST_SESSION_DIRECTORY_CHANNEL,
  WITHMATE_INSPECT_SESSION_FILE_CHANNEL,
  WITHMATE_INSPECT_SESSION_IMAGE_CHANNEL,
  WITHMATE_READ_SESSION_IMAGE_CHUNK_CHANNEL,
  WITHMATE_INSPECT_SESSION_PDF_CHANNEL,
  WITHMATE_READ_SESSION_PDF_CHUNK_CHANNEL,
  WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL,
  WITHMATE_OPEN_SESSION_FILE_CHANNEL,
  WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL,
  WITHMATE_GET_SESSION_FILE_PREVIEW_WINDOW_PAYLOAD_CHANNEL,
  WITHMATE_COPY_SESSION_FILE_PREVIEW_IMAGE_CHANNEL,
  WITHMATE_COPY_SESSION_FILE_OBJECT_CHANNEL,
  WITHMATE_SHOW_SESSION_FILE_OBJECT_COPY_CONTEXT_MENU_CHANNEL,
  WITHMATE_SHOW_SESSION_FILE_TREE_CONTEXT_MENU_CHANNEL,
  WITHMATE_SHOW_SESSION_FILE_PREVIEW_IMAGE_CONTEXT_MENU_CHANNEL,
  WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL,
  WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL,
  WITHMATE_LIST_FILE_ROOT_CHANGES_REPOSITORIES_CHANNEL,
  WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL,
  WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_REPOSITORIES_CHANNEL,
  WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_COMMITS_CHANNEL,
  WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMMIT_DETAIL_CHANNEL,
  WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMPARISON_CHANNEL,
  WITHMATE_GET_FILE_ROOT_GIT_HISTORY_DIFF_CHANNEL,
  WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_GET_SESSION_WINDOW_RESTORE_SET_CHANNEL,
  WITHMATE_RESTORE_SESSION_WINDOWS_CHANNEL,
  WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
  WITHMATE_PICK_IMAGE_FILE_CHANNEL,
  WITHMATE_VALIDATE_SESSION_WORKSPACE_CHANNEL,
  WITHMATE_VALIDATE_SESSION_ADDITIONAL_DIRECTORY_CHANNEL,
  WITHMATE_VALIDATE_WORKSPACE_DIRECTORY_CHANNEL,
  WITHMATE_RESET_APP_DATABASE_CHANNEL,
  WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL,
  WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL,
  WITHMATE_SAVE_AUXILIARY_DRAFT_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_STEER_SESSION_TURN_CHANNEL,
  WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL,
  WITHMATE_STEER_AUXILIARY_SESSION_TURN_CHANNEL,
  WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_SET_AUXILIARY_EXECUTION_OPTIONS_CHANNEL,
  WITHMATE_SET_AUXILIARY_TITLE_CHANNEL,
  WITHMATE_SET_AUXILIARY_MESSAGE_BOOKMARK_CHANNEL,
  WITHMATE_SET_SESSION_EXECUTION_OPTIONS_CHANNEL,
  WITHMATE_SET_SESSION_TITLE_CHANNEL,
  WITHMATE_SET_SESSION_MESSAGE_BOOKMARK_CHANNEL,
  WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL,
  WITHMATE_UPDATE_PROMPT_TEMPLATE_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";

/** 登録済みチャネルから取り出して呼び出せるよう、イベントと IPC 引数をまとめて表す型。 */
type Handler = (...args: unknown[]) => unknown;

// @test-value v2
// kind = "security"
// claim = "画像専用IPCはowning Sessionまたはcurrent preview baseのみ許可し、読込中のbase変更を結果返却前に拒否する"
// oracle = { type = "contract", ref = "src-electron/ipc/shared.ts: assertSessionFileLinkSender" }
// fault = "別windowや別session・stale preview baseへ画像を公開する、またはdetached Previewが他の通常fileを読む"
// observable = "画像IPCの返却値・拒否Error、service呼出数、generic read IPCの拒否Error"
// observation_boundary = "public-boundary"
// scope = "registered inspect/read image IPC and existing generic file IPC"
// lifecycle = "permanent"
// impact = "任意windowから画像や一般fileを読み取れてwindow/session権限を逸脱する"
// distinction = "service testや型検査ではsenderとpreview lifecycleのIPC認可を実行確認できない;既存stubで低コストに確認する"
// @end-test-value
/** 画像の検査とチャンク読み取りを所有 Window または現在の Preview 基点に限定し、汎用読み取りへ権限が広がらないことを確認する。 */
test("image IPC authorizes owner and current preview base while keeping detached file reads bound", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub(
    "file:///session.html?sessionId=session-1",
  );
  const previewWindow = createWindowStub(
    "file:///file-preview.html?token=preview",
  );
  const otherWindow = createWindowStub("file:///home.html");
  let currentWindow = ownerWindow;
  let currentBase = { sessionId: "aux-1", absolutePath: "/outside/source.md" };
  let changeBaseDuringRead = false;
  let calls = 0;
  const { deps } = createDeps({
    /** 所有 Window、Preview、無関係な Window を切り替え、同じ画像要求を比較する。 */
    resolveEventWindow: () => currentWindow,
    /** Main の ID に一致したときだけ画像取得の所有 Window を返す。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? ownerWindow : null,
    /** 対象 Auxiliary の画像取得は既知の親にだけ所属するものとする。 */
    getSessionFileExplorerOwnerSessionId: async (sessionId: string) =>
      sessionId === "aux-1" ? "session-1" : null,
    /** Preview とその対象 Session が両方一致したときだけ、現在の基点ファイルを返す。 */
    getFilePreviewWindowResource: (window: unknown, sessionId: string) =>
      window === previewWindow && sessionId === "aux-1" ? currentBase : null,
    /** 認可を通過した画像検査を数え、識別しやすい PNG の情報を返す。 */
    inspectSessionImage: async () => {
      calls += 1;
      return { mimeType: "image/png" };
    },
    /** 画像チャンクを取得しつつ必要に応じて基点を置き換え、返却前の認可確認を観測する。 */
    readSessionImageChunk: async () => {
      calls += 1;
      if (changeBaseDuringRead)
        currentBase = { ...currentBase, absolutePath: "/outside/other.md" };
      return { data: new ArrayBuffer(1) };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const request = { sessionId: "aux-1", target: "/outside/image.png" };
  assert.deepEqual(
    await handlers.get(WITHMATE_INSPECT_SESSION_IMAGE_CHANNEL)?.({}, request),
    { mimeType: "image/png" },
  );
  currentWindow = previewWindow;
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL)?.(
        {},
        {
          sessionId: "aux-1",
          absolutePath: "/outside/image.png",
          offset: 0,
          length: 1,
          expectedRevision: "revision",
        },
      ) as Promise<unknown>,
    /current Preview resource/,
  );
  currentWindow = otherWindow;
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_INSPECT_SESSION_IMAGE_CHANNEL)?.(
        {},
        request,
      ) as Promise<unknown>,
    /current Preview resource as its base/,
  );
  currentWindow = ownerWindow;
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_INSPECT_SESSION_IMAGE_CHANNEL)?.(
        {},
        { ...request, sessionId: "other" },
      ) as Promise<unknown>,
  );
  assert.equal(calls, 1);
  currentWindow = previewWindow;
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_INSPECT_SESSION_IMAGE_CHANNEL)?.(
        {},
        request,
      ) as Promise<unknown>,
    /current Preview resource as its base/,
  );
  const basedRequest = { ...request, baseResource: currentBase };
  assert.deepEqual(
    await handlers.get(WITHMATE_INSPECT_SESSION_IMAGE_CHANNEL)?.(
      {},
      basedRequest,
    ),
    { mimeType: "image/png" },
  );
  const chunkRequest = {
    ...basedRequest,
    offset: 0,
    length: 1,
    expectedRevision: "revision",
  };
  assert.equal(
    (
      (await handlers.get(WITHMATE_READ_SESSION_IMAGE_CHUNK_CHANNEL)?.(
        {},
        chunkRequest,
      )) as { data: ArrayBuffer }
    ).data.byteLength,
    1,
  );
  changeBaseDuringRead = true;
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_READ_SESSION_IMAGE_CHUNK_CHANNEL)?.(
        {},
        chunkRequest,
      ) as Promise<unknown>,
    /current Preview resource as its base/,
  );
  assert.equal(calls, 4);
});

// @test-value v2
// kind = "security"
// claim = "PDF IPCはownerとcurrent preview baseのみ許可し、読込中のowner・base変更を返却前に拒否する"
// oracle = { type = "contract", ref = "src-electron/ipc/shared.ts: assertSessionFileLinkSender" }
// fault = "別windowやstale previewへのPDF読込を許可する、または非同期読込後にownerを再確認しない"
// observable = "PDF IPCの返却値・拒否Errorとservice呼出数"
// observation_boundary = "public-boundary"
// scope = "registered inspect/read PDF IPC sender lifecycle"
// lifecycle = "permanent"
// impact = "PDF自動読込がwindow/session権限を逸脱する"
// distinction = "service testと型検査はIPC sender lifecycleを検証できず、既存stubで低コストに確認する"
// @end-test-value
/** PDF の検査・チャンク取得を所有 Window と現在の Preview 基点に限定し、読み取り途中の認可変更も検出することを確かめる。 */
test("PDF IPC rechecks owner and preview base before returning bytes", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub(
    "file:///session.html?sessionId=session-1",
  );
  const previewWindow = createWindowStub(
    "file:///file-preview.html?token=preview",
  );
  const otherWindow = createWindowStub("file:///home.html");
  let currentWindow = ownerWindow;
  let ownerSessionId: string | null = "session-1";
  let currentBase = { sessionId: "aux-1", absolutePath: "/outside/source.md" };
  let changeDuringRead: "base" | "owner" | "window" | null = null;
  let calls = 0;
  const { deps } = createDeps({
    /** PDF を要求した Window を差し替え、読み取りの途中でも変更できるようにする。 */
    resolveEventWindow: () => currentWindow,
    /** 対象 Main に対してだけ、Files を所有する Window を返す。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? ownerWindow : null,
    /** PDF チャンクの取得中に所有 Session を失効させられるよう、その時点の値を返す。 */
    getSessionFileExplorerOwnerSessionId: async () => ownerSessionId,
    /** 指定 Preview と Auxiliary の組合せだけを有効にし、現在の基点を返す。 */
    getFilePreviewWindowResource: (window: unknown, sessionId: string) =>
      window === previewWindow && sessionId === "aux-1" ? currentBase : null,
    /** PDF 検査が依存先まで届いた回数と返却形式を確認するための応答。 */
    inspectSessionPdf: async () => {
      calls++;
      return { mimeType: "application/pdf" };
    },
    /** 読み取り中に基点・所有 Session・呼び出し元を切り替え、取得済みのバイトを返してはならない状況を作る。 */
    readSessionPdfChunk: async () => {
      calls++;
      if (changeDuringRead === "base")
        currentBase = { ...currentBase, absolutePath: "/outside/other.md" };
      if (changeDuringRead === "owner") ownerSessionId = null;
      if (changeDuringRead === "window") currentWindow = otherWindow;
      return { data: new ArrayBuffer(1) };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const request = { sessionId: "aux-1", target: "/outside/result.pdf" };
  /** 既定の PDF または検証用に変えた基点を使って、登録済みの検査ハンドラーを呼ぶ。 */
  const inspect = (input: unknown = request) =>
    handlers.get(WITHMATE_INSPECT_SESSION_PDF_CHANNEL)?.(
      {},
      input,
    ) as Promise<unknown>;
  /** 指定した PDF チャンク要求を登録済み IPC に送る。 */
  const read = (input: unknown) =>
    handlers.get(WITHMATE_READ_SESSION_PDF_CHUNK_CHANNEL)?.(
      {},
      input,
    ) as Promise<unknown>;
  assert.deepEqual(await inspect(), { mimeType: "application/pdf" });
  currentWindow = otherWindow;
  await assert.rejects(inspect, /current Preview resource as its base/);
  currentWindow = previewWindow;
  await assert.rejects(inspect, /current Preview resource as its base/);
  assert.equal(calls, 1);
  const based = { ...request, baseResource: currentBase };
  assert.deepEqual(await inspect(based), { mimeType: "application/pdf" });
  const chunk = {
    ...based,
    offset: 0,
    length: 1,
    expectedRevision: "revision",
  };
  assert.equal(
    ((await read(chunk)) as { data: ArrayBuffer }).data.byteLength,
    1,
  );
  changeDuringRead = "base";
  await assert.rejects(
    () => read(chunk),
    /current Preview resource as its base/,
  );
  currentWindow = ownerWindow;
  changeDuringRead = "owner";
  await assert.rejects(() =>
    read({ ...request, offset: 0, length: 1, expectedRevision: "revision" }),
  );
  ownerSessionId = "session-1";
  changeDuringRead = "window";
  await assert.rejects(() =>
    read({ ...request, offset: 0, length: 1, expectedRevision: "revision" }),
  );
  assert.equal(calls, 6);
});

/** Electron を立ち上げず、Main の登録内容と各 invoke を検証できるようにする。 */
function createIpcMainStub() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    /** 登録されたハンドラーを保存し、呼び出しごとに既定の sender と指定イベントを合成する。 */
    handle(channel: string, handler: Handler) {
      handlers.set(channel, (event, ...args) =>
        handler(
          {
            sender: { session: {} },
            ...(event as object),
          },
          ...args,
        ),
      );
    },
    /** invoke の検証にイベント購読を使わないため、購読登録をそのまま受け付ける。 */
    on() {},
  };

  return { ipcMain: ipcMain as unknown as IpcMain, handlers };
}

/** 操作ごとの依存先を差し替え、指定しなかった呼び出しを文字列の履歴に残す。 */
function createDeps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const featureDeps = new Proxy(
    {
      /** 個別に指定されない限り、呼び出し元を認可済み Window として解決しない。 */
      resolveEventWindow: () => null,
      /** Home として扱う Window はケースごとに指定する。 */
      resolveHomeWindow: () => null,
      /** 既定の Window は Settings の認可を持たないものとする。 */
      isSettingsWindow: () => false,
      /** 既定の送信元に Preview の権限を付けない。 */
      isFilePreviewWindow: () => false,
      /** Preview の基点は個別のテストが指定した場合にだけ存在する。 */
      getFilePreviewWindowResource: () => null,
      /** Preview token を所有する Window は既定では存在しない。 */
      isFilePreviewTokenWindow: () => false,
      /** Mate の状態を、活性の有無を検証しないケース向けに固定する。 */
      getMateState: async () => "active",
      /** ログに届いたチャネルを保存し、失敗の記録先を確認できるようにする。 */
      logIpcError: (input: { channel: string }) =>
        calls.push(`log:${input.channel}`),
      ...overrides,
    },
    {
      /** ケースで指定した依存を優先し、それ以外は呼び出し履歴に残して空の結果を返す。 */
      get(target, prop: string) {
        if (prop in target) {
          return target[prop as keyof typeof target];
        }
        return async (...args: unknown[]) => {
          calls.push(`${prop}:${args.join(",")}`);
          return null;
        };
      },
    },
  );

  const deps = {
    common: featureDeps,
    window: featureDeps,
    catalog: featureDeps,
    settings: featureDeps,
    promptTemplates: featureDeps,
    sessionQuery: featureDeps,
    auxiliary: featureDeps,
    sessionRuntime: featureDeps,
    sessionInstructions: featureDeps,
    mate: featureDeps,
    character: featureDeps,
  };

  return { deps: deps as never, calls };
}

// @test-value v2
// kind = "contract"
// claim = "Settingsはpreload経由でMainの実行中versionを読み、他Windowは同じIPCを呼べない"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#layout; src-electron/ipc/settings.ts" }
// fault = "異なる値やchannelを使うかSettings以外へversion取得を許す"
// observable = "preload経由で返るversionと別Windowからの拒否"
// observation_boundary = "public-boundary"
// scope = "Settings app version IPC"
// lifecycle = "permanent"
// distinction = "型検査や表示testではpreloadからMain handlerまでの接続とsender境界を確認できない"
// @end-test-value
/** Settings の preload が Main の実行中バージョンを取得し、別 Window からは同じ入口を利用できないことを確認する。 */
test("app version IPC returns the Main value to Settings", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const settingsWindow = createWindowStub("file:///home.html?mode=settings");
  const otherWindow = createWindowStub("file:///home.html");
  let sender = settingsWindow;
  const { deps } = createDeps({
    /** 同じ preload の呼び出しで、送信元を Settings と通常の Home に切り替える。 */
    resolveEventWindow: () => sender,
    /** 指定した Window だけを Settings として認可する。 */
    isSettingsWindow: (window: unknown) => window === settingsWindow,
    /** Main が持つバージョンとして preview を含む値を返し、戻り値を照合する。 */
    getAppVersion: () => "7.0.1-preview.2",
  });
  registerMainIpcHandlers(ipcMain, deps);
  const api = createWithMateWindowApi({
    /** preload が選んだ実チャネルを、登録された Main ハンドラーへつなぐ。 */ invoke:
      (channel: string, ...args: unknown[]) =>
        handlers.get(channel)!({}, ...args),
  } as never);
  assert.equal(await api.getAppVersion(), "7.0.1-preview.2");
  sender = otherWindow;
  await assert.rejects(() => api.getAppVersion(), /Settings window/);
});

// @test-value v2
// kind = "contract"
// claim = "MainとAuxiliaryのsteer IPCは対象の親Session Windowだけから同turn入力を受け付ける"
// oracle = { type = "contract", ref = "Issue #780 explicit steer ownership" }
// fault = "別Windowから同turn入力を送信できるか、turn IDがIPCで失われる"
// observable = "steer dependencyに渡るID/payloadと別Window要求のreject"
// observation_boundary = "public-boundary"
// scope = "steer IPC sender ownership"
// lifecycle = "permanent"
// impact = "他会話やpreviewから実行中の作業を変更できる"
// distinction = "runtimeとadapter単体testはElectron senderを認可しない"
// @end-test-value
/** 実行中 turn への追加入力は親 Window からだけ受け付け、Main と Auxiliary の対象 ID と turn 指定を維持することを確かめる。 */
test("steer IPCはMainとAuxiliaryのowner Windowを検証する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const owner = createWindowStub("file:///session.html?sessionId=session-1");
  const other = createWindowStub("file:///session.html?sessionId=other");
  let sender = owner;
  const sent: unknown[] = [];
  const request = { expectedTurnId: "turn-one", userMessage: "additional" };
  const { deps } = createDeps({
    /** 許可された親と無関係な Window の間で IPC の送信元を切り替える。 */
    resolveEventWindow: () => sender,
    /** 追加入力を所有する Main の ID にだけ Window を割り当てる。 */
    resolveSessionWindow: (id: string) => (id === "session-1" ? owner : null),
    /** 追加入力の認可に必要な Auxiliary の親 ID を提供する。 */
    getAuxiliarySession: async () => ({
      id: "aux-1",
      parentSessionId: "session-1",
    }),
    /** Main に対して配送された対象と追加入力を記録し、同じ実行中 turn の結果を返す。 */
    steerSessionTurn: async (id: string, payload: unknown) => {
      sent.push([id, payload]);
      return { turnId: "turn-one" };
    },
    /** Auxiliary の対象を親 ID と取り違えていないか検証するため、届いた対象と入力を記録する。 */
    steerAuxiliarySessionTurn: async (id: string, payload: unknown) => {
      sent.push([id, payload]);
      return { turnId: "turn-one" };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const main = handlers.get(WITHMATE_STEER_SESSION_TURN_CHANNEL)!;
  const auxiliary = handlers.get(
    WITHMATE_STEER_AUXILIARY_SESSION_TURN_CHANNEL,
  )!;
  assert.deepEqual(await main({}, "session-1", request), {
    turnId: "turn-one",
  });
  assert.deepEqual(await auxiliary({}, "aux-1", request), {
    turnId: "turn-one",
  });
  assert.deepEqual(sent, [
    ["session-1", request],
    ["aux-1", request],
  ]);
  sender = other;
  await assert.rejects(
    async () => main({}, "session-1", request),
    /Session window/,
  );
  await assert.rejects(
    async () => auxiliary({}, "aux-1", request),
    /Session window/,
  );
  assert.equal(sent.length, 2);
});

// @test-value v2
// kind = "contract"
// claim = "質問回答IPCはMainまたはAuxiliaryのowner Windowだけを許し、回答配送の成否をrendererへ返す"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md GUI Turn Queue" }
// fault = "別Windowから回答できるか、非同期配送の受付前にIPCが成功して送信失敗を隠す"
// observable = "許可されたresolver呼出、配送保留中のIPC未完了、失敗時のrejectと別Window拒否"
// observation_boundary = "public-boundary"
// scope = "question answer IPC ownership and acknowledgment"
// lifecycle = "permanent"
// impact = "別会話への入力混入または未送信回答の喪失"
// distinction = "serviceの単体testはElectronのsender認可とinvoke応答伝播を通らない"
// @end-test-value
/** 質問回答を所有 Window に限定し、配送が失敗するまで応答が成功扱いにならないことを確かめる。 */
test("質問回答IPCはownerを検証し配送の受付結果を待つ", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const owner = createWindowStub("file:///session.html?sessionId=session-1");
  const other = createWindowStub("file:///session.html?sessionId=other");
  let sender = owner;
  let rejectDelivery!: (error: Error) => void;
  let calls = 0;
  let settled = false;
  const { deps } = createDeps({
    /** 質問に回答する送信元を所有 Window と対象外 Window から選べるようにする。 */
    resolveEventWindow: () => sender,
    /** 既知の親 Session にだけ回答を所有する Window を割り当てる。 */
    resolveSessionWindow: (id: string) => (id === "session-1" ? owner : null),
    /** 回答対象の Auxiliary を同じ Main の所有として解決する。 */
    getAuxiliarySessionStatus: async (id: string) =>
      id === "aux-1" ? { parentSessionId: "session-1" } : null,
    /** 配送の呼び出しを数え、IPC が保留中であることを観測してから明示的に失敗させる。 */
    resolveLiveElicitation: async () => {
      calls += 1;
      await new Promise<void>((_resolve, reject) => {
        rejectDelivery = reject;
      });
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const handler = handlers.get(WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL)!;
  for (const sessionId of ["session-1", "aux-1"]) {
    settled = false;
    const pending = Promise.resolve(
      handler({}, sessionId, "question", {
        action: "accept",
        content: { q: "yes" },
      }),
    );
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejection = assert.rejects(pending, /delivery failed/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    rejectDelivery(new Error("delivery failed"));
    await rejection;
  }
  assert.equal(calls, 2);
  sender = other;
  await assert.rejects(
    async () => handler({}, "aux-1", "question", { action: "accept" }),
    /Session window/,
  );
  assert.equal(calls, 2);
});

/** URL から Window の役割や Session ID を識別する IPC 向けに、最小の WebContents を用意する。 */
function createWindowStub(url: string) {
  return {
    webContents: {
      /** 明示的な破棄を扱うケース以外では、生存している WebContents として扱う。 */
      isDestroyed: () => false,
      /** 認可処理が参照する Window の URL をそのまま返す。 */
      getURL: () => url,
    },
  };
}

/** 認可と更新に使う Auxiliary の共通フィールドを提供し、ケース固有の状態だけを上書きできるようにする。 */
function createAuxiliarySessionStub(overrides: Record<string, unknown> = {}) {
  return {
    id: "aux-1",
    parentSessionId: "session-1",
    runState: "idle",
    title: "Auxiliary",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5",
    reasoningEffort: "medium",
    approvalMode: "never",
    codexSandboxMode: "workspace-write",
    customAgentName: "",
    threadId: "thread-1",
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    ...overrides,
  };
}

// @test-value v2
// kind = "security"
// claim = "Files Pinの列挙・追加・解除はMain/Auxの親Session Windowだけを認可し他Windowや無効Sessionにはserviceを呼ばない"
// oracle = { type = "contract", ref = "docs/design/database-schema.md: Files Pin" }
// fault = "他SessionやHome・Preview WindowからPinを変更できるかAuxの親Session Windowが拒否される"
// observable = "各IPCの戻り値・拒否Errorとserviceへ届いたrequest集合"
// observation_boundary = "public-boundary"
// scope = "File Pin IPC sender authority"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "別Sessionから保存目印を変更する権限逸脱とAuxの主要機能不成立を防ぐ"
// distinction = "serviceのfilesystem認可testでは保証しないElectron sender Window境界を直接検証する"
// @end-test-value
/** Files Pin の一覧・追加・解除を所有 Window に限定し、対象外の Window と存在しない Session を依存呼び出し前に拒否することを確かめる。 */
test("Files Pin IPC はMain/Auxの親Windowだけから利用できる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const owner = createWindowStub("file:///session.html?sessionId=session-1");
  const others = [
    createWindowStub("file:///session.html?sessionId=other"),
    createWindowStub("file:///home.html"),
    createWindowStub("file:///file-preview.html"),
  ];
  let sender = owner;
  const requests: unknown[] = [];
  const { deps } = createDeps({
    /** 同じ Pin 操作を所有 Window と複数の対象外 Window から試せるようにする。 */
    resolveEventWindow: () => sender,
    /** Pin を所有する Main の Window だけを返す。 */
    resolveSessionWindow: (id: string) => (id === "session-1" ? owner : null),
    /** 既知の Main と Auxiliary だけを同じ Files 所有者へ結びつける。 */
    getSessionFileExplorerOwnerSessionId: async (id: string) =>
      ["session-1", "aux-1"].includes(id) ? "session-1" : null,
    /** 一覧取得に渡った Session ID を記録し、保存済み Pin のない状態を返す。 */
    listSessionFilePins: async (id: string) => {
      requests.push(id);
      return [];
    },
    /** 追加依頼の Session とパス情報を記録し、依存先が返した値の伝播を確認できるようにする。 */
    pinSessionFile: async (request: unknown) => {
      requests.push(request);
      return "pinned";
    },
    /** 解除先を記録し、削除済みの追加ルートの指定が失われていないか調べる。 */
    unpinSessionFile: async (request: unknown) => {
      requests.push(request);
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const list = handlers.get(WITHMATE_LIST_SESSION_FILE_PINS_CHANNEL)!;
  const pin = handlers.get(WITHMATE_PIN_SESSION_FILE_CHANNEL)!;
  const unpin = handlers.get(WITHMATE_UNPIN_SESSION_FILE_CHANNEL)!;
  const event = {};
  for (const id of ["session-1", "aux-1"]) {
    const pinRequest = {
      sessionId: id,
      rootId: "workspace",
      relativePath: "file.txt",
    };
    const unpinRequest = {
      sessionId: id,
      rootKind: "additional",
      rootPath: "C:/removed",
      relativePath: "file.txt",
    };
    assert.deepEqual(await list(event, id), []);
    assert.equal(await pin(event, pinRequest), "pinned");
    await unpin(event, unpinRequest);
    assert.deepEqual(requests.splice(0), [id, pinRequest, unpinRequest]);
    for (const other of others) {
      sender = other;
      await assert.rejects(
        async () => list(event, id),
        /owning Session window/,
      );
      await assert.rejects(
        async () => pin(event, pinRequest),
        /owning Session window/,
      );
      await assert.rejects(
        async () => unpin(event, unpinRequest),
        /owning Session window/,
      );
      assert.deepEqual(requests, []);
    }
    sender = owner;
  }
  await assert.rejects(
    async () => list(event, "missing"),
    /owning Session window/,
  );
  await assert.rejects(
    async () => pin(event, { sessionId: "missing" }),
    /owning Session window/,
  );
  await assert.rejects(
    async () => unpin(event, { sessionId: "missing" }),
    /owning Session window/,
  );
  assert.deepEqual(requests, []);
});

/** Session 起動依頼の共通項目を埋め、検証対象となる workspace だけを差し替える。 */
function createSessionRequest(workspace: Record<string, unknown>) {
  return {
    taskTitle: "Task",
    characterId: "character-1",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: { main: "#111111", sub: "#222222" },
    workspace,
  };
}

// @test-value v2
// kind = "contract"
// claim = "Main IPC registrationは代表的な現行公開channel（History Compareを含む）を登録し、列挙した廃止channelを登録しない"
// oracle = { type = "contract", ref = "withmate-ipc-channels public surface" }
// fault = "列挙した現行channelにMain handlerがないか、廃止済みchannelが再び呼び出し可能になる"
// observable = "registerMainIpcHandlers後のhandler mapにある代表channelとremoved channelの不在"
// observation_boundary = "public-boundary"
// scope = "Main IPC public channel registration"
// lifecycle = "permanent"
// impact = "rendererからHistory Compareを含む現行機能へ到達でき、廃止済み操作をIPC経由で再実行できない"
// distinction = "file tree context menuとHistory Compareを含む代表的な公開channel、およびremoved channel不在を検証する"
// @end-test-value
/** History Compare などの現行公開チャネルの登録と、列挙した廃止チャネルの不在を登録結果から確かめる。 */
test("registerMainIpcHandlers は保持する public IPC だけを登録する", () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const { deps } = createDeps();

  registerMainIpcHandlers(ipcMain, deps);

  assert.ok(handlers.has(WITHMATE_OPEN_SESSION_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_SESSION_WINDOW_RESTORE_SET_CHANNEL));
  assert.ok(handlers.has(WITHMATE_RESTORE_SESSION_WINDOWS_CHANNEL));
  assert.ok(handlers.has(WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL));
  assert.ok(handlers.has(WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL));
  assert.ok(handlers.has(WITHMATE_VALIDATE_WORKSPACE_DIRECTORY_CHANNEL));
  assert.ok(handlers.has(WITHMATE_LIST_SESSION_SUMMARY_PAGE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_LIST_SESSION_CHARACTER_USAGE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_COPY_SESSION_FILE_PREVIEW_IMAGE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_COPY_SESSION_FILE_OBJECT_CHANNEL));
  assert.ok(
    handlers.has(WITHMATE_SHOW_SESSION_FILE_OBJECT_COPY_CONTEXT_MENU_CHANNEL),
  );
  assert.ok(handlers.has(WITHMATE_SHOW_SESSION_FILE_TREE_CONTEXT_MENU_CHANNEL));
  assert.ok(
    handlers.has(WITHMATE_SHOW_SESSION_FILE_PREVIEW_IMAGE_CONTEXT_MENU_CHANNEL),
  );
  assert.ok(handlers.has(WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL));
  assert.ok(handlers.has(WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL));
  assert.ok(handlers.has(WITHMATE_LIST_FILE_ROOT_CHANGES_REPOSITORIES_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL));
  assert.ok(
    handlers.has(WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_REPOSITORIES_CHANNEL),
  );
  assert.ok(handlers.has(WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_COMMITS_CHANNEL));
  assert.ok(
    handlers.has(WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMMIT_DETAIL_CHANNEL),
  );
  assert.ok(
    handlers.has(WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMPARISON_CHANNEL),
  );
  assert.ok(handlers.has(WITHMATE_GET_FILE_ROOT_GIT_HISTORY_DIFF_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_APP_SETTINGS_CHANNEL));
  assert.ok(handlers.has(WITHMATE_LIST_PROMPT_TEMPLATES_CHANNEL));
  assert.ok(handlers.has(WITHMATE_CREATE_PROMPT_TEMPLATE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_UPDATE_PROMPT_TEMPLATE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_DELETE_PROMPT_TEMPLATE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_MATE_STATE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_CREATE_MATE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_LIST_CHARACTERS_CHANNEL));
  assert.ok(handlers.has(WITHMATE_GET_CHARACTER_CHANNEL));
  assert.ok(handlers.has(WITHMATE_CREATE_CHARACTER_CHANNEL));
  assert.equal(handlers.has("withmate:set-default-character"), false);
  assert.ok(handlers.has(WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL));
  assert.ok(handlers.has(WITHMATE_CREATE_SESSION_CHANNEL));
  assert.ok(handlers.has(WITHMATE_DELETE_SESSION_CHANNEL));
  assert.ok(handlers.has(WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL));
  assert.ok(handlers.has(WITHMATE_RUN_SESSION_TURN_CHANNEL));

  const removedChannels = [
    "withmate:open-memory-management-window",
    "withmate:open-mate-talk-window",
    "withmate:get-memory-management-snapshot",
    "withmate:get-memory-management-page",
    "withmate:get-mate-growth-settings",
    "withmate:update-mate-growth-settings",
    "withmate:get-mate-embedding-settings",
    "withmate:list-provider-instruction-targets",
    "withmate:upsert-provider-instruction-target",
    "withmate:apply-mate-growth",
    "withmate:list-mate-growth-events",
    "withmate:correct-mate-growth-event",
    "withmate:disable-mate-growth-event",
    "withmate:forget-mate-growth-event",
    "withmate:start-mate-embedding-download",
    "withmate:delete-session-memory",
    "withmate:delete-project-memory-entry",
    "withmate:forget-mate-profile-item",
    "withmate:run-mate-talk-turn",
  ];

  for (const channel of removedChannels) {
    assert.equal(
      handlers.has(channel),
      false,
      `${channel} should not be registered`,
    );
  }
});

/** 保存された Window の一覧取得と一括復元を Home から呼び出せること、および対象外の Window が復元へ進めないことを確認する。 */
test("Session Window restore IPC はHomeだけからsnapshot取得と一括復元を実行できる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  const sessionWindow = createWindowStub(
    "http://localhost:5173/?mode=session&sessionId=session-1",
  );
  let eventWindow = homeWindow;
  const calls: string[] = [];
  const { deps } = createDeps({
    /** 同じ復元用チャネルで送信元だけを Home から対象外の Window へ切り替える。 */
    resolveEventWindow: () => eventWindow,
    /** 復元の認可で比較される Home Window を返す。 */
    resolveHomeWindow: () => homeWindow,
    /** Home が取得した保存対象一覧と、一覧取得の依存先まで処理が届いたことを観測する。 */
    getSessionWindowRestoreSet: async () => {
      calls.push("get");
      return ["session-1"];
    },
    /** 一括復元の呼び出しを記録し、復元結果をそのまま返す。 */
    restoreSessionWindows: async () => {
      calls.push("restore");
      return {
        requestedSessionIds: ["session-1"],
        openedSessionIds: ["session-1"],
        failures: [],
      };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(WITHMATE_GET_SESSION_WINDOW_RESTORE_SET_CHANNEL)?.({}),
    ["session-1"],
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_RESTORE_SESSION_WINDOWS_CHANNEL)?.({}),
    {
      requestedSessionIds: ["session-1"],
      openedSessionIds: ["session-1"],
      failures: [],
    },
  );

  eventWindow = sessionWindow;
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_RESTORE_SESSION_WINDOWS_CHANNEL)?.(
        {},
      ) as Promise<unknown>,
    /only available from the Home window/,
  );
  assert.deepEqual(calls, ["get", "restore"]);
});

// @test-value v2
// kind = "contract"
// claim = "Session MonitorのAuxiliary選択は存在確認と親ID一致を経て、対象IDをWindow navigationへ保持する"
// oracle = { type = "contract", ref = "issue-722 exact Auxiliary navigation" }
// fault = "存在しないAuxiliaryや別親のAuxiliaryを黙ってMainへfallbackし、誤った会話を開く"
// observable = "openSessionWindowへ渡されたparentとAuxiliary ID、および不正選択時の拒否"
// observation_boundary = "public-boundary"
// scope = "Main IPC Session Monitor Auxiliary navigation"
// lifecycle = "permanent"
// impact = "展開一覧から選択した会話だけを再開し、対象消失や親不一致を利用者へ返す"
// distinction = "renderer callbackの引数変換ではなく、Mainの永続化照会と親子認可を検証する"
// @end-test-value
/** Session Monitor の選択を実際の Auxiliary ID 付きで Window に渡し、存在しないか親が異なる対象を開かないことを確認する。 */
test("Session MonitorのAuxiliary navigationは対象と親を検証してWindowへ渡す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const calls: unknown[] = [];
  const { deps } = createDeps({
    /** 指定した親に属する Auxiliary、別の親に属する Auxiliary、存在しない対象を区別して返す。 */
    getAuxiliarySession: async (auxiliarySessionId: string) => {
      if (auxiliarySessionId === "aux-main") {
        return createAuxiliarySessionStub({
          id: "aux-main",
          parentSessionId: "session-1",
        });
      }
      if (auxiliarySessionId === "aux-other") {
        return createAuxiliarySessionStub({
          id: "aux-other",
          parentSessionId: "session-2",
        });
      }
      return null;
    },
    /** Window を開くときに、親と選択された Auxiliary の両 ID が渡ったかを記録する。 */
    openSessionWindow: async (
      sessionId: string,
      auxiliarySessionId?: string,
    ) => {
      calls.push({ kind: "session", sessionId, auxiliarySessionId });
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await handlers.get(WITHMATE_OPEN_SESSION_CHANNEL)?.(
    {},
    "session-1",
    "aux-main",
  );
  assert.deepEqual(calls, [
    { kind: "session", sessionId: "session-1", auxiliarySessionId: "aux-main" },
  ]);

  await assert.rejects(
    () =>
      handlers.get(WITHMATE_OPEN_SESSION_CHANNEL)?.(
        {},
        "session-1",
        "missing",
      ) as Promise<unknown>,
    /The target Auxiliary Session could not be found/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_OPEN_SESSION_CHANNEL)?.(
        {},
        "session-1",
        "aux-other",
      ) as Promise<unknown>,
    /The Auxiliary Session parent does not match/,
  );
  assert.equal(calls.length, 1);
});

// @test-value v2
// kind = "contract"
// claim = "Monitor page IPCは既定100親とcursor/limitを正規化し、範囲外の要求をqueryへ渡さない"
// oracle = { type = "contract", ref = "GitHub Issue #876 Monitor専用queryの100親上限" }
// fault = "上限超過や不正cursorを許可するか、正規化前のrequestをMain queryへ渡す"
// observable = "query依存へ渡ったrequest、IPC結果、無効要求のrejectと依存呼出数"
// observation_boundary = "public-boundary"
// scope = "Session Monitor page IPC validation"
// lifecycle = "permanent"
// impact = "rendererからの無制限readとMonitor pagingの取り違えを防ぐ"
// distinction = "型checkやMain query単体testでは登録済みIPCのparse結線を保証できない"
// @end-test-value
/** Monitor の一覧要求を既定 100 件に正規化し、範囲外のページ指定を検索依存先へ送らないことを確認する。 */
test("Monitor page IPCは100親上限で検証し正規化requestを渡す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const requests: unknown[] = [];
  const result = {
    entries: [],
    auxiliarySessions: [],
    nextCursor: null,
    hasMore: false,
  };
  const { deps } = createDeps({
    /** 正規化されたページ要求を記録し、一覧の戻り値がそのまま届くか調べる。 */
    listSessionMonitorPage: (request: unknown) => {
      requests.push(request);
      return result;
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const handler = handlers.get("withmate:list-session-monitor-page");
  assert.ok(handler);
  assert.deepEqual(await handler({}), result);
  assert.deepEqual(
    await handler({}, { cursor: " parent-1 ", limit: 25 }),
    result,
  );
  assert.deepEqual(requests, [
    { cursor: null, limit: 100 },
    { cursor: "parent-1", limit: 25 },
  ]);
  for (const request of [{ limit: 101 }, { limit: 0 }, { cursor: 1 }, []]) {
    await assert.rejects(
      async () => handler({}, request),
      /Invalid open Session Window ID page request/,
    );
  }
  assert.equal(requests.length, 2);
});

/** 一覧ページの絞り込み付き要求と Character 利用状況の取得を、別々の依存先に渡すことを確認する。 */
test("Session summary IPC は bounded requestをparseしてpage / Character usageへ委譲する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const pageRequests: unknown[] = [];
  const { deps } = createDeps({
    /** 一覧検索に渡るページ指定とフィルターを記録し、空ページを返す。 */
    listSessionSummaryPage: (request: unknown) => {
      pageRequests.push(request);
      return { entries: [], nextCursor: null, hasMore: false };
    },
    /** 一覧検索とは異なる Character 利用状況を返し、専用チャネルから取得できるようにする。 */
    listSessionCharacterUsage: () => [
      { characterId: "char-1", sessionKind: "default" },
    ],
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_SESSION_SUMMARY_PAGE_CHANNEL)?.(
      {},
      {
        scope: "recent",
        limit: 50,
        searchText: "  Task ",
      },
    ),
    { entries: [], nextCursor: null, hasMore: false },
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_SESSION_CHARACTER_USAGE_CHANNEL)?.({}),
    [{ characterId: "char-1", sessionKind: "default" }],
  );
  assert.deepEqual(pageRequests, [
    {
      scope: "recent",
      cursor: null,
      limit: 50,
      searchText: "task",
      sessionIds: undefined,
    },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "Main/Auxiliary共用のパス入力は所有Session Windowからpreloadと登録済みIPCを通じて実在directoryを選択し、fileとWindowsのdrive未指定rooted pathは拒否する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Add Directory By Path; docs/design/electron-window-runtime.md: MainIpcRegistration" }
// fault = "Sessionのパス入力をHome専用IPCへ接続する、親Session IDを失う、filesystem検証を迂回する、またはdrive未指定入力を許可する"
// observable = "選択Promiseのdirectory pathとfile・Windows rooted入力のreject message"
// observation_boundary = "consumer"
// scope = "共用path adapterから本番preload・登録handler・filesystem validatorまで"
// lifecycle = "permanent"
// impact = "パス入力追加の主要機能不成立、fileの登録、検証時とconsumer利用時で許可driveが変わる登録を防ぐ"
// distinction = "単体API mockと型検査では検出できないsender認可とIPC配線を、既存fileのread-only検証で低コストに確認する"
// @end-test-value
/** 共用のパス入力が preload と登録済み Main IPC を通り、実在するディレクトリを採用してファイルやドライブ未指定の Windows 入力を拒否することを確かめる。 */
test("Additional Directoryのパス入力はSessionから実preloadと登録IPCで検証できる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const owner = createWindowStub("file:///session.html?sessionId=session-1");
  const service = new WorkspaceDirectoryValidationService();
  const { deps } = createDeps({
    /** 追加 Directory を選ぶ呼び出しは対象 Session の所有 Window から来たものとする。 */
    resolveEventWindow: () => owner,
    /** 追加 Directory の入力を担当する既知の Session にだけ Window を割り当てる。 */
    resolveSessionWindow: (id: string) => (id === "session-1" ? owner : null),
    /** テスト内の実ディレクトリと実ファイルを本番のディレクトリ検証に渡す。 */
    validateWorkspaceDirectory: (targetPath: unknown) =>
      service.validate(targetPath),
  });
  registerMainIpcHandlers(ipcMain, deps);
  const api = createWithMateWindowApi({
    /** preload の選んだチャネルが登録されていることを確認してから、その Main ハンドラーを起動する。 */
    async invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel);
      assert.ok(handler, `Unregistered IPC: ${channel}`);
      return handler({}, ...args);
    },
    /** イベントを配信しない invoke 用スタブとして、購読登録だけを受け付ける。 */
    on() {},
    /** イベントリスナーを保持しないため、解除要求を処理する必要はない。 */
    removeListener() {},
    /** invoke による検証だけを対象にし、片方向の送信には応答しない。 */
    send() {},
  } as never);
  const directoryPath = fileURLToPath(new URL("./", import.meta.url));
  assert.equal(
    await selectAdditionalDirectoryPath({
      sessionId: "session-1",
      directoryPath: `  ${directoryPath}  `,
      initialPath: null,
      api,
    }),
    directoryPath,
  );
  await assert.rejects(
    selectAdditionalDirectoryPath({
      sessionId: "session-1",
      directoryPath: fileURLToPath(import.meta.url),
      initialPath: null,
      api,
    }),
    { message: "Not a directory." },
  );
  if (process.platform === "win32") {
    const rootedPath = directoryPath.slice(2);
    assert.deepEqual(await service.validate(rootedPath), { valid: true });
    for (const input of [rootedPath, rootedPath.replaceAll("\\", "/")]) {
      await assert.rejects(
        selectAdditionalDirectoryPath({
          sessionId: "session-1",
          directoryPath: input,
          initialPath: null,
          api,
        }),
        { message: "Enter an absolute path." },
      );
    }
  }
});

// @test-value v2
// kind = "security"
// claim = "追加directoryの検証は対象Sessionの所有Windowだけを許可し、非所有Window・不正Session IDはfilesystem検証前に拒否する"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md: MainIpcRegistration" }
// fault = "Home・Settings・別Session・不明senderを許可する、他Session IDで検証できる、またはHome専用APIの権限を広げる"
// observable = "APIの返却値と拒否Error、validation serviceへ届いたpath集合"
// observation_boundary = "public-boundary"
// scope = "追加directory検証のpreloadから登録IPCのsender認可まで"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "他Windowから任意filesystem pathの存在・利用可能性を検証する権限逸脱を防ぐ"
// distinction = "filesystem判定の単体testや型検査では表せない実行時sender境界を既存IPC fixtureで確認する"
// @end-test-value
/** Additional Directory 専用 IPC の認可が所有 Window に限定され、Home 専用の汎用検証に影響しないことを確認する。 */
test("Additional Directory検証IPCは所有Sessionだけを認可しHome専用APIを緩和しない", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const owner = createWindowStub("file:///session.html?sessionId=session-1");
  const other = createWindowStub("file:///session.html?sessionId=session-2");
  const home = createWindowStub("file:///home.html");
  let sender: ReturnType<typeof createWindowStub> | null = owner;
  const validated: unknown[] = [];
  const { deps } = createDeps({
    /** 所有 Window、異なる Session の Window、Home などを切り替えるため、現在の送信元を返す。 */
    resolveEventWindow: () => sender,
    /** 二つの既知の Session ID を異なる所有 Window に解決し、その他の ID には Window を返さない。 */
    resolveSessionWindow: (id: string) =>
      id === "session-1" ? owner : id === "session-2" ? other : null,
    /** 汎用パス検証で参照する Home Window を、Session の Window とは別に指定する。 */
    resolveHomeWindow: () => home,
    /** 認可された要求だけが実際の検証段階に届いたか判断するため、渡ったパスを記録する。 */
    validateWorkspaceDirectory: async (targetPath: unknown) => {
      validated.push(targetPath);
      return { valid: true };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const ipcRenderer = {
    /** preload 経由と直接 IPC の両方で同じ登録済み処理に到達できるよう、チャネルを解決する。 */
    async invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel);
      assert.ok(handler, `Unregistered IPC: ${channel}`);
      return handler({}, ...args);
    },
    /** 認可の検証ではイベント通知を使わないため、リスナー登録を受け付けるだけにする。 */
    on() {},
    /** 登録を保持していないので、リスナーの解除は副作用なく受け付ける。 */
    removeListener() {},
    /** 片方向の送信はこのケースの認可経路に含めない。 */
    send() {},
  };
  const api = createWithMateWindowApi(ipcRenderer as never);
  const directoryPath = fileURLToPath(new URL("./", import.meta.url));
  assert.deepEqual(
    await api.validateSessionAdditionalDirectory("session-1", directoryPath),
    { valid: true },
  );
  await assert.rejects(
    api.validateWorkspaceDirectory("/outside/private"),
    /only available from the Home window/,
  );
  for (const sessionId of ["session-2", "unknown"]) {
    await assert.rejects(
      api.validateSessionAdditionalDirectory(sessionId, "/outside/private"),
      /only available from the target Session window/,
    );
  }
  for (const sessionId of [null, undefined, 1, ""]) {
    await assert.rejects(
      ipcRenderer.invoke(
        WITHMATE_VALIDATE_SESSION_ADDITIONAL_DIRECTORY_CHANNEL,
        sessionId,
        "/outside/private",
      ),
      /Session ID is invalid/,
    );
  }
  for (const unauthorized of [
    home,
    other,
    createWindowStub("file:///settings.html"),
    null,
  ]) {
    sender = unauthorized;
    await assert.rejects(
      api.validateSessionAdditionalDirectory("session-1", "/outside/private"),
      /only available from the target Session window/,
    );
  }
  assert.deepEqual(validated, [directoryPath]);
});

// @test-value v2
// kind = "contract"
// claim = "WindowsのAdditional Directory入力はdrive未指定rooted pathをfilesystem検証前に拒否し、drive付き・UNC入力は既存validatorへ渡す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Add Directory By Path" }
// fault = "rooted pathを許可directoryとして登録する、またはdrive付き・UNCの完全修飾pathまで拒否する"
// observable = "登録IPCのvalidation結果とfilesystem validatorが受け取ったpath集合"
// observation_boundary = "public-boundary"
// scope = "WindowsのAdditional Directory検証IPCのpath形式境界。実在性判定は既存validatorに委譲する"
// lifecycle = "permanent"
// impact = "検証時とconsumer利用時で許可driveが変わる登録と、通常の完全修飾入力の利用不能を防ぐ"
// distinction = "型やbuildでは検出できないWindows pathの形式とvalidator委譲を、network share接続なしの軽量fixtureで継続確認する"
// @end-test-value
/** Windows でドライブ未指定の rooted path を検証前に拒否し、ドライブ付き絶対パスと UNC を検証へ渡すことを確かめる。 */
test(
  "WindowsのAdditional Directory入力はdrive付きとUNCだけをfilesystem検証へ渡す",
  { skip: process.platform !== "win32" },
  async () => {
    const { ipcMain, handlers } = createIpcMainStub();
    const owner = createWindowStub("file:///session.html?sessionId=session-1");
    const validated: unknown[] = [];
    const { deps } = createDeps({
      /** パス形式の違いだけを比較するため、送信元を所有 Window に固定する。 */
      resolveEventWindow: () => owner,
      /** 対象 Session の Window が送信元と一致するようにする。 */
      resolveSessionWindow: () => owner,
      /** ファイルシステム検証まで届いた入力の一覧を記録し、パスの形による前段での拒否を判定できるようにする。 */
      validateWorkspaceDirectory: async (targetPath: unknown) => {
        validated.push(targetPath);
        return { valid: true };
      },
    });
    registerMainIpcHandlers(ipcMain, deps);
    const handler = handlers.get(
      WITHMATE_VALIDATE_SESSION_ADDITIONAL_DIRECTORY_CHANNEL,
    );
    assert.ok(handler);
    for (const targetPath of [
      "\\Windows",
      "/Windows",
      "\\",
      "/",
      "\\\\server",
    ]) {
      assert.deepEqual(await handler({}, "session-1", targetPath), {
        valid: false,
        reason: "not-absolute",
      });
    }
    assert.deepEqual(validated, []);
    const qualifiedPaths = [
      "C:\\作業\\shared folder",
      "D:/shared",
      "\\\\server\\share",
      "//server/share/folder",
    ];
    for (const targetPath of qualifiedPaths) {
      assert.deepEqual(await handler({}, "session-1", targetPath), {
        valid: true,
      });
    }
    assert.deepEqual(validated, qualifiedPaths);
  },
);

/** 汎用の作業ディレクトリ検証は Home 専用であり、対象外 Window のパスが検証先へ渡らないことを確かめる。 */
test("workspace validation IPC は Home window だけから validation service を呼べる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  const otherWindow = createWindowStub("http://localhost:5173/?mode=settings");
  let eventWindow = homeWindow;
  const validatedPaths: unknown[] = [];
  const { deps } = createDeps({
    /** Home と対象外 Window の切替を IPC event の解決に反映する。 */
    resolveEventWindow: () => eventWindow,
    /** 汎用の workspace 検証を使える Home Window を返す。 */
    resolveHomeWindow: () => homeWindow,
    /** 認可を通ったパスだけを記録し、パスの実在には依存しない成功を返す。 */
    validateWorkspaceDirectory: async (targetPath: unknown) => {
      validatedPaths.push(targetPath);
      return { valid: true };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const handler = handlers.get(WITHMATE_VALIDATE_WORKSPACE_DIRECTORY_CHANNEL);

  assert.deepEqual(await handler?.({}, "C:\\workspace"), { valid: true });
  eventWindow = otherWindow;
  await assert.rejects(
    () => handler?.({}, "C:\\private") as Promise<unknown>,
    /only available from the Home window/,
  );
  assert.deepEqual(validatedPaths, ["C:\\workspace"]);
});

/** 対象 Session の Window だけが、保存済み workspace をパス引数なしで検証できることを確かめる。 */
test("Session workspace validation IPC は対象 Session window の保存済み path だけを検証する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const sessionWindow = createWindowStub(
    "http://localhost:5173/?mode=session&sessionId=session-1",
  );
  const otherWindow = createWindowStub(
    "http://localhost:5173/?mode=session&sessionId=session-2",
  );
  let eventWindow = sessionWindow;
  const resolvedSessionIds: string[] = [];
  const validatedPaths: unknown[] = [];
  const { deps } = createDeps({
    /** 保存済み workspace を要求した Window を切り替えて認可結果を比べる。 */
    resolveEventWindow: () => eventWindow,
    /** 異なる Session の Window と対象の所有 Window を区別する。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? sessionWindow : otherWindow,
    /** 保存先を取得した Session ID を記録し、テスト対象にだけ保存済み workspace を返す。 */
    getSession: async (sessionId: string) => {
      resolvedSessionIds.push(sessionId);
      return sessionId === "session-1"
        ? { workspacePath: "C:\\session-workspace" }
        : null;
    },
    /** 検証まで届いた workspace が保存値だけだったかを確認できるようにする。 */
    validateWorkspaceDirectory: async (targetPath: unknown) => {
      validatedPaths.push(targetPath);
      return { valid: true };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const handler = handlers.get(WITHMATE_VALIDATE_SESSION_WORKSPACE_CHANNEL);

  assert.deepEqual(await handler?.({}, "session-1"), { valid: true });
  assert.deepEqual(resolvedSessionIds, ["session-1"]);
  assert.deepEqual(validatedPaths, ["C:\\session-workspace"]);

  eventWindow = otherWindow;
  await assert.rejects(
    () => handler?.({}, "session-1") as Promise<unknown>,
    /only available from the target Session window/,
  );
  assert.deepEqual(resolvedSessionIds, ["session-1"]);
  assert.deepEqual(validatedPaths, ["C:\\session-workspace"]);
});

// @test-value v2
// kind = "contract"
// claim = "SessionFolder作成IPCはfilesystem validationを要求せずHomeから作成できる"
// oracle = { type = "contract", ref = "src-electron/ipc/register-main-ipc.ts#create-session" }
// fault = "SessionFolder作成で不要なworkspace validationを行うか、Homeからの作成を拒否する"
// observable = "validation dependency未到達とcreateSession成功"
// observation_boundary = "public-boundary"
// scope = "Main IPC SessionFolder creation"
// lifecycle = "permanent"
// @end-test-value
/** SessionFolder を選んだ依頼は既存 workspace の検証をスキップし、Home から作成へ進むことを確認する。 */
test("SessionFolder 作成 IPC は filesystem validation を行わず Home から作成できる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  let validationCount = 0;
  let creationCount = 0;
  const { deps } = createDeps({
    /** SessionFolder の作成依頼が Home から送られたものとして解決する。 */
    resolveEventWindow: () => homeWindow,
    /** 作成を認可する Home Window と送信元を一致させる。 */
    resolveHomeWindow: () => homeWindow,
    /** 既存ディレクトリの検証が不要な経路で、もし呼ばれた場合は回数に残す。 */
    validateWorkspaceDirectory: async () => {
      validationCount += 1;
      return { valid: true };
    },
    /** SessionFolder の作成処理へ到達した回数を記録する。 */
    createSession: async () => {
      creationCount += 1;
      return {};
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  await handlers.get(WITHMATE_CREATE_SESSION_CHANNEL)?.(
    {},
    createSessionRequest({ kind: "session-folder" }),
  );
  assert.equal(validationCount, 0);
  assert.equal(creationCount, 1);
});

// @test-value v2
// kind = "contract"
// claim = "通常Session作成IPCはHomeからworkspace検証後に作成し、不正workspaceまたはHome以外からの要求を拒否する"
// oracle = { type = "contract", ref = "src-electron/ipc/register-main-ipc.ts#create-session" }
// fault = "通常Session作成の成功経路・workspace拒否・Home以外の認可境界が検出されず、拒否前に作成dependencyへ到達する"
// observable = "workspace validationの入力、createSession payload、validation失敗とHome以外の拒否、および拒否時のdependency未到達"
// observation_boundary = "public-boundary"
// scope = "Main IPC create session authorization and workspace validation"
// lifecycle = "permanent"
// @end-test-value
/** 通常 Session は Home から有効な workspace を指定した場合だけ作成し、検証失敗時と対象外 Window からは作成しないことを確かめる。 */
test("通常Session作成 IPC は workspace を検証し Home からだけ作成する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  const otherWindow = createWindowStub("http://localhost:5173/?mode=settings");
  let eventWindow: unknown = homeWindow;
  const validatedPaths: unknown[] = [];
  const createdInputs: unknown[] = [];
  let validationResult: { valid: boolean; reason?: string } = { valid: true };
  const { deps } = createDeps({
    /** 通常作成を要求する送信元を Home または対象外 Window へ切り替える。 */
    resolveEventWindow: () => eventWindow,
    /** 通常 Session を作成できる Home Window を返す。 */
    resolveHomeWindow: () => homeWindow,
    /** 作成前に受け取ったパスを記録し、同じパスの検証結果をケースごとに切り替える。 */
    validateWorkspaceDirectory: async (workspacePath: string) => {
      validatedPaths.push(workspacePath);
      return validationResult;
    },
    /** 通常 Session の作成まで到達した入力を記録し、無効な要求が混ざらないか確認する。 */
    createSession: async (input: unknown) => {
      createdInputs.push(input);
      return {};
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  const handler = handlers.get(WITHMATE_CREATE_SESSION_CHANNEL);
  const directoryRequest = createSessionRequest({
    kind: "directory",
    label: "Workspace",
    path: "C:\\workspace",
    branch: "main",
  });
  await handler?.({}, directoryRequest);
  assert.deepEqual(validatedPaths, ["C:\\workspace"]);
  assert.deepEqual(createdInputs, [directoryRequest]);

  validationResult = { valid: false, reason: "not-a-workspace" };
  await assert.rejects(
    () => handler?.({}, directoryRequest) as Promise<unknown>,
  );
  assert.equal(createdInputs.length, 1);

  eventWindow = otherWindow;
  validationResult = { valid: true };
  await assert.rejects(
    () => handler?.({}, directoryRequest) as Promise<unknown>,
    /only available from the Home window/,
  );
  assert.equal(createdInputs.length, 1);
  assert.equal(validatedPaths.length, 2);
});

/** プロンプトテンプレートの一覧・作成・更新・削除が、それぞれ専用の依存先へ必要な引数を渡すことを確認する。 */
test("prompt template IPC は CRUD payload を専用 dependency へ渡す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const received: unknown[] = [];
  const templates = [{ id: "template-1", name: "Review", prompt: "review it" }];
  const { deps } = createDeps({
    /** 一覧チャネルの結果と照合するため、既存テンプレートを返す。 */
    listPromptTemplates: () => templates,
    /** 作成に渡る名前と本文を記録し、呼び出し元へ返す一覧を指定する。 */
    createPromptTemplate: (input: unknown) => {
      received.push({ kind: "create", input });
      return templates;
    },
    /** 更新で対象 ID が保持されるか調べるため、更新依頼をそのまま記録する。 */
    updatePromptTemplate: (input: unknown) => {
      received.push({ kind: "update", input });
      return templates;
    },
    /** 削除対象の ID を記録し、削除後の空一覧を返す。 */
    deletePromptTemplate: (id: string) => {
      received.push({ kind: "delete", id });
      return [];
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_PROMPT_TEMPLATES_CHANNEL)?.({}),
    templates,
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_CREATE_PROMPT_TEMPLATE_CHANNEL)?.(
      {},
      { name: "Review", prompt: "review it" },
    ),
    templates,
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_UPDATE_PROMPT_TEMPLATE_CHANNEL)?.(
      {},
      { id: "template-1", name: "Review", prompt: "review it" },
    ),
    templates,
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_DELETE_PROMPT_TEMPLATE_CHANNEL)?.(
      {},
      "template-1",
    ),
    [],
  );
  assert.deepEqual(received, [
    { kind: "create", input: { name: "Review", prompt: "review it" } },
    {
      kind: "update",
      input: { id: "template-1", name: "Review", prompt: "review it" },
    },
    { kind: "delete", id: "template-1" },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "pick-image-file IPCはCharacter icon purposeをMain側へ伝播し、不正なpurposeを拒否する"
// oracle = { type = "contract", ref = "src-electron/ipc/window.ts#pick-image-file" }
// fault = "不正なimage picker purposeを受け入れるか、valid purposeをdialog serviceへ渡さない"
// observable = "pickImageFile dependency input and invalid-purpose rejection"
// observation_boundary = "public-boundary"
// scope = "main-ipc-image-picker-purpose"
// lifecycle = "permanent"
// impact = "Character icon選択の対象を誤るか、不正なIPC入力がnative dialogへ到達する"
// distinction = "valid purposeの伝播とinvalid purposeの拒否を同じIPC handlerで確認する"
// @end-test-value
/** Character アイコンの画像選択では用途が Main まで保持され、不明な用途が依存先へ届かないことを確認する。 */
test("pick-image-file IPC は Character icon purpose を伝播し、不正な purpose を拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const calls: Array<{ initialPath: string | null; purpose: string }> = [];
  const { deps } = createDeps({
    /** 画像ピッカーに渡った初期パスと用途だけを記録し、実際のダイアログを開かず選択結果を返す。 */
    pickImageFile: async (
      _targetWindow: unknown,
      initialPath: string | null,
      purpose: string,
    ) => {
      calls.push({ initialPath, purpose });
      return "C:/icons/a.png";
    },
  });

  registerMainIpcHandlers(ipcMain, deps);
  const handler = handlers.get(WITHMATE_PICK_IMAGE_FILE_CHANNEL);
  assert.ok(handler);

  assert.equal(
    await handler({}, "C:/icons/current.webp", "character-icon"),
    "C:/icons/a.png",
  );
  assert.deepEqual(calls, [
    {
      initialPath: "C:/icons/current.webp",
      purpose: "character-icon",
    },
  ]);
  assert.equal(await handler({}, null), "C:/icons/a.png");
  assert.deepEqual(calls[1], {
    initialPath: null,
    purpose: "general",
  });
  await assert.rejects(
    async () => handler({}, null, "unsupported-purpose"),
    /Invalid image picker purpose/,
  );
});

// @test-value v2
// kind = "invariant"
// claim = "chat layout IPC は現行targetの列挙値だけを専用のvoid更新処理へ渡す"
// oracle = { type = "contract", ref = "Chat layout preference IPC boundary" }
// fault = "不正な target/value または余分な payload が storage update へ到達する"
// observable = "専用更新処理へ渡されたupdatesとIPCのvoid応答"
// observation_boundary = "public-boundary"
// scope = "chat-layout-ipc"
// lifecycle = "permanent"
// impact = "廃止設定や不正値が main persistence に混入する"
// distinction = "IPC input validation と dependency forwarding を同時に確認する"
// @end-test-value
/** 表示設定の更新先を一件だけ受け付け、各対象で許される値だけを戻り値のない専用処理へ渡すことを確認する。 */
test("chat layout preference IPC は単一 target の列挙値だけを専用更新処理へ渡す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const updates: unknown[] = [];
  const { deps } = createDeps({
    /** 実際に受け付けた表示設定の更新を記録し、複数対象や不正な列挙値が届かないか検証する。 */
    updateChatLayoutPreference: (update: unknown) => {
      updates.push(update);
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL)?.(
      {},
      {
        target: "sidePane",
        value: "files",
      },
    ),
    undefined,
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL)?.(
      {},
      {
        target: "header",
        value: "visible",
      },
    ),
    undefined,
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL)?.(
      {},
      {
        target: "actionDock",
        value: "expanded",
      },
    ),
    undefined,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL)?.(
        {},
        {
          target: "unknown",
          value: "visible",
        },
      ) as Promise<unknown>,
    /Invalid chat layout preference update/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL)?.(
        {},
        {
          target: "header",
          value: "shown",
        },
      ) as Promise<unknown>,
    /Invalid chat layout preference update/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL)?.(
        {},
        {
          target: "actionDock",
          value: "expanded",
          sidePane: "context",
        },
      ) as Promise<unknown>,
    /Invalid chat layout preference update/,
  );
  assert.deepEqual(updates, [
    { target: "sidePane", value: "files" },
    { target: "header", value: "visible" },
    { target: "actionDock", value: "expanded" },
  ]);
});

// @test-value v2
// kind = "security"
// claim = "File Explorer IPCはowning Session senderを確認し、検証済みfile-root/history requestとhistory comparison requestだけをserviceへ渡す"
// oracle = { type = "contract", ref = "Session File Explorer IPC authority boundary" }
// fault = "無効なhistory branch/ref、または別Session senderのfile explorer/history requestがchanges・history serviceへ到達する"
// observable = "非owner・無効branch/ref requestのrejectionとserviceへ渡されたdirectory・history request"
// observation_boundary = "public-boundary"
// scope = "File Explorer IPC authority and request validation"
// lifecycle = "permanent"
// distinction = "Auxiliary IDをowning Sessionへ解決する成功経路と、別window・無効request・current preview resource外の拒否を同じIPC boundaryで確認する"
// @end-test-value
/** Files の一覧・ファイル操作・Git 履歴を親 Window の認可で処理し、外部 Preview は現在の対象だけに限定することを確認する。 */
test("File Explorer IPC は owning Session window からだけ利用でき、Auxiliary ID を parent へ解決する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub(
    "file:///session.html?sessionId=session-1",
  );
  const otherWindow = createWindowStub("file:///home.html");
  const previewWindow = createWindowStub(
    "file:///file-preview.html?token=preview-1",
  );
  const currentPreviewResource = {
    sessionId: "aux-1",
    absolutePath: "C:/outside/current.md",
  };
  let currentWindow = ownerWindow;
  const directoryRequests: unknown[] = [];
  const inspectRequests: unknown[] = [];
  const readRequests: unknown[] = [];
  const openRequests: unknown[] = [];
  const historyRepositoryRequests: unknown[] = [];
  const historyCommitRequests: unknown[] = [];
  const historyDetailRequests: unknown[] = [];
  const historyComparisonRequests: unknown[] = [];
  const historyDiffRequests: unknown[] = [];
  const changesRequests: unknown[] = [];
  const changesRepositoryRequests: unknown[] = [];
  const diffRequests: unknown[] = [];
  const previewNavigationRequests: unknown[] = [];
  const { deps } = createDeps({
    /** 同じ要求を親、Home、分離 Preview の送信元から比較できるようにする。 */
    resolveEventWindow: () => currentWindow,
    /** 既知の Main の場合だけ Files を所有する Window を返す。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? ownerWindow : null,
    /** Auxiliary の Files を親 Main の Window で認可するための所有者を返す。 */
    getSessionFileExplorerOwnerSessionId: async (sessionId: string) =>
      sessionId === "aux-1" ? "session-1" : null,
    /** 対象 Auxiliary と分離 Preview の対応を、その組合せに限って有効とする。 */
    isFilePreviewWindow: (window: unknown, sessionId: string) =>
      window === previewWindow && sessionId === "aux-1",
    /** 現在の Preview が参照する絶対パスを返し、他の Window・Session には基点を与えない。 */
    getFilePreviewWindowResource: (window: unknown, sessionId: string) =>
      window === previewWindow && sessionId === "aux-1"
        ? currentPreviewResource
        : null,
    /** 正しい Preview と発行済み token の組合せにだけ payload の取得を許す。 */
    isFilePreviewTokenWindow: (window: unknown, token: string) =>
      window === previewWindow && token === "preview-1",
    /** 開く要求が専用の Preview 経路まで届いたことを記録し、作成された Window の資源情報を返す。 */
    openSessionFilePreviewWindow: async (request: unknown) => {
      previewNavigationRequests.push(request);
      return {
        status: "opened",
        targetType: "preview-window",
        disposition: "created",
        resource: {
          sessionId: "aux-1",
          rootId: "workspace",
          relativePath: "src/app/SessionWindowApp.tsx",
        },
      };
    },
    /** 有効な token が取得した Preview の表示用情報として、資源と親 Session を返す。 */
    getSessionFilePreviewWindowPayload: () => ({
      resource: currentPreviewResource,
      ownerSessionId: "session-1",
      displayPath: "C:/workspace/file",
      windowTitle: "current.md",
    }),
    /** 認可された対象の一覧に、workspace ルートだけがある状態を返す。 */
    listSessionFileRoots: async () => [
      {
        id: "workspace",
        kind: "workspace",
        label: "Workspace",
        displayPath: "C:/repo",
      },
    ],
    /** ディレクトリ一覧に届いたルートと相対パスを記録し、実ファイルにはアクセスしない。 */
    listSessionDirectory: async (request: unknown) => {
      directoryRequests.push(request);
      return [];
    },
    /** 合成 Preview 資源の検査要求を記録し、対象制限を通った分だけを数える。 */
    inspectSessionFile: async (request: unknown) => {
      inspectRequests.push(request);
      return null;
    },
    /** 汎用のファイル読み取りに届いたチャンク要求を記録し、不要なファイルアクセスはしない。 */
    readSessionFileChunk: async (request: unknown) => {
      readRequests.push(request);
      return null;
    },
    /** OS で開く対象の要求を記録し、実際には起動せず成功形式を返す。 */
    openSessionFile: async (request: unknown) => {
      openRequests.push(request);
      return {
        status: "opened",
        targetType: "local-path",
        target: "C:/repo/src/App.tsx",
      };
    },
    /** 現在の変更一覧の要求を記録し、表示すべき変更がない状態を返す。 */
    listFileRootChanges: async (request: unknown) => {
      changesRequests.push(request);
      return { status: "ok", entries: [] };
    },
    /** 変更一覧で使うリポジトリ取得要求を記録し、既知の workspace ルートを返す。 */
    listFileRootChangesRepositories: async (request: unknown) => {
      changesRepositoryRequests.push(request);
      return {
        status: "ok",
        repositories: [{ rootId: "workspace" }],
        failures: [],
      };
    },
    /** 作業ツリー差分の取得要求を記録し、変更なしの応答を返す。 */
    getFileRootDiff: async (request: unknown) => {
      diffRequests.push(request);
      return { status: "not-changed", message: "none" };
    },
    /** 履歴を取得できるリポジトリの列挙要求を記録し、空一覧を返す。 */
    listFileRootGitHistoryRepositories: async (request: unknown) => {
      historyRepositoryRequests.push(request);
      return { status: "ok", repositories: [] };
    },
    /** 履歴ページに渡るカーソルと対象を記録し、次ページのない結果を返す。 */
    listFileRootGitHistoryCommits: async (request: unknown) => {
      historyCommitRequests.push(request);
      return {
        status: "ok",
        page: { entries: [], nextCursor: null, hasMore: false },
      };
    },
    /** 指定 commit の詳細取得に渡った引数を記録し、対象なしを返す。 */
    getFileRootGitHistoryCommitDetail: async (request: unknown) => {
      historyDetailRequests.push(request);
      return { status: "commit-not-found", message: "none" };
    },
    /** 比較元と比較先が履歴比較サービスに渡ったかを調べるため、要求を記録して結果にも残す。 */
    getFileRootGitHistoryComparison: async (request: unknown) => {
      historyComparisonRequests.push(request);
      return { status: "ok", comparison: request, entries: [] };
    },
    /** 履歴差分の要求を現在の変更差分とは別に記録し、変更なしの結果を返す。 */
    getFileRootGitHistoryDiff: async (request: unknown) => {
      historyDiffRequests.push(request);
      return { status: "not-changed", message: "none" };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_SESSION_FILE_ROOTS_CHANNEL)?.({}, "aux-1"),
    [
      {
        id: "workspace",
        kind: "workspace",
        label: "Workspace",
        displayPath: "C:/repo",
      },
    ],
  );
  const request = {
    sessionId: "aux-1",
    rootId: "workspace",
    relativePath: "src",
  };
  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_SESSION_DIRECTORY_CHANNEL)?.({}, request),
    [],
  );
  assert.deepEqual(directoryRequests, [request]);
  const openRequest = {
    sessionId: "aux-1",
    rootId: "workspace",
    relativePath: "src/app/SessionWindowApp.tsx",
  };
  assert.deepEqual(
    await handlers.get(WITHMATE_OPEN_SESSION_FILE_CHANNEL)?.({}, openRequest),
    {
      status: "opened",
      targetType: "local-path",
      target: "C:/repo/src/App.tsx",
    },
  );
  assert.deepEqual(openRequests, [openRequest]);
  const outsideResource = {
    sessionId: "aux-1",
    absolutePath: "C:/outside/current.md",
  };
  await handlers.get(WITHMATE_INSPECT_SESSION_FILE_CHANNEL)?.(
    {},
    outsideResource,
  );
  const outsideReadRequest = {
    ...outsideResource,
    offset: 0,
    length: 1024,
  };
  await handlers.get(WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL)?.(
    {},
    outsideReadRequest,
  );
  await handlers.get(WITHMATE_OPEN_SESSION_FILE_CHANNEL)?.({}, outsideResource);
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.(
        {},
        {
          kind: "resource",
          resource: outsideResource,
        },
      ) as Promise<unknown>,
    /must be root-scoped/,
  );
  assert.deepEqual(inspectRequests, [outsideResource]);
  assert.deepEqual(readRequests, [outsideReadRequest]);
  assert.deepEqual(openRequests, [openRequest, outsideResource]);
  const previewRequest = {
    kind: "resource",
    resource: openRequest,
    view: { kind: "diff", scope: "working-tree" },
  };
  assert.equal(
    (
      (await handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.(
        {},
        previewRequest,
      )) as { status: string }
    ).status,
    "opened",
  );
  assert.deepEqual(previewNavigationRequests, [previewRequest]);
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.(
        {},
        {
          ...previewRequest,
          view: { kind: "diff", scope: "invalid" },
        },
      ) as Promise<unknown>,
    /view is invalid/,
  );
  const changesRequest = { sessionId: "aux-1", rootId: "workspace" };
  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL)?.(
      {},
      changesRequest,
    ),
    {
      status: "ok",
      entries: [],
    },
  );
  assert.deepEqual(changesRequests, [changesRequest]);
  const changesRepositoriesRequest = {
    sessionId: "aux-1",
    rootIds: ["workspace"],
  };
  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_FILE_ROOT_CHANGES_REPOSITORIES_CHANNEL)?.(
      {},
      changesRepositoriesRequest,
    ),
    { status: "ok", repositories: [{ rootId: "workspace" }], failures: [] },
  );
  assert.deepEqual(changesRepositoryRequests, [changesRepositoriesRequest]);
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_LIST_FILE_ROOT_CHANGES_REPOSITORIES_CHANNEL)?.(
        {},
        {
          sessionId: "aux-1",
          rootIds: ["workspace", "workspace"],
        },
      ) as Promise<unknown>,
    /request is invalid/,
  );
  const diffRequest = {
    sessionId: "aux-1",
    rootId: "workspace",
    relativePath: "src/app/SessionWindowApp.tsx",
    scope: "working-tree",
  };
  assert.deepEqual(
    await handlers.get(WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL)?.({}, diffRequest),
    {
      status: "not-changed",
      message: "none",
    },
  );
  assert.deepEqual(diffRequests, [diffRequest]);
  const historyRepositoriesRequest = { sessionId: "aux-1" };
  assert.deepEqual(
    await handlers.get(
      WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_REPOSITORIES_CHANNEL,
    )?.({}, historyRepositoriesRequest),
    { status: "ok", repositories: [] },
  );
  const historyRequest = {
    sessionId: "aux-1",
    repositoryId: "git:aaaaaaaaaaaaaaaaaaaaaaaa",
    rootId: "workspace",
  };
  const historyCommitsRequest = {
    ...historyRequest,
    branch: "main",
  };
  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_COMMITS_CHANNEL)?.(
      {},
      { ...historyCommitsRequest, cursor: null },
    ),
    { status: "ok", page: { entries: [], nextCursor: null, hasMore: false } },
  );
  const historyDetailRequest = { ...historyRequest, commitId: "a".repeat(40) };
  assert.deepEqual(
    await handlers.get(
      WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMMIT_DETAIL_CHANNEL,
    )?.({}, historyDetailRequest),
    { status: "commit-not-found", message: "none" },
  );
  const historyComparisonRequest = {
    ...historyRequest,
    base: { kind: "branch", name: "main" },
    target: { kind: "remote", name: "origin/main" },
    mode: "branch",
  };
  assert.deepEqual(
    await handlers.get(WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMPARISON_CHANNEL)?.(
      {},
      historyComparisonRequest,
    ),
    { status: "ok", comparison: historyComparisonRequest, entries: [] },
  );
  const historyDiffRequest = {
    ...historyDetailRequest,
    relativePath: "src/app/SessionWindowApp.tsx",
  };
  assert.deepEqual(
    await handlers.get(WITHMATE_GET_FILE_ROOT_GIT_HISTORY_DIFF_CHANNEL)?.(
      {},
      historyDiffRequest,
    ),
    { status: "not-changed", message: "none" },
  );
  const historyPreviewRequest = {
    kind: "history-diff",
    request: historyDiffRequest,
  };
  assert.equal(
    (
      (await handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.(
        {},
        historyPreviewRequest,
      )) as { status: string }
    ).status,
    "opened",
  );
  assert.deepEqual(historyRepositoryRequests, [historyRepositoriesRequest]);
  assert.deepEqual(historyCommitRequests, [
    { ...historyCommitsRequest, cursor: null },
  ]);
  assert.deepEqual(historyDetailRequests, [historyDetailRequest]);
  assert.deepEqual(historyComparisonRequests, [historyComparisonRequest]);
  assert.deepEqual(historyDiffRequests, [historyDiffRequest]);
  assert.deepEqual(previewNavigationRequests, [
    previewRequest,
    historyPreviewRequest,
  ]);
  for (const branch of [
    undefined,
    "",
    " main",
    "main ",
    "main\n",
  ] as unknown[]) {
    await assert.rejects(
      () =>
        handlers.get(WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_COMMITS_CHANNEL)?.(
          {},
          {
            ...historyRequest,
            branch,
            cursor: null,
          },
        ) as Promise<unknown>,
      /Git history branch is invalid/,
    );
  }
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_COMMITS_CHANNEL)?.(
        {},
        {
          ...historyCommitsRequest,
          repositoryId: "not-a-repository",
        },
      ) as Promise<unknown>,
    /Git history request/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMMIT_DETAIL_CHANNEL)?.(
        {},
        {
          ...historyRequest,
          commitId: "not-a-commit",
        },
      ) as Promise<unknown>,
    /commit id is invalid/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMPARISON_CHANNEL)?.(
        {},
        {
          ...historyComparisonRequest,
          base: { kind: "branch", name: "../outside" },
        },
      ) as Promise<unknown>,
    /comparison ref is invalid/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_GET_FILE_ROOT_GIT_HISTORY_DIFF_CHANNEL)?.(
        {},
        {
          ...historyDiffRequest,
          relativePath: "../outside.ts",
        },
      ) as Promise<unknown>,
    /file path is invalid/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL)?.(
        {},
        { sessionId: "aux-1", rootId: "" },
      ) as Promise<unknown>,
    /File root changes request/,
  );
  assert.deepEqual(changesRequests, [changesRequest]);
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL)?.(
        {},
        { ...diffRequest, scope: "unknown" },
      ) as Promise<unknown>,
    /Git Diff request/,
  );
  assert.deepEqual(diffRequests, [diffRequest]);

  currentWindow = otherWindow;
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_LIST_SESSION_FILE_ROOTS_CHANNEL)?.(
        {},
        "aux-1",
      ) as Promise<unknown>,
    /owning Session window/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.(
        {},
        previewRequest,
      ) as Promise<unknown>,
    /owning Session window/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.(
        {},
        historyPreviewRequest,
      ) as Promise<unknown>,
    /owning Session window/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL)?.(
        {},
        changesRequest,
      ) as Promise<unknown>,
    /owning Session window/,
  );
  assert.deepEqual(changesRequests, [changesRequest]);
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_LIST_FILE_ROOT_CHANGES_REPOSITORIES_CHANNEL)?.(
        {},
        changesRepositoriesRequest,
      ) as Promise<unknown>,
    /owning Session window/,
  );
  assert.deepEqual(changesRepositoryRequests, [changesRepositoriesRequest]);
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_REPOSITORIES_CHANNEL)?.(
        {},
        historyRepositoriesRequest,
      ) as Promise<unknown>,
    /owning Session window/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_LIST_FILE_ROOT_GIT_HISTORY_COMMITS_CHANNEL)?.(
        {},
        { ...historyCommitsRequest, cursor: null },
      ) as Promise<unknown>,
    /owning Session window/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMMIT_DETAIL_CHANNEL)?.(
        {},
        historyDetailRequest,
      ) as Promise<unknown>,
    /owning Session window/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_GET_FILE_ROOT_GIT_HISTORY_COMPARISON_CHANNEL)?.(
        {},
        historyComparisonRequest,
      ) as Promise<unknown>,
    /owning Session window/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_GET_FILE_ROOT_GIT_HISTORY_DIFF_CHANNEL)?.(
        {},
        historyDiffRequest,
      ) as Promise<unknown>,
    /owning Session window/,
  );
  assert.deepEqual(historyRepositoryRequests, [historyRepositoriesRequest]);
  assert.deepEqual(historyCommitRequests, [
    { ...historyCommitsRequest, cursor: null },
  ]);
  assert.deepEqual(historyDetailRequests, [historyDetailRequest]);
  assert.deepEqual(historyComparisonRequests, [historyComparisonRequest]);
  assert.deepEqual(historyDiffRequests, [historyDiffRequest]);
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_OPEN_SESSION_FILE_CHANNEL)?.(
        {},
        openRequest,
      ) as Promise<unknown>,
    /current Preview resource/,
  );
  currentWindow = previewWindow;
  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_SESSION_FILE_ROOTS_CHANNEL)?.({}, "aux-1"),
    [
      {
        id: "workspace",
        kind: "workspace",
        label: "Workspace",
        displayPath: "C:/repo",
      },
    ],
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_LIST_SESSION_DIRECTORY_CHANNEL)?.(
        {},
        request,
      ) as Promise<unknown>,
    /owning Session window/,
  );
  assert.deepEqual(directoryRequests, [request]);
  assert.deepEqual(
    await handlers.get(
      WITHMATE_GET_SESSION_FILE_PREVIEW_WINDOW_PAYLOAD_CHANNEL,
    )?.({}, "preview-1"),
    {
      resource: currentPreviewResource,
      ownerSessionId: "session-1",
      displayPath: "C:/workspace/file",
      windowTitle: "current.md",
    },
  );
  assert.equal(
    await handlers.get(
      WITHMATE_GET_SESSION_FILE_PREVIEW_WINDOW_PAYLOAD_CHANNEL,
    )?.({}, "wrong-token"),
    null,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL)?.(
        {},
        changesRequest,
      ) as Promise<unknown>,
    /current Preview resource/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL)?.(
        {},
        diffRequest,
      ) as Promise<unknown>,
    /current Preview resource/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.(
        {},
        previewRequest,
      ) as Promise<unknown>,
    /owning Session window/,
  );
  assert.equal(
    (
      (await handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.(
        {},
        {
          kind: "link",
          sessionId: "aux-1",
          target: "../outside.txt",
          baseResource: currentPreviewResource,
        },
      )) as { status: string }
    ).status,
    "opened",
  );
  await handlers.get(WITHMATE_INSPECT_SESSION_FILE_CHANNEL)?.(
    {},
    currentPreviewResource,
  );
  assert.deepEqual(inspectRequests, [outsideResource, currentPreviewResource]);
  assert.deepEqual(
    await handlers.get(WITHMATE_OPEN_SESSION_FILE_CHANNEL)?.(
      {},
      currentPreviewResource,
    ),
    {
      status: "opened",
      targetType: "local-path",
      target: "C:/repo/src/App.tsx",
    },
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_INSPECT_SESSION_FILE_CHANNEL)?.(
        {},
        {
          sessionId: "aux-1",
          absolutePath: "C:/outside/other.md",
        },
      ) as Promise<unknown>,
    /current Preview resource/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.(
        {},
        {
          kind: "link",
          sessionId: "aux-1",
          target: "../outside.txt",
          baseResource: {
            sessionId: "aux-1",
            absolutePath: "C:/outside/other.md",
          },
        },
      ) as Promise<unknown>,
    /current Preview resource as its base/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.(
        {},
        {
          kind: "link",
          sessionId: "aux-1",
          target: "../outside.txt",
          baseResource: {
            sessionId: "aux-1",
            absolutePath: "C:/outside/current.md",
            rootId: "workspace",
            relativePath: "current.md",
          },
        },
      ) as Promise<unknown>,
    /File preview resource is invalid/,
  );
});

// @test-value v2
// kind = "security"
// claim = "リンク解決中にSession所有者・Preview resource・送信元windowが変わると、遅延したOS open前の再認可が失敗する"
// oracle = { type = "contract", ref = "ADR 034 File preview window navigation: current Preview resource and owning Session authority" }
// fault = "初回認可だけでリンク解決後の古いrequestからOS openへ進む"
// observable = "非同期解決後の再認可拒否とOS open相当の呼び出し回数"
// observation_boundary = "public-boundary"
// scope = "File preview link IPC sender reauthorization"
// lifecycle = "permanent"
// impact = "閉じた・切り替わったPreviewや所有者変更後のSessionから外部directoryをOSで開けてしまう"
// distinction = "既存testの初回sender/base拒否では検出できない、service待機後のauthority変化を検証する"
// risk_tags = ["authorization"]
// @end-test-value
/** リンクの非同期解決中に所有 Session、基点、送信元が変わると、実際に開く前の再認可が失敗することを確かめる。 */
test("File preview link IPC は非同期解決後も同じsender authorityを要求する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub(
    "file:///session.html?sessionId=session-1",
  );
  const otherWindow = createWindowStub(
    "file:///session.html?sessionId=session-2",
  );
  const previewWindow = createWindowStub(
    "file:///file-preview.html?token=preview-1",
  );
  let currentWindow = ownerWindow;
  let ownerSessionId = "session-1";
  const baseResource = {
    sessionId: "aux-1",
    absolutePath: "C:/outside/current.md",
  };
  let currentPreviewResource = baseResource;
  /** 初回は状態を変更せず、後続のケースでリンク解決直後の状態変更を注入する。 */
  let afterResolution = () => {};
  let openedCount = 0;
  const { deps } = createDeps({
    /** リンクを要求した Window を返し、解決後の送信元変更を再現できるようにする。 */
    resolveEventWindow: () => currentWindow,
    /** 二つの実在する Session ID に別々の Window を割り当てる。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1"
        ? ownerWindow
        : sessionId === "session-2"
          ? otherWindow
          : null,
    /** リンクを持つ Auxiliary の所有者が解決中に別 Session へ切り替わる状態を表す。 */
    getSessionFileExplorerOwnerSessionId: async (sessionId: string) =>
      sessionId === "aux-1" ? ownerSessionId : null,
    /** 分離 Preview の現在の基点を返し、同じ Window 内で別資源に移動した場合を再現する。 */
    getFilePreviewWindowResource: (window: unknown, sessionId: string) =>
      window === previewWindow && sessionId === "aux-1"
        ? currentPreviewResource
        : null,
    /** 非同期解決の後で認可を呼び直し、それに成功した場合だけ OS で開いたものとして数える。 */
    openSessionFilePreviewWindow: async (
      _request: unknown,
      assertLinkSender: () => Promise<void>,
    ) => {
      await Promise.resolve();
      afterResolution();
      await assertLinkSender();
      openedCount += 1;
      return {
        status: "opened",
        targetType: "local-directory",
        target: "C:/outside/docs",
      };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const request = {
    kind: "link",
    sessionId: "aux-1",
    target: "C:/outside/docs",
    baseResource,
  };
  /** 毎回同じ要求を登録済みリンク処理に送り、変化させた権限との組合せを検証する。 */
  const open = () =>
    handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.(
      {},
      request,
    ) as Promise<unknown>;

  assert.deepEqual(await open(), {
    status: "opened",
    targetType: "local-directory",
    target: "C:/outside/docs",
  });
  assert.equal(openedCount, 1);

  afterResolution = () => {
    ownerSessionId = "session-2";
  };
  await assert.rejects(open, /current Preview resource as its base/);
  assert.equal(openedCount, 1);

  ownerSessionId = "session-1";
  currentWindow = previewWindow;
  afterResolution = () => {
    currentPreviewResource = {
      ...baseResource,
      absolutePath: "C:/outside/other.md",
    };
  };
  await assert.rejects(open, /current Preview resource as its base/);
  assert.equal(openedCount, 1);

  currentPreviewResource = baseResource;
  afterResolution = () => {
    currentWindow = otherWindow;
  };
  await assert.rejects(open, /sender changed/);
  assert.equal(openedCount, 1);
});

/** Glossary の投影と検索は対象 Session の Window に限定し、renderer のパスを検索の権限根拠にしないことを確かめる。 */
test("Glossary IPCはtarget Session windowだけをauthorityとし、renderer pathを受け取らない", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub("http://localhost/?sessionId=session-1");
  const otherWindow = createWindowStub("http://localhost/?sessionId=session-2");
  let eventWindow = ownerWindow;
  let subscriptionCount = 0;
  const projection = {
    sessionId: "session-1",
    scopeRevision: "scope-1",
    sequence: 1,
    checkout: { repositoryName: "repo", branch: "main", pathLabel: "repo" },
    state: {
      status: "missing",
      relativePath: ".withmate/glossary.yaml",
      revision: null,
    },
  };
  const { deps } = createDeps({
    /** 投影と検索の送信元を所有 Window から別 Session の Window へ切り替えられるようにする。 */
    resolveEventWindow: () => eventWindow,
    /** 要求する Session ID に応じて照合対象の Window を返す。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? ownerWindow : otherWindow,
    /** 許可された投影取得によって購読が確保された回数を記録する。 */
    ensureSessionGlossarySubscription: async () => {
      subscriptionCount += 1;
    },
    /** Main が決めた checkout と用語集の状態を投影として返す。 */
    getSessionGlossaryProjection: async () => projection,
    /** 検索文字列を受け取って空の検索結果を返し、呼び出し元のパスは使わない。 */
    searchSessionGlossary: async (
      _sessionId: string,
      request: { query: string },
    ) => ({
      ok: true,
      revision: null,
      entries: [],
      total: 0,
      offset: 0,
      pageSize: 50,
      query: request.query,
    }),
  });
  registerMainIpcHandlers(ipcMain, deps);

  const getProjection = handlers.get(
    WITHMATE_GET_SESSION_GLOSSARY_PROJECTION_CHANNEL,
  )!;
  assert.deepEqual(
    await getProjection({ sender: {} }, "session-1"),
    projection,
  );
  assert.equal(subscriptionCount, 1);
  const search = handlers.get(WITHMATE_SEARCH_SESSION_GLOSSARY_CHANNEL)!;
  const searchResult = await search({ sender: {} }, "session-1", {
    query: "runtime",
  });
  assert.equal((searchResult as { ok: boolean }).ok, true);

  eventWindow = otherWindow;
  await assert.rejects(
    () => Promise.resolve(getProjection({ sender: {} }, "session-1")),
    /target Session window/,
  );
  await assert.rejects(
    () =>
      Promise.resolve(
        search({ sender: {} }, "session-1", {
          query: "runtime",
          path: "C:\\other",
        }),
      ),
    /target Session window/,
  );
});

/** 分離 Preview の Git 変更一覧を現在表示中のルート内ファイル一件に絞り、他ファイルの差分取得を拒否することを確認する。 */
test("File Preview の Git IPC は current root file だけを投影する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub(
    "file:///session.html?sessionId=session-1",
  );
  const previewWindow = createWindowStub(
    "file:///file-preview.html?token=preview-1",
  );
  const currentResource = {
    sessionId: "aux-1",
    rootId: "workspace",
    relativePath: "src/current.ts",
  };
  const diffRequests: unknown[] = [];
  const { deps } = createDeps({
    /** Git の要求元を分離 Preview に固定し、親 Window とは別の権限境界を調べる。 */
    resolveEventWindow: () => previewWindow,
    /** 元の Main には親 Window を割り当て、分離 Preview と同一にはしない。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? ownerWindow : null,
    /** Preview の対象 Auxiliary を既知の Files 所有者に関連付ける。 */
    getSessionFileExplorerOwnerSessionId: async (sessionId: string) =>
      sessionId === "aux-1" ? "session-1" : null,
    /** 指定 Preview が現在表示しているルート内資源を返す。 */
    getFilePreviewWindowResource: (window: unknown, sessionId: string) =>
      window === previewWindow && sessionId === "aux-1"
        ? currentResource
        : null,
    /** 複数ファイルの変更を返し、IPC が現在の Preview 対象だけに絞ることを観測する。 */
    listFileRootChanges: async () => ({
      status: "ok",
      entries: [
        {
          relativePath: "src/current.ts",
          previousRelativePath: null,
          kinds: { "working-tree": "modified" },
          scopes: ["working-tree"],
        },
        {
          relativePath: "src/secret.ts",
          previousRelativePath: null,
          kinds: { "working-tree": "modified" },
          scopes: ["working-tree"],
        },
      ],
    }),
    /** 差分取得に実際に届いた要求を記録し、他ファイルの要求を排除できたか調べる。 */
    getFileRootDiff: async (request: unknown) => {
      diffRequests.push(request);
      return { status: "not-changed", message: "none" };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL)?.(
      {},
      {
        sessionId: "aux-1",
        rootId: "workspace",
      },
    ),
    {
      status: "ok",
      entries: [
        {
          relativePath: "src/current.ts",
          previousRelativePath: null,
          kinds: { "working-tree": "modified" },
          scopes: ["working-tree"],
        },
      ],
    },
  );
  const currentDiff = { ...currentResource, scope: "working-tree" };
  assert.deepEqual(
    await handlers.get(WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL)?.({}, currentDiff),
    { status: "not-changed", message: "none" },
  );
  assert.deepEqual(diffRequests, [currentDiff]);
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_LIST_FILE_ROOT_CHANGES_CHANNEL)?.(
        {},
        {
          sessionId: "aux-1",
          rootId: "other-root",
        },
      ) as Promise<unknown>,
    /current Preview resource/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_GET_FILE_ROOT_DIFF_CHANNEL)?.(
        {},
        {
          ...currentDiff,
          relativePath: "src/secret.ts",
        },
      ) as Promise<unknown>,
    /current Preview resource/,
  );
  assert.deepEqual(diffRequests, [currentDiff]);
});

/** コミット内の Preview では同じファイルの区切り文字違いを許可し、別ファイル・別コミットには権限を広げないことを確認する。 */
test("commit file preview IPC はseparator表記が変わるinspect / chunk遷移もcurrent resourceとして認可する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub(
    "file:///session.html?sessionId=session-1",
  );
  const previewWindow = createWindowStub(
    "file:///file-preview.html?token=commit-preview-1",
  );
  let currentWindow = ownerWindow;
  const resource = {
    resourceKind: "git-commit-file" as const,
    sessionId: "aux-1",
    rootId: "workspace",
    repositoryId: "git:aaaaaaaaaaaaaaaaaaaaaaaa",
    commitId: "a".repeat(40),
    relativePath: "src\\current.ts",
  };
  const descriptor = {
    ...resource,
    relativePath: "src/current.ts",
    name: "current.ts",
    kind: "text" as const,
    byteLength: 32,
    modifiedAt: "2026-08-29T00:00:00.000Z",
    mimeType: "text/plain",
    suggestedEncoding: "utf-8" as const,
    revision: "b".repeat(40),
  };
  const inspectRequests: unknown[] = [];
  const readRequests: unknown[] = [];
  const navigationRequests: unknown[] = [];
  const { deps } = createDeps({
    /** 最初に Preview を開く親 Window と、開いた後の Preview を切り替える。 */
    resolveEventWindow: () => currentWindow,
    /** 元の Main にだけファイルを所有する Window を返す。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? ownerWindow : null,
    /** 対象 Auxiliary をコミット資源に対応する親 Session へ解決する。 */
    getSessionFileExplorerOwnerSessionId: async (sessionId: string) =>
      sessionId === "aux-1" ? "session-1" : null,
    /** 対象 Preview が保持する現在のコミット内資源を返す。 */
    getFilePreviewWindowResource: (window: unknown, sessionId: string) =>
      window === previewWindow && sessionId === "aux-1" ? resource : null,
    /** 検証を通過した Preview 作成要求を記録し、後続の検査・読み取り対象になる資源を返す。 */
    openSessionFilePreviewWindow: async (request: unknown) => {
      navigationRequests.push(request);
      return {
        status: "opened",
        targetType: "preview-window",
        disposition: "created",
        resource,
      };
    },
    /** コミット内ファイルの検査に渡った資源を記録し、区切りを正規化した descriptor を返す。 */
    inspectSessionFile: async (request: unknown) => {
      inspectRequests.push(request);
      return descriptor;
    },
    /** 検査結果で指定したファイルのチャンク要求が、正規化後も通過したことを記録する。 */
    readSessionFileChunk: async (request: unknown) => {
      readRequests.push(request);
      return null;
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () =>
      handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.(
        {},
        {
          kind: "resource",
          resource,
          view: { kind: "diff", scope: "working-tree" },
        },
      ) as Promise<unknown>,
    /do not support working tree diff views/,
  );
  assert.deepEqual(navigationRequests, []);
  const openRequest = { kind: "resource", resource };
  assert.equal(
    (
      (await handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)?.(
        {},
        openRequest,
      )) as { status: string }
    ).status,
    "opened",
  );
  assert.deepEqual(navigationRequests, [openRequest]);
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_OPEN_SESSION_FILE_CHANNEL)?.(
        {},
        resource,
      ) as Promise<unknown>,
    /Working tree file resource is invalid/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_COPY_SESSION_FILE_OBJECT_CHANNEL)?.(
        {},
        { resource },
      ) as Promise<unknown>,
    /Working tree file resource is invalid/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_INSPECT_SESSION_FILE_CHANNEL)?.(
        {},
        resource,
      ) as Promise<unknown>,
    /current Preview resource/,
  );

  currentWindow = previewWindow;
  const inspected = (await handlers.get(
    WITHMATE_INSPECT_SESSION_FILE_CHANNEL,
  )?.({}, resource)) as typeof descriptor;
  assert.equal(inspected.relativePath, "src/current.ts");
  const chunkRequest = {
    resourceKind: inspected.resourceKind,
    sessionId: inspected.sessionId,
    rootId: inspected.rootId,
    repositoryId: inspected.repositoryId,
    commitId: inspected.commitId,
    relativePath: inspected.relativePath,
    offset: 0,
    length: inspected.byteLength,
    expectedRevision: inspected.revision,
  };
  await handlers.get(WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL)?.(
    {},
    chunkRequest,
  );
  assert.deepEqual(inspectRequests, [resource]);
  assert.deepEqual(readRequests, [chunkRequest]);
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_INSPECT_SESSION_FILE_CHANNEL)?.(
        {},
        {
          ...resource,
          commitId: "c".repeat(40),
        },
      ) as Promise<unknown>,
    /current Preview resource/,
  );
});

// @test-value v2
// kind = "security"
// claim = "画像path menu IPCは元sourceと同一Sessionのbaseを保持しowner/current previewを認可して選択時の再確認も失効させる"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Image Handling" }
// fault = "不正sourceや別Sessionのbaseをmenuへ渡す、任意windowへ認可する、またはmenu表示後のowner/base変更を無視する"
// observable = "menu依存へ渡るrequestと再確認callbackの拒否、拒否時のmenu呼出件数"
// observation_boundary = "public-boundary"
// scope = "画像native path menuのIPC入力とsender認可"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// distinction = "service testはElectron senderとSession/previewの所有関係を知らず、画像read IPC testはmenu選択時の再認可callbackを通らない"
// @end-test-value
/** 画像のパス操作メニューでは送信した元画像と基点を維持し、表示後に権限が失われた場合は選択時の再確認で拒否することを確かめる。 */
test("画像path menu IPCはsource/baseを保持し表示後のowner/base変更を再認可で拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub(
    "file:///session.html?sessionId=session-1",
  );
  const previewWindow = createWindowStub(
    "file:///file-preview.html?token=preview",
  );
  const otherWindow = createWindowStub("file:///home.html");
  let currentWindow = ownerWindow;
  let currentBase = { sessionId: "aux-1", absolutePath: "/outside/message.md" };
  let ownerId: string | null = "session-1";
  let assertSender!: () => Promise<void>;
  const menuRequests: unknown[] = [];
  const { deps } = createDeps({
    /** メニューを開く親と Preview を切り替え、現在の送信元を返す。 */
    resolveEventWindow: () => currentWindow,
    /** 画像を所有する Main の Window だけを返す。 */
    resolveSessionWindow: (id: string) =>
      id === "session-1" ? ownerWindow : null,
    /** メニュー表示後に Auxiliary の所有者を変えられるよう、その時点の親を返す。 */
    getSessionFileExplorerOwnerSessionId: async (id: string) =>
      id === "aux-1" ? ownerId : null,
    /** 分離 Preview が現在表示している基点を返し、別資源への変更を反映する。 */
    getFilePreviewWindowResource: (window: unknown, id: string) =>
      window === previewWindow && id === "aux-1" ? currentBase : null,
    /** メニューに届いた入力と、選択時に使う再認可関数を捕捉する。 */
    showSessionFilePreviewImageContextMenu: async (
      _event: unknown,
      request: unknown,
      reauthorize: () => Promise<void>,
    ) => {
      menuRequests.push(request);
      assertSender = reauthorize;
      return { status: "dismissed" };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const request = {
    sessionId: "aux-1",
    point: { x: 10, y: 20 },
    image: { target: "../image.png", baseResource: currentBase },
  };
  /** 通常は同じ画像メニューを起動し、必要な場合だけ不正な入力で置き換える。 */
  const invoke = (input: unknown = request) =>
    handlers.get(
      WITHMATE_SHOW_SESSION_FILE_PREVIEW_IMAGE_CONTEXT_MENU_CHANNEL,
    )?.({}, input) as Promise<unknown>;
  assert.deepEqual(await invoke(), { status: "dismissed" });
  assert.deepEqual(menuRequests, [request]);
  await assertSender();
  ownerId = null;
  await assert.rejects(
    () => assertSender(),
    /current Preview resource as its base/,
  );
  ownerId = "session-1";
  currentWindow = otherWindow;
  await assert.rejects(() => invoke(), /current Preview resource as its base/);
  currentWindow = previewWindow;
  await invoke();
  await assertSender();
  currentBase = { ...currentBase, absolutePath: "/outside/other.md" };
  await assert.rejects(
    () => assertSender(),
    /current Preview resource as its base/,
  );
  currentWindow = ownerWindow;
  for (const image of [
    null,
    { target: "" },
    { target: 42 },
    {
      target: "image.png",
      baseResource: { ...currentBase, sessionId: "other" },
    },
  ]) {
    await assert.rejects(() => invoke({ ...request, image }), /invalid/);
  }
  assert.equal(menuRequests.length, 2);
});

/** 画像のコピーとコンテキストメニューは所有 Window に限定し、コピー時の座標制約で不正な入力を拒否することを確認する。 */
test("画像copy IPCはowning Session windowと非負の整数座標だけを受け付ける", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub(
    "file:///session.html?sessionId=session-1",
  );
  const otherWindow = createWindowStub("file:///home.html");
  let currentWindow = ownerWindow;
  const copyRequests: unknown[] = [];
  const menuRequests: unknown[] = [];
  const { deps } = createDeps({
    /** 画像を要求する呼び出し元を所有 Window から対象外 Window へ切り替える。 */
    resolveEventWindow: () => currentWindow,
    /** 画像の操作を所有する Main にだけ Window を割り当てる。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? ownerWindow : null,
    /** 画像が属する Auxiliary を認可用の親 Session に解決する。 */
    getSessionFileExplorerOwnerSessionId: async (sessionId: string) =>
      sessionId === "aux-1" ? "session-1" : null,
    /** クリップボードを使わず、座標検証を通過した画像コピー要求と結果を観測する。 */
    copySessionFilePreviewImage: async (_event: unknown, request: unknown) => {
      copyRequests.push(request);
      return { status: "copied" };
    },
    /** 画像メニューの要求が別の依存先へそのまま届くことを記録する。 */
    showSessionFilePreviewImageContextMenu: async (
      _event: unknown,
      request: unknown,
    ) => {
      menuRequests.push(request);
      return { status: "dismissed" };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const request = { sessionId: "aux-1", point: { x: 24, y: 48 } };

  assert.deepEqual(
    await handlers.get(WITHMATE_COPY_SESSION_FILE_PREVIEW_IMAGE_CHANNEL)?.(
      {},
      request,
    ),
    { status: "copied" },
  );
  assert.deepEqual(
    await handlers.get(
      WITHMATE_SHOW_SESSION_FILE_PREVIEW_IMAGE_CONTEXT_MENU_CHANNEL,
    )?.({}, request),
    { status: "dismissed" },
  );
  assert.deepEqual(copyRequests, [request]);
  assert.deepEqual(menuRequests, [request]);

  for (const invalidRequest of [
    null,
    { sessionId: "aux-1", point: { x: -1, y: 2 } },
    { sessionId: "aux-1", point: { x: 1.5, y: 2 } },
    { sessionId: "aux-1", point: { x: 1, y: Number.NaN } },
  ]) {
    await assert.rejects(
      () =>
        handlers.get(WITHMATE_COPY_SESSION_FILE_PREVIEW_IMAGE_CHANNEL)?.(
          {},
          invalidRequest,
        ) as Promise<unknown>,
      /Image copy request is invalid/,
    );
  }
  assert.deepEqual(copyRequests, [request]);

  currentWindow = otherWindow;
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_COPY_SESSION_FILE_PREVIEW_IMAGE_CHANNEL)?.(
        {},
        request,
      ) as Promise<unknown>,
    /owning Session window/,
  );
});

/** ファイルオブジェクトのコピーとメニューは認可済み資源と所有送信元だけを受け付けることを確認する。 */
test("file object copy IPCは認可対象resourceとowning senderだけを受け付ける", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub(
    "file:///session.html?sessionId=session-1",
  );
  const otherWindow = createWindowStub("file:///home.html");
  let currentWindow = ownerWindow;
  const copyRequests: unknown[] = [];
  const menuRequests: unknown[] = [];
  const { deps } = createDeps({
    /** 許可する所有 Window から対象外の Window へ送信元を変えられるようにする。 */
    resolveEventWindow: () => currentWindow,
    /** ファイルオブジェクトを所有する Main にだけ Window を割り当てる。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? ownerWindow : null,
    /** コピー対象の Auxiliary の権限を、その親 Session の Window に結びつける。 */
    getSessionFileExplorerOwnerSessionId: async (sessionId: string) =>
      sessionId === "aux-1" ? "session-1" : null,
    /** 検証済みのコピー要求を記録し、OS のコピー機能を使わず成功を返す。 */
    copySessionFileObject: async (_event: unknown, request: unknown) => {
      copyRequests.push(request);
      return { status: "copied", message: "File copied." };
    },
    /** ファイルオブジェクト用のメニュー要求を記録し、表示結果の伝播を確認する。 */
    showSessionFileObjectCopyContextMenu: async (
      _event: unknown,
      request: unknown,
    ) => {
      menuRequests.push(request);
      return { status: "dismissed" };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const resource = {
    sessionId: "aux-1",
    rootId: "workspace",
    relativePath: "docs/report.txt",
  };
  const copyRequest = { resource };
  const menuRequest = { resource, point: { x: 24, y: 48 } };

  assert.deepEqual(
    await handlers.get(WITHMATE_COPY_SESSION_FILE_OBJECT_CHANNEL)?.(
      {},
      copyRequest,
    ),
    { status: "copied", message: "File copied." },
  );
  assert.deepEqual(
    await handlers.get(
      WITHMATE_SHOW_SESSION_FILE_OBJECT_COPY_CONTEXT_MENU_CHANNEL,
    )?.({}, menuRequest),
    { status: "dismissed" },
  );
  assert.deepEqual(copyRequests, [copyRequest]);
  assert.deepEqual(menuRequests, [menuRequest]);

  for (const invalidRequest of [
    { resource: { ...resource, absolutePath: "C:/outside.txt" } },
    { resource, point: { x: -1, y: 2 } },
    { resource, point: { x: 1.5, y: 2 } },
  ]) {
    const channel =
      "point" in invalidRequest
        ? WITHMATE_SHOW_SESSION_FILE_OBJECT_COPY_CONTEXT_MENU_CHANNEL
        : WITHMATE_COPY_SESSION_FILE_OBJECT_CHANNEL;
    await assert.rejects(
      () => handlers.get(channel)?.({}, invalidRequest) as Promise<unknown>,
      /File (?:preview resource|copy(?: context menu)? request) is invalid/,
    );
  }

  currentWindow = otherWindow;
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_COPY_SESSION_FILE_OBJECT_CHANNEL)?.(
        {},
        copyRequest,
      ) as Promise<unknown>,
    /current Preview resource/,
  );
  assert.deepEqual(copyRequests, [copyRequest]);
});

// @test-value v1
// kind = "security"
// claim = "file tree context menu IPCは限定fieldとnode kindを検証し、対象Sessionを所有するwindowだけへrequestを渡す"
// oracle = { type = "contract", ref = "accepted behavior invariant 1: renderer request boundary" }
// failure_mode = "absolute pathや余分なfieldを含むrequest、または非owner windowからのpath操作がMain serviceへ到達する"
// scope = "main IPC file tree context menu boundary"
// lifecycle = "permanent"
// distinction = "file preview resourceではなくroot・directoryを含むtree node専用requestとowning Session windowを検証する"
// @end-test-value
/** Files のツリーメニューで許可フィールドとノード種別を検証し、対象の所有 Window からの要求だけを転送することを確かめる。 */
test("file tree context menu IPCはstrict requestとowning Session windowだけを受け付ける", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub(
    "file:///session.html?sessionId=session-1",
  );
  const otherWindow = createWindowStub("file:///home.html");
  let currentWindow = ownerWindow;
  const requests: unknown[] = [];
  const { deps } = createDeps({
    /** ツリーメニューの呼び出し元を切り替え、所有判定と入力検証を個別に調べる。 */
    resolveEventWindow: () => currentWindow,
    /** ツリーノードを所有する Main の Window だけを解決する。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? ownerWindow : null,
    /** Auxiliary のツリーメニューに親 Window の権限を対応させる。 */
    getSessionFileExplorerOwnerSessionId: async (sessionId: string) =>
      sessionId === "aux-1" ? "session-1" : null,
    /** 認可と形の検証を両方通過したツリーノードの要求だけを記録する。 */
    showSessionFileTreeContextMenu: async (
      _event: unknown,
      request: unknown,
    ) => {
      requests.push(request);
      return { status: "dismissed" };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const request = {
    sessionId: "aux-1",
    rootId: "workspace",
    relativePath: "docs",
    nodeKind: "directory",
    point: { x: 24, y: 48 },
    canInsert: false,
  };

  assert.deepEqual(
    await handlers.get(WITHMATE_SHOW_SESSION_FILE_TREE_CONTEXT_MENU_CHANNEL)?.(
      {},
      request,
    ),
    { status: "dismissed" },
  );
  assert.deepEqual(requests, [request]);

  for (const invalidRequest of [
    { ...request, absolutePath: "C:/outside" },
    { ...request, nodeKind: "symbolic-link" },
    { ...request, point: { x: -1, y: 2 } },
    { ...request, canInsert: "yes" },
  ]) {
    await assert.rejects(
      () =>
        handlers.get(WITHMATE_SHOW_SESSION_FILE_TREE_CONTEXT_MENU_CHANNEL)?.(
          {},
          invalidRequest,
        ) as Promise<unknown>,
      /File tree context menu request is invalid/,
    );
  }

  currentWindow = otherWindow;
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_SHOW_SESSION_FILE_TREE_CONTEXT_MENU_CHANNEL)?.(
        {},
        request,
      ) as Promise<unknown>,
    /owning Session window/,
  );
  assert.deepEqual(requests, [request]);
});

// @test-value v2
// kind = "contract"
// claim = "Markdown link context menu IPCはtargetとfile contextを変換せずowner認可して渡す"
// oracle = { type = "contract", ref = "src-electron/ipc/register-main-ipc.ts" }
// fault = "link targetやfile owner contextを書き換えるか、不正requestやWindowなしの呼出しを通す"
// observable = "委譲requestの完全一致、link-copied結果、不正requestとWindowなしでのrejection"
// observation_boundary = "public-boundary"
// scope = "main IPC markdown link context menu"
// lifecycle = "permanent"
// @end-test-value
/** Markdown リンクの対象文字列と認可用コンテキストを保持し、別 Window や不適切なコンテキストを拒否することを確認する。 */
test("Markdown link context menu IPCはtargetと認可用file contextを変換せず渡す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const sourceWindow = createWindowStub(
    "file:///session.html?sessionId=session-1",
  );
  const otherOwnerWindow = createWindowStub(
    "file:///session.html?sessionId=session-2",
  );
  let currentWindow: ReturnType<typeof createWindowStub> | null = sourceWindow;
  const requests: unknown[] = [];
  const { deps } = createDeps({
    /** Markdown リンクを開いた送信元を、所有 Window と別 Window の間で切り替える。 */
    resolveEventWindow: () => currentWindow,
    /** リンク元の Session に対応する Window だけを返す。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? sourceWindow : null,
    /** リンクに付いたファイルコンテキストの所有者を、既知の Session に解決する。 */
    getSessionFileExplorerOwnerSessionId: async (sessionId: string) =>
      sessionId === "session-1" ? "session-1" : null,
    /** リンク対象とコンテキストが変換されずに届くか記録し、コピー結果を返す。 */
    showMarkdownLinkContextMenu: async (_event: unknown, request: unknown) => {
      requests.push(request);
      return { status: "link-copied" };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const request = {
    target: "file:///C:/tmp/candidate-source%20final.json",
    point: { x: 24, y: 48 },
    fileContext: {
      sessionId: "session-1",
      baseResource: {
        sessionId: "session-1",
        rootId: "workspace",
        relativePath: "docs/readme.md",
      },
    },
  };

  assert.deepEqual(
    await handlers.get(WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL)?.(
      {},
      request,
    ),
    { status: "link-copied" },
  );
  assert.deepEqual(requests, [request]);

  for (const invalidRequest of [
    null,
    { target: "", point: { x: 1, y: 2 } },
    { target: "docs/review-brief.md", point: { x: -1, y: 2 } },
    { target: "docs/review-brief.md", point: { x: 1.5, y: 2 } },
    {
      target: "docs/review-brief.md",
      point: { x: 1, y: 2 },
      fileContext: {
        sessionId: "session-1",
        baseResource: {
          sessionId: "other-session",
          rootId: "workspace",
          relativePath: "readme.md",
        },
      },
    },
  ]) {
    await assert.rejects(
      () =>
        handlers.get(WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL)?.(
          {},
          invalidRequest,
        ) as Promise<unknown>,
      /Markdown link (?:context menu request|file context) is invalid/,
    );
  }
  assert.deepEqual(requests, [request]);

  currentWindow = otherOwnerWindow;
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL)?.(
        {},
        request,
      ) as Promise<unknown>,
    /File Preview navigation must use the current Preview resource as its base/,
  );
  assert.deepEqual(requests, [request]);

  currentWindow = null;
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL)?.(
        {},
        request,
      ) as Promise<unknown>,
    /only available from a WithMate window/,
  );
  assert.deepEqual(requests, [request]);
});

// @test-value v2
// kind = "contract"
// claim = "Mate未作成でもowning Session WindowのTurn送信を許可し、別Windowからの送信を拒否する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Main GUI turn ownership" }
// fault = "Mate状態でMain送信をblockするか、別WindowのSessionへ送信できる"
// observable = "ownerの送信呼出しと非ownerの拒否、依存呼出し数"
// observation_boundary = "public-boundary"
// scope = "Main turn IPC sender ownership"
// lifecycle = "permanent"
// @end-test-value
/** Mate が未作成でも所有 Session Window は turn を送信でき、別 Window には同じ権限を付けないことを確認する。 */
test("registerMainIpcHandlers は Mate 未作成でもowning Session Windowの送信を許可する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const owner = createWindowStub("file:///session.html?sessionId=session-1");
  let currentWindow = owner;
  const { deps, calls } = createDeps({
    /** Mate が作成されていない既定プロファイルを再現する。 */
    getMateState: async () => "not_created",
    /** 同じ turn 送信の呼び出し元を所有 Window と別 Window に切り替える。 */
    resolveEventWindow: () => currentWindow,
    /** 送信対象 Session にだけ正しい所有 Window を割り当てる。 */
    resolveSessionWindow: (id: string) => (id === "session-1" ? owner : null),
  });

  registerMainIpcHandlers(ipcMain, deps);

  await handlers.get(WITHMATE_RUN_SESSION_TURN_CHANNEL)?.({}, "session-1", {
    userMessage: "hello",
  });

  assert.deepEqual(calls, ["runSessionTurn:session-1,[object Object]"]);
  currentWindow = createWindowStub("file:///home.html");
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_RUN_SESSION_TURN_CHANNEL)?.({}, "session-1", {
        userMessage: "hello",
      }) as Promise<unknown>,
    /target Session window/,
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith("runSessionTurn:")),
    ["runSessionTurn:session-1,[object Object]"],
  );
});

// @test-value v2
// kind = "invariant"
// claim = "narrow session mutation IPC は対象Session windowのsenderだけを許可し、Auxiliary identityをstatus queryで照合し、titleのcommit結果を保持する"
// oracle = { type = "contract", ref = "Session mutation IPC sender ownership" }
// fault = "別Session windowからnarrow mutationを実行できる、Auxiliary requestのcreatedAt不一致がserviceへ到達する、またはtitle結果を捨てる"
// observable = "mutation service呼出し、Auxiliary Session full hydrationなしの拒否、title commit結果"
// observation_boundary = "public-boundary"
// scope = "session-mutation-ipc"
// lifecycle = "permanent"
// impact = "誤ったwindowからの変更がsession間で混線する"
// distinction = "既存generic update IPCではなく専用mutation channelのowner identityとlightweight Auxiliary status guardを検証する"
// @end-test-value
/** 設定・タイトル・ブックマークの更新を対象 Window と mutation identity に限定し、Auxiliary の照合に会話全体を読み込まないことを確認する。 */
test("narrow session mutation IPC はowner windowとmutation identityを確認する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const ownerWindow = createWindowStub(
    "http://localhost:5173/?sessionId=session-1",
  );
  const otherWindow = createWindowStub(
    "http://localhost:5173/?sessionId=session-2",
  );
  let currentWindow: ReturnType<typeof createWindowStub> = ownerWindow;
  const mutationCalls: string[] = [];
  const titleResult = {
    status: "committed",
    projectionUpdated: false,
  } as const;
  let fullAuxiliaryReads = 0;
  const { deps } = createDeps({
    /** 限定更新を要求した Window を所有 Window と別 Window の間で切り替える。 */
    resolveEventWindow: () => currentWindow,
    /** 要求対象の Session に応じて、比較する Window を返す。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? ownerWindow : otherWindow,
    /** Main の実行設定更新に渡った Session ID を記録する。 */
    setSessionExecutionOptions: (request: { sessionId: string }) =>
      mutationCalls.push(`session-options:${request.sessionId}`),
    /** タイトル変更の対象を記録し、コミット結果が IPC の戻り値に残ることを調べる。 */
    setSessionTitle: (request: { sessionId: string }) => {
      mutationCalls.push(`session-title:${request.sessionId}`);
      return titleResult;
    },
    /** Main のブックマーク変更に渡った対象 Session を記録する。 */
    setSessionMessageBookmark: (request: { sessionId: string }) =>
      mutationCalls.push(`session-bookmark:${request.sessionId}`),
    /** Auxiliary の親と incarnation を確認できる最小の状態を返す。 */
    getAuxiliarySessionStatus: async () => ({
      id: "aux-1",
      parentSessionId: "session-1",
      createdAt: "2026-07-04T00:00:00.000Z",
      incarnation: "aux-incarnation-1",
      runState: "idle",
    }),
    /** 会話全体の読み取りを数え、軽量な状態照会で済んだかを判定できるようにする。 */
    getAuxiliarySession: async () => {
      fullAuxiliaryReads += 1;
      return createAuxiliarySessionStub();
    },
    /** Auxiliary の実行設定に実際に渡った対象 ID を記録する。 */
    setAuxiliaryExecutionOptions: (request: { auxiliarySessionId: string }) =>
      mutationCalls.push(`aux-options:${request.auxiliarySessionId}`),
    /** Auxiliary のタイトル更新が正しい対象に届いたことを記録する。 */
    setAuxiliaryTitle: (request: { auxiliarySessionId: string }) =>
      mutationCalls.push(`aux-title:${request.auxiliarySessionId}`),
    /** Auxiliary のブックマーク変更で親ではなく対象自身の ID が渡ったことを記録する。 */
    setAuxiliaryMessageBookmark: (request: { auxiliarySessionId: string }) =>
      mutationCalls.push(`aux-bookmark:${request.auxiliarySessionId}`),
  });

  registerMainIpcHandlers(ipcMain, deps);
  const sessionIdentity = {
    sessionId: "session-1",
    incarnationId: "incarnation-1",
  };
  await handlers.get(WITHMATE_SET_SESSION_EXECUTION_OPTIONS_CHANNEL)?.(
    {},
    {
      ...sessionIdentity,
      executionOptions: {},
    },
  );
  assert.strictEqual(
    await handlers.get(WITHMATE_SET_SESSION_TITLE_CHANNEL)?.(
      {},
      { ...sessionIdentity, title: "Updated" },
    ),
    titleResult,
  );
  await handlers.get(WITHMATE_SET_SESSION_MESSAGE_BOOKMARK_CHANNEL)?.(
    {},
    {
      ...sessionIdentity,
      messageIndex: 2,
      isBookmarked: true,
    },
  );
  currentWindow = otherWindow;
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_SET_SESSION_TITLE_CHANNEL)?.(
        {},
        { ...sessionIdentity, title: "Rejected" },
      ) as Promise<unknown>,
    /target Session window/,
  );
  currentWindow = ownerWindow;

  const auxiliaryIdentity = {
    auxiliarySessionId: "aux-1",
    parentSessionId: "session-1",
    createdAt: "2026-07-04T00:00:00.000Z",
  };
  await handlers.get(WITHMATE_SET_AUXILIARY_EXECUTION_OPTIONS_CHANNEL)?.(
    {},
    {
      ...auxiliaryIdentity,
      executionOptions: {},
    },
  );
  await handlers.get(WITHMATE_SET_AUXILIARY_TITLE_CHANNEL)?.(
    {},
    { ...auxiliaryIdentity, title: "Updated" },
  );
  await handlers.get(WITHMATE_SET_AUXILIARY_MESSAGE_BOOKMARK_CHANNEL)?.(
    {},
    {
      ...auxiliaryIdentity,
      messageIndex: 3,
      isBookmarked: true,
    },
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_SET_AUXILIARY_TITLE_CHANNEL)?.(
        {},
        {
          ...auxiliaryIdentity,
          createdAt: "stale-created-at",
          title: "Rejected",
        },
      ) as Promise<unknown>,
    /identity is stale or invalid/,
  );

  assert.deepEqual(mutationCalls, [
    "session-options:session-1",
    "session-title:session-1",
    "session-bookmark:session-1",
    "aux-options:aux-1",
    "aux-title:aux-1",
    "aux-bookmark:aux-1",
  ]);
  assert.equal(fullAuxiliaryReads, 0);
});

// @test-value v2
// kind = "security"
// claim = "owning Session WindowのTurn拒否ログは本文を除外し正規request IDだけを相関情報として残す"
// oracle = { type = "contract", ref = "src-electron/ipc/register-main-ipc.ts IPC failure correlation" }
// fault = "拒否ログへ本文または不正request identity文字列を記録する"
// observable = "IPC rejectとlog payloadのchannel/request ID、本文不在"
// observation_boundary = "public-boundary"
// scope = "Main turn IPC diagnostic privacy"
// lifecycle = "permanent"
// impact = "利用者の入力本文が不要な診断ログへ流出する"
// distinction = "型検査は実際のlogger payloadとruntime正規化を検証しない"
// @end-test-value
/** turn の拒否を記録するとき、正規の client request ID だけを相関情報に使い、本文や任意文字列をログに含めないことを確認する。 */
test("run-session-turn IPC拒否ログは本文を含めずclient request IDを相関情報として渡す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const owner = createWindowStub("file:///session.html?sessionId=session-1");
  const errors: Array<{ channel: string; clientRequestId?: string }> = [];
  const { deps } = createDeps({
    /** 送信元を所有 Window に固定し、認可後に起きる turn の失敗を観測する。 */
    resolveEventWindow: () => owner,
    /** 拒否される turn の対象 Session にだけ所有 Window を割り当てる。 */
    resolveSessionWindow: (id: string) => (id === "session-1" ? owner : null),
    /** 認可を通った後で turn を拒否し、Main のエラーログ処理を起動する。 */
    runSessionTurn: async () => {
      throw new Error("このセッションはまだ実行中だよ。");
    },
    /** エラー記録に渡った値を保持し、本文を含まないことを観測する。 */
    logIpcError: (input: { channel: string; clientRequestId?: string }) => {
      errors.push(input);
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () =>
      handlers.get(WITHMATE_RUN_SESSION_TURN_CHANNEL)?.({}, "session-1", {
        userMessage: "ログへ出してはいけない本文",
        clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94bc",
      }) as Promise<unknown>,
    /まだ実行中/,
  );

  assert.deepEqual(
    errors.map(({ channel, clientRequestId }) => ({
      channel,
      clientRequestId,
    })),
    [
      {
        channel: WITHMATE_RUN_SESSION_TURN_CHANNEL,
        clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94bc",
      },
    ],
  );
  assert.doesNotMatch(JSON.stringify(errors), /ログへ出してはいけない本文/);

  await assert.rejects(
    () =>
      handlers.get(WITHMATE_RUN_SESSION_TURN_CHANNEL)?.({}, "session-1", {
        userMessage: "please use secretprompt",
        clientRequestId: "secretprompt",
        submitSource: "secretprompt",
      }) as Promise<unknown>,
    /まだ実行中/,
  );
  assert.equal(errors.at(-1)?.clientRequestId, undefined);
  assert.doesNotMatch(JSON.stringify(errors.at(-1)), /secretprompt/);
});

// @test-value v2
// kind = "security"
// claim = "Session Folder cleanupのscan/runはSettings以外と不正入力をservice前に拒否し、正常なrenderer要求と結果を保持する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md" }
// fault = "非Settings senderや不正条件でcleanup serviceを呼ぶか、preloadからscan条件とscan IDを欠落・取り違えする"
// observable = "renderer APIの返却値、serviceに渡ったrequest、拒否Errorとservice呼出件数"
// observation_boundary = "public-boundary"
// scope = "registered Session Folder cleanup IPC and preload authorization/validation"
// lifecycle = "permanent"
// risk_tags = ["authorization", "irreversible-data-loss"]
// impact = "許可されていないWindowや不正入力によるfile完全削除を防ぐ"
// distinction = "serviceのfilesystem testや型checkではrendererから登録済みIPCまでのsender認可、runtime parseとpayload伝達を検証できない"
// @end-test-value
/** Session Folder のスキャンと整理要求を Settings と正しい入力に限定し、正常な要求と応答を preload 経由で保持することを確認する。 */
test("Session Folder cleanup IPCはSettings認可とparseを通してrenderer要求を保持する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const settings = createWindowStub("file:///settings.html");
  let sender: unknown = settings;
  const requests: Array<{ method: string; request: unknown }> = [];
  const scanResult = {
    scanId: "confirmed-scan",
    matchedFileCount: 2,
    matchedBytes: 2048,
  };
  const runResult = {
    deletedFileCount: 2,
    deletedBytes: 2048,
    skippedFileCount: 0,
    failedFileCount: 0,
    issues: [],
  };
  const { deps } = createDeps({
    /** 同じ整理操作の送信元を Settings とその他の Window で切り替える。 */
    resolveEventWindow: () => sender,
    /** Session Folder 整理を使える Window を Settings に限定する。 */
    isSettingsWindow: (window: unknown) => window === settings,
    /** スキャンの入力を記録し、整理実行の参照に使う結果を返す。 */
    scanSessionFolderCleanup: async (request: unknown) => {
      requests.push({ method: "scan", request });
      return scanResult;
    },
    /** 整理実行に届くスキャン ID を記録し、実ファイルを削除せず実行結果を返す。 */
    runSessionFolderCleanup: async (request: unknown) => {
      requests.push({ method: "run", request });
      return runResult;
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  const api = createWithMateWindowApi({
    /** preload が選んだ整理チャネルの登録を確認して Main のハンドラーに渡す。 */
    async invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel);
      assert.ok(handler, `Unregistered IPC: ${channel}`);
      return handler({}, ...args);
    },
    /** 整理操作ではイベントを配信しないため、購読登録を受け付けるだけにする。 */
    on() {},
    /** 登録を保持しないため、購読解除の副作用はない。 */ removeListener() {},
    /** 整理は invoke で検証し、片方向通信は処理しない。 */ send() {},
  } as never);
  const request = {
    fromDate: "2026-05-01",
    toDate: "2026-05-31",
    minimumFileSizeMiB: 0.1,
  };
  assert.deepEqual(await api.scanSessionFolderCleanup(request), scanResult);
  assert.deepEqual(
    await api.runSessionFolderCleanup({ scanId: scanResult.scanId }),
    runResult,
  );
  assert.deepEqual(requests, [
    { method: "scan", request },
    { method: "run", request: { scanId: scanResult.scanId } },
  ]);
  for (const input of [
    null,
    { ...request, fromDate: "2026-02-30" },
    { ...request, minimumFileSizeMiB: -1 },
  ]) {
    await assert.rejects(
      api.scanSessionFolderCleanup(input as never),
      TypeError,
    );
  }
  for (const input of [null, {}, { scanId: "" }]) {
    await assert.rejects(
      api.runSessionFolderCleanup(input as never),
      TypeError,
    );
  }
  for (const window of [
    createWindowStub("file:///home.html"),
    createWindowStub("file:///session.html?sessionId=main"),
    null,
  ]) {
    sender = window;
    await assert.rejects(
      api.scanSessionFolderCleanup(request),
      /Settings IPC is only available/,
    );
    await assert.rejects(
      api.runSessionFolderCleanup({ scanId: scanResult.scanId }),
      /Settings IPC is only available/,
    );
  }
  assert.equal(requests.length, 2);
});

/** Settings から活動時刻を条件にした一括削除へ到達し、削除結果を受け取れることを確認する。 */
test("Storage Maintenance の bulk session delete IPC は Settings window からだけ呼び出せる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const settingsWindow = createWindowStub(
    "http://localhost:5173/?mode=settings",
  );
  const { deps, calls } = createDeps({
    /** 一括削除の送信元を Settings として解決する。 */
    resolveEventWindow: () => settingsWindow,
    /** 認可対象を一括削除用の Settings Window と一致させる。 */
    isSettingsWindow: (window: unknown) => window === settingsWindow,
    /** 一括削除への委譲を記録し、既知の Session が削除された想定の応答を返す。 */
    deleteSessionsLastActiveBefore: async () => {
      calls.push("deleteSessionsLastActiveBefore");
      return { deletedSessionIds: ["session-1"], skippedRunningSessionIds: [] };
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL)?.(
      {},
      { cutoffDate: "2026-07-01" },
    ),
    { deletedSessionIds: ["session-1"], skippedRunningSessionIds: [] },
  );
  assert.deepEqual(calls, ["deleteSessionsLastActiveBefore"]);
});

/** Home、Settings、削除対象自身の Session Window の三つから、同じ ID の単体削除を要求できることを確認する。 */
test("single session delete IPC は Home / Settings / 対象 Session window から呼び出せる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  const settingsWindow = createWindowStub(
    "http://localhost:5173/?mode=settings",
  );
  const sessionWindow = createWindowStub(
    "http://localhost:5173/?mode=agent&sessionId=session-1",
  );
  let eventWindow: unknown = homeWindow;
  const { deps, calls } = createDeps({
    /** 三つの許可済み Window のどれが送信元かをテストから切り替える。 */
    resolveEventWindow: () => eventWindow,
    /** 単体削除の呼び出し元候補として Home Window を返す。 */
    resolveHomeWindow: () => homeWindow,
    /** 削除対象の Session ID に一致したときだけ、その Session Window を返す。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? sessionWindow : null,
    /** 単体削除のもう一つの呼び出し元候補として指定した Settings を認可する。 */
    isSettingsWindow: (window: unknown) => window === settingsWindow,
    /** 指定 Window からの削除が委譲されたことを、対象 ID 付きで記録する。 */
    deleteSession: async (sessionId: string) => {
      calls.push(`deleteSession:${sessionId}`);
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await handlers.get(WITHMATE_DELETE_SESSION_CHANNEL)?.({}, "session-1");
  eventWindow = settingsWindow;
  await handlers.get(WITHMATE_DELETE_SESSION_CHANNEL)?.({}, "session-1");
  eventWindow = sessionWindow;
  await handlers.get(WITHMATE_DELETE_SESSION_CHANNEL)?.({}, "session-1");

  assert.deepEqual(calls, [
    "deleteSession:session-1",
    "deleteSession:session-1",
    "deleteSession:session-1",
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "Home・Settings・削除対象SessionのいずれでもないWindowからのSession削除IPCを拒否し、削除処理へ委譲しない"
// oracle = { type = "contract", ref = "src-electron/ipc/shared.ts: assertSessionDeleteSender" }
// fault = "無関係なWindowからの削除要求を許可するか、拒否してもdeleteSessionを実行する"
// observable = "登録済み削除IPC handlerの拒否errorとdeleteSession:session-1の呼出記録の不在"
// observation_boundary = "public-boundary"
// scope = "Session削除IPCのWindow認可と削除委譲"
// lifecycle = "permanent"
// impact = "無関係なWindowからSessionを削除されることを防ぐ"
// distinction = "型検査では実行時の送信Windowと認可前の削除副作用を判定できない"
// risk_tags = ["authorization", "irreversible-data-loss"]
// @end-test-value
/** Home・Settings・対象 Session のいずれでもない Window の単体削除を、依存先を呼ぶ前に拒否することを確認する。 */
test("single session delete IPC は許可されていない window からの呼び出しを拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const otherWindow = createWindowStub(
    "http://localhost:5173/?mode=other-window",
  );
  const homeWindow = createWindowStub("http://localhost:5173/");
  const sessionWindow = createWindowStub(
    "http://localhost:5173/?mode=agent&sessionId=session-1",
  );
  const { deps, calls } = createDeps({
    /** 単体削除を許可されていない Window を実際の送信元として返す。 */
    resolveEventWindow: () => otherWindow,
    /** 送信元とは異なる Home Window を登録して認可比較に使う。 */
    resolveHomeWindow: () => homeWindow,
    /** 削除される Session の正規の Window を返し、実際の送信元と区別する。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? sessionWindow : null,
    /** 呼び出し元が Settings ではないことを示す。 */
    isSettingsWindow: () => false,
    /** 認可漏れがあれば実際の削除依頼が記録に残るようにする。 */
    deleteSession: async (sessionId: string) => {
      calls.push(`deleteSession:${sessionId}`);
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () =>
      handlers.get(WITHMATE_DELETE_SESSION_CHANNEL)?.(
        {},
        "session-1",
      ) as Promise<unknown>,
    /Session delete IPC is only available/,
  );
  assert.equal(calls.includes("deleteSession:session-1"), false);
});

/** Home からの一括削除を拒否し、単体削除で認める Home 権限が一括削除へ波及しないことを確認する。 */
test("Storage Maintenance の bulk session delete IPC は Settings window 以外からの呼び出しを拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  const { deps, calls } = createDeps({
    /** 一括削除を要求した送信元を Home として解決する。 */
    resolveEventWindow: () => homeWindow,
    /** この送信元に一括削除を許可する Settings 権限を付けない。 */
    isSettingsWindow: () => false,
    /** 認可漏れで一括削除が呼ばれた場合に観測できるよう、履歴に記録する。 */
    deleteSessionsLastActiveBefore: async () => {
      calls.push("deleteSessionsLastActiveBefore");
      return { deletedSessionIds: ["session-1"], skippedRunningSessionIds: [] };
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () =>
      handlers.get(WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL)?.(
        {},
        { cutoffDate: "2026-07-01" },
      ) as Promise<unknown>,
    /Settings IPC is only available/,
  );
  assert.equal(calls.includes("deleteSessionsLastActiveBefore"), false);
});

/** Settings から DB リセットを実行するための専用ハンドラーが、依存先の結果を返すことを確認する。 */
test("DB reset IPC は Settings window からだけ呼び出せる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const settingsWindow = createWindowStub(
    "http://localhost:5173/?mode=settings",
  );
  const { deps, calls } = createDeps({
    /** DB リセットの送信元として Settings Window を返す。 */
    resolveEventWindow: () => settingsWindow,
    /** リセットを許可する Settings の同一性を照合する。 */
    isSettingsWindow: (window: unknown) => window === settingsWindow,
    /** DB を変更せずリセット依頼が委譲されたことを記録し、成功結果を返す。 */
    resetAppDatabase: async () => {
      calls.push("resetAppDatabase");
      return { ok: true };
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(WITHMATE_RESET_APP_DATABASE_CHANNEL)?.(
      {},
      { targets: ["sessions"] },
    ),
    { ok: true },
  );
  assert.deepEqual(calls, ["resetAppDatabase"]);
});

/** Settings ではない Window からの DB リセットを依存先に渡さないことを確認する。 */
test("DB reset IPC は Settings window 以外からの呼び出しを拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  const { deps, calls } = createDeps({
    /** DB リセットを要求する非 Settings の送信元を Home として解決する。 */
    resolveEventWindow: () => homeWindow,
    /** リセットに必要な Settings 権限を持たないことを示す。 */
    isSettingsWindow: () => false,
    /** 送信元の認可漏れがあればリセット呼び出しが記録されるようにする。 */
    resetAppDatabase: async () => {
      calls.push("resetAppDatabase");
      return { ok: true };
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () =>
      handlers.get(WITHMATE_RESET_APP_DATABASE_CHANNEL)?.(
        {},
        { targets: ["sessions"] },
      ) as Promise<unknown>,
    /Settings IPC is only available/,
  );
  assert.equal(calls.includes("resetAppDatabase"), false);
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary owner windowの作成とruntime selectionを対象Sessionへ限定する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#context-boundary" }
// fault = "別windowがAuxiliaryを作成し、親Sessionのruntime selectionを越えて処理する"
// observable = "owner windowからの作成委譲と不正selectionの拒否"
// observation_boundary = "public-boundary"
// scope = "main-ipc-auxiliary-owner-boundary"
// lifecycle = "permanent"
// @end-test-value
/** Auxiliary の作成要求を所有 Window と許可された runtime 選択に限定し、認可された入力だけを作成処理へ渡すことを確認する。 */
test("Auxiliary create IPC は送信元 window と runtime selection mode を結び付ける", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const sessionWindow = createWindowStub(
    "http://localhost:5173/?mode=agent&sessionId=session-1",
  );
  const otherSessionWindow = createWindowStub(
    "http://localhost:5173/?mode=agent&sessionId=session-2",
  );
  const auxiliarySession = createAuxiliarySessionStub();
  let eventWindow: unknown = sessionWindow;
  const forwardedInputs: unknown[] = [];
  const { deps } = createDeps({
    /** Auxiliary の作成発行元として、その時点で選択された Window を返す。 */
    resolveEventWindow: () => eventWindow,
    /** 要求した親に応じて所有 Window を切り替え、別 Session からの作成要求を区別する。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? sessionWindow : otherSessionWindow,
    /** IPC の確認を通過した作成入力を記録し、合成の Auxiliary を返す。 */
    createAuxiliarySession: async (input: unknown) => {
      forwardedInputs.push(input);
      return auxiliarySession;
    },
  });

  registerMainIpcHandlers(ipcMain, deps);
  const createHandler = handlers.get(WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL);

  await assert.rejects(
    () =>
      createHandler?.(
        {},
        {
          parentSessionId: "session-1",
          provider: "codex",
          runtimeSelection: "explicit",
          approvalMode: "never",
          codexSandboxMode: "danger-full-access",
        },
      ) as Promise<unknown>,
    /requires latest-session runtime selection/,
  );
  await assert.rejects(
    () =>
      createHandler?.(
        {},
        {
          parentSessionId: "session-1",
          provider: "codex",
          runtimeSelection: "latest-session",
          approvalMode: undefined,
        },
      ) as Promise<unknown>,
    /cannot specify runtime options directly/,
  );
  await assert.rejects(
    () =>
      createHandler?.(
        {},
        {
          parentSessionId: "session-1",
          provider: "codex",
          runtimeSelection: "latest-session",
          creationContext: {
            generationId: "generation-1",
            parentIncarnationId: "incarnation-1",
          },
        },
      ) as Promise<unknown>,
    /clientRequestId.*creationContext/,
  );
  await assert.rejects(
    () =>
      createHandler?.(
        {},
        {
          parentSessionId: "session-1",
          provider: "codex",
          runtimeSelection: "latest-session",
          clientRequestId: "ipc-create-missing-context",
        },
      ) as Promise<unknown>,
    /clientRequestId.*creationContext/,
  );
  await assert.rejects(
    () =>
      createHandler?.(
        {},
        {
          parentSessionId: "session-1",
          provider: "codex",
          runtimeSelection: "latest-session",
          codexReviewer: undefined,
        },
      ) as Promise<unknown>,
    /cannot specify runtime options directly/,
  );
  await createHandler?.(
    {},
    {
      parentSessionId: "session-1",
      provider: "codex",
      runtimeSelection: "latest-session",
      clientRequestId: "ipc-create-2",
      creationContext: {
        generationId: "generation-1",
        parentIncarnationId: "incarnation-1",
      },
    },
  );

  assert.deepEqual(forwardedInputs, [
    {
      parentSessionId: "session-1",
      provider: "codex",
      runtimeSelection: "latest-session",
      clientRequestId: "ipc-create-2",
      creationContext: {
        generationId: "generation-1",
        parentIncarnationId: "incarnation-1",
      },
    },
  ]);

  eventWindow = otherSessionWindow;
  await assert.rejects(
    () =>
      createHandler?.(
        {},
        {
          parentSessionId: "session-1",
          provider: "codex",
          runtimeSelection: "latest-session",
          clientRequestId: "ipc-create-other-owner",
          creationContext: {
            generationId: "generation-1",
            parentIncarnationId: "incarnation-1",
          },
        },
      ) as Promise<unknown>,
    /only available from the target Session window/,
  );
  assert.deepEqual(forwardedInputs, [
    {
      parentSessionId: "session-1",
      provider: "codex",
      runtimeSelection: "latest-session",
      clientRequestId: "ipc-create-2",
      creationContext: {
        generationId: "generation-1",
        parentIncarnationId: "incarnation-1",
      },
    },
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary creationのcontext取得・cancel・query IPCはSession owner windowへ限定される"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#context-boundary" }
// fault = "別windowが作成取消または結果照会を実行し、親scopeを越えてMain dependencyへ到達する"
// observable = "ownerからの委譲と非ownerからの拒否"
// observation_boundary = "public-boundary"
// scope = "auxiliary-creation-ipc-ownership"
// lifecycle = "permanent"
// impact = "遅延した作成要求の取消・結果照会を親Sessionの権限内に限定する"
// distinction = "既存Auxiliary mutation IPC testはcreation専用context/cancel/query channelを確認しない"
// @end-test-value
/** 作成前のコンテキスト取得、作成取消、作成結果照会を親 Session の Window に限定することを確かめる。 */
test("Auxiliary creation IPC はSession ownerだけがcontext/cancel/queryを実行できる", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const sessionWindow = createWindowStub(
    "http://localhost:5173/?mode=agent&sessionId=session-1",
  );
  const unauthorizedWindow = createWindowStub(
    "http://localhost:5173/?mode=settings",
  );
  let eventWindow: unknown = sessionWindow;
  const calls: string[] = [];
  const request = {
    parentSessionId: "session-1",
    clientRequestId: "creation-1",
    creationContext: {
      generationId: "generation-1",
      parentIncarnationId: "incarnation-1",
    },
  };
  const { deps } = createDeps({
    /** 同じ作成補助操作を、所有 Window と対象外 Window から試せるようにする。 */
    resolveEventWindow: () => eventWindow,
    /** 両方のケースで、作成を所有する親の正規 Window を返す。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? sessionWindow : null,
    /** コンテキスト取得に渡された親 ID を記録し、後続の要求に使う照合値を返す。 */
    getAuxiliaryCreationContext: async (parentSessionId: string) => {
      calls.push(`context:${parentSessionId}`);
      return request.creationContext;
    },
    /** 作成取消の委譲を記録し、取消成功の形式を返す。 */
    cancelAuxiliaryCreation: async () => {
      calls.push("cancel");
      return { status: "cancelled" as const };
    },
    /** 作成結果照会の委譲を記録し、作成が確定した Auxiliary ID を返す。 */
    getAuxiliaryCreation: async () => {
      calls.push("query");
      return { status: "committed" as const, auxiliarySessionId: "aux-1" };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);
  assert.deepEqual(
    await handlers.get(WITHMATE_GET_AUXILIARY_CREATION_CONTEXT_CHANNEL)?.(
      {},
      "session-1",
    ),
    request.creationContext,
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_CANCEL_AUXILIARY_CREATION_CHANNEL)?.(
      {},
      request,
    ),
    { status: "cancelled" },
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_GET_AUXILIARY_CREATION_CHANNEL)?.({}, request),
    {
      status: "committed",
      auxiliarySessionId: "aux-1",
    },
  );
  eventWindow = unauthorizedWindow;
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_GET_AUXILIARY_CREATION_CONTEXT_CHANNEL)?.(
        {},
        "session-1",
      ) as Promise<unknown>,
    /Auxiliary session IPC is only available/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_CANCEL_AUXILIARY_CREATION_CHANNEL)?.(
        {},
        request,
      ) as Promise<unknown>,
    /Auxiliary session IPC is only available/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_GET_AUXILIARY_CREATION_CHANNEL)?.(
        {},
        request,
      ) as Promise<unknown>,
    /Auxiliary session IPC is only available/,
  );
  assert.deepEqual(calls, ["context:session-1", "cancel", "query"]);
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary draft IPCはreadをownerへ、mutationをSession ownerへ限定する"
// oracle = { type = "contract", ref = "src-electron/ipc/register-main-ipc.ts" }
// fault = "Homeや別Session Windowへdraftを公開するか、parent不一致のdraft保存を許可する"
// observable = "ownerのdraft/statusと保存結果、対象外Windowのrejection、parent不一致のnot-found、storage呼出し一覧"
// observation_boundary = "public-boundary"
// scope = "main IPC auxiliary draft ownership"
// lifecycle = "permanent"
// @end-test-value
/** Auxiliary の草稿と状態の読み取り・草稿保存に親 Window の認可を求め、保存時に不一致の親 ID を受け付けないことを確かめる。 */
test("Auxiliary draft IPC はreadをownerへ、mutationをSession ownerへ限定する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const sessionWindow = createWindowStub(
    "http://localhost:5173/?mode=agent&sessionId=session-1",
  );
  const otherSessionWindow = createWindowStub(
    "http://localhost:5173/?mode=agent&sessionId=session-2",
  );
  const homeWindow = createWindowStub("http://localhost:5173/");
  const auxiliarySession = createAuxiliarySessionStub();
  const draft = {
    auxiliarySessionId: "aux-1",
    parentSessionId: "session-1",
    incarnation: "incarnation-1",
    durableRevision: 3,
    text: "draft",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
  const status = {
    id: "aux-1",
    parentSessionId: "session-1",
    status: "active" as const,
    createdAt: auxiliarySession.createdAt,
    incarnation: draft.incarnation,
    runState: "idle" as const,
  };
  let eventWindow: unknown = sessionWindow;
  const calls: string[] = [];
  const { deps } = createDeps({
    /** 保存済み草稿の要求を親 Window と対象外 Window の間で切り替える。 */
    resolveEventWindow: () => eventWindow,
    /** 親 Session ID に対応する Window を解決し、実際の送信元との一致を確認できるようにする。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1"
        ? sessionWindow
        : sessionId === "session-2"
          ? otherSessionWindow
          : null,
    /** 草稿の親と incarnation を照合する状態を返し、検索対象が Auxiliary 自身の ID であることを確認する。 */
    getAuxiliarySessionStatus: async (auxiliarySessionId: string) => {
      assert.equal(auxiliarySessionId, "aux-1");
      return status;
    },
    /** 認可後の草稿読み取りを数え、保存済み草稿そのものを返す。 */
    getAuxiliaryDraft: async () => {
      calls.push("getAuxiliaryDraft");
      return draft;
    },
    /** 保存まで到達したことを記録し、新しい durable revision を含む ACK を返す。 */
    saveAuxiliaryDraft: async () => {
      calls.push("saveAuxiliaryDraft");
      return {
        outcome: "saved",
        ack: {
          auxiliarySessionId: "aux-1",
          incarnation: draft.incarnation,
          durableRevision: 4,
          updatedAt: draft.updatedAt,
        },
      };
    },
  });
  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(WITHMATE_GET_AUXILIARY_DRAFT_CHANNEL)?.({}, "aux-1"),
    draft,
  );
  assert.deepEqual(
    await handlers.get(WITHMATE_GET_AUXILIARY_SESSION_STATUS_CHANNEL)?.(
      {},
      "aux-1",
    ),
    status,
  );
  const input = {
    auxiliarySessionId: "aux-1",
    parentSessionId: "session-1",
    incarnation: draft.incarnation,
    expectedDurableRevision: draft.durableRevision,
    text: "next",
    updatedAt: draft.updatedAt,
  };
  const savedDraftResult = await handlers.get(
    WITHMATE_SAVE_AUXILIARY_DRAFT_CHANNEL,
  )?.({}, input);
  assert.equal(
    (savedDraftResult as { outcome: string } | undefined)?.outcome,
    "saved",
  );

  for (const unauthorizedWindow of [homeWindow, otherSessionWindow]) {
    eventWindow = unauthorizedWindow;
    await assert.rejects(
      () =>
        handlers.get(WITHMATE_GET_AUXILIARY_DRAFT_CHANNEL)?.(
          {},
          "aux-1",
        ) as Promise<unknown>,
      /Auxiliary session IPC is only available/,
    );
    await assert.rejects(
      () =>
        handlers.get(WITHMATE_GET_AUXILIARY_SESSION_STATUS_CHANNEL)?.(
          {},
          "aux-1",
        ) as Promise<unknown>,
      /Auxiliary session IPC is only available/,
    );
    await assert.rejects(
      () =>
        handlers.get(WITHMATE_SAVE_AUXILIARY_DRAFT_CHANNEL)?.(
          {},
          input,
        ) as Promise<unknown>,
      /Auxiliary session IPC is only available/,
    );
  }
  eventWindow = sessionWindow;
  const mismatchedParentInput = { ...input, parentSessionId: "other-parent" };
  assert.deepEqual(
    await handlers.get(WITHMATE_SAVE_AUXILIARY_DRAFT_CHANNEL)?.(
      {},
      mismatchedParentInput,
    ),
    { outcome: "not-found" },
  );
  assert.deepEqual(calls, ["getAuxiliaryDraft", "saveAuxiliaryDraft"]);
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary mutation/run IPCは対象外windowからdepsへ到達させない"
// oracle = { type = "contract", ref = "src-electron/ipc/auxiliary.ts: assertAuxiliaryOwnerWindowSender" }
// fault = "Home、Settings、Diff、MonitorからAuxiliaryの作成・更新・実行・取消を許可する"
// observable = "各対象外Windowからの4操作のrejectionとmutationCallsが空であること"
// observation_boundary = "public-boundary"
// scope = "auxiliary-mutation-ipc-owner-authorization"
// lifecycle = "permanent"
// @end-test-value
/** 所有者ではない Window から、Auxiliary の作成・更新・実行・取消が各依存先に到達しないことを確認する。 */
test("Auxiliary mutation/run IPC は対象外 window から deps mutation/run に到達しない", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const sessionWindow = createWindowStub(
    "http://localhost:5173/?mode=agent&sessionId=session-1",
  );
  const auxiliarySession = createAuxiliarySessionStub();
  let eventWindow: unknown = createWindowStub("http://localhost:5173/");
  const mutationCalls: string[] = [];
  const { deps } = createDeps({
    /** 各変更要求を発行した対象外 Window を順に切り替える。 */
    resolveEventWindow: () => eventWindow,
    /** Auxiliary の親 Session にだけ正しい所有 Window を返す。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? sessionWindow : null,
    /** 既存 Auxiliary の親を Main の認可処理に提供する。 */
    getAuxiliarySession: async () => auxiliarySession,
    /** 誤認可で作成処理へ到達した場合、呼び出しが履歴に残るようにする。 */
    createAuxiliarySession: async () => {
      mutationCalls.push("createAuxiliarySession");
      return auxiliarySession;
    },
    /** 誤認可で更新処理へ到達した場合、他の変更操作と区別して記録する。 */
    updateAuxiliarySession: async () => {
      mutationCalls.push("updateAuxiliarySession");
      return auxiliarySession;
    },
    /** 対象外 Window の実行が依存先に届いた場合、履歴に残す。 */
    runAuxiliarySessionTurn: async () => {
      mutationCalls.push("runAuxiliarySessionTurn");
      return auxiliarySession;
    },
    /** 実行取消まで誤って到達していないかを呼び出し履歴で観測する。 */
    cancelAuxiliarySessionRun: async () => {
      mutationCalls.push("cancelAuxiliarySessionRun");
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  const unauthorizedWindows = [
    createWindowStub("http://localhost:5173/"),
    createWindowStub("http://localhost:5173/?mode=settings"),
    createWindowStub("http://localhost:5173/?mode=diff&token=diff-1"),
    createWindowStub("http://localhost:5173/?mode=monitor"),
  ];

  for (const window of unauthorizedWindows) {
    eventWindow = window;
    await assert.rejects(
      () =>
        handlers.get(WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL)?.(
          {},
          {
            parentSessionId: "session-1",
            provider: "codex",
          },
        ) as Promise<unknown>,
      /Auxiliary session IPC is only available/,
    );
    await assert.rejects(
      () =>
        handlers.get(WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL)?.(
          {},
          auxiliarySession,
        ) as Promise<unknown>,
      /Auxiliary session IPC is only available/,
    );
    await assert.rejects(
      () =>
        handlers.get(WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL)?.(
          {},
          "aux-1",
          { userMessage: "hello" },
        ) as Promise<unknown>,
      /Auxiliary session IPC is only available/,
    );
    await assert.rejects(
      () =>
        handlers.get(WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL)?.(
          {},
          {
            sessionId: "aux-1",
            incarnationId: auxiliarySession.createdAt,
            execution: { kind: "turn", id: "1" },
          },
        ) as Promise<unknown>,
      /Auxiliary session IPC is only available/,
    );
  }

  assert.deepEqual(mutationCalls, []);
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary detail IPCは対象外windowからの要求を本文取得前に拒否しsummary listだけを許可する"
// oracle = { type = "contract", ref = "src-electron/ipc/auxiliary.ts: registerAuxiliaryHandlers" }
// fault = "Homeへのsummary取得を拒否するか、owner外の要求でAuxiliary本文を取得する"
// observable = "summary件数1、active/detail取得のrejection、両方の本文取得呼出がないこと"
// observation_boundary = "public-boundary"
// scope = "tests/integration/main-ipc-registration.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** Home には Auxiliary の軽量一覧を返せる一方、個別・最新の本文を読む前には拒否することを確認する。 */
test("Auxiliary detail IPC は対象外 window の要求を本文取得前に拒否し、summary list は許可する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const homeWindow = createWindowStub("http://localhost:5173/");
  const sessionWindow = createWindowStub(
    "http://localhost:5173/?mode=agent&sessionId=session-1",
  );
  const auxiliarySession = createAuxiliarySessionStub();
  const detailReadCalls: string[] = [];
  const { deps } = createDeps({
    /** 詳細読み取りと一覧の両方が Home から呼ばれるよう固定する。 */
    resolveEventWindow: () => homeWindow,
    /** 詳細を読める正規の Session Window を Home とは別に返す。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? sessionWindow : null,
    /** 本文と Composer 草稿を含まない一覧用の Auxiliary を返す。 */
    listAuxiliarySessions: async () => [
      createAuxiliarySessionStub({
        messages: undefined,
        composerDraft: undefined,
      }),
    ],
    /** Home から最新の詳細を取得しようとして依存先まで届いたかを記録する。 */
    getLatestAuxiliarySession: async () => {
      detailReadCalls.push("getLatestAuxiliarySession");
      return auxiliarySession;
    },
    /** Home から個別の詳細が依存先に達した場合に、最新取得とは別名で記録する。 */
    getAuxiliarySession: async () => {
      detailReadCalls.push("getAuxiliarySession");
      return auxiliarySession;
    },
    /** 個別の詳細取得を認可するため、本文や草稿を含まない Auxiliary の状態を返す。 */
    getAuxiliarySessionStatus: async () => ({
      id: auxiliarySession.id,
      parentSessionId: auxiliarySession.parentSessionId,
      createdAt: auxiliarySession.createdAt,
      incarnation: "test",
      runState: auxiliarySession.runState,
    }),
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.equal(
    (
      (await handlers.get(WITHMATE_LIST_AUXILIARY_SESSIONS_CHANNEL)?.(
        {},
        "session-1",
      )) as unknown[]
    ).length,
    1,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_GET_LATEST_AUXILIARY_SESSION_CHANNEL)?.(
        {},
        "session-1",
      ) as Promise<unknown>,
    /Auxiliary session IPC is only available/,
  );
  await assert.rejects(
    () =>
      handlers.get(WITHMATE_GET_AUXILIARY_SESSION_CHANNEL)?.(
        {},
        "aux-1",
      ) as Promise<unknown>,
    /Auxiliary session IPC is only available/,
  );
  assert.deepEqual(detailReadCalls, []);
});

// @test-value v2
// kind = "contract"
// claim = "Home用Auxiliary一覧IPCはMainが確定したopen parent範囲の軽量summaryをそのまま返す"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#live-run-delivery" }
// fault = "renderer指定scopeや別のdetail取得経路を用いて対象外会話やtranscriptをHomeへ渡す"
// observable = "登録済IPC handlerの返却summary、Main側一覧の呼出記録、summaryのmessages/composerDraft不在"
// observation_boundary = "public-boundary"
// scope = "home-auxiliary-summary-ipc"
// lifecycle = "permanent"
// @end-test-value
/** Home 向けの一覧は Main が確定した開いている親の範囲から取得し、本文や草稿を含まないサマリーを返すことを確認する。 */
test("Home 用 Auxiliary summary IPC は main が確定した open parent scope の summary だけを返す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const {
    messages: _messages,
    composerDraft: _composerDraft,
    ...summary
  } = createAuxiliarySessionStub();
  const calls: string[] = [];
  const { deps } = createDeps({
    /** Main 側で対象範囲を決めた一覧経路への委譲を記録し、軽量サマリーを返す。 */
    listOpenAuxiliarySessionSummaries: async () => {
      calls.push("listOpenAuxiliarySessionSummaries");
      return [summary];
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  assert.deepEqual(
    await handlers.get(
      WITHMATE_LIST_OPEN_AUXILIARY_SESSION_SUMMARIES_CHANNEL,
    )?.({}),
    [summary],
  );
  assert.deepEqual(calls, ["listOpenAuxiliarySessionSummaries"]);
  assert.equal("messages" in summary, false);
  assert.equal("composerDraft" in summary, false);
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary update IPCはpayload parentと既存parentの不一致を拒否する"
// oracle = { type = "contract", ref = "src-electron/main-ipc-registration.ts" }
// fault = "保存済みAuxiliaryのparentを別Sessionへ付け替えるpayloadをstorageへ渡す"
// observable = "parent mismatchのrejectionとupdateAuxiliarySessionが呼ばれないこと"
// observation_boundary = "public-boundary"
// scope = "scripts/tests/main-ipc-registration.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** 開いている親 Window が呼び出しても、要求の親 ID が保存済み Auxiliary の親と一致しなければ更新しないことを確認する。 */
test("Auxiliary update IPC は payload parent と既存 parent の不一致を拒否する", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const sessionWindow = createWindowStub(
    "http://localhost:5173/?mode=agent&sessionId=session-1",
  );
  const auxiliarySession = createAuxiliarySessionStub();
  const { deps, calls } = createDeps({
    /** 親として認可され得る Session Window を送信元とする。 */
    resolveEventWindow: () => sessionWindow,
    /** 指定した Main の Window を解決し、認可に必要な Window 所有者を固定する。 */
    resolveSessionWindow: (sessionId: string) =>
      sessionId === "session-1" ? sessionWindow : null,
    /** 更新対象の保存済み Auxiliary を返し、依頼とは異なる親 ID を照合に使う。 */
    getAuxiliarySession: async () => auxiliarySession,
    /** 親 ID 不一致を通り抜けて更新された場合だけ履歴に残るようにする。 */
    updateAuxiliarySession: async () => {
      calls.push("updateAuxiliarySession");
      return auxiliarySession;
    },
  });

  registerMainIpcHandlers(ipcMain, deps);

  await assert.rejects(
    () =>
      handlers.get(WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL)?.(
        {},
        createAuxiliarySessionStub({ parentSessionId: "session-2" }),
      ) as Promise<unknown>,
    /Auxiliary Session parent mismatch/,
  );
  assert.equal(calls.includes("updateAuxiliarySession"), false);
});
