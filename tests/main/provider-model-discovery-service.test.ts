import assert from "node:assert/strict";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { it } from "node:test";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ListProviderModelsInput, ProviderCodingAdapter } from "../../src-electron/providers/provider-runtime.js";
import type { CachedProviderModels } from "../../src-electron/settings/model-catalog-storage.js";
import { ProviderModelDiscoveryService } from "../../src-electron/settings/provider-model-discovery-service.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function catalog(id = "codex", model = "available-model"): ModelCatalogProvider {
  return { id, label: id, defaultModelId: model, defaultReasoningEffort: "",
    models: model ? [{ id: model, label: model, reasoningEfforts: [] }] : [] };
}

function harness() {
  const settings = createDefaultAppSettings();
  const environment: NodeJS.ProcessEnv = {};
  const entries: CachedProviderModels[] = [];
  const changed: ModelCatalogSnapshot[] = [];
  const calls: { id: string; input: ListProviderModelsInput }[] = [];
  let now = Date.parse("2026-10-27T00:00:00.000Z");
  let list: (id: string, input: ListProviderModelsInput) => Promise<ModelCatalogProvider> = async (id) => catalog(id);
  const unexpected = (): never => { throw new Error("Discovery must not invoke a generation operation"); };
  const create = () => new ProviderModelDiscoveryService({
    getAppSettings: () => structuredClone(settings),
    getCachedProviders: () => structuredClone(entries),
    upsertProvider: (entry) => {
      const index = entries.findIndex((candidate) => candidate.provider.id === entry.provider.id && candidate.contextKey === entry.contextKey);
      if (index < 0) entries.push(structuredClone(entry));
      else entries[index] = structuredClone(entry);
    },
    getAdapter: (id): ProviderCodingAdapter => ({
      listModels: (input) => { calls.push({ id, input }); return list(id, input); },
      composePrompt: unexpected,
      getProviderQuotaTelemetry: unexpected,
      invalidateSessionThread: unexpected,
      invalidateAllSessionThreads: unexpected,
      runSessionTurn: unexpected,
    }),
    defaultWorkspace: () => path.resolve("workspace-a"),
    onChanged: (snapshot) => changed.push(snapshot),
    now: () => now,
    environment,
  });
  return { settings, environment, entries, changed, calls, create,
    advance: (milliseconds: number) => { now += milliseconds; },
    list: (implementation: typeof list) => { list = implementation; } };
}

function models(snapshot: ModelCatalogSnapshot, id = "codex") {
  return snapshot.providers.find((provider) => provider.id === id)?.models.map((model) => model.id);
}

// @test-value v2
// kind = "contract"
// claim = "有効providerだけを初期探索し、cacheはservice再生成後もSDK待ちなしで返し、10分超の同一context探索を共有する"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md" }
// fault = "無効providerを探索する、cacheを再利用しない、またはstale読取ごとにSDKを重複起動する"
// observable = "getのsnapshot、onChanged、adapter呼出し件数と保存された候補"
// observation_boundary = "public-boundary"
// scope = "provider discovery cache lifecycle"
// lifecycle = "permanent"
// impact = "Session候補の表示が外部SDK待ちになり不要なprocessを起動する"
// distinction = "SQLite単体testでは非同期SDKとcacheの連携を検出できず、固定時計と制御promiseで安価に確認する"
// @end-test-value
it("returns persisted candidates immediately and coalesces stale discovery for enabled providers", { timeout: 2_000 }, async (t) => {
  const h = harness();
  let pending = deferred<ModelCatalogProvider>();
  h.list(() => pending.promise);
  const first = h.create();
  t.after(async () => { pending.resolve(catalog()); await first.close(); });
  const initial = await first.get();
  assert.deepEqual(models(initial), []);
  assert.equal(initial.discovery?.codex?.status, "loading");
  assert.deepEqual(h.calls.map((call) => call.id), ["codex"]);
  pending.resolve(catalog());
  await setImmediate();
  assert.deepEqual(models(h.changed.at(-1)!), ["available-model"]);
  await first.close();

  const recreated = h.create();
  t.after(() => recreated.close());
  assert.deepEqual(models(await recreated.get()), ["available-model"]);
  assert.equal(h.calls.length, 1);
  h.advance(10 * 60_000 + 1);
  pending = deferred<ModelCatalogProvider>();
  const stale = await recreated.get();
  assert.deepEqual(models(stale), ["available-model"]);
  assert.equal(stale.discovery?.codex?.status, "loading");
  assert.deepEqual(models(await recreated.get()), ["available-model"]);
  assert.equal(h.calls.length, 2);
  pending.resolve(catalog("codex", "refreshed-model"));
  await setImmediate();
  assert.deepEqual(models(h.changed.at(-1)!), ["refreshed-model"]);
  assert.equal(h.entries.length, 1);
});

// @test-value v2
// kind = "contract"
// claim = "再探索失敗は既存候補を保持したerrorであり、成功した0件はreadyとして区別する"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md" }
// fault = "取得失敗でcacheを空にするか成功として扱う、または成功0件をerrorにする"
// observable = "失敗と成功後のonChanged候補、status、error、保存候補"
// observation_boundary = "public-boundary"
// scope = "provider discovery error and empty result"
// lifecycle = "permanent"
// impact = "認証障害を候補なしと誤表示し利用可能な選択肢を失う"
// distinction = "adapter単体testではcache保持と公開状態の区別を検出できない"
// @end-test-value
it("retains cached candidates on failure and distinguishes a successful empty response", async (t) => {
  const h = harness();
  const service = h.create();
  t.after(() => service.close());
  await service.ensure("codex");
  const cached = structuredClone(h.entries);
  h.advance(10 * 60_000 + 1);
  h.list(async () => { throw new Error("secret-token"); });
  await service.get();
  await setImmediate();
  const failed = h.changed.at(-1)!;
  assert.deepEqual(models(failed), ["available-model"]);
  assert.equal(failed.discovery?.codex?.status, "error");
  assert.ok(failed.discovery?.codex?.error);
  assert.ok(!JSON.stringify(failed).includes("secret-token"));
  assert.deepEqual(h.entries, cached);
  h.list(async () => catalog("codex", ""));
  h.advance(30_001);
  await service.refreshEnabled();
  await setImmediate();
  const empty = h.changed.at(-1)!;
  assert.deepEqual(models(empty), []);
  assert.equal(empty.discovery?.codex?.status, "ready");
  assert.equal(empty.discovery?.codex?.error, undefined);
  assert.deepEqual(h.entries[0]?.provider.models, []);
});

// @test-value v2
// kind = "contract"
// claim = "初期選択は背景取得失敗後も同contextの既定model cacheを利用でき、cacheなし失敗と正常0件を区別する"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md#cacheと更新" }
// fault = "保持cacheをerror状態だけで拒否する、別workspaceのcacheへfallbackする、または正常0件を失敗へ変換する"
// observable = "ensureの既定modelとdiscovery状態、SDK呼出し数、cacheなし時の拒否と正常0件snapshot"
// observation_boundary = "public-boundary"
// scope = "initial model selection after discovery failure"
// lifecycle = "permanent"
// impact = "providerの一時障害だけで保存済み候補を使う新規会話が作れなくなるか別contextのmodelを誤使用する"
// distinction = "既存のcache表示testでは初期選択用ensureの拒否条件とfallback禁止を観測しない。固定時計とfake adapterだけで検証する"
// @end-test-value
it("uses the same-context cached default after refresh failure without masking uncached failure or empty success", async (t) => {
  const h = harness();
  const service = h.create();
  t.after(() => service.close());
  await service.ensure("codex");
  h.advance(10 * 60_000 + 1);
  h.list(async () => { throw new Error("Connection failed"); });
  await service.get({ providerId: "codex" });
  await setImmediate();

  const cached = await service.ensure("codex");
  assert.equal(cached.providers.find((provider) => provider.id === "codex")?.defaultModelId, "available-model");
  assert.equal(cached.discovery?.codex?.status, "error");
  assert.equal(h.calls.length, 2);
  await assert.rejects(service.ensure("codex", path.resolve("uncached-workspace")), /Model discovery failed/);
  assert.equal(h.calls.length, 3);

  h.list(async () => catalog("codex", ""));
  const empty = await service.ensure("codex", path.resolve("empty-workspace"));
  assert.equal(empty.discovery?.codex?.status, "ready");
  assert.equal(empty.providers.find((provider) => provider.id === "codex")?.defaultModelId, "");
  assert.deepEqual(models(empty), []);
});

// @test-value v2
// kind = "contract"
// claim = "候補cacheはprovider、workspace、provider設定と認証環境が一致した場合だけ再利用する"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md" }
// fault = "別workspace、providerまたは認証contextの候補を流用する"
// observable = "context変更直後のget候補と元contextへ戻した際の保存候補"
// observation_boundary = "public-boundary"
// scope = "provider discovery context isolation"
// lifecycle = "permanent"
// impact = "別接続先のmodelを選べると誤認する"
// distinction = "保存keyの単体testではserviceが現在contextだけを公開する保証にならない"
// @end-test-value
it("isolates provider, workspace, settings and credential environment caches", async (t) => {
  const h = harness();
  h.settings.codingProviderSettings.claude = { enabled: true, apiKey: "", skillRootPath: "" };
  const service = h.create();
  const pending = deferred<ModelCatalogProvider>();
  t.after(async () => { pending.resolve(catalog()); await service.close(); });
  await service.ensure("codex");
  h.list((id) => id === "codex" ? pending.promise : Promise.resolve(catalog(id, "claude-model")));
  assert.deepEqual(models(await service.get({ providerId: "claude" }), "claude"), []);
  await setImmediate();
  assert.deepEqual(models(await service.get({ providerId: "claude" }), "claude"), ["claude-model"]);
  const otherWorkspace = await service.get({ providerId: "codex", workspacePath: path.resolve("workspace-b") });
  assert.deepEqual(models(otherWorkspace), []);
  h.settings.codingProviderSettings.codex!.apiKey = "new-key";
  assert.deepEqual(models(await service.get({ providerId: "codex" })), []);
  h.settings.codingProviderSettings.codex!.apiKey = "";
  h.environment.OPENAI_API_KEY = "new-environment-key";
  assert.deepEqual(models(await service.get({ providerId: "codex" })), []);
  delete h.environment.OPENAI_API_KEY;
  assert.deepEqual(models(await service.get({ providerId: "codex" })), ["available-model"]);
  pending.resolve(catalog());
  await setImmediate();
});

// @test-value v2
// kind = "contract"
// claim = "認証context変更前に開始した探索の遅延結果は新しいcontextの候補へ適用しない"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md" }
// fault = "古い認証で取得した候補を現contextへ保存または公開する"
// observable = "旧探索完了後の保存候補と新contextのget候補"
// observation_boundary = "public-boundary"
// scope = "late provider discovery result"
// lifecycle = "permanent"
// impact = "接続を変更しても旧accountのmodel候補が表示される"
// distinction = "context keyの静的検査では実行中SDKと設定変更の競合を検出できない"
// @end-test-value
it("discards a late result after authentication changes", async (t) => {
  const h = harness();
  const old = deferred<ModelCatalogProvider>();
  const current = deferred<ModelCatalogProvider>();
  h.list((_id, input) => input.appSettings.codingProviderSettings.codex?.apiKey ? current.promise : old.promise);
  const service = h.create();
  t.after(async () => { old.resolve(catalog()); current.resolve(catalog()); await service.close(); });
  await service.get({ providerId: "codex" });
  h.settings.codingProviderSettings.codex!.apiKey = "new-account";
  await service.get({ providerId: "codex" });
  old.resolve(catalog("codex", "old-account-model"));
  await setImmediate();
  assert.deepEqual(h.entries, []);
  assert.deepEqual(models(await service.get({ providerId: "codex" })), []);
  current.resolve(catalog("codex", "new-account-model"));
  await setImmediate();
  assert.deepEqual(models(h.changed.at(-1)!), ["new-account-model"]);
  assert.equal(h.entries.length, 1);
});

// @test-value v2
// kind = "contract"
// claim = "storage世代のcloseは探索を取消しadapter cleanup完了を待ち、その後の保存と通知を行わない"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md" }
// fault = "SDK cleanup前にcloseを解決するかclose後に候補を書き込む"
// observable = "AbortSignal、close完了順、cache書込とonChanged件数"
// observation_boundary = "public-boundary"
// scope = "provider discovery storage generation shutdown"
// lifecycle = "permanent"
// impact = "storage終了後の書込や旧世代processの残存が起きる"
// distinction = "adapter停止単体testではservice closeの待機境界を確認できない"
// @end-test-value
it("aborts discovery and awaits adapter cleanup before closing its storage generation", async (t) => {
  const h = harness();
  const cleanup = deferred<void>();
  let signal: AbortSignal | undefined;
  h.list(async (_id, input) => {
    signal = input.signal;
    await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
    await cleanup.promise;
    return catalog();
  });
  const service = h.create();
  t.after(async () => { cleanup.resolve(); await service.close(); });
  await service.get({ providerId: "codex" });
  let storageClosed = false;
  const closing = service.close().then(() => { storageClosed = true; });
  assert.equal(signal?.aborted, true);
  await setImmediate();
  assert.equal(storageClosed, false);
  cleanup.resolve();
  await closing;
  assert.equal(storageClosed, true);
  assert.deepEqual(h.entries, []);
  assert.deepEqual(h.changed, []);
  await service.get({ providerId: "codex" });
  assert.equal(h.calls.length, 1);
});
