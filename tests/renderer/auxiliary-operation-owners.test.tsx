import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { AuxiliaryDraftRecord } from "../../src-shared/auxiliary/auxiliary-draft-contract.js";
import type { SetExecutionOptionsResult } from "../../src-shared/session/session-mutation-contract.js";
import type { RunSessionTurnRequest } from "../../src-shared/session/runtime-state.js";
import { ComposerControllerRegistry } from "../../src/chat/composer-controller.js";
import { AuxiliaryExecutionOptionsOwner } from "../../src/chat/auxiliary/auxiliary-runtime-option-operation.js";
import { useAuxiliaryDraftPersistence } from "../../src/chat/auxiliary/use-auxiliary-draft-persistence.js";
import { runMainSessionTurnOperation } from "../../src/chat/runtime/run-main-session-turn-operation.js";
import { SessionTurnAcceptance } from "../../src/chat/runtime/session-turn-acceptance.js";
import { SessionSubmitCoordinator } from "../../src/chat/runtime/session-submit-coordinator.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { SessionTurnQueueAcceptanceResult, SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import type { AuxiliarySessionBinding } from "../../src/chat/use-auxiliary-workspace.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function session(id = "aux-1"): AuxiliarySession {
  return { id, parentSessionId: "parent", status: "active", runState: "idle", title: id, provider: "codex",
    catalogRevision: 1, model: "model-a", reasoningEffort: "medium", approvalMode: "untrusted",
    codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "",
    allowedAdditionalDirectories: [], threadId: "thread", composerDraft: "", messages: [],
    displayAfterMessageIndex: null, createdAt: "creation-1", updatedAt: "before", closedAt: "" };
}

function bindingFor(initial: AuxiliarySession) {
  const sessionRef = { current: initial as AuxiliarySession | null };
  let retained = 0;
  const binding: AuxiliarySessionBinding = {
    sessionRef, mutationRevision: { current: 0 }, draftSaveQueue: { current: Promise.resolve() }, sessionSaveQueue: { current: Promise.resolve() },
    getSession: () => sessionRef.current,
    setSession: (update) => { sessionRef.current = typeof update === "function" ? update(sessionRef.current) : update; },
    setExecutionSelection: (next) => { sessionRef.current = next; },
    setMessageBookmark: () => {},
    retainDetail: () => { retained++; return () => { retained--; }; },
  };
  return { binding, get retained() { return retained; } };
}

async function mountDrafts(t: TestContext) {
  const dom = new JSDOM("<div id='root'></div>");
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const registry = new ComposerControllerRegistry();
  const records = new Map<string, AuxiliaryDraftRecord>();
  const recordFor = (id: string) => {
    const existing = records.get(id);
    if (existing) return existing;
    const record = { auxiliarySessionId: id, parentSessionId: "parent", incarnation: "incarnation-1", durableRevision: 0, text: "", updatedAt: "before" };
    records.set(id, record);
    return record;
  };
  const api: NonNullable<Parameters<typeof useAuxiliaryDraftPersistence>[0]["api"]> = {
    getAuxiliarySessionStatus: async (id) => ({ id, parentSessionId: "parent", status: "active", runState: "idle", createdAt: "creation-1", incarnation: recordFor(id).incarnation }),
    getAuxiliaryDraft: async (id) => ({ ...recordFor(id) }),
    saveAuxiliaryDraft: async (request) => {
      const record = recordFor(request.auxiliarySessionId);
      if (record.incarnation !== request.incarnation || record.durableRevision !== request.expectedDurableRevision) return { outcome: "stale" };
      const saved = { ...record, text: request.text, durableRevision: record.durableRevision + 1, updatedAt: request.updatedAt };
      records.set(record.auxiliarySessionId, saved);
      return { outcome: "saved", ack: { auxiliarySessionId: saved.auxiliarySessionId, incarnation: saved.incarnation, durableRevision: saved.durableRevision, updatedAt: saved.updatedAt } };
    },
  };
  let drafts!: ReturnType<typeof useAuxiliaryDraftPersistence>;
  function Harness() {
    drafts = useAuxiliaryDraftPersistence({ api, composerRegistry: registry, touchRecency: () => {}, isFrozen: () => registry.isFrozen });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(<Harness />));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { drafts, registry, records, api, recordFor,
    edit: async (target: AuxiliarySession, text: string) => {
      const operation = drafts.changeDraft(target, text, text.length);
      await drafts.getOwner(target)!.flush();
      await operation;
    } };
}

// @test-value v2
// kind = "contract"
// claim = "Auxiliary実行設定は即時反映し、古い拒否・再取得で後続選択や再作成会話を巻き戻さず、現在要求の拒否だけを復旧し、read-onlyとnever時Reviewerの変更を拒否する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Auxiliaryの実行設定選択" }
// fault = "要求revisionか会話identityの照合を省き、遅いrollbackが新しい選択・本文を上書きするか、read-onlyまたはnever時Reviewerの変更を受付する"
// observable = "bindingのmodelと本文、feedback、実行設定要求とcheckpoint失敗log"
// observation_boundary = "component-behavior"
// scope = "Auxiliary execution selection owner"
// lifecycle = "permanent"
// impact = "次のSendが利用者の選択と異なる実行設定で開始される"
// distinction = "既存option patch testは非同期保存・拒否後の取得競合を通らず、型検査も応答順を検証しない"
// @end-test-value
test("実行設定ownerは要求revisionと会話identityを照合してrollbackする", async () => {
  const owner = new AuxiliaryExecutionOptionsOwner();
  const { binding } = bindingFor(session());
  const requests: Array<ReturnType<typeof deferred<SetExecutionOptionsResult>>> = [];
  const reloads: Array<ReturnType<typeof deferred<AuxiliarySession | null>>> = [];
  const feedback: Array<{ ownerId: string; message: string } | null> = [];
  const logs: unknown[] = [];
  const api: NonNullable<Parameters<typeof owner.update>[0]["api"]> = {
    setAuxiliaryExecutionOptions: async (request) => {
      assert.deepEqual([request.auxiliarySessionId, request.parentSessionId, request.createdAt], ["aux-1", "parent", "creation-1"]);
      const response = deferred<SetExecutionOptionsResult>(); requests.push(response); return response.promise;
    },
    getAuxiliarySession: async () => { const response = deferred<AuxiliarySession | null>(); reloads.push(response); return response.promise; },
    reportRendererLog: (log) => { logs.push(log); },
  };
  const select = (model: string) => owner.update({ api, binding, isReadOnly: false, recipe: (current) => ({ ...current, model }), onFeedback: (value) => feedback.push(value) });
  await select("model-b"); assert.equal(binding.getSession()!.model, "model-b");
  await select("model-c"); requests[0].reject(new Error("old rejected"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(binding.getSession()!.model, "model-c"); assert.equal(reloads.length, 0);
  requests[1].reject(new Error("current rejected"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(feedback.at(-1)!.message, /current rejected/);
  await select("model-d"); reloads[0].resolve({ ...session(), model: "model-a" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(binding.getSession()!.model, "model-d");
  requests[2].reject(new Error("retry rejected"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  binding.setSession({ ...binding.getSession()!, messages: [{ role: "assistant", text: "current body" }] });
  reloads[1].resolve(session()); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(binding.getSession()!.model, "model-a"); assert.equal(binding.getSession()!.messages[0].text, "current body");
  await select("model-e"); binding.setSession({ ...session(), createdAt: "creation-2", model: "recreated" });
  requests[3].reject(new Error("old identity")); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(binding.getSession()!.model, "recreated"); assert.equal(reloads.length, 2);
  binding.setSession(session()); await select("model-f");
  requests[4].resolve({ status: "accepted", checkpointSaved: false }); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(binding.getSession()!.model, "model-f"); assert.equal(logs.length, 1);
  binding.setSession({ ...session(), runState: "running", approvalMode: "never" });
  await owner.update({ api, binding, isReadOnly: false, recipe: (current) => ({ ...current, codexReviewer: "auto-review" }), onFeedback: () => {} });
  await owner.update({ api, binding, isReadOnly: true, recipe: (current) => ({ ...current, model: "read-only-selection" }), onFeedback: () => {} });
  assert.equal(requests.length, 5);
  assert.equal(binding.getSession()!.codexReviewer, "user");
  assert.equal(binding.getSession()!.model, "model-a");
});

function sendQueue(h: Awaited<ReturnType<typeof mountDrafts>>, state: ReturnType<typeof bindingFor>, input: {
  enqueue(request: RunSessionTurnRequest): Promise<SessionTurnQueueAcceptanceResult>;
  isCurrent(): boolean;
  requestId?: string;
}) {
  const selected = state.binding.getSession()!;
  const owner = { kind: "auxiliary" as const, id: selected.id };
  const release = state.binding.retainDetail();
  const executionOptions = captureSessionExecutionOptions(selected);
  const displayed: Session = {
    id: selected.id, incarnationId: selected.createdAt, taskTitle: selected.title, status: "idle", updatedAt: selected.updatedAt, isPinned: false,
    provider: selected.provider, ...executionOptions, workspaceLabel: "Workspace", workspacePath: "workspace", branch: "feature",
    sessionKind: "default", accessMode: "active", sourceSchemaVersion: 6, characterId: "mate", character: "Mate", characterIconPath: "",
    characterThemeColors: { main: "#000000", sub: "#000000" }, characterRuntimeSnapshot: null,
    runState: selected.runState, allowedAdditionalDirectories: [], threadId: selected.threadId, messages: [], stream: [],
  };
  return h.drafts.trackSend(runMainSessionTurnOperation({
    api: {
      previewComposerInput: async () => ({ attachments: [], errors: [] }),
      enqueueSessionTurn: async (_id, request) => input.enqueue(request),
      getSessionTurnQueueReceipt: async () => null,
    },
    sessionId: selected.id, selectedSession: displayed,
    request: { userMessage: h.registry.get(owner).draft, clientRequestId: input.requestId ?? "801-capture", submitSource: "composer", executionOptions, displayAnchorParentMessageCount: 17 },
    composerRegistry: h.registry, composerOwner: owner, submitCoordinator: new SessionSubmitCoordinator(), acceptance: new SessionTurnAcceptance(),
    auxiliaryDraftOwner: h.drafts.getOwner(selected)!, queueTurn: true, clearDraft: true, collapseActionDock: false,
    isCurrentSubmission: () => input.isCurrent() && state.binding.getSession()?.createdAt === selected.createdAt,
    selectedSessionRunState: selected.runState, blockedReason: null, isReadOnly: false, validateWorkspace: async () => true,
    state: { setComposerPreview: (preview) => h.registry.setPreview(owner, preview), setPendingSubmitSessionId() {}, setForceComposerBlockedFeedback() {}, collapseActionDock() {} },
    log() {},
  }).finally(release));
}

function queueReceipt(request: RunSessionTurnRequest): SessionTurnQueueReceipt {
  return { sessionId: "aux-1", incarnationId: "creation-1", id: "receipt", requestId: request.clientRequestId!, sequence: 1, state: "queued",
    captured: { request: { ...request, clientRequestId: request.clientRequestId! }, attachments: [], provider: "codex", workspacePath: "workspace" },
    turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now" };
}

// @test-value v2
// kind = "contract"
// claim = "running Auxiliaryの設定変更は次のqueue受付へ捕捉され、変更前の会話snapshotと受付済みreceiptの実行設定を変更しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: runtime設定のnative select / docs/design/electron-session-store.md: 実行設定と Send" }
// fault = "running設定変更をownerが拒否するか、次のSendが古い設定を捕捉するか、選択更新が既存snapshotまたはreceiptを変更する"
// observable = "設定API要求、bindingのrunState、変更前snapshotと受付済みreceiptと変更後receiptのexecutionOptions"
// observation_boundary = "component-behavior"
// scope = "Auxiliary execution selection owner through real draft hook and queue request capture"
// lifecycle = "permanent"
// impact = "実行中に次Turnの権限設定を選べない、または受付済みTurnの実行条件を後から変えてしまう"
// distinction = "owner rollback testとqueue draft ACK testはrunningでの権限設定更新から次の受付までの接合を通らない。小さい既存hook fixtureだけを使う"
// @end-test-value
test("running Auxiliaryの設定変更は次のreceiptだけへ捕捉される", async (t) => {
  const h = await mountDrafts(t);
  const running = { ...session(), runState: "running" as const };
  const state = bindingFor(running);
  const before = captureSessionExecutionOptions(running);
  const receipts: SessionTurnQueueReceipt[] = [];
  const enqueue = async (request: RunSessionTurnRequest) => {
    const record = h.recordFor(running.id);
    h.records.set(running.id, { ...record, text: "", durableRevision: record.durableRevision + 1 });
    const receipt = queueReceipt(request);
    receipts.push(receipt);
    return receipt;
  };
  await h.edit(running, "before selection");
  await sendQueue(h, state, { enqueue, isCurrent: () => true, requestId: "801-before-selection" });
  const selections: unknown[] = [];
  const owner = new AuxiliaryExecutionOptionsOwner();
  await owner.update({
    api: {
      setAuxiliaryExecutionOptions: async (request) => {
        selections.push(request);
        return { status: "accepted", checkpointSaved: true };
      },
      getAuxiliarySession: async () => { throw new Error("Accepted selection must not reload the conversation."); },
      reportRendererLog: () => {},
    },
    binding: state.binding, isReadOnly: false,
    recipe: (current) => ({ ...current, approvalMode: "on-request", codexSandboxMode: "read-only", codexSpeed: "fast", codexReviewer: "auto-review" }),
    onFeedback: () => {},
  });
  const next = captureSessionExecutionOptions(state.binding.getSession()!);
  assert.deepEqual(next, { ...before, approvalMode: "on-request", codexSandboxMode: "read-only", codexSpeed: "fast", codexReviewer: "auto-review" });
  assert.deepEqual(selections, [{ auxiliarySessionId: running.id, parentSessionId: running.parentSessionId, createdAt: running.createdAt, executionOptions: next }]);
  assert.equal(state.binding.getSession()!.runState, "running");
  await h.edit(state.binding.getSession()!, "after selection");
  await sendQueue(h, state, { enqueue, isCurrent: () => true, requestId: "801-after-selection" });
  assert.deepEqual(captureSessionExecutionOptions(running), before);
  assert.deepEqual(receipts[0].captured.request.executionOptions, before);
  assert.deepEqual(receipts[1].captured.request.executionOptions, next);
  assert.notEqual(receipts[0].requestId, receipts[1].requestId);
  assert.equal(state.retained, 0);
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliaryの実draft hookとqueue受付はdurable版をconsumeし、ACKまでdraftを保持して追編集だけをconsume後の版へ保存する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 送信受付の共通反映とComposer の更新・保存境界" }
// fault = "実hookがconsume前revisionで追編集を保存する、ACK前に本文を消す、またはACKが新revisionを消す"
// observable = "受付要求のincarnation/revisionと設定、ACK前後のlocal/durable本文、detail保持数"
// observation_boundary = "component-behavior"
// scope = "Auxiliary draft hook through durable queue acceptance"
// lifecycle = "permanent"
// impact = "実行中の次turn予約による追編集の消失とCAS保存失敗を防ぐ"
// distinction = "queue operation単体は実draft hookの保存状態・flushと受付gate接続を通らない"
// @end-test-value
test("Auxiliary queue ACKは実draft hookの捕捉版だけをconsumeし、追編集を保存する", async (t) => {
  const h = await mountDrafts(t);
  const state = bindingFor({ ...session(), runState: "running" });
  const owner = { kind: "auxiliary" as const, id: "aux-1" };
  for (const editDuringAck of [false, true]) {
    await h.edit(session(), "captured");
    const started = deferred<RunSessionTurnRequest>();
    const ack = deferred<SessionTurnQueueReceipt>();
    const pending = sendQueue(h, state, { isCurrent: () => true, enqueue: async (request) => {
      const record = h.recordFor(owner.id);
      assert.equal(request.auxiliaryDraftDurableRevision, record.durableRevision);
      h.records.set(owner.id, { ...record, text: "", durableRevision: record.durableRevision + 1 });
      started.resolve(request);
      return ack.promise;
    } });
    const request = await started.promise;
    assert.equal(request.auxiliaryDraftIncarnation, "incarnation-1");
    assert.equal(request.displayAnchorParentMessageCount, 17);
    assert.deepEqual(request.executionOptions, captureSessionExecutionOptions(session()));
    assert.equal(h.registry.get(owner).draft, "captured");
    assert.equal(state.retained, 1);
    state.binding.setExecutionSelection({ ...state.binding.getSession()!, model: "later-selection" });
    let edited: Promise<void> | null = null;
    if (editDuringAck) {
      edited = h.drafts.changeDraft(session(), "new edit", 8);
      void h.drafts.getOwner(session())!.flush();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(h.recordFor(owner.id).text, "", "queued save waits for atomic consume ACK");
    }
    ack.resolve(queueReceipt(request));
    await pending; await edited; await h.drafts.flushAll(); await h.drafts.waitForPendingSends();
    assert.equal(h.registry.get(owner).draft, editDuringAck ? "new edit" : "");
    assert.equal(h.recordFor(owner.id).text, editDuringAck ? "new edit" : "");
    assert.equal(h.registry.get(owner).saveState, editDuringAck ? "saved" : "idle");
    assert.equal(state.binding.getSession()!.model, "later-selection");
    assert.equal(state.retained, 0);
    state.binding.setExecutionSelection({ ...state.binding.getSession()!, model: "model-a" });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary queueの準備中の編集・対象変更・freeze・再作成は受付せず、確定拒否では実draft hookの本文と保存版を保持する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 送信受付の共通反映とComposer の更新・保存境界" }
// fault = "保存待ちで失効したcaptureを受付する、または確定拒否をconsume ACK扱いしてdraftを消す"
// observable = "enqueue呼出数、local/durable本文とrevision、保存状態、detail保持数"
// observation_boundary = "component-behavior"
// scope = "Auxiliary queue preparation invalidation and known rejection"
// lifecycle = "permanent"
// impact = "別会話への誤送信と未受付の入力消失を防ぐ"
// distinction = "queue class単体は実hookの遅いflushとUI capture失効を通らない"
// @end-test-value
test("Auxiliary queueはflush待ちの失効captureと確定拒否から入力を保護する", async (t) => {
  const h = await mountDrafts(t);
  const state = bindingFor(session());
  const owner = { kind: "auxiliary" as const, id: "aux-1" };
  let calls = 0;
  let selected = true;
  const send = () => sendQueue(h, state, { isCurrent: () => selected, enqueue: async () => {
    calls++;
    return { state: "rejected", reason: "known rejection" };
  } });
  for (const invalidation of ["edit", "target", "freeze", "identity"] as const) {
    const saveDraft = h.api.saveAuxiliaryDraft;
    const savingStarted = deferred<void>();
    const releaseSave = deferred<void>();
    h.api.saveAuxiliaryDraft = async (request) => {
      savingStarted.resolve(); await releaseSave.promise; return saveDraft(request);
    };
    const text = `draft before ${invalidation}`;
    const saving = h.drafts.changeDraft(session(), text, text.length);
    const pending = send();
    await savingStarted.promise;
    assert.equal(state.retained, 1);
    assert.equal(calls, 0);
    let laterEdit: Promise<void> | null = null;
    if (invalidation === "edit") laterEdit = h.drafts.changeDraft(session(), "new edit", 8);
    if (invalidation === "target") selected = false;
    if (invalidation === "freeze") h.registry.freeze();
    if (invalidation === "identity") state.binding.setSession({ ...session(), createdAt: "recreated" });
    releaseSave.resolve();
    await saving; await laterEdit; await pending;
    h.api.saveAuxiliaryDraft = saveDraft;
    assert.equal(calls, 0);
    assert.equal(h.registry.get(owner).draft, invalidation === "edit" ? "new edit" : text);
    assert.equal(h.recordFor(owner.id).text, invalidation === "edit" ? "new edit" : text);
    assert.equal(h.registry.get(owner).saveState, "saved");
    assert.equal(state.retained, 0);
    selected = true; h.registry.unfreeze(); state.binding.setSession(session());
  }
  await h.edit(session(), "rejected capture");
  const before = { ...h.recordFor(owner.id) };
  await assert.rejects(send(), /known rejection/);
  assert.equal(calls, 1);
  assert.equal(h.registry.get(owner).draft, "rejected capture");
  assert.deepEqual(h.recordFor(owner.id), before);
  assert.equal(h.registry.get(owner).saveState, "saved");
  assert.equal(state.retained, 0);
});
