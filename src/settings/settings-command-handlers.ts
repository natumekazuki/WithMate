import { getProviderAppSettings, type AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { HomeSettingsContentBaseProps } from "./home-settings-content-props.js";
import {
  deleteOldSessions,
  exportHomeModelCatalog,
  importHomeModelCatalog,
  saveHomeSettings,
} from "./settings-actions.js";
import { resolveProviderRelativePathFromSelection } from "./settings-view-model.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { MemoryV6Diagnostics } from "../../src-shared/memory/memory-diagnostics-state.js";

type SettingsCommandHandlersContext = {
  getApi: () => WithMateWindowApi | null;
  persistedSettingsDraft: AppSettings;
  setAppSettings: (settings: AppSettings) => void;
  setSettingsDraft: (settings: AppSettings) => void;
  getPersistedSettingsDraft?: () => AppSettings;
  setSettingsFeedback: (feedback: string) => void;
  setMemoryV6Diagnostics: (diagnostics: MemoryV6Diagnostics) => void;
  getSessionCleanupCutoffDate?: () => string;
  setDeletingOldSessions?: (deleting: boolean) => void;
  refreshSessionSummaries?: () => Promise<void>;
  onSettingsSaved?: () => void;
};

export type SettingsCommandHandlers = Pick<
  HomeSettingsContentBaseProps,
  | "onImportModelCatalog"
  | "onExportModelCatalog"
  | "onOpenAppLogFolder"
  | "onOpenCrashDumpFolder"
  | "onInstallMemoryV6CliShim"
  | "onUninstallMemoryV6CliShim"
  | "onBrowseProviderSkillRootPath"
  | "onBrowseProviderSkillRelativePath"
  | "onBrowseProviderInstructionRelativePath"
  | "onDeleteSessionsLastActiveBefore"
  | "onSaveSettings"
>;

export function buildSettingsCommandHandlers({
  getApi,
  persistedSettingsDraft,
  setAppSettings,
  setSettingsDraft,
  getPersistedSettingsDraft,
  setSettingsFeedback,
  setMemoryV6Diagnostics,
  getSessionCleanupCutoffDate = () => "",
  setDeletingOldSessions = () => undefined,
  refreshSessionSummaries,
  onSettingsSaved,
}: SettingsCommandHandlersContext): SettingsCommandHandlers {
  const withApi = async (callback: (api: WithMateWindowApi) => Promise<void>): Promise<void> => {
    const api = getApi();
    if (!api) {
      return;
    }

    await callback(api);
  };
  const getCurrentPersistedSettingsDraft = () => getPersistedSettingsDraft?.() ?? persistedSettingsDraft;
  const updateProviderSettings = (
    providerId: string,
    patch: Partial<ReturnType<typeof getProviderAppSettings>>,
  ) => {
    const currentPersistedSettingsDraft = getCurrentPersistedSettingsDraft();
    const currentProviderSettings = getProviderAppSettings(currentPersistedSettingsDraft, providerId);
    setSettingsDraft({
      ...currentPersistedSettingsDraft,
      codingProviderSettings: {
        ...currentPersistedSettingsDraft.codingProviderSettings,
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
    const currentProviderSettings = getProviderAppSettings(getCurrentPersistedSettingsDraft(), providerId);
    const rootDirectory = currentProviderSettings.skillRootPath.trim();
    const relativePath = resolveProviderRelativePathFromSelection(rootDirectory, selectedPath);
    if (relativePath === null) {
      setSettingsFeedback(`Choose a ${fieldLabel.toLowerCase()} inside the root directory.`);
      return null;
    }

    return relativePath;
  };

  return {
    onImportModelCatalog: () => withApi(async (api) => {
      try {
        setSettingsFeedback(await importHomeModelCatalog(api));
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not import the model catalog.");
      }
    }),
    onExportModelCatalog: () => withApi(async (api) => {
      try {
        setSettingsFeedback(await exportHomeModelCatalog(api));
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not export the model catalog.");
      }
    }),
    onOpenAppLogFolder: () => withApi(async (api) => {
      try {
        await api.openAppLogFolder();
        setSettingsFeedback("Opened the application log folder.");
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not open the application log folder.");
      }
    }),
    onOpenCrashDumpFolder: () => withApi(async (api) => {
      try {
        await api.openCrashDumpFolder();
        setSettingsFeedback("Opened the crash dump folder.");
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not open the crash dump folder.");
      }
    }),
    onInstallMemoryV6CliShim: () => withApi(async (api) => {
      try {
        const diagnostics = await api.installMemoryV6CliShim();
        setMemoryV6Diagnostics(diagnostics);
        setSettingsFeedback(formatCliShimActionFeedback(diagnostics, "install"));
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not install the CLI shim.");
      }
    }),
    onUninstallMemoryV6CliShim: () => withApi(async (api) => {
      try {
        const diagnostics = await api.uninstallMemoryV6CliShim();
        setMemoryV6Diagnostics(diagnostics);
        setSettingsFeedback(formatCliShimActionFeedback(diagnostics, "uninstall"));
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not uninstall the CLI shim.");
      }
    }),
    onBrowseProviderSkillRootPath: (providerId) => withApi(async (api) => {
      try {
        const currentProviderSettings = getProviderAppSettings(getCurrentPersistedSettingsDraft(), providerId);
        const selectedPath = await api.pickDirectory(currentProviderSettings.skillRootPath || null);
        if (!selectedPath) {
          setSettingsFeedback("Root directory selection canceled.");
          return;
        }

        updateProviderSettings(providerId, { skillRootPath: selectedPath });
        setSettingsFeedback("Root directory updated. Save settings to apply it.");
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not select the root directory.");
      }
    }),
    onBrowseProviderSkillRelativePath: (providerId) => withApi(async (api) => {
      try {
        const currentProviderSettings = getProviderAppSettings(getCurrentPersistedSettingsDraft(), providerId);
        const rootDirectory = currentProviderSettings.skillRootPath.trim();
        if (!rootDirectory) {
          setSettingsFeedback("Set a root directory before choosing a skill folder.");
          return;
        }

        const selectedPath = await api.pickDirectory(rootDirectory);
        if (!selectedPath) {
          setSettingsFeedback("Skill relative path selection canceled.");
          return;
        }

        const relativePath = resolveRelativePathSelection(providerId, selectedPath, "Skill folder");
        if (relativePath === null) {
          return;
        }

        updateProviderSettings(providerId, { skillRelativePath: relativePath });
        setSettingsFeedback("Skill relative path updated. Save settings to apply it.");
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not select the skill relative path.");
      }
    }),
    onBrowseProviderInstructionRelativePath: (providerId) => withApi(async (api) => {
      try {
        const currentProviderSettings = getProviderAppSettings(getCurrentPersistedSettingsDraft(), providerId);
        const rootDirectory = currentProviderSettings.skillRootPath.trim();
        if (!rootDirectory) {
          setSettingsFeedback("Set a root directory before choosing an instruction file.");
          return;
        }

        const selectedPath = await api.pickFile(rootDirectory);
        if (!selectedPath) {
          setSettingsFeedback("Instruction relative path selection canceled.");
          return;
        }

        const relativePath = resolveRelativePathSelection(providerId, selectedPath, "Instruction file");
        if (relativePath === null) {
          return;
        }

        updateProviderSettings(providerId, { instructionRelativePath: relativePath });
        setSettingsFeedback("Instruction relative path updated. Save settings to apply it.");
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not select the instruction relative path.");
      }
    }),
    onSaveSettings: () => withApi(async (api) => {
      const settingsAtSaveStart = persistedSettingsDraft;
      try {
        const result = await saveHomeSettings(api, persistedSettingsDraft);
        setAppSettings(result.nextSettings);
        const currentDraft = getPersistedSettingsDraft?.();
        const hasNewChanges = currentDraft
          ? JSON.stringify(currentDraft) !== JSON.stringify(settingsAtSaveStart)
          : false;
        if (!hasNewChanges) {
          setSettingsDraft(result.nextSettings);
        }
        setSettingsFeedback(hasNewChanges
          ? "Settings saved. New changes remain unsaved."
          : result.feedback);
        onSettingsSaved?.();
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not save settings.");
      }
    }),
    onDeleteSessionsLastActiveBefore: () => withApi(async (api) => {
      setDeletingOldSessions(true);
      try {
        const result = await deleteOldSessions({
          api,
          cutoffDate: getSessionCleanupCutoffDate(),
          confirm: (message) => window.confirm(message),
        });
        if (result.kind === "success") {
          await refreshSessionSummaries?.();
          setSettingsFeedback(result.feedback);
        } else if (result.kind === "noop") {
          setSettingsFeedback(result.feedback);
        }
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not delete old sessions.");
      } finally {
        setDeletingOldSessions(false);
      }
    }),
  };
}

function formatCliShimActionFeedback(
  diagnostics: MemoryV6Diagnostics,
  action: "install" | "uninstall",
): string {
  if (diagnostics.cliShim.status === "installed-path-missing") {
    return "CLI shim created. Add ~/.local/bin to PATH to enable it.";
  }

  if (action === "install") {
    return "Installed the withmate-memory CLI shim.";
  }

  return "Uninstalled the withmate-memory CLI shim.";
}
