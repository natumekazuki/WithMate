import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionGraphApplicationService, type SessionGraphChange, type SessionGraphStore,
} from "../../src-electron/session-graph/session-graph-application-service.js";
import { notifySessionGraphWindows, SessionGraphWindowService } from "../../src-electron/session-graph/session-graph-window-service.js";
import { SessionWindowBridge, type SessionWindowCloseEvent } from "../../src-electron/windows/session-window-bridge.js";
import type { SessionGraphStorageOperation, SessionGraphStorageResult } from "../../src-shared/session-graph/session-graph-ui-read-contract.js";
import {
  buildNewSession, getSessionIncarnationId, projectHomeSessionSummary, type Session, type SessionSummaryPageRequest,
} from "../../src-shared/session/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";

class Window {
  destroyed = false;
  private readonly closed: Array<() => void> = [];
  constructor(readonly id: string) {}
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  once() {}
  on(...entry: ["close", (event: SessionWindowCloseEvent) => void] | ["closed", () => void]) {
    if (entry[0] === "closed") this.closed.push(entry[1]);
  }
  close() { this.destroy(); }
  destroy() {
    this.destroyed = true;
    for (const callback of this.closed) callback();
  }
  show() {}
  minimize() {}
  restore() {}
  focus() {}
}

const view = { topicId: null, selectedId: null, zoom: 1, scrollLeft: 0, scrollTop: 0 };

function setup() {
  let generation = {};
  let sequence = 0;
  let failed = false;
  let pauseSummary: (() => Promise<void>) | undefined;
  let pauseAuthorization: (() => Promise<void>) | undefined;
  const sessions = new Map<string, Session>();
  for (const id of ["root", "child", "closed", "pending", "other", "stale", "destroyed"]) {
    const session = buildNewSession({ id, taskTitle: id, workspaceLabel: "Synthetic", workspacePath: "/synthetic",
      branch: "main", characterId: "synthetic", character: "Synthetic", characterIconPath: "",
      characterThemeColors: { main: "#000000", sub: "#ffffff" }, approvalMode: DEFAULT_APPROVAL_MODE });
    sessions.set(id, id === "root" || id === "other" ? session
      : { ...session, sessionRole: "executor", rootSessionId: "root", parentSessionId: "root", createdBySessionId: "root" });
  }
  const storageCalls: Array<[string, ...string[]]> = [];
  const sent: Array<[Window, string]> = [];
  const send = (window: Window, id: string) => sent.push([window, id]);
  const owner = (id: string) => ({ sessionId: id, incarnationId: getSessionIncarnationId(sessions.get(id)!) });
  const change = (): SessionGraphChange => ({ owner: owner("root"), generation });
  const store: SessionGraphStore = {
    async execute<K extends SessionGraphStorageOperation>(_owner: unknown, operation: K) {
      const result = failed && operation === "apply" ? { status: "conflict", revision: 1 }
        : operation === "apply" ? { status: "ok", revision: 1 }
          : { status: "ok", revision: 1, items: [], total: 0 };
      return result as SessionGraphStorageResult<K>;
    },
  };
  const application = new SessionGraphApplicationService({
    getStore: () => store,
    async resolveSession(id, source) {
      const main = sessions.get(id);
      if (!main || (source?.incarnationId && source.incarnationId !== getSessionIncarnationId(main))) return null;
      const resolved = {
        owner: owner(main.rootSessionId ?? main.id), generation, providerId: main.provider,
        identity: { sessionId: id, sessionTitle: main.taskTitle, role: "main" as const },
        source: { kind: "main" as const, incarnationId: getSessionIncarnationId(main) },
      };
      if (id === "root") await pauseAuthorization?.();
      return resolved;
    },
  });
  const bridge = new SessionWindowBridge({
    createWindow: (id) => new Window(id), getSession: (id) => sessions.get(id) ?? null, getStorageGeneration: () => generation,
    loadChatEntry: async () => {}, isRunInFlight: () => false, confirmCloseWhileRunning: () => true, broadcastOpenSessionWindowIds: () => {},
  });
  const graphWindows = new Map<string, Window>();
  const graphs = new SessionGraphWindowService({
    application, createWindow: () => {
      const token = String(sequence);
      const window = new Window(`graph-${token}`);
      graphWindows.set(token, window);
      return window;
    },
    load: async () => {}, token: () => String(++sequence), changed: () => {}, notify: send,
  });
  const sessionStorage = {
    async listSessionSummaryPage(request?: SessionSummaryPageRequest | null) {
      assert.equal(request?.scope, "open");
      const ids = [...(request.sessionIds ?? [])];
      storageCalls.push(["open", ...ids]);
      return {
        entries: ids.filter((id) => sessions.has(id) && id !== "pending").map((id) => projectHomeSessionSummary(sessions.get(id)!)),
        hasMore: false, nextCursor: null,
      };
    },
    async getSessionSummary(id: string) {
      const session = sessions.get(id);
      storageCalls.push(["point", id]);
      await pauseSummary?.();
      return session ? { ...session, isPinned: session.isPinned ?? false } : null;
    },
    async listSessionSummaries() {
      assert.fail("Graph notifications must not load all saved Session summaries");
    },
  };
  const notify = (event = change()) => notifySessionGraphWindows(event, {
    sessionStorage, sessionWindows: bridge, graphWindows: graphs, isCurrent: () => generation === event.generation, send,
  });
  return {
    application, bridge, sent, change, notify, storageCalls,
    replace: (id: string) => { sessions.set(id, { ...sessions.get(id)!, incarnationId: "replacement" }); },
    switchStore: () => { generation = {}; },
    failApply: () => { failed = true; },
    pauseSummary: (fn: () => Promise<void>) => { pauseSummary = fn; },
    pauseAuthorization: (fn: () => Promise<void>) => { pauseAuthorization = fn; },
    async openGraph(id: string) {
      const { token } = await graphs.open(id, view, () => true);
      return graphWindows.get(token)!;
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "成功applyだけが、開いたreadyかつ同じ保存identityのCrew窓にmember IDで一度ずつ届く"
// oracle = { type = "contract", ref = "https://app.notion.com/4239d4b6f26280e19fb4db059d36c4b1 の受け入れ条件" }
// fault = "全保存Sessionを列挙する、ready/所属/Window identityを無視する、またはread・失敗applyでも送る"
// observable = "通知起動回数、Session readのscope/ID群、Sessionおよび独立Graphの送信先とpayload"
// observation_boundary = "component-behavior"
// scope = "Session Graph applicationからWindow registryと通知sinkまで"
// lifecycle = "permanent"
// @end-test-value
test("only a successful apply notifies open ready Crew members and independent views", async () => {
  const s = setup();
  const root = await s.bridge.openSessionWindow("root");
  const child = await s.bridge.openSessionWindow("child");
  for (const id of ["other", "pending", "stale"]) await s.bridge.openSessionWindow(id);
  (await s.bridge.openSessionWindow("destroyed")).destroy();
  s.replace("stale");
  const graph = await s.openGraph("root");
  await s.openGraph("other");
  const notifications: Array<Promise<void>> = [];
  s.application.subscribe((change) => notifications.push(s.notify(change)));

  assert.equal((await s.application.executeTrusted("child", "apply", { expectedRevision: 0 }, () => true)).status, "ok");
  assert.equal(notifications.length, 1);
  await notifications[0];
  assert.deepEqual(s.sent, [[root, "root"], [child, "child"], [graph, "root"]]);
  const candidateIds = new Set(["root", "child", "other", "pending", "stale"]);
  assert.ok(s.storageCalls.every(([, ...ids]) => ids.every((id) => candidateIds.has(id))));

  assert.equal((await s.application.read("child", "recent", {})).status, "ok");
  s.failApply();
  assert.equal((await s.application.executeTrusted("child", "apply", { expectedRevision: 0 }, () => true)).status, "conflict");
  await assert.rejects(s.application.executeTrusted("child", "apply", { expectedRevision: 0 }, () => false));
  assert.equal(notifications.length, 1);
});

// @test-value v2
// kind = "invariant"
// claim = "独立GraphはSession窓なしでも現ownerと保存世代の再認可で通知し、失効・閉鎖したviewには送らない"
// oracle = { type = "contract", ref = "https://app.notion.com/4239d4b6f26280e19fb4db059d36c4b1 の受け入れ条件" }
// fault = "Session窓が0件で配送全体を打ち切る、発行済tokenだけを信頼する、または認可待ち中の閉鎖・store切替を見落とす"
// observable = "Session側readなし、および独立Graphの通知先とpayload"
// observation_boundary = "component-behavior"
// scope = "SessionGraphWindowServiceの独立Graph再認可と送信"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// @end-test-value
test("independent Graph delivery reauthorizes without any Session windows", async () => {
  const s = setup();
  const graph = await s.openGraph("root");
  await s.notify();
  assert.deepEqual(s.sent, [[graph, "root"]]);
  assert.deepEqual(s.storageCalls, []);

  const stale = s.change();
  s.replace("root");
  const replacement = await s.openGraph("root");
  await s.notify(stale); // Old token no longer authorizes, and new token does not match the old change.
  assert.deepEqual(s.sent, [[graph, "root"]]);

  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  s.pauseAuthorization(() => { entered.resolve(); return resume.promise; });
  const delivery = s.notify();
  await entered.promise;
  replacement.destroy();
  resume.resolve();
  await delivery;
  assert.deepEqual(s.sent, [[graph, "root"]]);

  s.pauseAuthorization(async () => {});
  await s.openGraph("root");
  const rechecking = Promise.withResolvers<void>();
  const authorized = Promise.withResolvers<void>();
  s.pauseAuthorization(() => { rechecking.resolve(); return authorized.promise; });
  const oldStoreDelivery = s.notify();
  await rechecking.promise;
  s.switchStore();
  authorized.resolve();
  await oldStoreDelivery;
  assert.deepEqual(s.sent, [[graph, "root"]]);
});

// @test-value v2
// kind = "invariant"
// claim = "配送待機中に閉じたSession窓・同IDで開き直した窓・切替前の保存世代には更新を送らない"
// oracle = { type = "contract", ref = "https://app.notion.com/4239d4b6f26280e19fb4db059d36c4b1 の受け入れ条件" }
// fault = "非同期照合後にWindowまたはstoreのidentityを再確認せず古い配送を流す"
// observable = "照合を中断して窓またはstoreを置き換えた後の配送先とpayload"
// observation_boundary = "component-behavior"
// scope = "Session Windowと独立Graphへの通知に対するstore切替・閉鎖競合"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// @end-test-value
test("pending delivery cannot cross a Session window replacement or a store switch", async () => {
  const s = setup();
  const root = await s.bridge.openSessionWindow("root");
  const child = await s.bridge.openSessionWindow("child");
  const graph = await s.openGraph("root");
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  s.pauseSummary(() => { entered.resolve(); return resume.promise; });
  const pending = s.notify();
  await entered.promise;
  child.destroy();
  const reopened = await s.bridge.openSessionWindow("child");
  resume.resolve();
  await pending;
  assert.deepEqual(s.sent, [[root, "root"], [graph, "root"]]);

  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  s.pauseSummary(() => { started.resolve(); return release.promise; });
  const oldDelivery = s.notify();
  await started.promise;
  s.switchStore();
  release.resolve();
  await oldDelivery;
  await s.notify(); // Same saved IDs and incarnations but windows still belong to the old store.
  assert.deepEqual(s.sent, [[root, "root"], [graph, "root"]]);
  reopened.destroy();
  const currentChild = await s.bridge.openSessionWindow("child");
  const currentGraph = await s.openGraph("root");
  await s.notify();
  assert.deepEqual(s.sent.slice(2), [[currentChild, "child"], [currentGraph, "root"]]);
});
