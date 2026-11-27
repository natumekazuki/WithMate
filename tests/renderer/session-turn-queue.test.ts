import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTurnQueueRow, SessionTurnSubmissionRow } from "../../src/chat/conversation/session-turn-queue-row.js";
import { ComposerControllerRegistry } from "../../src/chat/composer-controller.js";
import { SessionTurnAcceptance } from "../../src/chat/runtime/session-turn-acceptance.js";
import { projectSessionTurnQueue } from "../../src/chat/conversation/session-turn-queue-projection.js";
import { buildMessageListProjection } from "../../src/chat/auxiliary/auxiliary-session-message-projection.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { runMainSessionTurnOperation } from "../../src/chat/runtime/run-main-session-turn-operation.js";
import { SessionSubmitCoordinator } from "../../src/chat/runtime/session-submit-coordinator.js";
import type { Session } from "../../src-shared/session/session-state.js";
import { AuxiliaryDraftPersistenceOwner } from "../../src/chat/auxiliary-draft-persistence-owner.js";
import { useSessionWorkspaceAvailability } from "../../src/chat/runtime/session-window-workspace-hooks.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { WorkspaceDirectoryValidationResult } from "../../src-shared/window/workspace-directory-validation.js";
import { savedReplyConversationFrame } from "../../src-shared/session/conversation-threads.js";

const owner = { kind: "main" as const, id: "session" };
const request = {
  incarnationId: "incarnation", clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94bc", userMessage: "A", submitSource: "composer" as const,
  executionOptions: { catalogRevision: 1, model: "model", reasoningEffort: "medium" as const, approvalMode: "on-request" as const, codexSandboxMode: "workspace-write" as const, codexSpeed: "standard" as const, codexReviewer: "user" as const, customAgentName: "" },
};
function receipt(overrides: Partial<SessionTurnQueueReceipt> = {}): SessionTurnQueueReceipt {
  return { sessionId: owner.id, incarnationId: request.incarnationId, id: "item", requestId: request.clientRequestId, sequence: 1, queuePosition: overrides.sequence ?? 1, state: "queued",
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
// claim = "相手枠への明示返信も送信元の同じ版だけを消し、別枠・同枠追編集・受付失敗の下書きを保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#main-conversation-switcher; docs/design/session-history.md#main列の初期枠子session枠" }
// fault = "表示所属を下書き所有元として消す、後着ACKが本文・添付参照・返信の追編集を消す、拒否時に下書きを消す"
// observable = "受理入口が受け取ったMainの対象・参照と、遅延した結果の前後に各枠で読み直す下書き"
// observation_boundary = "consumer"
// scope = "Mainの通常送信、保存先と異なる下書き所有元、編集中の合成受付"
// lifecycle = "permanent"
// impact = "別の話題の入力や返信先を知らずに失い、意図しない会話に続きを送る"
// distinction = "既存の受付回復・Aux永続下書きテストは、同一Main内の複数枠と返信だけの版変更を検証しない"
// @end-test-value
test("Main acceptance consumes only the originating frame and draft revision", async () => {
  const main = { kind: "main" as const, sessionId: owner.id, incarnationId: request.incarnationId };
  const peer = { kind: "main" as const, sessionId: "peer", incarnationId: "peer-inc" };
  const all = { ...owner, frameKey: "all" };
  const peerDraft = { ...owner, frameKey: "peer" };
  const registry = new ComposerControllerRegistry();
  const replyTo = { target: main, seq: 2 };
  const quote = { key: "two", reference: replyTo };
  const threads = { initialMessageIndexes: [0], children: [
    { target: peer, title: "Peer", messageIndexes: [2], sentMessageIndexes: [0], inboundTurnIds: [] },
  ] };
  const thread = savedReplyConversationFrame(main, threads, replyTo);
  assert.deepEqual(thread, peer);
  assert.equal(savedReplyConversationFrame(main, threads, { target: main, seq: 0 }), null);
  registry.setDraft(owner, "Initial draft");
  registry.setDraft(peerDraft, "Peer draft @peer.txt");
  assert.equal(registry.get(all).draft, "");
  const input = { ...request, userMessage: "Follow-up @example.txt", replyTo, mainConversationFrame: thread };
  for (const scenario of ["accepted", "reply-edited", "attachment-edited", "rejected"] as const) {
    registry.setDraft(all, input.userMessage);
    registry.setReply(all, quote);
    const acceptance = new SessionTurnAcceptance();
    let acknowledge!: (response: Awaited<ReturnType<WithMateWindowApi["enqueueSessionTurn"]>>) => void;
    const op = runMainSessionTurnOperation({
      api: {
        previewComposerInput: async (id, text) => {
          assert.deepEqual([id, text], [main.sessionId, input.userMessage]);
          return { attachments: [], errors: [] };
        },
        enqueueSessionTurn: async (id, payload) => {
          assert.equal(id, main.sessionId);
          assert.deepEqual(payload, input);
          return new Promise((resolve) => { acknowledge = resolve; });
        },
        getSessionTurnQueueReceipt: async () => null,
      },
      sessionId: main.sessionId, selectedSession: session(), request: input, composerRegistry: registry, composerOwner: all,
      submitCoordinator: new SessionSubmitCoordinator(), acceptance, queueTurn: true, clearDraft: true, collapseActionDock: false,
      selectedSessionRunState: "idle", blockedReason: null, isReadOnly: false, validateWorkspace: async () => true,
      state: { setComposerPreview() {}, onSubmitStateChanged() {}, setForceComposerBlockedFeedback() {}, collapseActionDock() {} }, log() {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof acknowledge, "function");
    assert.equal(registry.get(peerDraft).draft, "Peer draft @peer.txt");
    assert.equal(registry.get(all).reply, quote);
    const edited = { key: "zero", reference: { target: main, seq: 0 } };
    if (scenario === "reply-edited") registry.setReply(all, edited); // Only the reply changed; the text is identical.
    if (scenario === "attachment-edited") registry.setDraft(all, "Follow-up @new.txt");
    acknowledge(scenario === "rejected" ? { state: "rejected", reason: "Queue rejected" }
      : receipt({ accepted: { ...receipt().captured, request: input } }));
    if (scenario === "rejected") await assert.rejects(op, /Queue rejected/); else assert.ok(await op);
    assert.equal(registry.get(all).draft, scenario === "accepted" ? "" : scenario === "attachment-edited" ? "Follow-up @new.txt" : input.userMessage);
    assert.equal(registry.get(all).reply, scenario === "accepted" ? undefined : scenario === "reply-edited" ? edited : quote);
    assert.equal(registry.get(peerDraft).draft, "Peer draft @peer.txt");
    assert.equal(registry.get(owner).draft, "Initial draft");
  }
});

// @test-value v2
// kind = "contract"
// claim = "失敗Turnの新規受付はenqueueと自動照会が終わるまで受付不明とは扱わず、重複送信を抑止する。照会でも受付を確認できないときだけ不明とし、同一request IDのreceiptで回復して現在のdraftを保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window: 受付応答・自動照会・回復" }
// fault = "応答待ちを受付不明と扱う、重複送信を通す、別IDで再送する、別receiptを受け入れる、既存draftを消す"
// observable = "enqueue回数、照会request ID、不明状態、照合されたreceiptとdraft本文"
// observation_boundary = "consumer"
// scope = "SessionTurnAcceptance failed Turn retry"
// lifecycle = "permanent"
// impact = "受付済みの外部作用を重複実行し、編集中の指示を失う"
// distinction = "main facadeの保存検証ではrendererのACK喪失とdraft保持を再現できない"
// @end-test-value
test("failed Turn retry resolves an uncertain acknowledgement without replacing the draft", async () => {
  const acceptance = new SessionTurnAcceptance();
  const registry = new ComposerControllerRegistry();
  registry.setDraft(owner, "Keep this draft");
  const retry = { target: { kind: "main" as const, sessionId: owner.id, incarnationId: request.incarnationId }, receiptId: "source", turnId: "42", clientRequestId: request.clientRequestId, executionOptions: request.executionOptions };
  const origin = { kind: "gui" as const, operation: "send" as const, targetSessionId: owner.id, targetIncarnationId: request.incarnationId };
  const acceptedInput = { request, provider: "codex", workspacePath: "workspace", attachments: [], origin,
    retrySource: { receiptId: "source", turnId: "42", origin, changedSinceAcceptance: false } };
  const saved = receipt({ captured: acceptedInput, accepted: acceptedInput });
  let disconnect!: (error: Error) => void;
  let completeLookup!: (receipt: SessionTurnQueueReceipt | null) => void;
  const initialReply = new Promise<SessionTurnQueueReceipt>((_, reject) => { disconnect = reject; });
  const initialLookup = new Promise<SessionTurnQueueReceipt | null>((resolve) => { completeLookup = resolve; });
  let lookups = 0;
  let sends = 0;
  const api = {
    enqueueSessionTurn: async () => { throw new Error("unexpected normal send"); },
    retryFailedSessionTurn: async () => { sends++; return initialReply; },
    getSessionTurnQueueReceipt: async (_sessionId: string, id: string) => { assert.equal(id, retry.clientRequestId); lookups++; return lookups === 1 ? initialLookup : lookups === 2 ? { ...saved, requestId: "wrong" } : saved; },
  };
  const operation = assert.rejects(acceptance.submitFailedRetry(api, owner.id, retry), /acceptance could not be confirmed/);
  assert.equal(acceptance.hasUncertain(owner.id), false);
  await assert.rejects(acceptance.submitFailedRetry(api, owner.id, retry), /in progress/);
  disconnect(new Error("ack lost"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lookups, 1);
  assert.equal(acceptance.hasUncertain(owner.id), false);
  assert.equal(await acceptance.check(api, owner.id, registry), null);
  await assert.rejects(acceptance.submitFailedRetry(api, owner.id, retry), /in progress/);
  completeLookup(null);
  await operation;
  assert.equal(acceptance.hasUncertain(owner.id), true);
  await assert.rejects(acceptance.submitFailedRetry(api, owner.id, retry), /previous turn/);
  await assert.rejects(acceptance.check(api, owner.id, registry), /does not match/);
  assert.equal(acceptance.hasUncertain(owner.id), true);
  assert.equal(await acceptance.check(api, owner.id, registry), saved);
  assert.equal(acceptance.hasUncertain(owner.id), false);
  assert.equal(sends, 1);
  assert.equal(lookups, 3);
  assert.equal(registry.get(owner).draft, "Keep this draft");
});

// @test-value v2
// kind = "contract"
// claim = "受付不明だったResendを同じIDで再試行して拒否が確定したら、元会話に理由を返し、下書きを保ったまま次の操作を許す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window: 受付応答・自動照会・回復" }
// fault = "確定拒否で回復操作を残す、拒否理由を破棄する、別incarnationへ理由または再試行を漏らす、下書きを消す"
// observable = "再試行の送信ID、対象incarnationの拒否理由と受付状態、既存draft"
// observation_boundary = "consumer"
// scope = "failed Turn Resend recovery rejection"
// lifecycle = "permanent"
// impact = "確定していないと誤認し再操作できない状態や、理由が分からないまま再度Resendする状態を防ぐ"
// distinction = "通常送信の拒否testはResendに受付・失敗のローカル本文行がない経路を扱わない"
// @end-test-value
test("failed Turn recovery keeps a known rejection scoped to its original conversation", async () => {
  const acceptance = new SessionTurnAcceptance();
  const registry = new ComposerControllerRegistry();
  registry.setDraft(owner, "Keep this draft");
  const retry = { target: { kind: "main" as const, sessionId: owner.id, incarnationId: request.incarnationId }, receiptId: "source", turnId: "42", clientRequestId: request.clientRequestId, executionOptions: request.executionOptions };
  const sentIds: string[] = [];
  const api = {
    enqueueSessionTurn: async () => { throw new Error("unexpected normal send"); },
    retryFailedSessionTurn: async (_sessionId: string, input: typeof retry) => {
      sentIds.push(input.clientRequestId);
      if (sentIds.length === 1) throw new Error("ack lost");
      return { state: "rejected" as const, reason: "Original input is unavailable." };
    },
    getSessionTurnQueueReceipt: async () => null,
  };
  await assert.rejects(acceptance.submitFailedRetry(api, owner.id, retry), /acceptance could not be confirmed/);
  assert.equal(await acceptance.retry(api, owner.id, registry, "new-incarnation"), null);
  await assert.rejects(acceptance.retry(api, owner.id, registry, request.incarnationId), /Original input is unavailable/);
  assert.deepEqual(sentIds, [retry.clientRequestId, retry.clientRequestId]);
  assert.equal(acceptance.hasUncertain(owner.id, request.incarnationId), false);
  assert.equal(acceptance.resendRecoveryError(owner.id, request.incarnationId), "Original input is unavailable.");
  assert.equal(acceptance.resendRecoveryError(owner.id, "new-incarnation"), "");
  assert.equal(registry.get(owner).draft, "Keep this draft");
});

// @test-value v2
// kind = "contract"
// claim = "Main/Auxiliaryの通常失敗と旧interruptedは共通Failedを一度使い、部分本文・Details・実入力と確定応答を保つ。旧予約の追加入力の受付不明は親のlive応答とは別に表示する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 通常の送信・実行失敗も再起動による失敗も; 失敗後も元要求を自動再送せず" }
// fault = "失敗通知が先着すると消える、二重表示、部分本文・Details欠落、確定済み成功や別Turnへの転記、追加の受付不明を親失敗と混同"
// observable = "応答の本文・artifact・runFailure、保存済み成功と別Turn、tailのassistant alertとuser本文、受付不明のqueue行に再試行buttonなし"
// observation_boundary = "consumer"
// scope = "queue failure response projection"
// lifecycle = "permanent"
// impact = "非同期到着順や送信時のqueue位置で失敗が見失われることを防ぐ"
// distinction = "Column単体testではreceiptからcanonicalへのbridgeとtail経路を通らない。小さいMain/Auxiliary fixtureで境界を確認する"
// @end-test-value
test("failed receipts bridge the response and use the same tail failure surface", () => {
  const failed = receipt({ state: "failed", turnId: "failed-turn", userMessageSeq: 40, reason: "Capacity unavailable." });
  const context = { sessionId: owner.id, incarnationId: request.incarnationId };
  for (const primaryMessageSourceKind of ["session", "auxiliary"] as const) {
    for (const state of ["failed", "interrupted"] as const) {
      const terminal = { ...failed, state };
      const prompt = { role: "user" as const, text: "A", historyIndex: 40 };
      const savedReply = { role: "assistant" as const, text: "saved reply", historyIndex: 41 };
      const savedPartial = { ...savedReply, text: "saved partial", runFailure: terminal.reason!,
        artifact: { title: "Execution details", activitySummary: [], changedFiles: [], runChecks: [{ label: "Fixture operation", value: "finished" }] } };
      const nextPrompt = { role: "user" as const, text: "B", historyIndex: 42 };
      const nextReply = { role: "assistant" as const, text: "B reply", historyIndex: 43 };
      const project = (messages: Parameters<typeof buildMessageListProjection>[0]) =>
        projectSessionTurnQueue(buildMessageListProjection(messages, [], owner.id, { primaryMessageSourceKind }), [terminal], context).projection.messages;
      assert.deepEqual(project([prompt, savedReply, nextPrompt, nextReply]), [prompt, savedReply, nextPrompt, nextReply]);
      assert.deepEqual(project([prompt, savedPartial, nextPrompt, nextReply]), [prompt, savedPartial, nextPrompt, nextReply]);
      assert.deepEqual(project([prompt, nextPrompt, nextReply]), [prompt, { role: "assistant", text: "", runFailure: failed.reason! }, nextPrompt, nextReply]);
      const confirmedInput = { role: "user" as const, text: "confirmed follow-up", historyIndex: 41,
        turnInput: { state: "confirmed" as const, turnId: "parent", nativeTurnId: "native", attachments: [] } };
      const withInput = [prompt, confirmedInput, { ...savedReply, historyIndex: 42 }];
      const inputHistory = buildMessageListProjection(withInput, [], owner.id, { primaryMessageSourceKind });
      assert.deepEqual(projectSessionTurnQueue(inputHistory, [{ ...terminal, inputTurnId: "parent", userMessageSeq: 41 }], context).projection.messages, withInput);
      assert.deepEqual(project([prompt, confirmedInput]), [prompt, confirmedInput, { role: "assistant", text: "", runFailure: failed.reason! }]);
      const laterLive = buildMessageListProjection([prompt], [], owner.id, {
        primaryMessageSourceKind,
        liveAssistant: { sessionId: owner.id, threadId: "shared-thread", withMateTurnId: "later-turn", messageIndex: 42, text: "Later response before its saved prompt" },
      });
      assert.deepEqual(projectSessionTurnQueue(laterLive, [terminal], context).projection.messages,
        [prompt, { role: "assistant", text: "", runFailure: failed.reason! }, laterLive.messages[1]]);
    }
    const liveHistory = buildMessageListProjection([{ role: "user", text: "parent input", historyIndex: 40 }], [], owner.id, {
      primaryMessageSourceKind, liveAssistant: { sessionId: owner.id, threadId: "thread", messageIndex: 41, text: "still generating" },
    });
    const unknownInput = { ...failed, state: "interrupted" as const, reason: "Execution outcome is unknown after interruption.", inputTurnId: "parent", userMessageSeq: null };
    const unknown = projectSessionTurnQueue(liveHistory, [unknownInput], context);
    assert.deepEqual(unknown.projection.messages, liveHistory.messages);
    assert.deepEqual(unknown.tail, [unknownInput]);
    for (const live of [false, true]) {
      const history = buildMessageListProjection([{ role: "user", text: "A", historyIndex: 40 }], [], owner.id, {
        primaryMessageSourceKind,
        ...(live ? { liveAssistant: { sessionId: owner.id, threadId: "thread", withMateTurnId: failed.turnId!, messageIndex: 41, text: "partial" } } : {}),
      });
      const messages = projectSessionTurnQueue(history, [failed], context).projection.messages;
      assert.equal(messages.length, 2);
      assert.equal(messages[1].text, live ? "partial" : "");
      assert.equal(messages[1].runFailure, failed.reason);
      const canonical = buildMessageListProjection([history.messages[0], { role: "assistant", text: "partial", runFailure: failed.reason!, historyIndex: 41 }], [], owner.id, { primaryMessageSourceKind });
      const settled = projectSessionTurnQueue(canonical, [failed], context).projection.messages;
      assert.equal(settled.length, 2);
      assert.equal(settled[1].runFailure, failed.reason);
    }
  }
  const character = { name: "Mate", iconPath: "" };
  const rows = [
    ...(["failed", "interrupted"] as const).map((state) =>
      React.createElement(SessionTurnQueueRow, { receipt: { ...failed, state, userMessageSeq: null }, character, busy: false, onCancel() {} })),
    React.createElement(SessionTurnSubmissionRow, { character, submission: { ...context, requestId: "local", userMessage: "A", historyMessageCount: 0, queuedBehindRun: true, error: failed.reason! } }),
  ];
  for (const row of rows) {
    const document = new JSDOM(renderToStaticMarkup(row)).window.document;
    assert.equal(document.querySelector(".message-row.user")?.textContent, "A");
    assert.equal(document.querySelectorAll(".session-run-failure").length, 1);
    assert.equal(document.querySelector(".message-row.assistant [role=alert]")?.textContent, `Failed${failed.reason}`);
  }
  const unknown = React.createElement(SessionTurnQueueRow, { receipt: { ...failed, state: "interrupted", reason: null, inputTurnId: "parent", userMessageSeq: null }, character, busy: false, onCancel() {} });
  const document = new JSDOM(renderToStaticMarkup(unknown)).window.document;
  assert.equal(document.querySelector(".message-row.assistant [role=alert]")?.textContent, "FailedInput acceptance could not be confirmed.");
  assert.equal(document.querySelectorAll("button").length, 0);
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryのrunning Sendは保存済draftのincarnation/revisionと設定を共通queue受付へ渡し、受付中の後続編集はACK後のdurable版へ保存し、送信時の通知を一度だけ行う"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 送信受付の共通反映 / Composer の更新・保存境界" }
// fault = "Auxiliaryが直接runへ流れる、古いdraft版で受付する、またはACK待ちの新編集を消す・consume前の版へ保存する"
// observable = "enqueue要求、ACK前後のlocal/durable draft、後続保存のdurable revision、送信時UI通知回数"
// observation_boundary = "consumer"
// scope = "auxiliary composer durable queue admission"
// lifecycle = "permanent"
// impact = "Auxiliaryの入力消失と重複実行を防ぎ、実行中でも次turnを受け付ける"
// distinction = "Main受付testとdraft owner単体testではAuxiliaryの共通operationからatomic受付への接続を確認できない"
// @end-test-value
test("Auxiliary running Send consumes only its durable capture and preserves ACK-wait edits", async () => {
  const auxiliaryOwner = { kind: "auxiliary" as const, id: "aux" };
  const incarnation = "2026-10-11T00:00:00Z";
  const draftIncarnation = "730d0664-8452-4d50-9ee9-4b0e4f55c0be";
  let durable = { auxiliarySessionId: "aux", parentSessionId: "session", incarnation: draftIncarnation, durableRevision: 3, text: "A", updatedAt: "" };
  const saves: number[] = [];
  const draftOwner = new AuxiliaryDraftPersistenceOwner({
    load: async () => ({ ...durable }), now: () => "now", debounceMs: 0,
    save: async (record) => {
      saves.push(record.durableRevision);
      assert.equal(record.durableRevision, durable.durableRevision);
      durable = { ...record, durableRevision: record.durableRevision + 1 };
      return { outcome: "saved", record: { ...durable } };
    },
  });
  const registry = new ComposerControllerRegistry(); registry.setDraft(auxiliaryOwner, "A");
  const acceptance = new SessionTurnAcceptance();
  let acknowledge!: (value: SessionTurnQueueReceipt) => void;
  let submitted: typeof request | undefined;
  let submittedCount = 0;
  const accepted = receipt({ sessionId: "aux", incarnationId: incarnation });
  const operation = runMainSessionTurnOperation({
    api: {
      previewComposerInput: async (id, text) => { assert.equal(id, "aux"); assert.equal(text, "A"); return { attachments: [], errors: [] }; },
      enqueueSessionTurn: async (id, input) => {
        assert.equal(id, "aux"); submitted = input as typeof request;
        durable = { ...durable, text: "", durableRevision: 4 };
        return new Promise((resolve) => { acknowledge = resolve; });
      },
      getSessionTurnQueueReceipt: async () => null,
    },
    sessionId: "aux", selectedSession: { ...session(), id: "aux", incarnationId: incarnation },
    request: { ...request, displayAnchorParentMessageCount: 9 },
    composerRegistry: registry, composerOwner: auxiliaryOwner, submitCoordinator: new SessionSubmitCoordinator(),
    acceptance, auxiliaryDraftOwner: draftOwner, queueTurn: true, clearDraft: true, collapseActionDock: false,
    onSubmitted: () => { submittedCount += 1; },
    selectedSessionRunState: "running", blockedReason: null, isReadOnly: false, validateWorkspace: async () => true,
    state: { setComposerPreview: (preview) => registry.setPreview(auxiliaryOwner, preview), onSubmitStateChanged() {}, setForceComposerBlockedFeedback() {}, collapseActionDock() {} }, log() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, { ...request, incarnationId: incarnation, displayAnchorParentMessageCount: 9, auxiliaryDraftIncarnation: draftIncarnation, auxiliaryDraftDurableRevision: 3 });
  assert.equal(registry.get(auxiliaryOwner).draft, "A");
  assert.equal(submittedCount, 1);
  registry.setDraft(auxiliaryOwner, "B");
  const saving = draftOwner.enqueue("B");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(saves, []);
  acknowledge(accepted);
  assert.equal(await operation, accepted);
  assert.equal(submittedCount, 1);
  await saving;
  assert.equal(registry.get(auxiliaryOwner).draft, "B");
  assert.equal(durable.text, "B");
  assert.deepEqual(saves, [4]);
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryの受付不明は対象ownerにだけ保持され、保存gateを解放し、元要求の照会・再試行で新しいdraftを消さない"
// oracle = { type = "contract", ref = "Issue #801: uncertain Aux queue受付は同request identityで明示回復する" }
// fault = "Aux結果不明がMainへ混線する、draft保存をrun終了まで止める、または再試行で別request/新draftを送信する"
// observable = "uncertain owner、再試行request列、durable/local draft"
// observation_boundary = "consumer"
// scope = "auxiliary queue uncertain admission"
// lifecycle = "permanent"
// impact = "結果不明時の入力消失・二重実行と他会話の送信不能を防ぐ"
// distinction = "既存Main unknown testにはAux durable CAS保存gateとowner照合がない"
// @end-test-value
test("Auxiliary uncertainty releases draft saving and retries the original target capture", async () => {
  const auxiliaryOwner = { kind: "auxiliary" as const, id: "aux" };
  let durable = { auxiliarySessionId: "aux", parentSessionId: "session", incarnation: "aux-inc", durableRevision: 3, text: "A", updatedAt: "" };
  const draftOwner = new AuxiliaryDraftPersistenceOwner({
    load: async () => ({ ...durable }), now: () => "now", debounceMs: 0,
    save: async (record) => { durable = { ...record, durableRevision: record.durableRevision + 1 }; return { outcome: "saved", record: { ...durable } }; },
  });
  await draftOwner.ensureLoaded();
  const registry = new ComposerControllerRegistry(); registry.setDraft(auxiliaryOwner, "A");
  const acceptance = new SessionTurnAcceptance();
  const original = { ...request, incarnationId: durable.incarnation, auxiliaryDraftIncarnation: durable.incarnation, auxiliaryDraftDurableRevision: 3 };
  const captured = { request: original, owner: auxiliaryOwner, revision: registry.capture(auxiliaryOwner).revision, clearDraft: true, auxiliaryDraftOwner: draftOwner };
  const sent: unknown[] = [];
  let failed = true;
  const api = {
    enqueueSessionTurn: async (id: string, input: typeof original) => {
      sent.push({ id, input });
      if (failed) throw new Error("disconnected");
      return receipt({ sessionId: "aux", incarnationId: "aux-inc" });
    },
    getSessionTurnQueueReceipt: async () => null,
  };
  await assert.rejects(acceptance.submit(api, "aux", captured, registry), /acceptance could not be confirmed/);
  assert.equal(acceptance.hasUncertain("aux"), true);
  assert.equal(acceptance.hasUncertain(owner.id), false);
  registry.setDraft(auxiliaryOwner, "B");
  await draftOwner.enqueue("B");
  assert.equal(durable.text, "B");
  failed = false;
  await acceptance.retry(api, "aux", registry);
  assert.deepEqual(sent, [{ id: "aux", input: original }, { id: "aux", input: original }]);
  assert.equal(registry.get(auxiliaryOwner).draft, "B");
  assert.equal(acceptance.hasUncertain("aux"), false);
});

// @test-value v2
// kind = "contract"
// claim = "MainのSendはpreview待機前に捕捉した本文・設定・incarnationをdurable受付へ渡し、ACK後に該当draftだけ消し、表示通知は送信時に一度だけ行う"
// oracle = { type = "contract", ref = "Issue #801: Main Send durable admission" }
// fault = "running preflightで予約受付を拒否する、preview後の設定へ置換する、またはdurable受付前にdraftを消す"
// observable = "enqueueへ渡したrequest、ACK前後のdraft、leaseとpending状態、返却receiptと既存Sessionの履歴・Bookmark、送信時UI通知回数"
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
  let submittedCount = 0;
  const operation = runMainSessionTurnOperation({
    api: { previewComposerInput: async () => new Promise((resolve) => { previewDone = resolve; }),
      enqueueSessionTurn: async (_id, input) => { submitted = input; return new Promise((resolve) => { acknowledge = resolve; }); }, getSessionTurnQueueReceipt: async () => null },
    sessionId: owner.id, selectedSession: selected, request, composerRegistry: registry, composerOwner: owner, submitCoordinator: coordinator,
    acceptance: new SessionTurnAcceptance(), queueTurn: true, clearDraft: true, collapseActionDock: false,
    onSubmitted: () => { submittedCount += 1; },
    selectedSessionRunState: "running", blockedReason: null, isReadOnly: false, validateWorkspace: async () => true,
    state: { setComposerPreview: (preview) => registry.setPreview(owner, preview), onSubmitStateChanged: () => { pending = coordinator.isClaimed(owner.id) ? owner.id : null; }, setForceComposerBlockedFeedback() {}, collapseActionDock() {} }, log() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  selected.model = "changed-after-send";
  previewDone({ attachments: [], errors: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, request);
  assert.equal(registry.get(owner).draft, "A");
  assert.equal(pending, owner.id);
  assert.equal(submittedCount, 1);
  const accepted = receipt(); acknowledge(accepted); assert.equal(await operation, accepted);
  assert.equal(submittedCount, 1);
  assert.equal(registry.get(owner).draft, "");
  assert.equal(pending, null);
  assert.equal(coordinator.isClaimed(owner.id), false);
  assert.deepEqual(selected.messages, [{ role: "user", text: "before", isBookmarked: true }]);
  assert.equal(selected.messageCount, 1);
});

// @test-value v2
// kind = "contract"
// claim = "Sendは非同期準備前に送信情報を登録し、設定に従うDock折りたたみと末尾追従を一度だけ通知する。拒否・受付不明時は下書きとエラーを保持し、回復後もDockや追従の操作を繰り返さない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Session Window / Scroll To Latest On Send; docs/design/session-run-lifecycle.md: Position / 新Turn送信と受付結果の照合" }
// fault = "非同期準備の完了まで送信時のDockや末尾追従を遅らせる、拒否・受付不明のエラーを保持しない、または受付再照会でDockや追従の操作を繰り返す"
// observable = "非同期準備前の送信store登録・Dock折りたたみ・末尾追従callback、拒否・受付不明のstore error、復旧後のreceiptとdraft"
// observation_boundary = "consumer"
// scope = "send handoff and receipt recovery"
// lifecycle = "permanent"
// impact = "通信や準備の速度でDockや追従が遅れたり、失敗時に送信文を見失ったり、復旧時に読み返し位置を奪ったりする"
// distinction = "型検査や受付class単体はworkspace/preview待ちと送信時UI callbackの境界を通らない。小さいdeferred Promiseで継続契約を確認する"
// @end-test-value
test("send notifies Dock and follow before asynchronous preparation and does not repeat them in recovery", async () => {
  for (const outcome of ["accepted", "rejected", "unknown", "check", "retry"] as const) {
    for (const autoCollapse of [false, true]) {
      const registry = new ComposerControllerRegistry(); registry.setDraft(owner, "A");
      const acceptance = new SessionTurnAcceptance();
      const events: string[] = [];
      acceptance.submissions.subscribe(() => { if (!events.length) events.push("surface"); });
      let validate!: (value: boolean) => void;
      let preview!: (value: { attachments: []; errors: [] }) => void;
      let acknowledge!: () => void;
      let recover = false;
      const api = {
        previewComposerInput: async () => new Promise<{ attachments: []; errors: [] }>((resolve) => { preview = resolve; }),
        enqueueSessionTurn: async () => {
          if (!recover) await new Promise<void>((resolve) => { acknowledge = resolve; });
          if (outcome === "rejected") return { state: "rejected" as const, reason: "Workspace is unavailable." };
          if (outcome !== "accepted" && !recover) throw new Error("disconnected");
          return receipt();
        },
        getSessionTurnQueueReceipt: async () => recover ? receipt() : null,
      };
      const operation = runMainSessionTurnOperation({
        api, sessionId: owner.id, selectedSession: session(), request,
        composerRegistry: registry, composerOwner: owner, submitCoordinator: new SessionSubmitCoordinator(), acceptance,
        queueTurn: true, clearDraft: true, collapseActionDock: autoCollapse,
        selectedSessionRunState: "idle", blockedReason: null, isReadOnly: false,
        validateWorkspace: () => new Promise<boolean>((resolve) => { validate = resolve; }),
        state: { setComposerPreview() {}, onSubmitStateChanged() {}, setForceComposerBlockedFeedback() {}, collapseActionDock: () => { events.push("collapse"); } },
        onSubmitted: () => { events.push("follow"); }, log() {},
      });
      const expected = autoCollapse ? ["surface", "collapse", "follow"] : ["surface", "follow"];
      assert.deepEqual(events, expected);
      assert.equal(acceptance.submissions.getSnapshot()[0]?.userMessage, "A");
      assert.equal(acceptance.submissions.getSnapshot()[0]?.error, "");
      assert.equal(registry.get(owner).draft, "A");
      validate(true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(events, expected);
      preview({ attachments: [], errors: [] });
      await new Promise((resolve) => setImmediate(resolve));
      acknowledge();
      if (outcome === "accepted") await operation;
      else {
        await assert.rejects(operation, outcome === "rejected" ? /Workspace is unavailable/ : /acceptance could not be confirmed/);
        assert.equal(registry.get(owner).draft, "A");
        assert.match(acceptance.submissions.getSnapshot()[0]!.error, outcome === "rejected" ? /Workspace is unavailable/ : /acceptance could not be confirmed/);
        if (outcome === "check" || outcome === "retry") {
          recover = true;
          if (outcome === "check") await Promise.all([acceptance.check(api, owner.id, registry), acceptance.check(api, owner.id, registry)]);
          else await acceptance.retry(api, owner.id, registry);
        }
      }
      await acceptance.check(api, owner.id, registry);
      assert.deepEqual(events, expected);
      if (outcome === "accepted" || outcome === "check" || outcome === "retry") {
        assert.equal(acceptance.submissions.getSnapshot()[0]?.receipt?.requestId, request.clientRequestId);
        assert.equal(acceptance.submissions.getSnapshot()[0]?.error, "");
        assert.equal(registry.get(owner).draft, "");
      }
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "準備失敗時は編集・対象変更・freezeで失効した未受付表示だけ取り消し、有効な準備失敗とenqueue後の受付結果不明は捕捉本文とerrorを保持する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#送信受付の共通反映: 未受付capture失効・受付結果不明の契約" }
// fault = "失効後のpreview rejectを送信errorとして残す、またはenqueue後のcapture失効を未受付と誤認して結果不明の送信表示を消す"
// observable = "operationの返却/例外、submission本文・error・uncertain、受付registry、draft、enqueue回数、pending状態と送信lease"
// observation_boundary = "consumer"
// scope = "composer capture invalidation across preparation and queue acceptance"
// lifecycle = "permanent"
// impact = "未送信の古いpromptを送信失敗と誤表示せず、受付結果不明の要求を見失わずに新draftを保持する"
// distinction = "既存workspace世代失効testはresolve経路のみ、受付単体testはoperationのcatchを通らない。deferred失敗で受付段階とcaptureの3失効条件を直接検証する"
// @end-test-value
test("failed preparation cancels only invalidated unaccepted captures", async () => {
  for (const stage of ["preview", "enqueue"] as const) {
    for (const invalidation of ["none", "edit", "target", "freeze"] as const) {
      const registry = new ComposerControllerRegistry(); registry.setDraft(owner, "A");
      const acceptance = new SessionTurnAcceptance();
      const coordinator = new SessionSubmitCoordinator();
      let fail!: (error: Error) => void;
      const delayedFailure = () => new Promise<never>((_resolve, reject) => { fail = reject; });
      let currentTarget = true;
      let enqueueCount = 0;
      let pending: string | null = null;
      const operation = runMainSessionTurnOperation({
        api: {
          previewComposerInput: async () => stage === "preview" ? delayedFailure() : { attachments: [], errors: [] },
          enqueueSessionTurn: async () => { enqueueCount += 1; return delayedFailure(); },
          getSessionTurnQueueReceipt: async () => null,
        },
        sessionId: owner.id, selectedSession: session(), request, composerRegistry: registry, composerOwner: owner,
        submitCoordinator: coordinator, acceptance, clearDraft: true, collapseActionDock: false,
        selectedSessionRunState: "idle", blockedReason: null, isReadOnly: false,
        isCurrentSubmission: () => currentTarget, validateWorkspace: async () => true,
        state: {
          setComposerPreview() {},
          onSubmitStateChanged: () => { pending = coordinator.isClaimed(owner.id) ? owner.id : null; },
          setForceComposerBlockedFeedback() {}, collapseActionDock() {},
        }, log() {},
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(acceptance.submissions.getSnapshot()[0]?.userMessage, "A");
      assert.equal(pending, owner.id);
      if (invalidation === "edit") registry.setDraft(owner, "B");
      if (invalidation === "target") currentTarget = false;
      if (invalidation === "freeze") registry.freeze();
      const cancelled = stage === "preview" && invalidation !== "none";
      const error = stage === "preview" ? /late preview failure/ : /acceptance could not be confirmed/;
      const result = cancelled ? operation : assert.rejects(operation, error);
      fail(new Error(`late ${stage} failure`));
      if (cancelled) assert.equal(await result, null);
      else await result;
      const submissions = acceptance.submissions.getSnapshot();
      if (cancelled) assert.deepEqual(submissions, []);
      else {
        assert.equal(submissions.length, 1);
        assert.equal(submissions[0].userMessage, "A");
        assert.match(submissions[0].error, error);
        assert.equal(submissions[0].uncertain, stage === "enqueue");
      }
      assert.equal(acceptance.hasUncertain(owner.id), stage === "enqueue");
      assert.equal(enqueueCount, stage === "enqueue" ? 1 : 0);
      assert.equal(registry.get(owner).draft, invalidation === "edit" ? "B" : "A");
      assert.equal(pending, null);
      assert.equal(coordinator.isClaimed(owner.id), false);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "workspace検証中にMain送信の対象が失効した場合は未受付の捕捉だけ取り消し、共有workspaceの後続検証が成功したら障害と扱わない。対象が有効な実検証失敗は入力を残してエラーを通知する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 送信受付の共通反映 / 準備中の捕捉失効; docs/design/ui-design-guidelines.md: 読込・空・失敗" }
// fault = "共有workspace検証の旧世代falseを対象失効より先にerror化し、正常な取り消しへ障害表示を残す、または有効な送信の実workspace障害を隠す"
// observable = "実workspace hookと送信operationの返却結果、submission store、workspace状態、draft、enqueue/preview件数と送信lease"
// observation_boundary = "consumer"
// scope = "shared workspace validation and invalidated submission capture"
// lifecycle = "permanent"
// impact = "対象切替で不要なWorkspace障害が残ることと、実際の送信不能を通知しないことを防ぎ、未受付の入力を保持する"
// distinction = "workspace状態のpure testやoperationのboolean mockでは、正常なAPI結果が共有hookで世代失効falseへ変わる境界を通らない"
// @end-test-value
test("workspace validation distinguishes invalidated submissions from real failures", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    for (const scenario of ["superseded", "unavailable"] as const) {
      const parent = session();
      let deferValidation = false;
      const resolutions: ((result: WorkspaceDirectoryValidationResult) => void)[] = [];
      const api = { validateSessionWorkspace: async (id: string) => {
        assert.equal(id, parent.id);
        if (!deferValidation) return { valid: true };
        return new Promise<WorkspaceDirectoryValidationResult>((resolve) => resolutions.push(resolve));
      } } as WithMateWindowApi;
      let current: ReturnType<typeof useSessionWorkspaceAvailability> | undefined;
      function View() { current = useSessionWorkspaceAvailability(api, parent); return null; }
      const workspace = () => { assert.ok(current); return current; };
      await act(async () => { root.render(React.createElement(View, { key: scenario })); });
      assert.equal(workspace().workspaceAvailability.status, "available");
      deferValidation = true;
      const registry = new ComposerControllerRegistry(); registry.setDraft(owner, "A");
      const acceptance = new SessionTurnAcceptance();
      const coordinator = new SessionSubmitCoordinator();
      let target = owner.id;
      let previewCount = 0;
      let enqueueCount = 0;
      const operation = runMainSessionTurnOperation({
        api: { previewComposerInput: async () => { previewCount += 1; return { attachments: [], errors: [] }; },
          enqueueSessionTurn: async () => { enqueueCount += 1; return receipt(); }, getSessionTurnQueueReceipt: async () => null },
        sessionId: owner.id, selectedSession: parent, request, composerRegistry: registry, composerOwner: owner,
        submitCoordinator: coordinator, acceptance, clearDraft: true, collapseActionDock: false,
        selectedSessionRunState: "idle", blockedReason: null, isReadOnly: false,
        isCurrentSubmission: () => target === owner.id,
        validateWorkspace: () => workspace().validateSessionWorkspace(parent, true),
        state: { setComposerPreview() {}, onSubmitStateChanged() {}, setForceComposerBlockedFeedback() {}, collapseActionDock() {} }, log() {},
      });
      assert.equal(acceptance.submissions.getSnapshot()[0]?.error, "");
      assert.equal(resolutions.length, 1);
      if (scenario === "superseded") {
        target = "aux";
        const auxiliaryValidation = workspace().validateSessionWorkspace(parent, true);
        assert.equal(resolutions.length, 2);
        await act(async () => {
          resolutions[0]({ valid: true });
          resolutions[1]({ valid: true });
          assert.equal(await operation, null);
          assert.equal(await auxiliaryValidation, true);
        });
        assert.deepEqual(acceptance.submissions.getSnapshot(), []);
        assert.equal(workspace().workspaceAvailability.status, "available");
      } else {
        await act(async () => {
          const rejected = assert.rejects(operation, /Workspace is not available/);
          resolutions[0]({ valid: false, reason: "unavailable" });
          await rejected;
        });
        assert.match(acceptance.submissions.getSnapshot()[0]!.error, /Workspace is not available/);
        assert.equal(workspace().workspaceAvailability.status, "unavailable");
      }
      assert.equal(registry.get(owner).draft, "A");
      assert.equal(previewCount, 0);
      assert.equal(enqueueCount, 0);
      assert.equal(coordinator.isClaimed(owner.id), false);
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
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
// claim = "確定未受付の応答はdraftを保持して理由を返す。受付不明から元要求を再試行した拒否は、元receipt不在も確認できたときにのみunknownを解除する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window: 受付応答・自動照会・回復" }
// fault = "rejectedをACK扱いしてdraftを消す、通常拒否を受付不明にする、照会できない再試行拒否で未知の元要求を破棄する"
// observable = "拒否理由、draft、unknown状態、lookup回数と元要求の送信回数"
// observation_boundary = "consumer"
// scope = "queue-known-rejection"
// lifecycle = "permanent"
// impact = "未受付の入力消失と再送信不能を防ぐ"
// distinction = "RPC throwの結果不明testとは別の、Mainが未mutationを保証した応答を検証する"
// @end-test-value
test("known rejection preserves draft and retry settles only when the prior receipt can be checked", async () => {
  for (const outcome of ["initial-rejection", "retry-rejection", "retry-lookup-failure", "retry-conflicting-receipt"] as const) {
    const registry = new ComposerControllerRegistry(); registry.setDraft(owner, "A");
    const acceptance = new SessionTurnAcceptance();
    let lookupCount = 0; let sendCount = 0;
    const retry = outcome !== "initial-rejection";
    const api = {
      enqueueSessionTurn: async () => { ++sendCount; if (retry && sendCount === 1) throw new Error("disconnected"); return { state: "rejected" as const, reason: "Workspace is unavailable." }; },
      getSessionTurnQueueReceipt: async () => {
        ++lookupCount;
        if (lookupCount > 1 && outcome === "retry-lookup-failure") throw new Error("lookup unavailable");
        if (lookupCount > 1 && outcome === "retry-conflicting-receipt") {
          const conflicting = receipt().captured;
          return receipt({ accepted: { ...conflicting, request: { ...conflicting.request, userMessage: "another request" } } });
        }
        return null;
      },
    };
    const captured = { request, owner, revision: registry.capture(owner).revision, clearDraft: true };
    if (retry) await assert.rejects(acceptance.submit(api, owner.id, captured, registry), /acceptance could not be confirmed/);
    const previousLookups = lookupCount;
    const error = outcome === "retry-lookup-failure" ? /lookup unavailable/ : outcome === "retry-conflicting-receipt" ? /does not match/ : /Workspace is unavailable/;
    await assert.rejects(retry ? acceptance.retry(api, owner.id, registry) : acceptance.submit(api, owner.id, captured, registry), error);
    assert.equal(lookupCount, previousLookups + (retry ? 1 : 0));
    assert.equal(sendCount, retry ? 2 : 1);
    assert.equal(registry.get(owner).draft, "A");
    assert.equal(acceptance.hasUncertain(owner.id), outcome === "retry-lookup-failure" || outcome === "retry-conflicting-receipt");
  }
});

// @test-value v2
// kind = "contract"
// claim = "Main/Auxiliaryの同文queue turnは対象ownerと保存seqとincarnationで接続し、terminal先着でもcanonical user到着まで本文と同じ表示keyを保持し、queued tailは受付順に並ぶ"
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
  for (const primaryMessageSourceKind of ["session", "auxiliary"] as const) {
    const history = buildMessageListProjection([{ role: "user", text: "A", historyIndex: 40 }], [], owner.id,
      { primaryMessageSourceKind, liveAssistant: { sessionId: owner.id, threadId: "thread", messageIndex: 41, text: "live" } });
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
    const canonical = buildMessageListProjection([{ role: "user", text: "A", historyIndex: 40 }, { role: "user", text: "A", historyIndex: 42 }], [], owner.id, { primaryMessageSourceKind });
    const connected = projectSessionTurnQueue(canonical, [started, queued], context);
    assert.equal(connected.projection.messages.length, 2);
    assert.equal(connected.metadata.get(connected.projection.keys[1])?.id, started.id);
    assert.equal(connected.projection.keys[1], projected.projection.keys[1], "the accepted prompt keeps its key at the canonical handoff");
    if (primaryMessageSourceKind === "auxiliary") {
      const otherOwner = buildMessageListProjection([{ role: "user", text: "A", historyIndex: 42 }], [], "other-aux", { primaryMessageSourceKind });
      assert.equal(projectSessionTurnQueue(otherOwner, [started], context).projection.sources[1].kind, "turn-queue");
    }
    const paged = projectSessionTurnQueue(buildMessageListProjection([{ role: "user", text: "later", historyIndex: 100 }], [], owner.id, { primaryMessageSourceKind }), [{ ...started, state: "completed" }], context);
    assert.equal(paged.projection.messages.length, 1);
  }
});
