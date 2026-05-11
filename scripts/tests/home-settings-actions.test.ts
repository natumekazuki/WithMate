import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import {
  exportHomeModelCatalog,
  importHomeModelCatalog,
  resetHomeDatabase,
  saveHomeSettings,
  syncProviderInstructionTargetRoots,
  type HomeSettingsApi,
} from "../../src/settings/settings-actions.js";
import type { HomeProviderInstructionTargetDraft } from "../../src/settings/provider-instruction-target-draft.js";

function createApi(overrides?: Partial<HomeSettingsApi>): HomeSettingsApi {
  return {
    importModelCatalogFile: async () => null,
    exportModelCatalogFile: async () => null,
    updateAppSettings: async (settings) => settings,
    upsertProviderInstructionTarget: async () => null as never,
    resetAppDatabase: async () => ({
      resetTargets: ["sessions", "auditLogs"],
      sessions: [],
      appSettings: createDefaultAppSettings(),
      modelCatalog: { revision: 1, providers: [] },
    }),
    ...overrides,
  };
}

function createProviderInstructionTarget(overrides?: Partial<HomeProviderInstructionTargetDraft>): HomeProviderInstructionTargetDraft {
  return {
    providerId: "codex",
    targetId: "main",
    enabled: false,
    rootDirectory: "",
    instructionRelativePath: ".github/copilot-instructions.md",
    lastSyncState: "never",
    lastSyncRunId: null,
    lastSyncedRevisionId: null,
    lastErrorPreview: "",
    lastSyncedAt: null,
    writeMode: "managed_block",
    projectionScope: "mate_only",
    failPolicy: "warn_continue",
    requiresRestart: false,
    ...overrides,
  };
}

describe("home-settings-actions", () => {
  it("import/export の feedback を返す", async () => {
    const api = createApi({
      importModelCatalogFile: async () => ({ revision: 3, providers: [] }),
      exportModelCatalogFile: async () => "tmp/catalog.json",
    });

    assert.equal(await importHomeModelCatalog(api), "model catalog revision 3 を読み込んだよ。");
    assert.equal(await exportHomeModelCatalog(api), "model catalog を保存したよ: tmp/catalog.json");
  });

  it("save は nextSettings と feedback を返す", async () => {
    const settings = createDefaultAppSettings();
    settings.autoCollapseActionDockOnSend = false;

    const result = await saveHomeSettings(createApi(), settings);

    assert.equal(result.nextSettings.autoCollapseActionDockOnSend, false);
    assert.equal(result.feedback, "設定を保存したよ。");
  });

  it("reset は confirm と result を扱う", async () => {
    const api = createApi();
    const result = await resetHomeDatabase({
      api,
      resetTargets: ["sessions"],
      confirm: () => true,
    });

    assert.equal(result.kind, "success");
    if (result.kind === "success") {
      assert.equal(result.feedback, "sessions / audit logs を初期状態へ戻したよ。characters は保持したよ。");
      assert.deepEqual(result.result.resetTargets, ["sessions", "auditLogs"]);
    }
  });

  it("reset target が空なら noop、confirm false なら canceled を返す", async () => {
    const api = createApi();

    const noopResult = await resetHomeDatabase({
      api,
      resetTargets: [],
      confirm: () => true,
    });
    assert.deepEqual(noopResult, {
      kind: "noop",
      feedback: "初期化対象を 1 つ以上選んでね。",
    });

    const canceledResult = await resetHomeDatabase({
      api,
      resetTargets: ["sessions"],
      confirm: () => false,
    });
    assert.deepEqual(canceledResult, {
      kind: "canceled",
    });
  });

  it("syncProviderInstructionTargetRoots は既存 root が一致すれば upsert しない", async () => {
    const api = createApi();
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings = {
      ...settings.codingProviderSettings,
      codex: {
        ...settings.codingProviderSettings.codex,
        skillRootPath: "/workspace",
      },
    };

    const providerInstructionTargets = [createProviderInstructionTarget({ rootDirectory: "/workspace" })];
    const upsertCalls: unknown[] = [];
    const syncApi = createApi({
      ...api,
      upsertProviderInstructionTarget: async (input) => {
        upsertCalls.push(input);
        return null as never;
      },
    });

    const nextTargets = await syncProviderInstructionTargetRoots({
      api: syncApi,
      nextSettings: settings,
      providerInstructionTargets,
    });

    assert.equal(upsertCalls.length, 0);
    assert.equal(nextTargets.length, 1);
    assert.equal(nextTargets[0].rootDirectory, "/workspace");
  });

  it("syncProviderInstructionTargetRoots は root 変更分だけ upsert して更新した target を返す", async () => {
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings = {
      ...settings.codingProviderSettings,
      codex: {
        ...settings.codingProviderSettings.codex,
        skillRootPath: "/workspace/new-root",
      },
    };

    const providerInstructionTargets = [createProviderInstructionTarget({ rootDirectory: "/workspace/old-root" })];
    const upsertInputs: HomeProviderInstructionTargetDraft[] = [];
    const syncApi = createApi({
      upsertProviderInstructionTarget: async (input) => {
        upsertInputs.push(input as HomeProviderInstructionTargetDraft);
        return null as never;
      },
    });

    const nextTargets = await syncProviderInstructionTargetRoots({
      api: syncApi,
      nextSettings: settings,
      providerInstructionTargets,
    });

    assert.equal(upsertInputs.length, 1);
    assert.equal(upsertInputs[0].rootDirectory, "/workspace/new-root");
    assert.equal(nextTargets[0].rootDirectory, "/workspace/new-root");
  });
});
