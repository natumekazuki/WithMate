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
import { AuxiliaryComposerSendOwner } from "../../src/chat/auxiliary/auxiliary-session-send-operation.js";
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
// claim = "Auxiliary実行設定は即時反映し、古い拒否・再取得で後続選択や再作成会話を巻き戻さず、現在要求の拒否だけを復旧する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Auxiliaryの実行設定選択" }
// fault = "要求revisionか会話identityの照合を省き、遅いrollbackが新しい選択・本文を上書きする"
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
  binding.setSession({ ...session(), runState: "running" });
  await owner.update({ api, binding, isReadOnly: false, recipe: (current) => ({ ...current, approvalMode: "never" }), onFeedback: () => {} });
  assert.equal(requests.length, 5);
});

// @test-value v2
// kind = "invariant"
// claim = "通常Sendは対象draftのdurable revisionをconsumeし、結果待ちの再編集をconsume後のrevisionへ保存し、非表示でも本文・選択を保持する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Composer の更新・保存境界と送信直後の共通反映" }
// fault = "保存をconsume前revisionで実行する、終端まで編集保存を待たせる、結果で新しいdraftを消す、または非表示時に送信結果とdetail保護を失う"
// observable = "run要求のincarnation/revision、CAS保存record、Composer本文、bindingの確定本文と実行設定、detail保持数"
// observation_boundary = "component-behavior"
// scope = "Auxiliary composer send through draft persistence owner"
// lifecycle = "permanent"
// impact = "追編集の消失・保存失敗や、会話切替後の確定本文の欠落を防ぐ"
// distinction = "既存send operation testはdraftの実flush・consume待機・durable CASを組み合わせず、実型検査もこの競合を検出しない"
// @end-test-value
test("通常Sendの結果待ち中の再編集は終端を待たず保存される", async (t) => {
  const h = await mountDrafts(t);
  const state = bindingFor(session());
  const sendOwner = new AuxiliaryComposerSendOwner();
  const owner = { kind: "auxiliary" as const, id: "aux-1" };
  let selected = true;
  const send = async (reject: boolean) => {
    state.binding.setSession(session()); selected = true;
    await h.edit(session(), "captured");
    const started = deferred<RunSessionTurnRequest>();
    const result = deferred<AuxiliarySession>();
    const events: string[] = [];
    const pending = sendOwner.send({
      api: { runAuxiliarySessionTurn: async (id, request) => {
        const record = h.recordFor(id);
        assert.equal(request.auxiliaryDraftDurableRevision, record.durableRevision);
        h.records.set(id, { ...record, text: "", durableRevision: record.durableRevision + 1 });
        started.resolve(request); return result.promise;
      } },
      binding: state.binding, drafts: h.drafts, composerRegistry: h.registry, blockedReason: "", busyReason: "", onBlocked: () => {}, parentMessageCount: 17, updatedAt: "now",
      isCurrentTarget: () => selected, collapseActionDock: () => { events.push("collapse"); },
      updateLiveRunState: () => { events.push(state.binding.getSession()!.runState); }, onRunningSessionApplied: () => {},
    });
    const outcome = pending.then(() => null, (error: unknown) => error);
    const request = await started.promise;
    assert.equal(request.auxiliaryDraftIncarnation, "incarnation-1"); assert.equal(request.displayAnchorParentMessageCount, 17);
    assert.equal(h.registry.get(owner).draft, ""); assert.deepEqual(events, ["collapse", "running"]); assert.equal(state.retained, 1);
    selected = false;
    state.binding.setExecutionSelection({ ...state.binding.getSession()!, model: "later-selection" });
    const edited = h.drafts.changeDraft(session(), "new edit", 8);
    const flushing = h.drafts.getOwner(session())!.flush();
    await edited; await flushing;
    assert.equal(h.recordFor(owner.id).text, "new edit", "editing must not wait for the running turn to finish");
    if (reject) result.reject(new Error("run rejected"));
    else result.resolve({ ...session(), messages: [{ role: "user", text: "captured" }, { role: "assistant", text: "done" }] });
    const error = await outcome;
    await edited; await flushing; await h.drafts.waitForPendingSends();
    assert.equal(reject ? error instanceof Error : error === null, true);
    assert.equal(h.registry.get(owner).draft, "new edit"); assert.equal(h.recordFor(owner.id).text, "new edit");
    assert.equal(h.registry.get(owner).saveState, "saved"); assert.equal(state.binding.getSession()!.model, "later-selection"); assert.equal(state.retained, 0);
    if (!reject) assert.equal(state.binding.getSession()!.messages[1].text, "done");
  };
  await send(false); await send(true);
});

// @test-value v2
// kind = "invariant"
// claim = "通常Send準備中の編集・対象変更・freezeはrunを開始せず、拒否後は捕捉した同一draftだけを復元し、再作成先へ旧結果を反映しない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Composer の更新・保存境界と送信直後の共通反映" }
// fault = "古いcaptureでrunを開始する、別draftをclear/restoreする、consume後の復元保存を省く、または同じIDの再作成先へ旧turn結果を適用する"
// observable = "run呼出数、Composerの本文と保存状態、binding本文とidentity、consume後に復元したdurable本文とrevision"
// observation_boundary = "component-behavior"
// scope = "Auxiliary send capture invalidation and rejection recovery"
// lifecycle = "permanent"
// impact = "利用者の入力消失と別会話への誤送信を防ぐ"
// distinction = "低水準send testのmutation revisionだけでは新ownerのcapture・flush・復元保存の接続を観測しない"
// @end-test-value
test("通常Sendは古いcaptureを無効化し、拒否復元を同一ownerへ限定する", async (t) => {
  const h = await mountDrafts(t);
  const state = bindingFor(session());
  const sendOwner = new AuxiliaryComposerSendOwner();
  const owner = { kind: "auxiliary" as const, id: "aux-1" };
  let runCalls = 0;
  let selected = true;
  let run = async (): Promise<AuxiliarySession> => { throw new Error("rejected"); };
  const send = () => sendOwner.send({
    api: { runAuxiliarySessionTurn: async () => { runCalls++; return run(); } }, binding: state.binding, drafts: h.drafts,
    composerRegistry: h.registry, blockedReason: "", busyReason: "", onBlocked: () => {}, parentMessageCount: null, updatedAt: "now", isCurrentTarget: () => selected,
    collapseActionDock: () => {}, updateLiveRunState: () => {}, onRunningSessionApplied: () => {},
  });
  await h.edit(session(), "captured");
  const stale = send(); await h.edit(session(), "edited during preparation"); await stale;
  assert.equal(runCalls, 0); assert.equal(h.registry.get(owner).draft, "edited during preparation");
  assert.notEqual(h.registry.get(owner).saveState, "error");
  for (const invalidation of ["target", "freeze"] as const) {
    const saveDraft = h.api.saveAuxiliaryDraft;
    const savingStarted = deferred<void>();
    const releaseSave = deferred<void>();
    h.api.saveAuxiliaryDraft = async (request) => {
      savingStarted.resolve();
      await releaseSave.promise;
      return saveDraft(request);
    };
    const text = `draft before ${invalidation} invalidation`;
    const saving = h.drafts.changeDraft(session(), text, text.length);
    const pending = send();
    await savingStarted.promise;
    assert.equal(state.retained, 1);
    assert.equal(runCalls, 0, "run must wait for draft preparation");
    if (invalidation === "target") selected = false;
    else h.registry.freeze();
    releaseSave.resolve();
    await saving; await pending;
    h.api.saveAuxiliaryDraft = saveDraft;
    assert.equal(runCalls, 0, `${invalidation} changed while preparation was pending`);
    assert.equal(h.registry.get(owner).draft, text);
    assert.equal(h.recordFor(owner.id).text, text);
    assert.equal(h.registry.get(owner).saveState, "saved");
    assert.equal(state.retained, 0);
    selected = true; h.registry.unfreeze();
  }
  await h.edit(session(), "rejected capture");
  const beforeRejection = { ...h.recordFor(owner.id) };
  run = async () => {
    h.records.set(owner.id, { ...beforeRejection, text: "", durableRevision: beforeRejection.durableRevision + 1 });
    throw new Error("rejected after consume");
  };
  await assert.rejects(send(), /rejected/); await h.drafts.flushAll();
  assert.equal(h.registry.get(owner).draft, "rejected capture");
  assert.equal(h.recordFor(owner.id).text, "rejected capture");
  assert.equal(h.recordFor(owner.id).durableRevision, beforeRejection.durableRevision + 2, "recovery must CAS-save after the consumed revision");
  assert.equal(h.registry.get(owner).saveState, "saved");
  const started = deferred<void>(); const response = deferred<AuxiliarySession>();
  run = async () => { started.resolve(); return response.promise; };
  const pending = send(); await started.promise;
  state.binding.setSession({ ...session(), createdAt: "recreated", messages: [{ role: "assistant", text: "new identity" }] });
  h.registry.setDraft(owner, "new identity draft");
  response.resolve({ ...session(), messages: [{ role: "assistant", text: "old result" }] });
  await pending;
  assert.equal(state.binding.getSession()!.messages[0].text, "new identity"); assert.equal(h.registry.get(owner).draft, "new identity draft");
  assert.equal(state.retained, 0);
});
