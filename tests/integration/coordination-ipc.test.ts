import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow } from "electron";
import { CoordinationDeletedError } from "../../src-electron/coordination/coordination-errors.js";
import type { CoordinationApplicationService } from "../../src-electron/coordination/coordination-application-service.js";
import { registerCoordinationHandlers } from "../../src-electron/ipc/coordination.js";
import type { IpcHandleRegistrar } from "../../src-electron/ipc/contracts.js";

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
  registerCoordinationHandlers(ipc, { service, resolveWindow: () => window, isTrustedWindow: () => true, allWindows: () => [], authorizeRequest: async () => {}, open: async () => window });
  const execute = handlers.get("withmate:coordination:execute")!;
  const event = { sender, senderFrame: mainFrame };
  const request = { operation: "get", id: "missing" };
  assert.deepEqual(await execute(event, request), { error: { code: "COORDINATION_DELETED", message: "Deleted" } });
  failure = new Error("The storage transport disconnected.");
  await assert.rejects(execute(event, request), /transport disconnected/);
});
