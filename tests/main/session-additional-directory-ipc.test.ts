import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import { registerSessionRuntimeHandlers } from "../../src-electron/ipc/session-runtime.js";
import type { MainIpcSessionRuntimeDeps } from "../../src-electron/ipc/contracts.js";
import { WITHMATE_CHANGE_SESSION_ADDITIONAL_DIRECTORY_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";

// @test-value v2
// kind = "security"
// claim = "Directory変更IPCは対象MainのWindowからの正確なidentityだけをserviceへ渡す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Additional Directories; docs/design/window-architecture.md" }
// fault = "別Windowまたはidentityなしのrequestを保存serviceへ渡す"
// observable = "登録・解除のservice呼出引数と、別Window・identity欠落時の拒否と呼出回数"
// observation_boundary = "public-boundary"
// scope = "session-additional-directory-ipc"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// distinction = "MCPと保存serviceの検証だけではElectron送信元のWindow認可を検査できない"
// @end-test-value
test("directory IPC requires the owning window and exact Main identity", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: any[]) => any>();
  const owner = {};
  let currentWindow = owner;
  const calls: unknown[] = [];
  const deps = {
    resolveEventWindow: () => currentWindow,
    resolveSessionWindow: (id: string) => id === "main" ? owner : null,
    changeSessionAdditionalDirectory: async (request: unknown) => { calls.push(request); },
  } as unknown as MainIpcSessionRuntimeDeps;
  registerSessionRuntimeHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); } }, deps);
  const invoke = handlers.get(WITHMATE_CHANGE_SESSION_ADDITIONAL_DIRECTORY_CHANNEL)!;
  const event = {} as IpcMainInvokeEvent;
  const request = { sessionId: "main", incarnationId: "main-v1", operation: "add", directoryPath: "C:/shared" };
  await invoke(event, request);
  await invoke(event, { ...request, operation: "remove" });
  assert.deepEqual(calls, [request, { ...request, operation: "remove" }]);
  currentWindow = {};
  assert.throws(() => invoke(event, request), /target Session window/);
  currentWindow = owner;
  assert.throws(() => invoke(event, { ...request, incarnationId: "" }), /identity/i);
  assert.equal(calls.length, 2);
});
