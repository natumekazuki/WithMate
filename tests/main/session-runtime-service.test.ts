import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, mock } from "node:test";

import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { currentTimestampLabel } from "../../src-shared/time-state.js";
import type { ComposerPreview, LiveApprovalDecision, LiveApprovalRequest, LiveElicitationRequest, LiveSessionRunState, ProviderQuotaTelemetry, SessionContextTelemetry } from "../../src-shared/session/runtime-state.js";
import type { CharacterProfile } from "../../src-shared/character/character-state.js";
import type { ProjectMemoryEntry, SessionMemory } from "../../src-shared/memory/session-memory-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { type ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import {
  ProviderTurnError,
  type ProviderCodingAdapter,
  type ProviderTurnAdapter,
  type RunSessionTurnResult,
  type RunSessionTurnProgressHandler,
} from "../../src-electron/providers/provider-runtime.js";
import { SessionRuntimeFixture as SessionRuntimeService, type SessionRuntimeFixtureDeps as SessionRuntimeServiceDeps } from "./session-runtime-fixture.js";
import {
  hasMeaningfulPartialRunResult,
  isRetryableStaleThreadSessionError,
} from "../../src-electron/session/session-runtime-service.js";
import type { ConversationTimingContext } from "../../src-electron/session/conversation-timing.js";
import type { CharacterContextResponse } from "../../src-shared/character-context/character-context-contract.js";
import { CharacterAffectTurnSettlementStorage } from "../../src-electron/character/character-affect-turn-settlement-storage.js";
import { SessionWindowBridge } from "../../src-electron/windows/session-window-bridge.js";
import { WindowBroadcastService } from "../../src-electron/windows/window-broadcast-service.js";
import { AppLifecycleService } from "../../src-electron/app/app-lifecycle-service.js";
import { DEFAULT_PROVIDER_CANCEL_GRACE_MS } from "../../src-electron/session/session-run-timeouts.js";
import { MainProviderFacade } from "../../src-electron/app/main-provider-facade.js";
import { ClaudeAdapter } from "../../src-electron/providers/claude/claude-adapter.js";
import { SessionApprovalService } from "../../src-electron/session/session-approval-service.js";
import { SessionElicitationService } from "../../src-electron/session/session-elicitation-service.js";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";

async function waitForCondition(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

function createSession(overrides?: Partial<Session>): Session {
  return {
    ...buildNewSession({
      taskTitle: "Runtime Test",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    ...overrides,
  };
}

const TEST_EXECUTION_OPTIONS = captureSessionExecutionOptions(createSession());

function createSessionMemory(sessionId: string): SessionMemory {
  return {
    sessionId,
    workspacePath: "C:/workspace",
    threadId: "",
    schemaVersion: 1,
    goal: "テストする",
    decisions: [],
    openQuestions: [],
    nextActions: [],
    notes: [],
    updatedAt: new Date().toISOString(),
  };
}

function createCharacter(): CharacterProfile {
  return {
    id: "char-a",
    name: "A",
    iconPath: "",
    roleMarkdown: "落ち着いて伴走する。",
    description: "",
    notesMarkdown: "",
    themeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    updatedAt: new Date().toISOString(),
  };
}

function createProviderCatalog(id = "codex"): ModelCatalogProvider {
  return {
    id,
    label: id,
    defaultModelId: "gpt-5.4",
    defaultReasoningEffort: "high",
    models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] }],
  };
}

type CreateSessionTurnInput = Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0];
type UpdateSessionTurnInput = Parameters<SessionRuntimeServiceDeps["updateSessionTurn"]>[1];
type TerminalNotificationInput = Parameters<NonNullable<SessionRuntimeServiceDeps["notifySessionTurnTerminal"]>>[0];

const previousTestProgress = new WeakMap<RunSessionTurnProgressHandler, LiveSessionRunState>();
function emitTestProgress(handler: RunSessionTurnProgressHandler | undefined, state: LiveSessionRunState): void | Promise<void> {
  const previous = handler ? previousTestProgress.get(handler) : undefined;
  if (handler) previousTestProgress.set(handler, state);
  return handler?.(state, {
    steps: { upserts: state.steps, removes: previous?.steps.filter((step) => !state.steps.some((next) => next.id === step.id)).map((step) => step.id) ?? [] },
    backgroundTasks: { upserts: state.backgroundTasks, removes: previous?.backgroundTasks.filter((task) => !state.backgroundTasks.some((next) => next.id === task.id)).map((task) => task.id) ?? [] },
  });
}

function createTestRuntime(deps: SessionRuntimeServiceDeps): SessionRuntimeService {
  return new SessionRuntimeService(deps);
}

function createSessionTurnBase(input: CreateSessionTurnInput): SessionTurnRecord {
  return {
    id: 1,
    ...input,
  };
}

function createPartialResult(overrides?: Partial<RunSessionTurnResult>): RunSessionTurnResult {
  return {
    threadId: null,
    assistantText: "",


    usage: null,
    ...overrides,
  };
}

function createLiveRunState(overrides?: Partial<LiveSessionRunState>): LiveSessionRunState {
  return {
    sessionId: overrides?.sessionId ?? "session-1",
    threadId: overrides?.threadId ?? "",
    assistantText: overrides?.assistantText ?? "",
    reasoningText: overrides?.reasoningText ?? "",
    steps: overrides?.steps ?? [],
    backgroundTasks: overrides?.backgroundTasks ?? [],
    usage: overrides?.usage ?? null,
    errorMessage: overrides?.errorMessage ?? "",
    approvalRequest: overrides?.approvalRequest ?? null,
    elicitationRequest: overrides?.elicitationRequest ?? null,
  };
}

function createProgressRuntime(session: Session, run: ProviderCodingAdapter["runSessionTurn"], overrides: Partial<SessionRuntimeServiceDeps>): SessionRuntimeService {
  let stored = session;
  let live: LiveSessionRunState | null = null;
  const adapter: ProviderCodingAdapter = {
    composePrompt() { return { systemBodyText: "system", inputBodyText: "input", logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" }, imagePaths: [], additionalDirectories: [] }; },
    async getProviderQuotaTelemetry() { return null; },
    async invalidateSessionThread() {},
    async invalidateAllSessionThreads() {},
    runSessionTurn: run,
  };
  return createTestRuntime({
    getSession: () => stored,
    upsertSession(next) { stored = next; return next; },
    async resolveComposerPreview() { return { attachments: [], errors: [] }; },
    getAppSettings: () => normalizeAppSettings({}),
    resolveProviderCatalog: () => ({ snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() }),
    getProviderCodingAdapter: () => adapter,
    getSessionMemory: () => createSessionMemory(session.id),
    resolveProjectMemoryEntriesForPrompt: () => [],
    createSessionTurn: createSessionTurnBase,
    updateSessionTurn() {},
    setLiveSessionRun(_id, state) { live = state; },
    getLiveSessionRun: () => live,
    waitForApprovalDecision: () => "approve",
    waitForElicitationResponse: () => ({ action: "cancel" }),
    setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {},
    invalidateProviderSessionThread() {}, scheduleProviderQuotaTelemetryRefresh() {},
    broadcastLiveSessionRun() {}, resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {},
    currentTimestampLabel,
    ...overrides,
  });
}

function queuedReceipt(session: Session): SessionTurnQueueReceipt {
  return { sessionId: session.id, incarnationId: getSessionIncarnationId(session), id: "queue-1", requestId: "13d5a026-53b0-4d79-94bc-a63b7733ab10",
    sequence: 1, state: "starting", turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
    captured: { provider: session.provider, workspacePath: session.workspacePath,
      request: { clientRequestId: "13d5a026-53b0-4d79-94bc-a63b7733ab10", submitSource: "composer", userMessage: "captured message",
        executionOptions: captureSessionExecutionOptions(session) },
      attachments: [{ id: "captured-file", kind: "file", source: "text", absolutePath: "C:/workspace/captured.txt",
        displayPath: "captured.txt", workspaceRelativePath: "captured.txt", isOutsideWorkspace: false }],
    } };
}

function queueGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// @test-value v2
// kind = "contract"
// claim = "queued実行は捕捉入力と開始時threadで原子的開始しterminal ACK後だけ確定しcleanup guard解放まで次runを許可しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Session Run Cancel; src-electron/session/session-running-turn-start.ts" }
// fault = "本文を再previewするか捕捉設定を現在選択で置換し、開始を分割保存するかterminal応答でcleanup guardを解放する"
// observable = "atomic開始payload・Provider request・onStarted identity・terminal待機中の返却と実guard/release通知"
// observation_boundary = "public-boundary"
// scope = "queued runtime captured start terminal and real guard"
// lifecycle = "permanent"
// impact = "受付時と異なる入力を実行し、旧provider cleanup中に後続を二重開始する"
// distinction = "store/service testだけではruntimeのProvider request構築とterminal保存ACK境界を通らない"
// @end-test-value
it("queued runtimeは捕捉入力・atomic開始・terminal ACK・実cleanup解放を守る", async () => {
  const session = createSession({ incarnationId: "owner", threadId: "current-thread" });
  const receipt = queuedReceipt(session);
  const capturedOptions = receipt.captured.request.executionOptions;
  const currentSession = { ...session, model: "current-selection", catalogRevision: 2 };
  const terminalEntered = queueGate();
  const commit = queueGate();
  const cleanup = queueGate();
  const starts: Array<{ turnId: string; userMessageSeq: number }> = [];
  let atomics = 0;
  let releases = 0;
  let runtime!: SessionRuntimeService;
  runtime = createProgressRuntime(currentSession, async (input) => {
    assert.equal(input.session.threadId, "current-thread");
    assert.equal(input.userMessage, "captured message");
    assert.deepEqual(input.executionOptions, { ...capturedOptions, catalogRevision: 2 });
    assert.deepEqual(input.attachments, receipt.captured.attachments);
    input.onCleanupPending?.(cleanup.promise);
    return createPartialResult({ assistantText: "done" });
  }, {
    resolveComposerPreview: async () => { assert.fail("queued input must not be re-previewed"); },
    persistRunningTurnStart: () => { assert.fail("queued start must be atomic"); },
    createSessionTurn: () => { assert.fail("minimum turn belongs to atomic start"); },
    assertCapturedComposerAttachmentsAvailable: async (current, attachments) => {
      assert.equal(current.threadId, "current-thread");
      assert.deepEqual(attachments, receipt.captured.attachments);
    },
    resolveProviderCatalog: (_, revision) => {
      assert.equal(revision, undefined);
      const provider = createProviderCatalog();
      return { snapshot: { revision: 2, providers: [provider] }, provider };
    },
    persistQueuedTurnStart: (next, count, id, turn) => {
      atomics += 1;
      assert.equal(id, receipt.id);
      assert.equal(count, 0);
      assert.equal(next.messages.at(-1)?.text, "captured message");
      assert.equal(turn.userMessageSeq, count);
      return { session: next, turn: { ...turn, id: 41 } };
    },
    appendTerminalSession: async (next, terminal) => {
      assert.equal(terminal.phase, "completed");
      assert.equal(terminal.turnId, 41);
      terminalEntered.resolve();
      await commit.promise;
      return next;
    },
    onSessionRunReleased: () => { assert.equal(runtime.isRunInFlight(session.id), false); releases += 1; },
  });
  let returned = false;
  const running = runtime.runQueuedSessionTurn(receipt, async (start) => { starts.push(start); }).then((result) => { returned = true; return result; });
  await terminalEntered.promise;
  assert.equal(returned, false);
  assert.equal(runtime.isRunInFlight(session.id), true);
  commit.resolve();
  assert.deepEqual(await running, { state: "completed" });
  assert.equal(atomics, 1);
  assert.deepEqual(starts, [{ turnId: "41", userMessageSeq: 0 }]);
  assert.equal(runtime.isRunInFlight(session.id), true);
  assert.equal(releases, 0);
  let drained = false;
  const draining = runtime.waitForPendingRuns().then(() => { drained = true; });
  assert.equal(drained, false);
  cleanup.resolve();
  await draining;
  assert.equal(runtime.isRunInFlight(session.id), false);
  assert.ok(releases > 0);
  assert.equal(receipt.captured.request.executionOptions.catalogRevision, 1);
});

// @test-value v2
// kind = "contract"
// claim = "queued開始前にowner/provider/workspace/添付または捕捉modelが無効なら未開始の確定failedを返す"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Session Delete; src-shared/session/session-execution-options.ts validateSessionExecutionOptions" }
// fault = "変更されたowner/実行先や失われた添付を実行するか別modelへ自動切替する"
// observable = "failed返却、atomic開始とProviderの呼出し件数0"
// observation_boundary = "public-boundary"
// scope = "queued runtime pre-provider capture validation"
// lifecycle = "permanent"
// impact = "古いownerへの送信や受付と異なるpath/modelの外部実行を防ぐ"
// distinction = "受付時facadeとstore検査では実行開始時の現在認可とcatalogを検証できない"
// @end-test-value
it("queued runtimeは無効になった捕捉入力を開始前にfailedで返す", async () => {
  for (const stage of ["owner", "provider", "workspace", "attachment", "model"] as const) {
    const session = createSession({ incarnationId: "owner" });
    const receipt = queuedReceipt(session);
    const current = { ...session, ...(stage === "owner" ? { incarnationId: "new-owner" } : {}),
      ...(stage === "provider" ? { provider: "copilot" } : {}), ...(stage === "workspace" ? { workspacePath: "C:/other" } : {}) };
    let starts = 0;
    let providers = 0;
    const runtime = createProgressRuntime(current, async () => { providers += 1; return createPartialResult(); }, {
      assertCapturedComposerAttachmentsAvailable: async () => { if (stage === "attachment") throw new Error("Captured attachment disappeared"); },
      persistQueuedTurnStart: (next, _, __, turn) => { starts += 1; return { session: next, turn: { id: 1, ...turn } }; },
      resolveProviderCatalog: () => {
        const provider = createProviderCatalog();
        if (stage === "model") provider.models = [];
        return { snapshot: { revision: 2, providers: [provider] }, provider };
      },
    });
    const result = await runtime.runQueuedSessionTurn(receipt, async () => { assert.fail("Rejected start cannot be observed as started"); });
    assert.equal(result.state, "failed");
    assert.ok(result.reason);
    assert.equal(starts, 0);
    assert.equal(providers, 0);
    assert.equal(runtime.isRunInFlight(session.id), false);
  }
});

// @test-value v2
// kind = "contract"
// claim = "queued atomic開始またはterminal保存の結果不明はgeneric throwのまま伝播し別failed保存で救済しない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md Decision" }
// fault = "commit返信喪失を確定failedへ変換し後続を自動dispatch可能にする"
// observable = "元error同一性、terminal保存phase列、Provider呼出し件数"
// observation_boundary = "public-boundary"
// scope = "queued runtime unknown persistence boundary"
// lifecycle = "permanent"
// impact = "保存済みか不明な要求を再実行したり後続を誤って進める"
// distinction = "store testではruntimeの保存失敗catchとfailed保存への変換を観測できない"
// @end-test-value
it("queued runtimeは開始とterminal保存の不明結果を救済しない", async () => {
  for (const stage of ["start", "terminal"] as const) {
    const session = createSession({ incarnationId: "owner" });
    const receipt = queuedReceipt(session);
    const failure = new Error(`${stage} commit outcome unknown`);
    const phases: string[] = [];
    let providers = 0;
    const runtime = createProgressRuntime(session, async () => { providers += 1; return createPartialResult({ assistantText: "done" }); }, {
      assertCapturedComposerAttachmentsAvailable: async () => {},
      persistQueuedTurnStart: (next, _, __, turn) => { if (stage === "start") throw failure; return { session: next, turn: { id: 41, ...turn } }; },
      appendTerminalSession: (_, terminal) => { phases.push(terminal.phase); throw failure; },
    });
    await assert.rejects(runtime.runQueuedSessionTurn(receipt, async () => {}), (error) => error === failure);
    assert.equal(providers, stage === "start" ? 0 : 1);
    assert.deepEqual(phases, stage === "start" ? [] : ["completed"]);
    await runtime.waitForPendingRuns();
  }
});

// @test-value v2
// kind = "contract"
// claim = "queued provider失敗/取消はACKされたterminal phaseを確定結果として返す"
// oracle = { type = "contract", ref = "src-electron/session/session-turn-terminal-commit.ts SessionTurnTerminalCommit" }
// fault = "保存済み取消をfailedへ変換するかACK前に結果を返す"
// observable = "appendTerminal phaseとdispatch返却state、onStarted minimum turn ID"
// observation_boundary = "public-boundary"
// scope = "queued runtime confirmed failure and cancellation"
// lifecycle = "permanent"
// distinction = "serviceのfake dispatch resultではruntimeの実terminal phaseとの対応を保証できない"
// @end-test-value
it("queued runtimeは保存済みfailedとcanceledを区別する", async () => {
  for (const canceled of [false, true]) {
    const session = createSession({ incarnationId: "owner" });
    const phases: string[] = [];
    const runtime = createProgressRuntime(session, async () => { throw new ProviderTurnError("stopped", createPartialResult(), canceled); }, {
      assertCapturedComposerAttachmentsAvailable: async () => {},
      persistQueuedTurnStart: (next, _, __, turn) => ({ session: next, turn: { id: 41, ...turn } }),
      appendTerminalSession: (next, terminal) => { phases.push(terminal.phase); return next; },
    });
    const result = await runtime.runQueuedSessionTurn(queuedReceipt(session), async (started) => { assert.equal(started.turnId, "41"); });
    assert.equal(result.state, canceled ? "canceled" : "failed");
    assert.deepEqual(phases, [canceled ? "canceled" : "failed"]);
  }
});

describe("SessionRuntimeService stale retry helpers", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "stale classifierはnarrowなthread/session系errorだけをretry対象にする"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: isRetryableStaleThreadSessionError" }
  // fault = "無関係なprovider errorをstale扱いしてretryする、またはstale errorを見逃す"
  // observable = "isRetryableStaleThreadSessionErrorのthread/session文字列・codeに対するtrueと汎用not_found/model_incompatible/接続errorに対するfalse"
  // observation_boundary = "component-behavior"
  // scope = "SessionRuntimeService stale error classifier"
  // lifecycle = "permanent"
  // @end-test-value
  it("stale classifier は narrow な thread / session 系だけを対象にする", () => {
    assert.equal(isRetryableStaleThreadSessionError(new Error("thread not found")), true);
    assert.equal(isRetryableStaleThreadSessionError(new Error("session expired on provider side")), true);
    assert.equal(isRetryableStaleThreadSessionError(new Error("invalid-thread identifier")), true);
    assert.equal(isRetryableStaleThreadSessionError(new Error("thread model incompatible with selected model")), true);
    assert.equal(isRetryableStaleThreadSessionError(new Error("SessionNotFound")), true);
    assert.equal(isRetryableStaleThreadSessionError(new Error("session_not_found")), true);
    assert.equal(isRetryableStaleThreadSessionError({ code: "thread_not_found" }), true);
    assert.equal(isRetryableStaleThreadSessionError({ code: "not_found" }), false);
    assert.equal(isRetryableStaleThreadSessionError({ code: "model_incompatible" }), false);
    assert.equal(isRetryableStaleThreadSessionError(new Error("Connection is closed.")), false);
    assert.equal(isRetryableStaleThreadSessionError(new Error("socket hang up")), false);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "meaningful partial判定はassistantTextまたは通常artifactの情報を観測する"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: hasMeaningfulPartialRunResult / hasMeaningfulArtifact" }
  // fault = "利用者に返せるpartial情報を空扱いし、不要なretryまたは破棄を行う"
  // observable = "hasMeaningfulPartialRunResultの空結果=false、本文・operationTimeline・changedFilesあり=true"
  // observation_boundary = "component-behavior"
  // scope = "SessionRuntimeService partial response classification"
  // lifecycle = "permanent"
  // @end-test-value
  it("meaningful partial 判定は assistantText と通常artifactを見る", () => {
    assert.equal(hasMeaningfulPartialRunResult(createPartialResult()), false);
    assert.equal(hasMeaningfulPartialRunResult(createPartialResult({ assistantText: "partial" })), true);
    assert.equal(hasMeaningfulPartialRunResult(createPartialResult({ artifact: {
      title: "", activitySummary: [], changedFiles: [], runChecks: [],
      operationTimeline: [{ type: "command_execution", summary: "npm test" }],
    } })), true);
    assert.equal(hasMeaningfulPartialRunResult(createPartialResult({
      artifact: {
        title: "Artifact",
        activitySummary: [],
        changedFiles: [{ kind: "edit", path: "src/a.ts", summary: "updated", diffRows: [] }],
        runChecks: [],
      },
    })), true);
  });
});
describe("SessionRuntimeService", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "streamのdelta数にかかわらず最小turnは開始と終端だけ保存し、取得済み本文と個別操作結果は通常履歴へ保持する"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md: 通常履歴と最小turn; src-electron/session/session-runtime-service.ts: runSessionTurnInternal" }
  // fault = "deltaごとにcreate/updateSessionTurnを呼ぶか、失敗・取消の返却履歴からpartial artifactを捨ててturn phaseから操作結果を生成する"
  // observable = "create/updateSessionTurn入力のphase列とcreatedAt/completedAt、返却Session最終messageの本文とoperationTimeline"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService minimal turn and history persistence"
  // lifecycle = "permanent"
  // impact = "長い応答で保存量が増幅するか、取得済み操作結果を失う"
  // distinction = "storage型検査だけではruntimeのstream配送とterminal history保存を接続できない"
  // @end-test-value
  it("delta数が異なっても開始と終端だけ保存し、全phaseの通常artifactを保持する", async () => {
    for (const outcome of ["completed", "failed", "canceled"] as const) for (const deltaCount of [1, 250]) {
      const session = createSession();
      const writes: CreateSessionTurnInput[] = [];
      const operation = { id: "command-1", type: "command_execution", summary: "npm test", status: "failed", exitCode: 3, error: { message: "check failed", code: "CHECK" }, truncated: true };
      const partial = createPartialResult({ assistantText: "取得済み本文", artifact: { title: "", activitySummary: [], changedFiles: [], runChecks: [], operationTimeline: [operation] } });
      const service = createProgressRuntime(session, async (input, progress) => {
        for (let delta = 0; delta < deltaCount; delta += 1) await emitTestProgress(progress, createLiveRunState({ sessionId: input.session.id, assistantText: `partial-${delta}` }));
        if (outcome !== "completed") throw new ProviderTurnError("provider stopped", partial, outcome === "canceled");
        return partial;
      }, {
        createSessionTurn(input) { writes.push(input); return createSessionTurnBase(input); },
        updateSessionTurn(_id, input) { writes.push(input); },
      });
      const result = await service.runSessionTurn(session.id, { userMessage: "run", executionOptions: TEST_EXECUTION_OPTIONS });
      assert.deepEqual(writes.map((entry) => entry.phase), ["running", outcome]);
      assert.equal(writes[1]?.createdAt, writes[0]?.createdAt);
      assert.equal(typeof writes[1]?.completedAt, "string");
      assert.match(result.messages.at(-1)?.text ?? "", /取得済み本文/);
      assert.deepEqual(result.messages.at(-1)?.artifact?.operationTimeline, [operation]);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Codex失敗時はSessionの保存threadと最小turnの実行threadを維持し、terminal保存後の通知が失敗してもcleanupする"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: runSessionTurnInternal catch / notifySessionTurnTerminalBestEffort / invalidateProviderSessionThreadBestEffort; docs/design/provider-adapter.md: Error Handling" }
  // fault = "保存threadをlive threadで上書きする、partial threadId欠如でturnのlive情報を失う、または通知失敗でcleanupを止める"
  // scope = "session-runtime-failed-terminal-notification"
  // observable = "SessionとturnのthreadId、通知回数と保存・cleanup順序"
  // observation_boundary = "public-boundary"
  // lifecycle = "permanent"
  // impact = "失敗後の会話継続先や実行先を失い、終了処理が止まる"
  // distinction = "復帰失敗の単体testはlive progressと保存threadが異なる場合のturn・Session分離を確認しない"
  // @end-test-value
  it("failed 最小turn は partial threadId が無くても live progress の threadId を維持する", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-stale" });
    let live: LiveSessionRunState | null = null;
    const storedSessions: Session[] = [];
    const turnUpdates: UpdateSessionTurnInput[] = [];
    const terminalNotifications: TerminalNotificationInput[] = [];
    const terminalOrder: string[] = [];

    const service = createProgressRuntime(session, async (input, onProgress) => {
      await emitTestProgress(onProgress, createLiveRunState({
        sessionId: input.session.id,
        threadId: "thread-live",
      }));
      throw new ProviderTurnError("network timeout", createPartialResult(), false);
    }, {
      upsertSession(next) {
        storedSessions.push(next);
        if (next.runState === "error") terminalOrder.push("failed-upsert");
        return next;
      },
      updateSessionTurn(_id, entry) { turnUpdates.push(entry); },
      setLiveSessionRun(_id, state) { live = state; },
      getLiveSessionRun() { return live; },
      invalidateProviderSessionThread() { terminalOrder.push("provider-cleanup"); },
      notifySessionTurnTerminal(notification) {
        terminalNotifications.push(notification);
        terminalOrder.push("terminal-notification");
        throw new Error("notification failed");
      },
    });

    const result = await service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });
    await waitForCondition(() => turnUpdates.at(-1)?.phase === "failed", "failed最小turnが保存されること");

    assert.equal(result.runState, "error");
    assert.equal(result.threadId, "thread-stale");
    assert.equal(storedSessions.at(-1)?.threadId, "thread-stale");
    assert.equal(turnUpdates.at(-1)?.phase, "failed");
    assert.equal(turnUpdates.at(-1)?.threadId, "thread-live");
    assert.equal(terminalNotifications.length, 1);
    assert.equal(terminalNotifications[0]?.outcome, "failed");
    assert.deepEqual(terminalNotifications[0]?.session, { ...storedSessions.at(-1), messageCount: storedSessions.at(-1)!.messages.length });
    assert.deepEqual(terminalOrder, ["failed-upsert", "terminal-notification", "provider-cleanup"]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "終端保存の例外は自動再保存やfailedへの置換をせず呼出元へ返す"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: appendTerminalSession / runSessionTurnInternal; docs/design/provider-adapter.md: 通常履歴と最小turn" }
  // fault = "終端保存例外をprovider失敗と扱い別のterminalを書き、未確定結果を成功またはfailedに隠す"
  // observable = "公開run APIのreject、terminal保存とProvider・通知の呼出数"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService terminal persistence failure boundary"
  // lifecycle = "permanent"
  // impact = "保存結果が不明な会話の重複や、完了済み応答の結果改変を防ぐ"
  // distinction = "Storage Workerのunknown outcome testはruntimeのcatchから二つ目の終端を保存する経路を通らない"
  // @end-test-value
  it("終端保存の例外を再保存せず返し、terminal通知をしない", async () => {
      const session = createSession();
      let providerCalls = 0;
      let terminalCalls = 0;
      let notifications = 0;
      const persistenceError = new Error("Persistence outcome unknown");
      const service = createProgressRuntime(session, async () => { providerCalls += 1; return createPartialResult({ assistantText: "completed" }); }, {
        appendTerminalSession() { terminalCalls += 1; throw persistenceError; },
        notifySessionTurnTerminal() { notifications += 1; },
      });
      await assert.rejects(service.runSessionTurn(session.id, { userMessage: "run", executionOptions: TEST_EXECUTION_OPTIONS }), (error) => error === persistenceError);
      assert.equal(providerCalls, 1);
      assert.equal(terminalCalls, 1);
      assert.equal(notifications, 0);
      assert.equal(service.isRunInFlight(session.id), false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "取消deadlineで取得済みlive本文と操作を通常artifactへ保存し、未完了の操作statusをcanceledへ改変しない"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: buildCanceledPartialResult / waitForProviderTurnWithCancelDeadline; docs/design/provider-adapter.md: Error Handling / 通常履歴と最小turn" }
  // fault = "deadline partialを本文だけ保存するか、turnの取消を個別操作の確定結果として補完する"
  // observable = "返却Sessionの本文とoperationTimeline、最小turnのphase"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService cancellation deadline artifact"
  // lifecycle = "permanent"
  // impact = "途中出力と操作の実際の確定状態を保持する"
  // distinction = "Provider正常応答のpartial testではdeadlineのlive projection経路を通らない"
  // @end-test-value
  it("取消deadlineは取得済みlive操作を通常artifactに保存する", async () => {
    const session = createSession();
    let progressSeen = false;
    let finishProvider!: (result: RunSessionTurnResult) => void;
    const providerEnd = new Promise<RunSessionTurnResult>((resolve) => { finishProvider = resolve; });
    const writes: CreateSessionTurnInput[] = [];
    const step = { id: "command-1", type: "command_execution", summary: "npm test", status: "in_progress", details: "取得済み出力", truncated: true };
    const service = createProgressRuntime(session, async (input, progress) => {
      await emitTestProgress(progress, createLiveRunState({ sessionId: input.session.id, assistantText: "途中本文", steps: [step] }));
      progressSeen = true;
      return providerEnd;
    }, { providerCancelGraceMs: 1, updateSessionTurn(_id, input) { writes.push(input); } });
    const run = service.runSessionTurn(session.id, { userMessage: "run", executionOptions: TEST_EXECUTION_OPTIONS });
    await waitForCondition(() => progressSeen, "provider live state");
    service.cancelRun(session.id);
    const result = await run;
    finishProvider(createPartialResult());
    assert.equal(writes[0]?.phase, "canceled");
    assert.match(result.messages.at(-1)?.text ?? "", /途中本文/);
    assert.deepEqual(result.messages.at(-1)?.artifact?.operationTimeline, [step]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Renderer死亡後の再openと保存待ち中closeでもMainの既存Provider実行は一度だけ継続し、Sessionの最終応答保存を待ってrun結果を返す"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: Session Window Close; src-electron/session/session-runtime-service.ts: appendTerminalSession / runSessionTurnInternal" }
  // fault = "表示の復旧で既存turnをcancelまたは再実行するか、壊れたRendererへの通知例外でterminal応答保存を失う"
  // observable = "provider呼出し数、abort状態、保存gate前後のstoredSession/run結果の本文・runStateと保存待ち中のisRunInFlight"
  // observation_boundary = "public-boundary"
  // scope = "session-runtime-renderer-recovery-persistence"
  // lifecycle = "permanent"
  // impact = "provider応答を失うか、同じ作業を再実行して結果が二重化する"
  // distinction = "bridge単体のcloseとruntime単体の保存testを実際のrun Promiseで接続し、表示障害とterminal保存待ちの独立性を一つのturnで検証する"
  // @end-test-value
  it("Rendererの再openと保存待ちcloseを越えてprovider応答を一度だけ保存する", async () => {
    let stored = createSession();
    let live: LiveSessionRunState | null = null;
    let finishProvider!: () => void;
    let finishSave!: () => void;
    const providerGate = new Promise<void>((resolve) => { finishProvider = resolve; });
    const saveGate = new Promise<void>((resolve) => { finishSave = resolve; });
    let providerCalls = 0;
    let providerSignal: AbortSignal | undefined;
    let saveStarted = false;
    const turnUpdates: UpdateSessionTurnInput[] = [];
    class RuntimeWindow {
      destroyed = false;
      readonly closedListeners: Array<() => void> = [];
      readonly closeListeners: Array<(event: { preventDefault(): void }) => void> = [];
      webContents = { send() { throw new Error("renderer unavailable"); } };
      isDestroyed() { return this.destroyed; }
      isMinimized() { return false; }
      restore() {} focus() {} show() {}
      once(_event: "ready-to-show", _listener: () => void) {}
      on(event: "close", listener: (event: { preventDefault(): void }) => void): void;
      on(event: "closed", listener: () => void): void;
      on(event: "close" | "closed", listener: ((event: { preventDefault(): void }) => void) | (() => void)) {
        if (event === "closed") this.closedListeners.push(listener as () => void);
        else this.closeListeners.push(listener as (event: { preventDefault(): void }) => void);
      }
      close() {
        let prevented = false;
        for (const listener of this.closeListeners) listener({ preventDefault() { prevented = true; } });
        if (!prevented) this.destroy();
      }
      destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        for (const listener of this.closedListeners.splice(0)) listener();
      }
    }
    const windows: RuntimeWindow[] = [];
    const rendererObservers = new Map<RuntimeWindow, (state: "responsive" | "unresponsive" | "gone") => void>();
    const broadcast = new WindowBroadcastService({
      getAllWindows: () => windows, getHomeWindows: () => [], getPrimaryHomeWindow: () => null, getSessionWindows: () => windows,
      getLiveSessionRunStatusWindows: () => [], getLiveSessionRunWindow: () => bridge.getWindow(stored.id),
    });
    const adapter: ProviderCodingAdapter = {
      composePrompt: () => ({ systemBodyText: "system", inputBodyText: "input", logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" }, imagePaths: [], additionalDirectories: [] }),
      getProviderQuotaTelemetry: async () => null, invalidateSessionThread: async () => {}, invalidateAllSessionThreads: async () => {},
      runSessionTurn: async (input) => {
        providerCalls += 1;
        providerSignal = input.signal;
        await providerGate;
        return createPartialResult({ assistantText: "durable provider response" });
      },
    };
    const service = createTestRuntime({
      getSession: () => stored, upsertSession: (next) => { stored = next; return next; },
      upsertTerminalSession: async (next) => { saveStarted = true; await saveGate; stored = next; return next; },
      resolveComposerPreview: async () => ({ attachments: [], errors: [] }), getAppSettings: () => normalizeAppSettings({}),
      resolveProviderCatalog: () => ({ snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() }),
      getProviderCodingAdapter: () => adapter, getSessionMemory: (session) => createSessionMemory(session.id), resolveProjectMemoryEntriesForPrompt: () => [],
      createSessionTurn: createSessionTurnBase, updateSessionTurn: (_id, input) => { turnUpdates.push(input); },
      setLiveSessionRun: (_id, next) => { live = next; }, getLiveSessionRun: () => live,
      waitForApprovalDecision: () => "deny", waitForElicitationResponse: () => ({ action: "cancel" }),
      setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, async invalidateProviderSessionThread() {}, scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun: (id) => broadcast.broadcastLiveSessionRun(id, live), resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {},
    });
    const bridge = new SessionWindowBridge({
      createWindow: () => { const window = new RuntimeWindow(); windows.push(window); return window; },
      observeRendererState: (window, changed) => { rendererObservers.set(window, changed); },
      async loadChatEntry() {}, getSession: () => stored, isRunInFlight: (id) => service.isRunInFlight(id),
      confirmCloseWhileRunning: () => true, broadcastOpenSessionWindowIds() {},
      getWindowSender: (window) => window, sendDraftFlushRequest() { throw new Error("renderer unavailable"); },
      cancelInFlightSessionRuns: () => service.cancelAllRuns(),
    });
    const first = await bridge.openSessionWindow(stored.id);
    const turn = service.runSessionTurn(stored.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "start" });
    try {
      await waitForCondition(() => providerCalls === 1, "provider must start");
      rendererObservers.get(first)!("gone");
      const second = await bridge.openSessionWindow(stored.id);
      assert.notEqual(first, second);
      assert.equal(providerSignal?.aborted, false);
      finishProvider();
      await waitForCondition(() => saveStarted, "terminal persistence must start despite failing Renderer broadcasts");
      assert.notEqual(stored.messages.at(-1)?.text, "durable provider response");
      assert.equal(await bridge.requestCloseSessionWindow(stored.id), true);
      const third = await bridge.openSessionWindow(stored.id);
      assert.notEqual(second, third);
      assert.equal(providerSignal?.aborted, false);
      assert.equal(service.isRunInFlight(stored.id), true);
      finishSave();
      const result = await turn;
      assert.equal(providerCalls, 1);
      assert.equal(result.messages.at(-1)?.text, "durable provider response");
      assert.equal(stored.messages.at(-1)?.text, "durable provider response");
      assert.equal(stored.runState, "idle");
    } finally {
      finishProvider(); finishSave();
      await turn;
      for (const window of windows) window.destroy();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "completed結果はcleanup待機で失敗へ変わらず、process実終了の通知までruntimeの再送と未確認quitを保護する"
  // oracle = { type = "contract", ref = "docs/adr/002-provider-turn-terminal-and-cancellation.md#現在の適用範囲" }
  // fault = "adapterのcleanup completionをMainへ接続せず、completed保存後にadmission guardとquit保護を解放する"
  // observable = "返却SessionとTurn phase、isRunInFlight/hasInFlightRuns、live cancellationState、再送拒否、quit確認とDB close回数"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService adapter cleanup admission and quit boundary"
  // lifecycle = "permanent"
  // impact = "生存中のproviderと再送が競合し、未終了processを残したまま未確認終了する"
  // distinction = "transportやadapter単体testはMain callback結線とcompleted保存後のruntime/AppLifecycle保護を通らない。単一の遅延completionで結線を維持する"
  // @end-test-value
  it("completed後もprovider cleanupの実終了まで再送とquitを保護する", async () => {
    let stored = createSession();
    let live: LiveSessionRunState | null = null;
    let completeCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { completeCleanup = resolve; });
    let providerCalls = 0;
    const turnUpdates: UpdateSessionTurnInput[] = [];
    const adapter: ProviderCodingAdapter = {
      composePrompt: () => ({ systemBodyText: "system", inputBodyText: "input", logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" }, imagePaths: [], additionalDirectories: [] }),
      getProviderQuotaTelemetry: async () => null, invalidateSessionThread: async () => {}, invalidateAllSessionThreads: async () => {},
      runSessionTurn: async (input) => {
        providerCalls += 1;
        if (providerCalls === 1) input.onCleanupPending?.(cleanup);
        return createPartialResult({ assistantText: "completed response" });
      },
    };
    const service = createTestRuntime({
      getSession: () => stored, upsertSession: (next) => { stored = next; return next; },
      resolveComposerPreview: async () => ({ attachments: [], errors: [] }), getAppSettings: () => normalizeAppSettings({}),
      resolveProviderCatalog: () => ({ snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() }),
      getProviderCodingAdapter: () => adapter, getSessionMemory: (session) => createSessionMemory(session.id), resolveProjectMemoryEntriesForPrompt: () => [],
      createSessionTurn: createSessionTurnBase, updateSessionTurn: (_id, input) => { turnUpdates.push(input); },
      setLiveSessionRun: (_id, next) => { live = next; }, getLiveSessionRun: () => live,
      waitForApprovalDecision: () => "deny", waitForElicitationResponse: () => ({ action: "cancel" }),
      setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, async invalidateProviderSessionThread() {}, scheduleProviderQuotaTelemetryRefresh() {}, broadcastLiveSessionRun() {}, resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {},
    });
    let quitConfirmations = 0;
    let storeCloses = 0;
    let quits = 0;
    const lifecycle = new AppLifecycleService({
      hasInFlightSessionRuns: () => service.hasInFlightRuns(), getAllowQuitWithInFlightRuns: () => false,
      setAllowQuitWithInFlightRuns() {}, async createHomeWindow() {}, shouldQuitWhenAllWindowsClosed: () => false,
      confirmQuitWhileRunning: () => { quitConfirmations += 1; return false; },
      closePersistentStores: () => { storeCloses += 1; }, quitApp: () => { quits += 1; },
    });
    try {
      const result = await service.runSessionTurn(stored.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "start" });
      assert.equal(result.runState, "idle");
      assert.equal(result.messages.at(-1)?.text, "completed response");
      await waitForCondition(() => turnUpdates.some((entry) => entry.phase === "completed"), "completed turn must persist while cleanup is pending");
      assert.equal(turnUpdates.some((entry) => entry.phase === "failed"), false);
      assert.equal(service.isRunInFlight(stored.id), true);
      assert.equal(service.hasInFlightRuns(), true);
      assert.equal((live as LiveSessionRunState | null)?.cancellationState, "terminating");
      await assert.rejects(service.runSessionTurn(stored.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "too early" }), /already running/);
      assert.equal(providerCalls, 1);
      await lifecycle.handleBeforeQuit({ preventDefault() {} });
      assert.equal(quitConfirmations, 1);
      assert.equal(storeCloses, 0);
      assert.equal(quits, 0);
      completeCleanup();
      await waitForCondition(() => !service.isRunInFlight(stored.id), "cleanup completion must release admission");
      assert.equal(service.hasInFlightRuns(), false);
      assert.equal((live as LiveSessionRunState | null)?.cancellationState, undefined);
      const next = await service.runSessionTurn(stored.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "after cleanup" });
      assert.equal(next.runState, "idle");
      assert.equal(providerCalls, 2);
      await lifecycle.handleBeforeQuit({ preventDefault() {} });
      assert.equal(quitConfirmations, 1);
      assert.equal(storeCloses, 1);
      assert.equal(quits, 1);
    } finally {
      completeCleanup();
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Codexの追加入力は捕捉したactive turnだけへ一度送信され、確定user本文をterminal保存へ維持する"
  // oracle = { type = "contract", ref = "Issue #780 explicit same-turn input" }
  // fault = "追加入力を新turnへ送る、重複送信する、またはterminalが受理済み本文を上書きする"
  // observable = "adapter steer要求と回数、公開API結果、保存済みmessage列、重複要求のreject"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService Codex steer admission and terminal persistence"
  // lifecycle = "permanent"
  // impact = "入力が別作業へ適用されるか受理済み会話を失う"
  // distinction = "adapter単体testではruntime排他とterminal保存の競合を検出しない"
  // @end-test-value
  it("Codex steerは同turnへ一度送りterminalに受理済み入力を残す", async () => {
    let stored = createSession({ threadId: "thread-existing" });
    let live: LiveSessionRunState | null = null;
    let finishTurn!: () => void;
    const turnEnd = new Promise<void>((resolve) => { finishTurn = resolve; });
    let finishInput!: () => void;
    const inputEnd = new Promise<void>((resolve) => { finishInput = resolve; });
    const sent: Array<Parameters<NonNullable<ProviderCodingAdapter["steerSessionTurn"]>>[0]> = [];
    const adapter: ProviderCodingAdapter = {
      composePrompt: () => ({ systemBodyText: "system", inputBodyText: "input", logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" }, imagePaths: [], additionalDirectories: [] }),
      getProviderQuotaTelemetry: async () => null, invalidateSessionThread: async () => {}, invalidateAllSessionThreads: async () => {},
      runSessionTurn: async (input, progress) => {
        await emitTestProgress(progress, { ...createLiveRunState(), sessionId: input.session.id, threadId: "thread-existing", turnId: "turn-one", inputAvailable: true });
        await turnEnd;
        return createPartialResult({ threadId: "thread-existing", assistantText: "done" });
      },
      steerSessionTurn: async (input) => { sent.push(input); await inputEnd; return { turnId: input.expectedTurnId }; },
    };
    const service = createTestRuntime({
      getSession: () => stored, upsertSession: (next) => { stored = next; return next; },
      resolveComposerPreview: async () => ({ attachments: [], errors: [] }), getAppSettings: () => normalizeAppSettings({}),
      resolveProviderCatalog: () => ({ snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() }),
      getProviderCodingAdapter: () => adapter, getSessionMemory: (session) => createSessionMemory(session.id), resolveProjectMemoryEntriesForPrompt: () => [],
      createSessionTurn: createSessionTurnBase, updateSessionTurn() {}, setLiveSessionRun: (_id, next) => { live = next; }, getLiveSessionRun: () => live,
      waitForApprovalDecision: () => "deny", waitForElicitationResponse: () => ({ action: "cancel" }),
      setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, async invalidateProviderSessionThread() {}, scheduleProviderQuotaTelemetryRefresh() {}, broadcastLiveSessionRun() {}, resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {},
    });
    const turn = service.runSessionTurn(stored.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "start" });
    await waitForCondition(() => live?.inputAvailable === true, "active turn accepts input");
    await assert.rejects(service.steerSessionTurn(stored.id, { expectedTurnId: "different", userMessage: "wrong" }), /no longer accepts input/);
    const steer = service.steerSessionTurn(stored.id, { expectedTurnId: "turn-one", userMessage: "additional" });
    await waitForCondition(() => sent.length === 1, "input dispatched");
    await assert.rejects(service.steerSessionTurn(stored.id, { expectedTurnId: "turn-one", userMessage: "duplicate" }), /already being sent/);
    finishTurn();
    finishInput();
    assert.deepEqual(await steer, { turnId: "turn-one" });
    const completed = await turn;
    assert.deepEqual(completed.messages.map((message) => message.text), ["start", "additional", "done"]);
    assert.equal(sent[0]?.expectedTurnId, "turn-one");
    assert.equal(sent[0]?.userMessage, "additional");
    assert.equal(sent.length, 1);
    await assert.rejects(service.steerSessionTurn(stored.id, { expectedTurnId: "turn-one", userMessage: "late" }), /no longer accepts input/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "添付解決中に取消されたCodex steerはproviderへ送信せず会話本文へ追加しない"
  // oracle = { type = "contract", ref = "Issue #780 same-turn input cancellation fence" }
  // fault = "添付解決前だけturnを照合し、取消後に遅延inputをdispatchする"
  // observable = "steer公開APIのreject、adapter steer呼出回数、terminal message列"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService steer preparation cancellation"
  // lifecycle = "permanent"
  // impact = "取消後の入力が実行されるか送信未確定の本文を会話へ追加する"
  // distinction = "adapter単体testはruntimeの非同期添付解決を通らない"
  // @end-test-value
  it("Codex steerは添付解決後も取消を照合し未送信本文を追加しない", async () => {
    let stored = createSession({ threadId: "thread-existing" });
    let live: LiveSessionRunState | null = null;
    let finishTurn!: () => void;
    const turnEnd = new Promise<void>((resolve) => { finishTurn = resolve; });
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => { releasePreview = resolve; });
    let previewStarted = false;
    let inputCalls = 0;
    const adapter: ProviderCodingAdapter = {
      composePrompt: () => ({ systemBodyText: "system", inputBodyText: "input", logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" }, imagePaths: [], additionalDirectories: [] }),
      getProviderQuotaTelemetry: async () => null, invalidateSessionThread: async () => {}, invalidateAllSessionThreads: async () => {},
      runSessionTurn: async (input, progress) => {
        await emitTestProgress(progress, { ...createLiveRunState(), sessionId: input.session.id, threadId: "thread-existing", turnId: "turn-one", inputAvailable: true });
        await turnEnd;
        return createPartialResult({ threadId: "thread-existing", assistantText: "done" });
      },
      steerSessionTurn: async (input) => { inputCalls += 1; return { turnId: input.expectedTurnId }; },
    };
    const service = createTestRuntime({
      getSession: () => stored, upsertSession: (next) => { stored = next; return next; },
      resolveComposerPreview: async (_session, text) => { if (text === "race") { previewStarted = true; await previewGate; } return { attachments: [], errors: [] }; }, getAppSettings: () => normalizeAppSettings({}),
      resolveProviderCatalog: () => ({ snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() }),
      getProviderCodingAdapter: () => adapter, getSessionMemory: (session) => createSessionMemory(session.id), resolveProjectMemoryEntriesForPrompt: () => [],
      createSessionTurn: createSessionTurnBase, updateSessionTurn() {}, setLiveSessionRun: (_id, next) => { live = next; }, getLiveSessionRun: () => live,
      waitForApprovalDecision: () => "deny", waitForElicitationResponse: () => ({ action: "cancel" }),
      setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, async invalidateProviderSessionThread() {}, scheduleProviderQuotaTelemetryRefresh() {}, broadcastLiveSessionRun() {}, resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {},
    });
    const turn = service.runSessionTurn(stored.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "start" });
    await waitForCondition(() => live?.inputAvailable === true, "active turn");
    const steer = service.steerSessionTurn(stored.id, { expectedTurnId: "turn-one", userMessage: "race" });
    await waitForCondition(() => previewStarted, "steer preview held");
    service.cancelRun(stored.id);
    const rejected = assert.rejects(steer, /no longer accepts input/);
    finishTurn();
    const result = await turn;
    releasePreview();
    await rejected;
    assert.equal(inputCalls, 0);
    assert.equal(result.messages.some((message) => message.text === "race"), false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Codexのthread復帰失敗は同じ保存threadを保持して一度の失敗として返し、自動新規threadへ切り替えない"
  // oracle = { type = "contract", ref = "Issue #780 no silent session replacement" }
  // fault = "stale errorでthreadを消すか、新規threadを作るため再試行する"
  // observable = "provider呼出回数、thread reset回数、失敗Sessionのthreadと本文"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService Codex resume failure"
  // lifecycle = "permanent"
  // impact = "既存のprovider会話を黙って別の会話へ置換する"
  // distinction = "adapter単体testでは上位runtimeによるretryを検出しない"
  // @end-test-value
  it("Codex復帰失敗では保存threadを保持し自動retryしない", async () => {
    let stored = createSession({ threadId: "thread-existing" });
    let attempts = 0;
    let resets = 0;
    const adapter: ProviderCodingAdapter = {
      composePrompt: () => ({ systemBodyText: "system", inputBodyText: "input", logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" }, imagePaths: [], additionalDirectories: [] }),
      getProviderQuotaTelemetry: async () => null, invalidateSessionThread: async () => {}, invalidateAllSessionThreads: async () => {},
      runSessionTurn: async () => { attempts += 1; throw new ProviderTurnError("thread not found", createPartialResult(), false); },
    };
    const service = createTestRuntime({
      getSession: () => stored, upsertSession: (next) => { stored = next; return next; },
      resolveComposerPreview: async () => ({ attachments: [], errors: [] }), getAppSettings: () => normalizeAppSettings({}),
      resolveProviderCatalog: () => ({ snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() }),
      getProviderCodingAdapter: () => adapter, getSessionMemory: (session) => createSessionMemory(session.id), resolveProjectMemoryEntriesForPrompt: () => [],
      createSessionTurn: createSessionTurnBase, updateSessionTurn() {}, setLiveSessionRun() {}, getLiveSessionRun: () => null,
      waitForApprovalDecision: () => "deny", waitForElicitationResponse: () => ({ action: "cancel" }), resetProviderSessionThread: () => { resets += 1; },
      setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, async invalidateProviderSessionThread() {}, scheduleProviderQuotaTelemetryRefresh() {}, broadcastLiveSessionRun() {}, resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {},
    });
    const result = await service.runSessionTurn(stored.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "resume" });
    assert.equal(attempts, 1);
    assert.equal(resets, 0);
    assert.equal(result.threadId, "thread-existing");
    assert.equal(result.runState, "error");
    assert.match(result.messages.at(-1)?.text ?? "", /thread not found/);
  });
  // @test-value v2
  // kind = "contract"
  // claim = "Claude個別要求取消は共通pending表示とresolverを解放してから後続を表示し、古い回答を拒否する"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md; Issue #751 F751-1" }
  // fault = "SDKのみ取消してpendingを残す、queueを先に進めて上書きする、または旧requestIdへの回答を新要求へ適用する"
  // observable = "共通serviceのlive要求IDと解除通知列、古い回答の例外、SDK判断、turn完了"
  // observation_boundary = "public-boundary"
  // scope = "ClaudeAdapter through SessionRuntimeService and shared pending services"
  // lifecycle = "permanent"
  // impact = "回答待ちの後続承認・質問が停止する、または取消済み操作の回答が別操作へ誤適用される"
  // distinction = "adapter単独mockはMainのsignal接続と実pending cleanupを迂回するためこの軽量統合testで検査する"
  // @end-test-value
  it("Claude個別取消は共通pendingを解除し、後続要求とturn全体取消を区別する", async () => {
    let stored = createSession({ provider: "claude", workspacePath: process.cwd(), approvalMode: "on-request" });
    let live: LiveSessionRunState | null = null;
    const displayed: Array<string | null> = [];
    const update = (_id: string, recipe: (current: LiveSessionRunState) => LiveSessionRunState) => {
      live = recipe(live!);
      displayed.push(live.approvalRequest?.requestId ?? live.elicitationRequest?.requestId ?? null);
      return live;
    };
    const approvals = new SessionApprovalService({ updateLiveSessionRun: update });
    const questions = new SessionElicitationService({ updateLiveSessionRun: update });
    const context = (id: string, signal: AbortSignal) => ({ toolUseID: id, signal }) as Parameters<NonNullable<Options["canUseTool"]>>[2];
    let service!: SessionRuntimeService;
    let turnCancelObservation: Promise<{ behavior: string | null; approvalRequest: LiveApprovalRequest | null | undefined }> | undefined;
    const adapter = new ClaudeAdapter({ query: (({ options }: { options: Options }) => (async function* () {
      const canceled = new AbortController();
      const first = options.canUseTool!("Bash", { command: "first" }, context("first", canceled.signal));
      const queued = new AbortController();
      const skipped = options.canUseTool!("Bash", { command: "queued" }, context("queued", queued.signal));
      const second = options.canUseTool!("AskUserQuestion", { questions: [{ question: "Choose", options: [{ label: "yes" }] }] }, context("second", new AbortController().signal));
      await waitForCondition(() => live?.approvalRequest?.requestId === "first", "first approval displayed");
      queued.abort();
      canceled.abort();
      assert.deepEqual(await first, { behavior: "deny", message: "Canceled" });
      assert.deepEqual(await skipped, { behavior: "deny", message: "Canceled" });
      await waitForCondition(() => live?.elicitationRequest?.requestId === "second", "second question displayed after cleanup");
      assert.deepEqual(displayed.slice(0, 3), ["first", null, "second"]);
      assert.throws(() => approvals.resolveLiveApproval(stored.id, "first", "approve"), /no longer exists/);
      const questionCanceled = new AbortController();
      const third = options.onElicitation!({ mode: "form", serverName: "test", message: "Third", requestedSchema: { type: "object", properties: { answer: { type: "string" } } } } as Parameters<NonNullable<Options["onElicitation"]>>[0],
        { requestId: "third", signal: questionCanceled.signal } as Parameters<NonNullable<Options["onElicitation"]>>[1]);
      questions.resolveLiveElicitation(stored.id, "second", { action: "accept", content: { "0": "yes" } });
      const secondDecision = await second;
      assert.ok(secondDecision);
      assert.equal(secondDecision.behavior, "allow");
      await waitForCondition(() => live?.elicitationRequest?.requestId === "third", "third question displayed");
      const fourth = options.canUseTool!("Bash", { command: "fourth" }, context("fourth", new AbortController().signal));
      questionCanceled.abort();
      assert.deepEqual(await third, { action: "cancel" });
      await waitForCondition(() => live?.approvalRequest?.requestId === "fourth", "fourth approval displayed");
      assert.throws(() => questions.resolveLiveElicitation(stored.id, "third", { action: "accept" }), /no longer exists/);
      assert.deepEqual(displayed.slice(-3), ["third", null, "fourth"]);
      turnCancelObservation = fourth.then((decision) => ({
        behavior: decision?.behavior ?? null,
        approvalRequest: live?.approvalRequest,
      }));
      service.cancelRun(stored.id);
      await turnCancelObservation;
      yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "thread" } as SDKMessage;
    })()) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query });
    service = createTestRuntime({
      getSession: () => stored,
      upsertSession: (next) => { stored = next; return next; },
      resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
      getAppSettings: () => normalizeAppSettings({ codingProviderSettings: { claude: { enabled: true } } }),
      resolveProviderCatalog: () => ({ snapshot: { revision: 1, providers: [createProviderCatalog("claude")] }, provider: createProviderCatalog("claude") }),
      getProviderCodingAdapter: () => adapter,
      getSessionMemory: (session) => createSessionMemory(session.id),
      resolveProjectMemoryEntriesForPrompt: () => [],
      createSessionTurn: createSessionTurnBase,
      updateSessionTurn() {},
      setLiveSessionRun: (_id, next) => { live = next; },
      getLiveSessionRun: () => live,
      waitForApprovalDecision: (id, request, signal) => approvals.waitForLiveApprovalDecision(id, request, signal),
      waitForElicitationResponse: (id, request, signal) => questions.waitForLiveElicitationResponse(id, request, signal),
      setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {},
      async invalidateProviderSessionThread() {}, scheduleProviderQuotaTelemetryRefresh() {}, broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest: (id, decision) => { if (live?.approvalRequest) approvals.resolveLiveApproval(id, live.approvalRequest.requestId, decision); },
      resolvePendingElicitationRequest: (id, response) => { if (live?.elicitationRequest) questions.resolveLiveElicitation(id, live.elicitationRequest.requestId, response); },
    });
    const completed = await service.runSessionTurn(stored.id, { executionOptions: captureSessionExecutionOptions(stored), userMessage: "test" });
    assert.equal(completed.status, "idle");
    assert.equal(completed.runState, "idle", "request assertions must not become a failed provider outcome");
    assert.ok(turnCancelObservation, "turn-wide cancellation was reached");
    assert.deepEqual(await turnCancelObservation, { behavior: "deny", approvalRequest: null });
    assert.ok(!displayed.includes("queued"));
  });

  // @test-value v2
  // kind = "contract"
  // claim = "送信開始時に更新されたCharacter定義と当turnのAffectはClaudeの継続・明示resume appendへ反映する"
  // oracle = { type = "contract", ref = "docs/design/prompt-composition.md; Issue #775; Issue #751 T751-3" }
  // fault = "runtimeが更新前Sessionをadapterへ渡す、またはClaudeが前turnのsystem appendを使い続ける"
  // observable = "SDK queryのresume値・append内のturn固有定義とAffect、および保存snapshot identityとmetadata"
  // observation_boundary = "public-boundary"
  // scope = "Main runtime send-time refresh through Claude SDK query boundary"
  // lifecycle = "permanent"
  // impact = "Character編集とAffect更新が継続会話へ反映されず、ユーザーの設定に反する応答になる"
  // distinction = "canonical snapshot更新単体testとadapter単体testの間にあるruntime配線を、実composerとSDK query captureで確認する"
  // @end-test-value
  it("送信時Character更新とAffectをClaudeの次turn・明示resume appendへ接続する", async () => {
    let stored = createSession({ provider: "claude", workspacePath: process.cwd(), approvalMode: "on-request" });
    let current = "old";
    const seen: Options[] = [];
    const makeAdapter = () => new ClaudeAdapter({ query: (({ options }: { options: Options }) => {
      seen.push(options);
      return (async function* () { yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "fresh-thread",
        usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} } as SDKMessage; })();
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query });
    let adapter = makeAdapter();
    const service = createTestRuntime({
      getSession: () => stored,
      upsertSession: (next) => { stored = next; return next; },
      resolveRuntimeSessionForTurn: (session) => ({ ...session, characterRuntimeSnapshot: {
        characterId: "char-a", name: "Saved name", description: "Saved description", iconFilePath: "",
        theme: { main: "#112233", sub: "#445566" }, definitionMarkdown: `Definition ${current}`,
        definitionSha256: current, definitionByteSize: current.length, snapshotAt: "2026-10-03T00:00:00Z",
      } }),
      resolveCharacterContext: () => ({ schemaVersion: "withmate-character-context-v1",
        baseline: { definitionSha256: current, snapshotAt: "2026-10-03T00:00:00Z" },
        affect: { mode: "active", effective: [{ contributingLayers: ["session"], targetType: "user", targetId: "user", family: null,
          label: `Affect ${current}`, valence: 0.5, intensity: 0.5 }], evaluatedAt: "2026-10-03T00:00:00Z", version: current, updatedAt: null },
        memory: { items: [], updatedAt: null } }),
      resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
      getAppSettings: () => normalizeAppSettings({ codingProviderSettings: { claude: { enabled: true } } }),
      resolveProviderCatalog: () => ({ snapshot: { revision: 1, providers: [createProviderCatalog("claude")] }, provider: createProviderCatalog("claude") }),
      getProviderCodingAdapter: () => adapter,
      getSessionMemory: (session) => createSessionMemory(session.id), resolveProjectMemoryEntriesForPrompt: () => [],
      createSessionTurn: createSessionTurnBase, updateSessionTurn() {}, setLiveSessionRun() {}, getLiveSessionRun: () => null,
      waitForApprovalDecision: () => "deny", waitForElicitationResponse: () => ({ action: "cancel" }),
      setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, async invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {}, broadcastLiveSessionRun() {}, resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {},
    });
    for (const [index, marker] of ["old", "new", "resumed"].entries()) {
      current = marker;
      if (index === 2) adapter = makeAdapter();
      const completed = await service.runSessionTurn(stored.id, { executionOptions: captureSessionExecutionOptions(stored), userMessage: marker });
      assert.equal(completed.runState, "idle", JSON.stringify(completed.messages));
      assert.equal(seen[index].resume, index === 0 ? undefined : "fresh-thread");
      const system = seen[index].systemPrompt;
      assert.ok(system && typeof system === "object" && !Array.isArray(system) && system.type === "preset");
      assert.match(system.append!, new RegExp(`Definition ${marker}`));
      assert.match(system.append!, new RegExp(`Affect ${marker}`));
      for (const other of ["old", "new", "resumed"].filter((value) => value !== marker)) {
        assert.doesNotMatch(system.append!, new RegExp(`Definition ${other}|Affect ${other}`));
      }
      assert.equal(completed.characterRuntimeSnapshot?.characterId, "char-a");
      assert.equal(completed.characterRuntimeSnapshot?.name, "Saved name");
      assert.equal(completed.characterRuntimeSnapshot?.description, "Saved description");
    }
  });
  // @test-value v2
  // kind = "contract"
  // claim = "取消はsetup・provider・終端保存の終了待ちをliveへ投影し、実終了後だけ再送と連続履歴を許可する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-run-cancel" }
  // fault = "取消連打で状態通知を二重化する、未終了中にSendを許可する、終了通知が欠ける、または次turnへ旧応答を混入する"
  // observable = "live取消状態とbroadcast、Send結果、provider呼出件数、保存message列"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService cancellation lifecycle"
  // lifecycle = "permanent"
  // impact = "取消済み表示なのにSendを拒否する状態や、履歴欠損・同一会話の二重実行を防ぐ"
  // distinction = "既存deadline testのguard確認に加え、live解除通知・連打の冪等性・実Send再開をdeferred境界で確認する"
  // @end-test-value
  it("取消待ちを実終了まで投影し、単発・連打後の次Sendを安全に再開する", async () => {
    for (const phase of ["admission", "setup", "provider", "terminal"] as const) {
      for (const lateOutcome of ["resolve", "reject"] as const) {
        let stored = createSession();
        let live: LiveSessionRunState | null = null;
        const broadcasts: Array<LiveSessionRunState | null> = [];
        let releaseGate!: () => void;
        const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
        let announceGate!: () => void;
        const gateReady = new Promise<void>((resolve) => { announceGate = resolve; });
        let resolveProvider!: (result: RunSessionTurnResult) => void;
        let rejectProvider!: (error: Error) => void;
        let providerCalls = 0;
        let emitLateProgress: (() => void) | undefined;
        let announceNext!: () => void;
        const nextReady = new Promise<void>((resolve) => { announceNext = resolve; });
        let finishNext!: (result: RunSessionTurnResult) => void;
        const readLive = (): LiveSessionRunState | null => live;
        const adapter: ProviderCodingAdapter = {
          composePrompt: () => ({ systemBodyText: "system", inputBodyText: "input", logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" }, imagePaths: [], additionalDirectories: [] }),
          async getProviderQuotaTelemetry() { return null; },
          async invalidateSessionThread() {},
          async invalidateAllSessionThreads() {},
          runSessionTurn(input, onProgress) {
            providerCalls += 1;
            if (input.userMessage === "next request") {
              announceNext();
              return new Promise<RunSessionTurnResult>((resolve) => { finishNext = resolve; });
            }
            if (phase === "provider" && providerCalls === 1) {
              emitLateProgress = () => { void emitTestProgress(onProgress, createLiveRunState({ sessionId: stored.id, assistantText: "old late progress" })); };
              announceGate();
              return new Promise<RunSessionTurnResult>((resolve, reject) => { resolveProvider = resolve; rejectProvider = reject; });
            }
            return Promise.resolve(createPartialResult({ assistantText: "completed answer" }));
          },
        };
        let firstAdmission = true;
        let firstSetup = true;
        let firstTerminal = true;
        const service = createTestRuntime({
          providerCancelGraceMs: 5,
          async runSessionAdmissionExclusive(_id, operation) {
            if (phase === "admission" && firstAdmission) { firstAdmission = false; announceGate(); await gate; }
            return operation();
          },
          getSession: () => stored,
          upsertSession: (next) => { stored = next; return next; },
          async upsertTerminalSession(next) {
            if (phase === "terminal" && firstTerminal) { firstTerminal = false; announceGate(); await gate; }
            stored = next;
            return next;
          },
          async resolveComposerPreview() {
            if (phase === "setup" && firstSetup) { firstSetup = false; announceGate(); await gate; }
            return { attachments: [], errors: [] };
          },
          getAppSettings: () => normalizeAppSettings({}),
          resolveProviderCatalog: () => ({ snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() }),
          getProviderCodingAdapter: () => adapter,
          getSessionMemory: (session) => createSessionMemory(session.id),
          resolveProjectMemoryEntriesForPrompt: () => [],
          createSessionTurn: createSessionTurnBase,
          updateSessionTurn() {},
          setLiveSessionRun: (_id, next) => { live = next; },
          getLiveSessionRun: () => live,
          async waitForApprovalDecision() { return "approve" as const; },
          async waitForElicitationResponse() { return { action: "cancel" } as const; },
          setProviderQuotaTelemetry() {},
          setSessionContextTelemetry() {},
          async invalidateProviderSessionThread() {},
          scheduleProviderQuotaTelemetryRefresh() {},
          broadcastLiveSessionRun() { broadcasts.push(live); },
          resolvePendingApprovalRequest() {},
          resolvePendingElicitationRequest() {},
        });
        const firstRun = service.runSessionTurn(stored.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "first request" });
        const firstOutcome = firstRun.then((session) => session, () => null);
        await gateReady;
        service.cancelRun(stored.id);
        assert.equal(broadcasts.at(-1)?.cancellationState, "requested", phase);
        const cancelBroadcastCount = broadcasts.length;
        if (lateOutcome === "reject") {
          service.cancelRun(stored.id);
          service.cancelRun(stored.id);
          assert.equal(broadcasts.length, cancelBroadcastCount, "repeated cancel is idempotent");
        }
        if (phase !== "terminal") {
          await firstOutcome;
          assert.equal(broadcasts.at(-1)?.cancellationState, "terminating", phase);
        } else {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          assert.equal(broadcasts.at(-1)?.cancellationState, "requested", "terminal persistence retains cancellation after grace");
        }
        assert.equal(service.isRunInFlight(stored.id), true);
        await assert.rejects(service.runSessionTurn(stored.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "too early" }), /already running/);
        if (phase === "provider") {
          if (lateOutcome === "resolve") { resolveProvider(createPartialResult({ assistantText: "old late answer" })); }
          else { rejectProvider(new Error("old late rejection")); }
        } else { releaseGate(); }
        await firstOutcome;
        await waitForCondition(() => !service.isRunInFlight(stored.id), "original run must finish");
        assert.equal(broadcasts.at(-1)?.cancellationState, undefined);
        const historyBeforeNext = [...stored.messages];
        const secondRun = service.runSessionTurn(stored.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "next request" });
        await nextReady;
        emitLateProgress?.();
        assert.equal(readLive()?.assistantText.includes("old late"), false);
        assert.equal(readLive()?.cancellationState, undefined);
        finishNext(createPartialResult({ assistantText: "completed answer" }));
        const second = await secondRun;
        assert.deepEqual(stored.messages.slice(0, historyBeforeNext.length), historyBeforeNext);
        assert.equal(second.messageCount, stored.messages.length);
        assert.equal(second.messages.at(-2)?.text, "next request");
        assert.equal(second.messages.at(-1)?.text, "completed answer");
        assert.equal(second.messages.some((message) => /old late/.test(message.text)), false);
        assert.equal(broadcasts.at(-1)?.assistantText.includes("old late"), undefined);
        assert.equal(providerCalls, phase === "setup" || phase === "admission" ? 1 : 2);
      }
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "保存済みSessionのProviderが未対応なら、Codexでも有効なmodelでも実行開始・保存・binding発行前に拒否する"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md#current-runtime" }
  // fault = "保存ProviderをcatalogまたはAdapterでCodexへ置き換えてturnを開始する"
  // observable = "runSessionTurnのreject、adapter呼出し回数、保存とbinding発行回数"
  // observation_boundary = "public-boundary"
  // scope = "session-runtime-provider-identity"
  // lifecycle = "permanent"
  // impact = "誤った契約へのprompt送信・課金・Session履歴変更を防止する"
  // distinction = "resolverとlaunchの単体testだけでは保存済みSessionからの本番Facade経由の実行を保証できない"
  // @end-test-value
  it("未対応Providerの保存Sessionは実Adapterを呼ばずturn開始前に拒否する", async () => {
    const session = createSession({ provider: "custom", model: "gpt-5.4" });
    let adapterCalls = 0;
    let writes = 0;
    let bindingIssues = 0;
    const unexpectedAdapterCall = (): never => { adapterCalls += 1; throw new Error("Unexpected adapter call"); };
    const adapter: ProviderTurnAdapter = {
      composePrompt: unexpectedAdapterCall,
      getProviderQuotaTelemetry: unexpectedAdapterCall,
      invalidateSessionThread: unexpectedAdapterCall,
      invalidateAllSessionThreads: unexpectedAdapterCall,
      runSessionTurn: unexpectedAdapterCall,
      getBackgroundStructuredPromptPolicy: unexpectedAdapterCall,
      extractSessionMemoryDelta: unexpectedAdapterCall,
      runBackgroundStructuredPrompt: unexpectedAdapterCall,
    };
    const catalog = { revision: 1, providers: [createProviderCatalog(), createProviderCatalog("custom")] };
    const facade = new MainProviderFacade({
      codexAdapter: adapter,
      copilotAdapter: adapter,
      claudeAdapter: adapter,
      getModelCatalog: () => catalog,
      ensureModelCatalogSeeded: () => catalog,
    });
    const unexpectedWrite = (): never => { writes += 1; throw new Error("Unexpected write"); };
    const service = createTestRuntime({
      getSession: () => session,
      upsertSession: unexpectedWrite,
      resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
      getAppSettings: () => normalizeAppSettings({ codingProviderSettings: { custom: { enabled: true } } }),
      resolveProviderCatalog: (id, revision) => facade.resolveProviderCatalog(id, revision),
      getProviderCodingAdapter: (id) => facade.getProviderCodingAdapter(id),
      getProviderAgentRuntimeBinding: () => { bindingIssues += 1; return null; },
      getSessionMemory: () => createSessionMemory(session.id),
      resolveProjectMemoryEntriesForPrompt: () => [],
      createSessionTurn: unexpectedWrite,
      updateSessionTurn: unexpectedWrite,
      getLiveSessionRun: () => null,
      setLiveSessionRun: () => {},
      waitForApprovalDecision: () => "deny",
      waitForElicitationResponse: () => ({ action: "cancel" }),
      setProviderQuotaTelemetry: () => {},
      setSessionContextTelemetry: () => {},
      invalidateProviderSessionThread: (id, sessionId) => facade.invalidateProviderSessionThread(id, sessionId),
      scheduleProviderQuotaTelemetryRefresh: () => {},
      broadcastLiveSessionRun: () => {},
      resolvePendingApprovalRequest: () => {},
      resolvePendingElicitationRequest: () => {},
    });
    await assert.rejects(service.runSessionTurn(session.id, {
      userMessage: "Test provider identity",
      executionOptions: TEST_EXECUTION_OPTIONS,
    }), /Unsupported provider: custom/);
    assert.equal(adapterCalls, 0);
    assert.equal(writes, 0);
    assert.equal(bindingIssues, 0);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "各turnで最新Character contextをprovider promptへ渡し、completed Sessionのterminal commit後に通知を依頼してbackground settlementを待たず次turnを受け付ける"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: runSessionTurnInternal / notifySessionTurnTerminalBestEffort / completeCompletedTurnAppraisalBestEffort; docs/design/session-run-lifecycle.md: Character Affect の完了後評価" }
  // fault = "永続化前の通知またはbackground settlement待機により、通知先が未保存状態を読むか次turn受付が停止する"
  // observable = "providerへ渡されたturnごとのCharacter context、terminal commit後の通知とready correlation順序、appraisal依頼回数、次turnの完了結果"
  // observation_boundary = "public-boundary"
  // scope = "session-runtime-terminal-completion-order"
  // lifecycle = "permanent"
  // @end-test-value
  it("各turnで最新Character contextを取得し、terminal commit後はready・appraisalを待たずに返す", async () => {
    let storedSession = createSession();
    let contextVersion = 0;
    let turnId = 0;
    let completionNotificationCount = 0;
    let appraisalRequestCount = 0;
    const callOrder: string[] = [];
    const timingCompletionSnapshots: Array<string | null> = [];
    let lastCommittedAt: string | null = null;
    const composedCharacterContextVersions: string[] = [];
    const confirmedPreviewTexts: Array<string | null | undefined> = [];
    let terminalUpsertCount = 0;
    let terminalUpsertStarted = false;
    let releaseFirstTerminalUpsert!: () => void;
    const firstTerminalUpsertReleased = new Promise<void>((resolve) => {
      releaseFirstTerminalUpsert = resolve;
    });
    const adapter: ProviderCodingAdapter = {
      composePrompt(input) {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      async runSessionTurn(input) {
        if (input.characterContext) composedCharacterContextVersions.push(input.characterContext.affect.version);
        return {
          ...createPartialResult({ assistantText: "完了" }),
          lastNonEmptyAssistantMessageText: "完了",
        };
      },
    };
    const context = (version: number): CharacterContextResponse => ({
      schemaVersion: "withmate-character-context-v1",
      baseline: { definitionSha256: "sha", snapshotAt: "2026-08-09T00:00:00.000Z" },
      affect: {
        mode: "active",
        effective: [],
        evaluatedAt: "2026-08-09T00:00:00.000Z",
        version: `affect-v1-${version}`,
        updatedAt: "2026-08-09T00:00:00.000Z",
      },
      memory: { items: [], updatedAt: null },
    });

    const service = createTestRuntime({
      getSession(sessionId) {
        return sessionId === storedSession.id ? storedSession : null;
      },
      upsertSession(next) {
        storedSession = next;
        return next;
      },
      upsertTerminalSession(next, terminalCommit, options) {
        if (next.status === "idle" && next.messages.at(-1)?.role === "assistant") {
          terminalUpsertCount += 1;
          terminalUpsertStarted = true;
          callOrder.push(`completed-upsert:${terminalCommit.turnId}`);
          assert.equal(terminalCommit.assistantMessageSeq, next.messages.length - 1);
          confirmedPreviewTexts.push(options?.confirmedFinalAssistantText);
        }
        if (terminalUpsertCount === 1) {
          return firstTerminalUpsertReleased.then(() => {
            lastCommittedAt = terminalCommit.completedAt;
            storedSession = next;
            return next;
          });
        }
        lastCommittedAt = terminalCommit.completedAt;
        storedSession = next;
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        const provider = createProviderCatalog();
        return { snapshot: { revision: 1, providers: [provider] }, provider };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(session) {
        return createSessionMemory(session.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      resolveConversationTimingContext() {
        timingCompletionSnapshots.push(lastCommittedAt);
        return null;
      },
      resolveCharacterContext() {
        contextVersion += 1;
        return context(contextVersion);
      },
      async queueCompletedTurnAppraisal(input) {
        assert.equal(input.assistantMessageIndex, input.session.messageCount! - 1);
        callOrder.push(`queued:${input.correlationId}`);
      },
      markCompletedTurnAppraisalReady(correlationId) {
        callOrder.push(`pending-ready:${correlationId}`);
      },
      requireDurableCompletedTurnAppraisal: true,
      async appraiseCompletedTurn() {
        appraisalRequestCount++;
        callOrder.push("appraisal-started");
        await new Promise<void>(() => undefined);
      },
      createSessionTurn(input) {
        turnId += 1;
        return { ...createSessionTurnBase(input), id: turnId };
      },
      updateSessionTurn() {},
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      waitForApprovalDecision() {
        return "approve" as const;
      },
      waitForElicitationResponse() {
        return { action: "cancel" };
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      async invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      notifySessionTurnTerminal() {
        completionNotificationCount += 1;
        callOrder.push(`completion-notification:${completionNotificationCount}`);
      },
      currentTimestampLabel,
    });

    const firstRun = service.runSessionTurn(storedSession.id, { executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "first",
      clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94b1",
      submitSource: "composer",
    });
    await waitForCondition(() => terminalUpsertStarted, "terminal upsertが通知前に開始されること");
    assert.equal(completionNotificationCount, 0);
    releaseFirstTerminalUpsert();
    await firstRun;
    callOrder.push("first-returned");
    const firstCompletedAt = lastCommittedAt;
    assert.equal(service.isRunInFlight(storedSession.id), false);
    assert.equal(confirmedPreviewTexts[0], "完了");
    assert.equal(callOrder.some((entry) => entry === `pending-ready:turn:${storedSession.id}:turn:1`), false);
    await service.runSessionTurn(storedSession.id, { executionOptions: TEST_EXECUTION_OPTIONS,
      userMessage: "second",
      clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94b2",
      submitSource: "retry",
    });
    callOrder.push("second-returned");

    await waitForCondition(
      () => appraisalRequestCount === 2,
      "ready・appraisal・terminal turnがbackgroundで完了すること",
    );

    assert.equal(contextVersion, 2);
    assert.deepEqual(composedCharacterContextVersions, ["affect-v1-1", "affect-v1-2"]);
    assert.equal(appraisalRequestCount, 2);
    assert.deepEqual(callOrder.filter((entry) => entry.startsWith("pending-ready:")), [
      `pending-ready:turn:${storedSession.id}:turn:1`,
      `pending-ready:turn:${storedSession.id}:turn:2`,
    ]);
    assert.equal(timingCompletionSnapshots[0], null);
    assert.equal(timingCompletionSnapshots[1], firstCompletedAt);
    for (const [turnId, returned] of [
      [1, "first-returned"],
      [2, "second-returned"],
    ] as const) {
      const correlationId = `turn:${storedSession.id}:turn:${turnId}`;
      assert.ok(callOrder.indexOf(`completed-upsert:${turnId}`) < callOrder.indexOf(`completion-notification:${turnId}`));
      assert.ok(callOrder.indexOf(`completion-notification:${turnId}`) < callOrder.indexOf(returned));
      assert.ok(callOrder.indexOf(returned) < callOrder.indexOf(`pending-ready:${correlationId}`));
    }
    assert.equal(callOrder.filter((entry) => entry === "appraisal-started").length, 2);

  });

  // @test-value v2
  // kind = "invariant"
  // claim = "SessionRuntimeServiceへ注入したdurable appraisal queueがcompletedより先にpendingを永続化し、enqueue失敗・ready再試行・欠落pendingを適切に収束させる"
  // oracle = { type = "contract", ref = "Session runtime persistence ordering contract" }
  // fault = "completed sessionを先に保存してpendingを失う、enqueue失敗時もcompletedを保存する、またはready再試行・欠落pendingを誤ってappraisalする"
  // observable = "pending enqueueとcompleted保存の順序、enqueue/readiness/appraisal結果、最終Session runState"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService pending persistence and failure handling"
  // lifecycle = "permanent"
  // @end-test-value
  it("注入したdurable appraisal queueはpendingをcompleted Sessionより先に永続化し、保存失敗時はcompletedにしない", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-mandatory-appraisal-"));
    const storage = new CharacterAffectTurnSettlementStorage(path.join(directory, "app.sqlite"));
    const createService = (
      initialSession: Session,
      queueCompletedTurnAppraisal: NonNullable<SessionRuntimeServiceDeps["queueCompletedTurnAppraisal"]>,
      beforeCompletedUpsert?: () => void | Promise<void>,
      markCompletedTurnAppraisalReady?: NonNullable<SessionRuntimeServiceDeps["markCompletedTurnAppraisalReady"]>,
      appraiseCompletedTurn?: NonNullable<SessionRuntimeServiceDeps["appraiseCompletedTurn"]>,
    ) => {
      let storedSession = initialSession;
      const completedWrites: Session[] = [];
      const callOrder: string[] = [];
      const adapter: ProviderCodingAdapter = {
        composePrompt() {
          return {
            systemBodyText: "system",
            inputBodyText: "input",
            logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
            imagePaths: [],
            additionalDirectories: [],
          };
        },
        async getProviderQuotaTelemetry() {
          return null;
        },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
        async runSessionTurn() {
          return createPartialResult({ assistantText: "完了" });
        },
      };
      const service = createTestRuntime({
        getSession(sessionId) {
          return sessionId === storedSession.id ? storedSession : null;
        },
        async upsertSession(next) {
          if (next.runState === "idle" && next.messages.at(-1)?.role === "assistant") {
            await beforeCompletedUpsert?.();
            completedWrites.push(next);
            callOrder.push("completed-upsert");
          }
          storedSession = next;
          return next;
        },
        async resolveComposerPreview() {
          return { attachments: [], errors: [] };
        },
        getAppSettings() {
          return normalizeAppSettings({});
        },
        resolveProviderCatalog() {
          const provider = createProviderCatalog();
          return { snapshot: { revision: 1, providers: [provider] }, provider };
        },
        getProviderCodingAdapter() {
          return adapter;
        },
        getSessionMemory(session) {
          return createSessionMemory(session.id);
        },
        resolveProjectMemoryEntriesForPrompt() {
          return [];
        },
        queueCompletedTurnAppraisal(input) {
          callOrder.push("pending-enqueue");
          return queueCompletedTurnAppraisal(input);
        },
        markCompletedTurnAppraisalReady(correlationId) {
          callOrder.push("pending-ready");
          if (markCompletedTurnAppraisalReady) {
            return markCompletedTurnAppraisalReady(correlationId);
          }
          storage.markReady(correlationId);
        },
        appraiseCompletedTurn,
        requireDurableCompletedTurnAppraisal: true,
        createSessionTurn(input) {
          return createSessionTurnBase(input);
        },
        updateSessionTurn() {},
        setLiveSessionRun() {},
        getLiveSessionRun() {
          return null;
        },
        waitForApprovalDecision() {
        return "approve" as const;
        },
        waitForElicitationResponse() {
          return { action: "cancel" };
        },
        setProviderQuotaTelemetry() {},
        setSessionContextTelemetry() {},
      async invalidateProviderSessionThread() {},
        scheduleProviderQuotaTelemetryRefresh() {},
        broadcastLiveSessionRun() {},
        resolvePendingApprovalRequest() {},
        resolvePendingElicitationRequest() {},
        currentTimestampLabel,
        appraisalReadyRetryMs: 0,
      });
      return { service, completedWrites, callOrder };
    };

    try {
      const successfulSession = createSession();
      const successful = createService(
        successfulSession,
        (input) => {
          storage.enqueue({
            correlationId: input.correlationId,
            characterId: input.session.characterId,
            sessionId: input.session.id,
            userMessage: input.userMessage,
            assistantMessage: input.assistantMessage,
            assistantMessageIndex: input.assistantMessageIndex,
            occurredAt: input.occurredAt,
          });
        },
        () => {
          assert.equal(storage.listPending().length, 1);
          assert.deepEqual(storage.listReadyPending(), []);
        },
      );
      const successfulResult = await successful.service.runSessionTurn(successfulSession.id, { executionOptions: TEST_EXECUTION_OPTIONS,
        userMessage: "保存して",
      });
      await waitForCondition(
        () => storage.listReadyPending().length === 1,
        "terminal commit後にbackgroundでpendingがready化されること",
      );
      const pending = storage.listPending();

      assert.equal(successfulResult.runState, "idle");
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.assistantMessage, "完了");
      assert.notEqual(pending[0]?.readyAt, null);
      assert.deepEqual(successful.callOrder, ["pending-enqueue", "completed-upsert", "pending-ready"]);

      const failingSession = createSession();
      const failing = createService(failingSession, () => {
        throw new Error("settlement storage unavailable");
      });
      const failingResult = await failing.service.runSessionTurn(failingSession.id, { executionOptions: TEST_EXECUTION_OPTIONS,
        userMessage: "保存に失敗して",
      });

      assert.equal(failingResult.runState, "error");
      assert.equal(failing.completedWrites.length, 0);
      assert.deepEqual(failing.callOrder, ["pending-enqueue"]);

      const readinessFailureSession = createSession();
      let appraisalCalls = 0;
      let readinessAttempts = 0;
      let releaseReadiness: () => void = () => undefined;
      const readinessBarrier = new Promise<void>((resolve) => {
        releaseReadiness = resolve;
      });
      const readinessFailure = createService(
        readinessFailureSession,
        (input) => {
          storage.enqueue({
            correlationId: input.correlationId,
            characterId: input.session.characterId,
            sessionId: input.session.id,
            userMessage: input.userMessage,
            assistantMessage: input.assistantMessage,
            assistantMessageIndex: input.assistantMessageIndex,
            occurredAt: input.occurredAt,
          });
        },
        undefined,
        async (correlationId) => {
          readinessAttempts += 1;
          if (readinessAttempts === 1) {
            throw new Error("temporary readiness failure");
          }
          await readinessBarrier;
          storage.markReady(correlationId);
        },
        () => {
          appraisalCalls += 1;
        },
      );
      let readinessRunResolved = false;
      const readinessFailureRun = readinessFailure.service.runSessionTurn(readinessFailureSession.id, { executionOptions: TEST_EXECUTION_OPTIONS,
        userMessage: "ready化に失敗しても完了を維持して",
      });
      void readinessFailureRun.then(() => {
        readinessRunResolved = true;
      });

      await waitForCondition(() => readinessAttempts >= 2, "background ready retryが2回目へ進むこと");

      assert.equal(readinessRunResolved, true);
      assert.equal(appraisalCalls, 0);
      assert.equal(storage.getPending(`turn:${readinessFailureSession.id}:turn:1`)?.readyAt, null);

      releaseReadiness();
      const readinessFailureResult = await readinessFailureRun;
      await waitForCondition(() => appraisalCalls === 1, "ready成功後にappraisal schedulerが起動すること");

      assert.equal(readinessFailureResult.runState, "idle");
      assert.equal(readinessFailure.completedWrites.length, 1);
      assert.equal(readinessAttempts, 2);
      assert.equal(appraisalCalls, 1);
      assert.equal(readinessFailureResult.messages.filter((message) => message.role === "assistant").length, 1);

      const absentSession = createSession();
      let absentReadyCalls = 0;
      let absentAppraisalCalls = 0;
      const absent = createService(
        absentSession,
        (input) => {
          storage.enqueue({
            correlationId: input.correlationId,
            characterId: input.session.characterId,
            sessionId: input.session.id,
            userMessage: input.userMessage,
            assistantMessage: input.assistantMessage,
            assistantMessageIndex: input.assistantMessageIndex,
            occurredAt: input.occurredAt,
          });
        },
        undefined,
        () => {
          absentReadyCalls += 1;
          return "absent";
        },
        () => {
          absentAppraisalCalls += 1;
        },
      );
      const absentResult = await absent.service.runSessionTurn(absentSession.id, { executionOptions: TEST_EXECUTION_OPTIONS,
        userMessage: "削除済みpendingは終端して",
      });
      await waitForCondition(() => absentReadyCalls === 1, "missing pendingのready化が一度だけ試行されること");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      assert.equal(absentResult.runState, "idle");
      assert.equal(absentReadyCalls, 1);
      assert.equal(absentAppraisalCalls, 0);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "character-authoring turnの通知対象はturn開始時の最新Character snapshotを含む保存済みSession結果である"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "staleなSession snapshotを通知へ渡して誤ったCharacter iconまたはSession情報を表示する"
  // scope = "session-runtime-terminal-notification-snapshot"
  // observable = "terminal通知へ渡されたSessionのcharacterRuntimeSnapshot"
  // observation_boundary = "public-boundary"
  // lifecycle = "permanent"
  // @end-test-value
  it("character-authoring session は turn 開始時の最新 Character snapshot を使う", async () => {
    const staleSession = createSession({
      sessionKind: "character-authoring",
      characterRuntimeSnapshot: {
        characterId: "char-a",
        name: "Old",
        description: "",
        iconFilePath: "",
        theme: { main: "#111111", sub: "#222222" },
        definitionMarkdown: "# Old",
        definitionSha256: "old",
        definitionByteSize: 5,
        snapshotAt: "old",
      },
    });
    const freshSession = {
      ...staleSession,
      character: "Fresh",
      characterRuntimeSnapshot: {
        characterId: "char-a",
        name: "Fresh",
        description: "",
        iconFilePath: "",
        theme: { main: "#333333", sub: "#444444" },
        definitionMarkdown: "# Fresh",
        definitionSha256: "fresh",
        definitionByteSize: 7,
        snapshotAt: "fresh",
      },
    };
    let runSessionName = "";
    let runSessionFolderPath = "";
    const notifiedSessions: Session[] = [];
    let notifiedLastNonEmptyAssistantMessageText = "";

    const adapter: ProviderCodingAdapter = {
      composePrompt(input) {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      runSessionTurn(input) {
        runSessionName = input.session.characterRuntimeSnapshot?.name ?? "";
        runSessionFolderPath = input.sessionFolderPath ?? "";
        return Promise.resolve(createPartialResult({
          threadId: "thread-1",
          assistantText: "途中の案内\n\n完了したよ。",
          lastNonEmptyAssistantMessageText: "完了したよ。",
        }));
      },
    };

    const service = createTestRuntime({
      getSession(sessionId) {
        return sessionId === staleSession.id ? staleSession : null;
      },
      upsertSession(next) {
        return next;
      },
      resolveRuntimeSessionForTurn(session) {
        assert.equal(session.characterRuntimeSnapshot?.name, "Old");
        return freshSession;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      resolveSessionFolderPath(sessionId) {
        return `F:/user-data/session-files/${sessionId}`;
      },
      getSessionMemory() {
        return createSessionMemory(staleSession.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn() {},
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      async invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      notifySessionTurnTerminal(notification) {
        assert.equal(notification.outcome, "completed");
        notifiedSessions.push(notification.session);
        notifiedLastNonEmptyAssistantMessageText = notification.outcome === "completed"
          ? notification.lastNonEmptyAssistantMessageText
          : "";
      },
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(staleSession.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });

    assert.equal(runSessionName, "Fresh");
    assert.equal(runSessionFolderPath, `F:/user-data/session-files/${freshSession.id}`);
    assert.equal(result.characterRuntimeSnapshot?.name, "Fresh");
    const notifiedSession = notifiedSessions.at(-1);
    assert.ok(notifiedSession);
    assert.equal(notifiedSession, result);
    assert.equal(notifiedSession?.id, freshSession.id);
    assert.equal(notifiedSession?.characterRuntimeSnapshot?.definitionSha256, "fresh");
    assert.equal(notifiedLastNonEmptyAssistantMessageText, "完了したよ。");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "resolveSessionCharacter未提供でもprovider turnを実行できる"
  // oracle = { type = "contract", ref = "Session runtime optional character resolver contract" }
  // fault = "任意依存の未提供を理由にprovider turnを中断する"
  // observable = "provider turn resultと保存されたSession state"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService provider turn setup"
  // lifecycle = "permanent"
  // @end-test-value
  it("resolveSessionCharacter 未提供でも provider turn まで進む", async () => {
    const session = createSession();
    let runCalled = false;
    let hasCharacterKey = false;

    const adapter: ProviderCodingAdapter = {
      composePrompt(input) {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      runSessionTurn(input) {
        runCalled = true;
        hasCharacterKey = Object.prototype.hasOwnProperty.call(input, "character");
        return Promise.resolve(createPartialResult({
          threadId: "thread-1",
          assistantText: "完了したよ。",
        }));
      },
    };

    const service = createTestRuntime({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      upsertSession(next) {
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn() {},
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      async invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願い" });

    assert.equal(runCalled, true);
    assert.equal(hasCharacterKey, false);
    assert.equal(result.runState, "idle");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "turn setup失敗時もlive stateを掃除する"
  // oracle = { type = "contract", ref = "Session runtime cleanup contract" }
  // fault = "setup例外後にin-flight/live stateを残し、再送やUI表示を阻害する"
  // observable = "live state、in-flight判定、cleanup呼び出し"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService setup failure cleanup"
  // lifecycle = "permanent"
  // @end-test-value
  it("setup 失敗でも live state を掃除する", async () => {
    const session = createSession();
    const calls: string[] = [];
    const liveStates: Array<LiveSessionRunState | null> = [];
    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        calls.push("compose");
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      runSessionTurn() {
        throw new Error("provider should not run");
      },
    };

    const service = createTestRuntime({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      upsertSession(next) {
        calls.push(`upsert:${next.runState}`);
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      createSessionTurn() {
        calls.push("createSessionTurn");
        throw new Error("turn failed");
      },
      updateSessionTurn() {},
      setLiveSessionRun(_sessionId, state) {
        liveStates.push(state);
      },
      getLiveSessionRun() {
        return liveStates.at(-1) ?? null;
      },
      async waitForApprovalDecision(): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      async invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {
        calls.push("broadcast");
      },
      resolvePendingApprovalRequest() {
        calls.push("approval:deny");
      },
      resolvePendingElicitationRequest() {
        calls.push("elicitation:cancel");
      },
      currentTimestampLabel,
    });

    await assert.rejects(
      service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願い" }),
      /turn failed/,
    );

    assert.deepEqual(calls, [
      "upsert:running",
      "createSessionTurn",
      "approval:deny",
      "elicitation:cancel",
      "upsert:error",
      "broadcast",
    ]);
    assert.equal(liveStates.at(-1), null);
    assert.equal(service.isRunInFlight(session.id), false);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "成功turnはrunningからidleを保存し、最小turnのcompletedと本文位置を記録してlive stateを解放する"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: runSessionTurnInternal; docs/design/provider-adapter.md: Session Flow 9-10 / 通常履歴と最小turn" }
  // fault = "runningからidleへの2回のSession保存を失う、completed turnのphase/本文位置を誤る、またはReasoning/taskがない成功turnのlive stateとin-flightを残す"
  // observable = "保存runState、completed turnのphaseとassistantMessageSeq、live stateの解放"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService successful turn completion"
  // lifecycle = "permanent"
  // @end-test-value
  it("成功時に running -> idle を保存し、完了後に live state を解放する", async () => {
    const session = createSession();
    const storedSessions: Session[] = [];
    const turnUpdates: UpdateSessionTurnInput[] = [];
    const liveStates: Array<LiveSessionRunState | null> = [];
    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      async runSessionTurn(input, onProgress) {
        await emitTestProgress(onProgress, createLiveRunState({
          sessionId: input.session.id,
        }));
        await emitTestProgress(onProgress, createLiveRunState({
          sessionId: input.session.id,
          threadId: "thread-progress",
          assistantText: "途中経過だよ。",
          steps: [
            {
              id: "step-1",
              type: "command_execution",
              summary: "npm test",
              details: "実行中",
              status: "in_progress",
            },
          ],
          usage: { inputTokens: 4, cachedInputTokens: 0, outputTokens: 1 },
        }));
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        return {
          threadId: "thread-1",
          assistantText: "完了したよ。",


          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 220 },
          providerQuotaTelemetry: {
            provider: "copilot",
            updatedAt: "2026-03-29T04:10:00.000Z",
            snapshots: [
              {
                quotaKey: "premium_interactions",
                entitlementRequests: 500,
                usedRequests: 120,
                remainingPercentage: 76.4,
                overage: 0,
                overageAllowedWithExhaustedQuota: false,
                resetDate: "2026-04-01T00:00:00.000Z",
              },
            ],
          },
        };
      },
    };

    const service = createTestRuntime({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      upsertSession(next) {
        storedSessions.push(next);
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt(): ProjectMemoryEntry[] {
        return [];
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn(_id, entry) {
        turnUpdates.push(entry);
      },
      setLiveSessionRun(_sessionId, state) {
        liveStates.push(state);
      },
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry(_telemetry: ProviderQuotaTelemetry) {},
      setSessionContextTelemetry(_telemetry: SessionContextTelemetry) {},
      async invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });
    await waitForCondition(() => turnUpdates.length === 1, "completed最小turnが保存されること");

    assert.equal(result.runState, "idle");
    assert.equal(storedSessions.length, 2);
    assert.equal(storedSessions[0]?.runState, "running");
    assert.equal(storedSessions[1]?.runState, "idle");
    assert.equal(storedSessions[1]?.messages.at(-1)?.text, "完了したよ。");
    assert.equal(turnUpdates.length, 1);
    assert.equal(turnUpdates.at(-1)?.phase, "completed");
    assert.equal(turnUpdates.at(-1)?.assistantMessageSeq, 1);
    assert.equal(liveStates.at(-1), null);
    assert.equal(service.isRunInFlight(session.id), false);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "成功時のfinally処理でも保存済みcompleted SessionのthreadIdをlive projectionへ反映し、backgroundTasksを失わない"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: pickPreferredThreadId / runSessionTurnInternal finally; docs/design/provider-adapter.md: Streaming Policy" }
  // fault = "background task保持処理がliveまたは旧threadIdでcompleted sessionを上書きする"
  // observable = "保存SessionのthreadIdとfinally後のlive projectionに保持されたthreadId/backgroundTasks"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService completed thread persistence"
  // lifecycle = "permanent"
  // @end-test-value
  it("成功時に backgroundTasks を保持する finally でも completed session の threadId を使う", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-old" });
    const storedSessions: Session[] = [];
    const backgroundTasks = [
      {
        id: "bg-1",
        kind: "shell" as const,
        status: "running" as const,
        title: "npm run watch",
        details: "watch mode",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    ];
    const liveStates: Array<LiveSessionRunState | null> = [];
    let liveState: LiveSessionRunState | null = createLiveRunState({
      sessionId: session.id,
      threadId: session.threadId,
      backgroundTasks,
    });

    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      async runSessionTurn() {
        return createPartialResult({
          threadId: "thread-new",
          assistantText: "完了したよ。",
        });
      },
    };

    const service = createTestRuntime({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      upsertSession(next) {
        storedSessions.push(next);
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt(): ProjectMemoryEntry[] {
        return [];
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn() {},
      setLiveSessionRun(_sessionId, next) {
        liveState = next;
        liveStates.push(next);
      },
      getLiveSessionRun() {
        return liveState;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      async invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });

    assert.equal(result.threadId, "thread-new");
    assert.equal(storedSessions[1]?.threadId, "thread-new");
    assert.equal(liveStates.at(-1)?.threadId, "thread-new");
    assert.deepEqual(liveStates.at(-1)?.backgroundTasks, backgroundTasks);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "成功後のReasoningはlive stateに保持し、次turn開始時のlive stateでは空に初期化する"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: buildEmptyLiveSessionRunState / runSessionTurnInternal finally; docs/design/provider-adapter.md: Streaming Policy" }
  // fault = "reasoningをlive stateから失う、または次turnへ古いreasoningを持ち越す"
  // observable = "各turnのlive reasoningText"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService reasoning lifecycle"
  // lifecycle = "permanent"
  // @end-test-value
  it("成功後も Reasoning は live state に保持し、次の prompt 用 state で空にする", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-old" });
    let liveState: LiveSessionRunState | null = null;
    const liveStates: Array<LiveSessionRunState | null> = [];
    let runCount = 0;

    const service = createProgressRuntime(session, async (input, onProgress) => {
        runCount += 1;
        await emitTestProgress(onProgress, createLiveRunState({
          sessionId: session.id,
          threadId: "thread-new",
          reasoningText: runCount === 1
            ? "既存経路を確認してから表示へ流す"
            : "二回目のturnの推論を表示へ流す",
        }));
        return createPartialResult({
          threadId: "thread-new",
          assistantText: "完了したよ。",
        });
    }, {
      setLiveSessionRun(_sessionId, next) {
        liveState = next;
        liveStates.push(next);
      },
      getLiveSessionRun() {
        return liveState;
      },
    });

    await service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });

    assert.equal(liveStates[0]?.reasoningText, "");
    assert.equal(liveStates.at(-1)?.threadId, "thread-new");
    assert.equal(liveStates.at(-1)?.reasoningText, "既存経路を確認してから表示へ流す");

    await service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "二回目もお願いします" });

    assert.equal(runCount, 2);
    assert.equal(liveStates.filter((state) => state?.reasoningText === "").length >= 2, true);
    assert.equal(liveStates.at(-1)?.reasoningText, "二回目のturnの推論を表示へ流す");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "全終端のlive snapshotはReasoning/taskを保持してもterminal runStateでstepsを空にし、終了後の履歴復元を妨げない"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: runSessionTurn finally; docs/design/desktop-ui.md: 操作履歴" }
  // fault = "終了済みsnapshotをrunningのまま保持するか、Reasoning/taskを消す、または古いlive stepsを残す"
  // observable = "production runtime終了後のlive runState、steps、reasoningText、backgroundTasksと保存artifact"
  // observation_boundary = "public-boundary"
  // scope = "session-runtime-terminal-retained-live"
  // lifecycle = "permanent"
  // impact = "Rendererが実行中と終了後の表示保持を区別できず履歴復元またはReasoning/task表示を失う"
  // distinction = "Renderer fixtureのみではMainが配信するterminal stateとpartial artifact保存を確認できない"
  // @end-test-value
  it("全terminal後のretained liveはReasoning/tasksを保持してstepsを空にする", async () => {
    for (const outcome of ["completed", "failed", "canceled"] as const) {
      const session = createSession();
      const retained: { value: LiveSessionRunState | null } = { value: null };
      const task = { id: "task-1", kind: "shell" as const, status: "running" as const, title: "retained task", updatedAt: "now" };
      const operation = { id: "command-1", type: "command_execution", status: "completed", summary: "fixture command", exitCode: 0 };
      const partial = createPartialResult({ assistantText: "acquired response", artifact: { title: "Result", activitySummary: [], runChecks: [], changedFiles: [], operationTimeline: [operation] } });
      const service = createProgressRuntime(session, async (input, progress) => {
        await emitTestProgress(progress, createLiveRunState({ sessionId: input.session.id, reasoningText: "retained reasoning", backgroundTasks: [task], steps: [operation] }));
        if (outcome !== "completed") throw new ProviderTurnError("fixture stopped", partial, outcome === "canceled");
        return partial;
      }, {
        setLiveSessionRun(_id, next) { retained.value = next; },
        getLiveSessionRun: () => retained.value,
      });
      const result = await service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "run" });
      assert.equal(retained.value?.runState, outcome === "failed" ? "error" : "idle");
      assert.equal(retained.value?.cancellationState, undefined);
      assert.deepEqual(retained.value?.steps, []);
      assert.equal(retained.value?.reasoningText, "retained reasoning");
      assert.deepEqual(retained.value?.backgroundTasks, [task]);
      assert.deepEqual(result.messages.at(-1)?.artifact?.operationTimeline, [operation]);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "利用者cancelはidle Sessionを保存し、failed terminal通知を依頼しない"
  // oracle = { type = "contract", ref = "accepted contract: user cancel is not a failure notification" }
  // fault = "利用者cancelをfailed通知して意図した中止をエラーと誤認させる"
  // scope = "session-runtime-terminal-cancel"
  // observable = "cancel時の保存status/runStateとterminal通知呼び出し"
  // observation_boundary = "public-boundary"
  // lifecycle = "permanent"
  // @end-test-value
  it("利用者cancel時は idle session を保存し、failed通知を依頼しない", async () => {
    const baseSession = createSession();
    const storedSessions: Session[] = [];
    const turnUpdates: UpdateSessionTurnInput[] = [];
    let detachedSessionId: string | null = null;
    let cleanupStartedSessionId: string | null = null;
    let notificationCount = 0;
    let releaseInvalidation: () => void = () => undefined;
    const invalidationBarrier = new Promise<void>((resolve) => {
      releaseInvalidation = resolve;
    });
    let signalInvalidationStarted: () => void = () => undefined;
    const invalidationStarted = new Promise<void>((resolve) => {
      signalInvalidationStarted = resolve;
    });
    const partialResult: RunSessionTurnResult = {
      threadId: "thread-before-cancel",
      assistantText: "途中まで進んだよ。",
      artifact: { title: "", activitySummary: [], changedFiles: [], runChecks: [], operationTimeline: [{ id: "step-1", type: "command_execution", summary: "npm run build", status: "in_progress" }] },


      usage: null,
    };
    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread(sessionId) {
        detachedSessionId = sessionId;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        cleanupStartedSessionId = sessionId;
        signalInvalidationStarted();
        await invalidationBarrier;
      },
      async invalidateAllSessionThreads() {},
      async runSessionTurn(input, onProgress) {
        await emitTestProgress(onProgress, createLiveRunState({
          sessionId: input.session.id,
          threadId: "thread-before-cancel",
          assistantText: "途中まで進んだよ。",
          steps: [
            {
              id: "step-1",
              type: "command_execution",
              summary: "npm run build",
              status: "in_progress",
            },
          ],
          usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 },
        }));
        setTimeout(() => {
          void emitTestProgress(onProgress, createLiveRunState({
            sessionId: input.session.id,
            threadId: "thread-late",
            assistantText: "late cancel progress",
            steps: [
              {
                id: "step-late",
                type: "command_execution",
                summary: "late cancel step",
                status: "in_progress",
              },
            ],
          }));
        }, 0);
        throw new ProviderTurnError("cancelled", partialResult, true);
      },
    };

    const service = createTestRuntime({
      getSession() {
        return baseSession;
      },
      upsertSession(next) {
        storedSessions.push(next);
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn(_id, entry) {
        turnUpdates.push(entry);
      },
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "deny";
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread(providerId, sessionId) {
        return adapter.invalidateSessionThread(sessionId);
      },
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      notifySessionTurnTerminal() {
        notificationCount += 1;
      },
      currentTimestampLabel,
    });

    const run = service.runSessionTurn(baseSession.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });
    const result = await run;
    assert.equal(service.isRunInFlight(baseSession.id), false);
    assert.equal(detachedSessionId, baseSession.id);
    assert.equal(cleanupStartedSessionId, null);
    await invalidationStarted;
    assert.equal(cleanupStartedSessionId, baseSession.id);
    releaseInvalidation();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(result.runState, "idle");
    assert.equal(result.status, "idle");
    assert.equal(storedSessions.at(-1)?.status, "idle");
    assert.equal(storedSessions.at(-1)?.runState, "idle");
    assert.match(result.messages.at(-1)?.text ?? "", /Run canceled/);
    assert.equal(turnUpdates.length, 1);
    assert.equal(turnUpdates.at(-1)?.phase, "canceled");
    assert.equal(turnUpdates.at(-1)?.threadId, "thread-before-cancel");
    assert.equal(detachedSessionId, baseSession.id);
    assert.equal(notificationCount, 0);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "実行中sessionはin-flightとして見え、完了後に解放される"
  // oracle = { type = "contract", ref = "Session runtime in-flight contract" }
  // fault = "実行中判定がfalseになる、または完了後もin-flightを保持する"
  // observable = "hasInFlightRuns/isRunInFlightの値"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService in-flight tracking"
  // lifecycle = "permanent"
  // @end-test-value
  it("実行中の session は in-flight として見え、完了後に解放される", async () => {
    const session = createSession();
    let resolveRun: ((value: RunSessionTurnResult) => void) | null = null;

    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      runSessionTurn() {
        return new Promise<RunSessionTurnResult>((resolve) => {
          resolveRun = resolve;
        });
      },
    };

    const service = createTestRuntime({
      getSession() {
        return session;
      },
      upsertSession(next) {
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn() {},
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      async invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const promise = service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(service.isRunInFlight(session.id), true);
    if (!resolveRun) {
      throw new Error("runSessionTurn の resolve が取得できていないよ。");
    }
    const completeRun: (value: RunSessionTurnResult) => void = resolveRun;
    completeRun({
      threadId: "thread-3",
      assistantText: "完了したよ。",


      usage: null,
    });
    await promise;
    assert.equal(service.isRunInFlight(session.id), false);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "setup dependency停止時もcancel deadlineで呼び出しを収束させ、実終了まで再送を拒否する"
  // oracle = { type = "contract", ref = "Session runtime cancellation deadline contract" }
  // fault = "cancelが無期限に待機する、またはdependency実行中に再送を許可する"
  // observable = "cancel completion、再送拒否、dependency終了後のin-flight state"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService cancellation deadline"
  // lifecycle = "permanent"
  // @end-test-value
  it("setup dependency が停止しても cancel deadline で呼び出しを収束させ、dependency の実終了まで再送を拒否する", async () => {
    const session = createSession();
    let resolveComposer: (preview: ComposerPreview) => void = () => undefined;
    let providerCalled = false;
    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      async runSessionTurn() {
        providerCalled = true;
        return createPartialResult();
      },
    };

    const service = createTestRuntime({
      getSession() {
        return session;
      },
      upsertSession(next) {
        return next;
      },
      resolveComposerPreview() {
        return new Promise<ComposerPreview>((resolve) => {
          resolveComposer = resolve;
        });
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn() {},
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      async invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
      providerCancelGraceMs: 5,
    });

    const runPromise = service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!resolveComposer) {
      throw new Error("composer setup が開始されていないよ。");
    }
    assert.equal(service.isRunInFlight(session.id), true);
    service.cancelRun(session.id);
    const outcome = await Promise.race([
      runPromise.then(() => "resolved", () => "rejected"),
      new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), 25)),
    ]);

    assert.equal(service.hasInFlightRuns(), true);
    await assert.rejects(
      service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "再送" }),
      /This session is already running/,
    );
    if (!resolveComposer) {
      throw new Error("composer resolve が取得できていないよ。");
    }
resolveComposer!({ attachments: [], errors: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(outcome, "rejected");
    assert.equal(providerCalled, false);
    assert.equal(service.hasInFlightRuns(), false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "quitはproviderを先にcancelし、非協力providerの猶予満了後もterminal保存を待ってDBを閉じ、実終了までは再送を拒否する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#app-quit" }
  // fault = "cancelより先に送信結果を待つか、cancel猶予と同時にquitがtimeoutするか、terminal保存前にDBを閉じる"
  // observable = "provider abort、保存gate中のDB close回数、quit完了、再送拒否、provider実終了後のin-flight解除"
  // observation_boundary = "public-boundary"
  // scope = "runtime-bridge-lifecycle-quit"
  // lifecycle = "permanent"
  // distinction = "実runtimeの非協力providerとbridge・lifecycleを接続し、復元保存単体では検出できない停止順序と待機期限を確認する"
  // @end-test-value
  it("provider が cancel 後も生存する間は terminal session への再送を拒否する", async () => {
    const session = createSession();
    const approvalResolutions: Array<{ sessionId: string; decision: LiveApprovalDecision }> = [];
    let observedAbortSignal: AbortSignal | undefined;
    let observedAbort = false;
    let providerStarted!: () => void;
    const providerReady = new Promise<void>((resolve) => { providerStarted = resolve; });
    let terminalStarted!: () => void;
    const terminalReady = new Promise<void>((resolve) => { terminalStarted = resolve; });
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    let terminalStored = false;
    let resolveProvider: (result: RunSessionTurnResult) => void = () => undefined;
    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      runSessionTurn(input) {
        observedAbortSignal = input.signal;
        if (!input.signal) {
          throw new Error("AbortSignal が渡されていないよ。");
        }
        const signal = input.signal;
        observedAbort = signal.aborted;
        signal.addEventListener("abort", () => {
          observedAbort = true;
        }, { once: true });
        providerStarted();
        return new Promise<RunSessionTurnResult>((resolve) => {
          resolveProvider = resolve;
        });
      },
    };

    const service = createTestRuntime({
      getSession() {
        return session;
      },
      upsertSession(next) {
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn() {},
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      async invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest(sessionId, decision) {
        approvalResolutions.push({ sessionId, decision });
      },
      async upsertTerminalSession(next) {
        terminalStarted();
        await terminalGate;
        terminalStored = true;
        return next;
      },
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const promise = service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });
    await providerReady;
    if (!observedAbortSignal) {
      throw new Error("provider setup が開始されていないよ。");
    }
    // A previously closed Window has no renderer ACK; Main must still cancel
    // and wait for the send lifecycle before AppLifecycle closes persistence.
    const bridge = new SessionWindowBridge({
      createWindow() { throw new Error("no Window should be created"); },
      async loadChatEntry() {},
      getSession: () => session,
      isRunInFlight: (id) => service.isRunInFlight(id),
      confirmCloseWhileRunning: () => true,
      broadcastOpenSessionWindowIds() {},
      cancelInFlightSessionRuns: () => service.cancelAllRuns(),
      waitForPendingDraftSends: async () => { await promise; return true; },
    });
    let closeCount = 0;
    let quitCount = 0;
    const lifecycle = new AppLifecycleService({
      hasInFlightSessionRuns: () => service.hasInFlightRuns(),
      getAllowQuitWithInFlightRuns: () => false,
      setAllowQuitWithInFlightRuns() {},
      async createHomeWindow() {},
      shouldQuitWhenAllWindowsClosed: () => false,
      confirmQuitWhileRunning: () => true,
      flushSessionWindowDrafts: () => bridge.flushSessionWindowDrafts(),
      closePersistentStores: () => { assert.equal(terminalStored, true); closeCount += 1; },
      quitApp: () => { quitCount += 1; },
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const quitting = lifecycle.handleBeforeQuit({ preventDefault() {} });
      assert.equal(observedAbort, true);
      assert.equal(bridge.isQuitPending(), true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      mock.timers.tick(DEFAULT_PROVIDER_CANCEL_GRACE_MS);
      await terminalReady;
      mock.timers.tick(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closeCount, 0);
      assert.equal(quitCount, 0);
      assert.equal(bridge.isQuitPending(), true, "quit must allow persistence time after cancellation grace");
      releaseTerminal();
      await quitting;
      assert.equal(closeCount, 1);
      assert.equal(quitCount, 1);
    } finally {
      mock.timers.reset();
    }
    const result = await promise;

    if (!observedAbortSignal) {
      throw new Error("abort signal が観測できていないよ。");
    }
    assert.equal(observedAbort, true);
    assert.equal(result.runState, "idle");
    assert.equal(service.hasInFlightRuns(), true);
    await assert.rejects(
      service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "再送" }),
      /This session is already running/,
    );
    if (!resolveProvider) {
      throw new Error("provider resolve が取得できていないよ。");
    }
resolveProvider!(createPartialResult());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.hasInFlightRuns(), false);
    assert.deepEqual(approvalResolutions, [
      { sessionId: session.id, decision: "deny" },
      { sessionId: session.id, decision: "deny" },
    ]);
  });

  // @test-value v2
  // kind = "regression"
  // claim = "利用者cancelとprovider成功が競合してもterminal通知を依頼しない"
  // oracle = { type = "contract", ref = "accepted contract: user cancel is not a failure notification" }
  // fault = "cancel後に到着したprovider成功をcompleted通知し、利用者の中止操作と矛盾する"
  // scope = "session-runtime-terminal-cancel-race"
  // observable = "terminal通知呼び出し回数と保存済みrunState"
  // observation_boundary = "public-boundary"
  // lifecycle = "permanent"
  // distinction = "通常のprovider canceled errorではなく、cancel後にproviderがgrace内で成功する競合を扱う"
  // @end-test-value
  it("cancel 後に provider が grace 内で成功しても完了通知しない", async () => {
    const session = createSession();
    let resolveProvider: (result: RunSessionTurnResult) => void = () => undefined;
    let notificationCount = 0;
    let queuedAppraisalCount = 0;
    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      runSessionTurn() {
        return new Promise<RunSessionTurnResult>((resolve) => {
          resolveProvider = resolve;
        });
      },
    };

    const service = createTestRuntime({
      getSession() {
        return session;
      },
      upsertSession(next) {
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      queueCompletedTurnAppraisal(input) {
        queuedAppraisalCount += 1;
        assert.equal(input.assistantMessageIndex, input.session.messages.length - 1);
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn() {},
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      async invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      notifySessionTurnTerminal() {
        notificationCount += 1;
      },
      currentTimestampLabel,
      providerCancelGraceMs: 1_000,
    });

    const runPromise = service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!resolveProvider) {
      throw new Error("provider resolve が取得できていないよ。");
    }

    service.cancelRun(session.id);
    resolveProvider(createPartialResult({ assistantText: "完了したよ。" }));
    const result = await runPromise;

    assert.equal(result.runState, "idle");
    assert.equal(result.messages.at(-1)?.text, "完了したよ。");
    assert.equal(notificationCount, 0);
    assert.equal(queuedAppraisalCount, 1);
  });

  // @test-value v2
  // kind = "regression"
  // claim = "利用者cancel後にproviderがgrace内でnoncanceled errorを返してもfailed terminal通知を依頼しない"
  // oracle = { type = "contract", ref = "accepted contract: user cancel is not a failure notification" }
  // fault = "adapterがcancel前にcanceled=falseを確定して遅延rejectすると、abort済みturnをfailed通知して利用者に失敗と誤認させる"
  // scope = "session-runtime-terminal-cancel-race"
  // observable = "failed terminal通知呼び出し回数と保存済みrunState"
  // observation_boundary = "public-boundary"
  // lifecycle = "permanent"
  // distinction = "cancel後のprovider成功ではなく、grace内にcanceled=falseのProviderTurnErrorがrejectする経路を扱う"
  // @end-test-value
  it("cancel 後に provider が grace 内で noncanceled error を返しても失敗通知しない", async () => {
    const session = createSession();
    let rejectProvider: (error: Error) => void = () => undefined;
    let notificationCount = 0;
    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      runSessionTurn() {
        return new Promise<RunSessionTurnResult>((_resolve, reject) => {
          rejectProvider = reject;
        });
      },
    };

    const service = createTestRuntime({
      getSession() {
        return session;
      },
      upsertSession(next) {
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn() {},
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      async invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      notifySessionTurnTerminal() {
        notificationCount += 1;
      },
      currentTimestampLabel,
      providerCancelGraceMs: 1_000,
    });

    const runPromise = service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!rejectProvider) {
      throw new Error("provider reject が取得できていないよ。");
    }

    service.cancelRun(session.id);
rejectProvider!(new ProviderTurnError("workspace snapshot failed", createPartialResult(), false));
    const result = await runPromise;

    assert.equal(result.runState, "error");
    assert.equal(notificationCount, 0);
  });

  // @test-value v2
  // kind = "regression"
  // claim = "内部stale retryが成功したturnは一つのcompleted terminal通知だけを依頼する"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "内部retryの各attemptを別turnとして通知し、同一turnで重複通知する"
  // scope = "session-runtime-stale-retry-terminal-notification"
  // observable = "completed terminal通知の回数と保存済みSession"
  // observation_boundary = "public-boundary"
  // lifecycle = "permanent"
  // @end-test-value
  it("stale thread / session error で meaningful partial が無い時だけ thread reset 後に 1 回 retry する", async () => {
    const session = createSession({ provider: "copilot", threadId: "thread-stale" });
    const storedSessions: Session[] = [];
    const invalidated: Array<{ providerId: string | null | undefined; sessionId: string }> = [];
    const reset: Array<{ providerId: string | null | undefined; sessionId: string }> = [];
    const turnUpdates: UpdateSessionTurnInput[] = [];
    const seenThreadIds: string[] = [];
    const seenBindingGenerations: Array<string | undefined> = [];
    let bindingGeneration = 0;
    const timingContexts: Array<ConversationTimingContext | undefined> = [];
    const fixedObservedAt = new Date("2026-08-04T12:32:00.000Z");
    const timingContext: ConversationTimingContext = {
      observedAt: "2026-08-04T21:32:00.000+09:00",
      observedDayOfWeek: "tuesday",
      currentSession: null,
      sameCharacterOtherSession: null,
      sameCharacterSharedWork: null,
    };
    let attempt = 0;
    let notificationCount = 0;
    let timingResolutionCount = 0;
    let currentDateCount = 0;
    const runtimeTurnHandles: object[] = [];
    const endedRuntimeTurnHandles: unknown[] = [];
    const seenTurnCapabilities: Array<string | undefined> = [];

    const adapter: ProviderCodingAdapter = {
      composePrompt(input) {
        timingContexts.push(input.conversationTimingContext);
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      async runSessionTurn(input) {
        attempt += 1;
        seenThreadIds.push(input.session.threadId);
        seenBindingGenerations.push(input.agentRuntimeBinding?.executionGeneration);
        seenTurnCapabilities.push(input.agentRuntimeBinding?.turnCapability);
        timingContexts.push(input.conversationTimingContext);
        if (attempt === 1) {
          throw new ProviderTurnError("thread not found", createPartialResult({ threadId: "thread-stale" }), false);
        }

        return createPartialResult({
          threadId: "thread-fresh",
          assistantText: "再試行で成功したよ。",
        });
      },
    };

    const service = createTestRuntime({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      upsertSession(next) {
        storedSessions.push(next);
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({ codingProviderSettings: { copilot: { enabled: true } } });
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog("copilot")] }, provider: createProviderCatalog("copilot") };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getProviderAgentRuntimeBinding({ session: bindingSession, provider }) {
        bindingGeneration += 1;
        return {
          bindingId: `binding-${bindingGeneration}`,
          bindingReference: `reference-${bindingGeneration}`,
          providerId: provider.id,
          executionGeneration: `generation-${bindingGeneration}`,
          transport: "env",
          expiresAt: null,
        };
      },
      beginProviderAgentRuntimeTurn({ binding }) {
        assert.equal(binding?.executionGeneration, "generation-1");
        const handle = {};
        runtimeTurnHandles.push(handle);
        return {
          handle,
          binding: binding ? { ...binding, turnCapability: "turn-capability-a" } : null,
        };
      },
      endProviderAgentRuntimeTurn(handle) {
        endedRuntimeTurnHandles.push(handle);
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      resolveConversationTimingContext(_session, observedAt) {
        timingResolutionCount += 1;
        assert.equal(observedAt, fixedObservedAt);
        return timingContext;
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn(_id, entry) {
        turnUpdates.push(entry);
      },
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread(providerId, retrySessionId) {
        invalidated.push({ providerId, sessionId: retrySessionId });
      },
      resetProviderSessionThread(providerId, retrySessionId) {
        reset.push({ providerId, sessionId: retrySessionId });
      },
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      notifySessionTurnTerminal() {
        notificationCount += 1;
      },
      currentTimestampLabel,
      currentDate() {
        currentDateCount += 1;
        return fixedObservedAt;
      },
    });

    const result = await service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });
    await waitForCondition(() => turnUpdates.length === 1, "retry成功turnが保存されること");

    assert.equal(result.runState, "idle");
    assert.equal(result.threadId, "thread-fresh");
    assert.equal(result.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(result.messages.filter((message) => message.role === "assistant").length, 1);
    assert.deepEqual(seenThreadIds, ["thread-stale", ""]);
    assert.deepEqual(seenBindingGenerations, ["generation-1", "generation-1"]);
    assert.deepEqual(seenTurnCapabilities, ["turn-capability-a", "turn-capability-a"]);
    assert.equal(bindingGeneration, 1);
    assert.equal(runtimeTurnHandles.length, 1);
    assert.deepEqual(endedRuntimeTurnHandles, runtimeTurnHandles);
    assert.deepEqual(reset, [{ providerId: "copilot", sessionId: session.id }]);
    assert.deepEqual(invalidated, []);
    assert.equal(storedSessions.length, 3);
    assert.equal(storedSessions[1]?.threadId, "");
    assert.equal(turnUpdates.length, 1);
    assert.equal(turnUpdates.at(-1)?.phase, "completed");
    assert.equal(notificationCount, 1);
    assert.equal(currentDateCount, 1);
    assert.equal(timingResolutionCount, 1);
    assert.deepEqual(timingContexts, [timingContext, timingContext]);
    assert.equal(timingContexts[0], timingContexts[1]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "stale retry中は旧attemptのlate progressをlive stateへ反映しない"
  // oracle = { type = "contract", ref = "Session runtime stale attempt isolation contract" }
  // fault = "旧providerのlate progressが新attemptのUIへ混入する"
  // observable = "live progressのthreadIdとassistantText"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService stale attempt isolation"
  // lifecycle = "permanent"
  // @end-test-value
  it("stale retry 中は旧 attempt の late progress を live state へ反映しない", async () => {
    const session = createSession({ provider: "copilot", threadId: "thread-stale" });
    const turnUpdates: UpdateSessionTurnInput[] = [];
    const liveStates: Array<LiveSessionRunState | null> = [];
    let attempt = 0;
    let notifySecondAttemptStarted: (() => void) | null = null;
    let releaseSecondAttempt: (() => void) | null = null;
    const secondAttemptStarted = new Promise<void>((resolve) => {
      notifySecondAttemptStarted = resolve;
    });
    const secondAttemptGate = new Promise<void>((resolve) => {
      releaseSecondAttempt = resolve;
    });

    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      async runSessionTurn(input, onProgress) {
        attempt += 1;
        if (attempt === 1) {
          await emitTestProgress(onProgress, createLiveRunState({
            sessionId: input.session.id,
            threadId: "thread-before-retry",
            assistantText: "1 回目の progress",
            steps: [{ id: "step-1", type: "command_execution", summary: "npm test", status: "in_progress" }],
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 },
          }));
          setTimeout(() => {
            void emitTestProgress(onProgress, createLiveRunState({
              sessionId: input.session.id,
              threadId: "thread-stale-late",
              assistantText: "旧 attempt の late progress",
              steps: [{ id: "step-stale-late", type: "command_execution", summary: "stale step", status: "in_progress" }],
              usage: { inputTokens: 99, cachedInputTokens: 0, outputTokens: 9 },
            }));
          }, 0);
          throw new ProviderTurnError("thread not found", createPartialResult({ threadId: "thread-stale" }), false);
        }

        notifySecondAttemptStarted?.();
        await emitTestProgress(onProgress, createLiveRunState({
          sessionId: input.session.id,
          threadId: "thread-fresh-progress",
          assistantText: "2 回目の progress",
          steps: [{ id: "step-2", type: "command_execution", summary: "npm run build", status: "in_progress" }],
          usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 2 },
        }));
        await secondAttemptGate;
        return createPartialResult({
          threadId: "thread-fresh",
          assistantText: "再試行で成功したよ。",
        });
      },
    };

    const service = createTestRuntime({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      upsertSession(next) {
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({ codingProviderSettings: { copilot: { enabled: true } } });
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog("copilot")] }, provider: createProviderCatalog("copilot") };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn(_id, entry) {
        turnUpdates.push(entry);
      },
      setLiveSessionRun(_sessionId, state) {
        liveStates.push(state);
      },
      getLiveSessionRun() {
        return liveStates.at(-1) ?? null;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      async invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const runPromise = service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });
    await secondAttemptStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
releaseSecondAttempt!();
    await runPromise;

    assert.equal(liveStates.some((state) => state?.threadId === "thread-stale-late"), false);
    assert.equal(liveStates.some((state) => state?.assistantText === "旧 attempt の late progress"), false);
  });


  // @test-value v2
  // kind = "invariant"
  // claim = "usage_limit reasonは最小turnとassistant fallbackで通常失敗文言に変換しない"
  // oracle = { type = "contract", ref = "Session runtime usage limit error contract" }
  // fault = "usage limitを通常provider failureとして表示し、利用者の制限理由を隠す"
  // observable = "turn error fieldsとassistant fallback text"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService usage limit failure mapping"
  // lifecycle = "permanent"
  // @end-test-value
  it("usage_limit reason は 最小turn と assistant fallback で通常失敗文言にしない", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-before-limit" });
    const storedSessions: Session[] = [];
    const turnUpdates: UpdateSessionTurnInput[] = [];
    const usageLimitMessage =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jun 12th, 2026 2:07 AM.";

    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      async runSessionTurn() {
        throw new ProviderTurnError(
          usageLimitMessage,
          createPartialResult({ threadId: "thread-before-limit" }),
          false,
          "usage_limit",
        );
      },
    };

    const service = createTestRuntime({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      upsertSession(next) {
        storedSessions.push(next);
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(currentSession) {
        return createSessionMemory(currentSession.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn(_id, entry) {
        turnUpdates.push(entry);
      },
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision() {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      async invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });
    await waitForCondition(() => turnUpdates.at(-1)?.phase === "failed", "usage limit最小turnが保存されること");
    const expectedMessage = "Codex usage limit reached.\nTry again at: Jun 12th, 2026 2:07 AM";

    assert.equal(result.runState, "error");
    assert.equal(turnUpdates.at(-1)?.phase, "failed");
    assert.equal(turnUpdates.at(-1)?.errorMessage, expectedMessage);
    assert.equal(storedSessions.at(-1)?.messages.at(-1)?.text, expectedMessage);
    assert.doesNotMatch(storedSessions.at(-1)?.messages.at(-1)?.text ?? "", /実行に失敗したよ。/);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Codexのstale失敗は再実行せず取得済みpartial本文をerror Sessionへ保持する"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: runSessionTurnInternal catch; docs/design/provider-adapter.md: Error Handling / 通常履歴と最小turn" }
  // fault = "Codexの失敗を自動再実行する、取得済み本文を返却履歴から落とす、またはerror Session保存とthread invalidationを省く"
  // observable = "Codex adapter呼出数、返却SessionのrunState/最終本文、Session保存数とinvalidation対象"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService stale error partial handling"
  // lifecycle = "permanent"
  // @end-test-value
  it("meaningful partial が出た stale error は internal retry しない", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-stale" });
    const storedSessions: Session[] = [];
    const invalidated: Array<{ providerId: string | null | undefined; sessionId: string }> = [];
    let attempt = 0;

    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      async runSessionTurn() {
        attempt += 1;
        throw new ProviderTurnError("thread not found", createPartialResult({ assistantText: "途中まで出たよ。" }), false);
      },
    };

    const service = createTestRuntime({
      getSession() {
        return session;
      },
      upsertSession(next) {
        storedSessions.push(next);
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn() {},
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread(providerId, retrySessionId) {
        invalidated.push({ providerId, sessionId: retrySessionId });
      },
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });

    assert.equal(attempt, 1);
    assert.equal(result.runState, "error");
    assert.match(result.messages.at(-1)?.text ?? "", /途中まで出たよ。/);
    assert.deepEqual(invalidated, [{ providerId: "codex", sessionId: session.id }]);
    assert.equal(storedSessions.length, 2);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "not_foundを返したCodex turnは一回のerror Sessionとして返り、thread invalidationを一回依頼する"
  // oracle = { type = "contract", ref = "src-electron/session/session-runtime-service.ts: runSessionTurnInternal catch / invalidateProviderSessionThreadBestEffort; docs/design/provider-adapter.md: Error Handling" }
  // fault = "Codexの汎用not_found errorを自動再実行する、error Sessionを保存しない、またはthread invalidationを省く"
  // observable = "Codex adapter呼出数、返却SessionのrunState/最終error本文、Session保存数とinvalidation対象"
  // observation_boundary = "public-boundary"
  // scope = "SessionRuntimeService provider error classification"
  // lifecycle = "permanent"
  // @end-test-value
  it("not_found 単独 code の provider error では internal retry しない", async () => {
    const session = createSession({ provider: "codex", threadId: "thread-stale" });
    const storedSessions: Session[] = [];
    const invalidated: Array<{ providerId: string | null | undefined; sessionId: string }> = [];
    let attempt = 0;

    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      async runSessionTurn() {
        attempt += 1;
        const error = new ProviderTurnError("resource not found", createPartialResult(), false) as ProviderTurnError & { code?: string };
        error.code = "not_found";
        throw error;
      },
    };

    const service = createTestRuntime({
      getSession() {
        return session;
      },
      upsertSession(next) {
        storedSessions.push(next);
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] };
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn() {},
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(_sessionId, _request, _signal): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread(providerId, retrySessionId) {
        invalidated.push({ providerId, sessionId: retrySessionId });
      },
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願いします" });

    assert.equal(attempt, 1);
    assert.equal(result.runState, "error");
    assert.match(result.messages.at(-1)?.text ?? "", /resource not found/);
    assert.deepEqual(invalidated, [{ providerId: "codex", sessionId: session.id }]);
    assert.equal(storedSessions.length, 2);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "completed Sessionを保存した後にその保存結果で通知し、通知の非同期failureはturn成功を変更しない"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "永続化前snapshotを通知するか、通知Promise rejectionでcompleted turnをfailedへ変更する"
  // scope = "session-runtime-completed-terminal-notification"
  // observable = "通知へ渡される保存済みSessionとturn結果"
  // observation_boundary = "public-boundary"
  // lifecycle = "permanent"
  // @end-test-value
  it("Session success を保存後に通知し、通知 failure は turn を失敗させない", async () => {
    const session = createSession();
    let persistedCompletedSession: Session | null = null;
    let notifiedSession: Session | null = null;
    const adapter: ProviderCodingAdapter = {
      composePrompt() {
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
      async getProviderQuotaTelemetry() {
        return null;
      },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      async runSessionTurn() {
        return createPartialResult({
          threadId: "thread-1",
          assistantText: "完了したよ。",
        });
      },
    };

    const service = createTestRuntime({
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      upsertSession(next) {
        if (next.runState === "idle" && next.messages.at(-1)?.role === "assistant") {
          persistedCompletedSession = next;
        }
        return next;
      },
      async resolveComposerPreview() {
        return { attachments: [], errors: [] } satisfies ComposerPreview;
      },
      async resolveSessionCharacter() {
        return createCharacter();
      },
      getAppSettings() {
        return normalizeAppSettings({});
      },
      resolveProviderCatalog() {
        return { snapshot: { revision: 1, providers: [createProviderCatalog()] }, provider: createProviderCatalog() };
      },
      getProviderCodingAdapter() {
        return adapter;
      },
      getSessionMemory(current) {
        return createSessionMemory(current.id);
      },
      resolveProjectMemoryEntriesForPrompt() {
        return [];
      },
      createSessionTurn(input) {
        return createSessionTurnBase(input);
      },
      updateSessionTurn() {},
      setLiveSessionRun() {},
      getLiveSessionRun() {
        return null;
      },
      async waitForApprovalDecision(): Promise<LiveApprovalDecision> {
        return "approve" as const;
      },
      async waitForElicitationResponse() {
        return { action: "cancel" } as const;
      },
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      async invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
      notifySessionTurnTerminal(notification) {
        assert.equal(notification.outcome, "completed");
        notifiedSession = notification.session;
        return Promise.reject(new Error("notification failed"));
      },
      currentTimestampLabel,
    });

    const result = await service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願い" });

    assert.equal(result.runState, "idle");
    assert.equal(result.messages.at(-1)?.text, "完了したよ。");
    assert.deepEqual(notifiedSession, result);
    const { messageCount, ...persistedProjection } = result;
    assert.equal(messageCount, result.messages.length);
    assert.deepEqual(persistedCompletedSession, persistedProjection);
    assert.equal((notifiedSession as Session | null)!.messages.at(-1)?.text, "完了したよ。");
  });
});
