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
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";

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
test("Coordination IPC returns deleted DTO only for authoritative missing lookups", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipc = { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) } as IpcHandleRegistrar;
  const mainFrame = {};
  const sender = { mainFrame };
  const window = { isDestroyed: () => false } as BrowserWindow;
  let failure: Error = new CoordinationDeletedError("Deleted");
  const service = { executeUser: async () => { throw failure; }, subscribe: () => () => {} } as unknown as CoordinationApplicationService;
  registerCoordinationHandlers(ipc, { service, resolveWindow: () => window, isTrustedWindow: () => true, allWindows: () => [], authorizeRequest: async () => {}, open: async () => window, resolveIdentity: async () => null, readStatus: async () => { throw failure; } });
  const execute = handlers.get("withmate:coordination:execute")!;
  const event = { sender, senderFrame: mainFrame };
  const request = { operation: "get", id: "missing" };
  assert.deepEqual(await execute(event, request), { error: { code: "COORDINATION_DELETED", message: "Deleted" } });
  const status = handlers.get("withmate:coordination:status")!;
  assert.deepEqual(await status(event, { id: "missing" }), { error: { code: "COORDINATION_DELETED", message: "Deleted" } });
  failure = new Error("The storage transport disconnected.");
  await assert.rejects(execute(event, request), /transport disconnected/);
  await assert.rejects(status(event, { id: "missing" }), /transport disconnected/);
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
test("Coordination status IPC projects the saved state without transferring or acquiring the answer", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "withmate-coordination-status-"));
  const dbPath = join(temporary, "withmate-v6.db");
  const bundle = createV6StorageWorkerBundle({ dbPath, userDataPath: temporary });
  try {
    await bundle.initialize();
    const source = await bundle.stores.session.insertSession(buildNewSession({ id: "status-origin", taskTitle: "Origin", workspaceLabel: "Workspace", workspacePath: "C:/workspace", branch: "task", characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#234567" }, approvalMode: "on-request" }));
    const db = new DatabaseSync(dbPath);
    try { db.prepare("INSERT INTO session_turns_v6(id,session_id,phase,started_at,updated_at) VALUES(1,?,'completed','now','now')").run(source.id); } finally { db.close(); }
    const actor = { kind: "main" as const, sessionId: source.id, incarnationId: getSessionIncarnationId(source), turnId: "1" };
    const store = bundle.stores.coordination;
    const service = new CoordinationApplicationService({ getStore: () => store, prepareDelivery: async () => { throw new Error("Unexpected delivery"); } });
    const handlers = new Map<string, (...args: any[]) => any>();
    const mainFrame = {};
    const event = { sender: { mainFrame }, senderFrame: mainFrame };
    const window = { isDestroyed: () => false } as BrowserWindow;
    let readAllowed = true;
    registerCoordinationHandlers({ handle: (channel, handler) => handlers.set(channel, handler) } as IpcHandleRegistrar, {
      service, resolveWindow: () => window, isTrustedWindow: () => true, allWindows: () => [], open: async () => window,
      authorizeRequest: async (_window, request) => { if (!readAllowed || request.operation !== "get") throw new Error("Read denied"); },
      resolveIdentity: async () => null, readStatus: (id) => store.readStatus(id),
    });
    const api = createCoordinationApi({ invoke: (channel: string, raw: unknown) => handlers.get(channel)!(event, raw) } as IpcRendererLike);
    const body = "q".repeat(32000), answer = "a".repeat(32000), choices = ["1", "2", "3", "4"].map((n) => n.repeat(8000));
    let detailBytes = 0, statusBytes = 0;
    let id = "";
    for (let index = 0; index < 8; index++) {
      id = randomUUID();
      await service.executeAgent(actor, { operation: "create", operationId: id, kind: "blocker", body, choices, deliver: false });
      assert.deepEqual(await api.getCoordinationStatus({ id }), { state: "open", respondentKind: "user", hasAnswer: false });
      await service.executeUser({ operation: "answer", id, operationId: randomUUID(), body: answer, selectedChoices: [], expectedAnswerRevision: 0, send: false }, () => true);
      const status = await api.getCoordinationStatus({ id });
      assert.deepEqual(status, { state: "open", respondentKind: "user", hasAnswer: true });
      const detail = await api.executeCoordination({ operation: "get", id });
      assert.ok("record" in detail);
      assert.equal(detail.record.body, body);
      assert.deepEqual(detail.record.choices, choices);
      assert.equal(detail.record.answers[0]?.body, answer);
      assert.equal(detail.record.answers[0]?.acquiredAt, undefined);
      detailBytes += Buffer.byteLength(JSON.stringify(detail));
      statusBytes += Buffer.byteLength(JSON.stringify(status));
    }
    t.diagnostic(`8 long records, UTF-8 JSON at the IPC return boundary: detail=${detailBytes} B, status=${statusBytes} B`);
    await service.executeUser({ operation: "resolve", id, operationId: randomUUID() }, () => true);
    assert.deepEqual(await api.getCoordinationStatus({ id }), { state: "resolved", respondentKind: "user", hasAnswer: true });
    assert.deepEqual(await api.getCoordinationStatus({ id: "missing" }), {
      error: { code: "COORDINATION_DELETED", message: "Coordination was deleted or does not exist." },
    });
    const status = handlers.get("withmate:coordination:status")!;
    await assert.rejects(status({ ...event, senderFrame: {} }, { id }), /Invalid Coordination window sender/);
    await assert.rejects(status(event, { id, actor: "user" }));
    readAllowed = false;
    await assert.rejects(api.getCoordinationStatus({ id }), /Read denied/);
  } finally { await bundle.client.close(); await rm(temporary, { recursive: true, force: true }); }
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
test("Coordination display identity crosses the preload IPC boundary without losing stable identity", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const mainFrame = {};
  const sender = { mainFrame };
  const window = { isDestroyed: () => false } as BrowserWindow;
  const event = { sender, senderFrame: mainFrame };
  const calls: unknown[] = [];
  let trusted = true;
  let fail = false;
  registerCoordinationHandlers({ handle: (channel, handler) => handlers.set(channel, handler) } as IpcHandleRegistrar, {
    service: { subscribe: () => () => {} } as unknown as CoordinationApplicationService,
    resolveWindow: () => window,
    isTrustedWindow: () => trusted,
    allWindows: () => [],
    authorizeRequest: async () => {},
    readStatus: async () => { throw new Error("Unexpected status read"); },
    open: async () => window,
    resolveIdentity: async (identity) => {
      calls.push(identity);
      if (fail) throw new Error("Identity transport disconnected");
      return identity.incarnationId === "current" ? { title: "Current Task", character: { name: "AZKi", iconPath: "icon.png" } } : null;
    },
  });
  const api = createCoordinationApi({ invoke: (channel: string, raw: unknown) => handlers.get(channel)!(event, raw) } as IpcRendererLike);
  for (const kind of ["main", "auxiliary"] as const) {
    const identity = { kind, sessionId: "session", incarnationId: "current" };
    assert.deepEqual(await api.getCoordinationIdentity(identity), { title: "Current Task", character: { name: "AZKi", iconPath: "icon.png" } });
    assert.deepEqual(calls.at(-1), identity);
    assert.equal(await api.getCoordinationIdentity({ ...identity, incarnationId: "replaced" }), null);
  }
  const read = handlers.get("withmate:coordination:identity")!;
  const identity = { kind: "main", sessionId: "session", incarnationId: "current" };
  await assert.rejects(read(event, { ...identity, arbitrary: true }));
  await assert.rejects(read(event, { ...identity, kind: "user" }));
  await assert.rejects(read(event, { kind: "main", sessionId: "session" }));
  await assert.rejects(read({ ...event, senderFrame: {} }, identity), /Invalid Coordination window sender/);
  trusted = false;
  await assert.rejects(read(event, identity), /Invalid Coordination window sender/);
  trusted = true;
  fail = true;
  await assert.rejects(api.getCoordinationIdentity({ ...identity, kind: "main" }), /Identity transport disconnected/);
});
