import assert from "node:assert/strict";
import test from "node:test";
import { ComposerControllerRegistry } from "../../src/chat/composer-controller.js";
import { SessionTurnAcceptance } from "../../src/chat/runtime/session-turn-acceptance.js";
import { projectSessionTurnQueue } from "../../src/chat/conversation/session-turn-queue-projection.js";
import { buildMessageListProjection } from "../../src/chat/auxiliary/auxiliary-session-message-projection.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { runMainSessionTurnOperation } from "../../src/chat/runtime/run-main-session-turn-operation.js";
import { SessionSubmitCoordinator } from "../../src/chat/runtime/session-submit-coordinator.js";
import type { Session } from "../../src-shared/session/session-state.js";

const owner = { kind: "main" as const, id: "session" };
const request = {
  incarnationId: "incarnation", clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94bc", userMessage: "A", submitSource: "composer" as const,
  executionOptions: { catalogRevision: 1, model: "model", reasoningEffort: "medium" as const, approvalMode: "on-request" as const, codexSandboxMode: "workspace-write" as const, codexSpeed: "standard" as const, codexReviewer: "user" as const, customAgentName: "" },
};
function receipt(overrides: Partial<SessionTurnQueueReceipt> = {}): SessionTurnQueueReceipt {
  return { sessionId: owner.id, incarnationId: request.incarnationId, id: "item", requestId: request.clientRequestId, sequence: 1, state: "queued",
    captured: { request, attachments: [], provider: "codex", workspacePath: "workspace" }, turnId: null, userMessageSeq: null, reason: null,
    releasedAt: null, createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z", ...overrides };
}

function session(): Session {
  return { id: owner.id, incarnationId: request.incarnationId, taskTitle: "Session", status: "idle", updatedAt: "2026-10-10T00:00:00Z", isPinned: false,
    provider: "codex", ...request.executionOptions, workspaceLabel: "Workspace", workspacePath: "workspace", branch: "feature", sessionKind: "default", accessMode: "active", sourceSchemaVersion: 6,
    characterId: "mate", character: "Mate", characterIconPath: "", characterThemeColors: { main: "#000000", sub: "#000000" }, characterRuntimeSnapshot: null,
    runState: "running", allowedAdditionalDirectories: [], threadId: "thread", messages: [{ role: "user", text: "before", isBookmarked: true }], messageCount: 1, stream: [] };
}

// @test-value v2
// kind = "contract"
// claim = "Mainの明示Queue Turnはpreview待機前に捕捉した本文・設定・incarnationをdurable受付へ渡し、ACK後に該当draftだけ消す"
// oracle = { type = "contract", ref = "Issue #801: Main Send and Queue Turn admission" }
// fault = "running preflightで明示Queueを拒否する、preview後の設定へ置換する、またはdurable受付前にdraftを消す"
// observable = "enqueueへ渡したrequest、ACK前後のdraft、leaseとpending状態、返却receiptと既存Sessionの履歴・Bookmark"
// observation_boundary = "consumer"
// scope = "main-queue-operation"
// lifecycle = "permanent"
// impact = "実行中に次の依頼を予約できない、選択設定が変わる、未受付の入力を失う"
// distinction = "受付class単体ではComposer preview/preflightとRuntime operationの接続を検証しない"
// @end-test-value
test("Main Queue Turn admits captured settings after preview and clears after ACK", async () => {
  const registry = new ComposerControllerRegistry(); registry.setDraft(owner, "A");
  const selected = session();
  const coordinator = new SessionSubmitCoordinator();
  let previewDone!: (value: { attachments: []; errors: [] }) => void;
  let acknowledge!: (value: SessionTurnQueueReceipt) => void;
  let submitted: unknown;
  let pending: string | null = null;
  const operation = runMainSessionTurnOperation({
    api: { previewComposerInput: async () => new Promise((resolve) => { previewDone = resolve; }),
      enqueueSessionTurn: async (_id, input) => { submitted = input; return new Promise((resolve) => { acknowledge = resolve; }); }, getSessionTurnQueueReceipt: async () => null },
    sessionId: owner.id, selectedSession: selected, request, composerRegistry: registry, composerOwner: owner, submitCoordinator: coordinator,
    acceptance: new SessionTurnAcceptance(), queueTurn: true, clearDraft: true, collapseActionDock: false,
    selectedSessionRunState: "running", blockedReason: null, isReadOnly: false, validateWorkspace: async () => true,
    state: { setComposerPreview: (preview) => registry.setPreview(owner, preview), setPendingSubmitSessionId: (value) => { pending = typeof value === "function" ? value(pending) : value; }, setForceComposerBlockedFeedback() {}, collapseActionDock() {} }, log() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  selected.model = "changed-after-send";
  previewDone({ attachments: [], errors: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, request);
  assert.equal(registry.get(owner).draft, "A");
  assert.equal(pending, owner.id);
  const accepted = receipt(); acknowledge(accepted); assert.equal(await operation, accepted);
  assert.equal(registry.get(owner).draft, "");
  assert.equal(pending, null);
  assert.equal(coordinator.isClaimed(owner.id), false);
  assert.deepEqual(selected.messages, [{ role: "user", text: "before", isBookmarked: true }]);
  assert.equal(selected.messageCount, 1);
});

// @test-value v2
// kind = "contract"
// claim = "durable受付ACK前はdraftを保持し、ACK待ちA→B→Aの追編集は同文でも消さない"
// oracle = { type = "contract", ref = "Issue #801: durable ACK and draft revision ownership" }
// fault = "enqueue前にdraftを消す、またはACKで本文一致だけを見て新revisionを消す"
// observable = "enqueue待機中とACK後のComposer draftとclear対象revision"
// observation_boundary = "consumer"
// scope = "queue-acceptance-composer"
// lifecycle = "permanent"
// impact = "受付されていない入力やACK待ちの追編集を失う"
// distinction = "Registry単体のrevision検査では非同期durable受付境界を検証しない"
// @end-test-value
test("queue ACK clears only its captured draft revision", async () => {
  for (const edit of [false, true]) {
    const registry = new ComposerControllerRegistry(); registry.setDraft(owner, "A");
    const acceptance = new SessionTurnAcceptance();
    let resolve!: (value: SessionTurnQueueReceipt) => void;
    const api = { enqueueSessionTurn: async () => new Promise<SessionTurnQueueReceipt>((done) => { resolve = done; }), getSessionTurnQueueReceipt: async () => null };
    const pending = acceptance.submit(api, owner.id, { request, owner, revision: registry.capture(owner).revision, clearDraft: true }, registry);
    assert.equal(registry.get(owner).draft, "A");
    if (edit) { registry.setDraft(owner, "B"); registry.setDraft(owner, "A"); }
    resolve(receipt()); await pending;
    assert.equal(registry.get(owner).draft, edit ? "A" : "");
  }
});

// @test-value v2
// kind = "contract"
// claim = "受付結果不明では新要求を拒否し、明示再試行は元ID・本文・設定・incarnationを保持する"
// oracle = { type = "contract", ref = "Issue #801: uncertain acceptance identity" }
// fault = "lookup nullだけで受付なしと断定し、新IDまたは新draftで再送する"
// observable = "送信APIの要求列、結果不明中のdraft、新送信の拒否、再照会後の保持と解放"
// observation_boundary = "consumer"
// scope = "queue-unknown-retry"
// lifecycle = "permanent"
// impact = "結果不明の要求の二重実行と追編集の消失を防ぐ"
// distinction = "IPCとstorage冪等testはWindow内のrequest保持とdraft更新を通らない"
// @end-test-value
test("unknown acceptance retains its original request for manual retry", async () => {
  const registry = new ComposerControllerRegistry(); registry.setDraft(owner, "A");
  const acceptance = new SessionTurnAcceptance();
  const sent: typeof request[] = [];
  let fail = true;
  const api = { enqueueSessionTurn: async (_id: string, input: typeof request) => { sent.push(input); if (fail) throw new Error("disconnected"); return receipt(); }, getSessionTurnQueueReceipt: async () => null };
  const captured = { request, owner, revision: registry.capture(owner).revision, clearDraft: true };
  await assert.rejects(acceptance.submit(api, owner.id, captured, registry), /acceptance could not be confirmed/);
  assert.equal(acceptance.hasUncertain(owner.id), true);
  assert.equal(await acceptance.check(api, owner.id, registry), null);
  registry.setDraft(owner, "B");
  await assert.rejects(acceptance.submit(api, owner.id, { ...captured, request: { ...request, userMessage: "B" } }, registry), /previous turn/);
  assert.equal(sent.length, 1);
  fail = false; await acceptance.retry(api, owner.id, registry);
  assert.deepEqual(sent, [request, request]);
  assert.equal(registry.get(owner).draft, "B");
  assert.equal(acceptance.hasUncertain(owner.id), false);
});

// @test-value v2
// kind = "contract"
// claim = "確定未受付の応答は初回・元要求再試行ともunknownを解除し、draftを保持して理由を返す"
// oracle = { type = "contract", ref = "Issue #801: structured known rejection" }
// fault = "rejectedをACK扱いしてdraftを消すか、receipt照会してunknownを残す"
// observable = "拒否理由、draft、unknown状態、lookup回数と元要求の送信回数"
// observation_boundary = "consumer"
// scope = "queue-known-rejection"
// lifecycle = "permanent"
// impact = "未受付の入力消失と再送信不能を防ぐ"
// distinction = "RPC throwの結果不明testとは別の、Mainが未mutationを保証した応答を検証する"
// @end-test-value
test("known rejection preserves draft and releases uncertainty without receipt lookup", async () => {
  for (const retry of [false, true]) {
    const registry = new ComposerControllerRegistry(); registry.setDraft(owner, "A");
    const acceptance = new SessionTurnAcceptance();
    let lookupCount = 0; let sendCount = 0;
    const api = {
      enqueueSessionTurn: async () => { ++sendCount; if (retry && sendCount === 1) throw new Error("disconnected"); return { state: "rejected" as const, reason: "Workspace is unavailable." }; },
      getSessionTurnQueueReceipt: async () => { ++lookupCount; return null; },
    };
    const captured = { request, owner, revision: registry.capture(owner).revision, clearDraft: true };
    if (retry) await assert.rejects(acceptance.submit(api, owner.id, captured, registry), /acceptance could not be confirmed/);
    const previousLookups = lookupCount;
    await assert.rejects(retry ? acceptance.retry(api, owner.id, registry) : acceptance.submit(api, owner.id, captured, registry), /Workspace is unavailable/);
    assert.equal(lookupCount, previousLookups);
    assert.equal(sendCount, retry ? 2 : 1);
    assert.equal(registry.get(owner).draft, "A");
    assert.equal(acceptance.hasUncertain(owner.id), false);
  }
});

// @test-value v2
// kind = "contract"
// claim = "同文queue turnは保存seqとincarnationだけで接続し、terminal先着でもcanonical user到着まで本文を保持し、queued tailは受付順に並ぶ"
// oracle = { type = "contract", ref = "Issue #801: queue projection canonical barrier" }
// fault = "本文一致で別turnを結合し、terminal通知で未接続promptを落とすか旧incarnationを表示する、またはqueued tailの受付順を逆転する"
// observable = "queue source・key・本文の投影、canonical到着後の重複なし接続、FIFO tail順序"
// observation_boundary = "consumer"
// scope = "queue-conversation-projection"
// lifecycle = "permanent"
// impact = "同文連続送信や逆順通知で本文が重複・消失する"
// distinction = "storage seq整合性testはRendererのlive・saved・queue結合を検証しない"
// @end-test-value
test("queue projection uses canonical sequence and preserves terminal barrier", () => {
  const history = buildMessageListProjection([{ role: "user", text: "A", historyIndex: 40 }], [], owner.id,
    { liveAssistant: { sessionId: owner.id, threadId: "thread", messageIndex: 41, text: "live" } });
  const started = receipt({ state: "running", turnId: "turn", userMessageSeq: 42 });
  const queued = receipt({ id: "next", sequence: 2 });
  const queuedLater = receipt({ id: "later", sequence: 3 });
  const context = { sessionId: owner.id, incarnationId: request.incarnationId };
  const projected = projectSessionTurnQueue(history, [queuedLater, queued, started, receipt({ id: "old", incarnationId: "old" })], context);
  assert.deepEqual(projected.projection.messages.map((message) => message.text), ["A", "A", "live"]);
  assert.equal(projected.projection.sources[1].kind, "turn-queue");
  assert.deepEqual(projected.tail.map((row) => row.id), ["next", "later"]);
  const terminal = projectSessionTurnQueue(history, [{ ...started, state: "completed" }, queued], context);
  assert.deepEqual(terminal.projection.messages.map((message) => message.text), ["A", "A", "live"]);
  assert.deepEqual(projectSessionTurnQueue(history, [{ ...started, state: "canceled" }], context).projection.messages.map((message) => message.text), ["A", "A", "live"]);
  const canonical = buildMessageListProjection([{ role: "user", text: "A", historyIndex: 40 }, { role: "user", text: "A", historyIndex: 42 }], [], owner.id);
  const connected = projectSessionTurnQueue(canonical, [started, queued], context);
  assert.equal(connected.projection.messages.length, 2);
  assert.equal(connected.metadata.get("session-session-42")?.id, started.id);
  const paged = projectSessionTurnQueue(buildMessageListProjection([{ role: "user", text: "later", historyIndex: 100 }], [], owner.id), [{ ...started, state: "completed" }], context);
  assert.equal(paged.projection.messages.length, 1);
});
