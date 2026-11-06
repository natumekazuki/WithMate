import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  SessionWindowBridge,
  type SessionWindowCloseEvent,
  type SessionWindowLike,
} from "../../src-electron/windows/session-window-bridge.js";
import { SessionWindowRestoreService } from "../../src-electron/windows/session-window-restore-service.js";
import { SessionWindowRestoreStorage } from "../../src-electron/windows/session-window-restore-storage.js";
import { SESSION_WINDOW_RESTORE_SET_MAX } from "../../src-shared/window/session-window-restore.js";

class StubWindow implements SessionWindowLike {
  destroyed = false;
  readonly presentationOperations: string[] = [];
  private readonly readyListeners: Array<() => void> = [];
  private readonly closeListeners: Array<(event: SessionWindowCloseEvent) => void> = [];
  private readonly closedListeners: Array<() => void> = [];

  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  minimize() { this.presentationOperations.push("minimize"); }
  restore() {}
  focus() { this.presentationOperations.push("focus"); }
  show() { this.presentationOperations.push("show"); }
  destroy() { this.finishClose(); }
  close() {
    let prevented = false;
    for (const listener of this.closeListeners) {
      listener({ preventDefault: () => { prevented = true; } });
    }
    if (!prevented) {
      this.finishClose();
    }
  }
  once(_event: "ready-to-show", listener: () => void) { this.readyListeners.push(listener); }
  emitReady() { for (const listener of this.readyListeners.splice(0)) listener(); }
  on(event: "close", listener: (event: SessionWindowCloseEvent) => void): void;
  on(event: "closed", listener: () => void): void;
  on(event: "close" | "closed", listener: ((event: SessionWindowCloseEvent) => void) | (() => void)) {
    if (event === "close") {
      this.closeListeners.push(listener as (event: SessionWindowCloseEvent) => void);
    } else {
      this.closedListeners.push(listener as () => void);
    }
  }

  private finishClose() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const listener of this.closedListeners.splice(0)) {
      listener();
    }
  }
}

function createBridge(input: {
  persist(sessionIds: readonly string[]): Promise<void>;
  created: Map<string, StubWindow[]>;
  load?(sessionId: string): Promise<void>;
}) {
  return new SessionWindowBridge<StubWindow>({
    createWindow(sessionId) {
      const window = new StubWindow();
      input.created.set(sessionId, [...input.created.get(sessionId) ?? [], window]);
      return window;
    },
    async loadChatEntry(_window, mode) { await input.load?.(mode.sessionId); },
    getSession: () => null,
    isRunInFlight: () => false,
    confirmCloseWhileRunning: () => false,
    broadcastOpenSessionWindowIds() {},
    persistOpenSessionWindowIds: input.persist,
  });
}

describe("SessionWindowRestoreService", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "初期読込失敗後の回復保存中に明示closeした対象は、先行保存成功でも候補へ復活せず、保存集合と復元対象が空へ収束する"
  // oracle = { type = "contract", ref = "docs/features/session-window-restore.md#保存する集合; docs/features/session-window-restore.md#失敗時の扱い" }
  // fault = "回復保存開始後のcloseを古い保存成功で巻き戻し、diskから消えたWindowを同一instanceの復元操作で開き直す"
  // observable = "順序制御した保存先集合、serviceの候補・通知、復元結果とopen呼出し列"
  // observation_boundary = "public-boundary"
  // scope = "session-window-restore recovery save and explicit close race"
  // lifecycle = "permanent"
  // impact = "利用者が明示的に閉じたWindowがRestore Sessionsで意図せず再表示される"
  // distinction = "逐次保存の既存testや型検査では未知集合からの回復保存中に発生するcloseとの順序競合を検出できない"
  // @end-test-value
  it("回復保存の完了待ち中にcloseしたWindowを候補へ復活させない", async () => {
    let releaseFirstSave!: () => void;
    const firstSaveGate = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
    let firstSaveStarted!: () => void;
    const savingFirst = new Promise<void>((resolve) => { firstSaveStarted = resolve; });
    let saves = 0;
    let durable: readonly string[] = [];
    const notifications: string[][] = [];
    const opened: string[] = [];
    const service = new SessionWindowRestoreService({
      storage: {
        async loadSnapshot() { throw new Error("initial read failed"); },
        async saveSnapshot(ids) {
          if (++saves === 1) {
            firstSaveStarted();
            await firstSaveGate;
          }
          durable = [...ids];
        },
      },
      getSession: () => ({}),
      getSessionWindowRestoreStates: () => new Map(),
      async openSessionWindow(id) { opened.push(id); },
      onRestoreSetChanged(ids) { notifications.push([...ids]); },
    });
    await assert.rejects(service.getSnapshot(), /initial read failed/);
    const openingSave = service.saveSnapshot(["a"]);
    await savingFirst;
    const closingSave = service.saveSnapshot([]);
    await Promise.resolve();
    releaseFirstSave();
    await Promise.all([openingSave, closingSave]);
    assert.deepEqual(durable, []);
    assert.deepEqual(await service.getSnapshot(), []);
    assert.deepEqual(notifications, [[]]);
    assert.deepEqual(await service.restoreSnapshot(), { requestedSessionIds: [], openedSessionIds: [], failures: [] });
    assert.deepEqual(opened, []);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Restoreは今回開く全Windowを最小化で用意し、既存Windowに触らず同じsnapshot保存経路へ接続する"
  // oracle = { type = "contract", ref = "docs/features/session-window-restore.md#復元操作" }
  // fault = "Restoreのopen optionsをBridgeへ渡さず通常表示するか、既存Windowも最小化するか、保存集合から復元Windowを落とす"
  // observable = "各Windowの表示操作列、復元結果、保存集合、生成Window数"
  // observation_boundary = "public-boundary"
  // scope = "session-window-restore minimized bridge integration"
  // lifecycle = "permanent"
  // distinction = "Bridge単体ではRestoreの対象除外・open optionsと保存serviceへの実接続を検出できない"
  // @end-test-value
  it("Restoreは新規対象だけを最小化し、既存Windowの表示と同じ保存経路を維持する", async () => {
    const created = new Map<string, StubWindow[]>();
    const writes: Promise<void>[] = [];
    let saved: readonly string[] = [];
    let bridge!: SessionWindowBridge<StubWindow>;
    const service = new SessionWindowRestoreService({
      storage: {
        async loadSnapshot() { return ["existing", "a", "b"]; },
        async saveSnapshot(ids) { saved = [...ids]; },
      },
      getSession: () => ({}),
      getSessionWindowRestoreStates: () => bridge.getSessionWindowRestoreStates(),
      openSessionWindow: (id, options) => bridge.openSessionWindow(id, options),
    });
    bridge = createBridge({
      created,
      persist(ids) { const write = service.saveSnapshot(ids); writes.push(write); return write; },
    });
    const existing = await bridge.openSessionWindow("existing");
    existing.emitReady();
    assert.deepEqual((await service.restoreSnapshot()).openedSessionIds, ["a", "b"]);
    for (const id of ["a", "b"]) {
      const window = created.get(id)![0];
      window.emitReady();
      assert.deepEqual(window.presentationOperations, ["minimize"]);
      assert.equal(created.get(id)?.length, 1);
    }
    assert.deepEqual(existing.presentationOperations, ["show", "focus"]);
    await Promise.all(writes);
    assert.deepEqual(new Set(saved), new Set(["existing", "a", "b"]));
  });

  // @test-value v2
  // kind = "contract"
  // claim = "初期snapshot読込失敗と保存失敗を報告し、Bridgeの後続保存成功から同じserviceの取得・復元と通知を回復する"
  // oracle = { type = "contract", ref = "docs/features/session-window-restore.md#失敗時の扱い" }
  // fault = "未知の集合を空の成功にするか、正常保存後も初期rejectを再利用するか、既存Windowを二重生成する"
  // observable = "取得・保存のreject、回復通知、同一instanceの候補と復元結果、実snapshotと生成Window数"
  // observation_boundary = "public-boundary"
  // scope = "session-window-restore recovery"
  // lifecycle = "permanent"
  // impact = "一時的な保存先障害で復元機能が再起動まで利用できなくなる"
  // distinction = "通常load成功やstorage単体の検証ではBridgeの保存成功後も残るserviceの失敗状態を検出できない"
  // @end-test-value
  it("不正JSONと保存失敗の後、通常Window保存で同一instanceの取得・復元を回復する", async () => {
    const root = await mkdtemp(join(tmpdir(), "withmate-restore-recovery-"));
    const writes: Promise<void>[] = [];
    try {
      await writeFile(join(root, "session-window-restore-set.json"), "invalid JSON", "utf8");
      const storage = new SessionWindowRestoreStorage(root);
      const notifications: string[][] = [];
      let failSave = true;
      let bridge!: SessionWindowBridge<StubWindow>;
      const service = new SessionWindowRestoreService({
        storage: {
          loadSnapshot: () => storage.loadSnapshot(),
          async saveSnapshot(sessionIds) {
            if (failSave) throw new Error("save failed");
            await storage.saveSnapshot(sessionIds);
          },
        },
        getSession: () => ({}),
        getSessionWindowRestoreStates: () => bridge.getSessionWindowRestoreStates(),
        openSessionWindow: (sessionId) => bridge.openSessionWindow(sessionId),
        onRestoreSetChanged: (sessionIds) => { notifications.push([...sessionIds]); },
      });
      const created = new Map<string, StubWindow[]>();
      bridge = createBridge({
        created,
        persist: (sessionIds) => {
          const write = service.saveSnapshot(sessionIds);
          writes.push(write);
          return write;
        },
      });
      await assert.rejects(service.getSnapshot(), SyntaxError);
      assert.deepEqual(notifications, []);
      await bridge.openSessionWindow("a");
      await assert.rejects(writes[0], /save failed/);
      await assert.rejects(service.getSnapshot(), SyntaxError);
      failSave = false;
      await bridge.openSessionWindow("b");
      await writes[1];
      assert.deepEqual(await storage.loadSnapshot(), ["a", "b"]);
      assert.deepEqual(await service.getSnapshot(), ["a", "b"]);
      assert.deepEqual(notifications, [["a", "b"]]);
      assert.deepEqual(await service.restoreSnapshot(), { requestedSessionIds: [], openedSessionIds: [], failures: [] });
      assert.equal(created.get("a")?.length, 1);
      assert.equal(created.get("b")?.length, 1);
      bridge.closeSessionWindow("a");
      await Promise.allSettled(writes);
      assert.deepEqual(await storage.loadSnapshot(), ["b"]);
    } finally {
      await Promise.allSettled(writes);
      await rm(root, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "一時読込障害後の明示再取得で同一serviceが回復し、並行する通常保存は読み直せた未処理候補を保持する"
  // oracle = { type = "contract", ref = "docs/features/session-window-restore.md#失敗時の扱い" }
  // fault = "初期失敗を固定するか無操作で再試行するか、再取得と保存の競合で未処理候補を上書きする"
  // observable = "取得errorと取得回数、再取得結果・通知、保存先のID集合"
  // observation_boundary = "component-behavior"
  // scope = "session-window-restore recovery"
  // lifecycle = "permanent"
  // @end-test-value
  it("次の取得で一時読込障害から回復し、並行保存でも未処理集合を残す", async () => {
    let loads = 0;
    let finishLoad!: (sessionIds: string[]) => void;
    const recovered = new Promise<string[]>((resolve) => { finishLoad = resolve; });
    let durable: readonly string[] = [];
    const notifications: string[][] = [];
    const service = new SessionWindowRestoreService({
      storage: {
        async loadSnapshot() {
          if (++loads === 1) throw new Error("temporarily unavailable");
          return recovered;
        },
        async saveSnapshot(sessionIds) { durable = [...sessionIds]; },
      },
      getSession: () => ({}),
      getSessionWindowRestoreStates: () => new Map(),
      openSessionWindow: async () => undefined,
      onRestoreSetChanged: (sessionIds) => { notifications.push([...sessionIds]); },
    });
    await assert.rejects(service.getSnapshot(), /temporarily unavailable/);
    assert.equal(loads, 1);
    const retry = service.getSnapshot();
    const joined = service.getSnapshot();
    const saving = service.saveSnapshot(["current"]);
    finishLoad(["pending"]);
    assert.deepEqual(await retry, ["pending"]);
    assert.deepEqual(await joined, ["pending"]);
    await saving;
    assert.equal(loads, 2);
    assert.deepEqual(notifications, [["pending"]]);
    assert.deepEqual(durable, ["pending", "current"]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "復元途中の確定Window保存は未処理・失敗対象を永続化し、明示closeを巻き戻さず再試行後は現在集合へ収束する"
  // oracle = { type = "contract", ref = "docs/features/session-window-restore.md#保存する集合" }
  // fault = "先行Window保存で未処理対象を失うか、明示closeした対象を再生成するか、再試行成功後も閉じたWindowを保存する"
  // observable = "実storageから再生成したserviceの候補、復元結果、生成Window数、close後の保存集合"
  // observation_boundary = "public-boundary"
  // scope = "session-window-restore"
  // lifecycle = "permanent"
  // impact = "途中終了で利用者のWindow復元意図が失われる"
  // distinction = "型検査やservice単独のmockではBridgeのload成功時保存と実ファイルの合成結果を確認できない"
  // @end-test-value
  it("復元途中の実snapshotを再読でき、手動close・失敗再試行を現在Window集合へ反映する", async () => {
    const root = await mkdtemp(join(tmpdir(), "withmate-restore-pending-"));
    const writes: Promise<void>[] = [];
    let releaseB!: () => void;
    const waitingB = new Promise<void>((resolve) => { releaseB = resolve; });
    let reachedB!: () => void;
    const atB = new Promise<void>((resolve) => { reachedB = resolve; });
    try {
      const storage = new SessionWindowRestoreStorage(root);
      await storage.saveSnapshot(["a", "b", "c", "failed"]);
      let bridge!: SessionWindowBridge<StubWindow>;
      let failOpen = true;
      const created = new Map<string, StubWindow[]>();
      const service = new SessionWindowRestoreService({
        storage,
        getSession: async (sessionId) => {
          if (sessionId === "b") {
            reachedB();
            await waitingB;
          }
          return { id: sessionId };
        },
        getSessionWindowRestoreStates: () => bridge.getSessionWindowRestoreStates(),
        openSessionWindow: (sessionId) => bridge.openSessionWindow(sessionId),
      });
      bridge = createBridge({
        created,
        persist: (sessionIds) => {
          const write = service.saveSnapshot(sessionIds);
          writes.push(write);
          return write;
        },
        async load(sessionId) {
          if (sessionId === "failed" && failOpen) throw new Error("open failed");
        },
      });
      const restoring = service.restoreSnapshot();
      await atB;
      assert.equal(writes.length, 1);
      await Promise.all(writes);
      const restarted = new SessionWindowRestoreService({
        storage: new SessionWindowRestoreStorage(root),
        getSession: () => ({}),
        getSessionWindowRestoreStates: () => new Map(),
        openSessionWindow: async () => undefined,
      });
      assert.deepEqual(new Set(await restarted.getSnapshot()), new Set(["a", "b", "c", "failed"]));

      await bridge.openSessionWindow("c");
      bridge.closeSessionWindow("c");
      await Promise.all(writes);
      releaseB();
      assert.deepEqual(await restoring, {
        requestedSessionIds: ["a", "b", "failed"],
        openedSessionIds: ["a", "b"],
        failures: [{ sessionId: "failed", reason: "open-failed" }],
      });
      await Promise.all(writes);
      assert.deepEqual(new Set(await storage.loadSnapshot()), new Set(["a", "b", "failed"]));
      assert.equal(created.get("c")?.length, 1);
      failOpen = false;
      assert.deepEqual((await service.restoreSnapshot()).openedSessionIds, ["failed"]);
      assert.deepEqual(await service.getSnapshot(), []);
      bridge.closeSessionWindow("a");
      await Promise.all(writes);
      assert.deepEqual(await storage.loadSnapshot(), ["b", "failed"]);
    } finally {
      releaseB();
      await Promise.allSettled(writes);
      await rm(root, { recursive: true, force: true });
    }
  });
  // @test-value v2
  // kind = "invariant"
  // claim = "保存済みのWindow復元候補はruntime再生成後に各1Windowとして復元され、close後の保存では残ったWindowだけが候補になる"
  // oracle = { type = "contract", ref = "src-electron/windows/session-window-restore-service.ts" }
  // fault = "復元候補を読み戻せないか、重複Windowを開くか、close済みWindowを次回候補に残す"
  // observable = "runtime再生成後の復元結果、生成Window数、保存完了後に読み戻した候補"
  // observation_boundary = "public-boundary"
  // scope = "session-window-restore"
  // lifecycle = "permanent"
  // @end-test-value
  it("A/B snapshotをruntime再生成後に各1Windowとして一括復元し、closeを次回snapshotへ反映する", async () => {
    const root = await mkdtemp(join(tmpdir(), "withmate-session-window-restore-"));
    const pendingWrites: Promise<void>[] = [];
    try {
      const firstStorage = new SessionWindowRestoreStorage(root);
      const firstService = new SessionWindowRestoreService({
        storage: firstStorage,
        getSession: () => ({}),
        getSessionWindowRestoreStates: () => new Map(),
        openSessionWindow: async () => undefined,
      });
      const firstCreated = new Map<string, StubWindow[]>();
      const firstBridge = createBridge({
        persist: (sessionIds) => {
          const write = firstService.saveSnapshot(sessionIds);
          pendingWrites.push(write);
          return write;
        },
        created: firstCreated,
      });

      await firstBridge.openSessionWindow("session-a");
      await firstBridge.openSessionWindow("session-b");
      await firstBridge.openSessionWindow("session-a");
      await Promise.all(pendingWrites);
      assert.deepEqual(await firstStorage.loadSnapshot(), ["session-a", "session-b"]);

      const secondStorage = new SessionWindowRestoreStorage(root);
      const secondCreated = new Map<string, StubWindow[]>();
      let secondBridge: SessionWindowBridge<StubWindow>;
      const secondService = new SessionWindowRestoreService({
        storage: secondStorage,
        getSession: (sessionId) => ({ id: sessionId }),
        getSessionWindowRestoreStates: () => secondBridge.getSessionWindowRestoreStates(),
        openSessionWindow: (sessionId) => secondBridge.openSessionWindow(sessionId),
      });
      secondBridge = createBridge({
        persist: (sessionIds) => {
          const write = secondService.saveSnapshot(sessionIds);
          pendingWrites.push(write);
          return write;
        },
        created: secondCreated,
      });

      const result = await secondService.restoreSnapshot();

      assert.deepEqual(result, {
        requestedSessionIds: ["session-a", "session-b"],
        openedSessionIds: ["session-a", "session-b"],
        failures: [],
      });
      assert.equal(secondCreated.get("session-a")?.length, 1);
      assert.equal(secondCreated.get("session-b")?.length, 1);
      assert.deepEqual(secondBridge.listOpenSessionWindowIds(), ["session-a", "session-b"]);
      assert.deepEqual(await secondService.getSnapshot(), []);

      secondBridge.closeSessionWindow("session-a");
      await Promise.all(pendingWrites);
      assert.deepEqual(await secondStorage.loadSnapshot(), ["session-b"]);
    } finally {
      await Promise.allSettled(pendingWrites);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("missing・読込不能・open失敗を対象別にskipし、残りの復元を続ける", async () => {
    const opened: string[] = [];
    const service = new SessionWindowRestoreService({
      storage: {
        async loadSnapshot() {
          return ["missing", "unreadable", "open-failed", "valid"];
        },
        async saveSnapshot() {},
      },
      getSession(sessionId) {
        if (sessionId === "missing") {
          return null;
        }
        if (sessionId === "unreadable") {
          throw new Error("read failed");
        }
        return { id: sessionId };
      },
      getSessionWindowRestoreStates: () => new Map(),
      async openSessionWindow(sessionId) {
        if (sessionId === "open-failed") {
          throw new Error("open failed");
        }
        opened.push(sessionId);
      },
    });

    const result = await service.restoreSnapshot();

    assert.deepEqual(opened, ["valid"]);
    assert.deepEqual(result.failures, [
      { sessionId: "missing", reason: "missing" },
      { sessionId: "unreadable", reason: "unreadable" },
      { sessionId: "open-failed", reason: "open-failed" },
    ]);
    assert.deepEqual(result.openedSessionIds, ["valid"]);
  });

  it("snapshot保存時にopen順のduplicateを除去し、100件へ制限する", async () => {
    const root = await mkdtemp(join(tmpdir(), "withmate-session-window-limit-"));
    try {
      const storage = new SessionWindowRestoreStorage(root);
      const sessionIds = ["session-0", "session-0", ...Array.from(
        { length: SESSION_WINDOW_RESTORE_SET_MAX + 5 },
        (_, index) => `session-${index + 1}`,
      )];

      await storage.saveSnapshot(sessionIds);
      const saved = await storage.loadSnapshot();

      assert.equal(saved.length, SESSION_WINDOW_RESTORE_SET_MAX);
      assert.deepEqual(saved.slice(0, 3), ["session-0", "session-1", "session-2"]);
      assert.equal(saved.at(-1), "session-99");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "起動時復元集合を現在集合で上書きせず、現在集合の任意保存が未完了でも読み込んだ候補を復元できる"
  // oracle = { type = "contract", ref = "src-electron/windows/session-window-restore-service.ts" }
  // fault = "初期load前の保存で候補を失うか、現在集合の保存待ちを復元操作へ伝播させる"
  // observable = "保存未完了中の復元結果と、保存へ渡された現在集合"
  // observation_boundary = "public-boundary"
  // scope = "session-window-restore"
  // lifecycle = "permanent"
  // @end-test-value
  it("起動時復元集合は先に読み込み、現在集合の保存を待たず復元できる", async () => {
    const initialSnapshotControl = { resolve: undefined as ((sessionIds: string[]) => void) | undefined };
    let finishSave!: () => void;
    const saving = new Promise<void>((resolve) => { finishSave = resolve; });
    const durableSnapshots: string[][] = [];
    const opened: string[] = [];
    const service = new SessionWindowRestoreService({
      storage: {
        loadSnapshot: () => new Promise<string[]>((resolve) => {
          initialSnapshotControl.resolve = resolve;
        }),
        async saveSnapshot(sessionIds) {
          durableSnapshots.push([...sessionIds]);
          await saving;
        },
      },
      getSession: (sessionId) => ({ id: sessionId }),
      getSessionWindowRestoreStates: () => new Map(),
      async openSessionWindow(sessionId) {
        opened.push(sessionId);
      },
    });

    const saveCurrentSnapshot = service.saveSnapshot(["session-c"]);
    await Promise.resolve();
    assert.deepEqual(durableSnapshots, []);

    assert.ok(initialSnapshotControl.resolve);
    initialSnapshotControl.resolve(["session-a", "session-b"]);
    let restored = false;
    const restoring = service.restoreSnapshot().then((result) => { restored = true; return result; });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(restored, true);
      assert.deepEqual(durableSnapshots, [["session-a", "session-b", "session-c"]]);
      assert.deepEqual((await restoring).requestedSessionIds, ["session-a", "session-b"]);
      assert.deepEqual(opened, ["session-a", "session-b"]);
    } finally {
      finishSave();
      await saveCurrentSnapshot;
      await restoring;
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "保存失敗後も取得済み未処理候補を保持し、後続保存は現在open集合と未処理集合を保存できる"
  // oracle = { type = "contract", ref = "docs/features/session-window-restore.md#保存する集合" }
  // fault = "保存失敗が後続保存を拒否するか、未処理候補を失う"
  // observable = "保存結果、storageへ保存された集合、serviceから取得した候補"
  // observation_boundary = "component-behavior"
  // scope = "session-window-restore"
  // lifecycle = "permanent"
  // @end-test-value
  it("保存失敗をsettleして復元集合のreadと後続保存を維持する", async () => {
    let shouldFailSave = true;
    let durableSnapshot = ["session-a", "session-b"];
    const service = new SessionWindowRestoreService({
      storage: {
        async loadSnapshot() {
          return [...durableSnapshot];
        },
        async saveSnapshot(sessionIds) {
          if (shouldFailSave) {
            throw new Error("save failed");
          }
          durableSnapshot = [...sessionIds];
        },
      },
      getSession: () => ({}),
      getSessionWindowRestoreStates: () => new Map(),
      openSessionWindow: async () => undefined,
    });

    await assert.rejects(service.saveSnapshot(["session-c"]), /save failed/);
    assert.deepEqual(await service.getSnapshot(), ["session-a", "session-b"]);

    shouldFailSave = false;
    await service.saveSnapshot(["session-d"]);
    assert.deepEqual(durableSnapshot, ["session-a", "session-b", "session-d"]);
    assert.deepEqual(await service.getSnapshot(), ["session-a", "session-b"]);
  });

  it("復元後通知の失敗で復元結果と未復元集合を失敗させない", async () => {
    const service = new SessionWindowRestoreService({
      storage: {
        async loadSnapshot() {
          return ["session-a"];
        },
        async saveSnapshot() {},
      },
      getSession: () => ({}),
      getSessionWindowRestoreStates: () => new Map(),
      openSessionWindow: async () => undefined,
      onRestoreSetChanged() {
        throw new Error("broadcast failed");
      },
    });

    const result = await service.restoreSnapshot();

    assert.deepEqual(result.openedSessionIds, ["session-a"]);
    assert.deepEqual(await service.getSnapshot(), []);
  });

  it("すでにopenのSessionを消費し、未openのSessionだけを復元結果へ含める", async () => {
    const opened: string[] = [];
    const restoreSetChanges: string[][] = [];
    const service = new SessionWindowRestoreService({
      storage: {
        async loadSnapshot() {
          return ["session-a", "session-b"];
        },
        async saveSnapshot() {},
      },
      getSession: (sessionId) => ({ id: sessionId }),
      getSessionWindowRestoreStates: () => new Map([
        ["session-a", { kind: "settled-open" as const }],
      ]),
      async openSessionWindow(sessionId) {
        opened.push(sessionId);
      },
      onRestoreSetChanged(sessionIds) {
        restoreSetChanges.push([...sessionIds]);
      },
    });

    const result = await service.restoreSnapshot();

    assert.deepEqual(result, {
      requestedSessionIds: ["session-b"],
      openedSessionIds: ["session-b"],
      failures: [],
    });
    assert.deepEqual(opened, ["session-b"]);
    assert.deepEqual(restoreSetChanges, [[]]);
    assert.deepEqual(await service.getSnapshot(), []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "手動open中のsessionのload失敗を復元失敗として扱い、後続対象を継続する"
  // oracle = { type = "contract", ref = "src-electron/windows/session-window-restore-service.ts" }
  // fault = "失敗対象を成功扱いするか、後続window復元を中断する"
  // observable = "openedSessionIds、failures、未復元snapshot集合"
  // observation_boundary = "public-boundary"
  // scope = "session-window-restore"
  // lifecycle = "permanent"
  // @end-test-value
  it("手動open中の対象へ合流し、load失敗を再試行集合へ残して後続対象を復元する", async () => {
    const rejectSessionAControl = { reject: undefined as ((error: Error) => void) | undefined };
    const sessionBControl = { resolve: undefined as ((session: { id: string }) => void) | undefined };
    const created = new Map<string, StubWindow[]>();
    const restoreOpenCalls: string[] = [];
    const restoreSetChanges: string[][] = [];
    let bridge: SessionWindowBridge<StubWindow>;
    const service = new SessionWindowRestoreService({
      storage: {
        async loadSnapshot() {
          return ["session-b", "session-a"];
        },
        async saveSnapshot() {},
      },
      getSession: (sessionId) => {
        if (sessionId === "session-b") {
          return new Promise<{ id: string }>((resolve) => {
            sessionBControl.resolve = resolve;
          });
        }
        return { id: sessionId };
      },
      getSessionWindowRestoreStates: () => bridge.getSessionWindowRestoreStates(),
      openSessionWindow: (sessionId) => {
        restoreOpenCalls.push(sessionId);
        return bridge.openSessionWindow(sessionId);
      },
      onRestoreSetChanged(sessionIds) {
        restoreSetChanges.push([...sessionIds]);
      },
    });
    bridge = new SessionWindowBridge({
      createWindow(sessionId) {
        const window = new StubWindow();
        created.set(sessionId, [...created.get(sessionId) ?? [], window]);
        return window;
      },
      loadChatEntry(_window, mode) {
        if (mode.sessionId === "session-a") {
          return new Promise<void>((_resolve, reject) => {
            rejectSessionAControl.reject = reject;
          });
        }
        return Promise.resolve();
      },
      getSession: () => null,
      isRunInFlight: () => false,
      confirmCloseWhileRunning: () => false,
      broadcastOpenSessionWindowIds() {},
      persistOpenSessionWindowIds: (sessionIds) => service.saveSnapshot(sessionIds),
    });

    const manualOpen = bridge.openSessionWindow("session-a");
    const restoring = service.restoreSnapshot();
    const outcomes = Promise.allSettled([manualOpen, restoring]);
    let restoreSettled = false;
    void restoring.then(() => {
      restoreSettled = true;
    }, () => {
      restoreSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(created.get("session-a")?.length, 1);
    assert.equal(created.get("session-b")?.length ?? 0, 0);
    assert.deepEqual(restoreOpenCalls, ["session-a"]);
    assert.equal(restoreSettled, false);
    assert.ok(rejectSessionAControl.reject);
    rejectSessionAControl.reject(new Error("load failed"));
    assert.ok(sessionBControl.resolve);
    sessionBControl.resolve({ id: "session-b" });

    const [manualResult, restoreResult] = await outcomes;

    assert.equal(manualResult.status, "rejected");
    assert.equal(restoreResult.status, "fulfilled");
    if (restoreResult.status !== "fulfilled") {
      assert.fail("restore result should be fulfilled");
    }
    assert.deepEqual(restoreResult.value, {
      requestedSessionIds: ["session-b", "session-a"],
      openedSessionIds: ["session-b"],
      failures: [{ sessionId: "session-a", reason: "open-failed" }],
    });
    assert.equal(created.get("session-a")?.length, 1);
    assert.equal(created.get("session-b")?.length, 1);
    assert.deepEqual(restoreOpenCalls, ["session-a", "session-b"]);
    assert.deepEqual(await service.getSnapshot(), ["session-a"]);
    assert.deepEqual(restoreSetChanges, [["session-a"]]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "手動open中のsessionへ復元処理が合流し、windowを重複生成しない"
  // oracle = { type = "contract", ref = "src-electron/windows/session-window-restore-service.ts" }
  // fault = "同一sessionのrestoreで二重windowを作成し、復元結果を誤分類する"
  // observable = "生成window数とopenedSessionIds"
  // observation_boundary = "public-boundary"
  // scope = "session-window-restore"
  // lifecycle = "permanent"
  // @end-test-value
  it("手動open中の対象へ合流し、load成功を重複生成せず復元成功に分類する", async () => {
    const sessionAControl = { resolve: undefined as (() => void) | undefined };
    const created = new Map<string, StubWindow[]>();
    let bridge: SessionWindowBridge<StubWindow>;
    const service = new SessionWindowRestoreService({
      storage: {
        async loadSnapshot() {
          return ["session-a", "session-b"];
        },
        async saveSnapshot() {},
      },
      getSession: (sessionId) => ({ id: sessionId }),
      getSessionWindowRestoreStates: () => bridge.getSessionWindowRestoreStates(),
      openSessionWindow: (sessionId) => bridge.openSessionWindow(sessionId),
    });
    bridge = new SessionWindowBridge({
      createWindow(sessionId) {
        const window = new StubWindow();
        created.set(sessionId, [...created.get(sessionId) ?? [], window]);
        return window;
      },
      loadChatEntry(_window, mode) {
        if (mode.sessionId === "session-a") {
          return new Promise<void>((resolve) => {
            sessionAControl.resolve = resolve;
          });
        }
        return Promise.resolve();
      },
      getSession: () => null,
      isRunInFlight: () => false,
      confirmCloseWhileRunning: () => false,
      broadcastOpenSessionWindowIds() {},
      persistOpenSessionWindowIds: (sessionIds) => service.saveSnapshot(sessionIds),
    });

    const manualOpen = bridge.openSessionWindow("session-a");
    const restoring = service.restoreSnapshot();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(created.get("session-a")?.length, 1);
    assert.ok(sessionAControl.resolve);
    sessionAControl.resolve();

    const [, result] = await Promise.all([manualOpen, restoring]);

    assert.deepEqual(result, {
      requestedSessionIds: ["session-a", "session-b"],
      openedSessionIds: ["session-a", "session-b"],
      failures: [],
    });
    assert.equal(created.get("session-a")?.length, 1);
    assert.equal(created.get("session-b")?.length, 1);
    assert.deepEqual(await service.getSnapshot(), []);
  });
});
