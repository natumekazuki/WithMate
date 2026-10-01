import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { ModelCatalogStorage } from "../../src-electron/settings/model-catalog-storage.js";

describe("ModelCatalogStorage", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "resetToBundledは同梱catalogのprovider一式へ戻し、Codexの既定model definitionを維持する"
  // oracle = { type = "contract", ref = "public/model-catalog.json#providers; docs/design/model-catalog.md#seed-policy" }
  // fault = "reset時に登録済みClaudeを除外するか、Codexのreasoning effort定義を失う"
  // observable = "reset後にexportしたprovider ID集合とCodex GPT-5.6 SolのreasoningEfforts"
  // observation_boundary = "public-boundary"
  // scope = "model-catalog-reset-to-bundled"
  // lifecycle = "permanent"
  // impact = "reset後にClaudeのcatalog選択肢が欠落するか、既定Codex modelの有効なdepth選択が変わる"
  // distinction = "database schemaと型は同梱catalogの内容やreset結果との一致を検証しない"
  // @end-test-value
  it("resetToBundled で bundled catalog の初期状態へ戻せる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-model-catalog-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const bundledCatalogPath = path.resolve("public/model-catalog.json");

    try {
      const storage = new ModelCatalogStorage(dbPath, bundledCatalogPath);
      const seeded = storage.ensureSeeded();
      const seededDocument = storage.exportCatalogDocument(seeded.revision);
      storage.importCatalogDocument({
        providers: [
          {
            id: "codex",
            label: "Codex Custom",
            defaultModelId: "gpt-5-custom",
            defaultReasoningEffort: "medium",
            models: [
              {
                id: "gpt-5-custom",
                label: "GPT-5 Custom",
                reasoningEfforts: ["medium", "high"],
              },
            ],
          },
        ],
      });

      const reset = storage.resetToBundled();
      const exported = storage.exportCatalogDocument(null);
      storage.close();

      assert.equal(reset.revision, 1);
      assert.deepEqual(exported, seededDocument);
      assert.deepEqual(new Set(exported?.providers.map((provider) => provider.id)), new Set(["codex", "claude", "copilot"]));
      assert.deepEqual(
        exported?.providers
          .find((provider) => provider.id === "codex")
          ?.models.find((model) => model.id === "gpt-5.6-sol")
          ?.reasoningEfforts,
        ["low", "medium", "high", "xhigh", "max", "ultra"],
      );
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "active catalogへのbundled provider補完はClaudeを追加し、既存Codex・Copilotの定義と履歴revisionを保持する"
  // oracle = { type = "contract", ref = "accepted behavior: additive bundled provider seeding preserves active catalog entries; docs/design/model-catalog.md#seed-policy" }
  // fault = "Claude追加時にcatalogをresetして利用者のCodex・Copilot設定を上書きするか、既存revisionを失う"
  // observable = "ensureSeeded後のprovider定義、revision番号、および前revisionの取得結果"
  // observation_boundary = "public-boundary"
  // scope = "model-catalog-additive-seeding"
  // lifecycle = "permanent"
  // impact = "provider追加のアプリ更新によって利用者がimportしたmodel catalog設定が失われる"
  // distinction = "schema validationはrevision間で既存providerの内容・履歴保持を比較しない"
  // @end-test-value
  it("既存 active catalog に不足 provider がある時は bundled catalog から補完する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-model-catalog-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const bundledCatalogPath = path.resolve("public/model-catalog.json");

    try {
      const storage = new ModelCatalogStorage(dbPath, bundledCatalogPath);
      const imported = storage.importCatalogDocument({
        providers: [
          {
            id: "codex",
            label: "Codex Custom",
            defaultModelId: "gpt-5-custom",
            defaultReasoningEffort: "medium",
            models: [
              {
                id: "gpt-5-custom",
                label: "GPT-5 Custom",
                reasoningEfforts: ["medium", "high"],
              },
            ],
          },
          {
            id: "copilot",
            label: "Copilot Custom",
            defaultModelId: "copilot-custom",
            defaultReasoningEffort: "low",
            models: [
              {
                id: "copilot-custom",
                label: "Copilot Custom Model",
                reasoningEfforts: ["low", "medium"],
              },
            ],
          },
        ],
      });

      const ensured = storage.ensureSeeded();
      const previousRevision = storage.getCatalog(imported.revision);
      storage.close();

      assert.deepEqual(
        ensured.providers.map((provider) => provider.id).sort(),
        ["claude", "codex", "copilot"],
      );
      assert.ok(ensured.revision > imported.revision);
      assert.deepEqual(ensured.providers.find((provider) => provider.id === "codex"), imported.providers.find((provider) => provider.id === "codex"));
      assert.deepEqual(ensured.providers.find((provider) => provider.id === "copilot"), imported.providers.find((provider) => provider.id === "copilot"));
      assert.deepEqual(previousRevision, imported);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
