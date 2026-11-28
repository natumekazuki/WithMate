import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { SessionTurnQueueRow } from "../../src/chat/conversation/session-turn-queue-row.js";
import { SessionMessageColumn } from "../../src/chat/conversation/session-message-column.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { SessionTurnQueueStorageV6 } from "../../src-electron/session/session-turn-queue-storage-v6.js";
import { SessionExecutionReadStorage } from "../../src-electron/storage/session-execution-read.js";
import type { ComposerAttachment } from "../../src-shared/session/runtime-state.js";
import { executionWindowResultSchemas, type ExecutionReadInput } from "../../src-shared/session/session-execution-read.js";
import type { SessionTurnQueueCapturedInput, SessionTurnQueueOrigin, SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";

const target = { kind: "main" as const, sessionId: "owner", incarnationId: "owner-v1" };
const origin: SessionTurnQueueOrigin = { kind: "gui", operation: "send", targetSessionId: target.sessionId, targetIncarnationId: target.incarnationId };
const original: SessionTurnQueueOrigin = { ...origin, kind: "session", actorKind: "main", actorSessionId: "sender", actorIncarnationId: "sender-v1", actorTurnId: "12",
  actorSnapshot: { sessionTitle: "Sender Workspace", character: { id: "sender", name: "Original Agent", iconPath: "" } },
  targetSnapshot: { sessionTitle: "Owner Workspace", character: { id: "owner", name: "Owner", iconPath: "" } } };
const character = { id: "owner", name: "Owner", iconPath: "", description: "", roleMarkdown: "", notesMarkdown: "", updatedAt: "", themeColors: { main: "#112233", sub: "#445566" } };
const settings = captureSessionExecutionOptions(buildNewSession({ id: "owner", taskTitle: "Fixture", workspacePath: "C:/fixture", workspaceLabel: "Fixture",
  branch: "main", characterId: character.id, character: character.name, characterIconPath: "", characterThemeColors: character.themeColors, approvalMode: "on-request" }));

// @test-value v2
// kind = "contract"
// claim = "再実行のカードは由来の説明文を足さず、未編集の場合だけ元話者を示す。待機グループ名と旧中断の理由を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action DockのResend; docs/design/session-run-lifecycle.md#gui-turn-queue; docs/design/session-history.md: Main列の初期枠・子Session枠" }
// fault = "GUI起点を常に話者とみなす、編集済み再送を元Sessionの原文に見せる、または由来の説明文をカード・読み上げ・tooltipに足す"
// observable = "予約カードの本文・元話者名・リンク、説明文の不在、元の待機グループ名と旧中断理由"
// observation_boundary = "component-behavior"
// scope = "未編集／本文編集した同一の再送予約と旧interruptedカード。providerとIPCは使わない"
// lifecycle = "permanent"
// impact = "相手から新規の依頼が来たか、利用者が編集した再実行かを取り違える"
// distinction = "SQLiteが来歴を分けて保存しても実際にどの話者をカードへ出すかは決まらない"
// @end-test-value
test("Retry queue cards distinguish a replay from a user edit", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const accepted: SessionTurnQueueCapturedInput = { origin, provider: "codex", workspacePath: "C:/fixture", attachments: [],
    retrySource: { receiptId: "original", turnId: "13", origin: original, changedSinceAcceptance: false },
    request: { userMessage: "Original content", clientRequestId: "request", submitSource: "retry", executionOptions: settings } };
  const receipt: SessionTurnQueueReceipt = { id: "retry", requestId: "request", sessionId: target.sessionId, incarnationId: target.incarnationId, state: "queued",
    captured: accepted, accepted, dispatched: null, turnId: null, userMessageSeq: null, inputTurnId: null, reason: null, releasedAt: null,
    queuePosition: 1, sequence: 1, createdAt: "now", updatedAt: "now" };
  const renderQueue = (next: SessionTurnQueueReceipt) => root.render(<SessionTurnQueueRow receipt={next} character={character} busy={false} onCancel={() => {}} />);
  const article = () => dom.window.document.querySelector("article")!;
  const assertNoRetryCaption = () => {
    assert.doesNotMatch(article().textContent!, /Retry requested by you|Previous input from/);
    assert.equal(article().getAttribute("aria-label"), null);
    assert.equal(article().getAttribute("title"), null);
    assert.equal(article().querySelector("[data-queue-receipt-id]")?.getAttribute("title") ?? null, null);
  };
  try {
    await act(async () => renderQueue(receipt));
    assert.equal(article().querySelector(".message-character-name")?.textContent, "Original Agent");
    assert.ok(article().querySelector('button[aria-label="Open Sender: Sender Workspace"]'));
    assert.match(article().textContent!, /Original content/);
    assertNoRetryCaption();
    assert.ok(article().querySelector('[role="group"][aria-label="Queued turn"] button[aria-label="Cancel queued turn"]'));

    const changed = { ...accepted, request: { ...accepted.request, userMessage: "User edited content" } };
    await act(async () => renderQueue({ ...receipt, captured: changed, updatedAt: "edited" }));
    assert.ok(article().classList.contains("user"));
    assert.equal(article().querySelector('button[aria-label="Open Sender: Sender Workspace"]'), null);
    assert.equal(article().querySelector(".message-character-name"), null);
    assert.match(article().textContent!, /User edited content/);
    assert.doesNotMatch(article().textContent!, /Original content/);
    assertNoRetryCaption();

    await act(async () => renderQueue({ ...receipt, state: "interrupted", reason: "Saved outcome unknown" }));
    assertNoRetryCaption();
    assert.match(dom.window.document.body.textContent ?? "", /Saved outcome unknown/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of prior) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

// @test-value v2
// kind = "contract"
// claim = "照合できる未編集Retryは待機、実行中、保存済みで元話者・宛先・色を保つ。添付変更と比較不能は保存後も区別し、元発信元と現行Sessionの世代が異なれば保存来歴だけを表示する。受付主体と由来説明は変えない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action DockのResend; docs/design/session-history.md: Main列の初期枠・子Session枠" }
// fault = "GUI受付を色の発信元にする、実行から保存への再取得で同じ入力の色を失う、本文だけで部分的な一致を確認扱いする、元入力が編集済みでも今回trueだけで元話者に見せる"
// observable = "SQLiteの軽量読取のGUI origin、true/false/nullと元来歴、実カードの名前・From・宛先・色・本文、同じseqの再取得中の色、表示読取件数と自動Details読取の有無"
// observation_boundary = "component-behavior"
// scope = "分離SQLiteの再送受付から、本番待機カード・会話列をrunning、保存、再openで描画。IPCは同じ保存readerへのfixture接続"
// lifecycle = "permanent"
// impact = "添付を差し替えた方向付けや比較できない本文を、以前の相手から届いた原文と誤認する"
// distinction = "待機カードtestは保存された三値との接続を通らず、履歴reader単体では話者の見え方を確認しない"
// @end-test-value
test("Retry cards preserve the original sender route and theme only for an exact replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-retry-author-"));
  const database = join(directory, "fixture.db");
  const sessions = new SessionStorageV6(database);
  const queue = new SessionTurnQueueStorageV6(database);
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true, url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperties(dom.window.HTMLElement.prototype, { offsetHeight: { get: () => 720 }, offsetWidth: { get: () => 800 }, clientHeight: { get: () => 720 } });
  const container = dom.window.document.getElementById("root")!;
  const attachment = (id: string): ComposerAttachment => ({ id, kind: "file", source: "text", absolutePath: join(directory, id),
    displayPath: id, workspaceRelativePath: id, isOutsideWorkspace: false });
  const content = "Content unchanged across retries";
  try {
    const owner = sessions.insertSession(buildNewSession({ id: target.sessionId, taskTitle: "Owner",
      workspacePath: directory, workspaceLabel: "Fixture", branch: "main", characterId: character.id,
      character: character.name, characterIconPath: "", characterThemeColors: character.themeColors, approvalMode: "on-request" }));
    const savedTarget = { ...target, incarnationId: getSessionIncarnationId(owner) };
    const savedOrigin = { ...origin, targetIncarnationId: savedTarget.incarnationId };
    const senderColors = { main: "#e07299", sub: "#9bcdda" };
    const sender = sessions.insertSession(buildNewSession({ id: "sender", taskTitle: "Sender Workspace",
      workspacePath: directory, workspaceLabel: "Fixture", branch: "main", characterId: "sender",
      character: "Original Agent", characterIconPath: "", characterThemeColors: senderColors, approvalMode: "on-request" }));
    const savedOriginal = { ...original, actorIncarnationId: sender.incarnationId, targetIncarnationId: savedTarget.incarnationId };
    const executionOptions = captureSessionExecutionOptions(owner);
    let seq = 0;
    const enqueue = (inputOrigin: SessionTurnQueueOrigin, retrySource?: SessionTurnQueueCapturedInput["retrySource"], attachments = [attachment("original.txt")]) =>
      queue.enqueue(savedTarget, { origin: inputOrigin, retrySource, provider: owner.provider, workspacePath: directory,
        attachments, request: { userMessage: content, clientRequestId: randomUUID(),
          submitSource: retrySource ? "retry" : "composer", executionOptions } });
    const start = (input: SessionTurnQueueReceipt) => {
      const claimed = queue.claimNext(savedTarget);
      assert.equal(claimed?.id, input.id);
      assert.ok(claimed?.dispatched);
      const running = sessions.appendRunningTurnStart({ ...savedTarget, expectedMessageCount: seq, updatedAt: "start",
        userMessage: { role: "user", text: claimed.dispatched.request.userMessage },
        queuedTurn: { queueId: input.id, turn: { sessionId: target.sessionId, phase: "running", userMessageSeq: seq,
          provider: owner.provider, model: executionOptions.model, reasoningEffort: executionOptions.reasoningEffort,
          sandboxMode: executionOptions.codexSandboxMode, approvalMode: executionOptions.approvalMode, threadId: "", createdAt: "start", errorMessage: "" } } });
      assert.ok(running.queuedTurn);
      return running.queuedTurn.id;
    };
    const finish = (input: SessionTurnQueueReceipt, id: number, phase: "failed" | "completed") => {
      sessions.appendSessionTerminal({ ...savedTarget, expectedMessageCount: seq + 1, assistantMessage: { role: "assistant", text: phase },
        metadata: { status: "saved", runState: "idle", threadId: "", updatedAt: "finish" },
        terminalCommit: { turnId: id, sessionId: target.sessionId, phase, assistantMessageSeq: seq + 1,
          threadId: "", errorMessage: "", completedAt: "finish" } });
      const saved = { receiptId: input.id, turnId: String(id), seq };
      seq += 2;
      return saved;
    };
    const save = (inputOrigin: SessionTurnQueueOrigin, phase: "failed" | "completed", retrySource?: SessionTurnQueueCapturedInput["retrySource"],
      replaceAttachment = false, attachments = [attachment("original.txt")]) => {
      const input = enqueue(inputOrigin, retrySource, attachments);
      if (replaceAttachment) queue.updateQueued(savedTarget, input.id, { userMessage: content, attachments: [attachment("replacement.txt")] });
      return finish(input, start(input), phase);
    };
    const source = save(savedOriginal, "failed");
    const retrySource = { receiptId: source.receiptId, turnId: source.turnId, origin: savedOriginal, changedSinceAcceptance: false };
    const queueEntry = enqueue(savedOrigin, retrySource);
    const assertOriginalAppearance = () => {
      const senderCard = container.querySelector<HTMLElement>(".message-card.session-origin.has-sender-theme");
      assert.ok(senderCard, "the exact replay must use the original sender's themed card");
      assert.equal(senderCard.style.getPropertyValue("--sender-main"), senderColors.main);
      assert.equal(container.querySelector(".message-character-name")?.textContent, "Original Agent");
      assert.equal(senderCard.querySelector(".session-message-mention")?.textContent, "@Owner");
      assert.ok(senderCard.querySelector('button[aria-label="Open Sender: Sender Workspace"]'));
    };
    const readContext = { target: savedTarget, ownerSessionId: target.sessionId };
    const stageRoot = createRoot(container);
    const stageReader = new SessionExecutionReadStorage(database);
    let holdSavedRead = false;
    let resumeSavedRead: (() => void) | undefined;
    Object.defineProperty(dom.window, "withmate", { configurable: true, value: { openSession: async () => {},
      readSessionExecution: async (_owner: string, operation: ExecutionReadInput["operation"], request: ExecutionReadInput["request"]) => {
        if (operation !== "read_turn_input_display") return { ok: true, items: [], nextCursor: null };
        if (holdSavedRead && "messageSeq" in request) await new Promise<void>((resolve) => { resumeSavedRead = resolve; });
        const result = executionWindowResultSchemas.read_turn_input_display.parse(stageReader.execute({ target: savedTarget, operation, request }));
        assert.equal(result.origin?.kind, "gui");
        assert.equal(result.retryInputUnchanged, true);
        assert.deepEqual(result.retrySource, retrySource);
        assert.deepEqual(result.senderTheme, senderColors);
        return result;
      },
    } });
    const noop = () => {};
    const liveOrSaved = (receipt?: SessionTurnQueueReceipt) => <SessionMessageColumn sessionId={target.sessionId} character={character}
      inputReadContext={readContext} messages={[{ role: "user", text: content, historyIndex: seqOfRetry }]} messageKeys={["resolved-retry"]}
      turnQueueMetadata={receipt ? new Map([["resolved-retry", receipt]]) : undefined}
      messageListRef={createRef()} expandedArtifacts={{}} isRunning={!!receipt}
      liveApprovalRequest={null} approvalActionRequestId={null} liveElicitationRequest={null} elicitationActionRequestId={null}
      liveRunAssistantText="" hasLiveRunAssistantText={false} liveRunErrorMessage="" isMessageListFollowing
      onMessageListScroll={noop} onToggleArtifact={noop} onOpenDiff={noop} onResolveLiveApproval={noop} onResolveLiveElicitation={noop} />;
    const seqOfRetry = seq;
    let unchanged: ReturnType<typeof finish>;
    try {
      await act(async () => stageRoot.render(<SessionTurnQueueRow receipt={queueEntry} character={character} inputReadContext={readContext} busy={false} onCancel={noop} />));
      assertOriginalAppearance();
      const id = start(queueEntry);
      const active = queue.getReceiptById(savedTarget, queueEntry.id);
      assert.equal(active?.state, "running");
      await act(async () => stageRoot.render(liveOrSaved(active!)));
      assertOriginalAppearance();
      unchanged = finish(queueEntry, id, "completed");
      holdSavedRead = true;
      await act(async () => stageRoot.render(liveOrSaved()));
      assert.ok(resumeSavedRead, "the exact saved message is now being read");
      assertOriginalAppearance();
      await act(async () => resumeSavedRead?.());
      assertOriginalAppearance();
    } finally {
      await act(async () => stageRoot.unmount());
      stageReader.close();
    }
    const changed = save(savedOrigin, "completed", retrySource, true);
    const unknown = save(savedOrigin, "completed", retrySource);
    const editedSource = save(savedOriginal, "failed", undefined, true);
    const editedRetrySource = { ...retrySource, receiptId: editedSource.receiptId, turnId: editedSource.turnId, changedSinceAcceptance: true };
    const retryOfEditedSource = save(savedOrigin, "completed", editedRetrySource, false, [attachment("replacement.txt")]);
    const staleOriginal = { ...savedOriginal, actorIncarnationId: "old-sender-incarnation" };
    const staleSource = save(staleOriginal, "failed");
    const staleRetrySource = { ...retrySource, receiptId: staleSource.receiptId, turnId: staleSource.turnId, origin: staleOriginal };
    const stale = save(savedOrigin, "completed", staleRetrySource);
    // 以前に保存された実行には、固定スナップショットだけがあり、比較元が残っていない場合がある。
    const fixture = new DatabaseSync(database);
    try { fixture.prepare("UPDATE session_turn_queue_v6 SET accepted_json=NULL WHERE id=?").run(unknown.receiptId); }
    finally { fixture.close(); }
    const checks = [[unchanged.seq, true], [changed.seq, false], [unknown.seq, null], [retryOfEditedSource.seq, true], [stale.seq, true]] as const;
    for (const round of ["saved", "reopened"]) {
      const reader = new SessionExecutionReadStorage(database);
      const history = round === "saved" ? sessions : new SessionStorageV6(database);
      const root = createRoot(container);
      const displayReads = new Map<number, boolean | null>();
      const operations: string[] = [];
      Object.defineProperty(dom.window, "withmate", { configurable: true, value: { openSession: async () => {},
        readSessionExecution: async (_owner: string, operation: ExecutionReadInput["operation"], request: ExecutionReadInput["request"]) => {
          operations.push(operation);
          if (operation !== "read_turn_input_display") return { ok: true, items: [], nextCursor: null };
          const result = executionWindowResultSchemas.read_turn_input_display.parse(reader.execute({ target: savedTarget, operation, request }));
          const messageSeq = "messageSeq" in request ? request.messageSeq : undefined;
          assert.ok(typeof messageSeq === "number");
          assert.equal(result.origin?.kind, "gui");
          assert.deepEqual(result.retrySource, messageSeq === retryOfEditedSource.seq ? editedRetrySource : messageSeq === stale.seq ? staleRetrySource : retrySource);
          assert.deepEqual(result.senderTheme, messageSeq === unchanged.seq ? senderColors : null);
          displayReads.set(messageSeq, result.retryInputUnchanged);
          return result;
        },
      } });
      try {
        const messages = history.getConversationPage(target.sessionId)!.messages
          .filter(({ historyIndex }) => checks.some(([messageSeq]) => messageSeq === historyIndex));
        assert.deepEqual(messages.map(({ text }) => text), checks.map(() => content));
        const noop = () => {};
        await act(async () => root.render(<SessionMessageColumn sessionId={target.sessionId} character={character}
          inputReadContext={{ target: savedTarget, ownerSessionId: target.sessionId }} messages={messages} messageListRef={createRef()}
          expandedArtifacts={{}} isRunning={false} liveApprovalRequest={null} approvalActionRequestId={null}
          liveElicitationRequest={null} elicitationActionRequestId={null} liveRunAssistantText="" hasLiveRunAssistantText={false}
          liveRunErrorMessage="" isMessageListFollowing onMessageListScroll={noop} onToggleArtifact={noop} onOpenDiff={noop}
          onResolveLiveApproval={noop} onResolveLiveElicitation={noop} />));
        assert.deepEqual(displayReads, new Map(checks));
        assert.equal(operations.filter((operation) => operation === "read_turn_input_display").length, checks.length);
        assert.equal(operations.includes("get_execution"), false, "the rendered card must not read full Details");
        const cards = [...container.querySelectorAll("article")];
        assert.equal(cards.length, checks.length);
        assert.deepEqual(cards.map((card) => [...card.querySelectorAll(".message-character-name")].map((node) => node.textContent)),
          [["Original Agent"], [], [], [], ["Original Agent"]]);
        for (const card of cards) {
          assert.doesNotMatch(card.textContent!, /Retry requested by you|Previous input from|Edited before this Turn started/);
          assert.equal(card.getAttribute("aria-label"), null);
          assert.equal(card.getAttribute("title"), null);
        }
        assert.deepEqual(cards.map((card) => Boolean(card.querySelector('button[aria-label="Open Sender: Sender Workspace"]'))), [true, false, false, false, true]);
        assert.equal(cards.at(-1)?.querySelector(".session-message-mention")?.textContent, "@Owner");
        assertOriginalAppearance();
        assert.equal(container.querySelectorAll(".has-sender-theme").length, 1);
        assert.deepEqual(cards.map((card) => card.querySelector("[data-message-body]")?.textContent), checks.map(() => content));
      } finally {
        await act(async () => root.unmount());
        reader.close();
        if (history !== sessions) history.close();
      }
    }
  } finally {
    dom.window.close();
    for (const [key, descriptor] of prior) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    queue.close();
    sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});
