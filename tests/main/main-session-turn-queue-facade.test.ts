import assert from "node:assert/strict";
import test from "node:test";
import { MainSessionTurnQueueFacade, SessionTurnQueuePreflightRejectedError, type MainSessionTurnQueueFacadeDeps } from "../../src-electron/app/main-session-turn-queue-facade.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { ComposerPreview, RunSessionTurnRequest } from "../../src-shared/session/runtime-state.js";
import type { SessionTurnQueueReceipt, SessionTurnQueueStore } from "../../src-shared/session/session-turn-queue.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

const requestId = "13d5a026-53b0-4d79-94bc-a63b7733ab10";
// @test-value v2
// kind = "contract"
// claim = "Coordination配送準備はexact種別とincarnationの宛先に通常Send共通preflightを適用し、本文・添付の仮受付や独立enqueueを作らない"
// oracle = { type = "contract", ref = "GitHub Issue #838: Coordinationと共通queueのatomic配送受付; GitHub Issue #832: 共通Application受付" }
// fault = "Main-firstでAux宛先を取り違える、検証中の対象置換を許可する、独立enqueueでCoordination記録と受付を分離する"
// observable = "exact resolverのkind/identity、捕捉設定、preview/enqueue呼出数、対象変更とdisabled modelの拒否"
// observation_boundary = "public-boundary"
// scope = "MainSessionTurnQueueFacade.prepareCoordinationDeliveryと通常Send共通preflight"
// lifecycle = "permanent"
// distinction = "通常Send testはcanonical Coordination本文のatomic保存前に行うcapture-only経路を通らない"
// @end-test-value
test("Coordination配送準備はexact宛先へ共通preflightだけを実施する", async () => {
  const f = fixture();
  let changed = false;
  const targets: string[] = [];
  f.deps.getSessionForCoordination = async (target) => { targets.push(target.kind); return changed ? { ...f.session, incarnationId: "replacement" } : f.session; };
  f.deps.getSession = async () => { throw new Error("A Coordination target must not use Main-first lookup"); };
  try {
    for (const kind of ["main", "auxiliary"] as const) {
      const capture = await f.facade.prepareCoordinationDelivery({ kind, sessionId: f.session.id, incarnationId: f.session.incarnationId }, requestId);
      assert.equal(capture.request.clientRequestId, requestId);
      assert.deepEqual(capture.request.executionOptions, captureSessionExecutionOptions(f.session));
      assert.equal(capture.request.userMessage, "");
      assert.deepEqual(capture.attachments, []);
      assert.equal(capture.origin, undefined);
    }
    assert.deepEqual(targets, ["main", "main", "auxiliary", "auxiliary"]);
    assert.equal(f.calls.preview, 0);
    assert.equal(f.calls.acceptance, 0);
    f.deps.validateWorkspace = async () => { changed = true; };
    await assert.rejects(f.facade.prepareCoordinationDelivery({ kind: "auxiliary", sessionId: f.session.id, incarnationId: f.session.incarnationId }, requestId), /target changed/);
    changed = false;
    f.deps.validateWorkspace = async () => {};
    const settings = createDefaultAppSettings();
    settings.modelAvailability.codex = { disabledServiceIds: [], disabledModelIds: [f.session.model] };
    f.deps.getAppSettings = async () => settings;
    await assert.rejects(f.facade.prepareCoordinationDelivery({ kind: "main", sessionId: f.session.id, incarnationId: f.session.incarnationId }, requestId), /disabled/);
    assert.equal(f.calls.acceptance, 0);
  } finally { await f.service.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "Session送信の再試行は不変の受付入力と実actorに結び付き、編集後も一件へ収束し、actor失効は受付済み仕事を取消しない"
// oracle = { type = "contract", ref = "GitHub Issue #832: 実行identityと認証寿命・受理済み実行寿命の分離" }
// fault = "編集後payloadを再試行の正本にする、他actorのkey再利用を許可する、失効時に保存済み受付を消す"
// observable = "receipt IDとcaptured/accepted、受付回数、異actorと失効actorの拒否"
// observation_boundary = "public-boundary"
// scope = "MainSessionTurnQueueFacadeのSession origin・retry・現行actor境界"
// lifecycle = "permanent"
// distinction = "GUI retry testは実actorと有効bindingの再検証を通らない"
// @end-test-value
test("Session送信は編集後も受付原文と実actorで同じreceiptへ収束する", async () => {
  const f = fixture();
  const origin = { kind: "session" as const, operation: "send" as const, actorSessionId: "parent", actorIncarnationId: "parent-incarnation", actorTurnId: "10", targetSessionId: f.session.id, targetIncarnationId: f.session.incarnationId };
  let valid = true;
  const assertActor = () => { if (!valid) throw new Error("Actor binding expired"); };
  try {
    const accepted = await f.facade.enqueueSessionTurn(f.session.id, f.input, origin, assertActor);
    accepted.captured.request.userMessage = "GUI edited";
    const retried = await f.facade.enqueueSessionTurn(f.session.id, f.input, origin, assertActor);
    assert.equal(retried.id, accepted.id);
    assert.equal(retried.captured.request.userMessage, "GUI edited");
    assert.equal(retried.accepted?.request.userMessage, f.input.userMessage.trim());
    await assert.rejects(f.facade.enqueueSessionTurn(f.session.id, f.input, { ...origin, actorSessionId: "another" }, assertActor), /different input or actor/);
    valid = false;
    await assert.rejects(f.facade.enqueueSessionTurn(f.session.id, f.input, origin, assertActor), /binding expired/);
    assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0]?.state, "queued");
    assert.equal(f.calls.acceptance, 1);
  } finally { await f.service.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "非同期preflight中に失効したactorから新規受付を保存しない"
// oracle = { type = "contract", ref = "GitHub Issue #832: 受付前と非同期検証後の実actor確認" }
// fault = "最初の認可だけで非同期検証後に失効済みactorを受理する"
// observable = "preflight拒否と受付mutation件数"
// observation_boundary = "public-boundary"
// scope = "MainSessionTurnQueueFacadeの非同期受付検証"
// lifecycle = "permanent"
// distinction = "storage型とGUI受付testはruntime binding失効の時点を再現しない"
// @end-test-value
test("preflight中のactor失効は保存前に拒否する", async () => {
  const f = fixture();
  let valid = true;
  f.deps.preview = async () => { valid = false; return f.preview; };
  try {
    await assert.rejects(f.facade.enqueueSessionTurn(f.session.id, f.input, undefined, () => { if (!valid) throw new Error("Actor binding expired"); }), /binding expired/);
    assert.equal(f.calls.acceptance, 0);
  } finally { await f.service.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "順変更APIは現行の書込可能ownerだけを許可し、捕捉済み本文/添付を再解決せず競合結果を返す"
// oracle = { type = "contract", ref = "GitHub Issue #912: incarnationと未開始列の照合、捕捉内容不変" }
// fault = "旧incarnationやread-only ownerを順変更へ渡す、または順変更で本文/添付のpreflightを再実行する"
// observable = "storeへのowner/ID列と呼出回数、返却conflict、preflight回数、旧owner/read-only拒否"
// observation_boundary = "public-boundary"
// scope = "MainSessionTurnQueueFacade.reorderQueuedSessionTurnsのowner境界"
// lifecycle = "permanent"
// impact = "再作成または参照専用会話の変更と受付済み指示の変質を防ぐ"
// distinction = "storage testは公開facadeでのread-onlyと要求incarnation検証を通らない"
// @end-test-value
test("順変更facadeはownerを照合して捕捉内容を再解決しない", async () => {
  const f = fixture();
  let calls = 0;
  f.deps.store.reorderQueued = async (owner, before, after) => {
    calls += 1;
    assert.deepEqual(owner, { sessionId: f.session.id, incarnationId: f.session.incarnationId });
    assert.deepEqual(before, ["a", "b"]);
    assert.deepEqual(after, ["b", "a"]);
    return { outcome: "conflict", receipts: [] };
  };
  const request = { incarnationId: f.session.incarnationId, expectedQueuedIds: ["a", "b"], queuedIds: ["b", "a"] };
  assert.deepEqual(await f.facade.reorderQueuedSessionTurns(f.session.id, request), { outcome: "conflict", receipts: [] });
  await assert.rejects(f.facade.reorderQueuedSessionTurns(f.session.id, { ...request, incarnationId: "old" }), /identity changed/);
  f.deps.getSession = async () => ({ ...f.session, accessMode: "legacy_readonly" });
  await assert.rejects(f.facade.reorderQueuedSessionTurns(f.session.id, request), /read-only/);
  assert.equal(calls, 1);
  assert.deepEqual(f.calls, { preview: 0, provider: 0, workspace: 0, acceptance: 0 });
  await f.service.close();
});

function fixture() {
  const session = {
    ...buildNewSession({ taskTitle: "Queue", workspaceLabel: "workspace", workspacePath: "C:/workspace",
      branch: "main", characterId: "character", character: "Character", characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "on-request" }),
    incarnationId: "current-owner",
    model: "discovered-model",
    reasoningEffort: "high",
  };
  const rows: SessionTurnQueueReceipt[] = [];
  const calls = { preview: 0, provider: 0, workspace: 0, acceptance: 0 };
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected queue operation"); };
  const store: SessionTurnQueueStore = {
    updateQueued: unexpected,
    reorderQueued: unexpected,
    enqueue: async (owner, captured) => {
      calls.acceptance += 1;
      const receipt: SessionTurnQueueReceipt = { ...owner, id: "durable-id", requestId: captured.request.clientRequestId,
        sequence: 1, queuePosition: 1, state: "queued", captured: structuredClone(captured), accepted: structuredClone(captured), dispatched: null, turnId: null, userMessageSeq: null,
        reason: null, releasedAt: null, createdAt: "now", updatedAt: "now" };
      rows.push(receipt);
      return receipt;
    },
    getReceipt: async (owner, id) => rows.find((row) => row.requestId === id && row.incarnationId === owner.incarnationId) ?? null,
    getReceiptById: async (owner, id) => rows.find((row) => row.id === id && row.incarnationId === owner.incarnationId) ?? null,
    listActive: unexpected, listReceipts: unexpected, listPendingOwners: unexpected,
    claimNext: async () => null, markStarted: unexpected, settle: unexpected, cancelQueued: unexpected,
    recoverInterrupted: unexpected, releaseInterrupted: unexpected,
    claimForInput: unexpected, restoreQueuedInput: unexpected,
  };
  const service = new SessionTurnQueueService({ store, isRunInFlight: () => true, dispatch: unexpected });
  const preview: ComposerPreview = { errors: [], attachments: [{ id: "path", kind: "file", source: "text",
    absolutePath: "C:/workspace/input.txt", displayPath: "input.txt", workspaceRelativePath: "input.txt", isOutsideWorkspace: false }] };
  const deps: MainSessionTurnQueueFacadeDeps = {
    assertActive() {}, assertAccepting() {}, getSession: async () => session,
    getAppSettings: async () => createDefaultAppSettings(),
    validateWorkspace: async () => { calls.workspace += 1; },
    validateProvider: async () => {
      calls.provider += 1;
      return { provider: { id: "codex", label: "Codex", defaultModelId: session.model,
        defaultReasoningEffort: session.reasoningEffort,
        models: [{ id: session.model, label: "Model", reasoningEfforts: [session.reasoningEffort] }] } };
    },
    preview: async () => { calls.preview += 1; return preview; }, store, service,
  };
  const input: RunSessionTurnRequest & { incarnationId: string } = {
    userMessage: "  Inspect @input.txt  ", clientRequestId: requestId, submitSource: "composer",
    executionOptions: captureSessionExecutionOptions(session), incarnationId: session.incarnationId,
  };
  return { session, rows, calls, service, preview, deps, input, facade: new MainSessionTurnQueueFacade(deps) };
}

// @test-value v2
// kind = "contract"
// claim = "新規受付は現在のModel無効化設定で拒否し、既知要求の再確認は元receiptを返す"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md#model-availability" }
// fault = "preview中に無効化されたModelを受付するか、設定変更で既知要求の再確認を拒否する"
// observable = "preflight拒否、永続受付件数、再確認時のreceipt identity"
// observation_boundary = "public-boundary"
// scope = "共通queue受付のModel無効化境界"
// lifecycle = "permanent"
// impact = "古いUIやMCPの指定で無効Modelが実行待ちに入り、再試行が重複受付になる"
// distinction = "共有判定testは受付の非同期待機と既知要求の順序を通らない"
// @end-test-value
test("受付は最新のModel無効化を適用し既知receiptは保持する", async () => {
  const f = fixture();
  const settings = createDefaultAppSettings();
  f.deps.getAppSettings = async () => settings;
  f.deps.preview = async () => {
    settings.modelAvailability.codex = { disabledServiceIds: [], disabledModelIds: [f.session.model] };
    return f.preview;
  };
  await assert.rejects(f.facade.enqueueSessionTurn(f.session.id, f.input),
    (error) => error instanceof SessionTurnQueuePreflightRejectedError && /disabled/.test(error.message));
  assert.equal(f.calls.acceptance, 0);
  settings.modelAvailability = {};
  f.deps.preview = async () => f.preview;
  const accepted = await f.facade.enqueueSessionTurn(f.session.id, f.input);
  settings.modelAvailability.codex = { disabledServiceIds: [], disabledModelIds: [f.session.model] };
  assert.equal(await f.facade.enqueueSessionTurn(f.session.id, f.input), accepted);
  await assert.rejects(f.facade.enqueueSessionTurn(f.session.id, { ...f.input, clientRequestId: "2ab10148-99c6-4f0c-a6c2-05ae0d24dc55" }), /disabled/);
  assert.equal(f.calls.acceptance, 1);
  await f.service.close();
});

// @test-value v2
// kind = "contract"
// claim = "Aux targetのqueue受付はdraft incarnation/revisionとdisplay anchorを保存し既知receipt再照会でdraftを再消費しない"
// oracle = { type = "contract", ref = "src-shared/session/runtime-state.ts RunSessionTurnRequest Auxiliary draft identity" }
// fault = "facade正規化でAux draft identityを落とすか既知要求の再送を再受付する"
// observable = "receipt captured.requestのAux fieldsと受付/preview件数"
// observation_boundary = "public-boundary"
// scope = "generic queue facade Auxiliary captured request"
// lifecycle = "permanent"
// impact = "保存済み下書きと予約が原子的に対応せず重複送信または下書き損失になる"
// distinction = "storage testはpublic facadeによるAux fieldsの脱落を検出できない"
// @end-test-value
test("Aux queue受付はdraft identityとanchorを保持する", async () => {
  const { facade, session, input, calls, service } = fixture();
  session.id = "aux-1";
  const request = { ...input, auxiliaryDraftIncarnation: "draft-1", auxiliaryDraftDurableRevision: 7, displayAnchorParentMessageCount: 3 };
  const receipt = await facade.enqueueSessionTurn(session.id, request);
  assert.equal(receipt.sessionId, "aux-1");
  assert.equal(receipt.captured.request.auxiliaryDraftIncarnation, "draft-1");
  assert.equal(receipt.captured.request.auxiliaryDraftDurableRevision, 7);
  assert.equal(receipt.captured.request.displayAnchorParentMessageCount, 3);
  assert.equal(await facade.enqueueSessionTurn(session.id, request), receipt);
  assert.equal(calls.acceptance, 1);
  assert.equal(calls.preview, 1);
  await service.close();
});

// @test-value v2
// kind = "contract"
// claim = "同じ正規化requestの並行・後続再送は終了受付停止中も同じreceiptを返し再捕捉せず、新要求は拒否する"
// oracle = { type = "contract", ref = "src-shared/session/session-turn-queue.ts SessionTurnQueueCapturedInput" }
// fault = "ACK再照会を新規受付としてpreviewし添付pathや実行設定を差し替える"
// observable = "再送のreceipt identityと保存payload、preview/provider/workspace/acceptance件数"
// observation_boundary = "public-boundary"
// scope = "Main queue facade durable receipt retry"
// lifecycle = "permanent"
// impact = "送信時と異なる入力で実行したり同じ送信を二重受付する"
// distinction = "service/store testはfacadeの再preview・catalog検証省略を通らない"
// @end-test-value
test("再送は正規化済みrequestのreceiptを返し再捕捉しない", async () => {
  const { facade, deps, input, calls, service, session } = fixture();
  const [receipt, concurrent] = await Promise.all([
    facade.enqueueSessionTurn(session.id, input),
    facade.enqueueSessionTurn(session.id, { ...input, userMessage: "Inspect @input.txt" }),
  ]);
  assert.equal(concurrent, receipt);
  deps.preview = async () => { throw new Error("Attachment disappeared"); };
  deps.validateProvider = async () => { throw new Error("Catalog changed"); };
  deps.validateWorkspace = async () => { throw new Error("Workspace unavailable"); };
  const retry = await facade.enqueueSessionTurn(session.id, { ...input, userMessage: "Inspect @input.txt" });
  assert.equal(retry, receipt);
  assert.equal(retry.id, "durable-id");
  assert.deepEqual(calls, { preview: 1, provider: 1, workspace: 1, acceptance: 1 });
  await assert.rejects(facade.enqueueSessionTurn(session.id, { ...input, userMessage: "Different" }), /different input/);
  await assert.rejects(facade.enqueueSessionTurn(session.id, { ...input, executionOptions: { ...input.executionOptions, model: "other" } }), /different input/);
  await assert.rejects(facade.enqueueSessionTurn(session.id, { ...input, submitSource: "retry" }), /different input/);
  assert.equal(calls.acceptance, 1);
  deps.assertAccepting = () => { throw new Error("closing"); };
  assert.equal(await facade.enqueueSessionTurn(session.id, input), receipt);
  await assert.rejects(facade.enqueueSessionTurn(session.id, { ...input, clientRequestId: "2ab10148-99c6-4f0c-a6c2-05ae0d24dc55" }),
    (error) => error instanceof SessionTurnQueuePreflightRejectedError && error.message === "closing");
  assert.equal(calls.acceptance, 1);
  await service.close();
});

// @test-value v2
// kind = "contract"
// claim = "受付本文・実行設定・添付descriptorは送信要求から捕捉し後のcomposer編集で変えない"
// oracle = { type = "contract", ref = "src-shared/session/session-execution-options.ts captureSessionExecutionOptions" }
// fault = "preflight待機中のcomposer編集後の本文や設定を受付payloadへ混入する"
// observable = "受付receiptの本文・executionOptions・attachment descriptor・provider/workspacePath"
// observation_boundary = "public-boundary"
// scope = "Main queue facade captured input"
// lifecycle = "permanent"
// distinction = "service/storeはfacadeがどの時点の入力を渡すか確認できない"
// @end-test-value
test("受付は本文と設定と添付path descriptorを捕捉する", async () => {
  const { facade, deps, input, preview, session, service } = fixture();
  const options = {
    model: "captured-model", reasoningEffort: "high", approvalMode: "on-request",
    codexSandboxMode: "workspace-write-network", codexSpeed: "fast", codexReviewer: "auto-review", customAgentName: "captured-agent",
  } as const;
  input.executionOptions = { ...options };
  session.model = options.model;
  session.reasoningEffort = options.reasoningEffort;
  const descriptors = structuredClone(preview.attachments);
  deps.preview = async (_, message) => {
    assert.equal(message, "Inspect @input.txt");
    input.userMessage = "Edited after submit";
    input.executionOptions = { ...input.executionOptions, model: "edited-model" };
    return preview;
  };
  const receipt = await facade.enqueueSessionTurn(session.id, input);
  assert.equal(receipt.captured.request.userMessage, "Inspect @input.txt");
  assert.deepEqual(receipt.captured.request.executionOptions, options);
  assert.deepEqual(receipt.captured.attachments, descriptors);
  assert.equal(receipt.captured.provider, session.provider);
  assert.equal(receipt.captured.workspacePath, session.workspacePath);
  await service.close();
});

// @test-value v2
// kind = "contract"
// claim = "古いincarnationとpreflight中のowner/provider/workspace変更は受付しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Session Delete" }
// fault = "削除・再作成前の送信や別実行先への変更中要求を受付する"
// observable = "受付rejectとdurable receipt件数"
// observation_boundary = "public-boundary"
// scope = "Main queue facade incarnation acceptance"
// lifecycle = "permanent"
// impact = "古いSessionの要求を新しいownerや別workspaceに実行する"
// distinction = "storeは現ownerだけ検証しfacadeのpreflight前後のidentityを比較しない"
// @end-test-value
test("旧incarnationとpreflight中の実行先変更を拒否する", async () => {
  const old = fixture();
  await assert.rejects(old.facade.enqueueSessionTurn(old.session.id, { ...old.input, incarnationId: "old" }), /identity changed/);
  assert.equal(old.calls.preview, 0);
  assert.equal(old.rows.length, 0);
  await old.service.close();
  for (const changes of [{ incarnationId: "replacement" }, { provider: "copilot" }, { workspacePath: "C:/other" }]) {
    const context = fixture();
    context.deps.preview = async () => {
      context.deps.getSession = async () => ({ ...context.session, ...changes });
      return context.preview;
    };
    await assert.rejects(context.facade.enqueueSessionTurn(context.session.id, context.input), /identity changed/);
    assert.equal(context.rows.length, 0);
    await context.service.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "workspace/catalog/preview失敗はcanonical不在確認後の専用preflight reject型で返し、不正requestも未受付にする"
// oracle = { type = "contract", ref = "AGENTS.md 失敗を成功に見せる救済を作らない" }
// fault = "preflight失敗でもreceiptを保存し成功ACKを返す"
// observable = "enqueue reject型とerror message、receipt件数・acceptance件数"
// observation_boundary = "public-boundary"
// scope = "Main queue facade preflight rejection"
// lifecycle = "permanent"
// distinction = "service/storeはworkspaceやcatalogやattachment previewを検証しない"
// @end-test-value
test("preflight失敗は全て未受付で返す", async () => {
  for (const stage of ["workspace", "catalog", "preview"] as const) {
    const context = fixture();
    const failure = new Error(`${stage} failed`);
    if (stage === "workspace") context.deps.validateWorkspace = async () => { throw failure; };
    if (stage === "catalog") context.deps.validateProvider = async () => { throw failure; };
    if (stage === "preview") context.deps.preview = async () => ({ attachments: [], errors: [failure.message] });
    await assert.rejects(context.facade.enqueueSessionTurn(context.session.id, context.input), (error) => error instanceof SessionTurnQueuePreflightRejectedError && error.message === failure.message);
    assert.equal(context.rows.length, 0);
    assert.equal(context.calls.acceptance, 0);
    await context.service.close();
  }
  for (const invalid of [{ clientRequestId: "not-a-uuid" }, { submitSource: undefined }, { userMessage: "  " }]) {
    const context = fixture();
    await assert.rejects(context.facade.enqueueSessionTurn(context.session.id, { ...context.input, ...invalid }), /message, request identity, and submit source/);
    assert.equal(context.rows.length, 0);
    assert.deepEqual(context.calls, { preview: 0, provider: 0, workspace: 0, acceptance: 0 });
    await context.service.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "lookup失敗とcommit後の返信失敗を未受付が確定した専用reject型へ変換しない"
// oracle = { type = "contract", ref = "src-electron/app/main-session-turn-queue-facade.ts SessionTurnQueuePreflightRejectedError" }
// fault = "存在照会や保存返信の不明結果をknown rejectとして返し要求再送を誘導する"
// observable = "元errorの同一性とreject型でないこと、保存済みreceipt再照会と受付件数"
// observation_boundary = "public-boundary"
// scope = "Main queue facade uncertain acceptance result"
// lifecycle = "permanent"
// impact = "受付済み要求が未受付扱いとなり再実行や下書き復元を誤る"
// distinction = "store/service testはfacadeの専用preflight型へのerror分類を通らない"
// @end-test-value
test("lookupとcommit返信の不明結果はknown rejectへ変換しない", async () => {
  for (const stage of ["lookup", "commit-reply"] as const) {
    const context = fixture();
    const failure = new Error(`${stage} unknown`);
    if (stage === "lookup") context.deps.store.getReceipt = async () => { throw failure; };
    else {
      const enqueue = context.deps.store.enqueue;
      context.deps.store.enqueue = async (...args) => { await enqueue(...args); throw failure; };
    }
    await assert.rejects(context.facade.enqueueSessionTurn(context.session.id, context.input),
      (error) => error === failure && !(error instanceof SessionTurnQueuePreflightRejectedError));
    if (stage === "lookup") {
      assert.equal(context.rows.length, 0);
      assert.deepEqual(context.calls, { preview: 0, provider: 0, workspace: 0, acceptance: 0 });
    } else {
      assert.equal(context.rows.length, 1);
      assert.equal(await context.facade.enqueueSessionTurn(context.session.id, context.input), context.rows[0]);
      assert.equal(context.calls.acceptance, 1);
    }
    await context.service.close();
  }
});
