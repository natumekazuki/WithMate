import { getProviderAppSettings, type AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { HomeSettingsContentBaseProps } from "./home-settings-content-props.js";
import {
  deleteOldSessions,
  saveHomeSettings,
} from "./settings-actions.js";
import { resolveProviderRelativePathFromSelection } from "./settings-view-model.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { SettingsFeedbackSource } from "./use-settings-feedback.js";

type SettingsCommandHandlersContext = {
  getApi: () => WithMateWindowApi | null;
  persistedSettingsDraft: AppSettings;
  setAppSettings: (settings: AppSettings) => void;
  setSettingsDraft: (settings: AppSettings) => void;
  getPersistedSettingsDraft?: () => AppSettings;
  setSettingsFeedback: (feedback: string, source: SettingsFeedbackSource) => void;
  getSessionCleanupCutoffDate?: () => string;
  setDeletingOldSessions?: (deleting: boolean) => void;
  refreshSessionSummaries?: () => Promise<void>;
};

export type SettingsCommandHandlers = Pick<
  HomeSettingsContentBaseProps,
  | "onOpenAppLogFolder"
  | "onOpenCrashDumpFolder"
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
  setSettingsFeedback: reportSettingsFeedback,
  getSessionCleanupCutoffDate = () => "",
  setDeletingOldSessions = () => undefined,
  refreshSessionSummaries,
}: SettingsCommandHandlersContext): SettingsCommandHandlers {
  const withApi = async (
    action: string,
    callback: (api: WithMateWindowApi, setFeedback: (message: string, error?: boolean, requiresInput?: boolean) => void) => Promise<void>,
  ): Promise<void> => {
    const api = getApi();
    if (!api) {
      return;
    }

    await callback(api, (message, error = false, requiresInput = false) =>
      reportSettingsFeedback(message, { action, error, requiresInput }));
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
    setFeedback: (message: string, error?: boolean, requiresInput?: boolean) => void,
  ): string | null => {
    const currentProviderSettings = getProviderAppSettings(getCurrentPersistedSettingsDraft(), providerId);
    const rootDirectory = currentProviderSettings.skillRootPath.trim();
    const relativePath = resolveProviderRelativePathFromSelection(rootDirectory, selectedPath);
    if (relativePath === null) {
      setFeedback(`Choose a ${fieldLabel.toLowerCase()} inside the root directory.`, true, true);
      return null;
    }

    return relativePath;
  };

  return {
    onOpenAppLogFolder: () => withApi("open-logs", async (api, setSettingsFeedback) => {
      try {
        await api.openAppLogFolder();
        setSettingsFeedback("Opened the application log folder.");
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not open the application log folder.", true);
      }
    }),
    onOpenCrashDumpFolder: () => withApi("open-crash-dumps", async (api, setSettingsFeedback) => {
      try {
        await api.openCrashDumpFolder();
        setSettingsFeedback("Opened the crash dump folder.");
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not open the crash dump folder.", true);
      }
    }),
    onBrowseProviderSkillRootPath: (providerId) => withApi(`browse-root:${providerId}`, async (api, setSettingsFeedback) => {
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
        setSettingsFeedback(error instanceof Error ? error.message : "Could not select the root directory.", true);
      }
    }),
    onBrowseProviderSkillRelativePath: (providerId) => withApi(`browse-skill:${providerId}`, async (api, setSettingsFeedback) => {
      try {
        const currentProviderSettings = getProviderAppSettings(getCurrentPersistedSettingsDraft(), providerId);
        const rootDirectory = currentProviderSettings.skillRootPath.trim();
        if (!rootDirectory) {
          setSettingsFeedback("Set a root directory before choosing a skill folder.", true, true);
          return;
        }

        const selectedPath = await api.pickDirectory(rootDirectory);
        if (!selectedPath) {
          setSettingsFeedback("Skill relative path selection canceled.");
          return;
        }

        const relativePath = resolveRelativePathSelection(providerId, selectedPath, "Skill folder", setSettingsFeedback);
        if (relativePath === null) {
          return;
        }

        updateProviderSettings(providerId, { skillRelativePath: relativePath });
        setSettingsFeedback("Skill relative path updated. Save settings to apply it.");
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not select the skill relative path.", true);
      }
    }),
    onBrowseProviderInstructionRelativePath: (providerId) => withApi(`browse-instruction:${providerId}`, async (api, setSettingsFeedback) => {
      try {
        const currentProviderSettings = getProviderAppSettings(getCurrentPersistedSettingsDraft(), providerId);
        const rootDirectory = currentProviderSettings.skillRootPath.trim();
        if (!rootDirectory) {
          setSettingsFeedback("Set a root directory before choosing an instruction file.", true, true);
          return;
        }

        const selectedPath = await api.pickFile(rootDirectory);
        if (!selectedPath) {
          setSettingsFeedback("Instruction relative path selection canceled.");
          return;
        }

        const relativePath = resolveRelativePathSelection(providerId, selectedPath, "Instruction file", setSettingsFeedback);
        if (relativePath === null) {
          return;
        }

        updateProviderSettings(providerId, { instructionRelativePath: relativePath });
        setSettingsFeedback("Instruction relative path updated. Save settings to apply it.");
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not select the instruction relative path.", true);
      }
    }),
    onSaveSettings: () => withApi("save-settings", async (api, setSettingsFeedback) => {
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
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not save settings.", true);
      }
    }),
    onDeleteSessionsLastActiveBefore: () => withApi("delete-sessions", async (api, setSettingsFeedback) => {
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
          setSettingsFeedback(result.feedback, true, true);
        }
      } catch (error) {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not delete old sessions.", true);
      } finally {
        setDeletingOldSessions(false);
      }
    }),
  };
}
