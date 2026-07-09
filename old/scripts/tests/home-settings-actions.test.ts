import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import {
  exportHomeModelCatalog,
  importHomeModelCatalog,
  resetHomeDatabase,
  saveHomeSettings,
  deleteOldSessions,
  type HomeSettingsApi,
} from "../../src/settings/settings-actions.js";
import { buildSettingsCommandHandlers } from "../../src/settings/settings-command-handlers.js";
import type { AppSettings } from "../../src/provider-settings-state.js";
import type { WithMateWindowApi } from "../../src/withmate-window-api.js";

function createApi(overrides?: Partial<HomeSettingsApi>): HomeSettingsApi {
  return {
    importModelCatalogFile: async () => null,
    exportModelCatalogFile: async () => null,
    updateAppSettings: async (settings) => settings,
    resetAppDatabase: async () => ({
      resetTargets: ["sessions", "auditLogs"],
      sessions: [],
      appSettings: createDefaultAppSettings(),
      modelCatalog: { revision: 1, providers: [] },
    }),
    deleteSessionsLastActiveBefore: async () => ({
      cutoffDate: "2026-07-01",
      cutoffTimestampMs: 1782831600000,
      deletedSessionIds: ["s-1"],
      skippedRunningSessionIds: [],
    }),
    ...overrides,
  };
}

async function flushAsyncHandlers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
      assert.equal(result.feedback, "sessions / audit logs を初期状態へ戻したよ。characters file body は保持したよ。");
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

  it("old session delete は confirm と result を扱う", async () => {
    const api = createApi();
    const result = await deleteOldSessions({
      api,
      cutoffDate: "2026-07-01",
      confirm: () => true,
    });

    assert.equal(result.kind, "success");
    if (result.kind === "success") {
      assert.equal(result.feedback, "1 件の古い Session を削除したよ。");
      assert.deepEqual(result.result.deletedSessionIds, ["s-1"]);
    }
  });

  it("old session delete は cutoff 未指定なら noop、confirm false なら canceled を返す", async () => {
    const api = createApi();

    const noopResult = await deleteOldSessions({
      api,
      cutoffDate: "",
      confirm: () => true,
    });
    assert.deepEqual(noopResult, {
      kind: "noop",
      feedback: "削除基準日を選んでね。",
    });

    const canceledResult = await deleteOldSessions({
      api,
      cutoffDate: "2026-07-01",
      confirm: () => false,
    });
    assert.deepEqual(canceledResult, {
      kind: "canceled",
    });
  });

  it("provider skill root picker は選択 path を draft に反映する", async () => {
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings.codex = {
      enabled: true,
      apiKey: "key",
      skillRootPath: "C:/before",
      skillRelativePath: ".codex/skills",
      instructionRelativePath: "AGENTS.md",
    };
    let draft: AppSettings = settings;
    let feedback = "";
    const handlers = buildSettingsCommandHandlers({
      getApi: () => ({
        pickDirectory: async (initialPath) => {
          assert.equal(initialPath, "C:/before");
          return "C:/after";
        },
      } as Partial<WithMateWindowApi> as WithMateWindowApi),
      persistedSettingsDraft: settings,
      setAppSettings: () => undefined,
      setSettingsDraft: (nextSettings) => {
        draft = nextSettings;
      },
      setSettingsFeedback: (nextFeedback) => {
        feedback = nextFeedback;
      },
      setMemoryV6Diagnostics: () => undefined,
    });

    handlers.onBrowseProviderSkillRootPath("codex");
    await flushAsyncHandlers();

    assert.equal(draft.codingProviderSettings.codex.skillRootPath, "C:/after");
    assert.equal(draft.codingProviderSettings.codex.skillRelativePath, ".codex/skills");
    assert.equal(draft.codingProviderSettings.codex.instructionRelativePath, "AGENTS.md");
    assert.equal(draft.codingProviderSettings.codex.enabled, true);
    assert.match(feedback, /反映した/);
  });

  it("provider skill relative picker は Root Directory 配下の相対 path を draft に反映する", async () => {
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings.codex = {
      enabled: true,
      apiKey: "key",
      skillRootPath: "C:/workspace",
      skillRelativePath: "",
      instructionRelativePath: "AGENTS.md",
    };
    let draft: AppSettings = settings;
    let feedback = "";
    const handlers = buildSettingsCommandHandlers({
      getApi: () => ({
        pickDirectory: async (initialPath) => {
          assert.equal(initialPath, "C:/workspace");
          return "C:/workspace/.codex/skills";
        },
      } as Partial<WithMateWindowApi> as WithMateWindowApi),
      persistedSettingsDraft: settings,
      setAppSettings: () => undefined,
      setSettingsDraft: (nextSettings) => {
        draft = nextSettings;
      },
      setSettingsFeedback: (nextFeedback) => {
        feedback = nextFeedback;
      },
      setMemoryV6Diagnostics: () => undefined,
    });

    handlers.onBrowseProviderSkillRelativePath("codex");
    await flushAsyncHandlers();

    assert.equal(draft.codingProviderSettings.codex.skillRootPath, "C:/workspace");
    assert.equal(draft.codingProviderSettings.codex.skillRelativePath, ".codex/skills");
    assert.equal(draft.codingProviderSettings.codex.instructionRelativePath, "AGENTS.md");
    assert.match(feedback, /Skill Relative Path/);
  });

  it("provider instruction relative picker は Root Directory 配下の相対 path を draft に反映する", async () => {
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings.codex = {
      enabled: true,
      apiKey: "key",
      skillRootPath: "C:/workspace",
      skillRelativePath: ".codex/skills",
      instructionRelativePath: "",
    };
    let draft: AppSettings = settings;
    let feedback = "";
    const handlers = buildSettingsCommandHandlers({
      getApi: () => ({
        pickFile: async (initialPath) => {
          assert.equal(initialPath, "C:/workspace");
          return "C:/workspace/AGENTS.md";
        },
      } as Partial<WithMateWindowApi> as WithMateWindowApi),
      persistedSettingsDraft: settings,
      setAppSettings: () => undefined,
      setSettingsDraft: (nextSettings) => {
        draft = nextSettings;
      },
      setSettingsFeedback: (nextFeedback) => {
        feedback = nextFeedback;
      },
      setMemoryV6Diagnostics: () => undefined,
    });

    handlers.onBrowseProviderInstructionRelativePath("codex");
    await flushAsyncHandlers();

    assert.equal(draft.codingProviderSettings.codex.skillRootPath, "C:/workspace");
    assert.equal(draft.codingProviderSettings.codex.skillRelativePath, ".codex/skills");
    assert.equal(draft.codingProviderSettings.codex.instructionRelativePath, "AGENTS.md");
    assert.match(feedback, /Instruction Relative Path/);
  });

  it("provider instruction relative picker は Root Directory 外の選択を反映しない", async () => {
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings.codex = {
      enabled: true,
      apiKey: "key",
      skillRootPath: "C:/workspace",
      skillRelativePath: ".codex/skills",
      instructionRelativePath: "AGENTS.md",
    };
    let draft: AppSettings = settings;
    let feedback = "";
    const handlers = buildSettingsCommandHandlers({
      getApi: () => ({
        pickFile: async () => "D:/other/AGENTS.md",
      } as Partial<WithMateWindowApi> as WithMateWindowApi),
      persistedSettingsDraft: settings,
      setAppSettings: () => undefined,
      setSettingsDraft: (nextSettings) => {
        draft = nextSettings;
      },
      setSettingsFeedback: (nextFeedback) => {
        feedback = nextFeedback;
      },
      setMemoryV6Diagnostics: () => undefined,
    });

    handlers.onBrowseProviderInstructionRelativePath("codex");
    await flushAsyncHandlers();

    assert.equal(draft, settings);
    assert.match(feedback, /Root Directory 配下/);
  });

  it("provider skill root picker cancel は draft を変更しない", async () => {
    const settings = createDefaultAppSettings();
    let draft: AppSettings = settings;
    let feedback = "";
    const handlers = buildSettingsCommandHandlers({
      getApi: () => ({
        pickDirectory: async () => null,
      } as Partial<WithMateWindowApi> as WithMateWindowApi),
      persistedSettingsDraft: settings,
      setAppSettings: () => undefined,
      setSettingsDraft: (nextSettings) => {
        draft = nextSettings;
      },
      setSettingsFeedback: (nextFeedback) => {
        feedback = nextFeedback;
      },
      setMemoryV6Diagnostics: () => undefined,
    });

    handlers.onBrowseProviderSkillRootPath("codex");
    await flushAsyncHandlers();

    assert.equal(draft, settings);
    assert.match(feedback, /キャンセル/);
  });

  it("CLI shim install/uninstall は diagnostics state と feedback を更新する", async () => {
    const settings = createDefaultAppSettings();
    let feedback = "";
    let status = "";
    const handlers = buildSettingsCommandHandlers({
      getApi: () => ({
        installMemoryV6CliShim: async () => ({
          generatedAt: "2026-06-28T00:00:00.000Z",
          runtime: { status: "running", baseUrl: null, dbPath: null, discoveryFilePath: null, hasApiSecret: false },
          binding: { activeBindingCount: 0 },
          providers: [],
          skillSync: [],
          cliShim: {
            platform: "darwin",
            commandName: "withmate-memory",
            supported: true,
            status: "installed-path-missing",
            shimDirectory: "/Users/test/.local/bin",
            shimPath: "/Users/test/.local/bin/withmate-memory",
            pathContainsShimDirectory: false,
            message: "withmate-memory shim is installed, but the shim directory is not on PATH.",
          },
          lastErrors: [],
        }),
        uninstallMemoryV6CliShim: async () => ({
          generatedAt: "2026-06-28T00:00:00.000Z",
          runtime: { status: "running", baseUrl: null, dbPath: null, discoveryFilePath: null, hasApiSecret: false },
          binding: { activeBindingCount: 0 },
          providers: [],
          skillSync: [],
          cliShim: {
            platform: "darwin",
            commandName: "withmate-memory",
            supported: true,
            status: "not-installed",
            shimDirectory: "/Users/test/.local/bin",
            shimPath: "/Users/test/.local/bin/withmate-memory",
            pathContainsShimDirectory: false,
            message: "withmate-memory shim is not installed, and ~/.local/bin is not on PATH.",
          },
          lastErrors: [],
        }),
      } as Partial<WithMateWindowApi> as WithMateWindowApi),
      persistedSettingsDraft: settings,
      setAppSettings: () => undefined,
      setSettingsDraft: () => undefined,
      setSettingsFeedback: (nextFeedback) => {
        feedback = nextFeedback;
      },
      setMemoryV6Diagnostics: (diagnostics) => {
        status = diagnostics.cliShim.status;
      },
    });

    handlers.onInstallMemoryV6CliShim();
    await flushAsyncHandlers();

    assert.equal(status, "installed-path-missing");
    assert.match(feedback, /PATH/);

    handlers.onUninstallMemoryV6CliShim();
    await flushAsyncHandlers();

    assert.equal(status, "not-installed");
    assert.match(feedback, /アンインストール/);
  });

});
