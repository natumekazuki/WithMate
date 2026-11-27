import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BrowserWindow, IpcMain, MenuItemConstructorOptions, MessageBoxOptions, PopupOptions } from "electron";
import { AuxiliaryLiveRunParents } from "../../src-electron/auxiliary/auxiliary-live-run-parents.js";
import { registerMainIpcHandlers } from "../../src-electron/ipc/register-main-ipc.js";
import { createWithMateWindowApi } from "../../src-electron/preload/preload-api.js";
import { readHomeCrewCloseRunIdentities } from "../../src-electron/session/home-crew-close-runs.js";
import { HomeCrewContextMenuService } from "../../src-electron/session/home-crew-context-menu-service.js";
import { readHomeCrewPage } from "../../src-electron/session/home-crew-query.js";
import { SessionRuntimeService } from "../../src-electron/session/session-runtime-service.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import type { DraftFlushRequest } from "../../src-electron/platform/draft-flush-coordinator.js";
import { TerminalService } from "../../src-electron/terminal/terminal-service.js";
import type { TerminalPty } from "../../src-electron/terminal/utility-terminal-pty.js";
import { SessionWindowBridge, type SessionWindowCloseEvent } from "../../src-electron/windows/session-window-bridge.js";
import { WindowBroadcastService } from "../../src-electron/windows/window-broadcast-service.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { buildNewSession, getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";

class TestWindow {
  private readonly events = new EventEmitter();
  private destroyed = false;
  readonly webContents = new EventEmitter() as EventEmitter & { isDestroyed(): boolean; send(): void };
  failClose = false;
  constructor(readonly id: number) {
    this.webContents.isDestroyed = () => this.destroyed;
    this.webContents.send = () => {};
  }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  minimize() {}
  restore() {}
  focus() {}
  show() {}
  once(event: "ready-to-show", listener: () => void) { this.events.once(event, listener); }
  on(event: "close" | "closed", listener: ((event: SessionWindowCloseEvent) => void) | (() => void)) { this.events.on(event, listener); }
  close() {
    if (this.failClose) throw new Error("BrowserWindow could not close");
    let prevented = false;
    this.events.emit("close", { preventDefault() { prevented = true; } });
    if (!prevented) this.destroy();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.events.emit("closed");
  }
  asBrowserWindow() { return this as unknown as BrowserWindow; }
}

function newSession(id: string, parentSessionId: string | null = null, sessionRole: Session["sessionRole"] = "standalone", rootSessionId = "root"): Session {
  return {
    ...buildNewSession({ id, parentSessionId, rootSessionId, createdBySessionId: parentSessionId, sessionRole, taskTitle: `Title ${id}`,
      workspaceLabel: "test", workspacePath: process.cwd(), branch: "test",
      characterId: "mate", character: "Mate", characterIconPath: "", characterThemeColors: { main: "#000000", sub: "#ffffff" },
      approvalMode: DEFAULT_APPROVAL_MODE }),
    incarnationId: `${id}-incarnation`,
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

function newAuxiliary(parent: Session, id: string): AuxiliarySession {
  const { provider, catalogRevision, model, reasoningEffort, approvalMode, codexSandboxMode, codexSpeed, codexReviewer, characterId } = parent;
  return {
    id, parentSessionId: parent.id, runState: "idle", title: id, provider, catalogRevision, model, reasoningEffort,
    approvalMode, codexSandboxMode, codexSpeed, codexReviewer, customAgentName: "", threadId: "", composerDraft: "",
    messages: [], displayAfterMessageIndex: null, createdAt: parent.updatedAt, updatedAt: parent.updatedAt, characterId,
    characterRuntimeSnapshot: parent.characterRuntimeSnapshot, characterIconPath: parent.characterIconPath,
  };
}

function connectIpc(home: TestWindow, ports: Pick<Parameters<typeof registerMainIpcHandlers>[1]["window"], "listHomeCrewPage" | "showHomeCrewContextMenu">) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcMain = { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler), on() {} };
  const homeFrame = {};
  const homeSender = { mainFrame: homeFrame, session: {}, window: home };
  const window = { ...ports, resolveHomeWindow: () => home.asBrowserWindow(),
    resolveEventWindow: (event: { sender: { window: TestWindow } }) => event.sender.window.asBrowserWindow() };
  registerMainIpcHandlers(ipcMain as unknown as IpcMain, {
    window, common: {}, auxiliary: {}, catalog: {}, settings: {}, promptTemplates: {},
    sessionQuery: {}, sessionRuntime: {}, mate: {}, character: {},
  } as unknown as Parameters<typeof registerMainIpcHandlers>[1]);
  const apiFor = (sender: typeof homeSender, senderFrame: object | null) => createWithMateWindowApi({
    invoke: async (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender, senderFrame }, ...args), on() {}, removeListener() {}, send() {},
  } as unknown as Parameters<typeof createWithMateWindowApi>[0]);
  return {
    api: apiFor(homeSender, homeFrame),
    iframe: apiFor(homeSender, {}),
    other: apiFor({ ...homeSender, window: new TestWindow(99) }, homeFrame),
  };
}

// @test-value v2
// kind = "contract"
// claim = "Home Crewは現incarnationの実WindowがあるCrewの保存済み全階層をページ取得し、古い一覧世代の続きを拒否する"
// oracle = { type = "contract", ref = "docs/design/window-architecture.md#home-crewのデータとwindow操作" }
// fault = "Monitor保持IDや旧incarnationのWindowを掲載する、閉じた枝を落とす、別世代の続きcursorを受け付ける"
// observable = "Home preloadへのMainとAuxiliaryのsummary、Window開閉・live・未読、無効化後の続きの拒否"
// observation_boundary = "public-boundary"
// scope = "preloadとMain IPCを経由する実Storage WorkerのHome Crew取得"
// lifecycle = "permanent"
// distinction = "SQL単体やrenderer fixtureではWorker allowlist・open registry・ページ境界の組合せを検証できない"
// @end-test-value
test("Home Crew pages join real Window IDs to the saved hierarchy through preload, IPC and SQLite Worker", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "withmate-home-crew-"));
  const bootstrap = await createOrVerifyV6FreshDatabase(userDataPath);
  const bundle = createV6StorageWorkerBundle({ dbPath: bootstrap.dbPath, userDataPath,
    workerUrl: new URL("../../src-electron/storage/storage-worker-entry.ts", import.meta.url),
    handlerModule: new URL("../../src-electron/storage/storage-worker-bundle.ts", import.meta.url), workerOptions: { execArgv: ["--import", "tsx"] } });
  try {
    await bundle.initialize();
    const root = newSession("root", null, "overall-coordinator");
    const middle = newSession("closed-middle", root.id, "task-coordinator");
    const open = newSession("open-leaf", middle.id, "executor");
    const closed = newSession("closed-leaf", middle.id, "executor");
    const lone = newSession("standalone");
    const retained = newSession("monitor-only");
    const stale = newSession("stale-window");
    const sessions = new Map([root, middle, open, closed, lone, retained, stale].map((session) => [session.id, session]));
    for (const session of sessions.values()) sessions.set(session.id, await bundle.stores.session.insertSession(session));
    const auxiliary = newAuxiliary(middle, "middle-aux");
    await bundle.stores.auxiliary.upsertAuxiliarySession(auxiliary);
    const home = new TestWindow(1);
    const broadcast = new WindowBroadcastService({ getAllWindows: () => [], getHomeWindows: () => [home],
      getPrimaryHomeWindow: () => home, getSessionWindows: () => [], getLiveSessionRunStatusWindows: () => [], getLiveSessionRunWindow: () => null });
    const bridge = new SessionWindowBridge({ createWindow: () => new TestWindow(2), async loadChatEntry() {},
      getSession: (id) => sessions.get(id) ?? null, isRunInFlight: () => false, confirmCloseWhileRunning: () => false,
      broadcastOpenSessionWindowIds: (ids) => broadcast.broadcastOpenSessionWindowIds(ids) });
    await bridge.openSessionWindow(open.id);
    await bridge.openSessionWindow(lone.id);
    const saved = sessions.get(stale.id)!;
    sessions.set(stale.id, { ...saved, incarnationId: "old-incarnation" });
    await bridge.openSessionWindow(stale.id);
    sessions.set(stale.id, saved);
    bridge.retainSessionForMonitor(retained.id);
    let invalidateWhileReadingAuxiliaries = false;
    const { api } = connectIpc(home, {
      listHomeCrewPage: (request) => readHomeCrewPage({
        getGeneration: () => `${bundle.client.generationId}:${broadcast.getHomeCrewRevision()}`,
        listOpenSessionWindows: () => bridge.listOpenSessionWindowIdentities(),
        readMembers: (...args) => bundle.stores.session.listHomeCrewMembersPage(...args),
        readAuxiliarySummaries: async (ids) => {
          const rows = await bundle.stores.auxiliary.listAuxiliarySessionSummaries(ids);
          if (invalidateWhileReadingAuxiliaries) broadcast.broadcastSessionInvalidation({ scope: "all" });
          return rows;
        },
        getLiveSessionRun: (id) => id === auxiliary.id ? {
          sessionId: id, threadId: "thread", assistantText: "", reasoningText: "", steps: [], backgroundTasks: [],
          usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null, runState: "running", cancellationState: "requested",
        } : null,
        hasUnreadResult: (id) => id === middle.id,
      }, request),
      showHomeCrewContextMenu: () => assert.fail("No menu is required for listing"),
    });
    const readAll = async () => {
      const first = await api.listHomeCrewPage({ limit: 2 });
      assert.equal(first.entries.length, 2);
      assert.ok(first.hasMore && first.nextCursor);
      const second = await api.listHomeCrewPage({ limit: 2, cursor: first.nextCursor });
      assert.ok(second.hasMore && second.nextCursor);
      const last = await api.listHomeCrewPage({ limit: 2, cursor: second.nextCursor });
      assert.equal(last.hasMore, false);
      assert.equal(last.nextCursor, null);
      const entries = [first, second, last].flatMap((page) => page.entries);
      assert.deepEqual(entries.map(({ id, parentSessionId, rootSessionId, isWindowOpen }) => [id, parentSessionId, rootSessionId, isWindowOpen]), [
        [closed.id, middle.id, root.id, false], [middle.id, root.id, root.id, false], [open.id, middle.id, root.id, true],
        [root.id, null, root.id, false], [lone.id, null, lone.id, true],
      ]);
      assert.equal(entries.find(({ id }) => id === root.id)?.incarnationId, sessions.get(root.id)?.incarnationId);
      assert.equal(entries.find(({ id }) => id === root.id)?.createdAt, root.updatedAt);
      assert.equal(entries.find(({ id }) => id === middle.id)?.hasUnreadResult, true);
      assert.deepEqual(first.auxiliarySessions.map(({ id, parentSessionId, runState, cancellationState }) => [id, parentSessionId, runState, cancellationState]),
        [[auxiliary.id, middle.id, "running", "requested"]]);
      assert.equal(second.auxiliarySessions.length + last.auxiliarySessions.length, 0);
      return first.nextCursor;
    };
    const oldCursor = await readAll();
    invalidateWhileReadingAuxiliaries = true;
    await assert.rejects(api.listHomeCrewPage(), /changed while loading/);
    invalidateWhileReadingAuxiliaries = false;
    const beforeClose = await api.listHomeCrewPage({ limit: 2 });
    assert.ok(beforeClose.nextCursor && beforeClose.nextCursor !== oldCursor);
    assert.equal(await bridge.requestCloseSessionWindow(open.id), true);
    await assert.rejects(api.listHomeCrewPage({ cursor: beforeClose.nextCursor }), /changed while loading/);
    assert.deepEqual((await api.listHomeCrewPage()).entries.map(({ id }) => id), [lone.id]);
  } finally {
    await bundle.client.close();
    await rm(userDataPath, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Home Crewの取得とメニューはHome main frameからだけ呼べ、メニューへの対象配列やガード指示を拒否する"
// oracle = { type = "contract", ref = "docs/design/window-architecture.md#home-crewのデータとwindow操作" }
// fault = "iframeや別Windowを認可する、rendererの追加指示をMain操作へ渡す、preload channelの結線を欠く"
// observable = "両公開APIの許可応答・拒否例外と許可されたdelegate呼出しだけの記録"
// observation_boundary = "public-boundary"
// scope = "preloadと登録Main handlerの送信者・request境界"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// @end-test-value
test("Home Crew IPC invokes only from the Home main frame and accepts identity and point, not batch inputs", async () => {
  const menuRequests: unknown[] = [];
  let reads = 0;
  const { api, iframe, other } = connectIpc(new TestWindow(1), {
    listHomeCrewPage: () => { reads++; return { entries: [], auxiliarySessions: [], nextCursor: null, hasMore: false }; },
    showHomeCrewContextMenu: (_home, request) => { menuRequests.push(request); return { status: "dismissed" }; },
  });
  const request = { sessionId: "parent", incarnationId: "incarnation", point: { x: 10, y: 20 } };
  assert.equal((await api.listHomeCrewPage()).entries.length, 0);
  assert.deepEqual(await api.showHomeCrewContextMenu(request), { status: "dismissed" });
  for (const client of [iframe, other]) {
    await assert.rejects(client.listHomeCrewPage(), /Home main frame/);
    await assert.rejects(client.showHomeCrewContextMenu(request), /Home main frame/);
  }
  await assert.rejects(api.listHomeCrewPage({ limit: 101 }), /page request/i);
  for (const invalid of [{ ...request, targets: ["child"] }, { ...request, skipConfirmation: true },
    { ...request, approved: true }, { ...request, incarnationId: " " }, { ...request, point: { x: -1, y: 20 } }]) {
    await assert.rejects(api.showHomeCrewContextMenu(invalid), TypeError);
  }
  assert.equal(reads, 1);
  assert.deepEqual(menuRequests, [request]);
});

function menuFixture() {
  const owner = {};
  const root = newSession("root", null, "overall-coordinator");
  const parent = newSession("parent", root.id, "task-coordinator");
  const first = newSession("first", parent.id, "executor");
  const second = newSession("second", parent.id, "executor");
  const third = newSession("third", parent.id, "executor");
  const sibling = newSession("sibling", root.id, "executor");
  const sessions = new Map([root, parent, first, second, third, sibling].map((entry) => [entry.id, entry]));
  const ptys: { activity: ReturnType<TerminalPty["getActivity"]>; kills: number }[] = [];
  const confirmations: MessageBoxOptions[] = [];
  const singleConfirmations: string[] = [];
  const clipboard: string[] = [];
  const flushes: string[] = [];
  const releases: { window: TestWindow; success: boolean }[] = [];
  const currentAdmissions = new Map<string, { promise: Promise<void>; finish(): void }>();
  const unexpected = () => assert.fail("Fixture must stop at admission, before provider work");
  const runtime = new SessionRuntimeService({
    runSessionAdmissionExclusive: async (id) => {
      await currentAdmissions.get(id)!.promise;
      throw new Error("fixture admission finished");
    },
    getSession: unexpected, persistRunningTurnStart: unexpected, appendRunningInput: unexpected,
    appendTerminalSession: unexpected, checkpointRuntimeMetadata: unexpected,
    resolveComposerPreview: unexpected, getAppSettings: unexpected, resolveProviderCatalog: unexpected,
    getProviderCodingAdapter: unexpected, createSessionTurn: unexpected, updateSessionTurn: unexpected,
    setLiveSessionRun() {}, getLiveSessionRun: () => null, broadcastLiveSessionRun() {},
    waitForApprovalDecision: unexpected, waitForElicitationResponse: unexpected,
    setProviderQuotaTelemetry() {}, setSessionContextTelemetry() {}, invalidateProviderSessionThread() {},
    scheduleProviderQuotaTelemetryRefresh() {}, resolvePendingApprovalRequest() {}, resolvePendingElicitationRequest() {},
  });
  const parents = new AuxiliaryLiveRunParents({ getStorageOwner: () => owner, isRunPending: (id) => runtime.isRunInFlight(id),
    hasLiveSessionRun: () => false, broadcastLiveSessionRun() {} });
  const readRuns = (id: string) => readHomeCrewCloseRunIdentities(id, { mainRuntime: runtime, auxiliaryRuntime: runtime,
    directAuxiliaryRuns: new Map(), liveAuxiliaryParents: parents });
  let nextWindowId = 2;
  const controls = {
    beforeConfirm: async () => true,
    beforeDraftAcknowledgment: async (_request: DraftFlushRequest) => true,
    readSession: async (id: string) => sessions.get(id) ?? null,
  };
  const bridge: SessionWindowBridge<TestWindow> = new SessionWindowBridge({
    createWindow: () => new TestWindow(nextWindowId++), async loadChatEntry() {}, getSession: (id) => sessions.get(id) ?? null,
    isRunInFlight: (id) => runtime.isRunInFlight(id) || parents.hasPendingRunForParent(id),
    getTerminalCloseConfirmationCount: (window) => terminals.countRequiringCloseConfirmation(window),
    confirmCloseWhileRunning: (_window, id) => { singleConfirmations.push(id); return false; },
    broadcastOpenSessionWindowIds() {}, onSessionWindowClosed: (id) => terminals.releaseSession(id),
    getWindowSender: (window) => window,
    sendDraftFlushRequest: (window, request) => {
      flushes.push(request.sessionId);
      void controls.beforeDraftAcknowledgment(request).then((ok) => bridge.acknowledgeDraftFlush(request.requestId, window, ok));
    },
    sendDraftFlushRelease: (window, { success }) => releases.push({ window, success }),
  });
  const terminals = new TerminalService<TestWindow>({
    resolveOwner: (window) => {
      const id = bridge.listOpenSessionWindowIds().find((id) => bridge.getWindow(id) === window);
      return id && window instanceof TestWindow ? { window, sessionId: id, workspacePath: process.cwd() } : null;
    },
    confirmClose: async () => assert.fail("Batch must not show an individual Terminal prompt"), sendEvent() {},
    resolveShell: async () => ({ file: "fixture", shellName: "fixture" }),
    async spawn() {
      const pty = { activity: "idle" as ReturnType<TerminalPty["getActivity"]>, kills: 0 };
      ptys.push(pty);
      const listener = () => ({ dispose() {} });
      return { getActivity: () => pty.activity, kill: () => { pty.kills++; }, onData: listener, onError: listener, onExit: listener,
        write() {}, resize() {}, pause() {}, resume() {} };
    },
  });
  const createTerminal = async (window: TestWindow, ordinal: number, activity: ReturnType<TerminalPty["getActivity"]> = "idle") => {
    const id = `a0000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
    await terminals.create(window, { terminalId: id, cols: 100, rows: 30 });
    const pty = ptys.at(-1)!;
    pty.activity = activity;
    return { id, pty, release: () => terminals.release(window, id) };
  };
  const runAuxiliary = (session: Session, id: string) => {
    const admission = Promise.withResolvers<void>();
    currentAdmissions.set(id, { promise: admission.promise, finish: () => admission.resolve() });
    const pending = parents.trackRun({ id, parentSessionId: session.id }, owner, () => runtime.runSessionTurn(id, {
      userMessage: "fixture", executionOptions: captureSessionExecutionOptions(session),
    }));
    const settled = assert.rejects(pending, /fixture admission finished/);
    return { finish: async () => { admission.resolve(); await settled; currentAdmissions.delete(id); } };
  };
  let menuReady = Promise.withResolvers<{ template: MenuItemConstructorOptions[]; popup: PopupOptions }>();
  const home = new TestWindow(1);
  const menu = new HomeCrewContextMenuService({ bridge, getStoreOwner: () => owner,
    listSessions: () => [...sessions.values()], readSavedSession: (_owner, id) => controls.readSession(id),
    getCloseEffects: (id, window) => ({ runs: readRuns(id), terminals: terminals.getWindowCloseImpacts(window) }),
    confirm: async (_home, options) => { confirmations.push(options); return controls.beforeConfirm(); },
    writeText: (value) => clipboard.push(value),
    buildMenu: (template) => ({ popup: (options) => menuReady.resolve({ template, popup: options! }) }),
  });
  const openMenu = async (session: Session) => {
    menuReady = Promise.withResolvers();
    const result = menu.show(home.asBrowserWindow(), { sessionId: session.id, incarnationId: getSessionIncarnationId(session), point: { x: 0, y: 0 } });
    const shown = await Promise.race([menuReady.promise, result.then((value) => assert.fail(`Menu not opened: ${JSON.stringify(value)}`))]);
    const find = (label: string) => shown.template.find((entry) => entry.label === label)!;
    return { find, choose: (label: string) => { find(label).click?.(null as never, home.asBrowserWindow(), null as never); shown.popup.callback?.(); return result; } };
  };
  const dispose = async () => {
    for (const pending of currentAdmissions.values()) pending.finish();
    await runtime.waitForPendingRuns();
    terminals.releaseAll();
  };
  return { root, parent, first, second, third, sibling, sessions, bridge, confirmations, singleConfirmations, clipboard, flushes, releases,
    controls, createTerminal, runAuxiliary, openMenu, dispose, runtime };
}

// @test-value v2
// kind = "contract"
// claim = "選択した閉じた親の子孫だけが、閉じた中間親を挟んでも確認なしの通常Closeを通る（実行・端末保護なし）"
// oracle = { type = "contract", ref = "docs/design/window-architecture.md#home-crewのデータとwindow操作" }
// fault = "子孫を同じrootの全Windowまたは直下だけで代用する、閉じた親を不可とする、idle端末を理由に確認する、draft flushを省く"
// observable = "メニューの有効状態、残るWindow、確認件数、通常のflushと端末停止"
// observation_boundary = "public-boundary"
// scope = "ネイティブメニューservice・Window Bridge・Terminal Service"
// lifecycle = "permanent"
// @end-test-value
test("Batch from a closed parent skips confirmation for idle terminals and closes descendants only", async (t) => {
  const f = menuFixture();
  t.after(f.dispose);
  const outside = newSession("outside");
  f.sessions.set(outside.id, outside);
  const first = await f.bridge.openSessionWindow(f.first.id);
  await f.bridge.openSessionWindow(f.second.id);
  await f.bridge.openSessionWindow(outside.id);
  const idle = await f.createTerminal(first, 1);
  const menu = await f.openMenu(f.root);
  assert.equal(menu.find("Close").enabled, false);
  assert.equal(menu.find("Close Descendant Windows").enabled, true);
  assert.deepEqual(await menu.choose("Close Descendant Windows"), { status: "closed" });
  assert.deepEqual(f.bridge.listOpenSessionWindowIds(), [outside.id]);
  assert.deepEqual(f.flushes, [f.first.id, f.second.id]);
  assert.equal(f.confirmations.length + f.singleConfirmations.length, 0);
  assert.equal(idle.pty.kills, 1);
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryだけが複数実行中でも一Windowと数え、端末停止の全数だけを表示し、取消では閉じず了承後もrunを止めない"
// oracle = { type = "contract", ref = "docs/design/window-architecture.md#home-crewのデータとwindow操作" }
// fault = "Auxiliaryごとに数える、保護端末の数を止まる全数に使う、取消前に処理する、単体確認を重ねる"
// observable = "dialogの対象名・影響・buttons、取消時のWindowとdraft、了承後のWindow・PTY・実runtime admission状態"
// observation_boundary = "public-boundary"
// scope = "一括確認の文言と取消・承認、実Window Bridge・Terminal Service・Auxiliary実行判定"
// lifecycle = "permanent"
// @end-test-value
test("Batch uses one facts-only confirmation for Aux-only runs and all stopped terminals; cancellation closes zero", async (t) => {
  const f = menuFixture();
  t.after(f.dispose);
  const first = await f.bridge.openSessionWindow(f.first.id);
  const second = await f.bridge.openSessionWindow(f.second.id);
  await f.bridge.openSessionWindow(f.parent.id);
  await f.bridge.openSessionWindow(f.sibling.id);
  const idle = await f.createTerminal(first, 1);
  const busy = await f.createTerminal(second, 2, "busy");
  f.runAuxiliary(f.first, "aux-a");
  f.runAuxiliary(f.first, "aux-b");
  f.controls.beforeConfirm = async () => {
    assert.deepEqual(f.bridge.listOpenSessionWindowIds(), [f.first.id, f.second.id, f.parent.id, f.sibling.id]);
    assert.deepEqual(f.flushes, []);
    return false;
  };
  const batch = async () => (await f.openMenu(f.parent)).choose("Close Descendant Windows");
  assert.deepEqual(await batch(), { status: "dismissed" });
  assert.deepEqual(f.bridge.listOpenSessionWindowIds(), [f.first.id, f.second.id, f.parent.id, f.sibling.id]);
  assert.deepEqual(f.flushes, []);
  assert.equal(idle.pty.kills + busy.pty.kills, 0);
  assert.equal(f.confirmations.length, 1);
  f.controls.beforeConfirm = async () => true;
  assert.deepEqual(await batch(), { status: "closed" });
  assert.equal(f.confirmations.length, 2);
  for (const dialog of f.confirmations) {
    assert.equal(dialog.message, "Close Descendant Windows?");
    assert.equal(dialog.detail, "Title first\nTitle second\n\nRuns Will Continue: 1 Window\n\nTerminals Will Stop: 2");
    assert.deepEqual(dialog.buttons, ["Cancel", "Close 2 Windows"]);
    assert.equal(dialog.cancelId, 0);
  }
  assert.deepEqual(f.singleConfirmations, []);
  assert.deepEqual(f.bridge.listOpenSessionWindowIds(), [f.parent.id, f.sibling.id]);
  assert.equal(idle.pty.kills + busy.pty.kills, 2);
  assert.equal(f.runtime.isRunInFlight("aux-a") && f.runtime.isRunInFlight("aux-b"), true);
});

// @test-value v2
// kind = "contract"
// claim = "メニュー選択時は閉じたメンバーもincarnationを照合し、同世代なら最新titleをCopyし、単体Closeは通常確認を維持する"
// oracle = { type = "contract", ref = "docs/design/window-architecture.md#home-crewのデータとwindow操作" }
// fault = "popup時のtitleをCopyする、他世代IDをCopyする、一括の個別確認省略を単体Closeにも適用する"
// observable = "Copy結果とclipboard、単体確認とWindow・flushの状態"
// observation_boundary = "public-boundary"
// scope = "Crewネイティブメニューの選択時認可と従来Close経路"
// lifecycle = "permanent"
// @end-test-value
test("Crew Copy uses the current saved incarnation and title, and single Close still offers Keep Open", async (t) => {
  const f = menuFixture();
  t.after(f.dispose);
  const menu = await f.openMenu(f.parent);
  f.sessions.set(f.parent.id, { ...f.parent, taskTitle: "Latest full title" });
  assert.deepEqual(await menu.choose("Copy Session Title"), { status: "copied" });
  const stale = await f.openMenu(f.parent);
  f.sessions.set(f.parent.id, { ...f.parent, incarnationId: "recreated" });
  assert.equal((await stale.choose("Copy Session ID")).status, "failed");
  assert.deepEqual(f.clipboard, ["Latest full title"]);
  const first = await f.bridge.openSessionWindow(f.first.id);
  await f.createTerminal(first, 1, "busy");
  assert.deepEqual(await (await f.openMenu(f.first)).choose("Close"), { status: "dismissed" });
  assert.deepEqual(f.singleConfirmations, [f.first.id]);
  assert.deepEqual(f.flushes, []);
  assert.equal(first.isDestroyed(), false);
});

// @test-value v2
// kind = "contract"
// claim = "メニュー選択から最初のCloseまでにWindow追加・実体差替え、同数のrun・端末差替え、端末保護の拡大があれば新規closeを行わない"
// oracle = { type = "contract", ref = "docs/design/window-architecture.md#home-crewのデータとwindow操作" }
// fault = "選択後の保存読取完了や了承時まで対象確定を遅らせる、承認済み影響を件数で比較する、端末の状態変化を見落とす"
// observable = "操作失敗と0件close、未試行数、対象と追加先のWindowが残ること"
// observation_boundary = "public-boundary"
// scope = "一括Closeの初回事前照合、実runtime admissionとTerminal Serviceによる同数差替え"
// lifecycle = "permanent"
// @end-test-value
test("Batch refuses new and recreated Windows or increased activity even when impact counts match", async (t) => {
  for (const change of ["Window during selection read", "new Window", "recreated Window", "same-number run", "same-ID terminal", "new terminal protection"] as const) {
    const f = menuFixture();
    t.after(f.dispose);
    const first = await f.bridge.openSessionWindow(f.first.id);
    const second = await f.bridge.openSessionWindow(f.second.id);
    const terminal = await f.createTerminal(second, 1);
    const run = f.runAuxiliary(f.first, "aux");
    const menu = await f.openMenu(f.parent);
    if (change === "Window during selection read") {
      f.controls.readSession = async (id) => {
        await f.bridge.openSessionWindow(f.third.id);
        return f.sessions.get(id) ?? null;
      };
    }
    f.controls.beforeConfirm = async () => {
      switch (change) {
        case "new Window": await f.bridge.openSessionWindow(f.third.id); break;
        case "recreated Window": second.destroy(); await f.bridge.openSessionWindow(f.second.id); break;
        case "same-number run": await run.finish(); f.runAuxiliary(f.first, "aux"); break;
        case "same-ID terminal": terminal.release(); await f.createTerminal(second, 1); break;
        case "new terminal protection": terminal.pty.activity = "busy"; break;
      }
      return true;
    };
    const result = await menu.choose("Close Descendant Windows");
    assert.equal(result.status, "failed", change);
    if (result.status === "failed") assert.match(result.message, /^0 closed .*not attempted.*changed/i, change);
    assert.deepEqual(f.flushes, [], change);
    assert.equal(first.isDestroyed(), false, change);
    assert.ok(f.bridge.getWindow(f.second.id), change);
    if (change === "Window during selection read" || change === "new Window") assert.ok(f.bridge.getWindow(f.third.id));
    if (change === "Window during selection read") assert.deepEqual(f.confirmations, []);
  }
});

// @test-value v2
// kind = "contract"
// claim = "最終draft flushの間に未承認の端末が増えればACK成功・不成功のどちらでもWindowを閉じず、既に閉じた件と残り・未試行を分ける"
// oracle = { type = "contract", ref = "docs/design/window-architecture.md#home-crewのデータとwindow操作" }
// fault = "確認直後しか照合しない、flush失敗のdestroy経路が照合を迂回する、部分成功を全件成功と報告する"
// observable = "result内の件数・理由、Windowの生存、TTYが解放されないこと、draft freezeの失敗release"
// observation_boundary = "public-boundary"
// scope = "一括Close・実Session Window Bridgeのdraft ACK後のguard"
// lifecycle = "permanent"
// @end-test-value
test("Batch stops in the final draft-flush interval before close or destroy and reports partial progress", async (t) => {
  for (const ack of [true, false]) {
    const f = menuFixture();
    t.after(f.dispose);
    const first = await f.bridge.openSessionWindow(f.first.id);
    const second = await f.bridge.openSessionWindow(f.second.id);
    const third = await f.bridge.openSessionWindow(f.third.id);
    let created: Awaited<ReturnType<typeof f.createTerminal>> | undefined;
    f.controls.beforeDraftAcknowledgment = async (request) => {
      if (request.sessionId !== f.second.id) return true;
      created = await f.createTerminal(second, 1, "busy");
      return ack;
    };
    const result = await (await f.openMenu(f.parent)).choose("Close Descendant Windows");
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.match(result.message, /1 closed · 2 remaining \(1 not attempted\) · 0 already closed.*activity changed/);
    assert.deepEqual(f.flushes, [f.first.id, f.second.id]);
    assert.equal(first.isDestroyed(), true);
    assert.equal(second.isDestroyed() || third.isDestroyed(), false);
    assert.equal(created?.pty.kills, 0);
    assert.deepEqual(f.releases, [{ window: second, success: false }]);
  }
});

// @test-value v2
// kind = "contract"
// claim = "一括Close途中に対象が独立に閉じたら数を区別し、実Window Closeが失敗したら後続を閉じない"
// oracle = { type = "contract", ref = "docs/design/window-architecture.md#home-crewのデータとwindow操作" }
// fault = "既に閉じたWindowを自分が閉じたと報告する、Close例外後も続ける、事実どおりの部分結果を返さない"
// observable = "閉じた数・残り・未試行と既に閉じた数、残ったWindow、draft flushの記録"
// observation_boundary = "public-boundary"
// scope = "一括Closeの縮小・例外・結果の報告"
// lifecycle = "permanent"
// @end-test-value
test("Batch distinguishes completed, independently closed, failed and untouched targets", async (t) => {
  const f = menuFixture();
  t.after(f.dispose);
  await f.bridge.openSessionWindow(f.first.id);
  const disappears = await f.bridge.openSessionWindow(f.second.id);
  const fails = await f.bridge.openSessionWindow(f.third.id);
  const extra = newSession("extra", f.parent.id, "executor");
  f.sessions.set(extra.id, extra);
  await f.bridge.openSessionWindow(extra.id);
  await f.createTerminal(f.bridge.getWindow(f.first.id)!, 1, "busy");
  f.controls.beforeConfirm = async () => { fails.failClose = true; return true; };
  f.controls.beforeDraftAcknowledgment = async ({ sessionId }) => {
    if (sessionId === f.second.id) disappears.destroy();
    return true;
  };
  const result = await (await f.openMenu(f.parent)).choose("Close Descendant Windows");
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.message, /1 closed · 2 remaining \(1 not attempted\) · 1 already closed/);
  assert.deepEqual(f.bridge.listOpenSessionWindowIds(), [f.third.id, extra.id]);
  assert.deepEqual(f.flushes, [f.first.id, f.second.id]);
});
