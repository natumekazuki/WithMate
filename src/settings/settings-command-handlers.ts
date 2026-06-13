import type { AppSettings } from "../provider-settings-state.js";
import type { HomeSettingsContentBaseProps } from "./home-settings-content-props.js";
import {
  exportHomeModelCatalog,
  importHomeModelCatalog,
  saveHomeSettings,
} from "./settings-actions.js";
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
