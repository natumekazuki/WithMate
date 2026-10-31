import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ModelCatalogStorage, type CachedProviderModels } from "../../src-electron/settings/model-catalog-storage.js";

// @test-value v2
// kind = "contract"
// claim = "SDKモデルcacheはproviderと接続contextごとに保存され、再起動後も任意depthとSDK既定値を保持する"
// oracle = { type = "contract", ref = "Issue #879: SDK discovered models are cached persistently per provider connection context" }
// fault = "同providerの別contextを上書きするか、再open時にSDKモデルmetadataを失う"
// observable = "reopen後のgetCachedProviders結果とprovider単位clear後の残存cache"
// observation_boundary = "public-boundary"
// scope = "provider-model-cache-persistence"
// lifecycle = "permanent"
// impact = "workspace切替または再起動後に別接続のモデル候補や不正なdepthを提示する"
// distinction = "型検査とSQLite schema検査はJSON metadataの往復とcontext間の保存分離を検証しない"
// @end-test-value
test("モデルcacheは接続contextを分離してSDK metadataを再open後も保持する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-model-cache-"));
  const dbPath = path.join(directory, "withmate.db");
  let storage = new ModelCatalogStorage(dbPath);
  const first: CachedProviderModels = {
    provider: {
      id: "opencode", label: "OpenCode", defaultModelId: "sdk/model",
      defaultReasoningEffort: "adaptive",
      models: [{ id: "sdk/model", label: "SDK Model", sourceLabel: "SDK", reasoningEfforts: ["adaptive"], defaultReasoningEffort: "adaptive" }],
    },
    contextKey: "workspace-a", fetchedAt: "2026-10-27T00:00:00.000Z",
  };
  const second = { ...first, contextKey: "workspace-b", provider: { ...first.provider, models: [] } };
  const other = { ...first, provider: { ...first.provider, id: "codex" } };
  try {
    assert.deepEqual(storage.getCatalog(), { providers: [] });
    storage.upsertProvider(first);
    storage.upsertProvider(second);
    storage.upsertProvider(other);
    storage.close();
    storage = new ModelCatalogStorage(dbPath);
    assert.deepEqual(storage.getCachedProviders(), [other, first, second]);
    storage.clear("opencode");
    assert.deepEqual(storage.getCachedProviders(), [other]);
    storage.clear();
    assert.deepEqual(storage.getCachedProviders(), []);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
