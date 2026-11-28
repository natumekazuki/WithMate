import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { registerSessionRuntimeHandlers } from "../../src-electron/ipc/session-runtime.js";
import type { IpcMainInvokeEvent } from "electron";
import type { MainIpcSessionRuntimeDeps } from "../../src-electron/ipc/contracts.js";

// @test-value v2
// kind = "contract"
// claim = "失敗Turn再実行IPCは対象MainまたはAuxiliaryの親を所有するmain frameだけを許可し、非同期受付時にも認可を確認する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#gui-turn-queue" }
// fault = "別Windowやframeの要求を許す、認可失効後にqueueへ受付する"
// observable = "IPC拒否とfacadeの対象、非同期受付時の認可callback結果"
// observation_boundary = "public-boundary"
// scope = "失敗Turn再実行のElectron IPC"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "別会話の失敗指示を権限のないWindowから実行できる"
// distinction = "facade testはElectron Windowとframeの認可境界を通らない"
// @end-test-value
/** 失敗 Turn の再実行には親の所有ウィンドウのメインフレームを要求し、受付中も確認する。 */
test("failed Turn retry IPC rechecks the owning window and main frame", async () => {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, ...args: any[]) => any
  >();
  const mainFrame = {};
  const sender = {
    mainFrame,
    /** このケースでは破棄ではなく、別のウィンドウへの変化を観測する。 */
    isDestroyed: () => false,
  };
  const ownerWindow = {};
  let currentWindow = ownerWindow;
  let calls = 0;
  const queue = {
    /** Auxiliary の対象を保持し、受付前後に使う認可コールバックを検証する。 */
    retryFailedSessionTurn: async (
      id: string,
      request: unknown,
      assertCurrent: () => void,
    ) => {
      calls++;
      assert.equal(id, "aux");
      assert.deepEqual(request, { original: true });
      assertCurrent();
      currentWindow = {};
      assert.throws(assertCurrent, /target Session window/);
      return { state: "queued" };
    },
  };
  const deps = {
    queue,
    /** ケースから切り替えられる現在の送信元ウィンドウを返す。 */
    resolveEventWindow: () => currentWindow,
    /** 親 Main の所有ウィンドウを固定する。 */
    resolveSessionWindow: (id: string) => (id === "main" ? ownerWindow : null),
    /** Auxiliary の認可に使う親 Main を返す。 */
    getAuxiliarySessionStatus: async (id: string) =>
      id === "aux" ? { parentSessionId: "main" } : null,
  } as unknown as MainIpcSessionRuntimeDeps;
  registerSessionRuntimeHandlers(
    {
      /** 本番ハンドラーを IPC サーバーなしで実行できるように記録する。 */
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
    deps,
  );
  /** 指定フレームを送信元として Auxiliary の失敗 Turn を再実行する。 */
  const invoke = (frame: object) =>
    handlers.get("withmate:retry-failed-session-turn")!(
      { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent,
      "aux",
      { original: true },
    );
  currentWindow = {};
  await assert.rejects(invoke(mainFrame), /target Session window/);
  currentWindow = ownerWindow;
  await assert.rejects(invoke({}), /owning main application frame/);
  assert.equal(calls, 0);
  await invoke(mainFrame);
  assert.equal(calls, 1);
});

// @test-value v2
// kind = "contract"
// claim = "queued Edit IPCはMain/Auxのowning Windowだけを許可し、編集ownerのnavigation/crash/destructionで一時pauseを解放する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: GUI Turn Queue、owning Window喪失時の一時編集取消" }
// fault = "別Windowの編集を通す、Auxを親IDに置換する、失敗した編集のpauseをowner喪失時に残す"
// observable = "IPCの依存呼出引数と拒否、navigation/crash/destruction後の解放target列"
// observation_boundary = "public-boundary"
// scope = "registerSessionRuntimeHandlers queued Edit認可とrenderer lifecycle"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// distinction = "service/facade testはElectron senderとrenderer喪失eventを通らない"
// @end-test-value
/** 所有者だけに一時編集を許し、画面遷移や消失で未完の編集の停止状態を解放する。 */
test("queued Edit IPCはownerを照合しrenderer喪失時にMainとAuxのpauseを解放する", async () => {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, ...args: any[]) => any
  >();
  const sender = new EventEmitter();
  const ownerWindow = {};
  let eventWindow = ownerWindow;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const queue = {
    /** 開始要求の対象を記録し、編集中のキュー項目を返す。 */
    beginQueuedSessionTurnEdit: async (...args: unknown[]) => {
      calls.push({ method: "begin", args });
      return { id: "item" };
    },
    /** 保存できなかった場合でも後の解除処理が動作するよう、更新を失敗させる。 */
    updateQueuedSessionTurn: async (...args: unknown[]) => {
      calls.push({ method: "update", args });
      throw new Error("save failed");
    },
    /** 明示取消を記録し、後の所有者消失による解除と区別する。 */
    cancelQueuedSessionTurnEdit: async (...args: unknown[]) => {
      calls.push({ method: "cancel", args });
    },
    /** 所有者消失で実際に解放したセッションを記録する。 */
    releaseQueuedSessionTurnEdit: async (...args: unknown[]) => {
      calls.push({ method: "release", args });
    },
  };
  const deps = {
    queue,
    /** 所有者と非所有者の送信を切り替えられるようにする。 */
    resolveEventWindow: () => eventWindow,
    /** Main の編集を許可する所有ウィンドウを指定する。 */
    resolveSessionWindow: (id: string) => (id === "main" ? ownerWindow : null),
    /** 同じ所有者が Auxiliary を編集できるよう、親 Main を返す。 */
    getAuxiliarySessionStatus: async (id: string) =>
      id === "aux" ? { parentSessionId: "main" } : null,
  } as unknown as MainIpcSessionRuntimeDeps;
  registerSessionRuntimeHandlers(
    {
      /** 編集操作を登録チャネルごとに直接呼び出せるようにする。 */
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
    deps,
  );
  const event = { sender } as unknown as IpcMainInvokeEvent;
  const edit = { incarnationId: "incarnation", id: "item" };
  /** 指定した編集操作のハンドラーに、対象セッションと編集内容を渡す。 */
  const invoke = (method: "begin" | "update" | "cancel", id: string) =>
    Promise.resolve(
      handlers.get(
        `withmate:${method === "update" ? "update-queued-session-turn" : `${method}-queued-session-turn-edit`}`,
      )!(
        event,
        id,
        method === "update" ? { ...edit, userMessage: "edited" } : edit,
      ),
    );
  for (const method of ["begin", "update", "cancel"] as const) {
    eventWindow = {};
    await assert.rejects(invoke(method, "aux"), /target Session window/);
  }
  assert.equal(calls.length, 0);
  eventWindow = ownerWindow;
  await invoke("begin", "main");
  await invoke("begin", "aux");
  assert.deepEqual(calls.slice(0, 2), [
    { method: "begin", args: ["main", edit] },
    { method: "begin", args: ["aux", edit] },
  ]);
  sender.emit("did-start-navigation", {}, "file:///frame", false, false);
  assert.equal(calls.filter((call) => call.method === "release").length, 0);
  sender.emit("did-start-navigation", {}, "file:///session", false, true);
  assert.deepEqual(
    calls.filter((call) => call.method === "release").map((call) => call.args),
    [["main"], ["aux"]],
  );
  await invoke("begin", "aux");
  await assert.rejects(invoke("update", "aux"), /save failed/);
  sender.emit("render-process-gone");
  assert.deepEqual(calls.at(-1), { method: "release", args: ["aux"] });
  await invoke("begin", "main");
  sender.emit("destroyed");
  assert.deepEqual(calls.at(-1), { method: "release", args: ["main"] });
  await invoke("begin", "aux");
  await invoke("cancel", "aux");
  const before = calls.length;
  sender.emit("destroyed");
  assert.equal(calls.length, before);
  let authorize!: () => void;
  deps.getAuxiliarySessionStatus = async () => {
    await new Promise<void>((resolve) => {
      authorize = resolve;
    });
    return null;
  };
  const pending = invoke("begin", "main");
  sender.emit("did-start-navigation", {}, "file:///session", false, true);
  authorize();
  await assert.rejects(pending, /owner is no longer available/);
  assert.equal(calls.length, before);
});
