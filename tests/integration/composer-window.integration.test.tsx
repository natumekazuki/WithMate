import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { AuxiliaryDraftRecord } from "../../src-shared/auxiliary/auxiliary-draft-contract.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";

// @test-value v2
// kind = "contract"
// claim = "実Session Windowは入力と送信revisionをowner別に保ち、複数Auxiliaryのdurable受付を相互にbusy扱いせず、同一Auxiliaryの未確定受付中の重複送信を抑止する。送信時のActionDockはMain/Auxiliaryとも設定を守り、保存待機中の手動開閉を遅い送信で巻き戻さない。受付ACKはcaptured revisionだけを消し、拒否・不明では入力を保持する。不明結果の正本照会で再送せず後続編集を守る。回復操作のbusyは操作と会話に対応し、成功・失敗で解除する。保存・回復失敗は非modal詳細から確認でき、各閉鎖操作とfocus復帰を維持する。回復Detailsの領域は保持し、診断なしでは操作・読み上げの対象から外す。入力名とSend不可理由は対象切替・blank・凍結後も識別可能にする。quitでは未確定受付と後続編集の保存後にACKし、保存失敗では終了を拒否してRetryを保持する。通常closeは受付完了を待たず、凍結後の送信前保存からの受付と添付を止める。Main/AuxiliaryのSendと送信shortcutは設定有効時だけ初回送信時に対象列を追従へ戻し、後続の閲覧や対象切替をACK・受付照会で巻き戻さない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Composer の更新・保存境界; docs/design/desktop-ui.md: Composer診断Details・送信時の先行表示とScroll To Latest On Send" }
// fault = "診断詳細に到達できないか閉鎖時にfocusを失う、診断のない予約領域に操作・読み上げが到達する、入力のたびにAuxiliary一覧summaryのアイコン参照を全件評価する、古いowner/revisionを送信する、別Auxiliaryの送信までbusy扱いする、同一ownerの未確定受付中に重複要求を発行する、設定無効でもActionDockを縮小する、保存待機後に新しい手動開閉を上書きする、ACKで後続編集を消す、拒否でdraftをconsumeする、不明結果から新規要求を自動再送する、後続編集を未保存のままflush成功にする、凍結後にpicker結果からコピーする、設定無効時に末尾へ移動する、初回送信の追従をACKまで遅延する、または後続の閲覧や対象切替をACK・受付照会で巻き戻す"
// observable = "Details予約領域の存続・inert・aria-hidden、診断詳細の原文・expanded・dialog・focusとEscape／閉じる／入口再操作／外側click後の状態、textareaのaccessible name、Send説明ownerのtitle・tabIndex・説明参照、focus時の理由overlay・Escape後のfocus保持、回復操作のaria-busy・spinner・disabledとAPI呼出数、ActionDock expanded class、summaryアイコン参照回数、A/B別の送信対象と同一ownerの送信数、保存要求・永続draft・flush ACK、picker後のコピー回数、Main/Auxiliaryの初回送信・受付ACK・受付照会前後のscrollTop"
// observation_boundary = "component-behavior"
// scope = "composer-window-input-wiring"
// lifecycle = "permanent"
// impact = "多数会話での入力遅延、切替による下書き消失、古い入力や別会話への誤送信を防ぐ"
// distinction = "controller単体や型検査では検出できないApp・ActionDock・workspace・送信adapterの実配線を合成API境界で検証し、設定切替と保存待機中の手動開閉、A受付pending中のB受付、同一Aの重複入力、受付pending→quit待機→ACK→後続編集保存→quit ACKの順序、非選択owner、closeとの違いも確認する。壁時計の性能値をCI合否にしない"
// @end-test-value
test("Session Windowの入力境界と切替後の最新値送信を実配線で守る", { timeout: 30_000 }, async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    url: "http://withmate.test/session.html?sessionId=benchmark-main", pretendToBeVisual: true,
  });
  dom.window.localStorage.setItem("withmate:auxiliary-workspace:benchmark-main", JSON.stringify({ selectedId: null, widthRatio: 0.5 }));
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
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { value(this: HTMLElement) {
    const list = this.closest<HTMLElement>(".session-message-list");
    if (list) list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
  } });
  const alerts: string[] = [];
  dom.window.alert = (message) => { alerts.push(String(message)); };
  let api!: WithMateWindowApi;
  runInNewContext(readFileSync(new URL("../../scripts/benchmarks/benchmark-composer-input-preload.cjs", import.meta.url), "utf8"), {
    require: (name: string) => {
      assert.equal(name, "electron");
      return { contextBridge: { exposeInMainWorld: (_key: string, value: WithMateWindowApi) => { api = value; } } };
    },
    process: { argv: ["--benchmark-auxiliary-count=100", "--benchmark-history=long"] },
    Buffer,
  });

  const getModelCatalog = api.getModelCatalog;
  api.getModelCatalog = async (request) => {
    const snapshot = await getModelCatalog(request);
    return snapshot ? { ...snapshot, workspacePath: request?.workspacePath } : snapshot;
  };
 let summaryReads = 0;
  api.getProviderQuotaTelemetry = async () => null;
  api.subscribeProviderQuotaTelemetry = () => () => {};
  let notifyAppSettings: Parameters<WithMateWindowApi["subscribeAppSettings"]>[0] | undefined;
  api.subscribeAppSettings = (listener) => { notifyAppSettings = listener; return () => { notifyAppSettings = undefined; }; };
  const initialSettings = await api.getAppSettings();
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
    if (!current || current.incarnation !== input.incarnation || current.parentSessionId !== input.parentSessionId || current.durableRevision !== input.expectedDurableRevision) return { outcome: "stale" };
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
  let heldAdmission: Promise<void> | null = null;
  let notifyAdmissionStarted: (() => void) | undefined;
  let notifyAdmissionCompleted: ((id: string) => void) | undefined;
  let rejectAdmission = false;
  let loseAdmissionReply = false;
  let receiptVisible = true;
  let heldReceipt: Promise<void> | null = null;
  let receiptChecks = 0;
  const receipts = new Map<string, SessionTurnQueueReceipt>();
  api.getSessionTurnQueueReceipt = async (id, requestId) => {
    receiptChecks += 1;
    if (heldReceipt) await heldReceipt;
    return receiptVisible ? receipts.get(`${id}:${requestId}`) ?? null : null;
  };
  api.runAuxiliarySessionTurn = async () => { throw new Error("Normal Send must use durable queue admission."); };
  api.previewComposerInput = async (_id, text) => ({ text, attachments: [], errors: text === "invalid reference" ? ["Invalid attachment"] : [] } as Awaited<ReturnType<WithMateWindowApi["previewComposerInput"]>>);
  api.enqueueSessionTurn = async (id, request) => {
    const current = id === "benchmark-main" ? null : await api.getAuxiliaryDraft(id);
    if (id !== "benchmark-main") {
      assert.ok(current);
      assert.equal(request.auxiliaryDraftIncarnation, current.incarnation);
      assert.equal(request.auxiliaryDraftDurableRevision, current.durableRevision);
      assert.equal(request.userMessage, current.text);
    }
    sent.push({ id, text: request.userMessage });
    if (heldAdmission) {
      const wait = heldAdmission;
      heldAdmission = null;
      notifyAdmissionStarted?.();
      await wait;
    }
    if (rejectAdmission) {
      rejectAdmission = false;
      return { state: "rejected", reason: "Auxiliary admission failed" };
    }
    // Admission atomically commits the receipt and captured Auxiliary consume.
    if (current) drafts.set(id, { ...current, text: "", durableRevision: current.durableRevision + 1 });
    const session = await api.getSession(id);
    assert.ok(session);
    const receipt: SessionTurnQueueReceipt = { sessionId: id, incarnationId: request.incarnationId, id: request.clientRequestId!, requestId: request.clientRequestId!, sequence: sent.length, queuePosition: sent.length, state: "queued",
      captured: { request: { ...request, clientRequestId: request.clientRequestId! }, attachments: [], provider: session.provider, workspacePath: session.workspacePath },
      turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: session.updatedAt, updatedAt: session.updatedAt };
    receipts.set(`${id}:${receipt.requestId}`, receipt);
    if (loseAdmissionReply) {
      loseAdmissionReply = false;
      throw new Error("Admission reply lost");
    }
    notifyAdmissionCompleted?.(id);
    return receipt;
  };
  Object.defineProperty(dom.window, "withmate", { value: api });
  const { createRoot } = await import("react-dom/client");
  const cssImports = registerHooks({ load(url, context, next) {
    return url.endsWith(".css") ? { format: "module", shortCircuit: true, source: "" } : next(url, context);
  } });
  const { default: App } = await import("../../src/app/SessionWindowApp.js").finally(() => cssImports.deregister());
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
    assert.equal(textarea().getAttribute("aria-label"), "Message");
  };
  const recoveryButton = (label: string) => {
    const button = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>(".composer-turn-recovery button"))
      .find((item) => item.textContent === label);
    assert.ok(button);
    return button;
  };
  const assertRecoveryBusy = (label: string) => {
    for (const name of ["Check Receipt", "Retry Original Turn"]) {
      const button = recoveryButton(name);
      assert.equal(button.disabled, true);
      assert.equal(button.getAttribute("aria-busy"), name === label ? "true" : null);
      assert.equal(!!button.querySelector(".button-content-spinner"), name === label);
    }
    assert.equal(dom.window.document.querySelector(".composer-control-row .session-send-button")?.getAttribute("aria-busy"), null);
  };
  const focusSendReason = async (reason: RegExp) => {
    const owner = dom.window.document.querySelector<HTMLElement>(".composer-send-control");
    assert.ok(owner);
    assert.equal(owner.tabIndex, 0);
    assert.match(owner.title, reason);
    const description = dom.window.document.getElementById(owner.getAttribute("aria-describedby")!);
    assert.match(description?.textContent ?? "", reason);
    await act(async () => { owner.focus(); });
    assert.equal(dom.window.document.activeElement, owner);
    assert.equal(description?.getAttribute("role"), "tooltip");
    assert.match(description?.textContent ?? "", reason);
    await act(async () => {
      owner.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.equal(description?.getAttribute("role"), null);
    assert.equal(dom.window.document.activeElement, owner, "dismissing the reason must keep keyboard focus");
    await act(async () => { owner.blur(); });
  };
  const readHistory = async (column: "main" | "auxiliary") => {
    const element = dom.window.document.querySelector<HTMLDivElement>(`.session-concurrent-chat-${column} .session-message-list`);
    assert.ok(element);
    Object.defineProperties(element, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    await act(async () => {
      element.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -1, bubbles: true }));
      element.scrollTop = 100;
      element.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    });
    return element;
  };
  const dockExpanded = () => dom.window.document.querySelector(".session-action-dock-slot")?.classList.contains("is-expanded") === true;
  const toggleDock = async () => {
    const button = dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Collapse Action Dock"], button[aria-label="Expand Action Dock"]');
    assert.ok(button);
    await act(async () => { button.click(); });
  };
  try {
    await act(async () => { root.render(<App />); });
    assert.equal(dockExpanded(), true);
    assert.equal(textarea().disabled, false);
    assert.equal(textarea().getAttribute("aria-label"), "Message");
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
    const auxiliaryScroll = await readHistory("auxiliary");
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click(); });
    assert.equal(sent.length, 1, "a restored draft must be sendable without editing first");
    assert.equal(sent[0].text, "restored auxiliary draft");
    assert.equal(textarea().value, "");
    assert.equal(auxiliaryScroll.scrollTop, 800, "Auxiliary Send follows only after durable admission");
    assert.equal(dockExpanded(), true, "disabled auto-collapse keeps Auxiliary Action Dock expanded");
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
    const mainScroll = await readHistory("main");
    await act(async () => { textarea().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })); });
    assert.deepEqual(sent.at(-1), { id: "benchmark-main", text: "hello latest" });
    assert.equal(mainScroll.scrollTop, 800, "Main send shortcut uses the same admitted-send following path");
    assert.equal(textarea().value, "");
    assert.equal(dockExpanded(), true, "disabled auto-collapse keeps Main Action Dock expanded");
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

    let releaseParallelA!: () => void;
    let parallelAuxiliaryAId: string | null = null;
    let parallelAuxiliaryBId: string | null = null;
    let resolveParallelACompleted!: () => void;
    let resolveParallelBCompleted!: () => void;
    const parallelACompleted = new Promise<void>((resolve) => {
      resolveParallelACompleted = resolve;
    });
    const parallelBCompleted = new Promise<void>((resolve) => { resolveParallelBCompleted = resolve; });
    notifyAdmissionCompleted = (id) => {
      if (id === parallelAuxiliaryAId) resolveParallelACompleted();
      if (id === parallelAuxiliaryBId) resolveParallelBCompleted();
    };
    heldAdmission = new Promise<void>((resolve) => { releaseParallelA = resolve; });
    const parallelAAdmissionStarted = new Promise<void>((resolve) => { notifyAdmissionStarted = resolve; });
    await input("Auxiliary A pending");
    const parallelSentStart = sent.length;
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click();
      await parallelAAdmissionStarted;
    });
    parallelAuxiliaryAId = sent.at(-1)!.id;
    parallelAuxiliaryBId = ["benchmark-aux-1", "benchmark-aux-2", "benchmark-aux-3"]
      .find((id) => id !== parallelAuxiliaryAId) ?? null;
    assert.ok(parallelAuxiliaryBId);
    await act(async () => {
      navigateAuxiliary?.({ parentSessionId: "benchmark-main", auxiliarySessionId: parallelAuxiliaryBId });
    });
    assert.equal(textarea().value, "restored auxiliary draft");
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click();
      await parallelBCompleted;
    });
    assert.deepEqual(sent.slice(parallelSentStart), [
      { id: parallelAuxiliaryAId, text: "Auxiliary A pending" },
      { id: parallelAuxiliaryBId, text: "restored auxiliary draft" },
    ], "a pending Auxiliary A admission must not block a distinct Auxiliary B admission");
    await act(async () => {
      releaseParallelA();
      await parallelACompleted;
    });
    notifyAdmissionCompleted = undefined;

    const duplicateAuxiliaryId = ["benchmark-aux-1", "benchmark-aux-2", "benchmark-aux-3"]
      .find((id) => id !== parallelAuxiliaryAId && id !== parallelAuxiliaryBId);
    assert.ok(duplicateAuxiliaryId);
    await act(async () => {
      navigateAuxiliary?.({ parentSessionId: "benchmark-main", auxiliarySessionId: duplicateAuxiliaryId });
    });
    assert.equal(textarea().value, "restored auxiliary draft");
    let releaseDuplicate!: () => void;
    heldAdmission = new Promise<void>((resolve) => { releaseDuplicate = resolve; });
    const duplicateAdmissionStarted = new Promise<void>((resolve) => { notifyAdmissionStarted = resolve; });
    const duplicateCompleted = new Promise<void>((resolve) => {
      notifyAdmissionCompleted = (id) => {
        if (id === duplicateAuxiliaryId) resolve();
      };
    });
    const duplicateSentStart = sent.length;
    const scrolledDuringSend = await readHistory("auxiliary");
    await act(async () => {
      const button = dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button");
      assert.ok(button);
      const click = () => button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      click();
      click();
      await duplicateAdmissionStarted;
    });
    assert.equal(sent.length, duplicateSentStart + 1, "the same Auxiliary ID must admit one in-flight send");
    assert.equal(sent.at(-1)?.id, duplicateAuxiliaryId);
    assert.equal(scrolledDuringSend.scrollTop, 800, "initial submission follows before admission completes");
    await readHistory("auxiliary");
    await act(async () => {
      releaseDuplicate();
      await duplicateCompleted;
    });
    notifyAdmissionCompleted = undefined;
    assert.equal(scrolledDuringSend.scrollTop, 100, "new upward scroll intent during admission wins over the old send capture");

    let releaseAdmission!: () => void;
    heldAdmission = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const admissionStarted = new Promise<void>((resolve) => { notifyAdmissionStarted = resolve; });
    await input("switch during send");
    const switchedScroll = await readHistory("auxiliary");
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click();
      await admissionStarted;
    });
    assert.equal(textarea().value, "switch during send", "an unacknowledged admission must preserve the captured draft");
    assert.equal(switchedScroll.scrollTop, 800, "initial submission follows while admission is pending");
    await readHistory("auxiliary");
    await target("Main");
    await input("Main while Auxiliary sends");
    const runningCloseAck = new Promise<void>((resolve) => { notifyFlushAck = resolve; });
    await act(async () => {
      flushRequest?.({ requestId: "running-close", sessionId: "benchmark-main", reason: "close" });
      await runningCloseAck;
    });
    assert.deepEqual(flushAcks, [{ id: "running-close", success: true }], "normal close must not wait for the hidden owner's admission result");
    const runningQuitAck = new Promise<void>((resolve) => { notifyFlushAck = resolve; });
    await act(async () => { flushRequest?.({ requestId: "running-quit", sessionId: "benchmark-main", reason: "quit" }); });
    assert.equal(flushAcks.length, 1, "quit cannot reuse a save-only close ACK while a hidden owner's send is pending");
    await act(async () => { releaseAdmission(); await runningQuitAck; });
    assert.deepEqual(flushAcks.at(-1), { id: "running-quit", success: true });
    await act(async () => { flushRelease?.({ success: false }); });
    flushAcks.length = 0;
    assert.equal(textarea().value, "Main while Auxiliary sends", "another owner's admission ACK must preserve Main input");
    assert.equal(switchedScroll.scrollTop, 100, "switching targets invalidates an old pending admission's following intent");
    await target("Auxiliary");
    assert.equal(textarea().value, "", "a consumed draft must not reappear after switching back");

    // An edit after capture stays pending until the admission consume revision
    // is available; quit must persist that edit before acknowledging shutdown.
    heldAdmission = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const frozenAdmissionStarted = new Promise<void>((resolve) => { notifyAdmissionStarted = resolve; });
    await input("captured before quit");
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click();
      await frozenAdmissionStarted;
    });
    const frozenAuxiliaryId = sent.at(-1)!.id;
    await input("new draft during admission");
    const frozenFlushAck = new Promise<void>((resolve) => { notifyFlushAck = resolve; });
    await act(async () => {
      flushRequest?.({ requestId: "pending-draft-quit", sessionId: "benchmark-main", reason: "quit" });
    });
    assert.deepEqual(flushAcks, [], "quit must not ACK before the pending send settles");
    assert.equal(textarea().disabled, true, "flush freezes editing while the send is pending");
    assert.equal(textarea().value, "new draft during admission", "the later edit remains visible while acceptance is pending");
    failDraftWrites = true;
    const pendingDraftWriteFailed = new Promise<void>((resolve) => { notifyDraftSaveFailed = resolve; });
    await act(async () => { releaseAdmission(); await pendingDraftWriteFailed; await frozenFlushAck; });
    assert.deepEqual(flushAcks, [{ id: "pending-draft-quit", success: false }], "a later edit's failed save must prevent quit");
    notifyDraftSaveFailed = undefined;
    assert.equal(textarea().value, "new draft during admission", "the admission ACK must not clear a newer revision during freeze");
    assert.equal(textarea().disabled, true, "save failure does not release the shutdown freeze");
    assert.equal(drafts.get(frozenAuxiliaryId)?.text, "", "the captured draft was consumed but the newer draft is not yet durable");
    await act(async () => { flushRelease?.({ success: false }); });
    assert.equal(textarea().disabled, false, "failed shutdown release restores editing");
    assert.ok(dom.window.document.getElementById("composer-save-feedback"), "the failed pending save remains retryable after release");
    const inspectErrorDetails = async (label: string, expected: RegExp) => {
      const trigger = dom.window.document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
      assert.ok(trigger);
      assert.equal(trigger.getAttribute("aria-expanded"), "false");
      assert.equal(dom.window.document.querySelector(".composer-error-details-popover"), null);
      await act(async () => { trigger.focus(); trigger.click(); });
      const panel = dom.window.document.getElementById(trigger.getAttribute("aria-controls")!)!;
      assert.equal(trigger.getAttribute("aria-expanded"), "true");
      assert.equal(panel.getAttribute("role"), "dialog");
      assert.equal(panel.getAttribute("aria-label"), label);
      assert.match(panel.querySelector("p")?.textContent ?? "", expected);
      assert.equal(dom.window.document.activeElement, panel);
      await act(async () => { panel.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      assert.equal(trigger.getAttribute("aria-expanded"), "false");
      assert.equal(dom.window.document.activeElement, trigger);
      await act(async () => { trigger.click(); });
      await act(async () => { dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Close Error Details"]')!.click(); });
      assert.equal(trigger.getAttribute("aria-expanded"), "false");
      assert.equal(dom.window.document.activeElement, trigger);
      await act(async () => { trigger.click(); });
      await act(async () => { trigger.click(); });
      assert.equal(trigger.getAttribute("aria-expanded"), "false");
      await act(async () => { trigger.click(); });
      await act(async () => {
        textarea().dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
        textarea().focus();
      });
      assert.equal(trigger.getAttribute("aria-expanded"), "false");
      assert.equal(dom.window.document.activeElement, textarea(), "outside interaction keeps its focus");
    };
    await inspectErrorDetails("Draft Save Error Details", /Draft could not be saved/);
    failDraftWrites = false;
    const pendingDraftSaved = new Promise<void>((resolve) => { notifySaved = (text) => { if (text === "new draft during admission") resolve(); }; });
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-save-retry")!.click();
      await pendingDraftSaved;
    });
    assert.equal(drafts.get(frozenAuxiliaryId)?.text, "new draft during admission", "retry must CAS-save the later draft against the post-consume revision");
    const pendingDraftFlushAck = new Promise<void>((resolve) => { notifyFlushAck = resolve; });
    await act(async () => { flushRequest?.({ requestId: "pending-draft-retry", sessionId: "benchmark-main", reason: "quit" }); await pendingDraftFlushAck; });
    assert.deepEqual(flushAcks.at(-1), { id: "pending-draft-retry", success: true }, "retry must be persisted before the subsequent close ACK");
    await act(async () => { flushRelease?.({ success: false }); });
    assert.deepEqual(alerts, []);
    alerts.length = 0;
    flushAcks.length = 0;

    const previousAuxiliaryId = sent.at(-1)!.id;
    heldAdmission = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const rejectedAdmissionStarted = new Promise<void>((resolve) => { notifyAdmissionStarted = resolve; });
    rejectAdmission = true;
    await input("rejected admission draft");
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click();
      await rejectedAdmissionStarted;
    });
    const rejectedDraft = { ...drafts.get(previousAuxiliaryId)! };
    await act(async () => { navigateAuxiliary?.({ parentSessionId: "benchmark-main", auxiliarySessionId: "benchmark-aux-1" }); });
    await input("another Auxiliary draft");
    const hiddenRejectionAck = new Promise<void>((resolve) => { notifyFlushAck = resolve; });
    await act(async () => { flushRequest?.({ requestId: "hidden-rejection-quit", sessionId: "benchmark-main", reason: "quit" }); });
    assert.deepEqual(flushAcks, [], "quit must include the non-selected owner's pending send");
    await act(async () => { releaseAdmission(); await hiddenRejectionAck; });
    assert.deepEqual(flushAcks, [{ id: "hidden-rejection-quit", success: true }]);
    assert.equal(rejectedDraft.text, "rejected admission draft");
    assert.deepEqual(drafts.get(previousAuxiliaryId), rejectedDraft, "a rejected admission must preserve the saved text and durable revision before quit ACK");
    await act(async () => { flushRelease?.({ success: false }); });
    flushAcks.length = 0;
    assert.equal(textarea().value, "another Auxiliary draft", "a rejected old admission must not alter the selected owner");
    await act(async () => { navigateAuxiliary?.({ parentSessionId: "benchmark-main", auxiliarySessionId: previousAuxiliaryId }); });
    assert.equal(textarea().value, "rejected admission draft", "the rejected admission preserves only its captured owner");
    assert.equal(dom.window.document.querySelector("#session-auxiliary-chat-pane .message-row.assistant .session-run-failure p")?.textContent, "Auxiliary admission failed");
    assert.deepEqual(alerts, []);
    alerts.length = 0;

    loseAdmissionReply = true;
    receiptVisible = false;
    await input("unknown admission draft");
    const uncertainScroll = await readHistory("auxiliary");
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click();
    });
    assert.equal(textarea().value, "unknown admission draft", "a missing ACK must not clear the captured draft");
    assert.equal(uncertainScroll.scrollTop, 800, "initial submission follows even when the ACK is lost");
    await readHistory("auxiliary");
    assert.equal(drafts.get(previousAuxiliaryId)?.text, "");
    const sentBeforeCheck = sent.length;
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.disabled, true);
    assert.match(dom.window.document.querySelector("#session-auxiliary-chat-pane .pending-run-error-note")?.textContent ?? "", /acceptance could not be confirmed/);
    assert.deepEqual(alerts, []);
    const unknownDraftSaved = new Promise<void>((resolve) => { notifySaved = (text) => { if (text === "new draft after unknown admission") resolve(); }; });
    await input("new draft after unknown admission");
    const assertRecoveryDetailsSlot = (available: boolean) => {
      const slot = dom.window.document.querySelector(".composer-turn-recovery-details")!;
      assert.ok(slot, "recovery keeps a Details slot across pending and failure");
      assert.equal(slot.hasAttribute("inert"), !available);
      assert.equal(slot.getAttribute("aria-hidden"), String(!available));
      assert.ok(slot.querySelector('button[aria-label="Turn Recovery Error Details"]'));
    };
    assertRecoveryDetailsSlot(false);
    let releaseReceipt!: () => void;
    heldReceipt = new Promise<void>((resolve) => { releaseReceipt = resolve; });
    const checksBeforeRecovery = receiptChecks;
    await act(async () => { recoveryButton("Check Receipt").click(); });
    assertRecoveryBusy("Check Receipt");
    assertRecoveryDetailsSlot(false);
    await act(async () => { recoveryButton("Check Receipt").click(); recoveryButton("Retry Original Turn").click(); });
    assert.equal(receiptChecks, checksBeforeRecovery + 1, "busy controls must not issue another recovery request");
    await target("Main");
    assert.equal(dom.window.document.querySelector(".composer-turn-recovery"), null);
    await target("Auxiliary");
    assertRecoveryBusy("Check Receipt");
    await act(async () => { releaseReceipt(); await heldReceipt; });
    heldReceipt = null;
    assert.deepEqual(alerts, [], "recovery errors stay in the affected Composer instead of a modal alert");
    assertRecoveryDetailsSlot(true);
    await inspectErrorDetails("Turn Recovery Error Details", /No receipt is available/);
    await target("Main");
    assert.equal(dom.window.document.querySelector('button[aria-label="Turn Recovery Error Details"]'), null);
    await target("Auxiliary");
    assert.equal(recoveryButton("Check Receipt").disabled, false);
    assert.equal(recoveryButton("Check Receipt").getAttribute("aria-busy"), null);

    const enqueue = api.enqueueSessionTurn;
    let releaseRetry!: () => void;
    const retryPending = new Promise<void>((resolve) => { releaseRetry = resolve; });
    api.enqueueSessionTurn = async () => { await retryPending; throw new Error("Retry transport unavailable"); };
    await act(async () => { recoveryButton("Retry Original Turn").click(); });
    assertRecoveryBusy("Retry Original Turn");
    assertRecoveryDetailsSlot(false);
    await act(async () => { releaseRetry(); await retryPending; });
    api.enqueueSessionTurn = enqueue;
    assert.deepEqual(alerts, []);
    assertRecoveryDetailsSlot(true);
    await inspectErrorDetails("Turn Recovery Error Details", /Retry transport unavailable/);
    assert.equal(recoveryButton("Retry Original Turn").disabled, false);
    assert.equal(recoveryButton("Retry Original Turn").getAttribute("aria-busy"), null);
    receiptVisible = true;
    await act(async () => {
      const check = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Check Receipt");
      assert.ok(check);
      check.click();
    });
    assert.equal(sent.length, sentBeforeCheck, "receipt recovery must not enqueue a new request");
    assert.equal(uncertainScroll.scrollTop, 100, "receipt recovery must preserve later browsing without repeating send following");
    assert.equal(textarea().value, "new draft after unknown admission", "recovered ACK must preserve the newer edit");
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.disabled, false);
    await act(async () => { await unknownDraftSaved; });
    assert.equal(drafts.get(previousAuxiliaryId)?.text, "new draft after unknown admission");
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

    heldSave = new Promise<void>((resolve) => { releaseSave = resolve; });
    const closeSaveStarted = new Promise<void>((resolve) => { notifySaveStarted = resolve; });
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
    await act(async () => {
      flushRequest?.({ requestId: "close-1", sessionId: "benchmark-main", reason: "close" });
      await closeSaveStarted;
    });
    assert.equal(textarea().disabled, true, "close freezes editing before awaiting persistence");
    await focusSendReason(/Input is frozen/);
    assert.equal(attach.disabled, true);
    await act(async () => { releasePicker(["/picked.txt"]); });
    assert.equal(copies, 0, "picker completion after freeze must not begin copying files");
    assert.equal(textarea().value, "draft before close");
    assert.deepEqual(flushAcks, []);
    await act(async () => { releaseSave(); await flushAck; });
    assert.equal(drafts.get(previousAuxiliaryId)?.text, "draft before close");
    assert.deepEqual(flushAcks, [{ id: "close-1", success: true }]);
    assert.equal(textarea().disabled, true, "successful flush must remain frozen until destruction");
    await act(async () => { flushRelease?.({ success: false }); });
    assert.equal(textarea().disabled, false, "another window's failed quit releases this window");
    assert.equal(textarea().value, "draft before close");
    await target("Main");
    await input("");
    assert.equal(dom.window.document.getElementById("composer-sendability-feedback"), null, "blank draft has no constant helper text");
    await focusSendReason(/Message is empty/);
    await act(async () => {
      textarea().focus();
      textarea().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", code: "Enter", ctrlKey: true, bubbles: true }));
    });
    assert.equal(dom.window.document.getElementById("composer-sendability-feedback")?.textContent, "Message is empty.");
    await input("invalid reference");
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click(); });
    assert.ok(dom.window.document.body.textContent?.includes("Invalid attachment"));
    await input("fixed draft");
    await act(async () => { notifyAppSettings?.({ ...initialSettings, scrollToLatestOnSend: false }); });
    const disabledSendScroll = await readHistory("main");
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.disabled, false, "editing must remove the previous revision's preview error");
    await act(async () => {
      textarea().focus();
      textarea().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", code: "Enter", ctrlKey: true, bubbles: true }));
    });
    assert.deepEqual(sent.at(-1), { id: "benchmark-main", text: "fixed draft" }, "keyboard submission must read the same latest draft as Send");
    assert.equal(disabledSendScroll.scrollTop, 100, "disabled Scroll To Latest On Send keeps history even after shortcut admission");
    assert.deepEqual(alerts, []);

    await act(async () => { notifyAppSettings?.({ ...initialSettings, autoCollapseActionDockOnSend: true }); });
    await input("Main auto collapse");
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click(); });
    assert.equal(dockExpanded(), false, "a fresh Main send follows enabled auto-collapse");
    await toggleDock();
    assert.equal(dockExpanded(), true);
    await target("Auxiliary");
    heldSave = new Promise<void>((resolve) => { releaseSave = resolve; });
    const dockSaveStarted = new Promise<void>((resolve) => { notifySaveStarted = resolve; });
    await input("Auxiliary pending dock intent");
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click();
      await dockSaveStarted;
    });
    assert.equal(dockExpanded(), false, "initial submission collapses the dock before draft persistence completes");
    await toggleDock();
    assert.equal(dockExpanded(), true);
    const dockAdmissionCompleted = new Promise<void>((resolve) => { notifyAdmissionCompleted = () => resolve(); });
    await act(async () => { releaseSave(); await dockAdmissionCompleted; });
    assert.equal(dockExpanded(), true, "a delayed Auxiliary send preserves the newer manual dock intent");
    notifyAdmissionCompleted = undefined;
    await input("Auxiliary auto collapse");
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button")!.click(); });
    assert.equal(dockExpanded(), false, "a fresh Auxiliary send follows enabled auto-collapse");
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
