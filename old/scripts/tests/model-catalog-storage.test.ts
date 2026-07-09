import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { ModelCatalogStorage } from "../../src-electron/model-catalog-storage.js";

describe("ModelCatalogStorage", () => {
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
      assert.deepEqual(
        exported?.providers.map((provider) => provider.id),
        ["codex", "copilot"],
      );
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("既存 active catalog に不足 provider がある時は bundled catalog から補完する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-model-catalog-"));
    const dbPath = path.join(tempDirectory, "withmate.db");
    const bundledCatalogPath = path.resolve("public/model-catalog.json");

    try {
      const storage = new ModelCatalogStorage(dbPath, bundledCatalogPath);
      storage.importCatalogDocument({
        providers: [
          {
            id: "codex",
            label: "Codex",
            defaultModelId: "gpt-5.4",
            defaultReasoningEffort: "high",
            models: [
              {
                id: "gpt-5.4",
                label: "GPT-5.4",
                reasoningEfforts: ["low", "medium", "high", "xhigh"],
              },
            ],
          },
        ],
      });

      const ensured = storage.ensureSeeded();
      storage.close();

      assert.deepEqual(
        ensured.providers.map((provider) => provider.id),
        ["codex", "copilot"],
      );
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
