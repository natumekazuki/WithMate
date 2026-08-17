import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createDefaultAppSettings,
  type AppSettings,
} from "./provider-settings-state.js";
import { startAppSettingsSubscription } from "./app-settings-subscription.js";
import { type SessionSummary } from "./session-state.js";
import {
  startSessionSummariesSubscription,
  type SessionSummariesLoadStatus,
} from "./session-summary-subscription.js";
import {
  type AuxiliarySessionSummary,
} from "./auxiliary-session-state.js";
import { type ModelCatalogSnapshot } from "./model-catalog.js";
import { startModelCatalogSubscription } from "./model-catalog-subscription.js";
import type { OpenSessionWindowIdsState } from "./open-session-window-subscription.js";
import type { MemoryV6Diagnostics } from "./memory-v6/memory-diagnostics-state.js";
import type { SessionIntegrationDiagnostics } from "./session-integration-diagnostics-state.js";
import { WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE } from "./memory-v6/provider-instruction-sample.js";
import {
  buildHomeLaunchProjection,
} from "./home/home-launch-projection.js";
import { buildHomeLaunchDialogProps } from "./home/home-launch-dialog-props.js";
import {
  createClosedLaunchDraft,
  applyLaunchWorkspacePathValidation,
  beginLaunchWorkspacePathValidation,
  markLaunchWorkspacePathValidationPending,
  resolveLaunchCharacterId,
  type HomeLaunchDraft,
} from "./home/home-launch-state.js";
import {
  createHomeLaunchWorkspaceValidationController,
  type HomeLaunchWorkspaceValidationController,
} from "./home/home-launch-workspace-validation.js";
import { resolveSelectedLaunchProviderDraftId } from "./launch/launch-provider-selection.js";
import { type CompanionSessionSummary } from "./companion-state.js";
import { startCompanionSessionSummariesSubscription } from "./companion-session-summary-subscription.js";
import { buildHomeMateProfileHandlers } from "./home/home-mate-profile-handlers.js";
import {
  buildHomeSessionProjection,
} from "./home/home-session-projection.js";
import { buildHomeLaunchHandlers } from "./home/home-launch-handlers.js";
import {
  buildHomeProviderSettingRows,
  buildPersistedAppSettingsFromRows,
  type HomeProviderSettingRow,
} from "./settings/settings-view-model.js";
import type { CharacterCatalogEntry } from "./character/character-catalog.js";
import { HomeAppRouter } from "./home/HomeAppRouter.js";
import { buildHomeDashboardSlots } from "./home/HomeDashboardSlots.js";
import { buildHomeRecentSessionsPanelProps } from "./home/home-recent-sessions-panel-props.js";
import { mergePinnedSessionSummary } from "./home/session-pinning.js";
import { buildHomeRightPaneProps } from "./home/home-right-pane-props.js";
import { buildHomeWindowContentSlots } from "./home/HomeWindowContentSlots.js";
import { getHomeWindowMode } from "./home/home-window-mode.js";
import { useHomeOpenWindowSubscriptions } from "./home/use-home-open-window-subscriptions.js";
import {
  openCharacterEditorWindow,
  openCompanionReviewWindow,
  openMemoryV6ReviewWindow,
  openSessionMonitorWindow,
  openSessionWindow,
  openSettingsWindow,
} from "./home/home-launch-commands.js";
import {
  buildHomeSettingsContentProps,
  type HomeSettingsContentBaseProps,
} from "./settings/home-settings-content-props.js";
import { buildSettingsDraftHandlers } from "./settings/settings-draft-handlers.js";
import { buildSettingsCommandHandlers } from "./settings/settings-command-handlers.js";
import { getWithMateApi, isDesktopRuntime, withWithMateApi } from "./renderer-withmate-api.js";
import {
  type MateProfile,
  type MateStorageState,
} from "./mate/mate-state.js";
import { buildHomeMateSetupContentProps } from "./mate/home-mate-setup-props.js";
import { buildMateStatusRefreshers } from "./mate/mate-status-refreshers.js";
import { buildHomeMonitorContentProps } from "./home/home-monitor-content-props.js";
import { renderHomeMonitorWindowIcon, renderHomeSearchIcon } from "./home/home-icons.js";
import {
  createHomeActiveAuxiliarySessionRefresher,
  resolveHomeActiveAuxiliarySessionsState,
} from "./home/home-active-auxiliary-refresh.js";
import type { ScheduleSummaryProjection } from "./session-schedule-ui-projection.js";
import type { SessionScheduleSummary } from "./session-schedule.js";

type HomeRightPaneView = "monitor" | "characters" | "schedules";

type HomeSessionSummariesState = {
  status: SessionSummariesLoadStatus;
  summaries: SessionSummary[];
};

export default function HomeApp() {
  const desktopRuntime = isDesktopRuntime();
  const homeWindowMode = useMemo(() => getHomeWindowMode(), []);
  const isMonitorWindowMode = homeWindowMode === "monitor";
  const isSettingsWindowMode = homeWindowMode === "settings";
  const isMemoryReviewWindowMode = homeWindowMode === "memory-review";
  const [sessionSummariesState, setSessionSummariesState] = useState<HomeSessionSummariesState>({
    status: "loading",
    summaries: [],
  });
  const sessions = sessionSummariesState.summaries;
  const [companionSessions, setCompanionSessions] = useState<CompanionSessionSummary[]>([]);
  const [activeAuxiliarySessions, setActiveAuxiliarySessions] = useState<AuxiliarySessionSummary[]>([]);
  const [openSessionWindowIdsState, setOpenSessionWindowIdsState] = useState<OpenSessionWindowIdsState>({
    status: "loading",
    sessionIds: [],
  });
  const openSessionWindowIds = openSessionWindowIdsState.sessionIds;
  const [openCompanionReviewWindowIds, setOpenCompanionReviewWindowIds] = useState<string[]>([]);
  const [sessionSearchText, setSessionSearchText] = useState("");
  const [pendingSessionPinIds, setPendingSessionPinIds] = useState<string[]>([]);
  const [rightPaneView, setRightPaneView] = useState<HomeRightPaneView>("monitor");
  const [settingsFeedback, setSettingsFeedback] = useState("");
  const [sessionCleanupCutoffDate, setSessionCleanupCutoffDate] = useState("");
  const [deletingOldSessions, setDeletingOldSessions] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(createDefaultAppSettings());
  const [memoryV6Diagnostics, setMemoryV6Diagnostics] = useState<MemoryV6Diagnostics | null>(null);
  const [sessionIntegrationDiagnostics, setSessionIntegrationDiagnostics] =
    useState<SessionIntegrationDiagnostics | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [characterEntries, setCharacterEntries] = useState<CharacterCatalogEntry[]>([]);
  const [characterListFeedback, setCharacterListFeedback] = useState("");
  const [charactersLoaded, setCharactersLoaded] = useState(false);
  const [settingsDraftLoaded, setSettingsDraftLoaded] = useState(!isSettingsWindowMode);
  const [modelCatalogLoadSettled, setModelCatalogLoadSettled] = useState(!isSettingsWindowMode);
  const [launchDraft, setLaunchDraft] = useState<HomeLaunchDraft>(() => createClosedLaunchDraft());
  const [launchFeedback, setLaunchFeedback] = useState("");
  const [launchStarting, setLaunchStarting] = useState(false);
  const [mateState, setMateState] = useState<MateStorageState | null>(null);
  const [mateProfile, setMateProfile] = useState<MateProfile | null>(null);
  const [mateDisplayName, setMateDisplayName] = useState("");
  const [mateCreating, setMateCreating] = useState(false);
  const [mateAvatarUpdating, setMateAvatarUpdating] = useState(false);
  const [mateCreationFeedback, setMateCreationFeedback] = useState("");
  const [mateProfileEditorOpen, setMateProfileEditorOpen] = useState(false);
  const [scheduleSummaries, setScheduleSummaries] = useState<SessionScheduleSummary[]>([]);
  const [scheduleLoadState, setScheduleLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const scheduleRefreshGenerationRef = useRef(0);
  const settingsDirtyRef = useRef(false);
  const settingsHydratedRef = useRef(!isSettingsWindowMode);
  const workspaceValidationControllerRef = useRef<HomeLaunchWorkspaceValidationController | null>(null);
  if (workspaceValidationControllerRef.current === null) {
    workspaceValidationControllerRef.current = createHomeLaunchWorkspaceValidationController({
      validate: async (targetPath) => (
        await withWithMateApi((api) => api.validateWorkspaceDirectory(targetPath))
        ?? { valid: false, reason: "unavailable" }
      ),
      onScheduled: (targetPath) => {
        setLaunchDraft((current) => beginLaunchWorkspacePathValidation(current, targetPath));
      },
      onValidationStart: (targetPath) => {
        setLaunchDraft((current) => markLaunchWorkspacePathValidationPending(current, targetPath));
      },
      onResult: (targetPath, result) => {
        setLaunchDraft((current) => applyLaunchWorkspacePathValidation(current, targetPath, result));
      },
    });
  }

  useEffect(() => () => workspaceValidationControllerRef.current?.cancel(), []);

  const refreshHomeSchedules = useCallback(async () => {
    const api = getWithMateApi();
    if (!api) return;
    const generation = ++scheduleRefreshGenerationRef.current;
    setScheduleLoadState("loading");
    try {
      const next = await api.listSessionSchedules(null);
      if (generation !== scheduleRefreshGenerationRef.current) return;
      setScheduleSummaries(next);
      setScheduleLoadState("loaded");
    } catch {
      if (generation !== scheduleRefreshGenerationRef.current) return;
      setScheduleLoadState("error");
    }
  }, []);

  useEffect(() => {
    void refreshHomeSchedules();
    const api = getWithMateApi();
    return api?.subscribeSessionSchedules(() => void refreshHomeSchedules());
  }, [refreshHomeSchedules]);

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

  const { refreshMateStatus } = buildMateStatusRefreshers({
    setMateState,
    setMateProfile,
    setMateDisplayName,
    setMateAvatarUpdating,
  });

  const applyLoadedCharacterEntries = (entries: CharacterCatalogEntry[]) => {
    setCharacterEntries(entries);
    setLaunchDraft((current) => ({
      ...current,
      characterId: resolveLaunchCharacterId(entries, current.characterId),
    }));
  };

  const applyLoadedSessionSummaries = (summaries: SessionSummary[]) => {
    setSessionSummariesState({ status: "loaded", summaries });
  };

  const setSessionPinned = async (sessionId: string, isPinned: boolean) => {
    const api = getWithMateApi();
    if (!api) {
      window.alert("ピン止めはElectronアプリから操作してね。");
      return;
    }
    setPendingSessionPinIds((current) => current.includes(sessionId) ? current : [...current, sessionId]);
    try {
      const saved = await api.setSessionPinned({ sessionId, isPinned });
      setSessionSummariesState((current) => ({
        ...current,
        summaries: mergePinnedSessionSummary(current.summaries, saved),
      }));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "ピン止めの変更に失敗したよ。");
    } finally {
      setPendingSessionPinIds((current) => current.filter((id) => id !== sessionId));
    }
  };

  const refreshCharacterEntries = async (
    api: NonNullable<ReturnType<typeof getWithMateApi>>,
  ): Promise<CharacterCatalogEntry[]> => {
    const entries = await api.listCharacters();
    applyLoadedCharacterEntries(entries);
    setCharacterListFeedback("");
    setCharactersLoaded(true);
    return entries;
  };

  const refreshMemoryV6Diagnostics = async (
    api: NonNullable<ReturnType<typeof getWithMateApi>>,
  ): Promise<void> => {
    setMemoryV6Diagnostics(await api.getMemoryV6Diagnostics());
  };

  const refreshSessionIntegrationDiagnostics = async (
    api: NonNullable<ReturnType<typeof getWithMateApi>>,
  ): Promise<void> => {
    setSessionIntegrationDiagnostics(await api.getSessionIntegrationDiagnostics());
  };

  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();

    if (!withmateApi) {
      return () => {
        active = false;
      };
    }

    const handleInitialSummaryLoadError = (error: unknown) => {
      setLaunchFeedback(error instanceof Error ? error.message : "Home の読み込みに失敗したよ。");
    };

    const handleInitialSessionSummaryLoadError = (error: unknown) => {
      setSessionSummariesState((current) => ({ ...current, status: "error" }));
      handleInitialSummaryLoadError(error);
    };

    let unsubscribeSessions: (() => void) | null = null;
    let unsubscribeCompanionSessions: (() => void) | null = null;

    const startOperationalHomeSummarySubscriptions = () => {
      if (unsubscribeSessions || unsubscribeCompanionSessions) {
        return;
      }

      unsubscribeSessions = startSessionSummariesSubscription({
        api: withmateApi,
        applySummaries: applyLoadedSessionSummaries,
        onInitialLoadError: handleInitialSessionSummaryLoadError,
      });
      unsubscribeCompanionSessions = startCompanionSessionSummariesSubscription({
        api: withmateApi,
        applySummaries: setCompanionSessions,
        onInitialLoadError: handleInitialSummaryLoadError,
      });
    };

    startOperationalHomeSummarySubscriptions();

    void refreshMateStatus(withmateApi, { isActive: () => active }).then(() => {
      if (!active) {
        return;
      }
    }).catch((error) => {
      if (!active) {
        return;
      }

      setMateState("not_created");
      setMateProfile(null);
      setMateCreationFeedback(error instanceof Error ? error.message : "Mate 状態の取得に失敗したよ。");
    });

    void refreshCharacterEntries(withmateApi).catch((error) => {
      if (!active) {
        return;
      }

      setCharacterListFeedback(error instanceof Error ? error.message : "Character 一覧の読み込みに失敗したよ。");
    });
    void refreshMemoryV6Diagnostics(withmateApi).catch((error) => {
      if (!active) {
        return;
      }

      setSettingsFeedback(error instanceof Error ? error.message : "Memory V6 diagnostics の読み込みに失敗したよ。");
    });
    void refreshSessionIntegrationDiagnostics(withmateApi).catch((error) => {
      if (!active) {
        return;
      }

      setSettingsFeedback(error instanceof Error ? error.message : "Session integration diagnostics の読み込みに失敗したよ。");
    });

    const unsubscribeModelCatalog = startModelCatalogSubscription({
      api: withmateApi,
      enabled: true,
      subscribe: true,
      applyModelCatalog: (snapshot) => {
        setModelCatalog(snapshot);
        setModelCatalogLoadSettled(true);
      },
      onInitialLoadError: (error) => {
        setModelCatalog(null);
        setModelCatalogLoadSettled(true);
        setSettingsFeedback(error instanceof Error ? error.message : "model catalog の読み込みに失敗したよ。");
      },
    });
    const unsubscribeAppSettings = startAppSettingsSubscription({
      api: withmateApi,
      loadInitial: true,
      applyAppSettings: (settings) => {
        applyIncomingAppSettings(settings, { force: isSettingsWindowMode });
      },
      onInitialLoadError: (error) => {
        setMateCreationFeedback(error instanceof Error ? error.message : "Mate 状態の取得に失敗したよ。");
      },
    });

    return () => {
      active = false;
      unsubscribeSessions?.();
      unsubscribeCompanionSessions?.();
      unsubscribeModelCatalog();
      unsubscribeAppSettings();
    };
  }, []);

  useEffect(() => {
    const withmateApi = getWithMateApi();
    if (!withmateApi || isSettingsWindowMode || isMonitorWindowMode || isMemoryReviewWindowMode) {
      return;
    }

    let refreshInFlight = false;
    const refreshCharactersOnFocus = () => {
      if (refreshInFlight) {
        return;
      }
      refreshInFlight = true;
      void refreshCharacterEntries(withmateApi).catch((error) => {
        setCharacterListFeedback(error instanceof Error ? error.message : "Character 一覧の再読み込みに失敗したよ。");
      }).finally(() => {
        refreshInFlight = false;
      });
    };

    window.addEventListener("focus", refreshCharactersOnFocus);
    return () => window.removeEventListener("focus", refreshCharactersOnFocus);
  }, [isMemoryReviewWindowMode, isMonitorWindowMode, isSettingsWindowMode]);

  useHomeOpenWindowSubscriptions({
    getApi: getWithMateApi,
    setOpenSessionWindowIdsState,
    setOpenCompanionReviewWindowIds,
  });

  useEffect(() => {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      setActiveAuxiliarySessions([]);
      return;
    }

    const refresher = createHomeActiveAuxiliarySessionRefresher({
      fetchActiveAuxiliarySessions: () => withmateApi.listOpenActiveAuxiliarySessionSummaries(),
      setActiveAuxiliarySessions: (sessions) => {
        setActiveAuxiliarySessions((current) =>
          resolveHomeActiveAuxiliarySessionsState(current, sessions),
        );
      },
      onError: (error) => console.error(error),
    });

    refresher.refresh();
    const unsubscribeLiveRun = withmateApi.subscribeLiveSessionRun(() => {
      refresher.refresh();
    });

    return () => {
      refresher.dispose();
      unsubscribeLiveRun();
    };
  }, [openCompanionReviewWindowIds, openSessionWindowIds]);

  const sessionProjection = useMemo(
    () => buildHomeSessionProjection(
      sessions,
      openSessionWindowIds,
      sessionSearchText,
      companionSessions,
      openCompanionReviewWindowIds,
      activeAuxiliarySessions,
    ),
    [
      activeAuxiliarySessions,
      companionSessions,
      openCompanionReviewWindowIds,
      openSessionWindowIds,
      sessionSearchText,
      sessions,
    ],
  );
  const {
    filteredSessionEntries,
    normalizedSessionSearch,
    runningMonitorEntries,
    nonRunningMonitorEntries,
  } = sessionProjection;
  const launchProjection = useMemo(
    () => buildHomeLaunchProjection({
      launchProviderId: launchDraft.providerId,
      launchMode: "session",
      launchTitle: launchDraft.title,
      launchWorkspace: launchDraft.workspace,
      workspacePathInput: launchDraft.workspacePathInput,
      workspaceValidation: launchDraft.workspaceValidation,
      workspaceValidationMessage: launchDraft.workspaceValidationMessage,
      launchCharacterId: launchDraft.characterId,
      launchCharacterSelectionMode: launchDraft.characterSelectionMode,
      characterEntries,
      charactersLoaded,
      appSettings,
      modelCatalog,
    }),
    [appSettings, characterEntries, charactersLoaded, launchDraft, modelCatalog],
  );
  const { enabledLaunchProviders, selectedLaunchProvider } = launchProjection;

  useEffect(() => {
    setLaunchDraft((current) => {
      const nextProviderId = resolveSelectedLaunchProviderDraftId(
        enabledLaunchProviders,
        current.providerId,
      );

      if (current.providerId === nextProviderId) {
        return current;
      }

      return {
        ...current,
        providerId: nextProviderId,
      };
    });
  }, [enabledLaunchProviders]);

  const homePageClassName = `page-shell home-page${isMonitorWindowMode ? " home-page-monitor-window" : ""}`;

  const homeLaunchHandlers = buildHomeLaunchHandlers({
    launchDraft,
    launchStarting,
    mateState,
    mateProfile,
    enabledLaunchProviders,
    characterEntries,
    selectedLaunchProviderId: selectedLaunchProvider?.id ?? null,
    sessions,
    openSessionWindowIds,
    openSessionWindowIdsLoadStatus: openSessionWindowIdsState.status,
    sessionSummariesLoadStatus: sessionSummariesState.status,
    refreshCharacterEntries: async () => {
      const api = getWithMateApi();
      if (!api) {
        throw new Error("Character 一覧の再読み込みには desktop runtime が必要だよ。");
      }
      return refreshCharacterEntries(api);
    },
    setCharactersLoaded,
    setLaunchFeedback,
    setLaunchStarting,
    setLaunchDraft,
    pickWorkspaceDirectory: async () => withWithMateApi((api) => api.pickDirectory()),
    scheduleWorkspaceValidation: (targetPath) => workspaceValidationControllerRef.current?.schedule(targetPath),
    cancelWorkspaceValidation: () => workspaceValidationControllerRef.current?.cancel(),
    openSessionWindow,
    openCompanionReviewWindow,
    createSession: async (input) => await withWithMateApi((api) => api.createSession(input)),
    createCompanionSession: async (input) => await withWithMateApi((api) => api.createCompanionSession(input)),
    upsertSessionSummary: (summary) => {
      setSessionSummariesState((current) => ({
        ...current,
        summaries: [
          summary,
          ...current.summaries.filter((session) => session.id !== summary.id),
        ],
      }));
    },
    upsertCompanionSessionSummary: (summary) => {
      setCompanionSessions((current) => [
        summary,
        ...current.filter((session) => session.id !== summary.id),
      ]);
    },
  });

  const mateProfileHandlers = buildHomeMateProfileHandlers({
    getApi: getWithMateApi,
    mateDisplayName,
    mateState,
    mateProfile,
    setMateState,
    setMateProfile,
    setMateDisplayName,
    setMateCreationFeedback,
    setMateProfileEditorOpen,
    setMateCreating,
    setMateAvatarUpdating,
    setLaunchFeedback,
    setSessions: applyLoadedSessionSummaries,
    setCompanionSessions,
  });

  const settingsDraftHandlers = buildSettingsDraftHandlers({
    setSettingsDraft,
  });

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
  const settingsWindowReady =
    settingsDraftLoaded && modelCatalogLoadSettled;
  const settingsDirty = useMemo(() => {
    return JSON.stringify(persistedSettingsDraft) !== JSON.stringify(appSettings);
  }, [appSettings, persistedSettingsDraft]);

  useEffect(() => {
    settingsDirtyRef.current = settingsDirty;
  }, [settingsDirty]);

  const settingsCommandHandlers = buildSettingsCommandHandlers({
    getApi: getWithMateApi,
    persistedSettingsDraft,
    setAppSettings,
    setSettingsDraft,
    setSettingsFeedback,
    setMemoryV6Diagnostics,
    setSessionIntegrationDiagnostics,
    getSessionCleanupCutoffDate: () => sessionCleanupCutoffDate,
    setDeletingOldSessions,
    refreshSessionSummaries: async () => {
      const api = getWithMateApi();
      if (!api) {
        return;
      }
      applyLoadedSessionSummaries(await api.listSessionSummaries());
    },
    onSettingsSaved: () => {
      const api = getWithMateApi();
      if (!api) {
        return;
      }
      void refreshMemoryV6Diagnostics(api).catch((error) => {
        setSettingsFeedback(error instanceof Error ? error.message : "Memory V6 diagnostics の再読み込みに失敗したよ。");
      });
      void refreshSessionIntegrationDiagnostics(api).catch((error) => {
        setSettingsFeedback(error instanceof Error ? error.message : "Session integration diagnostics の再読み込みに失敗したよ。");
      });
    },
  });

  const isMateStateLoading = mateState === null;
  const canUsePrimaryFeatures = mateState !== null;

  const baseSettingsContentProps: HomeSettingsContentBaseProps = {
    settingsDraft,
    providerSettingRows,
    providerCatalogLoaded: modelCatalog !== null,
    modelCatalogRevisionLabel: String(modelCatalog?.revision ?? "-"),
    memoryV6Diagnostics,
    sessionIntegrationDiagnostics,
    settingsDirty,
    settingsFeedback,
    sessionCleanupCutoffDate,
    deletingOldSessions,
    onChangeSessionCleanupCutoffDate: setSessionCleanupCutoffDate,
    onOpenMemoryV6Review: () => void openMemoryV6ReviewWindow(),
    onCopyMemoryProviderInstructionSample: () => {
      const clipboard = navigator.clipboard;
      if (!clipboard?.writeText) {
        setSettingsFeedback("この環境では clipboard copy を利用できません。");
        return;
      }

      void clipboard.writeText(WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE)
        .then(() => setSettingsFeedback("WithMate Memory の provider instruction sample をコピーしたよ。"))
        .catch((error) => {
          setSettingsFeedback(error instanceof Error ? error.message : "provider instruction sample のコピーに失敗したよ。");
        });
    },
    ...settingsDraftHandlers,
    ...settingsCommandHandlers,
  };

  const { settingsContent, mateSetupContent, monitorContent } = buildHomeWindowContentSlots({
    settingsContent: buildHomeSettingsContentProps(baseSettingsContentProps),
    mateSetupContent: buildHomeMateSetupContentProps({
      mateState,
      mateProfile,
      mateDisplayName,
      mateCreating,
      mateAvatarUpdating,
      mateCreationFeedback,
      onChangeDisplayName: mateProfileHandlers.onChangeDisplayName,
      onSubmit: mateProfileHandlers.onSubmit,
      onOpenSettings: () => void openSettingsWindow(),
      onCancelEdit: mateProfileHandlers.onCancelEdit,
      onSelectAvatar: mateProfileHandlers.onSelectAvatar,
      onClearAvatar: mateProfileHandlers.onClearAvatar,
    }),
    monitorContent: buildHomeMonitorContentProps({
      runningEntries: runningMonitorEntries,
      nonRunningEntries: nonRunningMonitorEntries,
      onOpenSession: (sessionId) => void openSessionWindow(sessionId),
      onOpenCompanionReview: (sessionId) => void openCompanionReviewWindow(sessionId),
    }),
  });

  const { recentSessionsPanel, rightPane, launchDialog } = buildHomeDashboardSlots({
    recentSessionsPanel: buildHomeRecentSessionsPanelProps({
      filteredSessionEntries,
      companionSessions,
      normalizedSessionSearch,
      searchText: sessionSearchText,
      searchIcon: renderHomeSearchIcon(),
      handlers: {
        onChangeSearchText: setSessionSearchText,
        onOpenLaunchDialog: homeLaunchHandlers.onOpenLaunchDialog,
        onOpenSession: (sessionId) => void openSessionWindow(sessionId),
        onSetSessionPinned: (sessionId, isPinned) => void setSessionPinned(sessionId, isPinned),
        onOpenCompanionReview: (sessionId) => void openCompanionReviewWindow(sessionId),
      },
      canUsePrimaryFeatures,
      pendingSessionPinIds,
    }),
    rightPane: buildHomeRightPaneProps({
      rightPaneView,
      schedules: scheduleSummaries.map((schedule): ScheduleSummaryProjection => ({
        id: schedule.id,
        sessionId: schedule.sessionId,
        revision: schedule.revision,
        sessionTitle: sessions.find((session) => session.id === schedule.sessionId)?.taskTitle ?? schedule.sessionId,
        name: schedule.name,
        state: schedule.state,
        status: schedule.state,
        trigger: schedule.trigger,
        nextFireAt: schedule.nextFireAt,
        lastFireResult: schedule.latestFire?.errorMessage ?? schedule.latestFire?.state ?? null,
        lastExecutionId: schedule.latestFire?.executionId ?? null,
      })),
      scheduleLoadState,
      runningMonitorEntries,
      nonRunningMonitorEntries,
      characterEntries,
      characterListFeedback,
      monitorWindowIcon: renderHomeMonitorWindowIcon(),
      handlers: {
        onChangeRightPaneView: setRightPaneView,
        onOpenSessionMonitorWindow: () => void openSessionMonitorWindow(),
        onOpenSettingsWindow: () => void openSettingsWindow(),
        onCreateCharacter: () => void openCharacterEditorWindow(),
        onEditCharacter: (characterId) => void openCharacterEditorWindow(characterId),
        onOpenSession: (sessionId) => void openSessionWindow(sessionId),
        onOpenCompanionReview: (sessionId) => void openCompanionReviewWindow(sessionId),
      },
      canUsePrimaryFeatures,
    }),
    launchDialog: buildHomeLaunchDialogProps({
      draft: launchDraft,
      projection: launchProjection,
      canUsePrimaryFeatures,
      launchFeedback,
      launchStarting,
      onClose: homeLaunchHandlers.onCloseLaunchDialog,
      onChangeTitle: homeLaunchHandlers.onChangeTitle,
      onChangeWorkspacePath: homeLaunchHandlers.onChangeWorkspacePath,
      onBrowseWorkspace: () => void homeLaunchHandlers.onBrowseWorkspace(),
      onSelectSessionFolder: homeLaunchHandlers.onSelectSessionFolder,
      onSelectProvider: homeLaunchHandlers.onSelectLaunchProvider,
      onSelectCharacter: homeLaunchHandlers.onSelectLaunchCharacter,
      onSelectRandomCharacter: homeLaunchHandlers.onSelectRandomLaunchCharacter,
      onStartSession: () => void homeLaunchHandlers.onStartSession("session"),
    }),
  });

  return (
    <HomeAppRouter
      desktopRuntime={desktopRuntime}
      homePageClassName={homePageClassName}
      isSettingsWindowMode={isSettingsWindowMode}
      isMemoryReviewWindowMode={isMemoryReviewWindowMode}
      getMemoryReviewApi={getWithMateApi}
      settingsWindowReady={settingsWindowReady}
      settingsContent={settingsContent}
      isMateStateLoading={isMateStateLoading}
      mateProfileEditorOpen={mateProfileEditorOpen}
      mateSetupContent={mateSetupContent}
      isMonitorWindowMode={isMonitorWindowMode}
      monitorContent={monitorContent}
      recentSessionsPanel={recentSessionsPanel}
      rightPane={rightPane}
      launchDialog={launchDialog}
    />
  );
}
