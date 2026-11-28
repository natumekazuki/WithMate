import {
  getProviderAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import type { HomeSettingsContentBaseProps } from "./home-settings-content-props.js";
import { deleteOldSessions, saveHomeSettings } from "./settings-actions.js";
import { resolveProviderRelativePathFromSelection } from "./settings-view-model.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { SettingsFeedbackSource } from "./use-settings-feedback.js";

/** 保存・保守操作が使うウィンドウ API と、設定および操作結果を画面へ反映するための依存。 */
type SettingsCommandHandlersContext = {
  getApi: () => WithMateWindowApi | null;
  persistedSettingsDraft: AppSettings;
  setAppSettings: (settings: AppSettings) => void;
  setSettingsDraft: (settings: AppSettings) => void;
  getPersistedSettingsDraft?: () => AppSettings;
  setSettingsFeedback: (
    feedback: string,
    source: SettingsFeedbackSource,
  ) => void;
  getSessionCleanupCutoffDate?: () => string;
  setDeletingOldSessions?: (deleting: boolean) => void;
  refreshSessionSummaries?: () => Promise<void>;
};

/** 設定画面から非同期に実行する保存、パス参照、診断、セッション整理のコールバック。 */
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

/** ウィンドウ API を使う設定操作を組み立て、操作別の結果を画面へ返す。 */
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
  /** API が取得できる場合だけ処理し、結果に操作 ID と失敗・追加入力の分類を付ける。 */
  const withApi = async (
    action: string,
    callback: (
      api: WithMateWindowApi,
      setFeedback: (
        message: string,
        error?: boolean,
        requiresInput?: boolean,
      ) => void,
    ) => Promise<void>,
  ): Promise<void> => {
    const api = getApi();
    if (!api) {
      return;
    }

    await callback(api, (message, error = false, requiresInput = false) =>
      reportSettingsFeedback(message, { action, error, requiresInput }),
    );
  };
  /** 非同期の選択操作後には取得関数で最新の下書きを読み、取得関数がなければ組み立て時の値を使う。 */
  const getCurrentPersistedSettingsDraft = () =>
    getPersistedSettingsDraft?.() ?? persistedSettingsDraft;
  /** 現在の下書きを基に対象プロバイダーへ変更分をマージし、他の設定を保つ。 */
  const updateProviderSettings = (
    providerId: string,
    patch: Partial<ReturnType<typeof getProviderAppSettings>>,
  ) => {
    const currentPersistedSettingsDraft = getCurrentPersistedSettingsDraft();
    const currentProviderSettings = getProviderAppSettings(
      currentPersistedSettingsDraft,
      providerId,
    );
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

  /** 選択先をプロバイダーのルート基準に変換する。ルート外なら再入力を案内し null を返す。 */
  const resolveRelativePathSelection = (
    providerId: string,
    selectedPath: string,
    fieldLabel: string,
    setFeedback: (
      message: string,
      error?: boolean,
      requiresInput?: boolean,
    ) => void,
  ): string | null => {
    const currentProviderSettings = getProviderAppSettings(
      getCurrentPersistedSettingsDraft(),
      providerId,
    );
    const rootDirectory = currentProviderSettings.skillRootPath.trim();
    const relativePath = resolveProviderRelativePathFromSelection(
      rootDirectory,
      selectedPath,
    );
    if (relativePath === null) {
      setFeedback(
        `Choose a ${fieldLabel.toLowerCase()} inside the root directory.`,
        true,
        true,
      );
      return null;
    }

    return relativePath;
  };

  return {
    /** アプリケーションログのフォルダーを開き、失敗も同じ操作の結果に記録する。 */
    onOpenAppLogFolder: () =>
      withApi("open-logs", async (api, setSettingsFeedback) => {
        try {
          await api.openAppLogFolder();
          setSettingsFeedback("Opened the application log folder.");
        } catch (error) {
          setSettingsFeedback(
            error instanceof Error
              ? error.message
              : "Could not open the application log folder.",
            true,
          );
        }
      }),
    /** クラッシュダンプのフォルダーを開き、ログ参照とは別に成否を表示する。 */
    onOpenCrashDumpFolder: () =>
      withApi("open-crash-dumps", async (api, setSettingsFeedback) => {
        try {
          await api.openCrashDumpFolder();
          setSettingsFeedback("Opened the crash dump folder.");
        } catch (error) {
          setSettingsFeedback(
            error instanceof Error
              ? error.message
              : "Could not open the crash dump folder.",
            true,
          );
        }
      }),
    /** 現在のルートを初期位置にフォルダーを選ぶ。取消時は下書きを変えず、選択時は保存前の下書きに反映する。 */
    onBrowseProviderSkillRootPath: (providerId) =>
      withApi(`browse-root:${providerId}`, async (api, setSettingsFeedback) => {
        try {
          const currentProviderSettings = getProviderAppSettings(
            getCurrentPersistedSettingsDraft(),
            providerId,
          );
          const selectedPath = await api.pickDirectory(
            currentProviderSettings.skillRootPath || null,
          );
          if (!selectedPath) {
            setSettingsFeedback("Root directory selection canceled.");
            return;
          }

          updateProviderSettings(providerId, { skillRootPath: selectedPath });
          setSettingsFeedback(
            "Root directory updated. Save settings to apply it.",
          );
        } catch (error) {
          setSettingsFeedback(
            error instanceof Error
              ? error.message
              : "Could not select the root directory.",
            true,
          );
        }
      }),
    /** ルートが設定済みのときだけフォルダーを選べるようにし、ルート内の選択を相対パスで保持する。 */
    onBrowseProviderSkillRelativePath: (providerId) =>
      withApi(
        `browse-skill:${providerId}`,
        async (api, setSettingsFeedback) => {
          try {
            const currentProviderSettings = getProviderAppSettings(
              getCurrentPersistedSettingsDraft(),
              providerId,
            );
            const rootDirectory = currentProviderSettings.skillRootPath.trim();
            if (!rootDirectory) {
              setSettingsFeedback(
                "Set a root directory before choosing a skill folder.",
                true,
                true,
              );
              return;
            }

            const selectedPath = await api.pickDirectory(rootDirectory);
            if (!selectedPath) {
              setSettingsFeedback("Skill relative path selection canceled.");
              return;
            }

            const relativePath = resolveRelativePathSelection(
              providerId,
              selectedPath,
              "Skill folder",
              setSettingsFeedback,
            );
            if (relativePath === null) {
              return;
            }

            updateProviderSettings(providerId, {
              skillRelativePath: relativePath,
            });
            setSettingsFeedback(
              "Skill relative path updated. Save settings to apply it.",
            );
          } catch (error) {
            setSettingsFeedback(
              error instanceof Error
                ? error.message
                : "Could not select the skill relative path.",
              true,
            );
          }
        },
      ),
    /** ルートを起点に指示ファイルを選ぶ。ルート未設定・選択取消・ルート外選択では下書きを変えない。 */
    onBrowseProviderInstructionRelativePath: (providerId) =>
      withApi(
        `browse-instruction:${providerId}`,
        async (api, setSettingsFeedback) => {
          try {
            const currentProviderSettings = getProviderAppSettings(
              getCurrentPersistedSettingsDraft(),
              providerId,
            );
            const rootDirectory = currentProviderSettings.skillRootPath.trim();
            if (!rootDirectory) {
              setSettingsFeedback(
                "Set a root directory before choosing an instruction file.",
                true,
                true,
              );
              return;
            }

            const selectedPath = await api.pickFile(rootDirectory);
            if (!selectedPath) {
              setSettingsFeedback(
                "Instruction relative path selection canceled.",
              );
              return;
            }

            const relativePath = resolveRelativePathSelection(
              providerId,
              selectedPath,
              "Instruction file",
              setSettingsFeedback,
            );
            if (relativePath === null) {
              return;
            }

            updateProviderSettings(providerId, {
              instructionRelativePath: relativePath,
            });
            setSettingsFeedback(
              "Instruction relative path updated. Save settings to apply it.",
            );
          } catch (error) {
            setSettingsFeedback(
              error instanceof Error
                ? error.message
                : "Could not select the instruction relative path.",
              true,
            );
          }
        },
      ),
    /** 保存結果をアプリの設定へ反映する。保存待ちの間に編集が進んでいれば、その下書きは上書きしない。 */
    onSaveSettings: () =>
      withApi("save-settings", async (api, setSettingsFeedback) => {
        const settingsAtSaveStart = persistedSettingsDraft;
        try {
          const result = await saveHomeSettings(api, persistedSettingsDraft);
          setAppSettings(result.nextSettings);
          const currentDraft = getPersistedSettingsDraft?.();
          const hasNewChanges = currentDraft
            ? JSON.stringify(currentDraft) !==
              JSON.stringify(settingsAtSaveStart)
            : false;
          if (!hasNewChanges) {
            setSettingsDraft(result.nextSettings);
          }
          setSettingsFeedback(
            hasNewChanges
              ? "Settings saved. New changes remain unsaved."
              : result.feedback,
          );
        } catch (error) {
          setSettingsFeedback(
            error instanceof Error ? error.message : "Could not save settings.",
            true,
          );
        }
      }),
    /** 指定日より前のセッションを確認後に削除し、成功したらセッション概要を再取得する。 */
    onDeleteSessionsLastActiveBefore: () =>
      withApi("delete-sessions", async (api, setSettingsFeedback) => {
        setDeletingOldSessions(true);
        try {
          const result = await deleteOldSessions({
            api,
            cutoffDate: getSessionCleanupCutoffDate(),
            /** 削除処理が組み立てた確認文をネイティブ確認画面へ渡す。 */
            confirm: (message) => window.confirm(message),
          });
          if (result.kind === "success") {
            await refreshSessionSummaries?.();
            setSettingsFeedback(result.feedback);
          } else if (result.kind === "noop") {
            setSettingsFeedback(result.feedback, true, true);
          }
        } catch (error) {
          setSettingsFeedback(
            error instanceof Error
              ? error.message
              : "Could not delete old sessions.",
            true,
          );
        } finally {
          setDeletingOldSessions(false);
        }
      }),
  };
}
