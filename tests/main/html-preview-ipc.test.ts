import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMainInvokeEvent } from "electron";

import type {
  IpcHandleRegistrar,
  MainIpcSessionQueryDeps,
} from "../../src-electron/ipc/contracts.js";
import { registerSessionQueryHandlers } from "../../src-electron/ipc/session-query.js";
import { WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import { READ_SESSION_HTML_PREVIEW } from "../../src-shared/window/html-preview.js";

/** 実際の IPC ハンドラーを捕捉し、送信元と読み込みの境界をテストから制御する。 */
function createHarness() {
  const ownerWindow = { id: "owner" };
  const previewWindow = { id: "preview" };
  const foreignWindow = { id: "foreign" };
  const mainFrame = { id: "main-frame" };
  const event = { senderFrame: mainFrame, sender: { mainFrame } };
  const baseResource = {
    sessionId: "aux-1",
    absolutePath: "/outside/source.md",
  };
  const state = {
    window: ownerWindow,
    ownerSessionId: "session-1" as string | null,
    currentBase: baseResource,
    reads: 0,
    genericReads: 0,
    /** 通常は読み込み中に送信元の状態を変えない。 */
    onRead: () => {},
  };
  const result = { html: "<p>private HTML</p>", fileName: "preview.html" };
  const handlers = new Map<
    string,
    Parameters<IpcHandleRegistrar["handle"]>[1]
  >();
  const deps = {
    /** 現在の送信元としてケースが指定したウィンドウを返す。 */
    resolveEventWindow: () => state.window,
    /** 親セッションの所有ウィンドウを返し、他の ID には割り当てない。 */
    resolveSessionWindow: (id: string) =>
      id === "session-1" ? ownerWindow : null,
    /** 親セッションと Auxiliary の両方を同じ所有者へ対応付ける。 */
    getSessionFileExplorerOwnerSessionId: async (id: string) =>
      ["session-1", "aux-1"].includes(id) ? state.ownerSessionId : null,
    /** Auxiliary を表示する専用プレビューに限り、現在の基点を返す。 */
    getFilePreviewWindowResource: (window: unknown, id: string) =>
      window === previewWindow && id === "aux-1" ? state.currentBase : null,
    /** HTML 読み込み回数を記録し、応答を返す前に状態変更を挟めるようにする。 */
    readSessionHtmlPreview: async () => {
      state.reads += 1;
      state.onRead();
      return result;
    },
    /** 一般ファイル読み込みを HTML とは別に数え、1 バイトの応答を返す。 */
    readSessionFileChunk: async () => {
      state.genericReads += 1;
      return { data: new ArrayBuffer(1) };
    },
  } as unknown as MainIpcSessionQueryDeps;
  registerSessionQueryHandlers(
    {
      /** チャネルと本番ハンドラーの対応を、Electron を起動せずに保持する。 */
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
    deps,
  );
  /** 制御可能な送信イベントで登録済みハンドラーを呼ぶ。 */
  const invoke = (channel: string, request: unknown) =>
    Promise.resolve(
      handlers.get(channel)!(event as unknown as IpcMainInvokeEvent, request),
    );
  /** 既定では Auxiliary の HTML を要求し、任意の要求も同じチャネルに渡せるようにする。 */
  const read = (
    request: unknown = { sessionId: "aux-1", target: "/outside/preview.html" },
  ) => invoke(READ_SESSION_HTML_PREVIEW, request);
  return {
    state,
    event,
    ownerWindow,
    previewWindow,
    foreignWindow,
    baseResource,
    result,
    read,
    invoke,
  };
}

// @test-value v2
// kind = "security"
// claim = "Main/Aux ownerはHTMLと通常fileを読み、detached Previewは現在のbaseだけを利用できる"
// oracle = { type = "contract", ref = "src-electron/ipc/shared.ts: assertSessionFileLinkSender and assertSessionFileResourceSender" }
// fault = "Auxのparent mappingを落とす、通常fileをroot外として拒否する、またはdetached Previewへ他fileの読込を許す"
// observable = "ownerのHTMLと通常fileの応答、detached Previewの不一致file拒否とservice呼出回数"
// observation_boundary = "public-boundary"
// scope = "registered HTML link IPC and generic file read IPC"
// lifecycle = "permanent"
// impact = "ユーザーのfile閲覧とdetached Previewの対象所有境界を維持する"
// distinction = "reader testと型検査ではIPC sender認可とgeneric readとの差を確認できない"
// @end-test-value
/** 所有ウィンドウでは両種の読み込みを許可し、専用プレビューでは現在対象との対応を要求する。 */
test("HTMLと通常fileのIPCはownerと現在のPreview対象を区別する", async () => {
  const harness = createHarness();
  assert.deepEqual(
    await harness.read({
      sessionId: "session-1",
      target: "/outside/preview.html",
    }),
    harness.result,
  );
  assert.deepEqual(await harness.read(), harness.result);
  assert.deepEqual(
    await harness.invoke(WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL, {
      sessionId: "aux-1",
      absolutePath: "/outside/preview.html",
      offset: 0,
      length: 1,
      expectedRevision: "revision",
    }),
    { data: new ArrayBuffer(1) },
  );
  assert.equal(harness.state.genericReads, 1);
  harness.state.window = harness.previewWindow;
  await assert.rejects(
    harness.invoke(WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL, {
      sessionId: "aux-1",
      absolutePath: "/outside/preview.html",
      offset: 0,
      length: 1,
      expectedRevision: "revision",
    }),
    /current Preview resource/,
  );
  assert.deepEqual(
    await harness.read({
      sessionId: "aux-1",
      target: "preview.html",
      baseResource: harness.baseResource,
    }),
    harness.result,
  );
  assert.equal(harness.state.reads, 3);
});

// @test-value v2
// kind = "security"
// claim = "HTML link IPCはforeign window・subframe・不正request・不一致preview baseをreader呼出前に拒否する"
// oracle = { type = "contract", ref = "src-electron/ipc/session-query.ts: READ_SESSION_HTML_PREVIEW sender and request boundary" }
// fault = "未認可frameまたは他session/current resource以外からHTML readerを実行する"
// observable = "各requestの拒否Errorとreader呼出回数ゼロ"
// observation_boundary = "public-boundary"
// scope = "HTML link IPC pre-read authorization"
// lifecycle = "permanent"
// impact = "HTML documentや別windowからローカルfileを読み出す権限逸脱を防ぐ"
// distinction = "reader自身はwindow/frameの権限情報を持たないためIPCでの実行検証が必要"
// @end-test-value
/** 許可されない送信元または無効な要求では、HTML リーダーを呼ばずに拒否する。 */
test("HTML link IPC はforeign sender・subframe・不正baseを読込前に拒否する", async () => {
  const harness = createHarness();
  harness.state.window = harness.foreignWindow;
  await assert.rejects(harness.read(), /current Preview resource as its base/);
  harness.state.window = harness.ownerWindow;
  harness.event.senderFrame = { id: "subframe" };
  await assert.rejects(harness.read(), /main application frame/);
  harness.event.senderFrame = harness.event.sender.mainFrame;
  for (const request of [
    null,
    { sessionId: "aux-1", target: " " },
    { sessionId: "unknown", target: "preview.html" },
    {
      sessionId: "aux-1",
      target: "preview.html",
      baseResource: { sessionId: "foreign", absolutePath: "/source.md" },
    },
    {
      sessionId: "aux-1",
      target: "preview.html",
      baseResource: {
        sessionId: "aux-1",
        absolutePath: "/source.md",
        rootId: "workspace",
      },
    },
  ])
    await assert.rejects(harness.read(request));
  harness.state.window = harness.previewWindow;
  await assert.rejects(harness.read(), /current Preview resource as its base/);
  await assert.rejects(
    harness.read({
      sessionId: "aux-1",
      target: "preview.html",
      baseResource: { ...harness.baseResource, absolutePath: "/stale.md" },
    }),
    /current Preview resource as its base/,
  );
  assert.equal(harness.state.reads, 0);
});

// @test-value v2
// kind = "security"
// claim = "HTML link IPCはreader実行中のowner失効・current base変更・sender window/frame変更後に本文を返さない"
// oracle = { type = "contract", ref = "src-electron/ipc/session-query.ts: READ_SESSION_HTML_PREVIEW post-read authorization" }
// fault = "await後にsenderとcontextを再認可せず失効済みwindowへHTML本文を返す"
// observable = "reader一回実行後のhandler拒否Error"
// observation_boundary = "public-boundary"
// scope = "HTML link IPC post-read lifetime boundary"
// lifecycle = "permanent"
// impact = "読み込み中に権限や表示対象が変わったwindowへの本文漏えいを防ぐ"
// distinction = "事前認可だけのtestではawait境界の権限失効を検出できない"
// @end-test-value
/** 読み込み中に表示先の有効性が変わる場合、取得済みでも本文を返さない。 */
test("HTML link IPC は読込中にowner・base・window・frameが変わると本文を返さない", async () => {
  for (const mutation of ["owner", "base", "window", "frame"] as const) {
    const harness = createHarness();
    const request = {
      sessionId: "aux-1",
      target: "preview.html",
      baseResource: harness.baseResource,
    };
    if (mutation === "base") harness.state.window = harness.previewWindow;
    harness.state.onRead = () => {
      if (mutation === "owner") harness.state.ownerSessionId = null;
      if (mutation === "base")
        harness.state.currentBase = {
          ...harness.baseResource,
          absolutePath: "/changed.md",
        };
      // 解決先が別の Window に変わった場合、他の認可条件を満たしていても、同じ Window かどうかの検査で拒否する。
      if (mutation === "window") harness.state.window = harness.previewWindow;
      if (mutation === "frame")
        harness.event.sender.mainFrame = { id: "new-main-frame" };
    };
    await assert.rejects(
      harness.read(request),
      /current Preview resource as its base|sender changed/,
    );
    assert.equal(harness.state.reads, 1);
  }
});
