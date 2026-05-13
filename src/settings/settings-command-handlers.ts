import {
  getProviderAppSettings,
  type AppSettings,
} from "../provider-settings-state.js";
import type { HomeProviderInstructionTargetDraft } from "./provider-instruction-target-draft.js";
import type { HomeSettingsContentBaseProps } from "./home-settings-content-props.js";
import {
  exportHomeModelCatalog,
  importHomeModelCatalog,
  saveHomeSettings,
  syncProviderInstructionTargetRoots,
} from "./settings-actions.js";
import { resolveInstructionRelativePathFromSelection } from "./settings-view-model.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";

type SettingsCommandHandlersContext = {
  getApi: () => WithMateWindowApi | null;
  settingsDraft: AppSettings;
  persistedSettingsDraft: AppSettings;
  providerInstructionTargets: readonly HomeProviderInstructionTargetDraft[];
  setAppSettings: (settings: AppSettings) => void;
  setSettingsDraft: (settings: AppSettings) => void;
  setProviderInstructionTargets: (targets: HomeProviderInstructionTargetDraft[]) => void;
  setSettingsFeedback: (feedback: string) => void;
  onChangeProviderSkillRootPath: (providerId: string, skillRootPath: string) => void;
  onChangeProviderSkillRelativePath: (providerId: string, skillRelativePath: string) => void;
};

export type SettingsCommandHandlers = Pick<
  HomeSettingsContentBaseProps,
  | "onBrowseProviderSkillRootPath"
  | "onBrowseProviderSkillRelativePath"
  | "onImportModelCatalog"
  | "onExportModelCatalog"
  | "onOpenAppLogFolder"
  | "onOpenCrashDumpFolder"
  | "onSaveSettings"
>;

export function buildSettingsCommandHandlers({
  getApi,
  settingsDraft,
  persistedSettingsDraft,
  providerInstructionTargets,
  setAppSettings,
  setSettingsDraft,
  setProviderInstructionTargets,
  setSettingsFeedback,
  onChangeProviderSkillRootPath,
  onChangeProviderSkillRelativePath,
}: SettingsCommandHandlersContext): SettingsCommandHandlers {
  const withApi = async (callback: (api: WithMateWindowApi) => Promise<void>) => {
    const api = getApi();
    if (!api) {
      return;
    }

    await callback(api);
  };

  return {
    onBrowseProviderSkillRootPath: (providerId) => {
      void withApi(async (api) => {
        const currentSettings = getProviderAppSettings(settingsDraft, providerId);
        const selectedPath = await api.pickDirectory(currentSettings.skillRootPath || null);
        if (!selectedPath) {
          return;
        }

        onChangeProviderSkillRootPath(providerId, selectedPath);
      });
    },
    onBrowseProviderSkillRelativePath: (providerId) => {
      void withApi(async (api) => {
        const currentSettings = getProviderAppSettings(settingsDraft, providerId);
        const rootDirectory = currentSettings.skillRootPath.trim();
        if (!rootDirectory) {
          setSettingsFeedback("Skill folder を選ぶ前に Root Directory を指定してね。");
          return;
        }

        const selectedPath = await api.pickDirectory(rootDirectory);
        if (!selectedPath) {
          return;
        }

        const relativePath = resolveInstructionRelativePathFromSelection(rootDirectory, selectedPath);
        if (relativePath === null) {
          setSettingsFeedback("Root Directory 配下の Skill folder を選んでね。");
          return;
        }

        onChangeProviderSkillRelativePath(providerId, relativePath);
      });
    },
    onImportModelCatalog: () => {
      void withApi(async (api) => {
        try {
          setSettingsFeedback(await importHomeModelCatalog(api));
        } catch (error) {
          setSettingsFeedback(error instanceof Error ? error.message : "model catalog の読み込みに失敗したよ。");
        }
      });
    },
    onExportModelCatalog: () => {
      void withApi(async (api) => {
        try {
          setSettingsFeedback(await exportHomeModelCatalog(api));
        } catch (error) {
          setSettingsFeedback(error instanceof Error ? error.message : "model catalog の保存に失敗したよ。");
        }
      });
    },
    onOpenAppLogFolder: () => {
      void withApi(async (api) => {
        try {
          await api.openAppLogFolder();
          setSettingsFeedback("ログフォルダを開いたよ。");
        } catch (error) {
          setSettingsFeedback(error instanceof Error ? error.message : "ログフォルダを開けなかったよ。");
        }
      });
    },
    onOpenCrashDumpFolder: () => {
      void withApi(async (api) => {
        try {
          await api.openCrashDumpFolder();
          setSettingsFeedback("クラッシュダンプフォルダを開いたよ。");
        } catch (error) {
          setSettingsFeedback(error instanceof Error ? error.message : "クラッシュダンプフォルダを開けなかったよ。");
        }
      });
    },
    onSaveSettings: () => {
      void withApi(async (api) => {
        try {
          const result = await saveHomeSettings(api, persistedSettingsDraft);
          const nextProviderInstructionTargets = await syncProviderInstructionTargetRoots({
            api,
            nextSettings: result.nextSettings,
            providerInstructionTargets,
          });
          setAppSettings(result.nextSettings);
          setSettingsDraft(result.nextSettings);
          setProviderInstructionTargets(nextProviderInstructionTargets);
          setSettingsFeedback(result.feedback);
        } catch (error) {
          setSettingsFeedback(error instanceof Error ? error.message : "設定の保存に失敗したよ。");
        }
      });
    },
  };
}
