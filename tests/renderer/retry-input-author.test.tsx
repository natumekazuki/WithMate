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
  actorSnapshot: { sessionTitle: "Sender Workspace", character: { id: "sender", name: "Original Agent", iconPath: "" } } };
const character = { id: "owner", name: "Owner", iconPath: "", description: "", roleMarkdown: "", notesMarkdown: "", updatedAt: "", themeColors: { main: "#112233", sub: "#445566" } };
const settings = captureSessionExecutionOptions(buildNewSession({ id: "owner", taskTitle: "Fixture", workspacePath: "C:/fixture", workspaceLabel: "Fixture",
  branch: "main", characterId: character.id, character: character.name, characterIconPath: "", characterThemeColors: character.themeColors, approvalMode: "on-request" }));

// @test-value v2
// kind = "contract"
// claim = "再実行の待機中に元の指示を変更していなければ元話者を示し、編集後は元話者の発言として表示しない"
// oracle = { type = "contract", ref = "docs/design/session-history.md: Main列の初期枠・子Session枠" }
// fault = "GUI起点を常に話者とみなす、または編集済み再送を元Sessionの原文に見せる"
// observable = "本番の予約カードに表示される本文・再送label・元話者名とリンクの有無"
// observation_boundary = "component-behavior"
// scope = "同一受付で本文編集した再送予約。providerとIPCは使わない"
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
  try {
    await act(async () => renderQueue(receipt));
    assert.equal(article().querySelector(".message-character-name")?.textContent, "Original Agent");
    assert.ok(article().querySelector('button[aria-label="Open Sender: Sender Workspace"]'));
    assert.match(article().textContent!, /Retry requested by you · Previous input from Original Agent/);
    assert.match(article().textContent!, /Original content/);

    const changed = { ...accepted, request: { ...accepted.request, userMessage: "User edited content" } };
    await act(async () => renderQueue({ ...receipt, captured: changed, updatedAt: "edited" }));
    assert.ok(article().classList.contains("user"));
    assert.equal(article().querySelector('button[aria-label="Open Sender: Sender Workspace"]'), null);
    assert.deepEqual([...article().querySelectorAll(".message-character-name")].map((node) => node.textContent),
      ["Retry requested by you · Previous input from Original Agent"]);
    assert.match(article().textContent!, /User edited content/);
    assert.doesNotMatch(article().textContent!, /Original content/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of prior) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

// @test-value v2
// kind = "contract"
// claim = "保存Retryは元の未編集入力と今回の入力が同じと確認された場合だけ元話者を表示し、添付だけの変更と比較不能を再読込後も区別する"
// oracle = { type = "contract", ref = "docs/design/session-history.md: Main列の初期枠・子Session枠" }
// fault = "本文だけで一致とみなす、比較不能を編集済みと示す、または元入力が編集済みでも今回trueだけで元話者の発言に見せる"
// observable = "SQLiteの軽量読取の同一本文に対するtrue/false/null、実カードの元話者・再送注記・編集表示、表示読取の件数と自動Details読取の有無"
// observation_boundary = "component-behavior"
// scope = "分離SQLiteの固定済み再送受付から、本番会話列を初回および再openで描画。IPCは同じ保存readerへのfixture接続"
// lifecycle = "permanent"
// impact = "添付を差し替えた方向付けや比較できない本文を、以前の相手から届いた原文と誤認する"
// distinction = "待機カードtestは保存された三値との接続を通らず、履歴reader単体では話者と注記の組合せが分からない"
// @end-test-value
test("Saved Retry cards distinguish changed attachments from an uncomparable input after reopening", async () => {
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
    const savedOriginal = { ...original, targetIncarnationId: savedTarget.incarnationId };
    const executionOptions = captureSessionExecutionOptions(owner);
    let seq = 0;
    const save = (inputOrigin: SessionTurnQueueOrigin, phase: "failed" | "completed", retrySource?: SessionTurnQueueCapturedInput["retrySource"],
      replaceAttachment = false, attachments = [attachment("original.txt")]) => {
      const input = queue.enqueue(savedTarget, { origin: inputOrigin, retrySource, provider: owner.provider, workspacePath: directory,
        attachments, request: { userMessage: content, clientRequestId: randomUUID(),
          submitSource: retrySource ? "retry" : "composer", executionOptions } });
      if (replaceAttachment) queue.updateQueued(savedTarget, input.id, { userMessage: content, attachments: [attachment("replacement.txt")] });
      const claimed = queue.claimNext(savedTarget);
      assert.equal(claimed?.id, input.id);
      assert.ok(claimed?.dispatched);
      const start = sessions.appendRunningTurnStart({ ...savedTarget, expectedMessageCount: seq, updatedAt: "start",
        userMessage: { role: "user", text: claimed.dispatched.request.userMessage },
        queuedTurn: { queueId: input.id, turn: { sessionId: target.sessionId, phase: "running", userMessageSeq: seq,
          provider: owner.provider, model: executionOptions.model, reasoningEffort: executionOptions.reasoningEffort,
          sandboxMode: executionOptions.codexSandboxMode, approvalMode: executionOptions.approvalMode, threadId: "", createdAt: "start", errorMessage: "" } } });
      assert.ok(start.queuedTurn);
      sessions.appendSessionTerminal({ ...savedTarget, expectedMessageCount: seq + 1, assistantMessage: { role: "assistant", text: phase },
        metadata: { status: "saved", runState: "idle", threadId: "", updatedAt: "finish" },
        terminalCommit: { turnId: start.queuedTurn.id, sessionId: target.sessionId, phase, assistantMessageSeq: seq + 1,
          threadId: "", errorMessage: "", completedAt: "finish" } });
      const saved = { receiptId: input.id, turnId: String(start.queuedTurn.id), seq };
      seq += 2;
      return saved;
    };
    const source = save(savedOriginal, "failed");
    const retrySource = { receiptId: source.receiptId, turnId: source.turnId, origin: savedOriginal, changedSinceAcceptance: false };
    const unchanged = save(savedOrigin, "completed", retrySource);
    const changed = save(savedOrigin, "completed", retrySource, true);
    const unknown = save(savedOrigin, "completed", retrySource);
    const editedSource = save(savedOriginal, "failed", undefined, true);
    const editedRetrySource = { ...retrySource, receiptId: editedSource.receiptId, turnId: editedSource.turnId, changedSinceAcceptance: true };
    const retryOfEditedSource = save(savedOrigin, "completed", editedRetrySource, false, [attachment("replacement.txt")]);
    // Earlier saved executions may retain only the fixed snapshot, not its comparison baseline.
    const fixture = new DatabaseSync(database);
    try { fixture.prepare("UPDATE session_turn_queue_v6 SET accepted_json=NULL WHERE id=?").run(unknown.receiptId); }
    finally { fixture.close(); }
    const checks = [[unchanged.seq, true], [changed.seq, false], [unknown.seq, null], [retryOfEditedSource.seq, true]] as const;
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
          assert.deepEqual(result.retrySource, messageSeq === retryOfEditedSource.seq ? editedRetrySource : retrySource);
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
        const caption = "Retry requested by you · Previous input from Original Agent";
        assert.deepEqual(cards.map((card) => [...card.querySelectorAll(".message-character-name")].map((node) => node.textContent)),
          [["Original Agent", caption], [caption + " · Edited before this Turn started"], [caption], [caption]]);
        assert.deepEqual(cards.map((card) => Boolean(card.querySelector('button[aria-label="Open Sender: Sender Workspace"]'))), [true, false, false, false]);
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
