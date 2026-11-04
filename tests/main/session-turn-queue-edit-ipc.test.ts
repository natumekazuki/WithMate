import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { registerSessionRuntimeHandlers } from "../../src-electron/ipc/session-runtime.js";
import type { IpcMainInvokeEvent } from "electron";
import type { MainIpcSessionRuntimeDeps } from "../../src-electron/ipc/contracts.js";

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
test("queued Edit IPCはownerを照合しrenderer喪失時にMainとAuxのpauseを解放する", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: any[]) => any>();
  const sender = new EventEmitter();
  const ownerWindow = {};
  let eventWindow = ownerWindow;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const queue = {
    beginQueuedSessionTurnEdit: async (...args: unknown[]) => { calls.push({ method: "begin", args }); return { id: "item" }; },
    updateQueuedSessionTurn: async (...args: unknown[]) => { calls.push({ method: "update", args }); throw new Error("save failed"); },
    cancelQueuedSessionTurnEdit: async (...args: unknown[]) => { calls.push({ method: "cancel", args }); },
    releaseQueuedSessionTurnEdit: async (...args: unknown[]) => { calls.push({ method: "release", args }); },
  };
  const deps = { queue, resolveEventWindow: () => eventWindow, resolveSessionWindow: (id: string) => id === "main" ? ownerWindow : null,
    getAuxiliarySessionStatus: async (id: string) => id === "aux" ? { parentSessionId: "main" } : null } as unknown as MainIpcSessionRuntimeDeps;
  registerSessionRuntimeHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); } }, deps);
  const event = { sender } as unknown as IpcMainInvokeEvent;
  const edit = { incarnationId: "incarnation", id: "item" };
  const invoke = (method: "begin" | "update" | "cancel", id: string) => Promise.resolve(handlers.get(`withmate:${method === "update" ? "update-queued-session-turn" : `${method}-queued-session-turn-edit`}`)!(event, id,
    method === "update" ? { ...edit, userMessage: "edited" } : edit));
  for (const method of ["begin", "update", "cancel"] as const) {
    eventWindow = {};
    await assert.rejects(invoke(method, "aux"), /target Session window/);
  }
  assert.equal(calls.length, 0);
  eventWindow = ownerWindow;
  await invoke("begin", "main");
  await invoke("begin", "aux");
  assert.deepEqual(calls.slice(0, 2), [{ method: "begin", args: ["main", edit] }, { method: "begin", args: ["aux", edit] }]);
  sender.emit("did-start-navigation", {}, "file:///frame", false, false);
  assert.equal(calls.filter((call) => call.method === "release").length, 0);
  sender.emit("did-start-navigation", {}, "file:///session", false, true);
  assert.deepEqual(calls.filter((call) => call.method === "release").map((call) => call.args), [["main"], ["aux"]]);
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
  deps.getAuxiliarySessionStatus = async () => { await new Promise<void>((resolve) => { authorize = resolve; }); return null; };
  const pending = invoke("begin", "main");
  sender.emit("did-start-navigation", {}, "file:///session", false, true);
  authorize();
  await assert.rejects(pending, /owner is no longer available/);
  assert.equal(calls.length, before);
});
