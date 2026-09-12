import assert from "node:assert/strict";
import test from "node:test";

import type { IpcMain } from "electron";

import { registerMainIpcHandlers } from "../../src-electron/main-ipc-registration.js";
import { WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL } from "../../src/withmate-ipc-channels.js";

type Handler = (...args: unknown[]) => unknown;

function createIpcMainStub() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler);
    },
    on() {},
  };
  return { ipcMain: ipcMain as unknown as IpcMain, handlers };
}

function createDeps(requests: unknown[], senderKind: "home" | "monitor" | "unauthorized" = "home") {
  const senderWindow = {};
  return new Proxy({
    resolveEventWindow: () => senderWindow,
    resolveHomeWindow: () => senderKind === "home" ? senderWindow : null,
    isSessionMonitorWindow: () => senderKind === "monitor",
    isSettingsWindow: () => false,
    isMemoryV6ReviewWindow: () => false,
    isFilePreviewWindow: () => false,
    getFilePreviewWindowResource: () => null,
    isFilePreviewTokenWindow: () => false,
    showSessionMonitorContextMenu: async (_event: unknown, request: unknown) => {
      requests.push(request);
      return { status: "dismissed" as const };
    },
  }, {
    get(target, prop: string) {
      if (prop in target) {
        return target[prop as keyof typeof target];
      }
      return async () => null;
    },
  }) as never;
}

// @test-value v2
// kind = "contract"
// claim = "Session Monitor context menu IPCはHome/MonitorからのAgent/Companion strict requestを変換せずdelegateへ渡し、それ以外のsenderや不正requestを拒否する"
// oracle = { type = "contract", ref = "Session Monitor context menu IPC request boundary" }
// fault = "許可外senderや不正なkind、Session ID、座標、nested/top-level余分なfieldがnative menu delegateへ到達するか、公開channelにhandlerが登録されない"
// observable = "登録handlerの存在、delegateへ渡されたrequest、invalid requestのTypeError"
// observation_boundary = "public-boundary"
// scope = "Main IPC Session Monitor context menu handler"
// lifecycle = "permanent"
// impact = "Monitorから対象外Windowを閉じる入力をMainのmenu処理へ通さない"
// distinction = "native menu itemのkind dispatchやpreload channel変換とは分離してMainのrequest validationを検証する"
// @end-test-value
test("Session Monitor context menu IPCはstrict requestをdelegateへ渡す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const requests: unknown[] = [];
  registerMainIpcHandlers(ipcMain, createDeps(requests));

  const handler = handlers.get(WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL);
  assert.ok(handler);
  const agentRequest = { kind: "agent", sessionId: "agent-1", point: { x: 24, y: 48 } };
  const companionRequest = { kind: "companion", sessionId: "companion-1", point: { x: 72, y: 96 } };

  assert.deepEqual(await handler({}, agentRequest), { status: "dismissed" });
  assert.deepEqual(await handler({}, companionRequest), { status: "dismissed" });
  assert.deepEqual(requests, [agentRequest, companionRequest]);

  const monitorIpc = createIpcMainStub();
  const monitorRequests: unknown[] = [];
  registerMainIpcHandlers(monitorIpc.ipcMain, createDeps(monitorRequests, "monitor"));
  const monitorHandler = monitorIpc.handlers.get(WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL);
  assert.ok(monitorHandler);
  assert.deepEqual(await monitorHandler({}, agentRequest), { status: "dismissed" });
  assert.deepEqual(monitorRequests, [agentRequest]);

  for (const invalidRequest of [
    null,
    { ...agentRequest, kind: "settings" },
    { ...agentRequest, sessionId: "" },
    { ...agentRequest, point: { x: -1, y: 48 } },
    { ...agentRequest, point: { x: 24, y: 1.5 } },
    { ...agentRequest, point: { ...agentRequest.point, extra: true } },
    { ...agentRequest, extra: true },
  ]) {
    await assert.rejects(
      () => handler({}, invalidRequest) as Promise<unknown>,
      /Session Monitor context menu request is invalid/,
    );
  }
  assert.deepEqual(requests, [agentRequest, companionRequest]);

  const unauthorizedIpc = createIpcMainStub();
  const unauthorizedRequests: unknown[] = [];
  registerMainIpcHandlers(unauthorizedIpc.ipcMain, createDeps(unauthorizedRequests, "unauthorized"));
  const unauthorizedHandler = unauthorizedIpc.handlers.get(WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL);
  assert.ok(unauthorizedHandler);
  await assert.rejects(
    () => unauthorizedHandler({}, agentRequest) as Promise<unknown>,
    /Session Monitor context menu IPC is only available from Home or Session Monitor window/,
  );
  assert.deepEqual(unauthorizedRequests, []);
});
