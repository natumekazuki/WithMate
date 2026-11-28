import assert from "node:assert/strict";
import test from "node:test";

import { AppLifecycleService } from "../../src-electron/app/app-lifecycle-service.js";

/** アプリを再びアクティブにすると Home の表示を要求することを確かめる。 */
test("AppLifecycleService は activate で Home Window を開く", async () => {
  const calls: string[] = [];
  const service = new AppLifecycleService({
    /** 実行中の会話がない状態でアクティブ化する。 */
    hasInFlightSessionRuns: () => false,
    /** 会話の実行を無視する終了許可は持たせない。 */
    getAllowQuitWithInFlightRuns: () => false,
    /** アクティブ化だけでは終了許可の変更を観測しない。 */
    setAllowQuitWithInFlightRuns: () => {},
    /** 実画面を開かず Home の生成要求を記録する。 */
    async createHomeWindow() {
      calls.push("createHomeWindow");
    },
    /** アプリ自体は終了させない。 */
    quitApp() {},
    /** 全画面を閉じた場合の既定終了方針を与える。 */
    shouldQuitWhenAllWindowsClosed: () => true,
    /** 終了確認の UI を利用しない。 */
    confirmQuitWhileRunning: () => false,
    /** アクティブ化の試験では永続ストアを開閉しない。 */
    closePersistentStores() {},
  });

  await service.handleActivate();

  assert.deepEqual(calls, ["createHomeWindow"]);
});

/** 別インスタンスが起動された場合、既存インスタンスの Home を開くことを確かめる。 */
test("AppLifecycleService は second-instance で Home Window を開く", async () => {
  const calls: string[] = [];
  const service = new AppLifecycleService({
    /** 保留中の会話を持たない既存インスタンスを想定する。 */
    hasInFlightSessionRuns: () => false,
    /** 実行中の終了許可を既定の無効状態にする。 */
    getAllowQuitWithInFlightRuns: () => false,
    /** 再起動通知の処理では終了許可に副作用を持たせない。 */
    setAllowQuitWithInFlightRuns: () => {},
    /** 別インスタンス起動による Home 表示の要求だけを記録する。 */
    async createHomeWindow() {
      calls.push("createHomeWindow");
    },
    /** 既存インスタンスの実終了は行わない。 */
    quitApp() {},
    /** 全ウィンドウが閉じても終了しない構成とする。 */
    shouldQuitWhenAllWindowsClosed: () => false,
    /** 実行中の終了確認はこのケースでは承認しない。 */
    confirmQuitWhileRunning: () => false,
    /** 画面の再表示で使わない永続ストアは閉じない。 */
    closePersistentStores() {},
  });

  await service.handleSecondInstance();

  assert.deepEqual(calls, ["createHomeWindow"]);
});

/** 終了する構成でも、実行中の会話がある場合は Home を開き直すことを確かめる。 */
test("AppLifecycleService は実行中 session があると window-all-closed で Home Window を再度開く", async () => {
  const calls: string[] = [];
  const service = new AppLifecycleService({
    /** ウィンドウがすべて閉じても保護すべき実行中の会話があるものとする。 */
    hasInFlightSessionRuns: () => true,
    /** 実行中の会話を残したままの終了はまだ承認されていない。 */
    getAllowQuitWithInFlightRuns: () => false,
    /** 終了が許可された場合の状態書き換えは、この画面イベントの観測から外す。 */
    setAllowQuitWithInFlightRuns: () => {},
    /** ウィンドウを開き直すよう要求したことを記録する。 */
    async createHomeWindow() {
      calls.push("createHomeWindow");
    },
    /** 実行中にもかかわらず終了を要求した場合は、記録から検知できるようにする。 */
    quitApp() {
      calls.push("quitApp");
    },
    /** 保留の実行がなければ、ウィンドウを閉じたときに終了すべき構成にする。 */
    shouldQuitWhenAllWindowsClosed: () => true,
    /** 実行を残して終了する許可は与えない。 */
    confirmQuitWhileRunning: () => false,
    /** 実ストアを使わずウィンドウを閉じる分岐だけを調べる。 */
    closePersistentStores() {},
  });

  service.handleWindowAllClosed();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["createHomeWindow"]);
});

/** 全ウィンドウを閉じても終了不要なら、終了も Home の再表示も行わない。 */
test("AppLifecycleService は window-all-closed で終了不要なら app を終了しない", () => {
  const calls: string[] = [];
  const service = new AppLifecycleService({
    /** 実行中会話による Home 復帰の条件を除く。 */
    hasInFlightSessionRuns: () => false,
    /** 通常の終了許可を変更していない状態にする。 */
    getAllowQuitWithInFlightRuns: () => false,
    /** 全画面を閉じただけで永続的な許可は操作しない。 */
    setAllowQuitWithInFlightRuns: () => {},
    /** 予期しない Home の再表示を呼び出し列で検出する。 */
    async createHomeWindow() {
      calls.push("createHomeWindow");
    },
    /** 終了不要な構成にもかかわらず終了を要求したかを記録する。 */
    quitApp() {
      calls.push("quitApp");
    },
    /** 全ウィンドウが閉じてもプロセスを保持する構成にする。 */
    shouldQuitWhenAllWindowsClosed: () => false,
    /** 明示的な終了を要求していないため、確認で許可を与えない。 */
    confirmQuitWhileRunning: () => false,
    /** このウィンドウイベントでは実ストアを操作しない。 */
    closePersistentStores() {},
  });

  service.handleWindowAllClosed();

  assert.deepEqual(calls, []);
});

/** 実行中の終了を利用者が拒否した場合、既定終了を止めて後片付けに入らない。 */
test("AppLifecycleService は before-quit で実行中 session があり confirm が false なら終了しない", async () => {
  let prevented = false;
  const calls: string[] = [];
  const service = new AppLifecycleService({
    /** 終了確認を要する会話の実行を残す。 */
    hasInFlightSessionRuns: () => true,
    /** 実行を残した終了はまだ許可されていない。 */
    getAllowQuitWithInFlightRuns: () => false,
    /** 拒否後に許可状態を書き換えた場合を検出する。 */
    setAllowQuitWithInFlightRuns: () => {
      calls.push("setAllowQuit");
    },
    /** 終了確認でウィンドウの実生成を伴わないようにする。 */
    async createHomeWindow() {},
    /** 拒否を無視して終了を要求した場合に記録する。 */
    quitApp() {
      calls.push("quitApp");
    },
    /** 通常は全ウィンドウを閉じると終了する構成にする。 */
    shouldQuitWhenAllWindowsClosed: () => true,
    /** 利用者が実行中の終了を拒否する応答を返す。 */
    confirmQuitWhileRunning: () => false,
    /** 拒否後に永続ストアへ触れたかを記録する。 */
    closePersistentStores() {
      calls.push("closePersistentStores");
    },
    /** 終了が拒否された後のスレッド無効化も副作用として観測する。 */
    async invalidateAllProviderSessionThreads() {
      calls.push("invalidateAllProviderSessionThreads");
    },
    /** 拒否後に実行権限を失効させていないかを観測する。 */
    revokeAllAgentRuntimeBindings() {
      calls.push("revokeAllAgentRuntimeBindings");
    },
  });

  await service.handleBeforeQuit({
    /** Electron 既定の終了を差し止めたことを記録する。 */
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls, []);
});

// @test-value v2
// kind = "invariant"
// claim = "終了時はprovider thread cleanupとbinding失効後に共有runtimeを停止し、その後persistent storeを閉じてquitする"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence; ADR-021 binding authority; ADR-023 runtime discovery" }
// fault = "provider/binding/runtime cleanup前にpersistent storeを閉じるかquitする"
// observable = "provider thread cleanup・binding失効・stopAgentRuntime・persistent store close・quitのcallback呼出し順"
// observation_boundary = "public-boundary"
// scope = "application-shutdown-runtime-discovery"
// lifecycle = "permanent"
// @end-test-value
/** 実行中でも利用者が同意した終了は、表示の保存から共有 runtime と永続ストアの停止まで順番に行う。 */
test("AppLifecycleService は before-quit で runtime cleanup後にpersistent storeを閉じて終了する", async () => {
  let prevented = false;
  const calls: string[] = [];
  const service = new AppLifecycleService({
    /** 同意が必要になるよう、終了要求時に会話を実行中とする。 */
    hasInFlightSessionRuns: () => true,
    /** 事前に同意済みとはせず、確認の経路を通す。 */
    getAllowQuitWithInFlightRuns: () => false,
    /** 利用者の同意が処理の先頭で反映されたことを記録する。 */
    setAllowQuitWithInFlightRuns: () => {
      calls.push("setAllowQuit");
    },
    /** 終了処理中の実画面生成を行わない。 */
    async createHomeWindow() {},
    /** 全後処理が終わった後の終了要求を記録する。 */
    quitApp() {
      calls.push("quitApp");
    },
    /** ウィンドウが閉じた場合の終了方針も通常のままにする。 */
    shouldQuitWhenAllWindowsClosed: () => true,
    /** 会話の実行を残して終了することに同意する。 */
    confirmQuitWhileRunning: () => true,
    /** ウィンドウ状態の保存が権限やスレッドの解放に先行するかを記録する。 */
    async prepareSessionWindowSnapshotForQuit() {
      calls.push("prepareSessionWindowSnapshotForQuit");
    },
    /** 永続データを扱うストアを閉じる順番を記録する。 */
    closePersistentStores() {
      calls.push("closePersistentStores");
    },
    /** provider のスレッドを一括無効化した段階を記録する。 */
    async invalidateAllProviderSessionThreads() {
      calls.push("invalidateAllProviderSessionThreads");
    },
    /** 共有 runtime の停止前に実行権限を失効させたことを記録する。 */
    revokeAllAgentRuntimeBindings() {
      calls.push("revokeAllAgentRuntimeBindings");
    },
    /** ストアの終了より先に共有 runtime を停止することを記録する。 */
    async stopAgentRuntime() {
      calls.push("stopAgentRuntime");
    },
  });

  await service.handleBeforeQuit({
    /** 非同期の後処理に入る間は、最初の終了を止めたことを記録する。 */
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls, [
    "setAllowQuit",
    "prepareSessionWindowSnapshotForQuit",
    "invalidateAllProviderSessionThreads",
    "revokeAllAgentRuntimeBindings",
    "stopAgentRuntime",
    "closePersistentStores",
    "quitApp",
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "provider cleanupと共有runtime cleanupの非同期完了を待ってからpersistent storeを閉じてquitする"
// oracle = { type = "adr", ref = "ADR-021 and ADR-023 shutdown ordering" }
// fault = "非同期cleanupの途中でstoreを閉じ、runtime operationまたはowner cleanupが部分状態になる"
// observable = "provider／共有runtime cleanup開始・完了のcallback記録とpersistent store close・quitの呼出し順"
// observation_boundary = "public-boundary"
// scope = "application-shutdown-runtime-discovery"
// lifecycle = "permanent"
// distinction = "cleanup順序だけでなく非同期provider cleanupの完了待機を観測する"
// @end-test-value
/** provider と共有 runtime の非同期解放をそれぞれ待ち、どちらかの処理中はストアを閉じない。 */
test("AppLifecycleService はproviderと共有runtime停止完了後にpersistent storesを閉じて終了する", async () => {
  let prevented = false;
  const calls: string[] = [];
  const providerCleanup = { resolve: undefined as (() => void) | undefined };
  const memoryCleanup = { resolve: undefined as (() => void) | undefined };
  const service = new AppLifecycleService({
    /** 利用者確認を介さず、直ちに非同期の解放へ進める。 */
    hasInFlightSessionRuns: () => false,
    /** 実行中の終了を許可する事前フラグは無効にする。 */
    getAllowQuitWithInFlightRuns: () => false,
    /** 会話がない場合に余分な許可変更が行われたかを観測する。 */
    setAllowQuitWithInFlightRuns: () => {
      calls.push("setAllowQuit");
    },
    /** 後処理の順序だけを調べるので画面生成は省く。 */
    async createHomeWindow() {},
    /** 各停止処理が完了するまで終了要求が出ないかを観測する。 */
    quitApp() {
      calls.push("quitApp");
    },
    /** 通常のウィンドウ閉鎖では終了する構成とする。 */
    shouldQuitWhenAllWindowsClosed: () => true,
    /** 確認が呼ばれても後処理を妨げない応答を与える。 */
    confirmQuitWhileRunning: () => true,
    /** 非同期停止の前にストアを閉じた場合にも正確な順で記録する。 */
    closePersistentStores() {
      calls.push("closePersistentStores");
    },
    /** provider の解放をテスト側が進めるまで保留し、その開始と完了を分けて記録する。 */
    async invalidateAllProviderSessionThreads() {
      calls.push("invalidateAllProviderSessionThreads:start");
      await new Promise<void>((resolve) => {
        providerCleanup.resolve = resolve;
      });
      calls.push("invalidateAllProviderSessionThreads:end");
    },
    /** provider の解放と共有 runtime の停止の間で権限を無効化したかを記録する。 */
    revokeAllAgentRuntimeBindings() {
      calls.push("revokeAllAgentRuntimeBindings");
    },
    /** 共有 runtime 終了も別の待機点で止め、ストアの早期終了を検出する。 */
    async stopAgentRuntime() {
      calls.push("stopAgentRuntime:start");
      await new Promise<void>((resolve) => {
        memoryCleanup.resolve = resolve;
      });
      calls.push("stopAgentRuntime:end");
    },
  });

  const cleanup = service.handleBeforeQuit({
    /** 待機点を解放する前に Electron 側の終了を止めたことを確認できるようにする。 */
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls, ["invalidateAllProviderSessionThreads:start"]);

  providerCleanup.resolve?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    "invalidateAllProviderSessionThreads:start",
    "invalidateAllProviderSessionThreads:end",
    "revokeAllAgentRuntimeBindings",
    "stopAgentRuntime:start",
  ]);
  assert.equal(calls.includes("closePersistentStores"), false);
  memoryCleanup.resolve?.();
  await cleanup;

  assert.deepEqual(calls, [
    "invalidateAllProviderSessionThreads:start",
    "invalidateAllProviderSessionThreads:end",
    "revokeAllAgentRuntimeBindings",
    "stopAgentRuntime:start",
    "stopAgentRuntime:end",
    "closePersistentStores",
    "quitApp",
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "AppLifecycleServiceはclosePersistentStoresの非同期完了後にだけquitを実行する"
// oracle = { type = "contract", ref = "src-electron/app/app-lifecycle-service.ts#handleBeforeQuit" }
// fault = "closePersistentStoresの完了を待たずにElectron quitを実行する"
// observable = "closePersistentStoresの終了後に記録されたquitApp呼出し順"
// observation_boundary = "public-boundary"
// scope = "application-shutdown-persistent-store"
// lifecycle = "permanent"
// impact = "終了時にStorage Workerや非同期storeが未完了のままprocess終了し、保存結果が不明になることを防ぐ"
// distinction = "provider cleanupではなくAppLifecycleServiceのclosePersistentStores完了とquit順序を直接確認する"
// @end-test-value
/** 永続ストア自体の終了が非同期の場合も、解放されるまで Electron を終了しない。 */
test("AppLifecycleService は非同期persistent store closeの完了後にquitする", async () => {
  const calls: string[] = [];
  const closeControl = { resolve: undefined as (() => void) | undefined };
  const service = new AppLifecycleService({
    /** 実行中でない状態からストアの終了待ちに入る。 */
    hasInFlightSessionRuns: () => false,
    /** 実行中の終了を強制するフラグには依存しない。 */
    getAllowQuitWithInFlightRuns: () => false,
    /** 実行中の終了許可を更新する実ストアは設けない。 */
    setAllowQuitWithInFlightRuns() {},
    /** ストアの後片付けだけを調べるため、画面を作らない。 */
    async createHomeWindow() {},
    /** ストアの解決後に最後の終了が要求されたことを記録する。 */
    quitApp() {
      calls.push("quitApp");
    },
    /** 通常のウィンドウ終了方針を有効にしておく。 */
    shouldQuitWhenAllWindowsClosed: () => true,
    /** ここでは確認が呼ばれたとしても拒否しない。 */
    confirmQuitWhileRunning: () => true,
    /** 終了の開始を記録し、テストが解放するまでストアの完了を保留する。 */
    closePersistentStores() {
      calls.push("closePersistentStores:start");
      return new Promise<void>((resolve) => {
        closeControl.resolve = () => {
          calls.push("closePersistentStores:end");
          resolve();
        };
      });
    },
  });

  const cleanup = service.handleBeforeQuit({
    /** 既定終了の差し止め自体ではなく、非同期の終了順を観測する。 */ preventDefault() {},
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["closePersistentStores:start"]);
  closeControl.resolve?.();
  await cleanup;
  assert.deepEqual(calls, [
    "closePersistentStores:start",
    "closePersistentStores:end",
    "quitApp",
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "binding revoke、runtime stop、store closeが個別に失敗しても終了処理は一度だけsettleする"
// oracle = { type = "adr", ref = "ADR-021 and ADR-023 shutdown failure timing" }
// fault = "cleanup失敗でquit barrierが永久に未完了となるか、後続cleanupが実行されない"
// observable = "cleanup呼出し順とquitApp呼出し回数"
// observation_boundary = "public-boundary"
// scope = "application-shutdown-runtime-discovery"
// lifecycle = "permanent"
// @end-test-value
/** 個別の終了処理が失敗しても後続を試み、終わった処理を次のイベントで繰り返さない。 */
test("AppLifecycleService はbinding revoke、runtime stop、store closeが失敗しても終了処理をsettleする", async () => {
  const calls: string[] = [];
  const service = new AppLifecycleService({
    /** 会話の実行はなく、利用者確認なしで終了に進める。 */
    hasInFlightSessionRuns: () => false,
    /** 実行中でも終了する許可を事前には設定しない。 */
    getAllowQuitWithInFlightRuns: () => false,
    /** 終了許可の更新はこの障害の検証には含めない。 */
    setAllowQuitWithInFlightRuns() {},
    /** 失敗時に UI を生成する実装は供給しない。 */
    async createHomeWindow() {},
    /** 例外があっても最後の終了要求が何度発生したかを記録する。 */
    quitApp() {
      calls.push("quitApp");
    },
    /** 全ウィンドウの閉鎖で終了すべき設定を与える。 */
    shouldQuitWhenAllWindowsClosed: () => true,
    /** 利用者側の拒否を障害として混ぜない。 */
    confirmQuitWhileRunning: () => true,
    /** ストアを閉じようとした順序を記録してから、終了失敗を通知する。 */
    closePersistentStores() {
      calls.push("closePersistentStores");
      throw new Error("close failed");
    },
    /** 権限失効の障害より先に、provider の片付けが呼ばれることを記録する。 */
    async invalidateAllProviderSessionThreads() {
      calls.push("invalidateAllProviderSessionThreads");
    },
    /** 権限を失効できない場合も、以降の停止が試みられるか確かめる。 */
    revokeAllAgentRuntimeBindings() {
      calls.push("revokeAllAgentRuntimeBindings");
      throw new Error("revoke failed");
    },
    /** 共有 runtime 停止の例外で永続ストアの処理まで省かれないよう検証する。 */
    async stopAgentRuntime() {
      calls.push("stopAgentRuntime");
      throw new Error("runtime stop failed");
    },
  });

  await service.handleBeforeQuit({
    /** 初回の終了保留はこのケースの失敗条件としない。 */ preventDefault() {},
  });
  await service.handleBeforeQuit({
    /** 片付け済みの二度目の終了を妨げた場合は試験を失敗させる。 */
    preventDefault() {
      assert.fail("settled cleanup must not prevent a subsequent quit request");
    },
  });

  assert.deepEqual(calls, [
    "invalidateAllProviderSessionThreads",
    "revokeAllAgentRuntimeBindings",
    "stopAgentRuntime",
    "closePersistentStores",
    "quitApp",
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "全Windowのdraft flushが失敗したquit試行ではcleanupせず、再試行でのみ終了する"
// oracle = { type = "contract", ref = "AppLifecycleService#handleBeforeQuit" }
// fault = "一部Windowのflush失敗を成功扱いし、未保存入力を失ったままcleanupとquitを実行する"
// observable = "flush回数、cleanup呼出し、quit呼出し"
// observation_boundary = "public-boundary"
// scope = "application-shutdown-draft-flush"
// lifecycle = "permanent"
// @end-test-value
/** すべての下書きが保存できなければ解放を始めず、再試行が成功してから終了する。 */
test("AppLifecycleService は複数Window flush失敗時にcleanupを保留し再quitで完了する", async () => {
  let flushAttempt = 0;
  const calls: string[] = [];
  let allowQuit = false;
  const service = new AppLifecycleService({
    /** 実行中の会話ではなく、下書きの保存だけが終了を妨げる状態にする。 */
    hasInFlightSessionRuns: () => false,
    /** 試行の間で保存される終了の許可状態を返す。 */
    getAllowQuitWithInFlightRuns: () => allowQuit,
    /** 後続試行にも終了許可の変更が反映されるよう、テスト側の状態を更新する。 */
    setAllowQuitWithInFlightRuns: (value) => {
      allowQuit = value;
    },
    /** 下書き検証用のウィンドウを実際には作らない。 */
    async createHomeWindow() {},
    /** 後処理を完了した時点の最終終了を記録する。 */
    quitApp: () => calls.push("quit"),
    /** 通常のウィンドウ閉鎖で終了する方針を使う。 */
    shouldQuitWhenAllWindowsClosed: () => true,
    /** 確認への同意を固定し、保存失敗だけが終了拒否の要因になるようにする。 */
    confirmQuitWhileRunning: () => true,
    /** 両方の画面の保存試行を記録し、二度目だけ成功を返す。 */
    flushSessionWindowDrafts: async () => {
      flushAttempt += 1;
      calls.push(`flush-${flushAttempt}-window-a`);
      calls.push(`flush-${flushAttempt}-window-b`);
      return flushAttempt > 1;
    },
    /** 保存が完了するまで永続ストアに触れなかったことを確認できるようにする。 */
    closePersistentStores: () => {
      calls.push("close");
    },
    /** 下書き保存後に provider が解放されたかを確認するため記録する。 */
    invalidateAllProviderSessionThreads: async () => {
      calls.push("provider");
    },
    /** ストアより前に共有 runtime が停止したことを記録する。 */
    stopAgentRuntime: async () => {
      calls.push("memory");
    },
  });

  await service.handleBeforeQuit({
    /** 初回の終了イベントでは、差し止めより下書き保存の試行を観測する。 */ preventDefault() {},
  });
  assert.deepEqual(calls, ["flush-1-window-a", "flush-1-window-b"]);
  await service.handleBeforeQuit({
    /** 二度目のイベントでも OS 動作は再現せず、最終終了の記録までを観測する。 */ preventDefault() {},
  });
  assert.deepEqual(calls, [
    "flush-1-window-a",
    "flush-1-window-b",
    "flush-2-window-a",
    "flush-2-window-b",
    "provider",
    "memory",
    "close",
    "quit",
  ]);
});
