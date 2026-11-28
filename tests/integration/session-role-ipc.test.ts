import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { IpcHandleRegistrar } from "../../src-electron/ipc/contracts.js";
import { registerSessionRoleHandlers } from "../../src-electron/ipc/session-role.js";
import { WITHMATE_PROMOTE_SESSION_ROLE_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import {
  buildNewSession,
  projectSessionSummary,
} from "../../src-shared/session/session-state.js";

// @test-value v2
// kind = "security"
// claim = "Role昇格IPCは対象Session自身のmain frameだけを受け付け、保存待機後も同じ送信元であることを再検証できる"
// oracle = { type = "contract", ref = "GitHub Issue #834 Standaloneから全体統括へのGUI変更" }
// fault = "他Window・subframe・破棄済みsenderを受理する、またはmutation待機中に失われたownerの昇格を保存する"
// observable = "登録済みIPCの拒否、保存callbackへ到達したSessionとincarnation、返却summary"
// observation_boundary = "public-boundary"
// scope = "Role専用IPCのtrusted senderと保存直前認可callback"
// lifecycle = "permanent"
// impact = "別Sessionや非GUI callerがRoleを昇格して委任権限を拡張することを防ぐ"
// distinction = "storage単体と型検査ではElectron送信元を検証できず、実登録handlerと小さなWindow fixtureで境界を確認する"
// risk_tags = ["authorization"]
// @end-test-value
/** 自分の Session と有効なメインフレームだけが昇格を保存でき、待機中に所有 Window が失われた要求は反映しないことを確認する。 */
test("Role昇格IPCは自身のmain frameを検証し、保存待機中のowner喪失も拒否する", async () => {
  const owner = {} as BrowserWindow;
  let resolvedWindow: BrowserWindow | null = owner;
  let destroyed = false;
  const mainFrame = {};
  const event = {
    senderFrame: mainFrame,
    sender: {
      mainFrame,
      /** 登録後に送信元が破棄された場合を、呼出し時に観測できるようにする。 */
      isDestroyed: () => destroyed,
    },
  };
  const summary = projectSessionSummary(
    buildNewSession({
      id: "self",
      taskTitle: "Task",
      workspaceLabel: "Workspace",
      workspacePath: "C:/work",
      branch: "",
      characterId: "mia",
      character: "Mia",
      characterIconPath: "",
      characterThemeColors: { main: "#112233", sub: "#445566" },
      approvalMode: "on-request",
      sessionRole: "overall-coordinator",
    }),
  );
  const saved: Array<[string, string]> = [];
  /** 保存直前の処理をテストから差し替え、待機中に所有 Window がなくなる状況を作る。 */
  let beforeSave = async () => {};
  const handlers = new Map<
    string,
    Parameters<IpcHandleRegistrar["handle"]>[1]
  >();
  registerSessionRoleHandlers(
    {
      /** Electron の登録先を置き換え、実際の IPC ハンドラーを名前で呼べるようにする。 */
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
    {
      /** 呼出元イベントから、その時点で解決できる Window を返す。 */
      resolveEventWindow: () => resolvedWindow,
      /** 対象 ID がこの fixture の Session と同じときだけ、所有 Window を返す。 */
      resolveSessionWindow: (id) => (id === "self" ? owner : null),
      /** 保存直前の処理を待って呼出元を再照合し、認可に成功した昇格だけを記録する。 */
      promoteSessionToOverallCoordinator: async (
        id,
        incarnation,
        assertCurrent,
      ) => {
        await beforeSave();
        assertCurrent();
        saved.push([id, incarnation]);
        return summary;
      },
    },
  );
  /** 登録された昇格 IPC を、指定の Session ID と incarnation で呼び出す。 */
  const invoke = async (
    id: unknown = "self",
    incarnation: unknown = "self-generation",
  ) =>
    handlers.get(WITHMATE_PROMOTE_SESSION_ROLE_CHANNEL)!(
      event as unknown as IpcMainInvokeEvent,
      id,
      incarnation,
    );
  resolvedWindow = {} as BrowserWindow;
  await assert.rejects(invoke(), /target Session window/);
  resolvedWindow = owner;
  await assert.rejects(invoke("other"), /target Session window/);
  event.senderFrame = {};
  await assert.rejects(invoke(), /main application frame/);
  event.senderFrame = mainFrame;
  destroyed = true;
  await assert.rejects(invoke(), /main application frame/);
  destroyed = false;
  await assert.rejects(invoke("self", ""), /identity/);
  beforeSave = async () => {
    resolvedWindow = null;
  };
  await assert.rejects(invoke(), /target Session window/);
  assert.deepEqual(saved, []);
  beforeSave = async () => {};
  resolvedWindow = owner;
  assert.deepEqual(await invoke(), summary);
  assert.deepEqual(saved, [["self", "self-generation"]]);
});
