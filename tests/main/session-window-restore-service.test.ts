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

/** 実ウィンドウを起動せず、表示操作と終了イベントの順序を観測するスタブ。 */
class StubWindow implements SessionWindowLike {
  destroyed = false;
  readonly presentationOperations: string[] = [];
  private readonly readyListeners: Array<() => void> = [];
  private readonly closeListeners: Array<
    (event: SessionWindowCloseEvent) => void
  > = [];
  private readonly closedListeners: Array<() => void> = [];

  /** ブリッジが既に破棄されたウィンドウを再利用しないよう、現在の破棄状態を返す。 */
  isDestroyed() {
    return this.destroyed;
  }
  /** 既存の最小化状態を持たないフィクスチャとして扱う。 */
  isMinimized() {
    return false;
  }
  /** 本体を表示する代わりに、最小化の要求を順序付きで記録する。 */
  minimize() {
    this.presentationOperations.push("minimize");
  }
  /** このスタブでは最小化から戻す表示状態を持たないため、状態更新を行わない。 */
  restore() {}
  /** フォーカス要求を記録し、通常表示と最小化復元を比較する。 */
  focus() {
    this.presentationOperations.push("focus");
  }
  /** ウィンドウの表示要求を記録し、フォーカスとの順序を観測する。 */
  show() {
    this.presentationOperations.push("show");
  }
  /** 取消可能な閉じ要求を経ずに、ウィンドウの破棄を完了する。 */
  destroy() {
    this.finishClose();
  }
  /** 終了予告を発行し、リスナーが取り消さなかったときだけ閉じる。 */
  close() {
    let prevented = false;
    for (const listener of this.closeListeners) {
      listener({
        /** いずれかのリスナーによる閉じ要求の取消を記録する。 */ preventDefault:
          () => {
            prevented = true;
          },
      });
    }
    if (!prevented) {
      this.finishClose();
    }
  }
  /** 準備完了をテスト側から通知するまで、一度限りのリスナーを保留する。 */
  once(_event: "ready-to-show", listener: () => void) {
    this.readyListeners.push(listener);
  }
  /** 準備完了通知を発行し、登録されたリスナーを一度だけ実行する。 */
  emitReady() {
    for (const listener of this.readyListeners.splice(0)) listener();
  }
  /** 取消可能な閉じ要求のリスナーを登録する。 */
  on(event: "close", listener: (event: SessionWindowCloseEvent) => void): void;
  /** 破棄後に呼ばれるリスナーを登録する。 */
  on(event: "closed", listener: () => void): void;
  /** 閉じ要求と閉じ完了のリスナーを分けて保持する。 */
  on(
    event: "close" | "closed",
    listener: ((event: SessionWindowCloseEvent) => void) | (() => void),
  ) {
    if (event === "close") {
      this.closeListeners.push(
        listener as (event: SessionWindowCloseEvent) => void,
      );
    } else {
      this.closedListeners.push(listener as () => void);
    }
  }

  /** 破棄の状態変更と完了通知を一回だけ実施する。 */
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

/** 追跡可能なウィンドウ生成と保存処理を、実ブリッジの入出力に接続する。 */
function createBridge(input: {
  /** 開いているセッションの集合を保存し、完了を通知する。 */
  persist(sessionIds: readonly string[]): Promise<void>;
  created: Map<string, StubWindow[]>;
  /** 指定セッションの画面読込を必要なケースだけ遅延または失敗させる。 */
  load?(sessionId: string): Promise<void>;
}) {
  return new SessionWindowBridge<StubWindow>({
    /** 会話IDごとの生成回数を検査できるよう、窓を作るたびに記録する。 */
    createWindow(sessionId) {
      const window = new StubWindow();
      input.created.set(sessionId, [
        ...(input.created.get(sessionId) ?? []),
        window,
      ]);
      return window;
    },
    /** 画面読込の成功・失敗を、注入された会話単位の処理に委ねる。 */
    async loadChatEntry(_window, mode) {
      await input.load?.(mode.sessionId);
    },
    /** ブリッジ側の終了判定では保存済み会話の詳細を使わない。 */
    getSession: () => null,
    /** 実行中ターンによる終了制約を除き、ウィンドウ管理だけを検証する。 */
    isRunInFlight: () => false,
    /** 実行中ウィンドウの終了確認を外部ダイアログへ渡さない。 */
    confirmCloseWhileRunning: () => false,
    /** 通知先を接続せず、開いている窓の保存経路を直接観測する。 */
    broadcastOpenSessionWindowIds() {},
    persistOpenSessionWindowIds: input.persist,
  });
}

/** 起動時の復元候補と現在のウィンドウ集合が、障害・競合後にも区別されることを検証する。 */
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
  /** 回復用の保存待ちに閉じた対象を古い保存結果で復活させず、復元候補も保存集合も空にする。 */
  it("回復保存の完了待ち中にcloseしたWindowを候補へ復活させない", async () => {
    let releaseFirstSave!: () => void;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let firstSaveStarted!: () => void;
    const savingFirst = new Promise<void>((resolve) => {
      firstSaveStarted = resolve;
    });
    let saves = 0;
    let durable: readonly string[] = [];
    const notifications: string[][] = [];
    const opened: string[] = [];
    const service = new SessionWindowRestoreService({
      storage: {
        /** 初期集合が未知になるよう、読み込みを意図的に失敗させる。 */
        async loadSnapshot() {
          throw new Error("initial read failed");
        },
        /** 最初の保存だけを保留し、閉じた後の空集合の保存を途中に差し込めるようにする。 */
        async saveSnapshot(ids) {
          if (++saves === 1) {
            firstSaveStarted();
            await firstSaveGate;
          }
          durable = [...ids];
        },
      },
      /** 候補が復活した場合に、会話の欠落によって誤ったテスト成功にならないようにする。 */
      getSession: () => ({}),
      /** 実ウィンドウ一覧を使わず、保存と候補の更新順を単独で確認する。 */
      getSessionWindowRestoreStates: () => new Map(),
      /** 古い候補が残った場合に、再度開こうとしたIDを記録する。 */
      async openSessionWindow(id) {
        opened.push(id);
      },
      /** 回復時に公開された候補一覧を変更ごとに記録する。 */
      onRestoreSetChanged(ids) {
        notifications.push([...ids]);
      },
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
    assert.deepEqual(await service.restoreSnapshot(), {
      requestedSessionIds: [],
      openedSessionIds: [],
      failures: [],
    });
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
  /** 新規に復元する窓だけ最小化し、通常表示された既存窓も含め同じ保存経路で現在集合を更新する。 */
  it("Restoreは新規対象だけを最小化し、既存Windowの表示と同じ保存経路を維持する", async () => {
    const created = new Map<string, StubWindow[]>();
    const writes: Promise<void>[] = [];
    let saved: readonly string[] = [];
    let bridge!: SessionWindowBridge<StubWindow>;
    const service = new SessionWindowRestoreService({
      storage: {
        /** すでに開く対象と、今から復元する二件を同じ候補に含める。 */
        async loadSnapshot() {
          return ["existing", "a", "b"];
        },
        /** ブリッジ経由の保存が最後に渡した集合を保持する。 */
        async saveSnapshot(ids) {
          saved = [...ids];
        },
      },
      /** 全候補が存在する条件で表示方法だけを比較する。 */
      getSession: () => ({}),
      /** 復元側がすでに開いた窓を判定できるよう、実ブリッジの状態を返す。 */
      getSessionWindowRestoreStates: () =>
        bridge.getSessionWindowRestoreStates(),
      /** 最小化などの復元オプションを落とさず、実ブリッジへ渡す。 */
      openSessionWindow: (id, options) => bridge.openSessionWindow(id, options),
    });
    bridge = createBridge({
      created,
      /** 通常表示と復元が通った同じ保存の完了を、テストから待機できるよう記録する。 */
      persist(ids) {
        const write = service.saveSnapshot(ids);
        writes.push(write);
        return write;
      },
    });
    const existing = await bridge.openSessionWindow("existing");
    existing.emitReady();
    assert.deepEqual((await service.restoreSnapshot()).openedSessionIds, [
      "a",
      "b",
    ]);
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
  /** 不正JSONと保存エラーから通常の窓保存で回復し、同じサービスで候補が読めて窓が重複しないことを確認する。 */
  it("不正JSONと保存失敗の後、通常Window保存で同一instanceの取得・復元を回復する", async () => {
    const root = await mkdtemp(join(tmpdir(), "withmate-restore-recovery-"));
    const writes: Promise<void>[] = [];
    try {
      await writeFile(
        join(root, "session-window-restore-set.json"),
        "invalid JSON",
        "utf8",
      );
      const storage = new SessionWindowRestoreStorage(root);
      const notifications: string[][] = [];
      let failSave = true;
      let bridge!: SessionWindowBridge<StubWindow>;
      const service = new SessionWindowRestoreService({
        storage: {
          /** 不正な内容も含め、一時領域にある実ストレージから読み込む。 */
          loadSnapshot: () => storage.loadSnapshot(),
          /** 障害中の書込だけを失敗させ、以後は実ファイルへの書込を再開する。 */
          async saveSnapshot(sessionIds) {
            if (failSave) throw new Error("save failed");
            await storage.saveSnapshot(sessionIds);
          },
        },
        /** 候補の復元に必要なセッションがすべて存在する状態にする。 */
        getSession: () => ({}),
        /** 起動済み対象を二重生成しないよう、実ブリッジの管理状態を渡す。 */
        getSessionWindowRestoreStates: () =>
          bridge.getSessionWindowRestoreStates(),
        /** サービスが選んだ復元対象を実ブリッジで開く。 */
        openSessionWindow: (sessionId) => bridge.openSessionWindow(sessionId),
        /** 候補を取得できなかった時には通知せず、回復した時の集合を観測する。 */
        onRestoreSetChanged: (sessionIds) => {
          notifications.push([...sessionIds]);
        },
      });
      const created = new Map<string, StubWindow[]>();
      bridge = createBridge({
        created,
        /** 実際の窓一覧の変更をサービスの保存経路に戻し、成功と失敗を待機対象にする。 */
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
      assert.deepEqual(await service.restoreSnapshot(), {
        requestedSessionIds: [],
        openedSessionIds: [],
        failures: [],
      });
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
  /** 一時読込障害の後は明示再取得で回復し、並行した現在集合の保存にも読み直した候補を残す。 */
  it("次の取得で一時読込障害から回復し、並行保存でも未処理集合を残す", async () => {
    let loads = 0;
    let finishLoad!: (sessionIds: string[]) => void;
    const recovered = new Promise<string[]>((resolve) => {
      finishLoad = resolve;
    });
    let durable: readonly string[] = [];
    const notifications: string[][] = [];
    const service = new SessionWindowRestoreService({
      storage: {
        /** 最初だけ読み込みに失敗させ、再取得の結果は並行保存を開始するまで保留する。 */
        async loadSnapshot() {
          if (++loads === 1) throw new Error("temporarily unavailable");
          return recovered;
        },
        /** 再読結果と現在の窓が合成されて保存されるかを観測する。 */
        async saveSnapshot(sessionIds) {
          durable = [...sessionIds];
        },
      },
      /** 読込回復と保存を試すため、候補の保存済みデータは存在するものとする。 */
      getSession: () => ({}),
      /** 開いている窓による候補消費を発生させない。 */
      getSessionWindowRestoreStates: () => new Map(),
      /** 候補取得と保存だけの検証なので、窓を実際に生成しない。 */
      openSessionWindow: async () => undefined,
      /** 再取得に合流した複数の要求が、同じ候補を余分に通知しないかを記録する。 */
      onRestoreSetChanged: (sessionIds) => {
        notifications.push([...sessionIds]);
      },
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
  /** 実ファイルに復元途中の候補を保ち、手動で閉じた窓を復活させず、再試行後は現在集合へ収束させる。 */
  it("復元途中の実snapshotを再読でき、手動close・失敗再試行を現在Window集合へ反映する", async () => {
    const root = await mkdtemp(join(tmpdir(), "withmate-restore-pending-"));
    const writes: Promise<void>[] = [];
    let releaseB!: () => void;
    const waitingB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let reachedB!: () => void;
    const atB = new Promise<void>((resolve) => {
      reachedB = resolve;
    });
    try {
      const storage = new SessionWindowRestoreStorage(root);
      await storage.saveSnapshot(["a", "b", "c", "failed"]);
      let bridge!: SessionWindowBridge<StubWindow>;
      let failOpen = true;
      const created = new Map<string, StubWindow[]>();
      const service = new SessionWindowRestoreService({
        storage,
        /** 二番目の候補の詳細取得を保留し、復元途中の実スナップショットを読み直せるようにする。 */
        getSession: async (sessionId) => {
          if (sessionId === "b") {
            reachedB();
            await waitingB;
          }
          return { id: sessionId };
        },
        /** 手動で開いた窓も、実ブリッジの復元用状態に含める。 */
        getSessionWindowRestoreStates: () =>
          bridge.getSessionWindowRestoreStates(),
        /** 復元対象を手動操作と同じブリッジへ渡し、同じ窓のライフサイクルを使う。 */
        openSessionWindow: (sessionId) => bridge.openSessionWindow(sessionId),
      });
      bridge = createBridge({
        created,
        /** 復元中に発生した書込の完了を、再起動相当の再読前に待てるようにする。 */
        persist: (sessionIds) => {
          const write = service.saveSnapshot(sessionIds);
          writes.push(write);
          return write;
        },
        /** 指定候補だけを最初の復元では失敗させ、後の操作で成功へ切り替える。 */
        async load(sessionId) {
          if (sessionId === "failed" && failOpen)
            throw new Error("open failed");
        },
      });
      const restoring = service.restoreSnapshot();
      await atB;
      assert.equal(writes.length, 1);
      await Promise.all(writes);
      const restarted = new SessionWindowRestoreService({
        storage: new SessionWindowRestoreStorage(root),
        /** 再生成した観測側のサービスでは、候補IDを有効とみなす。 */
        getSession: () => ({}),
        /** 再生成したサービスには既存窓がない前提で、ディスクの候補を検査する。 */
        getSessionWindowRestoreStates: () => new Map(),
        /** 再生成したサービスは候補の再読専用で、実際の窓は開かない。 */
        openSessionWindow: async () => undefined,
      });
      assert.deepEqual(
        new Set(await restarted.getSnapshot()),
        new Set(["a", "b", "c", "failed"]),
      );

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
      assert.deepEqual(
        new Set(await storage.loadSnapshot()),
        new Set(["a", "b", "failed"]),
      );
      assert.equal(created.get("c")?.length, 1);
      failOpen = false;
      assert.deepEqual((await service.restoreSnapshot()).openedSessionIds, [
        "failed",
      ]);
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
  /** 再起動後に保存された二件を一窓ずつ復元し、片方を閉じた後は残りだけを保存する。 */
  it("A/B snapshotをruntime再生成後に各1Windowとして一括復元し、closeを次回snapshotへ反映する", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "withmate-session-window-restore-"),
    );
    const pendingWrites: Promise<void>[] = [];
    try {
      const firstStorage = new SessionWindowRestoreStorage(root);
      const firstService = new SessionWindowRestoreService({
        storage: firstStorage,
        /** 初回のサービスは窓一覧の保存に使い、候補の欠落は再現しない。 */
        getSession: () => ({}),
        /** 初回のサービスには復元用の事前登録窓を持たせない。 */
        getSessionWindowRestoreStates: () => new Map(),
        /** 初回の窓はブリッジから手動で開くため、復元からは生成しない。 */
        openSessionWindow: async () => undefined,
      });
      const firstCreated = new Map<string, StubWindow[]>();
      const firstBridge = createBridge({
        /** 起動中の通常操作で保存された集合を、再生成前に待機できるようにする。 */
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
      assert.deepEqual(await firstStorage.loadSnapshot(), [
        "session-a",
        "session-b",
      ]);

      const secondStorage = new SessionWindowRestoreStorage(root);
      const secondCreated = new Map<string, StubWindow[]>();
      let secondBridge: SessionWindowBridge<StubWindow>;
      const secondService = new SessionWindowRestoreService({
        storage: secondStorage,
        /** 再生成後の候補はそれぞれ復元できる保存済み会話として返す。 */
        getSession: (sessionId) => ({ id: sessionId }),
        /** 再生成後の重複判定には、新しいブリッジが管理する窓だけを使う。 */
        getSessionWindowRestoreStates: () =>
          secondBridge.getSessionWindowRestoreStates(),
        /** 再生成後の開き直しを第二の実ブリッジへ委ねる。 */
        openSessionWindow: (sessionId) =>
          secondBridge.openSessionWindow(sessionId),
      });
      secondBridge = createBridge({
        /** 復元後の開閉を、最初と同じファイルを指す新しいサービスで保存する。 */
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
      assert.deepEqual(secondBridge.listOpenSessionWindowIds(), [
        "session-a",
        "session-b",
      ]);
      assert.deepEqual(await secondService.getSnapshot(), []);

      secondBridge.closeSessionWindow("session-a");
      await Promise.all(pendingWrites);
      assert.deepEqual(await secondStorage.loadSnapshot(), ["session-b"]);
    } finally {
      await Promise.allSettled(pendingWrites);
      await rm(root, { recursive: true, force: true });
    }
  });

  /** 欠落、詳細の読込エラー、窓の生成エラーを対象別に報告し、正常な後続候補まで復元する。 */
  it("missing・読込不能・open失敗を対象別にskipし、残りの復元を続ける", async () => {
    const opened: string[] = [];
    const service = new SessionWindowRestoreService({
      storage: {
        /** 段階別の失敗と正常完了を一回の復元で確認できる候補列を返す。 */
        async loadSnapshot() {
          return ["missing", "unreadable", "open-failed", "valid"];
        },
        /** この検証は復元結果だけを比較し、集合の永続化は行わない。 */
        async saveSnapshot() {},
      },
      /** 候補IDに応じて欠落・読込失敗・正常な詳細を区別する。 */
      getSession(sessionId) {
        if (sessionId === "missing") {
          return null;
        }
        if (sessionId === "unreadable") {
          throw new Error("read failed");
        }
        return { id: sessionId };
      },
      /** 候補がすでに開かれていることによる除外を発生させない。 */
      getSessionWindowRestoreStates: () => new Map(),
      /** 開く段階でだけ失敗するIDを用意し、正常に開けた窓を記録する。 */
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

  /** 重複項目を初出順のまま除いてから上限を適用し、保存して読み直せることを確認する。 */
  it("snapshot保存時にopen順のduplicateを除去し、100件へ制限する", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "withmate-session-window-limit-"),
    );
    try {
      const storage = new SessionWindowRestoreStorage(root);
      const sessionIds = [
        "session-0",
        "session-0",
        ...Array.from(
          { length: SESSION_WINDOW_RESTORE_SET_MAX + 5 },
          (_, index) => `session-${index + 1}`,
        ),
      ];

      await storage.saveSnapshot(sessionIds);
      const saved = await storage.loadSnapshot();

      assert.equal(saved.length, SESSION_WINDOW_RESTORE_SET_MAX);
      assert.deepEqual(saved.slice(0, 3), [
        "session-0",
        "session-1",
        "session-2",
      ]);
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
  /** 起動時に保存されていた候補を先に読み、現在集合の書込完了が復元を止めないことを確認する。 */
  it("起動時復元集合は先に読み込み、現在集合の保存を待たず復元できる", async () => {
    const initialSnapshotControl = {
      resolve: undefined as ((sessionIds: string[]) => void) | undefined,
    };
    let finishSave!: () => void;
    const saving = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const durableSnapshots: string[][] = [];
    const opened: string[] = [];
    const service = new SessionWindowRestoreService({
      storage: {
        /** 読み込む候補をテストから渡すまで、起動時の取得結果を保留する。 */
        loadSnapshot: () =>
          new Promise<string[]>((resolve) => {
            initialSnapshotControl.resolve = resolve;
          }),
        /** 合成して保存する集合を先に記録し、書込の完了通知だけを保留する。 */
        async saveSnapshot(sessionIds) {
          durableSnapshots.push([...sessionIds]);
          await saving;
        },
      },
      /** 起動時に読み込んだ候補がすべて復元可能な会話に対応する。 */
      getSession: (sessionId) => ({ id: sessionId }),
      /** 初期状態ではすでに開いた窓を持たず、候補をそのまま復元へ進める。 */
      getSessionWindowRestoreStates: () => new Map(),
      /** 書込未完了の間に復元が開いたIDを記録する。 */
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
    const restoring = service.restoreSnapshot().then((result) => {
      restored = true;
      return result;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(restored, true);
      assert.deepEqual(durableSnapshots, [
        ["session-a", "session-b", "session-c"],
      ]);
      assert.deepEqual((await restoring).requestedSessionIds, [
        "session-a",
        "session-b",
      ]);
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
  /** 保存に失敗しても既知の未処理候補を保ち、次の成功時に現在集合と一緒に保存できることを確かめる。 */
  it("保存失敗をsettleして復元集合のreadと後続保存を維持する", async () => {
    let shouldFailSave = true;
    let durableSnapshot = ["session-a", "session-b"];
    const service = new SessionWindowRestoreService({
      storage: {
        /** 読み込まれる初期候補を、書込用配列の参照から分離して返す。 */
        async loadSnapshot() {
          return [...durableSnapshot];
        },
        /** 障害が有効な間だけ失敗し、その後は渡された一覧で保存内容を更新する。 */
        async saveSnapshot(sessionIds) {
          if (shouldFailSave) {
            throw new Error("save failed");
          }
          durableSnapshot = [...sessionIds];
        },
      },
      /** 初期候補を失敗なしで照会できる前提で保存の失敗を切り分ける。 */
      getSession: () => ({}),
      /** 保存中に別ウィンドウの状態で候補を除外しないようにする。 */
      getSessionWindowRestoreStates: () => new Map(),
      /** 取得と再保存だけを試すため、窓を開く処理には副作用を持たせない。 */
      openSessionWindow: async () => undefined,
    });

    await assert.rejects(service.saveSnapshot(["session-c"]), /save failed/);
    assert.deepEqual(await service.getSnapshot(), ["session-a", "session-b"]);

    shouldFailSave = false;
    await service.saveSnapshot(["session-d"]);
    assert.deepEqual(durableSnapshot, ["session-a", "session-b", "session-d"]);
    assert.deepEqual(await service.getSnapshot(), ["session-a", "session-b"]);
  });

  /** 復元後の候補変更通知が失敗しても、正常に開いた結果と消費後の候補集合は維持する。 */
  it("復元後通知の失敗で復元結果と未復元集合を失敗させない", async () => {
    const service = new SessionWindowRestoreService({
      storage: {
        /** 通知の失敗を確認するため、一件の未復元候補を供給する。 */
        async loadSnapshot() {
          return ["session-a"];
        },
        /** 通知の失敗とは独立に、ストレージ側は保存を拒まない。 */
        async saveSnapshot() {},
      },
      /** 候補取得の成功条件を満たし、通知経路の失敗に焦点を当てる。 */
      getSession: () => ({}),
      /** 候補を未オープンとし、復元操作を実行させる。 */
      getSessionWindowRestoreStates: () => new Map(),
      /** 窓を開く段階は成功させ、後の通知でのみ失敗を注入する。 */
      openSessionWindow: async () => undefined,
      /** 復元が終わった後の通知だけを例外にして、結果への波及を検査する。 */
      onRestoreSetChanged() {
        throw new Error("broadcast failed");
      },
    });

    const result = await service.restoreSnapshot();

    assert.deepEqual(result.openedSessionIds, ["session-a"]);
    assert.deepEqual(await service.getSnapshot(), []);
  });

  /** 開き終わった候補は再生成せず消費し、新規に開けた窓だけを復元結果へ含める。 */
  it("すでにopenのSessionを消費し、未openのSessionだけを復元結果へ含める", async () => {
    const opened: string[] = [];
    const restoreSetChanges: string[][] = [];
    const service = new SessionWindowRestoreService({
      storage: {
        /** 既に開いた対象と新規復元対象を初期保存集合に含める。 */
        async loadSnapshot() {
          return ["session-a", "session-b"];
        },
        /** 結果と候補通知のみを確認するため、永続化は実行しない。 */
        async saveSnapshot() {},
      },
      /** 候補IDを読み込み可能な会話詳細として返す。 */
      getSession: (sessionId) => ({ id: sessionId }),
      /** 一件だけはすでに準備まで完了した窓として報告する。 */
      getSessionWindowRestoreStates: () =>
        new Map([["session-a", { kind: "settled-open" as const }]]),
      /** 復元が実際に開こうとした対象だけを回収する。 */
      async openSessionWindow(sessionId) {
        opened.push(sessionId);
      },
      /** 既開と新規の候補がすべて消費されたことを通知の内容で調べる。 */
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
  /** 手動で開きかけた窓の失敗を復元にも反映し、該当候補を次回用に保って他の窓を復元する。 */
  it("手動open中の対象へ合流し、load失敗を再試行集合へ残して後続対象を復元する", async () => {
    const rejectSessionAControl = {
      reject: undefined as ((error: Error) => void) | undefined,
    };
    const sessionBControl = {
      resolve: undefined as ((session: { id: string }) => void) | undefined,
    };
    const created = new Map<string, StubWindow[]>();
    const restoreOpenCalls: string[] = [];
    const restoreSetChanges: string[][] = [];
    let bridge: SessionWindowBridge<StubWindow>;
    const service = new SessionWindowRestoreService({
      storage: {
        /** 手動オープンと競合する候補を、別の復元候補と一緒に返す。 */
        async loadSnapshot() {
          return ["session-b", "session-a"];
        },
        /** 候補集合の更新は通知と取得で検証し、実ファイルは用意しない。 */
        async saveSnapshot() {},
      },
      /** 後続候補の詳細を手順から解決できるよう保留する。 */
      getSession: (sessionId) => {
        if (sessionId === "session-b") {
          return new Promise<{ id: string }>((resolve) => {
            sessionBControl.resolve = resolve;
          });
        }
        return { id: sessionId };
      },
      /** 手動オープン中の窓を復元側が発見できるよう実ブリッジの状態を共有する。 */
      getSessionWindowRestoreStates: () =>
        bridge.getSessionWindowRestoreStates(),
      /** 復元の試行順を記録し、すでに進行中の同じブリッジ操作へ合流させる。 */
      openSessionWindow: (sessionId) => {
        restoreOpenCalls.push(sessionId);
        return bridge.openSessionWindow(sessionId);
      },
      /** 失敗した候補だけが次回用として通知されたかを記録する。 */
      onRestoreSetChanged(sessionIds) {
        restoreSetChanges.push([...sessionIds]);
      },
    });
    bridge = new SessionWindowBridge({
      /** 手動と復元が同じIDで窓を重複生成していないかを追跡する。 */
      createWindow(sessionId) {
        const window = new StubWindow();
        created.set(sessionId, [...(created.get(sessionId) ?? []), window]);
        return window;
      },
      /** 手動オープン側の画面読込をテストから失敗させ、その結果を復元側へ渡す。 */
      loadChatEntry(_window, mode) {
        if (mode.sessionId === "session-a") {
          return new Promise<void>((_resolve, reject) => {
            rejectSessionAControl.reject = reject;
          });
        }
        return Promise.resolve();
      },
      /** ブリッジ内の終了処理には会話詳細を渡さない。 */
      getSession: () => null,
      /** 実行中ターンを扱わず、ロードの競合を切り分ける。 */
      isRunInFlight: () => false,
      /** 終了確認のダイアログを接続しない。 */
      confirmCloseWhileRunning: () => false,
      /** 窓一覧通知に外部リスナーを接続せず、復元候補の変更だけを観測する。 */
      broadcastOpenSessionWindowIds() {},
      /** ブリッジの窓一覧変更を同じ復元サービスへ保存させる。 */
      persistOpenSessionWindowIds: (sessionIds) =>
        service.saveSnapshot(sessionIds),
    });

    const manualOpen = bridge.openSessionWindow("session-a");
    const restoring = service.restoreSnapshot();
    const outcomes = Promise.allSettled([manualOpen, restoring]);
    let restoreSettled = false;
    void restoring.then(
      () => {
        restoreSettled = true;
      },
      () => {
        restoreSettled = true;
      },
    );
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
  /** 進行中の手動オープンが成功した場合、同じ窓に合流し、重複せず後続とともに復元成功に数える。 */
  it("手動open中の対象へ合流し、load成功を重複生成せず復元成功に分類する", async () => {
    const sessionAControl = { resolve: undefined as (() => void) | undefined };
    const created = new Map<string, StubWindow[]>();
    let bridge: SessionWindowBridge<StubWindow>;
    const service = new SessionWindowRestoreService({
      storage: {
        /** 合流対象の窓と、通常どおり開く後続候補を返す。 */
        async loadSnapshot() {
          return ["session-a", "session-b"];
        },
        /** 生成回数と復元結果の比較に絞り、ファイルには保存しない。 */
        async saveSnapshot() {},
      },
      /** 両方の候補が保存済みで読み込める状態を作る。 */
      getSession: (sessionId) => ({ id: sessionId }),
      /** 手動オープンの進行状態を、復元側へ取り込む。 */
      getSessionWindowRestoreStates: () =>
        bridge.getSessionWindowRestoreStates(),
      /** 復元側でも手動と同じブリッジ経路を呼び、進行中の窓を共有する。 */
      openSessionWindow: (sessionId) => bridge.openSessionWindow(sessionId),
    });
    bridge = new SessionWindowBridge({
      /** 合流成功後にも対象ごとの窓が一つしかないことを生成履歴で検証する。 */
      createWindow(sessionId) {
        const window = new StubWindow();
        created.set(sessionId, [...(created.get(sessionId) ?? []), window]);
        return window;
      },
      /** 手動で開く対象の読込を復元要求が到着するまで止め、その後成功させる。 */
      loadChatEntry(_window, mode) {
        if (mode.sessionId === "session-a") {
          return new Promise<void>((resolve) => {
            sessionAControl.resolve = resolve;
          });
        }
        return Promise.resolve();
      },
      /** 終了用の会話詳細は、この窓スタブでは必要としない。 */
      getSession: () => null,
      /** 会話の実行状態には依存せず、画面読込と候補消費を検証する。 */
      isRunInFlight: () => false,
      /** 画面読込の検証では実行中の終了確認を使わない。 */
      confirmCloseWhileRunning: () => false,
      /** 外部のウィンドウ一覧通知なしでブリッジの挙動を確認する。 */
      broadcastOpenSessionWindowIds() {},
      /** 手動と復元の両方で変更された窓の集合を、共通の復元サービスへ渡す。 */
      persistOpenSessionWindowIds: (sessionIds) =>
        service.saveSnapshot(sessionIds),
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
