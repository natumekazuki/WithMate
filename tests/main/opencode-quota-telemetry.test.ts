import assert from "node:assert/strict";
import { it } from "node:test";
import { OpenCodeAdapter } from "../../src-electron/providers/opencode/opencode-adapter.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

const reset = "2026-11-26T10:53:43Z";
const window = { status: "ok", percent: 24, resetsAt: reset };
function input(apiKey = "test-key", signal?: AbortSignal) {
  const appSettings = createDefaultAppSettings();
  appSettings.codingProviderSettings.opencode = { ...appSettings.codingProviderSettings.opencode, apiKey };
  return { providerId: "opencode", appSettings, signal };
}

// @test-value v2
// kind = "contract"
// claim = "Goの認証済みGETで5時間・週・請求月の使用率とresetを取得し、請求月を固定日数へ変換しない"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "別endpointや生成APIを使う、使用率を反転する、windowを落とす、または月を30日と扱う"
// observable = "adapterからのtelemetryとHTTP request method・URL・Bearer・redirect policy"
// observation_boundary = "public-boundary"
// scope = "OpenCode quota HTTP to adapter projection"
// lifecycle = "permanent"
// impact = "契約枠の残量を誤表示せず、Quota確認で生成料金を発生させない"
// distinction = "共通cacheやrenderer testはprovider HTTP境界の投影を実行しない"
// @end-test-value
it("fetches Go usage and projects its three independent windows", async () => {
  let calls = 0;
  const adapter = new OpenCodeAdapter({ fetch: async (url, options) => {
    calls++;
    assert.equal(url, "https://opencode.ai/inference/go/v1/usage");
    assert.equal(options?.method, "GET");
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer test-key");
    assert.equal(options?.body, undefined);
    assert.equal(options?.redirect, "error");
    return Response.json({ usage: {
      rolling: { ...window, percent: 0 },
      weekly: { ...window, percent: 100, status: "rate-limited" },
      monthly: window,
    } });
  } });
  const before = Date.now();
  const result = await adapter.getProviderQuotaTelemetry(input(" test-key "));
  assert.equal(calls, 1);
  assert.equal(result?.provider, "opencode");
  assert.equal(result?.status, "ready");
  assert.ok(Date.parse(result!.updatedAt!) >= before);
  assert.deepEqual(result?.snapshots, []);
  assert.deepEqual(result?.rateLimits, [
    { quotaKey: "rolling", label: "5 hours", usedPercentage: 0, windowDurationMinutes: 300, resetDate: reset },
    { quotaKey: "weekly", label: "7 days", usedPercentage: 100, windowDurationMinutes: 10_080, resetDate: reset },
    { quotaKey: "monthly", label: "1 month", usedPercentage: 24, resetDate: reset },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "Go Quotaは設定キーを環境変数より優先し、両方が空ならHTTPを行わず取得不可を返す"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "設定と異なるaccountを照会するか、キーなしで未認証requestを繰り返す"
// observable = "HTTPへ渡すAuthorizationと回数、キーなしのnull結果"
// observation_boundary = "public-boundary"
// scope = "OpenCode quota credential resolution"
// lifecycle = "permanent"
// distinction = "foregroundのキー検査は独立したquota入口を通らない"
// @end-test-value
it("uses settings then environment credentials and skips requests without a key", async () => {
  const original = process.env.OPENCODE_API_KEY;
  const headers: Array<string | null> = [];
  const adapter = new OpenCodeAdapter({ fetch: async (_url, options) => {
    headers.push(new Headers(options?.headers).get("Authorization"));
    return Response.json({ usage: { monthly: window } });
  } });
  try {
    process.env.OPENCODE_API_KEY = " env-key ";
    await adapter.getProviderQuotaTelemetry(input("settings-key"));
    const partial = await adapter.getProviderQuotaTelemetry(input(" "));
    assert.deepEqual(partial?.rateLimits?.map((entry) => entry.quotaKey), ["monthly"]);
    delete process.env.OPENCODE_API_KEY;
    assert.equal(await adapter.getProviderQuotaTelemetry(input(" ")), null);
    assert.deepEqual(headers, ["Bearer settings-key", "Bearer env-key"]);
  } finally {
    if (original === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = original;
  }
});

// @test-value v2
// kind = "contract"
// claim = "Go Quotaの不正な応答を正常な空・使用率0として返さず失敗させる"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "window欠損、範囲外使用率、不正statusやresetを取得成功としてcacheへ渡す"
// observable = "adapterのrejectと秘密を含まないerror message"
// observation_boundary = "public-boundary"
// scope = "OpenCode quota external payload validation"
// lifecycle = "permanent"
// impact = "取得失敗を利用可能残量として誤表示しない"
// distinction = "runtime HTTP応答はTypeScript型検査で保証できない"
// @end-test-value
it("rejects empty and malformed quota data instead of inventing remaining capacity", async () => {
  for (const payload of [null, [], {}, { usage: [] }, { usage: {} }, { usage: { rolling: null } },
    ...[-1, 101, "24", null].map((percent) => ({ usage: { rolling: { ...window, percent } } })),
    { usage: { rolling: { ...window, status: "test-key" } } },
    { usage: { rolling: { ...window, resetsAt: "test-key" } } },
    { usage: { rolling: { status: "ok", percent: 24 } } },
  ]) {
    const adapter = new OpenCodeAdapter({ fetch: async () => Response.json(payload) });
    await assert.rejects(adapter.getProviderQuotaTelemetry(input()), (error: Error) => {
      assert.match(error.message, /OpenCode Go quota/);
      assert.ok(!error.message.includes("test-key"));
      return true;
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "HTTP・JSON・通信の失敗を失敗として伝え、responseや通信例外のsecretを公開しない"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "失敗bodyをusageとして使うか認証情報を含む例外をそのまま返す"
// observable = "adapterのrejectの固定messageとcause不在"
// observation_boundary = "public-boundary"
// scope = "OpenCode quota transport error sanitization"
// lifecycle = "permanent"
// risk_tags = ["privacy", "authentication"]
// distinction = "schema検査はHTTPやJSON parse以前の失敗を検証しない"
// @end-test-value
it("rejects HTTP and transport failures without leaking response or error details", async () => {
  for (const fetcher of [
    async () => new Response("test-key", { status: 401 }),
    async () => new Response("test-key", { status: 500 }),
    async () => new Response("test-key", { status: 200 }),
    async () => { throw new Error("connection error: test-key"); },
  ]) {
    const adapter = new OpenCodeAdapter({ fetch: fetcher });
    await assert.rejects(adapter.getProviderQuotaTelemetry(input()), (error: Error) => {
      assert.equal(error.message, "OpenCode Go quota request failed");
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "caller取消済みならHTTPを開始せず、取得中の取消はHTTP signalへ伝わり成功値を返さない"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "キー変更や終了後も旧accountのHTTPが続くか取消済みresponseを成功として返す"
// observable = "fetch回数、HTTP signal.aborted、adapter promiseのreject"
// observation_boundary = "public-boundary"
// scope = "OpenCode quota cancellation"
// lifecycle = "permanent"
// distinction = "cache invalidation testはproviderがHTTP取消を実際に受ける境界を検査しない"
// @end-test-value
it("propagates caller cancellation before and during a quota request", async () => {
  let calls = 0;
  let requestSignal: AbortSignal | null | undefined;
  let started!: () => void;
  const fetching = new Promise<void>((resolve) => { started = resolve; });
  const adapter = new OpenCodeAdapter({ fetch: async (_url, options) => {
    calls++;
    requestSignal = options?.signal;
    started();
    return new Promise<Response>((_resolve, reject) => {
      requestSignal!.addEventListener("abort", () => reject(new Error("test-key")), { once: true });
    });
  } });
  const alreadyCanceled = new AbortController();
  alreadyCanceled.abort();
  await assert.rejects(adapter.getProviderQuotaTelemetry(input("test-key", alreadyCanceled.signal)), /request canceled/);
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = adapter.getProviderQuotaTelemetry(input("test-key", controller.signal));
  const rejected = assert.rejects(pending, /request canceled/);
  await fetching;
  controller.abort();
  await rejected;
  assert.equal(requestSignal?.aborted, true);
  assert.equal(calls, 1);
});
