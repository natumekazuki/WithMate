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
  const homeWindow = {};
  const monitorWindow = {};
  const externalWindow = {};
  const homeSender = {};
  const monitorSender = {};
  const externalSender = {};
  const sender = senderKind === "home"
    ? homeSender
    : senderKind === "monitor"
      ? monitorSender
      : externalSender;
  const event = { sender };
  const deps = new Proxy({
    resolveEventWindow: (currentEvent: { sender: unknown }) => {
      if (currentEvent.sender === homeSender) {
        return homeWindow;
      }
      if (currentEvent.sender === monitorSender) {
        return monitorWindow;
      }
      if (currentEvent.sender === externalSender) {
        return externalWindow;
      }
      return null;
    },
    resolveHomeWindow: () => homeWindow,
    isSessionMonitorWindow: (window: unknown) => window === monitorWindow,
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
  return { deps, event };
}

// @test-value v2
// kind = "contract"
// claim = "Session Monitor context menu IPCはHome/Monitorの実Window identityからのAgent/Companion strict requestを変換せずdelegateへ渡し、それ以外のsenderや不正requestを拒否する"
// oracle = { type = "contract", ref = "Session Monitor context menu IPC request boundary" }
// fault = "Home Windowが存在するだけで許可される、許可外senderや不正なkind、Session ID、座標、nested/top-level余分なfieldがnative menu delegateへ到達する、または公開channelにhandlerが登録されない"
// observable = "登録handlerの存在、sender-bearing eventから解決されたWindowの認可、delegateへ渡されたrequest、invalid requestのTypeError"
// observation_boundary = "public-boundary"
// scope = "Main IPC Session Monitor context menu handler"
// lifecycle = "permanent"
// impact = "Monitorから対象外Windowを閉じる入力をMainのmenu処理へ通さない"
// distinction = "native menu itemのkind dispatchやpreload channel変換とは分離してMainのrequest validationを検証する"
// @end-test-value
test("Session Monitor context menu IPCはstrict requestをdelegateへ渡す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const requests: unknown[] = [];
  const home = createDeps(requests);
  registerMainIpcHandlers(ipcMain, home.deps);

  const handler = handlers.get(WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL);
  assert.ok(handler);
  const agentRequest = { kind: "agent", sessionId: "agent-1", point: { x: 24, y: 48 } };
  const companionRequest = { kind: "companion", sessionId: "companion-1", point: { x: 72, y: 96 } };

  assert.deepEqual(await handler(home.event, agentRequest), { status: "dismissed" });
  assert.deepEqual(await handler(home.event, companionRequest), { status: "dismissed" });
  assert.deepEqual(requests, [agentRequest, companionRequest]);

  const monitorIpc = createIpcMainStub();
  const monitorRequests: unknown[] = [];
  const monitor = createDeps(monitorRequests, "monitor");
  registerMainIpcHandlers(monitorIpc.ipcMain, monitor.deps);
  const monitorHandler = monitorIpc.handlers.get(WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL);
  assert.ok(monitorHandler);
  assert.deepEqual(await monitorHandler(monitor.event, agentRequest), { status: "dismissed" });
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
      () => handler(home.event, invalidRequest) as Promise<unknown>,
      /Session Monitor context menu request is invalid/,
    );
  }
  assert.deepEqual(requests, [agentRequest, companionRequest]);

  const unauthorizedIpc = createIpcMainStub();
  const unauthorizedRequests: unknown[] = [];
  const unauthorized = createDeps(unauthorizedRequests, "unauthorized");
  registerMainIpcHandlers(unauthorizedIpc.ipcMain, unauthorized.deps);
  const unauthorizedHandler = unauthorizedIpc.handlers.get(WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL);
  assert.ok(unauthorizedHandler);
  await assert.rejects(
    () => unauthorizedHandler(unauthorized.event, agentRequest) as Promise<unknown>,
    /Session Monitor context menu IPC is only available from Home or Session Monitor window/,
  );
  assert.deepEqual(unauthorizedRequests, []);
});
