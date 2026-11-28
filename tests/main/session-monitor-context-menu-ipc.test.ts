import assert from "node:assert/strict";
import test from "node:test";

import type { IpcMain } from "electron";

import { registerMainIpcHandlers } from "../../src-electron/ipc/register-main-ipc.js";
import { WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";

/** チャンネル単位で記録し、イベントと要求を渡して実行するIPCハンドラーの型。 */
type Handler = (...args: unknown[]) => unknown;

/** Electronを起動せずにMainの登録処理を呼び、公開チャンネルからハンドラーを取り出せるようにする。 */
function createIpcMainStub() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    /** チャンネルと要求応答ハンドラーの組を記録する。 */
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler);
    },
    /** 検証対象外の一方向イベント登録は何も保存しない。 */
    on() {},
  };
  return { ipcMain: ipcMain as unknown as IpcMain, handlers };
}

/** Windowの存在とイベント送信元の一致を分けて検証できるよう、3種類のsenderを用意する。 */
function createDeps(
  requests: unknown[],
  senderKind: "home" | "monitor" | "unauthorized" = "home",
) {
  const homeWindow = {};
  const monitorWindow = {};
  const externalWindow = {};
  const homeSender = {};
  const monitorSender = {};
  const externalSender = {};
  const sender =
    senderKind === "home"
      ? homeSender
      : senderKind === "monitor"
        ? monitorSender
        : externalSender;
  const event = { sender };
  const featureDeps = new Proxy(
    {
      /** イベントのsenderと同一のスタブWindowを返し、既知のsender以外は未解決とする。 */
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
      /** 許可外のsenderから送るケースでもHome Window自体は存在させる。 */
      resolveHomeWindow: () => homeWindow,
      /** 参照の一致だけを使い、Monitor Windowかを判定する。 */
      isSessionMonitorWindow: (window: unknown) => window === monitorWindow,
      /** どのスタブも設定Windowとして分類しない。 */
      isSettingsWindow: () => false,
      /** どのスタブもMemoryレビューWindowとして分類しない。 */
      isMemoryV6ReviewWindow: () => false,
      /** 要求に使ったWindowを通常のファイルプレビューには分類しない。 */
      isFilePreviewWindow: () => false,
      /** プレビューWindowに対応するリソースはないものとする。 */
      getFilePreviewWindowResource: () => null,
      /** プレビュートークン専用Windowには該当しない。 */
      isFilePreviewTokenWindow: () => false,
      /** デリゲートに到達した要求をそのまま記録し、メニューを選ばずに閉じた結果を返す。 */
      showSessionMonitorContextMenu: async (
        _event: unknown,
        request: unknown,
      ) => {
        requests.push(request);
        return { status: "dismissed" as const };
      },
    },
    {
      /** 明示した依存先を優先し、他のIPC機能に必要な未指定の依存は空実装で補う。 */
      get(target, prop: string) {
        if (prop in target) {
          return target[prop as keyof typeof target];
        }
        return async () => null;
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
    mate: featureDeps,
    character: featureDeps,
  } as never;
  return { deps, event };
}

// @test-value v2
// kind = "contract"
// claim = "Session Monitor context menu IPCはHome/Monitorの実Window identityからのAgent strict requestを変換せずdelegateへ渡し、それ以外のsenderや不正requestを拒否する"
// oracle = { type = "contract", ref = "Session Monitor context menu IPC request boundary" }
// fault = "Home Windowが存在するだけで許可される、許可外senderや不正なkind、Session ID、座標、nested/top-level余分なfieldがnative menu delegateへ到達する、または公開channelにhandlerが登録されない"
// observable = "登録handlerの存在、sender-bearing eventから解決されたWindowの認可、delegateへ渡されたrequest、invalid requestのTypeError"
// observation_boundary = "public-boundary"
// scope = "Main IPC Session Monitor context menu handler"
// lifecycle = "permanent"
// impact = "Monitorから対象外Windowを閉じる入力をMainのmenu処理へ通さない"
// distinction = "native menu itemのkind dispatchやpreload channel変換とは分離してMainのrequest validationを検証する"
// @end-test-value
/** HomeとMonitorの要求を変換せずメニュー処理へ渡し、別Windowの要求と余分なフィールド・不正座標などを拒否する。 */
test("Session Monitor context menu IPCはstrict requestをdelegateへ渡す", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const requests: unknown[] = [];
  const home = createDeps(requests);
  registerMainIpcHandlers(ipcMain, home.deps);

  const handler = handlers.get(
    WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL,
  );
  assert.ok(handler);
  const agentRequest = {
    kind: "agent",
    sessionId: "agent-1",
    point: { x: 24, y: 48 },
  };

  assert.deepEqual(await handler(home.event, agentRequest), {
    status: "dismissed",
  });
  assert.deepEqual(requests, [agentRequest]);

  const monitorIpc = createIpcMainStub();
  const monitorRequests: unknown[] = [];
  const monitor = createDeps(monitorRequests, "monitor");
  registerMainIpcHandlers(monitorIpc.ipcMain, monitor.deps);
  const monitorHandler = monitorIpc.handlers.get(
    WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL,
  );
  assert.ok(monitorHandler);
  assert.deepEqual(await monitorHandler(monitor.event, agentRequest), {
    status: "dismissed",
  });
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
  assert.deepEqual(requests, [agentRequest]);

  const unauthorizedIpc = createIpcMainStub();
  const unauthorizedRequests: unknown[] = [];
  const unauthorized = createDeps(unauthorizedRequests, "unauthorized");
  registerMainIpcHandlers(unauthorizedIpc.ipcMain, unauthorized.deps);
  const unauthorizedHandler = unauthorizedIpc.handlers.get(
    WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL,
  );
  assert.ok(unauthorizedHandler);
  await assert.rejects(
    () =>
      unauthorizedHandler(unauthorized.event, agentRequest) as Promise<unknown>,
    /Session Monitor context menu IPC is only available from Home or Session Monitor window/,
  );
  assert.deepEqual(unauthorizedRequests, []);
});
