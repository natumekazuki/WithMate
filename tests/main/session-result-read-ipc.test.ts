import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import type {
  IpcHandleRegistrar,
  MainIpcSessionQueryDeps,
} from "../../src-electron/ipc/contracts.js";
import { registerSessionQueryHandlers } from "../../src-electron/ipc/session-query.js";
import { SessionResultReadService } from "../../src-electron/session/session-result-read-service.js";
import {
  WITHMATE_GET_UNREAD_SESSION_RESULT_CHANNEL,
  WITHMATE_MARK_SESSION_RESULT_READ_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";

// @test-value v2
// kind = "security"
// claim = "結果既読IPCはMain/Auxのowner windowだけに公開し、非focus・他window・subframe・不正turnからの既読を受理しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "Monitorや他sessionから結果を既読にする、非focus要求を通す、またはAux ownerを誤認する"
// observable = "登録済みIPCの返却値/拒否とserviceの未読結果"
// observation_boundary = "public-boundary"
// scope = "結果既読IPCのsenderとfocus境界"
// lifecycle = "permanent"
// impact = "実際に表示していない結果を既読にして見落とす"
// distinction = "serviceとDOM単体はElectron sender権限を持たないため登録handlerで確認する"
// @end-test-value
/** 実際に対象会話を表示するウィンドウだけが、正しいターンを既読にできることを確認する。 */
test("結果既読IPCはfocusした会話ownerのmain frameだけから受理する", async () => {
  let focused = false;
  const owner = {
    /** テスト手順で切り替えたフォーカス状態を返す。 */ isFocused: () =>
      focused,
  };
  let sender: unknown = owner;
  const mainFrame = {};
  const event = { senderFrame: mainFrame, sender: { mainFrame } };
  const service = new SessionResultReadService(() => {});
  for (const id of ["main", "aux"])
    service.recordResult({
      sessionId: id,
      turnId: 1,
      phase: "completed",
      assistantMessageSeq: 1,
      threadId: "",
      errorMessage: "",
      completedAt: "",
    });
  const handlers = new Map<
    string,
    Parameters<IpcHandleRegistrar["handle"]>[1]
  >();
  registerSessionQueryHandlers(
    {
      /** 本番の登録処理が渡したハンドラーを呼出用に保持する。 */ handle: (
        channel,
        handler,
      ) => {
        handlers.set(channel, handler);
      },
    },
    {
      /** 呼出元を所有ウィンドウと無関係なウィンドウの間で切り替えられるようにする。 */
      resolveEventWindow: () => sender,
      /** MainのIDだけに会話ウィンドウを対応づける。 */
      resolveSessionWindow: (id: string) => (id === "main" ? owner : null),
      /** Auxiliaryの結果はその親の会話ウィンドウに帰属させる。 */
      getConversationOwnerSessionId: async (id: string) =>
        id === "aux" ? "main" : id,
      /** 未読照会を実サービスに委ねて既読操作の影響を観測する。 */
      getUnreadSessionResult: (id: string) => service.getUnreadResult(id),
      /** IPCで認可された既読操作を実サービスへ渡す。 */
      markSessionResultRead: (id: string, turnId: number) =>
        service.markRead(id, turnId),
    } as unknown as MainIpcSessionQueryDeps,
  );
  /** 現在の送信元フレームと指定した入力を登録済みハンドラーへ渡す。 */
  const invoke = async (
    channel: string,
    id: unknown = "aux",
    turnId: unknown = 1,
  ) =>
    handlers.get(channel)!(event as unknown as IpcMainInvokeEvent, id, turnId);
  /** 同じAuxiliary結果を対象に、認可条件だけを変えて既読を試みる。 */
  const read = () => invoke(WITHMATE_MARK_SESSION_RESULT_READ_CHANNEL);
  assert.deepEqual(await invoke(WITHMATE_GET_UNREAD_SESSION_RESULT_CHANNEL), {
    turnId: 1,
    assistantMessageSeq: 1,
  });
  assert.equal(await read(), false);
  focused = true;
  sender = {};
  await assert.rejects(read());
  await assert.rejects(invoke(WITHMATE_GET_UNREAD_SESSION_RESULT_CHANNEL));
  sender = owner;
  event.senderFrame = {};
  await assert.rejects(read());
  event.senderFrame = mainFrame;
  for (const turnId of [0, -1, 1.5, "1", NaN])
    await assert.rejects(
      invoke(WITHMATE_MARK_SESSION_RESULT_READ_CHANNEL, "aux", turnId),
      /Turn ID/,
    );
  await assert.rejects(
    invoke(WITHMATE_MARK_SESSION_RESULT_READ_CHANNEL, "foreign"),
  );
  assert.equal(service.getUnreadResult("aux")?.turnId, 1);
  assert.equal(await read(), true);
  assert.equal(service.getUnreadResult("aux"), null);
  assert.equal(service.getUnreadResult("main")?.turnId, 1);
  assert.equal(
    await invoke(WITHMATE_MARK_SESSION_RESULT_READ_CHANNEL, "main"),
    true,
  );
});
