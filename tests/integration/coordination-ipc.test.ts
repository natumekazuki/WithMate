import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow } from "electron";
import { CoordinationDeletedError } from "../../src-electron/coordination/coordination-errors.js";
import type { CoordinationApplicationService } from "../../src-electron/coordination/coordination-application-service.js";
import { registerCoordinationHandlers } from "../../src-electron/ipc/coordination.js";
import type { IpcHandleRegistrar } from "../../src-electron/ipc/contracts.js";
import { createCoordinationApi } from "../../src-electron/preload/coordination-api.js";
import type { IpcRendererLike } from "../../src-electron/preload/ipc.js";

// @test-value v2
// kind = "contract"
// claim = "Coordination GUIの削除済み保存結果だけを終端DTOへ変換し、通信失敗は終端扱いにしない"
// oracle = { type = "contract", ref = "GitHub Issue #839 sections 5-6; review-ui.md UI-2" }
// fault = "Electron IPCでtyped削除codeを失う、または一時通信失敗まで削除結果へ変換する"
// observable = "登録済みIPC execute handlerの戻り値error.codeと一時失敗時のreject"
// observation_boundary = "public-boundary"
// scope = "registerCoordinationHandlers executeのbackend例外とGUI DTO間の変換"
// lifecycle = "permanent"
// impact = "削除済み詳細の復活と一時障害での画面内容消失を防ぐ"
// distinction = "Worker testはElectronの例外変換境界を通らず、renderer fixtureだけでは本番IPCの終端変換を検出しない"
// @end-test-value
test("Coordination IPC returns deleted DTO only for authoritative missing lookups", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipc = { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) } as IpcHandleRegistrar;
  const mainFrame = {};
  const sender = { mainFrame };
  const window = { isDestroyed: () => false } as BrowserWindow;
  let failure: Error = new CoordinationDeletedError("Deleted");
  const service = { executeUser: async () => { throw failure; }, subscribe: () => () => {} } as unknown as CoordinationApplicationService;
  registerCoordinationHandlers(ipc, { service, resolveWindow: () => window, isTrustedWindow: () => true, allWindows: () => [], authorizeRequest: async () => {}, open: async () => window, resolveIdentity: async () => null });
  const execute = handlers.get("withmate:coordination:execute")!;
  const event = { sender, senderFrame: mainFrame };
  const request = { operation: "get", id: "missing" };
  assert.deepEqual(await execute(event, request), { error: { code: "COORDINATION_DELETED", message: "Deleted" } });
  failure = new Error("The storage transport disconnected.");
  await assert.rejects(execute(event, request), /transport disconnected/);
});

// @test-value v2
// kind = "contract"
// claim = "Coordinationの現在表示identityはMain/Auxの厳密identityをpreloadから信頼済みIPCへ渡し、欠落と通信失敗を区別する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Coordination; src-shared/coordination/coordination-window-contract.ts" }
// fault = "incarnationを落とす、余分なidentity fieldを通す、不正Windowへ情報を公開する、または取得失敗を削除済みに変える"
// observable = "preloadから登録handlerへ渡るidentity、表示DTO/null、schema/trust/transportのreject"
// observation_boundary = "public-boundary"
// scope = "Coordination identityのpreloadとIPC境界"
// lifecycle = "permanent"
// impact = "相談相手の誤認と信頼されていないframeからの情報取得を防ぐ"
// distinction = "型検査では外部IPC入力と実preload channelの接続を保証できない"
// @end-test-value
test("Coordination display identity crosses the preload IPC boundary without losing stable identity", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const mainFrame = {};
  const sender = { mainFrame };
  const window = { isDestroyed: () => false } as BrowserWindow;
  const event = { sender, senderFrame: mainFrame };
  const calls: unknown[] = [];
  let trusted = true;
  let fail = false;
  registerCoordinationHandlers({ handle: (channel, handler) => handlers.set(channel, handler) } as IpcHandleRegistrar, {
    service: { subscribe: () => () => {} } as unknown as CoordinationApplicationService,
    resolveWindow: () => window,
    isTrustedWindow: () => trusted,
    allWindows: () => [],
    authorizeRequest: async () => {},
    open: async () => window,
    resolveIdentity: async (identity) => {
      calls.push(identity);
      if (fail) throw new Error("Identity transport disconnected");
      return identity.incarnationId === "current" ? { title: "Current Task", character: { name: "AZKi", iconPath: "icon.png" } } : null;
    },
  });
  const api = createCoordinationApi({ invoke: (channel: string, raw: unknown) => handlers.get(channel)!(event, raw) } as IpcRendererLike);
  for (const kind of ["main", "auxiliary"] as const) {
    const identity = { kind, sessionId: "session", incarnationId: "current" };
    assert.deepEqual(await api.getCoordinationIdentity(identity), { title: "Current Task", character: { name: "AZKi", iconPath: "icon.png" } });
    assert.deepEqual(calls.at(-1), identity);
    assert.equal(await api.getCoordinationIdentity({ ...identity, incarnationId: "replaced" }), null);
  }
  const read = handlers.get("withmate:coordination:identity")!;
  const identity = { kind: "main", sessionId: "session", incarnationId: "current" };
  await assert.rejects(read(event, { ...identity, arbitrary: true }));
  await assert.rejects(read(event, { ...identity, kind: "user" }));
  await assert.rejects(read(event, { kind: "main", sessionId: "session" }));
  await assert.rejects(read({ ...event, senderFrame: {} }, identity), /Invalid Coordination window sender/);
  trusted = false;
  await assert.rejects(read(event, identity), /Invalid Coordination window sender/);
  trusted = true;
  fail = true;
  await assert.rejects(api.getCoordinationIdentity({ ...identity, kind: "main" }), /Identity transport disconnected/);
});
