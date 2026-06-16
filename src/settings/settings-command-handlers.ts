import { getProviderAppSettings, type AppSettings } from "../provider-settings-state.js";
import type { HomeSettingsContentBaseProps } from "./home-settings-content-props.js";
import {
  exportHomeModelCatalog,
  importHomeModelCatalog,
  saveHomeSettings,
} from "./settings-actions.js";
import { resolveProviderRelativePathFromSelection } from "./settings-view-model.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";

type SettingsCommandHandlersContext = {
  getApi: () => WithMateWindowApi | null;
  persistedSettingsDraft: AppSettings;
  setAppSettings: (settings: AppSettings) => void;
  setSettingsDraft: (settings: AppSettings) => void;
  setSettingsFeedback: (feedback: string) => void;
};

export type SettingsCommandHandlers = Pick<
  HomeSettingsContentBaseProps,
  | "onImportModelCatalog"
  | "onExportModelCatalog"
  | "onOpenAppLogFolder"
  | "onOpenCrashDumpFolder"
  | "onBrowseProviderSkillRootPath"
  | "onBrowseProviderSkillRelativePath"
  | "onBrowseProviderInstructionRelativePath"
  | "onSaveSettings"
>;

export function buildSettingsCommandHandlers({
  getApi,
  persistedSettingsDraft,
  setAppSettings,
  setSettingsDraft,
  setSettingsFeedback,
}: SettingsCommandHandlersContext): SettingsCommandHandlers {
  const withApi = async (callback: (api: WithMateWindowApi) => Promise<void>) => {
    const api = getApi();
    if (!api) {
      return;
    }

    await callback(api);
  };
  const updateProviderSettings = (
    providerId: string,
    patch: Partial<ReturnType<typeof getProviderAppSettings>>,
  ) => {
    const currentProviderSettings = getProviderAppSettings(persistedSettingsDraft, providerId);
    setSettingsDraft({
      ...persistedSettingsDraft,
      codingProviderSettings: {
        ...persistedSettingsDraft.codingProviderSettings,
        [providerId]: {
          ...currentProviderSettings,
          ...patch,
        },
      },
    });
  };

  const resolveRelativePathSelection = (
    providerId: string,
    selectedPath: string,
    fieldLabel: string,
  ): string | null => {
    const currentProviderSettings = getProviderAppSettings(persistedSettingsDraft, providerId);
    const rootDirectory = currentProviderSettings.skillRootPath.trim();
    const relativePath = resolveProviderRelativePathFromSelection(rootDirectory, selectedPath);
    if (relativePath === null) {
      setSettingsFeedback(`Root Directory 配下の ${fieldLabel} を選んでね。`);
      return null;
    }

    return relativePath;
  };

  return {
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
    onBrowseProviderSkillRootPath: (providerId) => {
      void withApi(async (api) => {
        try {
          const currentProviderSettings = getProviderAppSettings(persistedSettingsDraft, providerId);
          const selectedPath = await api.pickDirectory(currentProviderSettings.skillRootPath || null);
          if (!selectedPath) {
            setSettingsFeedback("Root Directory の選択をキャンセルしたよ。");
            return;
          }

          updateProviderSettings(providerId, { skillRootPath: selectedPath });
          setSettingsFeedback("Root Directory を反映したよ。保存すると有効になるよ。");
        } catch (error) {
          setSettingsFeedback(error instanceof Error ? error.message : "Root Directory を選択できなかったよ。");
        }
      });
    },
    onBrowseProviderSkillRelativePath: (providerId) => {
      void withApi(async (api) => {
        try {
          const currentProviderSettings = getProviderAppSettings(persistedSettingsDraft, providerId);
          const rootDirectory = currentProviderSettings.skillRootPath.trim();
          if (!rootDirectory) {
            setSettingsFeedback("Skill folder を選ぶ前に Root Directory を指定してね。");
            return;
          }

          const selectedPath = await api.pickDirectory(rootDirectory);
          if (!selectedPath) {
            setSettingsFeedback("Skill Relative Path の選択をキャンセルしたよ。");
            return;
          }

          const relativePath = resolveRelativePathSelection(providerId, selectedPath, "Skill folder");
          if (relativePath === null) {
            return;
          }

          updateProviderSettings(providerId, { skillRelativePath: relativePath });
          setSettingsFeedback("Skill Relative Path を反映したよ。保存すると有効になるよ。");
        } catch (error) {
          setSettingsFeedback(error instanceof Error ? error.message : "Skill Relative Path を選択できなかったよ。");
        }
      });
    },
    onBrowseProviderInstructionRelativePath: (providerId) => {
      void withApi(async (api) => {
        try {
          const currentProviderSettings = getProviderAppSettings(persistedSettingsDraft, providerId);
          const rootDirectory = currentProviderSettings.skillRootPath.trim();
          if (!rootDirectory) {
            setSettingsFeedback("Instruction file を選ぶ前に Root Directory を指定してね。");
            return;
          }

          const selectedPath = await api.pickFile(rootDirectory);
          if (!selectedPath) {
            setSettingsFeedback("Instruction Relative Path の選択をキャンセルしたよ。");
            return;
          }

          const relativePath = resolveRelativePathSelection(providerId, selectedPath, "Instruction file");
          if (relativePath === null) {
            return;
          }

          updateProviderSettings(providerId, { instructionRelativePath: relativePath });
          setSettingsFeedback("Instruction Relative Path を反映したよ。保存すると有効になるよ。");
        } catch (error) {
          setSettingsFeedback(error instanceof Error ? error.message : "Instruction Relative Path を選択できなかったよ。");
        }
      });
    },
    onSaveSettings: () => {
      void withApi(async (api) => {
        try {
          const result = await saveHomeSettings(api, persistedSettingsDraft);
          setAppSettings(result.nextSettings);
          setSettingsDraft(result.nextSettings);
          setSettingsFeedback(result.feedback);
        } catch (error) {
          setSettingsFeedback(error instanceof Error ? error.message : "設定の保存に失敗したよ。");
        }
      });
    },
  };
}
