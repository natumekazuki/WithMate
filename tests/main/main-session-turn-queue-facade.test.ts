import assert from "node:assert/strict";
import test from "node:test";
import { MainSessionTurnQueueFacade, SessionTurnQueuePreflightRejectedError, type MainSessionTurnQueueFacadeDeps } from "../../src-electron/app/main-session-turn-queue-facade.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { ComposerPreview, RunSessionTurnRequest } from "../../src-shared/session/runtime-state.js";
import type { SessionTurnQueueReceipt, SessionTurnQueueStore } from "../../src-shared/session/session-turn-queue.js";

const requestId = "13d5a026-53b0-4d79-94bc-a63b7733ab10";
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
    enqueue: async (owner, captured) => {
      calls.acceptance += 1;
      const receipt: SessionTurnQueueReceipt = { ...owner, id: "durable-id", requestId: captured.request.clientRequestId,
        sequence: 1, state: "queued", captured: structuredClone(captured), turnId: null, userMessageSeq: null,
        reason: null, releasedAt: null, createdAt: "now", updatedAt: "now" };
      rows.push(receipt);
      return receipt;
    },
    getReceipt: async (owner, id) => rows.find((row) => row.requestId === id && row.incarnationId === owner.incarnationId) ?? null,
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
