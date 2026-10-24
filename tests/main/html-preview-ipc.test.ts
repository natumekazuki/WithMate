import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMainInvokeEvent } from "electron";

import type { IpcHandleRegistrar, MainIpcSessionQueryDeps } from "../../src-electron/ipc/contracts.js";
import { registerSessionQueryHandlers } from "../../src-electron/ipc/session-query.js";
import { WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import { READ_SESSION_HTML_PREVIEW } from "../../src-shared/window/html-preview.js";

function createHarness() {
  const ownerWindow = { id: "owner" };
  const previewWindow = { id: "preview" };
  const foreignWindow = { id: "foreign" };
  const mainFrame = { id: "main-frame" };
  const event = { senderFrame: mainFrame, sender: { mainFrame } };
  const baseResource = { sessionId: "aux-1", absolutePath: "/outside/source.md" };
  const state = {
    window: ownerWindow,
    ownerSessionId: "session-1" as string | null,
    currentBase: baseResource,
    reads: 0,
    genericReads: 0,
    onRead: () => {},
  };
  const result = { html: "<p>private HTML</p>", fileName: "preview.html" };
  const handlers = new Map<string, Parameters<IpcHandleRegistrar["handle"]>[1]>();
  const deps = {
    resolveEventWindow: () => state.window,
    resolveSessionWindow: (id: string) => id === "session-1" ? ownerWindow : null,
    getSessionFileExplorerOwnerSessionId: async (id: string) => ["session-1", "aux-1"].includes(id) ? state.ownerSessionId : null,
    getFilePreviewWindowResource: (window: unknown, id: string) => window === previewWindow && id === "aux-1" ? state.currentBase : null,
    readSessionHtmlPreview: async () => { state.reads += 1; state.onRead(); return result; },
    readSessionFileChunk: async () => { state.genericReads += 1; return { data: new ArrayBuffer(1) }; },
  } as unknown as MainIpcSessionQueryDeps;
  registerSessionQueryHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); } }, deps);
  const invoke = (channel: string, request: unknown) => Promise.resolve(handlers.get(channel)!(event as unknown as IpcMainInvokeEvent, request));
  const read = (request: unknown = { sessionId: "aux-1", target: "/outside/preview.html" }) => invoke(READ_SESSION_HTML_PREVIEW, request);
  return { state, event, ownerWindow, previewWindow, foreignWindow, baseResource, result, read, invoke };
}

// @test-value v2
// kind = "security"
// claim = "HTML link IPCはMain/Auxの親owner windowとcurrent preview baseを許可するがgeneric absolute file read権限は広げない"
// oracle = { type = "contract", ref = "src-electron/ipc/shared.ts: assertSessionFileLinkSender and assertSessionFileResourceSender" }
// fault = "Auxのparent mappingを落とす、current previewを拒否する、またはHTML link権限で一般absolute fileを読む"
// observable = "HTML IPCの返却値、generic readの拒否とservice呼出回数"
// observation_boundary = "public-boundary"
// scope = "registered HTML link IPC and generic file read IPC"
// lifecycle = "permanent"
// impact = "意図したwindowからHTMLを表示しつつ一般fileへの読込権限拡大を防ぐ"
// distinction = "reader testと型検査ではIPC sender認可とgeneric readとの差を確認できない"
// @end-test-value
test("HTML link IPC はMain/Aux ownerとcurrent previewのみ許可しgeneric readは広げない", async () => {
  const harness = createHarness();
  assert.deepEqual(await harness.read({ sessionId: "session-1", target: "/outside/preview.html" }), harness.result);
  assert.deepEqual(await harness.read(), harness.result);
  await assert.rejects(harness.invoke(WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL, {
    sessionId: "aux-1", absolutePath: "/outside/preview.html", offset: 0, length: 1, expectedRevision: "revision",
  }), /current Preview resource/);
  assert.equal(harness.state.genericReads, 0);
  harness.state.window = harness.previewWindow;
  assert.deepEqual(await harness.read({ sessionId: "aux-1", target: "preview.html", baseResource: harness.baseResource }), harness.result);
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
    { sessionId: "aux-1", target: "preview.html", baseResource: { sessionId: "foreign", absolutePath: "/source.md" } },
    { sessionId: "aux-1", target: "preview.html", baseResource: { sessionId: "aux-1", absolutePath: "/source.md", rootId: "workspace" } },
  ]) await assert.rejects(harness.read(request));
  harness.state.window = harness.previewWindow;
  await assert.rejects(harness.read(), /current Preview resource as its base/);
  await assert.rejects(harness.read({ sessionId: "aux-1", target: "preview.html", baseResource: { ...harness.baseResource, absolutePath: "/stale.md" } }), /current Preview resource as its base/);
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
test("HTML link IPC は読込中にowner・base・window・frameが変わると本文を返さない", async () => {
  for (const mutation of ["owner", "base", "window", "frame"] as const) {
    const harness = createHarness();
    const request = { sessionId: "aux-1", target: "preview.html", baseResource: harness.baseResource };
    if (mutation === "base") harness.state.window = harness.previewWindow;
    harness.state.onRead = () => {
      if (mutation === "owner") harness.state.ownerSessionId = null;
      if (mutation === "base") harness.state.currentBase = { ...harness.baseResource, absolutePath: "/changed.md" };
      // A newly resolving, otherwise-authorized window must still fail the same-window check.
      if (mutation === "window") harness.state.window = harness.previewWindow;
      if (mutation === "frame") harness.event.sender.mainFrame = { id: "new-main-frame" };
    };
    await assert.rejects(harness.read(request), /current Preview resource as its base|sender changed/);
    assert.equal(harness.state.reads, 1);
  }
});
