import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderCodingAdapter } from "../../src-electron/providers/provider-runtime.js";
import { MainObservabilityFacade } from "../../src-electron/app/main-observability-facade.js";
import { SessionObservabilityService } from "../../src-electron/session/session-observability-service.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { OpenCodeAdapter } from "../../src-electron/providers/opencode/opencode-adapter.js";
import type { OpenCodeClient } from "@opencode/client";

/** 外部配信を実行せずに観測状態を蓄積する実サービスを作る。 */
function createService() {
  return new SessionObservabilityService({
    /** 利用枠キャッシュの変更はこのサービス外へ配信しない。 */
    onProviderQuotaTelemetryChanged() {},
    /** セッション文脈の変更通知をテスト内に閉じる。 */
    onSessionContextTelemetryChanged() {},

    /** 実行状態の変更をウィンドウへ送らない。 */
    onLiveSessionRunChanged() {},
  });
}

// @test-value v2
// kind = "contract"
// claim = "有効化したOpenCodeの正常取得でGo枠がなければ、実adapterのnull結果を枠なしのunsupportedとして公開する"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "OpenCodeをpoll対象から除外するか、Go枠なしの取得結果をreadyや残量の数値へ変換する"
// observable = "実OpenCode adapterの取得回数と、Main cacheが公開するstatus、updatedAt、snapshots、rateLimits"
// observation_boundary = "public-boundary"
// scope = "OpenCode quota facade lifecycle"
// lifecycle = "permanent"
// impact = "取得不能を有効な残量と誤表示してprovider選択や利用判断を誤らせる"
// distinction = "実adapterとMainのpolling/cache経路を通し、nullがrenderer向けのunsupported状態となる境界を検証する"
// @end-test-value
/** Go 枠が存在しない実アダプター応答を未対応として保持し、無効化後は再取得しない。 */
test("OpenCode Go枠なしを実adapterからMain cacheへ投影する", async (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout", "setInterval"],
    now: 1000,
  });
  const service = createService();
  /** ポーリングに使ったサービスを検査終了時に停止する。 */
  t.after(() => service.dispose());
  const settings = createDefaultAppSettings();
  settings.codingProviderSettings.codex.enabled = false;
  settings.codingProviderSettings.opencode = {
    enabled: true,
    apiKey: "",
    skillRootPath: "",
  };
  const adapter = new OpenCodeAdapter({
    /** 実アダプターには外部プロセスに接続しない通信路を渡す。 */ createTransport:
      () => ({
        /** 利用枠 API だけを持つ最小の OpenCode クライアントを返す。 */
        start: async () =>
          ({
            experimental: {
              usage: {
                /** 正常応答で利用枠データがない状態を返す。 */ limits:
                  async () => ({ data: null }),
              },
            },
          }) as unknown as OpenCodeClient,
        /** 外部接続がないため閉鎖時に行う処理はない。 */
        close: async () => {},
        /** 通信路の閉鎖待ちは即座に完了させる。 */ whenClosed: () =>
          Promise.resolve(),
      }),
  });
  const fetchQuota = t.mock.method(adapter, "getProviderQuotaTelemetry");
  const facade = new MainObservabilityFacade({
    /** ポーリングと公開読取が同じ観測サービスを使うようにする。 */
    getSessionObservabilityService: () => service,
    /** OpenCode の有効化を変更する設定オブジェクトを供給する。 */
    getAppSettings: () => settings,
    providerQuotaStaleTtlMs: 1,
    /** 呼び出し回数を観測する実 OpenCode アダプターを返す。 */
    getProviderCodingAdapter: () => adapter,
  });
  /** 偽時計で発火した取得とキャッシュ更新の Promise を進める。 */
  const flush = async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve();
  };
  facade.configureProviderQuotaPolling(settings);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(fetchQuota.mock.callCount(), 1);
  const unsupported = {
    provider: "opencode",
    updatedAt: null,
    snapshots: [],
    status: "unsupported",
  };
  assert.deepEqual(
    await facade.getOrRefreshProviderQuotaTelemetry("opencode"),
    unsupported,
  );
  assert.equal(fetchQuota.mock.callCount(), 1);
  t.mock.timers.tick(300000);
  await flush();
  assert.equal(fetchQuota.mock.callCount(), 2);
  assert.deepEqual(facade.getProviderQuotaTelemetry("opencode"), unsupported);
  settings.codingProviderSettings.opencode.enabled = false;
  facade.configureProviderQuotaPolling(settings);
  t.mock.timers.tick(600000);
  await flush();
  assert.equal(fetchQuota.mock.callCount(), 2);
  assert.equal(
    await facade.getOrRefreshProviderQuotaTelemetry("opencode"),
    null,
  );
});

// @test-value v2
// kind = "contract"
// claim = "共通残量UIのcacheOnly読取はCopilotもremote取得せず、既存の通常読取はstale時に更新できる"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md#共通の残量表示" }
// fault = "cacheOnlyを無視してWindow追加でprovider取得を増やすか、通常のCopilot読取までcacheOnlyにする"
// observable = "cache空時・stale時の返値とadapter呼出回数、通常読取後の返値"
// observation_boundary = "public-boundary"
// scope = "Main quota cacheOnly / Copilot refresh boundary"
// lifecycle = "permanent"
// impact = "Window数に比例したproviderアクセス、または既存Copilot残量更新の停止を招く"
// distinction = "renderer mockではMainのremote取得抑止と通常経路の維持を観測できない"
// @end-test-value
/** キャッシュ専用読取は空または古い値を返すだけで、通常の Copilot 読取では取得できる。 */
test("quota cacheOnlyはCopilotのremote更新を増やさず通常readを維持する", async (t) => {
  const service = createService();
  /** キャッシュの検査で使ったサービスを破棄する。 */
  t.after(() => service.dispose());
  let calls = 0;
  const fresh = {
    provider: "copilot",
    updatedAt: new Date().toISOString(),
    snapshots: [],
  };
  const facade = new MainObservabilityFacade({
    /** キャッシュ直接操作とファサードの参照先を揃える。 */
    getSessionObservabilityService: () => service,
    /** Copilot の通常取得に既定設定を渡す。 */
    getAppSettings: () => createDefaultAppSettings(),
    /** 利用枠読取以外のプロバイダー機能を切り離す。 */
    getProviderCodingAdapter: () =>
      ({
        /** 残量読取がプロンプト合成に踏み込めば検査を失敗させる。 */
        composePrompt() {
          throw new Error("not used");
        },
        /** 個別スレッドの無効化は残量取得では扱わない。 */
        async invalidateSessionThread() {},
        /** 残量取得で一括無効化の副作用を作らない。 */
        async invalidateAllSessionThreads() {},
        /** キャッシュ読取でターンが実行されることを許さない。 */
        async runSessionTurn() {
          throw new Error("not used");
        },
        /** 外部取得相当の呼び出しだけを数え、新しいキャッシュ候補を返す。 */
        getProviderQuotaTelemetry: async () => {
          calls++;
          return fresh;
        },
      }) satisfies ProviderCodingAdapter,
    providerQuotaStaleTtlMs: 0,
  });
  assert.equal(
    await facade.getOrRefreshProviderQuotaTelemetry("copilot", {
      cacheOnly: true,
    }),
    null,
  );
  const stale = { ...fresh, updatedAt: "2000-01-01T00:00:00Z" };
  facade.setProviderQuotaTelemetry("copilot", stale);
  assert.deepEqual(
    await facade.getOrRefreshProviderQuotaTelemetry("copilot", {
      cacheOnly: true,
    }),
    stale,
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    await facade.getOrRefreshProviderQuotaTelemetry("copilot"),
    fresh,
  );
  assert.equal(calls, 1);
});

// @test-value v2
// kind = "contract"
// claim = "有効providerだけを起動/設定変更時に取得し、無効化で停止し、Window取得はcache参照だけになる"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "無効providerを起動するか、認証変更で旧値を残すか、Window読取ごとに取得する"
// observable = "providerと認証設定ごとのadapter呼出し、設定変更直後とWindow取得結果"
// observation_boundary = "public-boundary"
// scope = "Main quota settings and window boundary"
// lifecycle = "permanent"
// impact = "意図しない認証先へのアクセスや別accountの残量表示を招く"
// distinction = "service単体では設定とadapterへの接続を通らず、mock clockで呼出し回数を直接確認する"
// @end-test-value
/** 有効設定や認証の変更にだけ追従し、ウィンドウ側のキャッシュ読取では再取得しない。 */
test("Main quotaは有効化と認証変更を反映しWindowから再取得しない", async (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout", "setInterval"],
    now: 1000,
  });
  const service = createService();
  /** 偽時計の検査を終える際にサービスを破棄する。 */
  t.after(() => service.dispose());
  const settings = createDefaultAppSettings();
  settings.codingProviderSettings.claude = {
    ...settings.codingProviderSettings.codex,
    enabled: false,
  };
  const calls: Array<[string, string]> = [];
  const facade = new MainObservabilityFacade({
    /** 現在値と認証変更直後の消去を観測するサービスを供給する。 */
    getSessionObservabilityService: () => service,
    /** 認証や有効状態の変更を加えた設定をそのまま返す。 */
    getAppSettings: () => settings,
    /** ポーリングに必要な利用枠取得だけを実装するアダプターを作る。 */
    getProviderCodingAdapter: () =>
      ({
        /** ポーリングからプロンプト合成が起動すれば失敗させる。 */
        composePrompt() {
          throw new Error("not used");
        },
        /** 利用枠ポーリングに不要な個別無効化を空の処理にする。 */
        async invalidateSessionThread() {},
        /** ポーリングと無関係な一括無効化を空の処理にする。 */
        async invalidateAllSessionThreads() {},
        /** 利用枠確認のためにセッションが実行されないことを守る。 */
        async runSessionTurn() {
          throw new Error("not used");
        },
        /** 取得対象のプロバイダーと認証値を記録し、現在時刻の成功結果を返す。 */
        async getProviderQuotaTelemetry(input) {
          calls.push([
            input.providerId,
            input.appSettings.codingProviderSettings[input.providerId].apiKey,
          ]);
          return {
            provider: input.providerId,
            updatedAt: new Date().toISOString(),
            snapshots: [],
            status: "ready",
          };
        },
      }) satisfies ProviderCodingAdapter,
    providerQuotaStaleTtlMs: 1,
  });
  /** 偽時計を進めた後、取得結果の反映に必要な非同期処理を進める。 */
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  facade.configureProviderQuotaPolling(settings);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(
    calls.map(([id]) => id),
    ["codex"],
  );
  t.mock.timers.tick(100);
  const cached = service.getProviderQuotaTelemetry("codex");
  assert.equal(
    await facade.getOrRefreshProviderQuotaTelemetry("codex"),
    cached,
  );
  facade.configureProviderQuotaPolling(settings);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls.length, 1);
  settings.codingProviderSettings.claude.enabled = true;
  settings.codingProviderSettings.codex.apiKey = "changed-fixture";
  facade.configureProviderQuotaPolling(settings);
  assert.equal(service.getProviderQuotaTelemetry("codex"), null);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(calls.slice(1), [
    ["codex", "changed-fixture"],
    ["claude", ""],
  ]);
  settings.codingProviderSettings.codex.enabled = false;
  settings.codingProviderSettings.claude.enabled = false;
  facade.configureProviderQuotaPolling(settings);
  facade.scheduleProviderQuotaTelemetryRefresh("codex", [3000]);
  t.mock.timers.tick(600000);
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(await facade.getOrRefreshProviderQuotaTelemetry("codex"), null);
  service.clearAllProviderQuotaTelemetry();
  settings.codingProviderSettings.codex.enabled = true;
  facade.configureProviderQuotaPolling(settings);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls.length, 4);
});

// @test-value v2
// kind = "contract"
// claim = "MainObservabilityFacadeがquota更新とsession observability stateをserviceへ委譲する"
// oracle = { type = "contract", ref = "src-electron/app/main-observability-facade.ts" }
// fault = "provider quota更新入力またはquota/context telemetryの取得結果がfacade境界で欠落・誤変換される"
// observable = "adapterへのquota入力とserviceから取得したtelemetry state"
// observation_boundary = "public-boundary"
// scope = "main-observability-facade"
// lifecycle = "permanent"
// @end-test-value
/** 更新時にアダプターへ設定を渡し、利用枠と文脈の観測値をサービスから公開する。 */
test("MainObservabilityFacade は observability service を透過し quota refresh を helper 経由で行う", async () => {
  const service = createService();
  const appSettings = createDefaultAppSettings();
  appSettings.codingProviderSettings.codex.apiKey = "quota-settings-fixture";
  const calls: Parameters<
    ProviderCodingAdapter["getProviderQuotaTelemetry"]
  >[0][] = [];
  const adapterProviderIds: Array<string | null | undefined> = [];
  const adapter = {
    /** 観測値の更新とは無関係なプロンプト合成を拒否する。 */
    composePrompt() {
      throw new Error("not used");
    },
    /** 更新条件を保存し、キャッシュに入る利用枠のサンプルを構成する。 */
    async getProviderQuotaTelemetry(input) {
      calls.push(input);
      return {
        provider: input.providerId,
        updatedAt: new Date().toISOString(),
        snapshots: [],
      };
    },
    /** 更新経路では使用しない個別無効化を空の処理にする。 */
    async invalidateSessionThread() {},
    /** アダプター契約を満たすだけの一括無効化処理。 */
    async invalidateAllSessionThreads() {},
    /** 観測値の取得がターンを開始しようとすれば失敗させる。 */
    async runSessionTurn() {
      throw new Error("not used");
    },
  } satisfies ProviderCodingAdapter;

  const facade = new MainObservabilityFacade({
    /** 取得済みの利用枠と文脈情報の更新先を共有する。 */
    getSessionObservabilityService: () => service,
    /** 認証入力の伝達を照合できる固定の設定を返す。 */
    getAppSettings: () => appSettings,
    /** アダプター選択時に渡されたプロバイダー ID を記録する。 */
    getProviderCodingAdapter(providerId) {
      adapterProviderIds.push(providerId);
      return adapter;
    },
    providerQuotaStaleTtlMs: 1000,
  });

  const refreshed = await facade.refreshProviderQuotaTelemetry("codex");
  facade.setSessionContextTelemetry("s-1", {
    provider: "copilot",
    sessionId: "s-1",
    updatedAt: new Date().toISOString(),
    tokenLimit: 1000,
    currentTokens: 200,
    messagesLength: 4,
  });

  assert.equal(refreshed?.provider, "codex");
  assert.equal(facade.getProviderQuotaTelemetry("codex")?.provider, "codex");
  assert.equal(facade.getSessionContextTelemetry("s-1")?.currentTokens, 200);
  assert.deepEqual(
    calls.map(({ signal, ...input }) => input),
    [{ providerId: "codex", appSettings }],
  );
  assert.equal(calls[0]?.signal?.aborted, false);
  assert.deepEqual(adapterProviderIds, ["codex"]);
});
