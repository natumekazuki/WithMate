import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { registerSessionGraphWindowHandlers } from "../../src-electron/ipc/session-graph-window.js";
import type { IpcHandleRegistrar } from "../../src-electron/ipc/contracts.js";
import type { SessionGraphWindowService } from "../../src-electron/session-graph/session-graph-window-service.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";

// @test-value v2
// kind = "invariant"
// claim = "Graph Window IPCは所有Sessionのmain frameからだけ生成できapplyを受け付けない"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "任意Windowやsubframeが親IDを自己申告してGraph windowを作るかapplyを実行する"
// observable = "IPCの拒否とserviceへ到達したopen/read呼出数"
// observation_boundary = "public-boundary"
// scope = "Graph Window IPC sender/operation validation"
// lifecycle = "permanent"
// impact = "別SessionのGraph漏洩やreadonly viewからのデータ改変を許す"
// distinction = "service testはElectron senderFrameとchannel引数の認可を通らない。小さなregistrar fixtureでIPC固有の境界を保証する"
// @end-test-value
test("Graph IPC validates main-frame ownership and excludes apply", async () => {
  const handlers = new Map<string, Parameters<IpcHandleRegistrar["handle"]>[1]>();
  let opens = 0; let reads = 0;
  const window = {} as BrowserWindow;
  const frame = {};
  const event = { sender: { mainFrame: frame }, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const state = { topicId: null, selectedId: null, zoom: 1, scrollLeft: 0, scrollTop: 0 };
  const service = {
    open: async () => { opens++; return { token: "token" }; },
    read: async () => { reads++; },
  } as unknown as SessionGraphWindowService<BrowserWindow>;
  registerSessionGraphWindowHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); } }, {
    service, resolveWindow: () => window, sessionWindow: (id) => id === "owner" ? window : null,
    openReference: async () => {},
  });
  const invoke = async (channel: string, sender: IpcMainInvokeEvent, ...args: unknown[]) => handlers.get(channel)!(sender, ...args);
  await assert.rejects(invoke(channels.WITHMATE_OPEN_SESSION_GRAPH_WINDOW_CHANNEL, event, { sessionId: "other", state }));
  await assert.rejects(invoke(channels.WITHMATE_OPEN_SESSION_GRAPH_WINDOW_CHANNEL, { ...event, senderFrame: {} } as IpcMainInvokeEvent, { sessionId: "owner", state }));
  await assert.rejects(invoke(channels.WITHMATE_READ_SESSION_GRAPH_WINDOW_CHANNEL, event, "token", "apply", { expectedRevision: 0 }));
  assert.equal(opens, 0); assert.equal(reads, 0);
  assert.deepEqual(await invoke(channels.WITHMATE_OPEN_SESSION_GRAPH_WINDOW_CHANNEL, event, { sessionId: "owner", state }), { token: "token" });
  assert.equal(opens, 1);
});
