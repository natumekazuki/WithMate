import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import {
  exportHomeModelCatalog,
  importHomeModelCatalog,
  resetHomeDatabase,
  saveHomeSettings,
  deleteOldSessions,
  type HomeSettingsApi,
} from "../../src/settings/settings-actions.js";
import { buildSettingsCommandHandlers } from "../../src/settings/settings-command-handlers.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

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
  // @test-value v2
  // kind = "contract"
  // claim = "model catalog import/export actionは読み込みrevisionと保存pathを含む成功feedbackを返す"
  // oracle = { type = "contract", ref = "src/settings/settings-actions.ts: importHomeModelCatalog/exportHomeModelCatalog" }
  // fault = "成功操作を汎用または旧言語feedbackにし、revisionまたは保存先pathを利用者へ伝えない"
  // observable = "import/export actionの戻り値"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-model-catalog-feedback"
  // lifecycle = "permanent"
  // @end-test-value
  it("import/export の feedback を返す", async () => {
    const api = createApi({
      importModelCatalogFile: async () => ({ revision: 3, providers: [] }),
      exportModelCatalogFile: async () => "tmp/catalog.json",
    });

    assert.equal(await importHomeModelCatalog(api), "Loaded model catalog revision 3.");
    assert.equal(await exportHomeModelCatalog(api), "Saved the model catalog to tmp/catalog.json.");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Settings save actionは更新済みsettingsと保存完了feedbackを返す"
  // oracle = { type = "contract", ref = "src/settings/settings-actions.ts: saveHomeSettings" }
  // fault = "保存後のnextSettingsまたは成功feedbackを返さず、呼び出し側の状態更新を失わせる"
  // observable = "saveHomeSettingsのnextSettingsとfeedback"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-save-result"
  // lifecycle = "permanent"
  // @end-test-value
  it("save は nextSettings と feedback を返す", async () => {
    const settings = createDefaultAppSettings();
    settings.autoCollapseActionDockOnSend = false;

    const result = await saveHomeSettings(createApi(), settings);

    assert.equal(result.nextSettings.autoCollapseActionDockOnSend, false);
    assert.equal(result.feedback, "Settings saved.");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "保存処理の待機中に加えられた新しいSettings draftを保存済み値で上書きしない"
  // oracle = { type = "contract", ref = "Issue #731 settings save draft preservation" }
  // fault = "保存完了時に後から編集した値が消え、dirty状態も失われる"
  // observable = "保存完了後のappSettings、settings draft、feedback"
  // observation_boundary = "public-boundary"
  // scope = "settings-save-concurrent-edit"
  // lifecycle = "permanent"
  // @end-test-value
  it("save は待機中に追加されたdraft編集を保持する", async () => {
    const settings = createDefaultAppSettings();
    settings.autoCollapseActionDockOnSend = false;
    let draft = settings;
    let appSettings = settings;
    let feedback = "";
    let resolveUpdate: ((value: AppSettings) => void) | undefined;
    const updateCompleted = new Promise<AppSettings>((resolve) => {
      resolveUpdate = resolve;
    });
    const handlers = buildSettingsCommandHandlers({
      getApi: () => createApi({
        updateAppSettings: async (nextSettings) => {
          return updateCompleted.then(() => nextSettings);
        },
      }) as Partial<WithMateWindowApi> as WithMateWindowApi,
      persistedSettingsDraft: settings,
      getPersistedSettingsDraft: () => draft,
      setAppSettings: (nextSettings) => {
        appSettings = nextSettings;
      },
      setSettingsDraft: (nextSettings) => {
        draft = nextSettings;
      },
      setSettingsFeedback: (nextFeedback) => {
        feedback = nextFeedback;
      },
      setMemoryV6Diagnostics: () => undefined,
    });

    const savePromise = handlers.onSaveSettings();
    await flushAsyncHandlers();
    draft = { ...draft, scrollToLatestOnSend: !draft.scrollToLatestOnSend };
    resolveUpdate?.(settings);
    await savePromise;

    assert.equal(appSettings.autoCollapseActionDockOnSend, false);
    assert.equal(draft.autoCollapseActionDockOnSend, false);
    assert.equal(draft.scrollToLatestOnSend, false);
    assert.equal(feedback, "Settings saved. New changes remain unsaved.");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Settings保存の失敗はdraftを維持し、失敗理由をfeedbackへ表示する"
  // oracle = { type = "contract", ref = "Issue #731 settings save failure feedback" }
  // fault = "保存失敗を成功扱いにする、または失敗理由を消してdraftを失う"
  // observable = "保存後のdraft、appSettings、settings feedback"
  // observation_boundary = "public-boundary"
  // scope = "settings-save-error"
  // lifecycle = "permanent"
  // @end-test-value
  it("save failure はdraftを維持してfeedbackに失敗理由を表示する", async () => {
    const settings = createDefaultAppSettings();
    let draft = settings;
    let appSettings = settings;
    let feedback = "";
    const handlers = buildSettingsCommandHandlers({
      getApi: () => createApi({
        updateAppSettings: async () => {
          throw new Error("disk full");
        },
      }) as Partial<WithMateWindowApi> as WithMateWindowApi,
      persistedSettingsDraft: settings,
      setAppSettings: (nextSettings) => {
        appSettings = nextSettings;
      },
      setSettingsDraft: (nextSettings) => {
        draft = nextSettings;
      },
      setSettingsFeedback: (nextFeedback) => {
        feedback = nextFeedback;
      },
      setMemoryV6Diagnostics: () => undefined,
    });

    await handlers.onSaveSettings();

    assert.equal(appSettings, settings);
    assert.equal(draft, settings);
    assert.equal(feedback, "disk full");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "database reset actionは選択対象を確認し、成功時にsessionsとaudit logsの影響とcharacter file bodiesの保持をfeedbackへ示す"
  // oracle = { type = "contract", ref = "src/settings/settings-actions.ts: resetHomeDatabase" }
  // fault = "confirm後のreset結果を誤った対象へ投影するか、保持対象を隠して破壊的操作の影響を誤認させる"
  // observable = "reset result kind、feedback、resetTargets"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-database-reset-success"
  // lifecycle = "permanent"
  // @end-test-value
  it("reset は confirm と result を扱う", async () => {
    const api = createApi();
    const result = await resetHomeDatabase({
      api,
      resetTargets: ["sessions"],
      confirm: () => true,
    });

    assert.equal(result.kind, "success");
    if (result.kind === "success") {
      assert.equal(result.feedback, "Reset Sessions / Audit logs. Character file bodies were preserved.");
      assert.deepEqual(result.result.resetTargets, ["sessions", "auditLogs"]);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "database reset actionは対象なしをnoopとし、confirm拒否をcanceledとして副作用なしに返す"
  // oracle = { type = "contract", ref = "src/settings/settings-actions.ts: resetHomeDatabase" }
  // fault = "空の対象をresetするか、confirm falseを成功扱いして破壊的操作を実行する"
  // observable = "noop/canceled resultのkindとfeedback"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-database-reset-guard"
  // lifecycle = "permanent"
  // @end-test-value
  it("reset target が空なら noop、confirm false なら canceled を返す", async () => {
    const api = createApi();

    const noopResult = await resetHomeDatabase({
      api,
      resetTargets: [],
      confirm: () => true,
    });
    assert.deepEqual(noopResult, {
      kind: "noop",
      feedback: "Select at least one reset target.",
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

  // @test-value v2
  // kind = "contract"
  // claim = "old session delete actionはconfirm後に削除件数を返し、対象sessionの影響をfeedbackへ示す"
  // oracle = { type = "contract", ref = "src/settings/settings-actions.ts: deleteOldSessions" }
  // fault = "削除結果の件数または対象を落とし、破壊的操作の完了状態を誤表示する"
  // observable = "delete result kind、feedback、deletedSessionIds"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-session-cleanup-success"
  // lifecycle = "permanent"
  // @end-test-value
  it("old session delete は confirm と result を扱う", async () => {
    const api = createApi();
    const result = await deleteOldSessions({
      api,
      cutoffDate: "2026-07-01",
      confirm: () => true,
    });

    assert.equal(result.kind, "success");
    if (result.kind === "success") {
      assert.equal(result.feedback, "1 old session deleted.");
      assert.deepEqual(result.result.deletedSessionIds, ["s-1"]);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "old session delete actionはcleanup date未指定をnoopとし、confirm拒否をcanceledとして返す"
  // oracle = { type = "contract", ref = "src/settings/settings-actions.ts: deleteOldSessions" }
  // fault = "日付なしで削除を実行するか、confirm falseを成功扱いしてSessionを削除する"
  // observable = "noop/canceled resultのkindとfeedback"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-session-cleanup-guard"
  // lifecycle = "permanent"
  // @end-test-value
  it("old session delete は cutoff 未指定なら noop、confirm false なら canceled を返す", async () => {
    const api = createApi();

    const noopResult = await deleteOldSessions({
      api,
      cutoffDate: "",
      confirm: () => true,
    });
    assert.deepEqual(noopResult, {
      kind: "noop",
      feedback: "Select a cleanup date.",
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

  // @test-value v2
  // kind = "contract"
  // claim = "provider skill root pickerは選択pathだけを更新し、既存relative pathとenabledを維持する"
  // oracle = { type = "contract", ref = "src/settings/settings-command-handlers.ts: onBrowseProviderSkillRootPath" }
  // fault = "root path選択時にrelative pathまたはprovider enabledを失い、feedbackも更新しない"
  // observable = "draft provider settingsとfeedback"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-provider-root-picker"
  // lifecycle = "permanent"
  // @end-test-value
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
    assert.match(feedback, /Root directory updated/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "provider skill relative pickerはRoot Directory配下の選択をrelative pathへ変換する"
  // oracle = { type = "contract", ref = "src/settings/settings-command-handlers.ts: onBrowseProviderSkillRelativePath" }
  // fault = "root外のabsolute pathや誤ったrelative pathをdraftへ保存する"
  // observable = "draftのskillRootPath、skillRelativePath、feedback"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-provider-skill-relative-picker"
  // lifecycle = "permanent"
  // @end-test-value
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
    assert.match(feedback, /Skill relative path updated/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "provider instruction relative pickerはRoot Directory配下のfileをrelative pathへ変換する"
  // oracle = { type = "contract", ref = "src/settings/settings-command-handlers.ts: onBrowseProviderInstructionRelativePath" }
  // fault = "instruction fileのabsolute pathを保存するか、既存skill pathを壊す"
  // observable = "draftのinstructionRelativePathと既存provider settings、feedback"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-provider-instruction-relative-picker"
  // lifecycle = "permanent"
  // @end-test-value
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
    assert.match(feedback, /Instruction relative path updated/);
  });

  // @test-value v2
  // kind = "security"
  // claim = "provider instruction relative pickerはRoot Directory外の選択をdraftへ反映せず、理由をfeedbackへ示す"
  // oracle = { type = "contract", ref = "src/settings/settings-command-handlers.ts: onBrowseProviderInstructionRelativePath" }
  // fault = "root外のfile pathをinstruction設定として保存し、provider file boundaryを越える"
  // observable = "draft identityとroot directory feedback"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-provider-instruction-root-boundary"
  // lifecycle = "permanent"
  // @end-test-value
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
    assert.match(feedback, /inside the root directory/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "provider skill root pickerのcancelはdraftを変更せずselection canceled feedbackを返す"
  // oracle = { type = "contract", ref = "src/settings/settings-command-handlers.ts: onBrowseProviderSkillRootPath" }
  // fault = "picker cancelをpath変更または成功として扱い、古いdraftを汚す"
  // observable = "draft identityとcancel feedback"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-provider-root-picker-cancel"
  // lifecycle = "permanent"
  // @end-test-value
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
    assert.match(feedback, /selection canceled/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "pathを含まないMemory diagnosticsでもCLI shim install/uninstallのstateとfeedbackを更新できる"
  // oracle = { type = "contract", ref = "src/settings/settings-command-handlers.ts: onInstallMemoryV6CliShim/onUninstallMemoryV6CliShim" }
  // fault = "diagnosticsからpathを除去した結果、CLI shim操作の成功状態をUIへ反映できない"
  // observable = "safe diagnosticsのcliShim.statusとinstall/uninstall feedback"
  // observation_boundary = "public-boundary"
  // scope = "memory-cli-shim-settings-action"
  // lifecycle = "permanent"
  // @end-test-value
  it("CLI shim install/uninstall はsafe diagnostics state と feedback を更新する", async () => {
    const settings = createDefaultAppSettings();
    let feedback = "";
    let status = "";
    const handlers = buildSettingsCommandHandlers({
      getApi: () => ({
        installMemoryV6CliShim: async () => ({
          generatedAt: "2026-06-28T00:00:00.000Z",
          runtime: { status: "running", applicationInstanceId: null, runtimeGenerationId: null, buildChannel: null, discoveryPublished: false },
          cliShim: {
            platform: "darwin",
            commandName: "withmate-memory",
            supported: true,
            status: "installed-path-missing",
            pathContainsShimDirectory: false,
          },
          lastErrors: [],
        }),
        uninstallMemoryV6CliShim: async () => ({
          generatedAt: "2026-06-28T00:00:00.000Z",
          runtime: { status: "running", applicationInstanceId: null, runtimeGenerationId: null, buildChannel: null, discoveryPublished: false },
          cliShim: {
            platform: "darwin",
            commandName: "withmate-memory",
            supported: true,
            status: "not-installed",
            pathContainsShimDirectory: false,
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
    assert.match(feedback, /Uninstalled the withmate-memory CLI shim/);
  });

});
