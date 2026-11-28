import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  startAppSettingsSubscription,
  type AppSettingsSubscriptionApi,
} from "../../src/settings/app-settings-subscription.js";
import {
  createDefaultAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";

const appSettings: AppSettings = createDefaultAppSettings();
const nextAppSettings: AppSettings = {
  ...createDefaultAppSettings(),
  autoCollapseActionDockOnSend: false,
  scrollToLatestOnSend: false,
};

/** 設定取得の Promise に登録済みの反映処理が走るまで、マイクロタスクを一回進める。 */
const flushPromises = () =>
  new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });

/** 設定 API が存在しない環境でも解除関数を呼べ、設定適用を起こさないことを確かめる。 */
test("startAppSettingsSubscription は api 不在なら no-op cleanup を返す", () => {
  const updates: AppSettings[] = [];

  const cleanup = startAppSettingsSubscription({
    api: null,
    loadInitial: true,
    /** API 不在でも通知された設定があれば捕捉する。 */
    applyAppSettings: (settings) => updates.push(settings),
  });
  cleanup();

  assert.deepEqual(updates, []);
});

// @test-value v2
// kind = "contract"
// claim = "初回AppSettingsと購読更新を順に反映し、cleanup後の更新を無視する"
// oracle = { type = "contract", ref = "startAppSettingsSubscription public update contract" }
// fault = "初回値・購読値の欠落、順序逆転、またはcleanup後の副作用"
// observable = "applyAppSettingsの呼び出し列とunsubscribe回数"
// observation_boundary = "public-boundary"
// scope = "startAppSettingsSubscription initial and subscribed updates"
// lifecycle = "permanent"
// @end-test-value
/** 初回値と購読更新がその順に適用され、解除は一度だけ呼ばれ、解除後の通知は無視されることを確かめる。 */
test("startAppSettingsSubscription は初回取得と購読更新を反映する", async () => {
  const updates: AppSettings[] = [];
  let subscribedListener: ((settings: AppSettings) => void) | null = null;
  let unsubscribeCount = 0;
  const api: AppSettingsSubscriptionApi = {
    /** 初回読み込み用に既定設定を返す。 */
    getAppSettings: async () => appSettings,
    /** 購読リスナーを捕捉し、解除が呼ばれた回数を記録できるようにする。 */
    subscribeAppSettings: (listener) => {
      subscribedListener = listener;
      return () => {
        unsubscribeCount += 1;
      };
    },
  };

  const cleanup = startAppSettingsSubscription({
    api,
    loadInitial: true,
    /** 初回応答と通知で適用された設定を到着順に記録する。 */
    applyAppSettings: (settings) => updates.push(settings),
  });
  await flushPromises();
  subscribedListener!(nextAppSettings);
  cleanup();
  subscribedListener!(appSettings);

  assert.deepEqual(updates, [appSettings, nextAppSettings]);
  assert.equal(unsubscribeCount, 1);
});

// @test-value v2
// kind = "invariant"
// claim = "購読更新後に遅れて到着した初回取得は新しいsettingsを巻き戻さない"
// oracle = { type = "contract", ref = "startAppSettingsSubscription stale initial load contract" }
// fault = "遅い初回取得が購読済みの新しいsettingsを上書きする"
// observable = "applyAppSettingsの呼び出し列"
// observation_boundary = "public-boundary"
// scope = "startAppSettingsSubscription stale initial settings"
// lifecycle = "permanent"
// @end-test-value
/** 購読から新しい設定が届いた後に古い初回応答が成功しても、新しい設定だけが適用されることを確かめる。 */
test("startAppSettingsSubscription は購読更新後に遅い初回取得で古い settings へ戻さない", async () => {
  const updates: AppSettings[] = [];
  /** 初回取得の応答を捕捉するまで使う、何もしない初期の解決関数。 */
  let resolveInitialSettings: (settings: AppSettings) => void = () => undefined;
  let subscribedListener: ((settings: AppSettings) => void) | null = null;
  const api: AppSettingsSubscriptionApi = {
    /** 初回値を購読更新より後に返せるよう、読み込みを保留する。 */
    getAppSettings: () =>
      new Promise((resolve) => {
        resolveInitialSettings = resolve;
      }),
    /** 初回値より先に更新を通知できるよう、購読リスナーを捕捉する。 */
    subscribeAppSettings: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startAppSettingsSubscription({
    api,
    loadInitial: true,
    /** 遅い初回値も含めて、実際に適用された設定を漏れなく記録する。 */
    applyAppSettings: (settings) => updates.push(settings),
  });
  subscribedListener!(nextAppSettings);
  resolveInitialSettings(appSettings);
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [nextAppSettings]);
});

// @test-value v2
// kind = "invariant"
// claim = "購読更新後の遅い初回取得失敗はfallback callbackを呼ばない"
// oracle = { type = "contract", ref = "startAppSettingsSubscription stale initial error contract" }
// fault = "既に購読更新を適用した後の初回取得失敗で不要なerror fallbackが発生する"
// observable = "onInitialLoadErrorの呼び出し回数"
// observation_boundary = "public-boundary"
// scope = "startAppSettingsSubscription stale initial error"
// lifecycle = "permanent"
// @end-test-value
/** 購読更新の反映後に初回取得が失敗しても、不要なフォールバックを実行しないことを確かめる。 */
test("startAppSettingsSubscription は購読更新後に遅い初回取得失敗 fallback を呼ばない", async () => {
  let errorCount = 0;
  /** 初回取得の拒否操作を捕捉するまで使う、何もしない初期関数。 */
  let rejectInitialSettings: (error: Error) => void = () => undefined;
  let subscribedListener: ((settings: AppSettings) => void) | null = null;
  const api: AppSettingsSubscriptionApi = {
    /** 購読更新の後で失敗させるため、初回取得の結果を保留する。 */
    getAppSettings: () =>
      new Promise((_, reject) => {
        rejectInitialSettings = reject;
      }),
    /** 初回取得の失敗前に更新を通知するため購読リスナーを捕捉する。 */
    subscribeAppSettings: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startAppSettingsSubscription({
    api,
    loadInitial: true,
    /** 購読された設定自体は記録せず、初回エラーの副作用に注目する。 */
    applyAppSettings: () => undefined,
    /** 遅れて届いた失敗がフォールバックまで伝播した回数を数える。 */
    onInitialLoadError: () => {
      errorCount += 1;
    },
  });
  subscribedListener!(nextAppSettings);
  rejectInitialSettings(new Error("failed"));
  await flushPromises();
  cleanup();

  assert.equal(errorCount, 0);
});

// @test-value v2
// kind = "contract"
// claim = "loadInitial無効時は初回取得せず購読更新だけを反映する"
// oracle = { type = "contract", ref = "startAppSettingsSubscription loadInitial contract" }
// fault = "無効化した初回取得が実行されるか購読更新が欠落する"
// observable = "getAppSettings呼び出し回数と適用settings"
// observation_boundary = "public-boundary"
// scope = "startAppSettingsSubscription disabled initial load"
// lifecycle = "permanent"
// @end-test-value
/** 初回読み込みを無効にすると取得 API を呼ばず、購読通知だけを適用することを確かめる。 */
test("startAppSettingsSubscription は loadInitial 無効なら購読更新だけ反映する", async () => {
  const updates: AppSettings[] = [];
  let getCallCount = 0;
  let subscribedListener: ((settings: AppSettings) => void) | null = null;
  const api: AppSettingsSubscriptionApi = {
    /** 初回読み込みが誤って行われた場合に、呼び出し回数を数える。 */
    getAppSettings: async () => {
      getCallCount += 1;
      return appSettings;
    },
    /** 読み込み無効時にも購読通知を試せるようリスナーを捕捉する。 */
    subscribeAppSettings: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startAppSettingsSubscription({
    api,
    loadInitial: false,
    /** 読み込み無効時に反映された設定を記録する。 */
    applyAppSettings: (settings) => updates.push(settings),
  });
  await flushPromises();
  subscribedListener!(nextAppSettings);
  cleanup();

  assert.equal(getCallCount, 0);
  assert.deepEqual(updates, [nextAppSettings]);
});

/** 購読更新がないまま初回取得に失敗した場合は、フォールバックを一度呼ぶことを確かめる。 */
test("startAppSettingsSubscription は初回取得失敗時に fallback callback を呼ぶ", async () => {
  let errorCount = 0;
  const api: AppSettingsSubscriptionApi = {
    /** 初回読み込みが失敗した状態を再現する。 */
    getAppSettings: async () => {
      throw new Error("failed");
    },
    /** 設定更新は通知せず、呼び出し可能な購読解除だけを返す。 */
    subscribeAppSettings: () => () => undefined,
  };

  const cleanup = startAppSettingsSubscription({
    api,
    loadInitial: true,
    /** 設定値の適用は記録せず、初回エラーの通知を観測する。 */
    applyAppSettings: () => undefined,
    /** 初回失敗のフォールバックが実行された回数を数える。 */
    onInitialLoadError: () => {
      errorCount += 1;
    },
  });
  await flushPromises();
  cleanup();

  assert.equal(errorCount, 1);
});

/** 購読を解除してから初回取得が成功しても、その結果を適用しないことを確かめる。 */
test("startAppSettingsSubscription は cleanup 後の初回取得結果を反映しない", async () => {
  const updates: AppSettings[] = [];
  /** 初回取得の解決操作を捕捉するまで使う、何もしない初期関数。 */
  let resolveSettings: (settings: AppSettings) => void = () => undefined;
  const api: AppSettingsSubscriptionApi = {
    /** 解除後に設定を返せるよう、初回取得の Promise を保留する。 */
    getAppSettings: () =>
      new Promise((resolve) => {
        resolveSettings = resolve;
      }),
    /** 設定の変更を送らず、何もしない購読解除を返す。 */
    subscribeAppSettings: () => () => undefined,
  };

  const cleanup = startAppSettingsSubscription({
    api,
    loadInitial: true,
    /** 解除後も応答が設定適用に届いてしまった場合に記録する。 */
    applyAppSettings: (settings) => updates.push(settings),
  });
  cleanup();
  resolveSettings(appSettings);
  await flushPromises();

  assert.deepEqual(updates, []);
});

// @test-value v2
// kind = "contract"
// claim = "Session Window Appはapp settingsの初回取得と購読更新を共通subscription helperへ委譲する"
// oracle = { type = "contract", ref = "src/app/SessionWindowApp.tsx app settings subscription" }
// fault = "Appがapp settingsを直接取得して購読更新を適用し、初回取得の設定や更新経路をhelperから外す"
// observable = "SessionWindowApp source内のstartAppSettingsSubscription呼び出しとloadInitial設定"
// observation_boundary = "declaration"
// scope = "app-settings-subscription SessionWindowApp integration"
// lifecycle = "permanent"
// @end-test-value
/** Session Window の設定反映が共通購読ヘルパーに接続され、初回取得も有効にしていることをソース上の宣言から確かめる。 */
test("App は app settings の初回取得と購読更新を helper に通す", async () => {
  const source = await readFile(
    new URL("../../src/app/SessionWindowApp.tsx", import.meta.url),
    "utf8",
  );
  const subscriptionIndex = source.indexOf("startAppSettingsSubscription({");
  const snippet = source.slice(subscriptionIndex, subscriptionIndex + 220);

  assert.notEqual(subscriptionIndex, -1);
  assert.match(snippet, /loadInitial: true/);
});

// @test-value v2
// kind = "contract"
// claim = "Homeはapp settingsの初期取得と購読更新を共通subscription helperへ委譲する"
// oracle = { type = "contract", ref = "src/home/HomeApp.tsx app settings subscription" }
// fault = "Homeがapp settingsを直接取得し、helperの初期取得・購読更新経路を迂回する"
// observable = "HomeApp source内のstartAppSettingsSubscription呼び出しと直接getAppSettings呼び出しの不在"
// observation_boundary = "declaration"
// scope = "app-settings-subscription HomeApp integration"
// lifecycle = "permanent"
// @end-test-value
/** Home が初回取得を有効にした共通購読ヘルパーを呼び、従来の直接取得を併用しないことをソースで確かめる。 */
test("Home は app settings 初期取得と購読更新を helper に通す", async () => {
  const homeSource = await readFile(
    new URL("../../src/home/HomeApp.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    homeSource.slice(
      homeSource.indexOf("startAppSettingsSubscription({"),
      homeSource.indexOf("startAppSettingsSubscription({") + 220,
    ),
    /loadInitial: true/,
  );
  assert.doesNotMatch(homeSource, /withmateApi\.getAppSettings\(\),/);
});

/** Main のチャットレイアウト設定更新処理が、アプリ全体の設定を一斉通知する関数を呼ばないことをソースで確かめる。 */
test("chat layout preference 切替は全体 app settings を broadcast しない", async () => {
  const mainSource = await readFile(
    new URL("../../src-electron/main.ts", import.meta.url),
    "utf8",
  );
  const functionStart = mainSource.indexOf(
    "function updateChatLayoutPreference",
  );
  const functionEnd = mainSource.indexOf("\n}", functionStart);
  const functionSource = mainSource.slice(functionStart, functionEnd);

  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);
  assert.doesNotMatch(functionSource, /broadcastAppSettings/);
});
