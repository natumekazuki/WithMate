import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src/withmate-window-api.js";
import type { AuxiliaryDraftRecord } from "../../src/auxiliary-draft-contract.js";

// @test-value v2
// kind = "contract"
// claim = "実Session Windowは入力と送信revisionをowner別に保ち、quitでは未確定送信と失敗復元の保存後にACKし、保存失敗では終了を拒否してRetryを保持する。通常closeは実行完了を待たず、凍結後の送信前保存からのrun開始と添付を止める"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Composer の更新・保存境界" }
// fault = "入力のたびにAuxiliary一覧summaryのアイコン参照を全件評価する、古いowner/revisionを送信する、凍結中の失敗復元を表示しない、復元を未保存のままflush成功にする、または凍結後にpicker結果からコピーする"
// observable = "textarea/feedback/Sendの状態、summaryアイコン参照回数、保存要求・永続draft・送信対象・flush ACK、picker後のコピー回数"
// observation_boundary = "component-behavior"
// scope = "composer-window-input-wiring"
// lifecycle = "permanent"
// impact = "多数会話での入力遅延、切替による下書き消失、古い入力や別会話への誤送信を防ぐ"
// distinction = "controller単体や型検査では検出できないApp・ActionDock・workspace・送信adapterの実配線を合成API境界で検証し、送信pending→quit待機→失敗復元保存→ACKの順序、非選択owner、closeとの違いも確認する。壁時計の性能値をCI合否にしない"
// @end-test-value
test("Session Windowの入力境界と切替後の最新値送信を実配線で守る", { timeout: 8000 }, async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    url: "http://withmate.test/session.html?sessionId=benchmark-main", pretendToBeVisual: true,
  });
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { value() {} });
  const alerts: string[] = [];
  dom.window.alert = (message) => { alerts.push(String(message)); };
  let api!: WithMateWindowApi;
  runInNewContext(readFileSync(new URL("../benchmark-composer-input-preload.cjs", import.meta.url), "utf8"), {
    require: (name: string) => {
      assert.equal(name, "electron");
      return { contextBridge: { exposeInMainWorld: (_key: string, value: WithMateWindowApi) => { api = value; } } };
    },
    process: { argv: ["--benchmark-auxiliary-count=100", "--benchmark-history=long"] },
    Buffer,
  });
  let summaryReads = 0;
  let fullSaves = 0;
  const getAuxiliary = api.getAuxiliarySession;
  api.getAuxiliarySession = async (id) => {
    const session = await getAuxiliary(id);
    return session ? { ...session, composerDraft: "restored auxiliary draft" } : null;
  };
  const list = api.listAuxiliarySessions;
  api.listAuxiliarySessions = async (id) => (await list(id)).map((summary) => ({
    ...summary,
    get characterIconPath() { summaryReads += 1; return ""; },
  }));
  api.updateAuxiliarySession = async () => { fullSaves += 1; throw new Error("Typing must use draft storage."); };
  const drafts = new Map<string, AuxiliaryDraftRecord>();
  const getStatus = api.getAuxiliarySessionStatus;
  api.getAuxiliarySessionStatus = async (id) => {
    const status = await getStatus(id);
    return status ? { ...status, incarnation: `fixture-incarnation-${id}` } : null;
  };
  let heldSave: Promise<void> | null = null;
  let notifySaveStarted: (() => void) | undefined;
  let notifySaved: ((text: string) => void) | undefined;
  let notifyDraftSaveFailed: (() => void) | undefined;
  let failDraftWrites = false;
  api.getAuxiliaryDraft = async (id) => {
    if (!drafts.has(id)) {
      const session = await api.getAuxiliarySession(id);
      if (!session) return null;
      drafts.set(id, { auxiliarySessionId: id, parentSessionId: session.parentSessionId, incarnation: `fixture-incarnation-${id}`, durableRevision: 0, text: session.composerDraft, updatedAt: session.updatedAt });
    }
    return drafts.get(id)!;
  };
  api.saveAuxiliaryDraft = async (input) => {
    if (failDraftWrites) {
      notifyDraftSaveFailed?.();
      throw new Error("Draft storage unavailable");
    }
    if (heldSave) {
      const wait = heldSave;
      heldSave = null;
      notifySaveStarted?.();
      await wait;
    }
    const current = await api.getAuxiliaryDraft(input.auxiliarySessionId);
    if (!current || current.durableRevision !== input.expectedDurableRevision) return { outcome: "stale" };
    const next = { ...current, text: input.text, durableRevision: current.durableRevision + 1, updatedAt: input.updatedAt };
    drafts.set(next.auxiliarySessionId, next);
    notifySaved?.(next.text);
    return { outcome: "saved", ack: { auxiliarySessionId: next.auxiliarySessionId, incarnation: next.incarnation, durableRevision: next.durableRevision, updatedAt: next.updatedAt } };
  };
  let flushRequest: Parameters<WithMateWindowApi["subscribeSessionDraftFlushRequest"]>[0] | undefined;
  let flushRelease: Parameters<WithMateWindowApi["subscribeSessionDraftFlushRelease"]>[0] | undefined;
  let navigateAuxiliary: Parameters<WithMateWindowApi["subscribeAuxiliarySessionNavigation"]>[0] | undefined;
  const flushAcks: Array<{ id: string; success: boolean }> = [];
  let notifyFlushAck: (() => void) | undefined;
  api.subscribeSessionDraftFlushRequest = (listener) => { flushRequest = listener; return () => { flushRequest = undefined; }; };
  api.subscribeSessionDraftFlushRelease = (listener) => { flushRelease = listener; return () => { flushRelease = undefined; }; };
  api.subscribeAuxiliarySessionNavigation = (listener) => { navigateAuxiliary = listener; return () => { navigateAuxiliary = undefined; }; };
  api.acknowledgeSessionDraftFlush = (id, success) => { flushAcks.push({ id, success }); notifyFlushAck?.(); };
  const sent: Array<{ id: string; text: string }> = [];
  let heldRun: Promise<void> | null = null;
  let notifyRunStarted: (() => void) | undefined;
  let rejectRun = false;
  let failRunRestore = false;
  let notifyRunFailed: (() => void) | undefined;
  api.runAuxiliarySessionTurn = async (id, request) => {
    const current = await api.getAuxiliaryDraft(id);
    assert.ok(current);
    assert.equal(request.auxiliaryDraftIncarnation, current.incarnation);
    assert.equal(request.auxiliaryDraftDurableRevision, current.durableRevision);
    assert.equal(request.userMessage, current.text);
    drafts.set(id, { ...current, text: "", durableRevision: current.durableRevision + 1 });
    sent.push({ id, text: request.userMessage });
    if (heldRun) {
      const wait = heldRun;
      heldRun = null;
      notifyRunStarted?.();
      await wait;
    }
    if (rejectRun) {
      rejectRun = false;
      if (failRunRestore) {
        failRunRestore = false;
        failDraftWrites = true;
        notifyRunFailed?.();
        throw new Error("Auxiliary turn failed and draft restore failed.");
      }
      drafts.set(id, { ...current, durableRevision: current.durableRevision + 2 });
      throw new Error("Auxiliary admission failed");
    }
    const session = await api.getAuxiliarySession(id);
    assert.ok(session);
    return { ...session, composerDraft: "", messages: [...session.messages, { role: "assistant", text: "Auxiliary response" }] };
  };
  api.previewComposerInput = async (_id, text) => ({ text, attachments: [], errors: text === "invalid reference" ? ["Invalid attachment"] : [] } as Awaited<ReturnType<WithMateWindowApi["previewComposerInput"]>>);
  api.runSessionTurn = async (id, request) => {
    sent.push({ id, text: request.userMessage });
    const session = await api.getSession(id);
    assert.ok(session);
    return { ...session, messages: [...session.messages, { role: "user", text: request.userMessage }, { role: "assistant", text: "Fresh response" }] };
  };
  Object.defineProperty(dom.window, "withmate", { value: api });
  const { createRoot } = await import("react-dom/client");
  const { default: App } = await import("../../src/App.js");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const textarea = () => {
    const value = dom.window.document.querySelector<HTMLTextAreaElement>('textarea[data-shortcut-scope="composer"]');
    assert.ok(value);
    return value;
  };
  const input = async (text: string) => {
    await act(async () => {
      const element = textarea();
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(element, text);
      element.setSelectionRange(text.length, text.length);
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(textarea().value, text, "controlled textarea must reflect the latest input immediately");
  };
  const target = async (label: string) => {
    const button = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>(".concurrent-chat-target-dock button")).find((item) => item.textContent === label);
    assert.ok(button);
    await act(async () => { button.click(); });
  };
  try {
    await act(async () => { root.render(<App />); });
    assert.equal(textarea().disabled, false);
    const beforeMain = summaryReads;
    for (const text of ["h", "he", "hello", "hello latest"]) await input(text);
    assert.equal(summaryReads, beforeMain, "Main typing must not reproject the Auxiliary list");
    assert.equal(fullSaves, 0);
    const send = dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button");
    assert.ok(send);
    assert.equal(send.disabled, false, "Send must use the current draft, not the shell's previous render");
    assert.equal(send.title.includes("Message is empty"), false);

    await target("Auxiliary");
    assert.equal(textarea().value, "restored auxiliary draft", "an existing persisted draft must hydrate before any editing");
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click(); });
    assert.equal(sent.length, 1, "a restored draft must be sendable without editing first");
    assert.equal(sent[0].text, "restored auxiliary draft");
    assert.equal(textarea().value, "");
    const beforeAuxiliary = summaryReads;
    const auxiliarySaved = new Promise<void>((resolve) => { notifySaved = (text) => { if (text === "auxiliary draft") resolve(); }; });
    for (const text of ["a", "au", "auxiliary draft"]) await input(text);
    assert.equal(summaryReads, beforeAuxiliary, "typing in the already first Auxiliary must not reproject all summaries");
    await act(async () => { await auxiliarySaved; });
    assert.equal(fullSaves, 0);
    assert.ok(Array.from(drafts.values()).some((record) => record.text === "auxiliary draft"));
    await target("Main");
    assert.equal(textarea().value, "hello latest");
    await target("Auxiliary");
    assert.equal(textarea().value, "auxiliary draft");
    await target("Main");
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click(); });
    assert.deepEqual(sent.at(-1), { id: "benchmark-main", text: "hello latest" });
    assert.equal(textarea().value, "");
    await target("Auxiliary");
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click(); });
    assert.equal(sent.length, 3, "a second Auxiliary send must use the revision after the previous consume");
    assert.equal(sent.at(-1)?.text, "auxiliary draft");
    assert.equal(textarea().value, "");

    let releaseSave!: () => void;
    heldSave = new Promise<void>((resolve) => { releaseSave = resolve; });
    const saveStarted = new Promise<void>((resolve) => { notifySaveStarted = resolve; });
    await input("ABA draft");
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click();
      await saveStarted;
    });
    await input("intermediate draft");
    await input("ABA draft");
    const abaSaved = new Promise<void>((resolve) => { notifySaved = (text) => { if (text === "ABA draft") resolve(); }; });
    await act(async () => { releaseSave(); await abaSaved; });
    assert.equal(sent.length, 3, "an edit during flush must invalidate the send capture even if the text returns to A");
    assert.equal(textarea().value, "ABA draft");
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click(); });
    assert.equal(sent.length, 4);
    assert.equal(sent.at(-1)?.text, "ABA draft");

    let releaseRun!: () => void;
    heldRun = new Promise<void>((resolve) => { releaseRun = resolve; });
    const runStarted = new Promise<void>((resolve) => { notifyRunStarted = resolve; });
    await input("switch during send");
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click();
      await runStarted;
    });
    assert.equal(textarea().value, "", "the captured draft clears when its run starts");
    await target("Main");
    await input("Main while Auxiliary sends");
    const runningCloseAck = new Promise<void>((resolve) => { notifyFlushAck = resolve; });
    await act(async () => {
      flushRequest?.({ requestId: "running-close", sessionId: "benchmark-main", reason: "close" });
      await runningCloseAck;
    });
    assert.deepEqual(flushAcks, [{ id: "running-close", success: true }], "normal close must allow the run to continue in Main");
    const runningQuitAck = new Promise<void>((resolve) => { notifyFlushAck = resolve; });
    await act(async () => { flushRequest?.({ requestId: "running-quit", sessionId: "benchmark-main", reason: "quit" }); });
    assert.equal(flushAcks.length, 1, "quit cannot reuse a save-only close ACK while a hidden owner's send is pending");
    await act(async () => { releaseRun(); await runningQuitAck; });
    assert.deepEqual(flushAcks.at(-1), { id: "running-quit", success: true });
    await act(async () => { flushRelease?.({ success: false }); });
    flushAcks.length = 0;
    assert.equal(textarea().value, "Main while Auxiliary sends", "another owner's completion must preserve Main input");
    await target("Auxiliary");
    assert.equal(textarea().value, "", "a consumed draft must not reappear after switching back");

    // A shutdown flush may freeze editing while the send is still pending.
    // The failed-send recovery must still become visible before release.
    heldRun = new Promise<void>((resolve) => { releaseRun = resolve; });
    const frozenRunStarted = new Promise<void>((resolve) => { notifyRunStarted = resolve; });
    await input("recover during quit");
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click();
      await frozenRunStarted;
    });
    const frozenAuxiliaryId = sent.at(-1)!.id;
    rejectRun = true;
    const frozenFlushAck = new Promise<void>((resolve) => { notifyFlushAck = resolve; });
    await act(async () => {
      flushRequest?.({ requestId: "frozen-recovery-quit", sessionId: "benchmark-main", reason: "quit" });
    });
    assert.deepEqual(flushAcks, [], "quit must not ACK before the pending send settles");
    assert.equal(textarea().disabled, true, "flush freezes editing while the send is pending");
    assert.equal(textarea().value, "", "the consumed draft stays hidden until send failure");
    failRunRestore = true;
    const frozenRunFailed = new Promise<void>((resolve) => { notifyRunFailed = resolve; });
    const frozenRecoveryWriteFailed = new Promise<void>((resolve) => { notifyDraftSaveFailed = resolve; });
    await act(async () => { releaseRun(); await frozenRunFailed; await frozenRecoveryWriteFailed; await frozenFlushAck; });
    assert.deepEqual(flushAcks, [{ id: "frozen-recovery-quit", success: false }], "failed restoration must prevent quit");
    notifyDraftSaveFailed = undefined;
    assert.equal(textarea().value, "recover during quit", "failed-send recovery updates the visible draft during freeze");
    assert.equal(textarea().disabled, true, "recovery does not release the shutdown freeze");
    assert.equal(drafts.get(frozenAuxiliaryId)?.text, "", "Main and renderer recovery writes failed");
    await act(async () => { flushRelease?.({ success: false }); });
    assert.equal(textarea().disabled, false, "failed shutdown release restores editing");
    assert.ok(dom.window.document.getElementById("composer-save-feedback"), "failed recovery save remains retryable after release");
    failDraftWrites = false;
    const frozenRecoverySaved = new Promise<void>((resolve) => { notifySaved = (text) => { if (text === "recover during quit") resolve(); }; });
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-save-retry")!.click();
      await frozenRecoverySaved;
    });
    assert.equal(drafts.get(frozenAuxiliaryId)?.text, "recover during quit", "retry must persist the restored draft");
    const frozenRecoveryFlushAck = new Promise<void>((resolve) => { notifyFlushAck = resolve; });
    await act(async () => { flushRequest?.({ requestId: "frozen-recovery-retry", sessionId: "benchmark-main", reason: "quit" }); await frozenRecoveryFlushAck; });
    assert.deepEqual(flushAcks.at(-1), { id: "frozen-recovery-retry", success: true }, "retry must be persisted before the subsequent close ACK");
    await act(async () => { flushRelease?.({ success: false }); });
    assert.deepEqual(alerts, ["Auxiliary turn failed and draft restore failed."]);
    alerts.length = 0;
    flushAcks.length = 0;

    const previousAuxiliaryId = sent.at(-1)!.id;
    heldRun = new Promise<void>((resolve) => { releaseRun = resolve; });
    const failedRunStarted = new Promise<void>((resolve) => { notifyRunStarted = resolve; });
    rejectRun = true;
    await input("restore failed send");
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click();
      await failedRunStarted;
    });
    await act(async () => { navigateAuxiliary?.({ parentSessionId: "benchmark-main", auxiliarySessionId: "benchmark-aux-1" }); });
    await input("another Auxiliary draft");
    const hiddenRecoveryAck = new Promise<void>((resolve) => { notifyFlushAck = resolve; });
    await act(async () => { flushRequest?.({ requestId: "hidden-recovery-quit", sessionId: "benchmark-main", reason: "quit" }); });
    assert.deepEqual(flushAcks, [], "quit must include the non-selected owner's pending send");
    await act(async () => { releaseRun(); await hiddenRecoveryAck; });
    assert.deepEqual(flushAcks, [{ id: "hidden-recovery-quit", success: true }]);
    assert.equal(drafts.get(previousAuxiliaryId)?.text, "restore failed send", "recovery must be durable before quit ACK");
    await act(async () => { flushRelease?.({ success: false }); });
    flushAcks.length = 0;
    assert.equal(textarea().value, "another Auxiliary draft", "a failed old send must not restore into the selected owner");
    await act(async () => { navigateAuxiliary?.({ parentSessionId: "benchmark-main", auxiliarySessionId: previousAuxiliaryId }); });
    assert.equal(textarea().value, "restore failed send", "the failed send restores only its captured owner");
    assert.deepEqual(alerts, ["Auxiliary admission failed"]);
    alerts.length = 0;

    rejectRun = true;
    failRunRestore = true;
    const recoveryRunFailed = new Promise<void>((resolve) => { notifyRunFailed = resolve; });
    await input("recover after storage failure");
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click();
      await recoveryRunFailed;
    });
    assert.equal(textarea().value, "recover after storage failure");
    assert.equal(drafts.get(previousAuxiliaryId)?.text, "");
    const failedFlushAck = new Promise<void>((resolve) => { notifyFlushAck = resolve; });
    await act(async () => { flushRequest?.({ requestId: "recovery-close", sessionId: "benchmark-main", reason: "close" }); await failedFlushAck; });
    assert.deepEqual(flushAcks, [{ id: "recovery-close", success: false }], "restored unsaved input must prevent a successful close ACK");
    await act(async () => { flushRelease?.({ success: false }); });
    assert.equal(textarea().value, "recover after storage failure");
    assert.ok(dom.window.document.getElementById("composer-save-feedback"));
    failDraftWrites = false;
    const recovered = new Promise<void>((resolve) => { notifySaved = (text) => { if (text === "recover after storage failure") resolve(); }; });
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".composer-save-retry")!.click(); await recovered; });
    assert.equal(drafts.get(previousAuxiliaryId)?.text, "recover after storage failure");
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.disabled, false);
    assert.deepEqual(alerts, ["Auxiliary turn failed and draft restore failed."]);
    alerts.length = 0;
    flushAcks.length = 0;

    heldSave = new Promise<void>((resolve) => { releaseSave = resolve; });
    const preflightSaveStarted = new Promise<void>((resolve) => { notifySaveStarted = resolve; });
    await input("quit during send preflight");
    const sentBeforePreflight = sent.length;
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click();
      await preflightSaveStarted;
    });
    const preflightQuitAck = new Promise<void>((resolve) => { notifyFlushAck = resolve; });
    await act(async () => { flushRequest?.({ requestId: "preflight-quit", sessionId: "benchmark-main", reason: "quit" }); });
    assert.deepEqual(flushAcks, []);
    await act(async () => { releaseSave(); await preflightQuitAck; });
    assert.equal(sent.length, sentBeforePreflight, "preflight must not consume a draft after shutdown freezes input");
    assert.equal(drafts.get(previousAuxiliaryId)?.text, "quit during send preflight");
    assert.deepEqual(flushAcks, [{ id: "preflight-quit", success: true }]);
    await act(async () => { flushRelease?.({ success: false }); });
    flushAcks.length = 0;

    await input("draft before close");
    let releasePicker!: (paths: string[]) => void;
    let copies = 0;
    api.pickFiles = () => new Promise((resolve) => { releasePicker = resolve; });
    api.copyFilesToSessionFiles = async () => { copies += 1; return ["/session/copied.txt"]; };
    const attach = dom.window.document.querySelector<HTMLButtonElement>(".composer-attachment-trigger");
    assert.ok(attach);
    await act(async () => { attach.click(); });
    const copy = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((button) => button.textContent === "Copy")!;
    assert.ok(copy);
    await act(async () => { copy.click(); });
    const flushAck = new Promise<void>((resolve) => { notifyFlushAck = resolve; });
    await act(async () => { flushRequest?.({ requestId: "close-1", sessionId: "benchmark-main", reason: "close" }); });
    assert.equal(textarea().disabled, true, "close freezes editing before awaiting persistence");
    assert.equal(attach.disabled, true);
    await act(async () => { releasePicker(["/picked.txt"]); });
    assert.equal(copies, 0, "picker completion after freeze must not begin copying files");
    assert.equal(textarea().value, "draft before close");
    assert.deepEqual(flushAcks, []);
    await act(async () => { await flushAck; });
    assert.deepEqual(flushAcks, [{ id: "close-1", success: true }]);
    assert.equal(textarea().disabled, true, "successful flush must remain frozen until destruction");
    await act(async () => { flushRelease?.({ success: false }); });
    assert.equal(textarea().disabled, false, "another window's failed quit releases this window");
    assert.equal(textarea().value, "draft before close");
    await target("Main");
    await input("");
    await act(async () => {
      textarea().focus();
      textarea().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", code: "Enter", ctrlKey: true, bubbles: true }));
    });
    assert.equal(dom.window.document.getElementById("composer-sendability-feedback")?.textContent, "Message is empty.");
    await input("invalid reference");
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click(); });
    assert.ok(dom.window.document.body.textContent?.includes("Invalid attachment"));
    await input("fixed draft");
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.disabled, false, "editing must remove the previous revision's preview error");
    await act(async () => {
      textarea().focus();
      textarea().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", code: "Enter", ctrlKey: true, bubbles: true }));
    });
    assert.deepEqual(sent.at(-1), { id: "benchmark-main", text: "fixed draft" }, "keyboard submission must read the same latest draft as Send");
    assert.deepEqual(alerts, []);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
