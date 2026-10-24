import assert from "node:assert/strict";
import test from "node:test";
import { SessionGraphApplicationService } from "../../src-electron/session-graph/session-graph-application-service.js";
import { SessionGraphWindowService } from "../../src-electron/session-graph/session-graph-window-service.js";
import type { SessionGraphOperation, SessionGraphOperationResult } from "../../src-shared/session-graph/session-graph-contract.js";
import type { SessionGraphStore } from "../../src-electron/session-graph/session-graph-application-service.js";

class Window {
  destroyed = false; focused = false; closed: (() => void)[] = [];
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; this.closed.forEach((fn) => fn()); }
  show() {} focus() { this.focused = true; } isMinimized() { return false; } restore() {}
  on(_event: "closed", listener: () => void) { this.closed.push(listener); }
}
const state = { topicId: null, selectedId: null, zoom: 1, scrollLeft: 0, scrollTop: 0 };
function setup() {
  let incarnation = "one"; let available = true; let sequence = 0;
  let pending: (() => Promise<void>) | undefined;
  let openInSession = async () => {};
  const generation = {};
  const store: SessionGraphStore = { execute: async <K extends SessionGraphOperation>() => { await pending?.(); return { status: "ok" as const, revision: 1, items: [], total: 0, offset: 0, hasMore: false, incomplete: false, relations: [], externalEndpoints: [] } as unknown as SessionGraphOperationResult<K>; } };
  const application = new SessionGraphApplicationService({ getStore: () => store, resolveSession: async (id) => available ? ({ owner: { sessionId: id, incarnationId: incarnation }, identity: { sessionId: id, sessionTitle: id, role: "main" as const }, providerId: "codex", generation }) : null });
  const windows: Window[] = []; const notifications: Window[] = [];
  const service = new SessionGraphWindowService({ application, createWindow: () => { const w = new Window(); windows.push(w); return w; }, load: async () => {}, token: () => String(++sequence), changed: () => {}, notify: (w) => notifications.push(w), openInSession: () => openInSession() });
  return { service, windows, notifications, incarnation: (value: string) => { incarnation = value; }, unavailable: () => { available = false; }, pending: (value: () => Promise<void>) => { pending = value; }, onOpenInSession: (value: () => Promise<void>) => { openInSession = value; } };
}

// @test-value v2
// kind = "invariant"
// claim = "Graph tokenは発行先Windowとowner incarnationに束縛される"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "別Windowまたは再作成されたownerから保存済みGraphを取得できる"
// observable = "payload取得の拒否と正規Windowのowner ID"
// observation_boundary = "public-boundary"
// scope = "SessionGraphWindowService"
// lifecycle = "permanent"
// impact = "別SessionのGraph情報が漏洩する"
// distinction = "型検査はruntimeのWindow identityやincarnation失効を検証しない。小さなin-memory testで境界を保持する"
// @end-test-value
test("Graph tokens require their own window and current incarnation", async () => {
  const s = setup(); const { token } = await s.service.open("owner", state, () => true);
  assert.equal((await s.service.payload(s.windows[0]!, token)).ownerSessionId, "owner");
  await assert.rejects(s.service.payload(new Window(), token));
  s.incarnation("two"); await assert.rejects(s.service.payload(s.windows[0]!, token));
});

// @test-value v2
// kind = "invariant"
// claim = "read待機中のtoken失効後にGraph内容を返さない"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "閉じたviewへの非同期readをそのまま完了させる"
// observable = "read promiseのreject"
// observation_boundary = "public-boundary"
// scope = "SessionGraphWindowService/ApplicationService"
// lifecycle = "permanent"
// impact = "削除またはreset済みownerの内容を遅延応答で表示する"
// distinction = "型やschemaで非同期の失効競合は検出できない。単一の制御可能promiseで実行負担を抑える"
// @end-test-value
test("Graph reads reject token revocation while storage is pending", async () => {
  const s = setup(); const { token } = await s.service.open("owner", state, () => true);
  let release!: () => void; let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  s.pending(() => { started(); return new Promise<void>((resolve) => { release = resolve; }); });
  const read = s.service.read(s.windows[0]!, token, "recent", {});
  await entered; s.service.closeOwner("owner"); release();
  await assert.rejects(read);
});

// @test-value v2
// kind = "contract"
// claim = "同じownerのGraph viewを複数作成し状態を独立させ、通知とcloseをowner単位に適用する"
// oracle = { type = "contract", ref = "docs/design/window-architecture.md" }
// fault = "同じownerのviewを再利用する、状態を共有する、別ownerも終了する"
// observable = "token数、view state、通知先、close後の登録owner"
// observation_boundary = "public-boundary"
// scope = "SessionGraphWindowService"
// lifecycle = "permanent"
// impact = "比較用の閲覧位置が上書きされるか、無関係なviewを失う"
// distinction = "Window registryの動的な複数viewとowner分離はbuildで保証できない。三つのfake Windowで実行を完結する"
// @end-test-value
test("Graph views remain independent and owner operations are isolated", async () => {
  const s = setup();
  const a = await s.service.open("owner", state, () => true);
  const b = await s.service.open("owner", state, () => true);
  await s.service.open("other", state, () => true);
  assert.notEqual(a.token, b.token);
  await s.service.update(s.windows[0]!, a.token, { ...state, zoom: 2 });
  assert.equal((await s.service.payload(s.windows[1]!, b.token)).state.zoom, 1);
  await s.service.notify("owner"); assert.deepEqual(s.notifications, s.windows.slice(0, 2));
  s.service.closeOwner("owner"); assert.deepEqual(s.service.list().map((entry) => entry.ownerSessionId), ["other"]);
});

// @test-value v2
// kind = "contract"
// claim = "親renderer準備より先のOpen In Sessionを一回取得でき、削除/reset/incarnation変更では失効する"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "親Window生成時のeventだけに依存して遷移を失うか、削除後に古い遷移を適用する"
// observable = "遅延takeNavigationのstate、一回取得後とowner失効後のnull"
// observation_boundary = "public-boundary"
// scope = "Graph navigation handoff"
// lifecycle = "permanent"
// impact = "親を閉じていると指定記録へ移動できず、再作成後の別ownerへ古い表示要求が混入する"
// distinction = "load完了とrenderer準備の順序は型検査では保証できない。timerなしの明示promise境界で一回受渡しと失効を検査する"
// @end-test-value
test("Graph navigation waits for a one-time receiver and expires with its owner", async () => {
  const s = setup(); const { token } = await s.service.open("owner", state, () => true);
  let release!: () => void;
  let entered!: () => void;
  const opening = new Promise<void>((resolve) => { entered = resolve; });
  s.onOpenInSession(() => { entered(); return new Promise<void>((resolve) => { release = resolve; }); });
  const target = { ...state, topicId: "topic", selectedId: "record", zoom: 2 };
  const request = s.service.openInSession(s.windows[0]!, token, target);
  await opening;
  release(); await request;
  assert.deepEqual(await s.service.takeNavigation("owner", () => true), { sessionId: "owner", state: target });
  assert.equal(await s.service.takeNavigation("owner", () => true), null);
  s.onOpenInSession(async () => {});
  await s.service.openInSession(s.windows[0]!, token, target);
  s.incarnation("replacement");
  assert.equal(await s.service.takeNavigation("owner", () => true), null);
  s.incarnation("one");
  await s.service.openInSession(s.windows[0]!, token, target);
  s.service.closeOwner("owner");
  assert.equal(await s.service.takeNavigation("owner", () => true), null);
  const next = await s.service.open("owner", state, () => true);
  await s.service.openInSession(s.windows[1]!, next.token, target);
  s.service.closeAll();
  assert.equal(await s.service.takeNavigation("owner", () => true), null);
});
