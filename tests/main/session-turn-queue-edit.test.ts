import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test, { mock } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { SessionTurnQueueStorageV6 } from "../../src-electron/session/session-turn-queue-storage-v6.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { MainSessionTurnQueueFacade } from "../../src-electron/app/main-session-turn-queue-facade.js";
import {
  buildNewSession,
  getSessionIncarnationId,
} from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type {
  SessionTurnQueueCapturedInput,
  SessionTurnQueueStore,
} from "../../src-shared/session/session-turn-queue.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { executionOperationResultSchemas } from "../../src-shared/session/session-execution-read.js";

/** 実SQLite上にキューとセッションを作り、サービスが使う非同期のストア窓口へ接続する。 */
async function fixture(model?: string) {
  const temporary = await mkdtemp(join(os.tmpdir(), "withmate-queue-edit-"));
  const dbPath = join(temporary, "withmate-v6.db");
  const sessions = new SessionStorageV6(dbPath);
  const queue = new SessionTurnQueueStorageV6(dbPath);
  const session = sessions.insertSession(
    buildNewSession({
      taskTitle: "Queue",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      model,
      characterId: "character",
      character: "Character",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: "on-request",
    }),
  );
  const owner = {
    sessionId: session.id,
    incarnationId: getSessionIncarnationId(session),
  };
  /** 通常送信として、固有の要求IDと当該会話の実行設定を持つ入力を作る。 */
  const capture = (userMessage: string): SessionTurnQueueCapturedInput => ({
    request: {
      userMessage,
      clientRequestId: randomUUID(),
      submitSource: "composer",
      executionOptions: captureSessionExecutionOptions(session),
    },
    attachments: [],
    provider: session.provider,
    workspacePath: session.workspacePath,
    origin: {
      kind: "gui",
      operation: "send",
      targetSessionId: owner.sessionId,
      targetIncarnationId: owner.incarnationId,
    },
  });
  const store: SessionTurnQueueStore = {
    /** 受付と即時確保を同期実装の実DBへ委ねる。 */ admit: async (...args) =>
      queue.admit(...args),
    /** 同じ所有者と要求IDに対応する受付を実DBから照会する。 */ getReceipt:
      async (...args) => queue.getReceipt(...args),
    /** 受付ID起点の操作が参照する現在の保存状態を返す。 */
    getReceiptById: async (...args) => queue.getReceiptById(...args),
    /** 待機・実行中などの有効な受付を、実ストアから取得する。 */ listActive:
      async (...args) => queue.listActive(...args),
    /** 終端も含めた保存済みの受付履歴を照会する。 */ listReceipts: async (
      ...args
    ) => queue.listReceipts(...args),
    /** 再開処理の対象となる待機中の所有者を取得する。 */ listPendingOwners:
      async () => queue.listPendingOwners(),
    /** 実DBに保存された順序で次の待機項目を確保する。 */ claimNext: async (
      ...args
    ) => queue.claimNext(...args),
    /** 現在のターンへの追加入力に使う受付の確保を実DBへ委ねる。 */ claimForInput:
      async (...args) => queue.claimForInput(...args),
    /** 配送前の入力確保を取り消し、待機列へ戻す処理を実DBへ委ねる。 */ restoreQueuedInput:
      async (...args) => queue.restoreQueuedInput(...args),
    /** 確保済みの受付に、実行開始を示すターン情報を保存する。 */ markStarted:
      async (...args) => queue.markStarted(...args),
    /** 実行後の終端状態を実ストアに記録する。 */ settle: async (...args) =>
      queue.settle(...args),
    /** 未実行の受付を取り消し、保存された状態を返す。 */ cancelQueued: async (
      ...args
    ) => queue.cancelQueued(...args),
    /** 待機中の本文と添付の変更を、実ストアの制約で保存する。 */ updateQueued:
      async (...args) => queue.updateQueued(...args),
    /** 対象会話の待機順変更を実ストアで照合・記録する。 */ reorderQueued:
      async (...args) => queue.reorderQueued(...args),
    /** DBに残る中断状態の回収処理を呼び出す。 */ recoverInterrupted:
      async () => queue.recoverInterrupted(),
  };
  return {
    sessions,
    queue,
    session,
    owner,
    capture,
    store,
    dbPath,
    temporary,
    /** 両方のDB接続を閉じ、テスト間でデータが混ざらないよう一時領域を消す。 */ close:
      async () => {
        queue.close();
        sessions.close();
        await rm(temporary, { recursive: true, force: true });
      },
  };
}

// @test-value v2
// kind = "contract"
// claim = "失敗Turnの再実行は通常の待機中編集と取消ができ、元の失敗receiptと今回の受付時入力・実行設定を保持する。同じ要求IDの再試行では受付を増やさず、再実行はSteerにならない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Queued Message Edit; docs/design/session-run-lifecycle.md: GUI Turn Queue / Queue Editing" }
// fault = "再実行の編集や取消を拒む、元の失敗receiptや今回の受付時入力・設定を上書きする、同じ要求IDで重複受付する、再実行を実行中Turnへの入力としてclaimする"
// observable = "Main facadeで再実行・編集・同一ID再試行・取消をしたreceipt、SQLiteに残る元の失敗receiptと今回の固定入力、ServiceのSteer拒否"
// observation_boundary = "public-boundary"
// scope = "MainSessionTurnQueueFacadeとSessionTurnQueueServiceの再実行予約・SQLite保存"
// lifecycle = "permanent"
// distinction = "普通の予約編集と再実行受付を別々に調べる既存testでは、編集後に同じ要求IDで再試行した結果、元の失敗receipt、今回の固定入力をまとめて照合できない"
// @end-test-value
/** 失敗ターンの再実行は別の待機受付として編集・取消でき、元の受付を変更せずSteerにもならないことを確認する。 */
test("待機中の再実行は元の失敗receiptを変えずに編集と取消ができ、Steerにはならない", async () => {
  const f = await fixture("test-model");
  let busy = true;
  const service = new SessionTurnQueueService({
    store: f.store,
    /** 再実行を編集する間は既に実行中のターンがある状態にする。 */ isRunInFlight:
      () => busy,
    /** 再実行が誤って既存ターンへの追加入力に変わった場合は失敗させる。 */ sendInput:
      async () => {
        throw new Error("Unexpected Provider input");
      },
    /** 新しいターンとして配送された場合は正常に完了させる。 */ dispatch:
      async () => ({ state: "completed" }),
  });
  /** 旧添付と編集後添付をパスで区別できるファイル参照を組み立てる。 */
  const attachment = (name: string) => ({
    id: name,
    kind: "file" as const,
    source: "text" as const,
    absolutePath: `C:/workspace/${name}`,
    displayPath: name,
    workspaceRelativePath: name,
    isOutsideWorkspace: false,
  });
  const original = {
    ...f.capture("Start @old.txt"),
    attachments: [attachment("old.txt")],
    origin: {
      kind: "session" as const,
      operation: "send" as const,
      actorSessionId: "sender",
      actorIncarnationId: "sender-incarnation",
      actorKind: "main" as const,
      actorTurnId: "2",
      actorSnapshot: {
        sessionTitle: "Sender Session",
        character: { id: "sender", name: "Fixture Sender", iconPath: "" },
      },
      targetSessionId: f.owner.sessionId,
      targetIncarnationId: f.owner.incarnationId,
    },
  };
  const settings = captureSessionExecutionOptions(f.session);
  const source = f.queue.enqueue(f.owner, original);
  f.queue.claimNext(f.owner);
  f.queue.markStarted(f.owner, source.id, { turnId: "42", userMessageSeq: 8 });
  const failed = f.queue.settle(f.owner, source.id, "failed");
  const retry = {
    target: { kind: "main" as const, ...f.owner },
    receiptId: source.id,
    turnId: "42",
    clientRequestId: randomUUID(),
    executionOptions: settings,
  };
  const facade = new MainSessionTurnQueueFacade({
    /** フィクスチャのストアを有効として、再実行の受付を検証する。 */ assertActive() {},
    /** 通常受付を許可し、終了中の拒否条件は持ち込まない。 */ assertAccepting() {},
    /** 再実行対象の会話を実DBから取得する。 */ getSession: async (id) =>
      f.sessions.getSession(id),
    /** 再実行設定を既定値で解決させる。 */
    getAppSettings: async () => createDefaultAppSettings(),
    /** 実ファイルシステムの検査は行わず、入力と添付の扱いを切り分ける。 */ validateWorkspace:
      async () => {},
    /** 再実行時の選択に使うCodexカタログを固定する。 */ validateProvider:
      async () => ({
        provider: {
          id: "codex",
          label: "Codex",
          models: [
            {
              id: f.session.model,
              label: f.session.model,
              reasoningEfforts: [f.session.reasoningEffort],
            },
          ],
          defaultModelId: f.session.model,
          defaultReasoningEffort: f.session.reasoningEffort,
        },
      }),
    /** 編集した本文で添付を再解決したことを確認し、新しい参照を返す。 */
    preview: async (_session, text) => {
      assert.equal(text, "Edit @new.txt");
      return { errors: [], attachments: [attachment("new.txt")] };
    },
    /** 過去の失敗に対応する入力と実行結果を、公開契約の形式で返す。 */
    readRetryExecution: async () =>
      executionOperationResultSchemas.get_execution.parse({
        ok: true,
        origin: original.origin,
        receiptId: source.id,
        receiptState: "failed",
        turnId: "42",
        turnState: "failed",
        resultState: "partial",
        userMessageSeq: 8,
        assistantMessageSeq: null,
        inputs: {
          entry: {
            receiptId: source.id,
            inputSeq: 8,
            kind: "start",
            stage: "fixed",
            comparison: "unchanged",
            detail: { operation: "get_execution_input", receiptId: source.id },
          },
          startChanged: false,
          additional: {
            confirmedCount: 0,
            references: [],
            referencesNextOffset: null,
            unresolved: [],
            unresolvedCount: 0,
            unresolvedNextOffset: null,
            notSent: [],
            notSentCount: 0,
            notSentNextOffset: null,
            coverage: "recorded",
          },
        },
        executionSettings: null,
        output: null,
      }),
    /** 再実行の受付時には編集前の添付を検証することを確認する。 */
    validateRetryAttachments: async (_session, attachments) =>
      assert.deepEqual(attachments, original.attachments),
    store: f.store,
    service,
  });
  try {
    const accepted = await facade.retryFailedSessionTurn(f.session.id, retry);
    assert.equal(
      accepted.captured.request.userMessage,
      original.request.userMessage,
    );
    assert.deepEqual(accepted.captured.attachments, original.attachments);
    assert.deepEqual(accepted.captured.retrySource?.origin, original.origin);
    assert.equal(accepted.captured.origin?.kind, "gui");
    const edit = { incarnationId: f.owner.incarnationId, id: accepted.id };
    assert.equal(
      (await facade.beginQueuedSessionTurnEdit(f.session.id, edit)).id,
      accepted.id,
    );
    const updated = await facade.updateQueuedSessionTurn(f.session.id, {
      ...edit,
      userMessage: " Edit @new.txt ",
    });
    assert.deepEqual(updated.captured, {
      ...accepted.captured,
      request: { ...accepted.captured.request, userMessage: "Edit @new.txt" },
      attachments: [attachment("new.txt")],
    });
    assert.deepEqual(updated.accepted, accepted.captured);
    assert.deepEqual(
      await facade.retryFailedSessionTurn(f.session.id, retry),
      updated,
    );
    await assert.rejects(
      facade.sendQueuedSessionInput(f.session.id, updated.id, "43"),
      /must start a new Turn/,
    );
    const cancelCandidate = await facade.retryFailedSessionTurn(f.session.id, {
      ...retry,
      clientRequestId: randomUUID(),
    });
    assert.equal(
      (await facade.cancelQueuedSessionTurn(f.session.id, cancelCandidate.id))
        .state,
      "canceled",
    );
    assert.equal(f.queue.listReceipts(f.owner).receipts.length, 3);
    busy = false;
    service.wake(f.session.id);
    await service.waitForPending();
    assert.deepEqual(
      f.queue.getReceiptById(f.owner, updated.id)?.dispatched,
      updated.captured,
    );
    assert.deepEqual(f.queue.getReceiptById(f.owner, source.id), failed);
  } finally {
    await service.close();
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "後方queuedの編集は会話全体の開始を保留し、実行中と別ownerを継続させ、更新確定後は同じ識別子と設定を保って再開する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: GUI Turn Queue; docs/design/electron-session-store.md: Turn Queue編集" }
// fault = "先行queuedを編集中にdispatchする、別ownerも停止する、編集で設定または受付識別子と順を置換する"
// observable = "dispatch済み本文列、queued receiptのID/requestID/sequence/queuePosition/captured、編集対象cancelとSteer拒否"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueService編集とSQLite queue"
// lifecycle = "permanent"
// distinction = "既存queue drain/reorder testは編集pause中の実行継続と保存更新を扱わない"
// @end-test-value
/** 後方項目を編集中は同じ会話の待機列だけを止め、編集後も同じ受付で並べ替えた順に配送する。 */
test("後方queued編集中は対象会話だけを保留して更新後に同じreceiptで再開する", async () => {
  const f = await fixture();
  const dispatched: string[] = [];
  let finish!: () => void;
  const running = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const service = new SessionTurnQueueService({
    store: f.store,
    /** 外部の実行中判定を無効にし、サービス自身の保持による停止を観測する。 */ isRunInFlight:
      () => false,
    /** 開始した本文を記録し、最初のターンだけをテストの合図まで実行中に保つ。 */ dispatch:
      async (receipt) => {
        dispatched.push(receipt.captured.request.userMessage);
        if (receipt.captured.request.userMessage === "running") await running;
        return { state: "completed" };
      },
  });
  try {
    await service.enqueue(f.owner, f.capture("running"));
    await setImmediate();
    const earlier = await service.enqueue(f.owner, f.capture("earlier"));
    const rear = await service.enqueue(f.owner, f.capture("rear"));
    assert.equal(
      (await service.beginQueuedEdit(f.owner, rear.id, async () => {})).id,
      rear.id,
    );
    finish();
    await setImmediate();
    service.reconcileKnownReceipt(rear);
    await setImmediate();
    assert.deepEqual(dispatched, ["running"]);
    await assert.rejects(
      service.cancelQueued(f.owner, rear.id),
      /being edited/,
    );
    await assert.rejects(
      service.sendQueuedInput(f.owner, rear.id, "turn"),
      /being edited/,
    );
    const other = f.sessions.insertSession({
      ...f.session,
      id: "other",
      incarnationId: "other-incarnation",
    });
    await service.enqueue(
      { sessionId: other.id, incarnationId: getSessionIncarnationId(other) },
      f.capture("independent"),
    );
    await setImmediate();
    assert.deepEqual(dispatched, ["running", "independent"]);
    await service.reorderQueued(
      f.owner,
      [earlier.id, rear.id],
      [rear.id, earlier.id],
    );
    const updated = await service.updateQueued(f.owner, rear.id, async () => ({
      userMessage: "edited",
      attachments: [],
    }));
    assert.deepEqual(
      {
        id: updated.id,
        requestId: updated.requestId,
        sequence: updated.sequence,
      },
      { id: rear.id, requestId: rear.requestId, sequence: rear.sequence },
    );
    assert.equal(updated.queuePosition, earlier.queuePosition);
    assert.deepEqual(updated.captured, {
      ...rear.captured,
      request: { ...rear.captured.request, userMessage: "edited" },
    });
    assert.deepEqual(updated.accepted, rear.captured);
    assert.equal(updated.dispatched, null);
    await service.waitForPending();
    assert.deepEqual(dispatched, [
      "running",
      "independent",
      "edited",
      "earlier",
    ]);
  } finally {
    finish();
    await service.close();
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Coordinationの配送は通常入力の編集・Steerで変更せず、拒否後に通常queueの実行を保留しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/838" }
// fault = "Coordinationを編集holdへ取り込み、storage拒否後もqueueの開始を止めるか追加入力としてclaimする"
// observable = "serviceの編集とSteer拒否、保持されたqueued状態と後続通常入力の編集成功"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueServiceのCoordination受付操作境界"
// lifecycle = "permanent"
// impact = "相談回答の保存本文と配送本文の不一致や、通常送信の停止を防ぐ"
// distinction = "storage拒否だけのtestではserviceが先に取得する編集holdやclaimを観測しない"
// @end-test-value
/** Coordination受付を編集・Steerの両方で拒否し、後続の通常項目を編集できることを確認する。 */
test("Coordination edit and Steer reject before acquiring an edit hold or dispatch claim", async () => {
  const f = await fixture();
  const service = new SessionTurnQueueService({
    store: f.store,
    /** Steerを試すため、入力の送り先となるターンがある状態にする。 */ isRunInFlight:
      () => true,
    /** 拒否すべきCoordinationが実際に追加入力として届いたら失敗させる。 */ sendInput:
      async () => {
        throw new Error("unexpected Provider input");
      },
    /** 通常配送側の依存は成功として完了させ、操作の拒否に絞る。 */ dispatch:
      async () => ({ state: "completed" }),
  });
  try {
    const receipt = f.queue.enqueue(f.owner, {
      ...f.capture("Coordination"),
      coordination: {
        id: "coordination",
        operation: "answer",
        actor: { kind: "user" },
      },
    });
    const ordinary = f.queue.enqueue(f.owner, f.capture("ordinary"));
    await assert.rejects(
      service.beginQueuedEdit(f.owner, receipt.id, async () => {}),
      /Coordination/,
    );
    await assert.rejects(
      service.sendQueuedInput(f.owner, receipt.id, "1"),
      /Coordination/,
    );
    assert.equal(f.queue.getReceiptById(f.owner, receipt.id)?.state, "queued");
    assert.equal(
      (await service.beginQueuedEdit(f.owner, ordinary.id, async () => {})).id,
      ordinary.id,
    );
    await service.cancelQueuedEdit(f.owner, ordinary.id);
  } finally {
    await service.close();
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "同じ受付の原文とclaim採用入力を別保存し、編集後も原文の再試行だけを受け付け、不明な過去原文を現在値で補わない"
// oracle = { type = "contract", ref = "GitHub Issue #832: 待機中の指示編集と再試行" }
// fault = "編集で再試行照合元を置換する、claim後に採用入力を失う、過去行の現在値を原文として返す"
// observable = "再open後のaccepted/dispatched/captured、再試行receipt ID、競合例外とID照会結果"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueStorageV6のSQLite受付・編集・claim・終端・過去行読取"
// lifecycle = "permanent"
// impact = "再送による二重実行と送信原文の誤表示を防ぐ"
// distinction = "既存編集testのplanned本文とdispatch順だけでは不変原文と固定採用入力の永続性を検出できない"
// @end-test-value
/** 編集後も同一要求の再試行は元の本文と照合し、再読時に採用入力を受付原文と取り違えない。 */
test("受付原文とclaim採用入力は編集・取消・再open後も取り違えない", async () => {
  const f = await fixture();
  try {
    const sent = f.capture("sent @original");
    const receipt = f.queue.enqueue(f.owner, sent);
    assert.equal(
      f.queue.getReceiptById(f.owner, receipt.id)?.requestId,
      receipt.requestId,
    );
    assert.equal(f.queue.getReceiptById(f.owner, "absent"), null);
    assert.throws(
      () =>
        f.queue.getReceiptById(
          { ...f.owner, incarnationId: "old" },
          receipt.id,
        ),
      /incarnation mismatch/,
    );
    const planned = f.queue.updateQueued(f.owner, receipt.id, {
      userMessage: "edited",
      attachments: [],
    });
    assert.deepEqual(planned.accepted, sent);
    assert.equal(planned.dispatched, null);
    assert.equal(f.queue.enqueue(f.owner, sent).id, receipt.id);
    assert.throws(
      () => f.queue.enqueue(f.owner, planned.captured),
      /different payload/,
    );
    const claimed = f.queue.claimNext(f.owner)!;
    assert.deepEqual(claimed.dispatched, planned.captured);
    assert.equal(f.queue.cancelQueued(f.owner, receipt.id).state, "starting");
    f.queue.settle(
      f.owner,
      receipt.id,
      "interrupted",
      "provider reply unknown",
    );
    const reopened = new SessionTurnQueueStorageV6(f.dbPath);
    try {
      const saved = reopened.getReceipt(f.owner, receipt.requestId)!;
      assert.deepEqual(saved.accepted, sent);
      assert.deepEqual(saved.dispatched, planned.captured);
      assert.equal(reopened.enqueue(f.owner, sent).state, "interrupted");
    } finally {
      reopened.close();
    }
    const db = new DatabaseSync(f.dbPath);
    try {
      db.prepare(
        "UPDATE session_turn_queue_v6 SET accepted_json = NULL, dispatched_json = NULL WHERE id = ?",
      ).run(receipt.id);
    } finally {
      db.close();
    }
    assert.equal(
      f.queue.getReceipt(f.owner, receipt.requestId)?.accepted,
      null,
    );
    assert.equal(
      f.queue.getReceipt(f.owner, receipt.requestId)?.dispatched,
      null,
    );
    assert.throws(
      () => f.queue.enqueue(f.owner, sent),
      /original.*unavailable/,
    );
  } finally {
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "同ms内の複数queue編集でも既存updatedAtを厳密前進させ、入力分割readが別の本文を混在させない変更検出値を持つ"
// oracle = { type = "contract", ref = "GitHub Issue #836: queue指示差分の分割取得中の変更検出" }
// fault = "同ms再編集で同じupdatedAtを返し古いcursorの続きに新本文を混ぜる"
// observable = "時刻固定下の2編集のreceipt.updatedAtとcaptured本文"
// observation_boundary = "public-boundary"
// scope = "SessionTurnQueueStorageV6.updateQueuedの既存更新時刻"
// lifecycle = "permanent"
// distinction = "通常の編集永続化testは同ms複数保存の更新識別を検証しない"
// @end-test-value
/** 時刻が進まない条件でも連続編集の更新時刻が厳密に進み、本文の版を識別できることを確認する。 */
test("同msのqueue編集でもupdatedAtは厳密に前進する", async () => {
  const f = await fixture();
  try {
    const receipt = f.queue.enqueue(f.owner, f.capture("original"));
    mock.method(Date, "now", () => Date.parse(receipt.updatedAt));
    const first = f.queue.updateQueued(f.owner, receipt.id, {
      userMessage: "first",
      attachments: [],
    });
    const second = f.queue.updateQueued(f.owner, receipt.id, {
      userMessage: "second",
      attachments: [],
    });
    assert.ok(first.updatedAt > receipt.updatedAt);
    assert.ok(second.updatedAt > first.updatedAt);
    assert.equal(second.captured.request.userMessage, "second");
    assert.equal(second.accepted?.request.userMessage, "original");
  } finally {
    mock.restoreAll();
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "編集失敗は停止を保持し、編集保存後も受付時入力の再試行は同じreceiptへ収束し、変更後入力でkeyを再利用できない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: GUI Turn Queue編集の停止と再開; docs/design/electron-session-store.md: Turn Queue本文添付更新" }
// fault = "失敗時にqueueを再開する、取消で本文を消す、添付を旧本文のまま保存する、旧incarnation/read-onlyを更新する"
// observable = "保存receipt payload、dispatch本文列、保存呼出回数、preview引数、旧owner/read-only/state拒否"
// observation_boundary = "public-boundary"
// scope = "MainSessionTurnQueueFacade編集、Service pause、SQLite queued条件"
// lifecycle = "permanent"
// distinction = "受付preflight testは保存済みqueuedの本文添付更新と編集停止の解除条件を扱わない"
// @end-test-value
/** プレビューや保存の失敗では配送を止めたままにし、取消または確実な保存成功後に再開する。 */
test("編集失敗は停止を保持し取消と成功時だけ再開する", async () => {
  const f = await fixture();
  let busy = true;
  let previewFails = true;
  let previewText = "";
  const dispatched: string[] = [];
  const service = new SessionTurnQueueService({
    store: f.store,
    /** 編集対象をキューに残すため、手順の途中で実行中判定を切り替える。 */ isRunInFlight:
      () => busy,
    /** 編集の停止が解けた時点で実際に配送された本文を順番に記録する。 */ dispatch:
      async (receipt) => {
        dispatched.push(receipt.captured.request.userMessage);
        return { state: "completed" };
      },
  });
  const attachment = {
    id: "new",
    kind: "file" as const,
    source: "text" as const,
    absolutePath: "C:/workspace/new.txt",
    displayPath: "new.txt",
    workspaceRelativePath: "new.txt",
    isOutsideWorkspace: false,
  };
  const facade = new MainSessionTurnQueueFacade({
    /** 初期化済みのテストストアを有効な所有者として扱う。 */ assertActive() {},
    /** 受付可能な条件に固定し、失敗を編集の検証や保存から発生させる。 */ assertAccepting() {},
    /** 対象の生存世代と読み取り専用状態を実ストアから現在値として解決する。 */ getSession:
      async (id) => f.sessions.getSession(id),
    /** 編集の検証に使う基準をアプリの既定設定に揃える。 */
    getAppSettings: async () => createDefaultAppSettings(),
    /** ファイルアクセスの成否はプレビューへ集め、作業領域検査では止めない。 */ validateWorkspace:
      async () => {},
    /** 外部Providerを起動せず、固定モデルで編集受付の検証を進める。 */ validateProvider:
      async () => ({
        provider: {
          id: "codex",
          label: "Codex",
          models: [],
          defaultModelId: "model",
          defaultReasoningEffort: "medium",
        },
      }),
    /** 正規化された本文を記録し、選択したケースに応じて添付解決の成功またはエラーを返す。 */
    preview: async (_session, text) => {
      previewText = text;
      return {
        errors: previewFails ? ["attachment unavailable"] : [],
        attachments: [attachment],
      };
    },
    store: f.store,
    service,
  });
  try {
    const original = await service.enqueue(f.owner, f.capture("original"));
    const edit = { incarnationId: f.owner.incarnationId, id: original.id };
    await assert.rejects(
      facade.beginQueuedSessionTurnEdit(f.session.id, {
        ...edit,
        incarnationId: "old",
      }),
      /identity changed/,
    );
    await facade.beginQueuedSessionTurnEdit(f.session.id, edit);
    busy = false;
    await assert.rejects(
      facade.updateQueuedSessionTurn(f.session.id, {
        ...edit,
        userMessage: "new @new.txt",
      }),
      /attachment unavailable/,
    );
    service.wake(f.session.id);
    await setImmediate();
    assert.deepEqual(dispatched, []);
    assert.deepEqual(
      f.queue.getReceipt(f.owner, original.requestId)?.captured,
      original.captured,
    );
    previewFails = false;
    const save = f.store.updateQueued;
    let saves = 0;
    f.store.updateQueued = async () => {
      saves++;
      throw new Error("save failed");
    };
    await assert.rejects(
      facade.updateQueuedSessionTurn(f.session.id, {
        ...edit,
        userMessage: "new @new.txt",
      }),
      /save failed/,
    );
    assert.equal(saves, 1);
    service.wake(f.session.id);
    await setImmediate();
    assert.deepEqual(dispatched, []);
    assert.deepEqual(
      f.queue.getReceipt(f.owner, original.requestId)?.captured,
      original.captured,
    );
    busy = true;
    await facade.cancelQueuedSessionTurnEdit(f.session.id, edit);
    assert.deepEqual(
      f.queue.getReceipt(f.owner, original.requestId)?.captured,
      original.captured,
    );
    await facade.beginQueuedSessionTurnEdit(f.session.id, edit);
    busy = false;
    f.store.updateQueued = async (...args) => {
      saves++;
      await save(...args);
      throw new Error("save reply unknown");
    };
    await assert.rejects(
      facade.updateQueuedSessionTurn(f.session.id, {
        ...edit,
        userMessage: "saved before reply loss",
      }),
      /save reply unknown/,
    );
    assert.equal(saves, 2);
    service.reconcileKnownReceipt(
      f.queue.getReceipt(f.owner, original.requestId)!,
    );
    await setImmediate();
    assert.deepEqual(dispatched, []);
    assert.equal(
      f.queue.getReceipt(f.owner, original.requestId)?.captured.request
        .userMessage,
      "saved before reply loss",
    );
    await facade.cancelQueuedSessionTurnEdit(f.session.id, edit);
    await service.waitForPending();
    assert.deepEqual(dispatched, ["saved before reply loss"]);
    f.store.updateQueued = save;
    busy = true;
    const next = await service.enqueue(f.owner, f.capture("second"));
    const nextEdit = { ...edit, id: next.id };
    await facade.beginQueuedSessionTurnEdit(f.session.id, nextEdit);
    const updated = await facade.updateQueuedSessionTurn(f.session.id, {
      ...nextEdit,
      userMessage: "  new @new.txt  ",
    });
    assert.equal(previewText, "new @new.txt");
    assert.deepEqual(updated.captured, {
      ...next.captured,
      request: { ...next.captured.request, userMessage: "new @new.txt" },
      attachments: [attachment],
    });
    assert.equal(
      (
        await facade.enqueueSessionTurn(f.session.id, {
          ...next.captured.request,
          incarnationId: f.owner.incarnationId,
        })
      ).id,
      next.id,
    );
    await assert.rejects(
      facade.enqueueSessionTurn(f.session.id, {
        ...updated.captured.request,
        incarnationId: f.owner.incarnationId,
      }),
      /different input/,
    );
    assert.equal(f.queue.listReceipts(f.owner).receipts.length, 2);
    assert.throws(
      () =>
        f.queue.updateQueued({ ...f.owner, incarnationId: "old" }, next.id, {
          userMessage: "bad",
          attachments: [],
        }),
      /incarnation mismatch/,
    );
    f.sessions.updateSession({ ...f.session, accessMode: "legacy_readonly" });
    await assert.rejects(
      facade.beginQueuedSessionTurnEdit(f.session.id, nextEdit),
      /read-only/,
    );
    f.sessions.updateSession(f.session);
    f.queue.claimNext(f.owner);
    assert.throws(
      () =>
        f.queue.updateQueued(f.owner, next.id, {
          userMessage: "bad",
          attachments: [],
        }),
      /Only a queued/,
    );
    await assert.rejects(
      facade.beginQueuedSessionTurnEdit(f.session.id, nextEdit),
      /Only a queued/,
    );
  } finally {
    await service.close();
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Worker経由の編集は同じreceiptを更新し、SQLite書込失敗では本文添付がrollbackされ、他ownerと開始済み項目は更新しない"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md: Turn Queue本文添付の同一transaction更新" }
// fault = "Worker methodが未公開、部分的に本文だけ保存、他ownerまたはstarting receiptの編集を保存する"
// observable = "Worker更新replyとSQLite正本のcaptured、ID/requestID/sequence/queuePosition、失敗後payload、owner/state拒否"
// observation_boundary = "public-boundary"
// scope = "V6StorageWorkerBundle.stores.queue.updateQueued"
// lifecycle = "permanent"
// distinction = "直接storageやservice fixtureはWorker allowlistと実SQLite失敗時の原子性を保証しない"
// @end-test-value
/** ワーカー経由でも本文と添付を同じ受付に保存し、書込失敗や対象外の受付には部分変更を残さない。 */
test("Worker queue編集は本文添付を同じreceiptへ原子的に保存する", async () => {
  const f = await fixture();
  const bundle = createV6StorageWorkerBundle({
    dbPath: f.dbPath,
    userDataPath: f.temporary,
  });
  const db = new DatabaseSync(f.dbPath);
  try {
    await bundle.initialize();
    const receipt = await bundle.stores.queue.enqueue(
      f.owner,
      f.capture("original"),
    );
    const attachment = {
      id: "new",
      kind: "file" as const,
      source: "text" as const,
      absolutePath: "C:/workspace/new.txt",
      displayPath: "new.txt",
      workspaceRelativePath: "new.txt",
      isOutsideWorkspace: false,
    };
    const updated = await bundle.stores.queue.updateQueued(
      f.owner,
      receipt.id,
      { userMessage: "edited", attachments: [attachment] },
    );
    assert.deepEqual(updated, {
      ...receipt,
      updatedAt: updated.updatedAt,
      captured: {
        ...receipt.captured,
        request: { ...receipt.captured.request, userMessage: "edited" },
        attachments: [attachment],
      },
    });
    db.exec(
      "CREATE TRIGGER reject_edit BEFORE UPDATE OF captured_json ON session_turn_queue_v6 BEGIN SELECT RAISE(ABORT, 'edit save failed'); END",
    );
    await assert.rejects(
      bundle.stores.queue.updateQueued(f.owner, receipt.id, {
        userMessage: "partial",
        attachments: [],
      }),
      /edit save failed/,
    );
    assert.deepEqual(
      f.queue.getReceipt(f.owner, receipt.requestId)?.captured,
      updated.captured,
    );
    db.exec("DROP TRIGGER reject_edit");
    const other = f.sessions.insertSession({
      ...f.session,
      id: "other",
      incarnationId: "other-incarnation",
    });
    await assert.rejects(
      bundle.stores.queue.updateQueued(
        { sessionId: other.id, incarnationId: getSessionIncarnationId(other) },
        receipt.id,
        { userMessage: "wrong owner", attachments: [] },
      ),
      /owner mismatch/,
    );
    await bundle.stores.queue.claimNext(f.owner);
    await assert.rejects(
      bundle.stores.queue.updateQueued(f.owner, receipt.id, {
        userMessage: "too late",
        attachments: [],
      }),
      /Only a queued/,
    );
    assert.deepEqual(
      f.queue.getReceipt(f.owner, receipt.requestId)?.captured,
      updated.captured,
    );
  } finally {
    db.close();
    await bundle.client.close();
    await f.close();
  }
});
