import assert from "node:assert/strict";
import test from "node:test";

import {
  LatestRequestRevision,
  SessionSubmitCoordinator,
  StateMutationRevision,
  convergeRejectedLiveRunState,
  convergeRejectedSessionSnapshot,
  convergeResolvedSessionProjection,
  fingerprintSessionDraft,
  mergeRefetchedSessionProjection,
  mergeRejectedSessionDraft,
  recoverRejectedSessionSnapshot,
} from "../../src/chat/runtime/session-submit-coordinator.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import {
  normalizeSessionTurnClientRequestId,
  normalizeSessionTurnCorrelation,
  normalizeSessionTurnSubmitSource,
} from "../../src-shared/session/runtime-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import { ComposerControllerRegistry, type ComposerOwner } from "../../src/chat/composer-controller.js";
import { runMainSessionTurnOperation } from "../../src/chat/runtime/run-main-session-turn-operation.js";
import { resolveComposerSendabilityState } from "../../src/chat/composer/session-composer-feedback.js";
import type { OwnedLiveSessionRunState } from "../../src/chat/runtime/session-live-run-state.js";

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    taskTitle: "test",
    status: "idle",
    updatedAt: "2026-08-13T01:00:00.000Z",
    isPinned: false,
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "workspace",
    workspacePath: "C:\\workspace",
    branch: "main",
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 5,
    characterId: "character-1",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: { main: "#000000", sub: "#000000" },
    characterRuntimeSnapshot: null,
    runState: "idle",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    model: "model",
    reasoningEffort: "medium",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "thread-1",
    messages: [],
    stream: [],
    ...overrides,
  };
}

function createLiveRun(overrides: Partial<LiveSessionRunState> = {}): LiveSessionRunState {
  return {
    sessionId: "session-1",
    threadId: "",
    assistantText: "",
    reasoningText: "",
    steps: [],
    backgroundTasks: [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
    ...overrides,
  };
}

function createTurnOperationHarness() {
  const selectedSession = createSession();
  const owner: ComposerOwner = { kind: "main", id: selectedSession.id };
  const registry = new ComposerControllerRegistry();
  registry.setDraft(owner, "retry message");
  const coordinator = new SessionSubmitCoordinator();
  const revisions = {
    mutation: new StateMutationRevision(),
    projection: new StateMutationRevision(),
    liveRun: new StateMutationRevision(),
  };
  const state = {
    sessions: [selectedSession],
    liveRun: { ownerSessionId: selectedSession.id, state: null } as OwnedLiveSessionRunState,
    pending: null as string | null,
    blockedFeedback: false,
  };
  type OperationInput = Parameters<typeof runMainSessionTurnOperation>[0];
  const api: NonNullable<OperationInput["api"]> = {
    previewComposerInput: async () => ({ attachments: [], errors: [] }),
    runSessionTurn: async () => { throw new Error("send failed"); },
    getSession: async () => { throw new Error("refetch failed"); },
    getLiveSessionRun: async () => null,
  };
  const input: OperationInput = {
    api,
    sessionId: selectedSession.id,
    selectedSession,
    request: { userMessage: "retry message", submitSource: "composer" },
    composerRegistry: registry,
    composerOwner: owner,
    submitCoordinator: coordinator,
    clearDraft: true,
    collapseActionDock: false,
    isCentralPreviewActive: false,
    hasLiveRun: false,
    selectedSessionRunState: selectedSession.runState,
    blockedReason: null,
    isReadOnly: false,
    currentTimestamp: "2026-08-13T01:00:01.000Z",
    validateWorkspace: async () => true,
    state: {
      setAuthoritativeSessions: (update) => {
        revisions.mutation.advance();
        state.sessions = update(state.sessions);
      },
      setLiveRunState: (update) => {
        revisions.liveRun.advance();
        state.liveRun = update(state.liveRun);
      },
      setComposerPreview: (preview) => registry.setPreview(owner, preview),
      acknowledgePreviewChatMessageCount: () => {},
      setPendingSubmitSessionId: (update) => {
        state.pending = typeof update === "function" ? update(state.pending) : update;
      },
      setForceComposerBlockedFeedback: (value) => { state.blockedFeedback = value; },
      collapseActionDock: () => {},
    },
    revisions,
    log: () => {},
  };
  return { input, api, state, registry, owner, coordinator, revisions };
}

// @test-value v2
// kind = "invariant"
// claim = "Main送信と再取得が失敗してlive runを取得できないとき、pinとdraftを保持してidle/errorへ復旧し再送信できる"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: Main Sessionの送信操作と失敗時収束" }
// fault = "再取得失敗を削除結果のnullと同一扱いし、楽観runningを残して再送信を拒否する"
// observable = "operationのreject、Session status/runState/pin/messages、draft、pending、lease、sendability、再送信のAPI到達と成功結果"
// observation_boundary = "consumer"
// scope = "main-session-turn-refetch-failure"
// impact = "実runがないのにComposerから再試行できなくなる"
// distinction = "helper単体では検出できない送信operationの分岐接続を実行し、メモリ内のAPI fakeだけで復旧から再送信まで確認する"
// lifecycle = "permanent"
// @end-test-value
test("Main送信失敗と再取得失敗から復旧し、live runがnullでも取得失敗でも再送信できる", async () => {
  for (const liveResult of ["null", "reject"] as const) {
    const harness = createTurnOperationHarness();
    const { input, api, state, registry, owner, coordinator, revisions } = harness;
    let dispatches = 0;
    api.runSessionTurn = async () => { dispatches += 1; throw new Error("send failed"); };
    api.getSession = async () => {
      state.sessions = state.sessions.map((session) => ({ ...session, isPinned: true }));
      revisions.projection.advance();
      throw new Error("refetch failed");
    };
    api.getLiveSessionRun = async () => {
      if (liveResult === "reject") throw new Error("live refetch failed");
      return null;
    };

    await assert.rejects(runMainSessionTurnOperation(input), /send failed/);
    assert.equal(state.sessions[0].status, "idle");
    assert.equal(state.sessions[0].runState, "error");
    assert.equal(state.sessions[0].isPinned, true);
    assert.deepEqual(state.sessions[0].messages, [{ role: "user", text: "retry message" }]);
    assert.equal(registry.get(owner).draft, "retry message");
    assert.equal(state.liveRun.state, null);
    assert.equal(state.pending, null);
    assert.equal(coordinator.isClaimed(owner.id), false);
    assert.equal(resolveComposerSendabilityState({
      runState: state.sessions[0].runState,
      busyReason: state.pending ? "Sending" : "",
      blockedReason: "",
      inputErrors: registry.get(owner).preview.errors,
      draftText: registry.get(owner).draft,
      forceBlockedFeedback: state.blockedFeedback,
    }).isSendDisabled, false);

    const saved = createSession({ isPinned: true, messages: [{ role: "assistant", text: "done" }] });
    api.runSessionTurn = async () => { dispatches += 1; return saved; };
    const result = await runMainSessionTurnOperation({
      ...input,
      selectedSession: state.sessions[0],
      selectedSessionRunState: state.sessions[0].runState,
    });
    assert.equal(result, saved);
    assert.equal(dispatches, 2);
    assert.deepEqual(state.sessions, [saved]);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "送信失敗後の再取得が正常にnullを返したSessionは削除済みとして収束する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: 削除済みDB行を復元しない" }
// fault = "取得失敗用の復旧を正常なnull結果にも適用し、削除済みSessionを復活させる"
// observable = "operationのrejectと収束後のSession一覧"
// observation_boundary = "consumer"
// scope = "main-session-turn-deleted-refetch"
// distinction = "helperのnull処理だけでなく送信operationの取得成功と失敗の分岐を観測する"
// lifecycle = "permanent"
// @end-test-value
test("Main送信失敗後の正常なnull再取得を復旧fallbackと区別する", async () => {
  const { input, api, state } = createTurnOperationHarness();
  api.getSession = async () => null;
  await assert.rejects(runMainSessionTurnOperation(input), /send failed/);
  assert.deepEqual(state.sessions, []);
});

// @test-value v2
// kind = "invariant"
// claim = "送信失敗後の再取得中に進んだSession本体とlive runの購読更新はfallbackで巻き戻さない"
// oracle = { type = "contract", ref = "src/chat/runtime/session-submit-coordinator.ts: mutation revisionによる最新状態の保護" }
// fault = "取得失敗時にrevisionを無視して新しいSessionやlive runを古い楽観状態へ置き換える"
// observable = "operation終了後のSession一覧とlive runの参照および内容"
// observation_boundary = "consumer"
// scope = "main-session-turn-newer-subscription"
// distinction = "operationのrefetch境界で更新を注入し、既存revision helperが実際に適用されることを確認する"
// lifecycle = "permanent"
// @end-test-value
test("Main送信失敗のfallbackは再取得中の新しい購読状態を維持する", async () => {
  const { input, api, state, revisions } = createTurnOperationHarness();
  const newer = createSession({ messages: [{ role: "assistant", text: "newer subscription" }] });
  const newerLive = { ownerSessionId: newer.id, state: createLiveRun({ assistantText: "newer live" }) };
  api.getSession = async () => {
    state.sessions = [newer];
    revisions.mutation.advance();
    state.liveRun = newerLive;
    revisions.liveRun.advance();
    throw new Error("refetch failed");
  };
  await assert.rejects(runMainSessionTurnOperation(input), /send failed/);
  assert.deepEqual(state.sessions, [newer]);
  assert.equal(state.sessions[0], newer);
  assert.equal(state.liveRun, newerLive);
});

// @test-value v2
// kind = "invariant"
// claim = "Session再取得に失敗しても実行中live runが取得できた場合はrunningを維持する"
// oracle = { type = "contract", ref = "src/chat/composer/session-composer-feedback.ts: running中の重複送信禁止" }
// fault = "取得できたlive runを無視してidle/errorへ復旧し実行中の再送信を許す"
// observable = "Session status/runState、反映されたlive run、sendability"
// observation_boundary = "consumer"
// scope = "main-session-turn-active-live-refetch"
// distinction = "operationのfallback適用条件とComposer送信可否をメモリ内で結合して確認する"
// lifecycle = "permanent"
// @end-test-value
test("Main送信の応答失敗後も取得できたlive runがあれば再送信を許さない", async () => {
  const { input, api, state, registry, owner } = createTurnOperationHarness();
  const liveRun = createLiveRun({ assistantText: "still running" });
  api.getLiveSessionRun = async () => liveRun;
  await assert.rejects(runMainSessionTurnOperation(input), /send failed/);
  assert.equal(state.sessions[0].status, "running");
  assert.equal(state.sessions[0].runState, "running");
  assert.equal(state.liveRun.state, liveRun);
  assert.equal(resolveComposerSendabilityState({
    runState: state.sessions[0].runState,
    blockedReason: "",
    inputErrors: [],
    draftText: registry.get(owner).draft,
    forceBlockedFeedback: false,
  }).isSendDisabled, true);
});

// @test-value v2
// kind = "invariant"
// claim = "同一sessionのpreview待機中submitは一件だけleaseを取得し、release後に再取得可能になる"
// oracle = { type = "contract", ref = "src/chat/runtime/session-submit-coordinator.ts#tryAcquire" }
// fault = "同一sessionの同時submitを二重dispatchするか、leaseをreleaseせず後続submitを恒久的に拒否する"
// observable = "submit結果、dispatch回数、isClaimedの前後状態"
// observation_boundary = "public-boundary"
// scope = "session-submit-coordinator-rapid-submit"
// lifecycle = "permanent"
// @end-test-value
test("SessionSubmitCoordinator は preview 待機中の同一session rapid submitを一件だけ通す", async () => {
  const coordinator = new SessionSubmitCoordinator();
  let releasePreview: () => void = () => undefined;
  const preview = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  let dispatchCount = 0;

  const submit = async () => {
    const lease = coordinator.tryAcquire("session-1");
    if (!lease) {
      return "blocked" as const;
    }
    try {
      await preview;
      dispatchCount += 1;
      return "dispatched" as const;
    } finally {
      lease.release();
    }
  };

  const first = submit();
  const second = await submit();
  assert.equal(second, "blocked");
  assert.equal(dispatchCount, 0);
  assert.equal(coordinator.isClaimed("session-1"), true);
  assert.ok(releasePreview);
  releasePreview();
  assert.equal(await first, "dispatched");
  assert.equal(dispatchCount, 1);
  assert.equal(coordinator.isClaimed("session-1"), false);
  assert.equal(await submit(), "dispatched");
  assert.equal(dispatchCount, 2);
  assert.equal(coordinator.isClaimed("session-1"), false);
});

// @test-value v2
// kind = "invariant"
// claim = "新しい取得要求の開始後は古い要求のrevisionをcurrentと判定しない"
// oracle = { type = "contract", ref = "src/chat/runtime/session-submit-coordinator.ts: LatestRequestRevision" }
// fault = "新しい取得開始でrevisionを更新せず古い取得結果の反映を許す"
// observable = "新旧request revisionに対するisCurrentの戻り値"
// observation_boundary = "public-boundary"
// scope = "session-refetch-request-revision"
// lifecycle = "permanent"
// @end-test-value
test("LatestRequestRevision は逆順で完了した古いsession refetchを失効させる", () => {
  const revisions = new LatestRequestRevision();
  const older = revisions.start();
  const newer = revisions.start();

  assert.equal(revisions.isCurrent(newer), true);
  assert.equal(revisions.isCurrent(older), false);
});

// @test-value v2
// kind = "invariant"
// claim = "状態更新前のcaptureは更新後にcurrentではなくなる"
// oracle = { type = "contract", ref = "src/chat/runtime/session-submit-coordinator.ts: StateMutationRevision" }
// fault = "advance後も取得開始時のrevisionをcurrentと判定し新しい状態の上書きを許す"
// observable = "captureしたrevisionに対するadvance前後のisCurrent"
// observation_boundary = "public-boundary"
// scope = "session-state-mutation-revision"
// lifecycle = "permanent"
// @end-test-value
test("StateMutationRevision はrefetch待機中の楽観またはsubscription更新を検知する", () => {
  const revisions = new StateMutationRevision();
  const refetchStartedAt = revisions.capture();
  assert.equal(revisions.isCurrent(refetchStartedAt), true);

  revisions.advance();
  assert.equal(revisions.isCurrent(refetchStartedAt), false);
});

// @test-value v2
// kind = "invariant"
// claim = "再取得結果の本体を反映しつつ、保持指定時だけ現行pinを優先する"
// oracle = { type = "contract", ref = "src/chat/runtime/session-submit-coordinator.ts: mergeRefetchedSessionProjection" }
// fault = "pin保持時に古い本体まで残す、または取得中のpin変更を巻き戻す"
// observable = "merge結果のSession全体と保持指定なしの戻り値"
// observation_boundary = "public-boundary"
// scope = "session-refetch-pin-projection"
// lifecycle = "permanent"
// @end-test-value
test("session refetch は局所的なpin projectionを維持して権威ある本体状態を反映する", () => {
  const current = createSession({
    isPinned: true,
    runState: "running",
    messages: [{ role: "user", text: "optimistic" }],
  });
  const refreshed = createSession({
    isPinned: false,
    runState: "idle",
    messages: [{ role: "user", text: "accepted" }, { role: "assistant", text: "done" }],
  });

  assert.deepEqual(mergeRefetchedSessionProjection(current, refreshed, true), {
    ...refreshed,
    isPinned: true,
  });
  assert.equal(mergeRefetchedSessionProjection(current, refreshed, false), refreshed);
});

// @test-value v2
// kind = "invariant"
// claim = "turn成功結果の本体を反映しつつ、保持指定時だけ現行pinを優先する"
// oracle = { type = "contract", ref = "src/chat/runtime/session-submit-coordinator.ts: convergeResolvedSessionProjection" }
// fault = "成功応答を反映するとき、実行中に変更されたpinを古い値に戻す"
// observable = "成功収束後のSession全体と保持指定なしの戻り値"
// observation_boundary = "public-boundary"
// scope = "session-turn-success-pin-projection"
// lifecycle = "permanent"
// @end-test-value
test("turn成功応答は実行中に進んだpin projectionを維持して最新本体を反映する", () => {
  const current = createSession({ isPinned: true, runState: "running" });
  const saved = createSession({
    isPinned: false,
    runState: "idle",
    messages: [{ role: "user", text: "accepted" }, { role: "assistant", text: "done" }],
  });

  assert.deepEqual(convergeResolvedSessionProjection(current, saved, true), {
    ...saved,
    isPinned: true,
  });
  assert.equal(convergeResolvedSessionProjection(current, saved, false), saved);
});

// @test-value v2
// kind = "invariant"
// claim = "拒否されたdraftを復元するとき追加入力を失わず、同文なら重複させない"
// oracle = { type = "contract", ref = "src/chat/runtime/session-submit-coordinator.ts: mergeRejectedSessionDraft" }
// fault = "送信後の追加入力を上書きするか同じ入力を二重に復元する"
// observable = "空・追加入力あり・同文の各draftに対する復元文字列"
// observation_boundary = "public-boundary"
// scope = "session-rejected-draft-merge"
// lifecycle = "permanent"
// @end-test-value
test("mergeRejectedSessionDraft は拒否された入力と送信後の追加入力を両方保持する", () => {
  assert.equal(mergeRejectedSessionDraft("送信した内容", ""), "送信した内容");
  assert.equal(
    mergeRejectedSessionDraft("送信した内容", "あとから入力した内容"),
    "送信した内容\n\nあとから入力した内容",
  );
  assert.equal(mergeRejectedSessionDraft("送信した内容", "送信した内容"), "送信した内容");
});

// @test-value v2
// kind = "invariant"
// claim = "draftの診断用fingerprintは同じ入力で安定し、代表的な異なる入力を区別してraw本文を含まない"
// oracle = { type = "contract", ref = "src/chat/runtime/session-submit-coordinator.ts: fingerprintSessionDraft" }
// fault = "fingerprintとしてraw本文や全入力で同じ値を返す"
// observable = "同一draftと異なるdraftのfingerprintの比較およびraw語の不在"
// observation_boundary = "public-boundary"
// scope = "session-draft-diagnostic-fingerprint"
// impact = "診断値へのraw入力混入または送信診断の相関不成立"
// distinction = "文字列型だけではraw本文混入を検出できず、メモリ内の代表入力で契約を確認する。暗号学的安全性や無衝突性は主張しない"
// lifecycle = "permanent"
// @end-test-value
test("fingerprintSessionDraft は本文を含めず同じdraftを安定して識別する", () => {
  const first = fingerprintSessionDraft("secret prompt");
  assert.equal(first, fingerprintSessionDraft("secret prompt"));
  assert.notEqual(first, fingerprintSessionDraft("different prompt"));
  assert.doesNotMatch(first, /secret|prompt/);
});

// @test-value v2
// kind = "invariant"
// claim = "送信相関情報はUUID形式のIDとcomposerを受理し、任意文字列や入力本文由来の相関情報を除く"
// oracle = { type = "contract", ref = "src-shared/session/runtime-state.ts: normalizeSessionTurnCorrelation" }
// fault = "任意文字列または本文を含む相関IDやsubmit sourceを診断ログへ流す"
// observable = "ID・submit sourceの正規化結果と本文を含む相関情報のnull化"
// observation_boundary = "public-boundary"
// scope = "session-turn-correlation-privacy"
// impact = "診断ログへの入力本文混入"
// distinction = "runtimeの未検証文字列と本文との関係はTypeScript型検査では検出できない"
// lifecycle = "permanent"
// @end-test-value
test("normalizeSessionTurnClientRequestId はログへ安全に渡せる相関IDだけを受理する", () => {
  assert.equal(
    normalizeSessionTurnClientRequestId("7c26d875-9117-4ad5-97b5-e9af775b94bc"),
    "7c26d875-9117-4ad5-97b5-e9af775b94bc",
  );
  assert.equal(normalizeSessionTurnClientRequestId("session-turn-mewz2-k4j8n"), null);
  assert.equal(normalizeSessionTurnClientRequestId("turn-123:abc"), null);
  assert.equal(normalizeSessionTurnClientRequestId(""), null);
  assert.equal(normalizeSessionTurnClientRequestId("本文 を含む"), null);
  assert.equal(normalizeSessionTurnClientRequestId("x".repeat(129)), null);
  assert.equal(normalizeSessionTurnSubmitSource("composer"), "composer");
  assert.equal(normalizeSessionTurnSubmitSource("本文"), null);
  assert.deepEqual(normalizeSessionTurnCorrelation({
    userMessage: "secretprompt",
    clientRequestId: "session-turn-secretprompt-abc",
    submitSource: "本文" as "composer",
  }), {
    clientRequestId: null,
    submitSource: null,
  });
  assert.deepEqual(normalizeSessionTurnCorrelation({
    userMessage: "please use 7c26d875-9117-4ad5-97b5-e9af775b94bc",
    clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94bc",
    submitSource: "composer",
  }), {
    clientRequestId: null,
    submitSource: "composer",
  });
});

// @test-value v2
// kind = "invariant"
// claim = "拒否された楽観本体は置換可能時だけ再取得結果へ収束し、pin保持指定と新しい本体を守る"
// oracle = { type = "contract", ref = "src/chat/runtime/session-submit-coordinator.ts: convergeRejectedSessionSnapshot" }
// fault = "置換禁止の本体を古い取得結果で上書きするか、収束時にpin変更を巻き戻す"
// observable = "置換可否とpin保持指定の各組合せに対する返却Session"
// observation_boundary = "public-boundary"
// scope = "session-rejected-snapshot-convergence"
// lifecycle = "permanent"
// @end-test-value
test("convergeRejectedSessionSnapshot は古い楽観snapshotを最新取得結果へ置き換える", () => {
  const before = createSession();
  const optimistic = createSession({
    status: "running",
    runState: "running",
    updatedAt: "2026-08-13T01:00:01.000Z",
    messages: [{ role: "user", text: "rejected" }],
  });
  const refreshed = createSession({
    updatedAt: "2026-08-13T01:00:02.000Z",
    messages: [{ role: "user", text: "accepted earlier" }, { role: "assistant", text: "done" }],
  });

  assert.equal(convergeRejectedSessionSnapshot(optimistic, optimistic, refreshed, true, false), refreshed);
  assert.equal(convergeRejectedSessionSnapshot(before, optimistic, refreshed, false, false), before);
  const pinnedProjection = { ...optimistic, isPinned: true };
  assert.deepEqual(convergeRejectedSessionSnapshot(pinnedProjection, optimistic, refreshed, true, true), {
    ...refreshed,
    isPinned: true,
  });
  const newerSubscription = createSession({
    updatedAt: optimistic.updatedAt,
    messages: [{ role: "user", text: "newer subscription" }],
  });
  assert.equal(convergeRejectedSessionSnapshot(newerSubscription, optimistic, refreshed, false, false), newerSubscription);
});

// @test-value v2
// kind = "invariant"
// claim = "再取得できない楽観本体はpinを保持してidle/errorへ復旧し、置換禁止の新しい本体は維持する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: Main送信失敗後の再取得失敗時の復旧" }
// fault = "楽観runningを残すか、復旧時にpinまたは新しい本体を巻き戻す"
// observable = "復旧後Sessionのstatus/runState/pinおよび置換禁止時の戻り値"
// observation_boundary = "public-boundary"
// scope = "session-rejected-snapshot-recovery"
// lifecycle = "permanent"
// @end-test-value
test("recoverRejectedSessionSnapshot はpin projectionを保持して楽観bodyだけをerrorへ収束する", () => {
  const optimistic = createSession({ status: "running", runState: "running" });
  assert.deepEqual(recoverRejectedSessionSnapshot(optimistic, optimistic, true), {
    ...optimistic,
    status: "idle",
    runState: "error",
  });
  const pinnedProjection = { ...optimistic, isPinned: true };
  assert.deepEqual(recoverRejectedSessionSnapshot(pinnedProjection, optimistic, true), {
    ...optimistic,
    isPinned: true,
    status: "idle",
    runState: "error",
  });

  const newer = createSession({ runState: "idle" });
  assert.equal(recoverRejectedSessionSnapshot(newer, optimistic, false), newer);
});

// @test-value v2
// kind = "invariant"
// claim = "live run取得結果はrevisionが同じ時だけ反映し、新しい購読の内容が空やnullでも維持する"
// oracle = { type = "contract", ref = "src/chat/runtime/session-submit-coordinator.ts: convergeRejectedLiveRunState" }
// fault = "revisionでなく本文の有無で新しさを判定し、完了済みまたは空の購読状態を巻き戻す"
// observable = "同一revision時の取得結果と、revision更新後の通常・null・空状態の参照保持"
// observation_boundary = "public-boundary"
// scope = "session-rejected-live-run-convergence"
// lifecycle = "permanent"
// @end-test-value
test("convergeRejectedLiveRunState は楽観pendingだけを最新取得結果へ収束し、空またはnullの購読更新も巻き戻さない", () => {
  const refreshed = createLiveRun({ threadId: "thread-latest", assistantText: "latest" });
  assert.deepEqual(
    convergeRejectedLiveRunState(
      { ownerSessionId: "session-1", state: createLiveRun() },
      "session-1",
      refreshed,
      3,
      3,
    ),
    { ownerSessionId: "session-1", state: refreshed },
  );

  const subscriptionProgress = createLiveRun({ assistantText: "newer subscription" });
  const current = { ownerSessionId: "session-1", state: subscriptionProgress };
  assert.equal(convergeRejectedLiveRunState(current, "session-1", refreshed, 3, 4), current);
  const completed = { ownerSessionId: "session-1", state: null };
  assert.equal(convergeRejectedLiveRunState(completed, "session-1", refreshed, 3, 4), completed);
  const emptySubscription = { ownerSessionId: "session-1", state: createLiveRun() };
  assert.equal(convergeRejectedLiveRunState(emptySubscription, "session-1", refreshed, 3, 4), emptySubscription);
});
