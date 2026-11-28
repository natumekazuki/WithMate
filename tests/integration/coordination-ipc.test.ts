import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { BrowserWindow } from "electron";
import { CoordinationDeletedError } from "../../src-electron/coordination/coordination-errors.js";
import { CoordinationApplicationService } from "../../src-electron/coordination/coordination-application-service.js";
import { registerCoordinationHandlers } from "../../src-electron/ipc/coordination.js";
import type { IpcHandleRegistrar } from "../../src-electron/ipc/contracts.js";
import { createCoordinationApi } from "../../src-electron/preload/coordination-api.js";
import type { IpcRendererLike } from "../../src-electron/preload/ipc.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import {
  buildNewSession,
  getSessionIncarnationId,
} from "../../src-shared/session/session-state.js";

// @test-value v2
// kind = "contract"
// claim = "Coordination GUIの削除済み保存結果だけを終端DTOへ変換し、通信失敗は終端扱いにしない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details: 相談状態の取得失敗と消去" }
// fault = "Electron IPCでtyped削除codeを失う、または一時通信失敗まで削除結果へ変換する"
// observable = "登録済みIPC execute/status handlerの戻り値error.codeと一時失敗時のreject"
// observation_boundary = "public-boundary"
// scope = "registerCoordinationHandlers execute/statusのbackend例外とGUI DTO間の変換"
// lifecycle = "permanent"
// impact = "削除済み詳細の復活と一時障害での画面内容消失を防ぐ"
// distinction = "Worker testはElectronの例外変換境界を通らず、renderer fixtureだけでは本番IPCの終端変換を検出しない"
// @end-test-value
/** 登録済みの Coordination 実行・状態ハンドラーが、確定した削除だけをエラー DTO に変え、保存通信の切断は拒否として伝えることを確かめる。 */
test("Coordination IPC returns deleted DTO only for authoritative missing lookups", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipc = {
    /** 本物の IPC 転送を使わず、チャネルに登録されたハンドラーを直接呼び出せるように保存する。 */ handle:
      (channel: string, handler: (...args: any[]) => any) =>
        handlers.set(channel, handler),
  } as IpcHandleRegistrar;
  const mainFrame = {};
  const sender = { mainFrame };
  const window = {
    /** 送信元のウィンドウが破棄されていないことを示す。 */ isDestroyed: () =>
      false,
  } as BrowserWindow;
  let failure: Error = new CoordinationDeletedError("Deleted");
  const service = {
    /** 操作実行で、現在選択している削除または一時障害を発生させる。 */ executeUser:
      async () => {
        throw failure;
      },
    /** 削除と一時障害の変換だけを見るため、購読イベントは配信せず解除関数を返す。 */ subscribe:
      () => () => {},
  } as unknown as CoordinationApplicationService;
  registerCoordinationHandlers(ipc, {
    service,
    /** IPC の送信元に対応する検証用ウィンドウを返す。 */ resolveWindow: () =>
      window,
    /** ウィンドウ自体は信頼済みとして削除と通信失敗の違いに絞る。 */ isTrustedWindow:
      () => true,
    /** 他ウィンドウへの通知は発生させない。 */ allWindows: () => [],
    /** 操作の認可は通し、サービスが返すエラーの扱いを検査対象にする。 */ authorizeRequest:
      async () => {},
    /** 起動経路からも同じテスト用ウィンドウを返す。 */ open: async () =>
      window,
    /** 表示 identity を取得できない場合の値を返す。 */ resolveIdentity:
      async () => null,
    /** 状態読み取りにも操作実行と同じ故障を注入する。 */ readStatus:
      async () => {
        throw failure;
      },
  });
  const execute = handlers.get("withmate:coordination:execute")!;
  const event = { sender, senderFrame: mainFrame };
  const request = { operation: "get", id: "missing" };
  assert.deepEqual(await execute(event, request), {
    error: { code: "COORDINATION_DELETED", message: "Deleted" },
  });
  const status = handlers.get("withmate:coordination:status")!;
  assert.deepEqual(await status(event, { id: "missing" }), {
    error: { code: "COORDINATION_DELETED", message: "Deleted" },
  });
  failure = new Error("The storage transport disconnected.");
  await assert.rejects(execute(event, request), /transport disconnected/);
  await assert.rejects(
    status(event, { id: "missing" }),
    /transport disconnected/,
  );
});

// @test-value v2
// kind = "contract"
// claim = "GUIの状態読取は認可された情報を3項目に限定し、詳細の全文と回答未取得を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details: 相談状態; GitHub Issue #981 受入条件" }
// fault = "状態IPCへ本文や選択肢を載せる、未信頼frameへ情報を返す、またはGUI読取で回答を取得済みにする"
// observable = "preload→IPC→実Worker応答の3項目と確定消去DTO、無効な入力・frameのreject、詳細の本文・選択肢・回答とacquiredAt"
// observation_boundary = "public-boundary"
// scope = "信頼済みWindowのIPC handler、preload、実WorkerとSQLite。Electronの転送路はinvoke fixture"
// lifecycle = "permanent"
// impact = "長文相談を表示するだけで不要な回答複製や意図しない回答取得確定が発生する"
// distinction = "型または画面fixtureだけでは実WorkerとIPCから余分なfieldが返ることや、保存済み回答への副作用を検出できない"
// @end-test-value
/** 実 Worker と SQLite に保存した相談の状態が IPC で三項目に絞られ、詳細本文や未取得の回答は維持されることを確かめる。信頼できない送信元や認可外の読み取りも拒否する。 */
test("Coordination status IPC projects the saved state without transferring or acquiring the answer", async (t) => {
  const temporary = await mkdtemp(
    join(tmpdir(), "withmate-coordination-status-"),
  );
  const dbPath = join(temporary, "withmate-v6.db");
  const bundle = createV6StorageWorkerBundle({
    dbPath,
    userDataPath: temporary,
  });
  try {
    await bundle.initialize();
    const source = await bundle.stores.session.insertSession(
      buildNewSession({
        id: "status-origin",
        taskTitle: "Origin",
        workspaceLabel: "Workspace",
        workspacePath: "C:/workspace",
        branch: "task",
        characterId: "unknown",
        character: "Unknown",
        characterIconPath: "",
        characterThemeColors: { main: "#123456", sub: "#234567" },
        approvalMode: "on-request",
      }),
    );
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        "INSERT INTO session_turns_v6(id,session_id,phase,started_at,updated_at) VALUES(1,?,'completed','now','now')",
      ).run(source.id);
    } finally {
      db.close();
    }
    const actor = {
      kind: "main" as const,
      sessionId: source.id,
      incarnationId: getSessionIncarnationId(source),
      turnId: "1",
    };
    const store = bundle.stores.coordination;
    const service = new CoordinationApplicationService({
      /** 実ストレージ Worker の相談ストアをアプリケーションサービスへ渡す。 */ getStore:
        () => store,
      /** 配送しない検証用レコードが配送準備に進んだ場合、想定外の経路として失敗させる。 */ prepareDelivery:
        async () => {
          throw new Error("Unexpected delivery");
        },
    });
    const handlers = new Map<string, (...args: any[]) => any>();
    const mainFrame = {};
    const event = { sender: { mainFrame }, senderFrame: mainFrame };
    const window = {
      /** 読み取り元のウィンドウを未破棄として扱う。 */ isDestroyed: () =>
        false,
    } as BrowserWindow;
    let readAllowed = true;
    registerCoordinationHandlers(
      {
        /** preload から実際の登録済みハンドラーに転送できるよう、IPC の登録内容を捕捉する。 */ handle:
          (channel, handler) => handlers.set(channel, handler),
      } as IpcHandleRegistrar,
      {
        service,
        /** IPC 送信元に対応するテスト用ウィンドウを返す。 */ resolveWindow:
          () => window,
        /** ウィンドウを信頼済みとし、フレームの不一致による拒否は実ハンドラーに任せる。 */ isTrustedWindow:
          () => true,
        /** ウィンドウ列挙を使う通知先を持たないようにする。 */ allWindows:
          () => [],
        /** 別ウィンドウを作らず検証用ウィンドウを返す。 */ open: async () =>
          window,
        /** 状態と詳細の取得を許可し、フラグが無効な場合や読み取り以外の操作を拒否する。 */
        authorizeRequest: async (_window, request) => {
          if (!readAllowed || request.operation !== "get")
            throw new Error("Read denied");
        },
        /** 状態・詳細の検証では表示 identity を返さない。 */
        resolveIdentity: async () => null,
        /** 状態投影を実 Worker のストアから取得する。 */ readStatus: (id) =>
          store.readStatus(id),
      },
    );
    const api = createCoordinationApi({
      /** preload のチャネルと引数を、テスト中のフレームから登録済み IPC ハンドラーへ渡す。 */ invoke:
        (channel: string, raw: unknown) => handlers.get(channel)!(event, raw),
    } as IpcRendererLike);
    const body = "q".repeat(32000),
      answer = "a".repeat(32000),
      choices = ["1", "2", "3", "4"].map((n) => n.repeat(8000));
    let detailBytes = 0,
      statusBytes = 0;
    let id = "";
    for (let index = 0; index < 8; index++) {
      id = randomUUID();
      await service.executeAgent(actor, {
        operation: "create",
        operationId: id,
        kind: "blocker",
        body,
        choices,
        deliver: false,
      });
      assert.deepEqual(await api.getCoordinationStatus({ id }), {
        state: "open",
        respondentKind: "user",
        hasAnswer: false,
      });
      await service.executeUser(
        {
          operation: "answer",
          id,
          operationId: randomUUID(),
          body: answer,
          selectedChoices: [],
          expectedAnswerRevision: 0,
          send: false,
        },
        () => true,
      );
      const status = await api.getCoordinationStatus({ id });
      assert.deepEqual(status, {
        state: "open",
        respondentKind: "user",
        hasAnswer: true,
      });
      const detail = await api.executeCoordination({ operation: "get", id });
      assert.ok("record" in detail);
      assert.equal(detail.record.body, body);
      assert.deepEqual(detail.record.choices, choices);
      assert.equal(detail.record.answers[0]?.body, answer);
      assert.equal(detail.record.answers[0]?.acquiredAt, undefined);
      detailBytes += Buffer.byteLength(JSON.stringify(detail));
      statusBytes += Buffer.byteLength(JSON.stringify(status));
    }
    t.diagnostic(
      `8 long records, UTF-8 JSON at the IPC return boundary: detail=${detailBytes} B, status=${statusBytes} B`,
    );
    await service.executeUser(
      { operation: "resolve", id, operationId: randomUUID() },
      () => true,
    );
    assert.deepEqual(await api.getCoordinationStatus({ id }), {
      state: "resolved",
      respondentKind: "user",
      hasAnswer: true,
    });
    assert.deepEqual(await api.getCoordinationStatus({ id: "missing" }), {
      error: {
        code: "COORDINATION_DELETED",
        message: "Coordination was deleted or does not exist.",
      },
    });
    const status = handlers.get("withmate:coordination:status")!;
    await assert.rejects(
      status({ ...event, senderFrame: {} }, { id }),
      /Invalid Coordination window sender/,
    );
    await assert.rejects(status(event, { id, actor: "user" }));
    readAllowed = false;
    await assert.rejects(api.getCoordinationStatus({ id }), /Read denied/);
  } finally {
    await bundle.client.close();
    await rm(temporary, { recursive: true, force: true });
  }
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
/** Main と Auxiliary の完全な identity が preload から IPC に届き、存在しない世代は null、信頼や入力条件の違反と通信失敗は拒否になることを確かめる。 */
test("Coordination display identity crosses the preload IPC boundary without losing stable identity", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const mainFrame = {};
  const sender = { mainFrame };
  const window = {
    /** フレーム検証に使うウィンドウを未破棄として扱う。 */ isDestroyed: () =>
      false,
  } as BrowserWindow;
  const event = { sender, senderFrame: mainFrame };
  const calls: unknown[] = [];
  let trusted = true;
  let fail = false;
  registerCoordinationHandlers(
    {
      /** identity 読み取りの IPC 登録を捕捉し、通常の preload 呼び出しと不正入力の直接検証を可能にする。 */ handle:
        (channel, handler) => handlers.set(channel, handler),
    } as IpcHandleRegistrar,
    {
      service: {
        /** アプリケーションサービスの購読イベントは通知せず、解除関数を返す。 */ subscribe:
          () => () => {},
      } as unknown as CoordinationApplicationService,
      /** フレーム照合に使う検証用ウィンドウを返す。 */
      resolveWindow: () => window,
      /** テスト中に切り替えられるウィンドウの信頼判定を返す。 */
      isTrustedWindow: () => trusted,
      /** ウィンドウの列挙結果を空にし、通知経路を分離する。 */
      allWindows: () => [],
      /** このケースでは操作認可を通し、identity の入力と送信元の検証に絞る。 */
      authorizeRequest: async () => {},
      /** identity の取得が相談の状態読み取りに流れたら失敗させる。 */
      readStatus: async () => {
        throw new Error("Unexpected status read");
      },
      /** 新規ウィンドウを作らず検証用ウィンドウを返す。 */
      open: async () => window,
      /** 受け取った identity を記録し、現在の世代だけの表示情報と、切断時の例外を返し分ける。 */
      resolveIdentity: async (identity) => {
        calls.push(identity);
        if (fail) throw new Error("Identity transport disconnected");
        return identity.incarnationId === "current"
          ? {
              title: "Current Task",
              character: { name: "AZKi", iconPath: "icon.png" },
            }
          : null;
      },
    },
  );
  const api = createCoordinationApi({
    /** 公開 API の要求をテストフレームのイベントとともに Main の IPC ハンドラーへ転送する。 */ invoke:
      (channel: string, raw: unknown) => handlers.get(channel)!(event, raw),
  } as IpcRendererLike);
  for (const kind of ["main", "auxiliary"] as const) {
    const identity = { kind, sessionId: "session", incarnationId: "current" };
    assert.deepEqual(await api.getCoordinationIdentity(identity), {
      title: "Current Task",
      character: { name: "AZKi", iconPath: "icon.png" },
    });
    assert.deepEqual(calls.at(-1), identity);
    assert.equal(
      await api.getCoordinationIdentity({
        ...identity,
        incarnationId: "replaced",
      }),
      null,
    );
  }
  const read = handlers.get("withmate:coordination:identity")!;
  const identity = {
    kind: "main",
    sessionId: "session",
    incarnationId: "current",
  };
  await assert.rejects(read(event, { ...identity, arbitrary: true }));
  await assert.rejects(read(event, { ...identity, kind: "user" }));
  await assert.rejects(read(event, { kind: "main", sessionId: "session" }));
  await assert.rejects(
    read({ ...event, senderFrame: {} }, identity),
    /Invalid Coordination window sender/,
  );
  trusted = false;
  await assert.rejects(
    read(event, identity),
    /Invalid Coordination window sender/,
  );
  trusted = true;
  fail = true;
  await assert.rejects(
    api.getCoordinationIdentity({ ...identity, kind: "main" }),
    /Identity transport disconnected/,
  );
});
