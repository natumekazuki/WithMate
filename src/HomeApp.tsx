import { useEffect, useMemo, useRef, useState } from "react";

import { type CharacterProfile } from "./character-state.js";
import {
  createDefaultAppSettings,
  getProviderAppSettings,
  type AppSettings,
} from "./provider-settings-state.js";
import { type Session } from "./session-state.js";
import { DEFAULT_APPROVAL_MODE } from "./approval-mode.js";
import {
  type ModelCatalogSnapshot,
} from "./model-catalog.js";
import type { MemoryManagementSnapshot } from "./memory-management-state.js";
import {
  buildHomeLaunchProjection,
} from "./home-launch-projection.js";
import {
  buildHomeCharacterProjection,
} from "./home-character-projection.js";
import {
  buildCreateSessionInputFromLaunchDraft,
  closeLaunchDraft,
  createClosedLaunchDraft,
  openLaunchDraft,
  resolveLastUsedSessionSelection,
  setLaunchWorkspaceFromPath,
  syncLaunchDraftCharacter,
  type HomeLaunchDraft,
} from "./home-launch-state.js";
import {
  buildHomeSessionProjection,
} from "./home-session-projection.js";
import {
  buildHomeProviderSettingRows,
  buildPersistedAppSettingsFromRows,
  type HomeProviderSettingRow,
} from "./home-settings-view-model.js";
import {
  HomeLaunchDialog,
  HomeMonitorContent,
  HomeRecentSessionsPanel,
  HomeRightPane,
  HomeSettingsContent,
} from "./home-components.js";
import {
  exportHomeModelCatalog,
  importHomeModelCatalog,
  resetHomeDatabase,
  saveHomeSettings,
} from "./home-settings-actions.js";
import { buildHomeSettingsProjection } from "./home-settings-projection.js";
import {
  updateCharacterReflectionCharDeltaThreshold,
  updateCharacterReflectionCooldownSeconds,
  updateCharacterReflectionModelDraft,
  updateCharacterReflectionMessageDeltaThreshold,
  updateCharacterReflectionReasoningEffortDraft,
  updateAutoCollapseActionDockOnSend,
  updateCodingProviderApiKeyDraft,
  updateCodingProviderEnabledDraft,
  updateCodingProviderSkillRootPathDraft,
  updateMemoryExtractionModelDraft,
  updateMemoryExtractionReasoningEffortDraft,
  updateMemoryExtractionThresholdDraft,
  updateMemoryGenerationEnabled,
  updateSystemPromptPrefix,
} from "./home-settings-draft.js";
import {
  ALL_RESET_APP_DATABASE_TARGETS,
  normalizeResetAppDatabaseTargets,
  type ResetAppDatabaseTarget,
} from "./withmate-window-types.js";
import { getWithMateApi, isDesktopRuntime, withWithMateApi } from "./renderer-withmate-api.js";

async function openSessionWindow(sessionId: string) {
  await withWithMateApi((api) => api.openSession(sessionId));
}

async function openHomeWindow() {
  await withWithMateApi((api) => api.openHomeWindow());
}

async function openSessionMonitorWindow() {
  await withWithMateApi((api) => api.openSessionMonitorWindow());
}

async function openSettingsWindow() {
  await withWithMateApi((api) => api.openSettingsWindow());
}

async function openCharacterEditor(characterId?: string | null) {
  await withWithMateApi((api) => api.openCharacterEditor(characterId));
}

type HomeRightPaneView = "monitor" | "characters";
type HomeWindowMode = "home" | "monitor" | "settings";

function getHomeWindowMode(): HomeWindowMode {
  if (typeof window === "undefined") {
    return "home";
  }

  const mode = new URLSearchParams(window.location.search).get("mode");
  return mode === "monitor" || mode === "settings" ? mode : "home";
}

export default function HomeApp() {
  const desktopRuntime = isDesktopRuntime();
  const homeWindowMode = useMemo(() => getHomeWindowMode(), []);
  const isMonitorWindowMode = homeWindowMode === "monitor";
  const isSettingsWindowMode = homeWindowMode === "settings";
  const [sessions, setSessions] = useState<Session[]>([]);
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [openSessionWindowIds, setOpenSessionWindowIds] = useState<string[]>([]);
  const [sessionSearchText, setSessionSearchText] = useState("");
  const [characterSearchText, setCharacterSearchText] = useState("");
  const [rightPaneView, setRightPaneView] = useState<HomeRightPaneView>("monitor");
  const [settingsFeedback, setSettingsFeedback] = useState("");
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(createDefaultAppSettings());
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [settingsDraftLoaded, setSettingsDraftLoaded] = useState(!isSettingsWindowMode);
  const [modelCatalogLoaded, setModelCatalogLoaded] = useState(!isSettingsWindowMode);
  const [memoryManagementSnapshot, setMemoryManagementSnapshot] = useState<MemoryManagementSnapshot | null>(null);
  const [memoryManagementLoaded, setMemoryManagementLoaded] = useState(!isSettingsWindowMode);
  const [memoryManagementBusyTarget, setMemoryManagementBusyTarget] = useState<string | null>(null);
  const [memoryManagementFeedback, setMemoryManagementFeedback] = useState("");
  const [resettingDatabase, setResettingDatabase] = useState(false);
  const [resetDatabaseTargets, setResetDatabaseTargets] = useState<ResetAppDatabaseTarget[]>([...ALL_RESET_APP_DATABASE_TARGETS]);
  const [launchDraft, setLaunchDraft] = useState<HomeLaunchDraft>(() => createClosedLaunchDraft());
  const settingsDirtyRef = useRef(false);
  const settingsHydratedRef = useRef(!isSettingsWindowMode);

  const applyIncomingAppSettings = (settings: AppSettings, options?: { force?: boolean }) => {
    setAppSettings(settings);
    setSettingsDraft((current) => {
      const shouldHydrateDrafts =
        options?.force || !isSettingsWindowMode || !settingsHydratedRef.current || !settingsDirtyRef.current;
      return shouldHydrateDrafts ? settings : current;
    });
    setSettingsDraftLoaded(true);
    if (options?.force || !isSettingsWindowMode || !settingsHydratedRef.current || !settingsDirtyRef.current) {
      settingsHydratedRef.current = true;
    }
  };

  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();

    if (!withmateApi) {
      return () => {
        active = false;
      };
    }

    void withmateApi.listSessions().then((nextSessions) => {
      if (active) {
        setSessions(nextSessions);
      }
    });
    void Promise.all([withmateApi.getAppSettings(), withmateApi.getModelCatalog(null)]).then(([settings, snapshot]) => {
      if (!active) {
        return;
      }

      applyIncomingAppSettings(settings, { force: isSettingsWindowMode });
      setModelCatalog(snapshot);
      setModelCatalogLoaded(true);
    });
    if (isSettingsWindowMode) {
      void withmateApi.getMemoryManagementSnapshot()
        .then((snapshot) => {
          if (!active) {
            return;
          }

          setMemoryManagementSnapshot(snapshot);
          setMemoryManagementLoaded(true);
        })
        .catch((error) => {
          if (!active) {
            return;
          }

          setMemoryManagementFeedback(error instanceof Error ? error.message : "Memory 一覧の読み込みに失敗したよ。");
          setMemoryManagementLoaded(true);
        });
    }

    void withmateApi.listCharacters().then((nextCharacters) => {
      if (!active) {
        return;
      }

      setCharacters(nextCharacters);
      setLaunchDraft((current) => syncLaunchDraftCharacter(current, nextCharacters));
    });

    const unsubscribeSessions = withmateApi.subscribeSessions((nextSessions) => {
      if (active) {
        setSessions(nextSessions);
      }
    });

    const unsubscribeCharacters = withmateApi.subscribeCharacters((nextCharacters) => {
      if (!active) {
        return;
      }

      setCharacters(nextCharacters);
      setLaunchDraft((current) => syncLaunchDraftCharacter(current, nextCharacters));
    });
    const unsubscribeModelCatalog = withmateApi.subscribeModelCatalog((snapshot) => {
      if (active) {
        setModelCatalog(snapshot);
        setModelCatalogLoaded(true);
      }
    });
    const unsubscribeAppSettings = withmateApi.subscribeAppSettings((settings) => {
      if (active) {
        applyIncomingAppSettings(settings);
      }
    });

    return () => {
      active = false;
      unsubscribeSessions();
      unsubscribeCharacters();
      unsubscribeModelCatalog();
      unsubscribeAppSettings();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let receivedSubscriptionUpdate = false;
    const withmateApi = getWithMateApi();

    if (!withmateApi) {
      return () => {
        active = false;
      };
    }

    const unsubscribeOpenSessionWindowIds = withmateApi.subscribeOpenSessionWindowIds((nextSessionIds) => {
      if (!active) {
        return;
      }

      receivedSubscriptionUpdate = true;
      setOpenSessionWindowIds(nextSessionIds);
    });

    void withmateApi.listOpenSessionWindowIds().then((nextSessionIds) => {
      if (!active || receivedSubscriptionUpdate) {
        return;
      }

      setOpenSessionWindowIds(nextSessionIds);
    });

    return () => {
      active = false;
      unsubscribeOpenSessionWindowIds();
    };
  }, []);

  const sessionProjection = useMemo(
    () => buildHomeSessionProjection(sessions, openSessionWindowIds, sessionSearchText),
    [openSessionWindowIds, sessionSearchText, sessions],
  );
  const {
    filteredSessionEntries,
    normalizedSessionSearch,
    runningMonitorEntries,
    nonRunningMonitorEntries,
    monitorRunningEmptyMessage,
    monitorCompletedEmptyMessage,
  } = sessionProjection;
  const launchProjection = useMemo(
    () => buildHomeLaunchProjection({
      characters,
      launchCharacterSearchText: launchDraft.characterSearchText,
      launchCharacterId: launchDraft.characterId,
      launchProviderId: launchDraft.providerId,
      launchTitle: launchDraft.title,
      launchWorkspace: launchDraft.workspace,
      appSettings,
      modelCatalog,
    }),
    [
      appSettings,
      characterSearchText,
      characters,
      launchDraft,
      modelCatalog,
    ],
  );
  const {
    filteredLaunchCharacters,
    selectedCharacter,
    enabledLaunchProviders,
    selectedLaunchProvider,
    launchWorkspacePathLabel,
    canStartSession,
  } = launchProjection;
  const characterProjection = useMemo(
    () => buildHomeCharacterProjection(characters, characterSearchText),
    [characterSearchText, characters],
  );
  const { filteredCharacters, emptyState: characterEmptyState } = characterProjection;

  useEffect(() => {
    setLaunchDraft((current) => {
      if (enabledLaunchProviders.find((provider) => provider.id === current.providerId)) {
        return current;
      }

      return {
        ...current,
        providerId: enabledLaunchProviders[0]?.id ?? "",
      };
    });
  }, [enabledLaunchProviders]);

  const renderSearchIcon = () => (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M13.9 12.5l3.6 3.6-1.4 1.4-3.6-3.6a6 6 0 1 1 1.4-1.4Zm-4.9.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"
        fill="currentColor"
      />
    </svg>
  );
  const renderMonitorWindowIcon = () => (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M4 3.5h12A1.5 1.5 0 0 1 17.5 5v10a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15V5A1.5 1.5 0 0 1 4 3.5Zm0 1a.5.5 0 0 0-.5.5v2h13V5a.5.5 0 0 0-.5-.5H4Zm-.5 10.5a.5.5 0 0 0 .5.5h12a.5.5 0 0 0 .5-.5V8h-13v7Zm2-5h4v1h-4v-1Zm0 2h6v1h-6v-1Z"
        fill="currentColor"
      />
    </svg>
  );
  const homePageClassName = `page-shell home-page${isMonitorWindowMode ? " home-page-monitor-window" : ""}`;

  const handleBrowseWorkspace = async () => {
    const selectedPath = await withWithMateApi((api) => api.pickDirectory());
    if (!selectedPath) {
      return;
    }

    setLaunchDraft((current) => setLaunchWorkspaceFromPath(current, selectedPath));
  };

  const openLaunchDialog = () => {
    setLaunchDraft((current) => openLaunchDraft(current, enabledLaunchProviders[0]?.id ?? ""));
  };

  const closeLaunchDialog = () => {
    setLaunchDraft((current) => closeLaunchDraft(current));
  };

  const handleStartSession = async () => {
    const lastUsedSelection = resolveLastUsedSessionSelection(sessions, selectedLaunchProvider?.id ?? null);
    const sessionInput = buildCreateSessionInputFromLaunchDraft({
      draft: launchDraft,
      selectedCharacter,
      selectedProviderId: selectedLaunchProvider?.id ?? null,
      approvalMode: DEFAULT_APPROVAL_MODE,
      lastUsedSelection,
    });
    if (!sessionInput) {
      return;
    }

    const createdSession = await withWithMateApi((api) => api.createSession(sessionInput));
    if (!createdSession) {
      return;
    }
    closeLaunchDialog();
    await openSessionWindow(createdSession.id);
  };

  const handleImportModelCatalog = async () => {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      return;
    }

    try {
      setSettingsFeedback(await importHomeModelCatalog(withmateApi));
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : "model catalog の読み込みに失敗したよ。");
    }
  };

  const handleResetAppDatabase = async () => {
    const withmateApi = getWithMateApi();
    if (!withmateApi || resettingDatabase) {
      return;
    }

    setResettingDatabase(true);
    try {
      const result = await resetHomeDatabase({
        api: withmateApi,
        resetTargets: resetDatabaseTargets,
        confirm: (message) => window.confirm(message),
      });
      if (result.kind === "success") {
        setSessions(result.result.sessions);
        setModelCatalog(result.result.modelCatalog);
        applyIncomingAppSettings(result.result.appSettings, { force: true });
        setResetDatabaseTargets(result.result.resetTargets);
        setSettingsFeedback(result.feedback);
        if (isSettingsWindowMode) {
          const snapshot = await withmateApi.getMemoryManagementSnapshot();
          setMemoryManagementSnapshot(snapshot);
          setMemoryManagementLoaded(true);
        }
      } else if (result.kind === "noop") {
        setSettingsFeedback(result.feedback);
      }
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : "DB の初期化に失敗したよ。");
    } finally {
      setResettingDatabase(false);
    }
  };

  const handleToggleResetDatabaseTarget = (target: ResetAppDatabaseTarget) => {
    setResetDatabaseTargets((current) => {
      const next = current.includes(target) ? current.filter((item) => item !== target) : [...current, target];
      return normalizeResetAppDatabaseTargets(next);
    });
  };

  const handleSaveSettings = async () => {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      return;
    }

    try {
      const result = await saveHomeSettings(withmateApi, persistedSettingsDraft);
      setAppSettings(result.nextSettings);
      setSettingsDraft(result.nextSettings);
      setSettingsFeedback(result.feedback);
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : "設定の保存に失敗したよ。");
    }
  };

  const handleChangeProviderEnabled = (providerId: string, enabled: boolean) => {
    setSettingsDraft((current) => updateCodingProviderEnabledDraft(current, providerId, enabled));
  };

  const handleChangeProviderApiKey = (providerId: string, apiKey: string) => {
    setSettingsDraft((current) => updateCodingProviderApiKeyDraft(current, providerId, apiKey));
  };

  const handleChangeProviderSkillRootPath = (providerId: string, skillRootPath: string) => {
    setSettingsDraft((current) => updateCodingProviderSkillRootPathDraft(current, providerId, skillRootPath));
  };

  const handleBrowseProviderSkillRootPath = async (providerId: string) => {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      return;
    }

    const currentSettings = getProviderAppSettings(settingsDraft, providerId);
    const selectedPath = await withmateApi.pickDirectory(currentSettings.skillRootPath || null);
    if (!selectedPath) {
      return;
    }

    handleChangeProviderSkillRootPath(providerId, selectedPath);
  };

  const handleChangeMemoryExtractionModel = (providerId: string, model: string) => {
    const providerCatalog = modelCatalog?.providers.find((provider) => provider.id === providerId);
    if (!providerCatalog) {
      return;
    }

    setSettingsDraft((current) => updateMemoryExtractionModelDraft(current, providerCatalog, providerId, model));
  };

  const handleChangeMemoryExtractionReasoningEffort = (
    providerId: string,
    reasoningEffort: AppSettings["memoryExtractionProviderSettings"][string]["reasoningEffort"],
  ) => {
    setSettingsDraft((current) => updateMemoryExtractionReasoningEffortDraft(current, providerId, reasoningEffort));
  };

  const handleChangeMemoryExtractionThreshold = (providerId: string, value: string) => {
    setSettingsDraft((current) => updateMemoryExtractionThresholdDraft(current, providerId, value));
  };

  const handleChangeCharacterReflectionModel = (providerId: string, model: string) => {
    const providerCatalog = modelCatalog?.providers.find((provider) => provider.id === providerId);
    if (!providerCatalog) {
      return;
    }

    setSettingsDraft((current) => updateCharacterReflectionModelDraft(current, providerCatalog, providerId, model));
  };

  const handleChangeCharacterReflectionReasoningEffort = (
    providerId: string,
    reasoningEffort: AppSettings["characterReflectionProviderSettings"][string]["reasoningEffort"],
  ) => {
    setSettingsDraft((current) => updateCharacterReflectionReasoningEffortDraft(current, providerId, reasoningEffort));
  };

  const handleChangeCharacterReflectionCooldownSeconds = (value: string) => {
    setSettingsDraft((current) => updateCharacterReflectionCooldownSeconds(current, value));
  };

  const handleChangeCharacterReflectionCharDeltaThreshold = (value: string) => {
    setSettingsDraft((current) => updateCharacterReflectionCharDeltaThreshold(current, value));
  };

  const handleChangeCharacterReflectionMessageDeltaThreshold = (value: string) => {
    setSettingsDraft((current) => updateCharacterReflectionMessageDeltaThreshold(current, value));
  };

  const handleReloadMemoryManagement = async () => {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !isSettingsWindowMode) {
      return;
    }

    try {
      setMemoryManagementLoaded(false);
      const snapshot = await withmateApi.getMemoryManagementSnapshot();
      setMemoryManagementSnapshot(snapshot);
      setMemoryManagementFeedback("Memory 管理ビューを更新したよ。");
    } catch (error) {
      setMemoryManagementFeedback(error instanceof Error ? error.message : "Memory 一覧の読み込みに失敗したよ。");
    } finally {
      setMemoryManagementLoaded(true);
    }
  };

  const handleDeleteSessionMemory = async (sessionId: string) => {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !isSettingsWindowMode) {
      return;
    }

    try {
      setMemoryManagementBusyTarget(`session:${sessionId}`);
      await withmateApi.deleteSessionMemory(sessionId);
      const snapshot = await withmateApi.getMemoryManagementSnapshot();
      setMemoryManagementSnapshot(snapshot);
      setMemoryManagementFeedback("Session Memory を削除したよ。");
    } catch (error) {
      setMemoryManagementFeedback(error instanceof Error ? error.message : "Session Memory の削除に失敗したよ。");
    } finally {
      setMemoryManagementBusyTarget(null);
      setMemoryManagementLoaded(true);
    }
  };

  const handleDeleteProjectMemoryEntry = async (entryId: string) => {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !isSettingsWindowMode) {
      return;
    }

    try {
      setMemoryManagementBusyTarget(`project:${entryId}`);
      await withmateApi.deleteProjectMemoryEntry(entryId);
      const snapshot = await withmateApi.getMemoryManagementSnapshot();
      setMemoryManagementSnapshot(snapshot);
      setMemoryManagementFeedback("Project Memory を削除したよ。");
    } catch (error) {
      setMemoryManagementFeedback(error instanceof Error ? error.message : "Project Memory の削除に失敗したよ。");
    } finally {
      setMemoryManagementBusyTarget(null);
      setMemoryManagementLoaded(true);
    }
  };

  const handleDeleteCharacterMemoryEntry = async (entryId: string) => {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !isSettingsWindowMode) {
      return;
    }

    try {
      setMemoryManagementBusyTarget(`character:${entryId}`);
      await withmateApi.deleteCharacterMemoryEntry(entryId);
      const snapshot = await withmateApi.getMemoryManagementSnapshot();
      setMemoryManagementSnapshot(snapshot);
      setMemoryManagementFeedback("Character Memory を削除したよ。");
    } catch (error) {
      setMemoryManagementFeedback(error instanceof Error ? error.message : "Character Memory の削除に失敗したよ。");
    } finally {
      setMemoryManagementBusyTarget(null);
      setMemoryManagementLoaded(true);
    }
  };

  const providerSettingRows = useMemo<HomeProviderSettingRow[]>(
    () => buildHomeProviderSettingRows(modelCatalog, settingsDraft),
    [
      modelCatalog,
      settingsDraft,
    ],
  );
  const persistedSettingsDraft = useMemo(
    () => buildPersistedAppSettingsFromRows(settingsDraft, providerSettingRows),
    [providerSettingRows, settingsDraft],
  );
  const settingsProjection = useMemo(
    () =>
      buildHomeSettingsProjection({
        settingsDraftLoaded,
        modelCatalogLoaded,
        memoryManagementLoaded,
        resetDatabaseTargets,
        resettingDatabase,
      }),
    [memoryManagementLoaded, modelCatalogLoaded, resetDatabaseTargets, resettingDatabase, settingsDraftLoaded],
  );
  const {
    settingsWindowReady,
    selectedResetTargetsDescription,
    resetTargetItems,
    canResetDatabase,
  } = settingsProjection;
  const settingsDirty = useMemo(() => {
    return JSON.stringify(persistedSettingsDraft) !== JSON.stringify(appSettings);
  }, [appSettings, persistedSettingsDraft]);

  useEffect(() => {
    settingsDirtyRef.current = settingsDirty;
  }, [settingsDirty]);

  const handleExportModelCatalog = async () => {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      return;
    }

    try {
      setSettingsFeedback(await exportHomeModelCatalog(withmateApi));
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : "model catalog の保存に失敗したよ。");
    }
  };

  const settingsContent = (
    <HomeSettingsContent
      settingsDraft={settingsDraft}
      providerSettingRows={providerSettingRows}
      modelCatalogRevisionLabel={String(modelCatalog?.revision ?? "-")}
      selectedResetTargetsDescription={selectedResetTargetsDescription}
      resetTargetItems={resetTargetItems}
      resettingDatabase={resettingDatabase}
      canResetDatabase={canResetDatabase}
      settingsDirty={settingsDirty}
      settingsFeedback={settingsFeedback}
      memoryManagementSnapshot={memoryManagementSnapshot}
      memoryManagementLoading={!memoryManagementLoaded}
      memoryManagementBusyTarget={memoryManagementBusyTarget}
      memoryManagementFeedback={memoryManagementFeedback}
      onOpenHome={() => void openHomeWindow()}
      onCloseWindow={() => window.close()}
      onChangeSystemPromptPrefix={(value) => setSettingsDraft((current) => updateSystemPromptPrefix(current, value))}
      onChangeMemoryGenerationEnabled={(enabled) =>
        setSettingsDraft((current) => updateMemoryGenerationEnabled(current, enabled))
      }
      onChangeAutoCollapseActionDockOnSend={(enabled) =>
        setSettingsDraft((current) => updateAutoCollapseActionDockOnSend(current, enabled))
      }
      onChangeProviderEnabled={handleChangeProviderEnabled}
      onChangeProviderApiKey={handleChangeProviderApiKey}
      onChangeProviderSkillRootPath={handleChangeProviderSkillRootPath}
      onBrowseProviderSkillRootPath={(providerId) => void handleBrowseProviderSkillRootPath(providerId)}
      onChangeMemoryExtractionModel={handleChangeMemoryExtractionModel}
      onChangeMemoryExtractionReasoningEffort={handleChangeMemoryExtractionReasoningEffort}
      onChangeMemoryExtractionThreshold={handleChangeMemoryExtractionThreshold}
      onChangeCharacterReflectionModel={handleChangeCharacterReflectionModel}
      onChangeCharacterReflectionReasoningEffort={handleChangeCharacterReflectionReasoningEffort}
      onChangeCharacterReflectionCooldownSeconds={handleChangeCharacterReflectionCooldownSeconds}
      onChangeCharacterReflectionCharDeltaThreshold={handleChangeCharacterReflectionCharDeltaThreshold}
      onChangeCharacterReflectionMessageDeltaThreshold={handleChangeCharacterReflectionMessageDeltaThreshold}
      onImportModelCatalog={() => void handleImportModelCatalog()}
      onExportModelCatalog={() => void handleExportModelCatalog()}
      onReloadMemoryManagement={() => void handleReloadMemoryManagement()}
      onDeleteSessionMemory={(sessionId) => void handleDeleteSessionMemory(sessionId)}
      onDeleteProjectMemoryEntry={(entryId) => void handleDeleteProjectMemoryEntry(entryId)}
      onDeleteCharacterMemoryEntry={(entryId) => void handleDeleteCharacterMemoryEntry(entryId)}
      onToggleResetDatabaseTarget={handleToggleResetDatabaseTarget}
      onResetAppDatabase={() => void handleResetAppDatabase()}
      onSaveSettings={() => void handleSaveSettings()}
    />
  );

  if (!desktopRuntime) {
    return (
      <div className={homePageClassName}>
        <main className="home-layout home-layout-minimal">
          <section className="panel empty-list-card rise-1">
            <p>Home は Electron から起動してね。</p>
          </section>
        </main>
      </div>
    );
  }

  if (isSettingsWindowMode) {
    return (
      <div className={`${homePageClassName} home-page-settings-window`.trim()}>
        <main className="home-layout home-layout-settings-window">
          <section className="launch-dialog settings-dialog panel settings-window-shell">
            {settingsWindowReady ? (
              settingsContent
            ) : (
              <div className="settings-loading-state">
                <p>Settings を読み込み中...</p>
              </div>
            )}
          </section>
        </main>
      </div>
    );
  }

  if (isMonitorWindowMode) {
    return (
      <div className={homePageClassName}>
        <main className="home-layout home-layout-monitor-window">
          <section className="panel home-monitor-window-panel rise-3">
            <div className="home-monitor-window-head">
              <div className="home-monitor-window-copy">
                <strong>Session Monitor</strong>
                <span>開いている Session Window を常時表示</span>
              </div>
              <button className="launch-toggle compact" type="button" onClick={() => void openHomeWindow()}>
                Home
              </button>
            </div>
            <section className="home-monitor-panel compact" aria-label="Session Monitor">
              <HomeMonitorContent
                runningEntries={runningMonitorEntries}
                nonRunningEntries={nonRunningMonitorEntries}
                runningEmptyMessage={monitorRunningEmptyMessage}
                completedEmptyMessage={monitorCompletedEmptyMessage}
                onOpenSession={(sessionId) => void openSessionWindow(sessionId)}
              />
            </section>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className={homePageClassName}>
      <main className="home-layout rise-2">
        <HomeRecentSessionsPanel
          filteredSessionEntries={filteredSessionEntries}
          normalizedSessionSearch={normalizedSessionSearch}
          searchText={sessionSearchText}
          searchIcon={renderSearchIcon()}
          onChangeSearchText={setSessionSearchText}
          onOpenLaunchDialog={openLaunchDialog}
          onOpenSession={(sessionId) => void openSessionWindow(sessionId)}
        />

        <HomeRightPane
          rightPaneView={rightPaneView}
          runningMonitorEntries={runningMonitorEntries}
          nonRunningMonitorEntries={nonRunningMonitorEntries}
          monitorRunningEmptyMessage={monitorRunningEmptyMessage}
          monitorCompletedEmptyMessage={monitorCompletedEmptyMessage}
          filteredCharacters={filteredCharacters}
          characterEmptyState={characterEmptyState}
          characterSearchText={characterSearchText}
          searchIcon={renderSearchIcon()}
          monitorWindowIcon={renderMonitorWindowIcon()}
          onChangeRightPaneView={setRightPaneView}
          onOpenSessionMonitorWindow={() => void openSessionMonitorWindow()}
          onOpenSettingsWindow={() => void openSettingsWindow()}
          onChangeCharacterSearchText={setCharacterSearchText}
          onOpenCharacterEditor={(characterId) => void openCharacterEditor(characterId)}
          onOpenSession={(sessionId) => void openSessionWindow(sessionId)}
        />
      </main>

      <HomeLaunchDialog
        open={launchDraft.open}
        title={launchDraft.title}
        workspace={launchDraft.workspace}
        launchWorkspacePathLabel={launchWorkspacePathLabel}
        enabledLaunchProviders={enabledLaunchProviders}
        selectedLaunchProviderId={selectedLaunchProvider?.id ?? null}
        characters={characters}
        filteredLaunchCharacters={filteredLaunchCharacters}
        selectedCharacterId={selectedCharacter?.id ?? null}
        launchCharacterSearchText={launchDraft.characterSearchText}
        canStartSession={canStartSession}
        searchIcon={renderSearchIcon()}
        onClose={closeLaunchDialog}
        onChangeTitle={(value) => setLaunchDraft((current) => ({ ...current, title: value }))}
        onBrowseWorkspace={() => void handleBrowseWorkspace()}
        onSelectProvider={(providerId) => setLaunchDraft((current) => ({ ...current, providerId }))}
        onChangeCharacterSearch={(value) => setLaunchDraft((current) => ({ ...current, characterSearchText: value }))}
        onSelectCharacter={(characterId) => setLaunchDraft((current) => ({ ...current, characterId }))}
        onOpenCharacterEditor={() => void openCharacterEditor()}
        onStartSession={() => void handleStartSession()}
      />

    </div>
  );
}
