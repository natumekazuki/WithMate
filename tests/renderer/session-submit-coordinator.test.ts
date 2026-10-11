import assert from "node:assert/strict";
import test from "node:test";

import {
  LatestRequestRevision,
  SessionSubmitCoordinator,
  StateMutationRevision,
  mergeRefetchedSessionProjection,
} from "../../src/chat/runtime/session-submit-coordinator.js";
import {
  normalizeSessionTurnClientRequestId,
  normalizeSessionTurnCorrelation,
  normalizeSessionTurnSubmitSource,
} from "../../src-shared/session/runtime-state.js";
import type { Session } from "../../src-shared/session/session-state.js";

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

// @test-value v2
// kind = "contract"
// claim = "Mainの再取得はBookmark解除を再付与せず、同じ確定本文の新しい付与も保持する"
// oracle = { type = "contract", ref = "docs/features/message-bookmark-filter.md" }
// fault = "遅いsnapshotのBookmarkを採用し、解除済みを復活させるか付与済みを消す"
// observable = "再取得後のBookmarkおよび追加本文"
// observation_boundary = "public-boundary"
// scope = "main-bookmark-snapshot-convergence"
// lifecycle = "permanent"
// impact = "実行中に確定messageへ行ったBookmark変更が失われる"
// distinction = "送信成功の接続testは古い再取得によるBookmark上書きを検証しない"
// @end-test-value
test("Mainの再取得はBookmark付与・解除を維持する", () => {
  const marked = { role: "assistant" as const, text: "before", isBookmarked: true };
  const unmarked = { role: "assistant" as const, text: "before" };
  const current = createSession({ messages: [unmarked] });
  const stale = createSession({ messages: [marked, { role: "assistant", text: "done" }] });
  const merged = mergeRefetchedSessionProjection(current, stale, true);
  assert.equal(merged.messages[0]?.isBookmarked, undefined);
  assert.equal(merged.messages[1]?.text, "done");
  assert.equal(mergeRefetchedSessionProjection(createSession({ messages: [marked] }), createSession({ messages: [unmarked] }), true).messages[0]?.isBookmarked, true);
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
