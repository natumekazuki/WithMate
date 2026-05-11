import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createDefaultAppSettings,
  getProviderAppSettings,
  type AppSettings,
} from "./provider-settings-state.js";
import { type SessionSummary } from "./session-state.js";
import { type ModelCatalogSnapshot } from "./model-catalog.js";
import {
  DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS,
  type MemoryManagementViewFilters,
} from "./memory/memory-management-view.js";
import {
  buildMemoryManagementPageRequest,
  type MemoryManagementDomain,
  type MemoryManagementSnapshot,
} from "./memory/memory-management-state.js";
import {
  buildHomeLaunchProjection,
} from "./home/home-launch-projection.js";
import {
  closeLaunchDraft,
  createClosedLaunchDraft,
  openLaunchDraft,
  setLaunchWorkspaceFromPath,
  updateLaunchDraftForProviderSelection,
  type HomeLaunchDraft,
} from "./home/home-launch-state.js";
import { type CompanionSessionSummary } from "./companion-state.js";
import { startHomeLaunch } from "./home/home-launch-actions.js";
import {
  clearHomeMateAvatar,
  saveHomeMateProfile,
  selectHomeMateAvatar,
} from "./home/home-mate-profile-actions.js";
import {
  buildHomeSessionProjection,
} from "./home/home-session-projection.js";
import {
  buildHomeProviderSettingRows,
  buildPersistedAppSettingsFromRows,
  type HomeProviderInstructionTargetSettings,
  type HomeProviderSettingRow,
} from "./settings/settings-view-model.js";
import { HomeAppRouter } from "./home/HomeAppRouter.js";
import { buildHomeDashboardSlots } from "./home/HomeDashboardSlots.js";
import { buildHomeWindowContentSlots } from "./home/HomeWindowContentSlots.js";
import { getHomeWindowMode } from "./home/home-window-mode.js";
import {
  openCompanionReviewWindow,
  openMateTalkWindow,
  openMemoryManagementWindow,
  openSessionMonitorWindow,
  openSessionWindow,
  openSettingsWindow,
} from "./home/home-launch-commands.js";
import {
  exportHomeModelCatalog,
  importHomeModelCatalog,
  syncProviderInstructionTargetRoots,
  saveHomeSettings,
} from "./settings/settings-actions.js";
import {
  EMPTY_MEMORY_MANAGEMENT_PAGE_STATE,
  normalizeMemoryManagementPages,
  type MemoryManagementPageState,
} from "./memory/memory-management-page-state.js";
import { buildResetMateConfirmMessage } from "./settings/settings-ui.js";
import {
  normalizeProviderInstructionTarget,
  type HomeProviderInstructionTargetDraft,
} from "./settings/provider-instruction-target-draft.js";
import {
  buildHomeMemoryManagementContentProps,
  buildHomeSettingsContentProps,
  type HomeSettingsContentBaseProps,
} from "./settings/home-settings-content-props.js";
import {
  handleBrowseProviderInstructionInstructionRelativePath as handleBrowseProviderInstructionInstructionRelativePathAction,
  handleChangeProviderInstructionEnabled as handleChangeProviderInstructionEnabledAction,
  handleChangeProviderInstructionFailPolicy as handleChangeProviderInstructionFailPolicyAction,
  handleChangeProviderInstructionInstructionRelativePath as handleChangeProviderInstructionInstructionRelativePathAction,
  handleChangeProviderInstructionWriteMode as handleChangeProviderInstructionWriteModeAction,
  updateProviderInstructionTarget as updateProviderInstructionTargetAction,
  upsertProviderInstructionTarget as upsertProviderInstructionTargetAction,
} from "./settings/provider-instruction-target-actions.js";
import {
  handleChangeAutoCollapseActionDockOnSend as handleChangeAutoCollapseActionDockOnSendAction,
  handleChangeCharacterReflectionCharDeltaThreshold as handleChangeCharacterReflectionCharDeltaThresholdAction,
  handleChangeCharacterReflectionCooldownSeconds as handleChangeCharacterReflectionCooldownSecondsAction,
  handleChangeCharacterReflectionMessageDeltaThreshold as handleChangeCharacterReflectionMessageDeltaThresholdAction,
  handleChangeCharacterReflectionModel as handleChangeCharacterReflectionModelAction,
  handleChangeCharacterReflectionReasoningEffort as handleChangeCharacterReflectionReasoningEffortAction,
  handleChangeCharacterReflectionTimeoutSeconds as handleChangeCharacterReflectionTimeoutSecondsAction,
  handleChangeMateMemoryGenerationPriorityModel as handleChangeMateMemoryGenerationPriorityModelAction,
  handleChangeMateMemoryGenerationPriorityProvider as handleChangeMateMemoryGenerationPriorityProviderAction,
  handleChangeMateMemoryGenerationPriorityReasoningEffort as handleChangeMateMemoryGenerationPriorityReasoningEffortAction,
  handleChangeMateMemoryGenerationPriorityTimeoutSeconds as handleChangeMateMemoryGenerationPriorityTimeoutSecondsAction,
  handleChangeMateMemoryGenerationTriggerIntervalMinutes as handleChangeMateMemoryGenerationTriggerIntervalMinutesAction,
  handleChangeMemoryGenerationEnabled as handleChangeMemoryGenerationEnabledAction,
  handleChangeMemoryExtractionModel as handleChangeMemoryExtractionModelAction,
  handleChangeMemoryExtractionReasoningEffort as handleChangeMemoryExtractionReasoningEffortAction,
  handleChangeMemoryExtractionThreshold as handleChangeMemoryExtractionThresholdAction,
  handleChangeMemoryExtractionTimeoutSeconds as handleChangeMemoryExtractionTimeoutSecondsAction,
  handleChangeProviderEnabled as handleChangeProviderEnabledAction,
  handleChangeProviderSkillRootPath as handleChangeProviderSkillRootPathAction,
  handleAddMateMemoryGenerationPriority as handleAddMateMemoryGenerationPriorityAction,
  handleRemoveMateMemoryGenerationPriority as handleRemoveMateMemoryGenerationPriorityAction,
} from "./settings/settings-draft-actions.js";
import { getWithMateApi, isDesktopRuntime, withWithMateApi } from "./renderer-withmate-api.js";
import {
  type MateGrowthSettings,
  type MateProfile,
  type MateStorageState,
  type UpdateMateGrowthSettingsInput,
} from "./mate/mate-state.js";
import { type MateEmbeddingSettings } from "./mate/mate-embedding-settings.js";
import type { MateGrowthEventListItem } from "./mate/mate-growth-events-state.js";
import {
  handleApplyPendingGrowth as handleApplyPendingGrowthAction,
  handleBeginCorrectMateGrowthEvent as handleBeginCorrectMateGrowthEventAction,
  handleCancelCorrectMateGrowthEvent as handleCancelCorrectMateGrowthEventAction,
  handleCorrectMateGrowthEvent as handleCorrectMateGrowthEventAction,
  handleDisableMateGrowthEvent as handleDisableMateGrowthEventAction,
  handleForgetMateGrowthEvent as handleForgetMateGrowthEventAction,
  handleReloadMateGrowthEvents as handleReloadMateGrowthEventsAction,
  handleUpdateMateGrowthSettings as handleUpdateMateGrowthSettingsAction,
  upsertMateGrowthEventListItem as upsertMateGrowthEventListItemAction,
} from "./mate/mate-growth-actions.js";
import {
  handleChangeMemoryManagementViewFilters as handleChangeMemoryManagementViewFiltersAction,
  handleDeleteCharacterMemoryEntry as handleDeleteCharacterMemoryEntryAction,
  handleDeleteMateProfileItem as handleDeleteMateProfileItemAction,
  handleDeleteProjectMemoryEntry as handleDeleteProjectMemoryEntryAction,
  handleDeleteSessionMemory as handleDeleteSessionMemoryAction,
  handleLoadMoreMemoryManagement as handleLoadMoreMemoryManagementAction,
  handleReloadMemoryManagement as handleReloadMemoryManagementAction,
  handleStartMateEmbeddingDownload as handleStartMateEmbeddingDownloadAction,
  MEMORY_MANAGEMENT_PAGE_LIMIT,
} from "./memory/memory-management-actions.js";

type HomeRightPaneView = "monitor" | "mate";

const MATE_EMBEDDING_SETTINGS_POLL_INTERVAL_MS = 2000;

export default function HomeApp() {
  const desktopRuntime = isDesktopRuntime();
  const homeWindowMode = useMemo(() => getHomeWindowMode(), []);
  const isMonitorWindowMode = homeWindowMode === "monitor";
  const isSettingsWindowMode = homeWindowMode === "settings";
  const isMemoryWindowMode = homeWindowMode === "memory";
  const usesMemoryManagementWindow = isSettingsWindowMode || isMemoryWindowMode;
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [companionSessions, setCompanionSessions] = useState<CompanionSessionSummary[]>([]);
  const [openSessionWindowIds, setOpenSessionWindowIds] = useState<string[]>([]);
  const [openCompanionReviewWindowIds, setOpenCompanionReviewWindowIds] = useState<string[]>([]);
  const [sessionSearchText, setSessionSearchText] = useState("");
  const [rightPaneView, setRightPaneView] = useState<HomeRightPaneView>("monitor");
  const [settingsFeedback, setSettingsFeedback] = useState("");
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(createDefaultAppSettings());
  const [mateEmbeddingSettings, setMateEmbeddingSettings] = useState<MateEmbeddingSettings | null>(null);
  const [mateEmbeddingFeedback, setMateEmbeddingFeedback] = useState("");
  const [mateEmbeddingBusy, setMateEmbeddingBusy] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [settingsDraftLoaded, setSettingsDraftLoaded] = useState(!isSettingsWindowMode);
  const [modelCatalogLoaded, setModelCatalogLoaded] = useState(!isSettingsWindowMode);
  const [memoryManagementSnapshot, setMemoryManagementSnapshot] = useState<MemoryManagementSnapshot | null>(null);
  const [memoryManagementPages, setMemoryManagementPages] =
    useState<MemoryManagementPageState>(EMPTY_MEMORY_MANAGEMENT_PAGE_STATE);
  const [memoryManagementFilters, setMemoryManagementFilters] =
    useState<MemoryManagementViewFilters>(DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS);
  const [memoryManagementLoaded, setMemoryManagementLoaded] = useState(!usesMemoryManagementWindow);
  const [memoryManagementBusyTarget, setMemoryManagementBusyTarget] = useState<string | null>(null);
  const [memoryManagementFeedback, setMemoryManagementFeedback] = useState("");
  const [providerInstructionTargets, setProviderInstructionTargets] = useState<HomeProviderInstructionTargetDraft[]>([]);
  const [providerInstructionTargetsLoaded, setProviderInstructionTargetsLoaded] = useState(!isSettingsWindowMode);
  const [launchDraft, setLaunchDraft] = useState<HomeLaunchDraft>(() => createClosedLaunchDraft());
  const [launchFeedback, setLaunchFeedback] = useState("");
  const [launchStarting, setLaunchStarting] = useState(false);
  const [mateState, setMateState] = useState<MateStorageState | null>(null);
  const [mateProfile, setMateProfile] = useState<MateProfile | null>(null);
  const [mateDisplayName, setMateDisplayName] = useState("");
  const [mateGrowthSettings, setMateGrowthSettings] = useState<MateGrowthSettings | null>(null);
  const [mateGrowthFeedback, setMateGrowthFeedback] = useState("");
  const [mateGrowthBusy, setMateGrowthBusy] = useState(false);
  const [mateGrowthEvents, setMateGrowthEvents] = useState<MateGrowthEventListItem[]>([]);
  const [mateGrowthEventsLoading, setMateGrowthEventsLoading] = useState(false);
  const [mateGrowthEventsFeedback, setMateGrowthEventsFeedback] = useState("");
  const [mateGrowthEventBusyTarget, setMateGrowthEventBusyTarget] = useState<string | null>(null);
  const [correctingMateGrowthEventId, setCorrectingMateGrowthEventId] = useState<string | null>(null);
  const [correctingMateGrowthEventStatement, setCorrectingMateGrowthEventStatement] = useState("");
  const [mateCreating, setMateCreating] = useState(false);
  const [mateAvatarUpdating, setMateAvatarUpdating] = useState(false);
  const [mateGrowthApplying, setMateGrowthApplying] = useState(false);
  const [mateResetting, setMateResetting] = useState(false);
  const [mateCreationFeedback, setMateCreationFeedback] = useState("");
  const [mateProfileEditorOpen, setMateProfileEditorOpen] = useState(false);
  const settingsDirtyRef = useRef(false);
  const settingsHydratedRef = useRef(!isSettingsWindowMode);
  const memoryManagementRequestIdRef = useRef(0);
  const mateEmbeddingSettingsPollingIntervalRef = useRef<number | null>(null);

  const beginMemoryManagementRequest = () => {
    memoryManagementRequestIdRef.current += 1;
    return memoryManagementRequestIdRef.current;
  };

  const isLatestMemoryManagementRequest = (requestId: number) =>
    memoryManagementRequestIdRef.current === requestId;

  const stopMateEmbeddingSettingsPolling = () => {
    if (mateEmbeddingSettingsPollingIntervalRef.current === null) {
      return;
    }

    window.clearInterval(mateEmbeddingSettingsPollingIntervalRef.current);
    mateEmbeddingSettingsPollingIntervalRef.current = null;
  };

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

  const refreshMateStatus = async (
    withmateApi: NonNullable<ReturnType<typeof getWithMateApi>>,
    options?: { isActive?: () => boolean },
  ): Promise<MateStorageState> => {
    const isActive = options?.isActive ?? (() => true);
    const nextMateState = await withmateApi.getMateState();
    if (!isActive()) {
      return nextMateState;
    }

    if (nextMateState === "not_created") {
      setMateState("not_created");
      setMateProfile(null);
      setMateDisplayName("");
      setMateEmbeddingSettings(null);
      setMateEmbeddingFeedback("");
      setMateEmbeddingBusy(false);
      setMateGrowthSettings(null);
      setMateGrowthFeedback("");
      setMateGrowthBusy(false);
      setMateGrowthEvents([]);
      setMateGrowthEventsFeedback("");
      setMateGrowthEventsLoading(false);
      setMateGrowthEventBusyTarget(null);
      setCorrectingMateGrowthEventId(null);
      setCorrectingMateGrowthEventStatement("");
      setMateAvatarUpdating(false);
      stopMateEmbeddingSettingsPolling();
      return nextMateState;
    }

    setMateState(nextMateState);
    if (!isActive()) {
      return nextMateState;
    }
    const nextMateProfile = await withmateApi.getMateProfile();
    if (!isActive()) {
      return nextMateState;
    }
    setMateProfile(nextMateProfile);
    setMateDisplayName(nextMateProfile?.displayName ?? "");
    return nextMateState;
  };

  const refreshMateGrowthEvents = async (
    withmateApi: NonNullable<ReturnType<typeof getWithMateApi>>,
    options?: { isActive?: () => boolean; silent?: boolean },
  ): Promise<void> => {
    const isActive = options?.isActive ?? (() => true);
    if (!options?.silent) {
      setMateGrowthEventsLoading(true);
      setMateGrowthEventsFeedback("");
    }

    try {
      const result = await withmateApi.listMateGrowthEvents({ limit: 20 });
      if (!isActive()) {
        return;
      }
      setMateGrowthEvents(result.events);
      if (!options?.silent) {
        setMateGrowthEventsFeedback("Growth Event を更新したよ。");
      }
    } catch (error) {
      if (!isActive()) {
        return;
      }
      setMateGrowthEventsFeedback(error instanceof Error ? error.message : "Growth Event の取得に失敗したよ。");
    } finally {
      if (isActive()) {
        setMateGrowthEventsLoading(false);
      }
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

    let unsubscribeSessions: (() => void) | null = null;
    let unsubscribeCompanionSessions: (() => void) | null = null;

    const hydrateOperationalHomeData = async () => {
      const [nextSessions, nextCompanionSessions] = await Promise.all([
        withmateApi.listSessionSummaries(),
        withmateApi.listCompanionSessionSummaries(),
      ]);
      if (!active) {
        return;
      }

      setSessions(nextSessions);
      setCompanionSessions(nextCompanionSessions);

      if (usesMemoryManagementWindow) {
        try {
          const page = await withmateApi.getMemoryManagementPage(buildMemoryManagementPageRequest(memoryManagementFilters, {
            limit: MEMORY_MANAGEMENT_PAGE_LIMIT,
          }));
          if (!active) {
            return;
          }

          setMemoryManagementSnapshot(page.snapshot);
          setMemoryManagementPages(normalizeMemoryManagementPages(page.pages));
          setMemoryManagementLoaded(true);
        } catch (error) {
          if (!active) {
            return;
          }

          setMemoryManagementFeedback(error instanceof Error ? error.message : "Memory 一覧の読み込みに失敗したよ。");
          setMemoryManagementLoaded(true);
        }
      }

      unsubscribeSessions = withmateApi.subscribeSessionSummaries((nextSessions) => {
        if (active) {
          setSessions(nextSessions);
        }
      });
      unsubscribeCompanionSessions = withmateApi.subscribeCompanionSessionSummaries((nextSessions) => {
        if (active) {
          setCompanionSessions(nextSessions);
        }
      });

    };

    void Promise.all([
      refreshMateStatus(withmateApi, { isActive: () => active }),
      Promise.all([
        withmateApi.getAppSettings(),
        withmateApi.getModelCatalog(null),
        withmateApi.getMateEmbeddingSettings(),
        withmateApi.getMateGrowthSettings(),
      ]),
    ]).then(([nextMateState, [settings, snapshot, embeddingSettings, growthSettings]]) => {
      if (!active) {
        return;
      }

      applyIncomingAppSettings(settings, { force: isSettingsWindowMode });
      setModelCatalog(snapshot);
      setMateEmbeddingSettings(embeddingSettings);
      setModelCatalogLoaded(true);
      if (nextMateState === "not_created") {
        setMateGrowthSettings(null);
        setMateGrowthFeedback("");
        setMateGrowthEvents([]);
        setMateGrowthEventsFeedback("");
        setCorrectingMateGrowthEventId(null);
        setCorrectingMateGrowthEventStatement("");
      } else {
        setMateGrowthSettings(growthSettings);
        void refreshMateGrowthEvents(withmateApi, { isActive: () => active, silent: true });
      }

      if (nextMateState !== "not_created") {
        void hydrateOperationalHomeData().catch((error) => {
          if (!active) {
            return;
          }

          setLaunchFeedback(error instanceof Error ? error.message : "Home の読み込みに失敗したよ。");
        });
      }
    }).catch((error) => {
      if (!active) {
        return;
      }

      setMateState("not_created");
      setMateProfile(null);
      setMateGrowthSettings(null);
      setMateGrowthFeedback("");
      setMateGrowthEvents([]);
      setMateGrowthEventsFeedback("");
      setCorrectingMateGrowthEventId(null);
      setCorrectingMateGrowthEventStatement("");
      setMateCreationFeedback(error instanceof Error ? error.message : "Mate 状態の取得に失敗したよ。");
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
      unsubscribeSessions?.();
      unsubscribeCompanionSessions?.();
      unsubscribeModelCatalog();
      unsubscribeAppSettings();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();

    if (!withmateApi) {
      setProviderInstructionTargetsLoaded(true);
      return () => {
        active = false;
      };
    }

    void withmateApi.listProviderInstructionTargets().then((nextTargets) => {
      if (!active) {
        return;
      }

      setProviderInstructionTargets(nextTargets.map((target) => normalizeProviderInstructionTarget(target)));
      setProviderInstructionTargetsLoaded(true);
    }).catch((error) => {
      if (!active) {
        return;
      }
      setSettingsFeedback(error instanceof Error ? error.message : "Provider Instruction Sync の一覧取得に失敗したよ。");
      setProviderInstructionTargetsLoaded(true);
    });

    return () => {
      active = false;
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

  useEffect(() => {
    let active = true;

    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      return () => {
        active = false;
      };
    }

    const unsubscribeOpenCompanionReviewWindowIds = withmateApi.subscribeOpenCompanionReviewWindowIds((nextSessionIds) => {
      if (active) {
        setOpenCompanionReviewWindowIds(nextSessionIds);
      }
    });

    void withmateApi.listOpenCompanionReviewWindowIds().then((nextSessionIds) => {
      if (active) {
        setOpenCompanionReviewWindowIds(nextSessionIds);
      }
    });

    return () => {
      active = false;
      unsubscribeOpenCompanionReviewWindowIds();
    };
  }, []);

  useEffect(() => {
    const withmateApi = getWithMateApi();
    if (!withmateApi || mateEmbeddingSettings?.cacheState !== "downloading") {
      stopMateEmbeddingSettingsPolling();
      return;
    }

    let active = true;
    const refreshMateEmbeddingSettings = async () => {
      try {
        const nextMateEmbeddingSettings = await withmateApi.getMateEmbeddingSettings();
        if (!active) {
          return;
        }

        setMateEmbeddingSettings(nextMateEmbeddingSettings);
        if (!nextMateEmbeddingSettings) {
          stopMateEmbeddingSettingsPolling();
          return;
        }

        if (nextMateEmbeddingSettings.cacheState !== "downloading") {
          stopMateEmbeddingSettingsPolling();
        }
      } catch (error) {
        if (!active) {
          return;
        }

        setMateEmbeddingFeedback(
          error instanceof Error ? error.message : "Mate Embedding の状態取得に失敗したよ。",
        );
        stopMateEmbeddingSettingsPolling();
      }
    };

    void refreshMateEmbeddingSettings();
    stopMateEmbeddingSettingsPolling();
    mateEmbeddingSettingsPollingIntervalRef.current = window.setInterval(
      () => {
        void refreshMateEmbeddingSettings();
      },
      MATE_EMBEDDING_SETTINGS_POLL_INTERVAL_MS,
    );

    return () => {
      active = false;
      stopMateEmbeddingSettingsPolling();
    };
  }, [mateEmbeddingSettings?.cacheState]);

  const sessionProjection = useMemo(
    () => buildHomeSessionProjection(
      sessions,
      openSessionWindowIds,
      sessionSearchText,
      companionSessions,
      openCompanionReviewWindowIds,
    ),
    [companionSessions, openCompanionReviewWindowIds, openSessionWindowIds, sessionSearchText, sessions],
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
      launchProviderId: launchDraft.providerId,
      launchTitle: launchDraft.title,
      launchWorkspace: launchDraft.workspace,
      appSettings,
      modelCatalog,
    }),
    [appSettings, launchDraft, modelCatalog],
  );
  const { enabledLaunchProviders, selectedLaunchProvider, launchWorkspacePathLabel, canStartSession } = launchProjection;

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

    setLaunchFeedback("");
    setLaunchDraft((current) => setLaunchWorkspaceFromPath(current, selectedPath));
  };

  const openLaunchDialog = () => {
    if (mateState === "not_created") {
      setLaunchFeedback("Mate を作成してから開始してね。");
      return;
    }
    setLaunchFeedback("");
    setLaunchDraft((current) => openLaunchDraft(current, enabledLaunchProviders[0]?.id ?? ""));
  };

  const closeLaunchDialog = () => {
    setLaunchFeedback("");
    setLaunchStarting(false);
    setLaunchDraft((current) => closeLaunchDraft(current));
  };

  const handleSelectLaunchProvider = (providerId: string) => {
    setLaunchFeedback("");
    setLaunchDraft((current) => updateLaunchDraftForProviderSelection(current, providerId, enabledLaunchProviders));
  };

  const handleSaveMate = async () => {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      setMateCreationFeedback("Mate API が利用できないよ。");
      return;
    }

    await saveHomeMateProfile({
      api: withmateApi,
      displayName: mateDisplayName,
      mateState,
      setMateState,
      setMateProfile,
      setMateDisplayName,
      setMateCreationFeedback,
      setMateProfileEditorOpen,
      setMateCreating,
      setLaunchFeedback,
      hydrateHomeData: async () => {
        const [nextSessions, nextCompanionSessions, nextEmbeddingSettings, nextGrowthSettings] = await Promise.all([
          withmateApi.listSessionSummaries(),
          withmateApi.listCompanionSessionSummaries(),
          withmateApi.getMateEmbeddingSettings(),
          withmateApi.getMateGrowthSettings(),
        ]);
        setSessions(nextSessions);
        setCompanionSessions(nextCompanionSessions);
        setMateEmbeddingSettings(nextEmbeddingSettings);
        setMateGrowthSettings(nextGrowthSettings);
        await refreshMateGrowthEvents(withmateApi, { silent: true });
      },
      clearMateGrowthViewState: () => {
        setMateGrowthSettings(null);
        setMateGrowthFeedback("");
        setMateGrowthEvents([]);
        setMateGrowthEventsFeedback("");
        setCorrectingMateGrowthEventId(null);
        setCorrectingMateGrowthEventStatement("");
      },
    });
  };

  const handleSelectMateAvatar = async () => {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      setMateCreationFeedback("Mate API が利用できないよ。");
      return;
    }

    await selectHomeMateAvatar({
      api: withmateApi,
      mateState,
      currentAvatarFilePath: mateProfile?.avatarFilePath ?? null,
      setMateProfile,
      setMateDisplayName,
      setMateCreationFeedback,
      setMateAvatarUpdating,
      setLaunchFeedback,
      refreshSessionSummaries: async () => {
        const [nextSessions, nextCompanionSessions] = await Promise.all([
          withmateApi.listSessionSummaries(),
          withmateApi.listCompanionSessionSummaries(),
        ]);
        setSessions(nextSessions);
        setCompanionSessions(nextCompanionSessions);
      },
    });
  };

  const handleClearMateAvatar = async () => {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      setMateCreationFeedback("Mate API が利用できないよ。");
      return;
    }

    await clearHomeMateAvatar({
      api: withmateApi,
      mateState,
      currentAvatarFilePath: mateProfile?.avatarFilePath ?? null,
      setMateProfile,
      setMateDisplayName,
      setMateCreationFeedback,
      setMateAvatarUpdating,
      setLaunchFeedback,
      refreshSessionSummaries: async () => {
        const [nextSessions, nextCompanionSessions] = await Promise.all([
          withmateApi.listSessionSummaries(),
          withmateApi.listCompanionSessionSummaries(),
        ]);
        setSessions(nextSessions);
        setCompanionSessions(nextCompanionSessions);
      },
    });
  };

  const openMateProfileEditor = () => {
    setMateDisplayName(mateProfile?.displayName ?? "");
    setMateCreationFeedback("");
    setMateProfileEditorOpen(true);
  };

  const handleStartSession = async (requestedMode: HomeLaunchDraft["mode"] = launchDraft.mode) => {
    await startHomeLaunch({
      draft: launchDraft,
      requestedMode,
      launchStarting,
      mateState,
      mateProfile,
      selectedProviderId: selectedLaunchProvider?.id ?? null,
      sessions,
      createSession: async (input) => await withWithMateApi((api) => api.createSession(input)),
      createCompanionSession: async (input) => await withWithMateApi((api) => api.createCompanionSession(input)),
      openSessionWindow,
      openCompanionReviewWindow,
      closeLaunchDialog,
      setLaunchFeedback,
      setLaunchStarting,
      upsertCompanionSessionSummary: (summary) => {
        setCompanionSessions((current) => [
          summary,
          ...current.filter((session) => session.id !== summary.id),
        ]);
      },
    });
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

  const handleSaveSettings = async () => {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      return;
    }

    try {
      const result = await saveHomeSettings(withmateApi, persistedSettingsDraft);
      const nextProviderInstructionTargets = await syncProviderInstructionTargetRoots({
        api: withmateApi,
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
  };

  const upsertMateGrowthEventListItem = (nextEvent: MateGrowthEventListItem | null) => {
    setMateGrowthEvents((current) => upsertMateGrowthEventListItemAction(current, nextEvent));
  };

  const handleApplyPendingGrowth = () => {
    void handleApplyPendingGrowthAction({
      api: getWithMateApi(),
      mateGrowthApplying,
      mateState,
      setMateGrowthApplying,
      setSettingsFeedback,
      refreshMateStatus,
      refreshMateGrowthEvents,
    });
  };

  const handleReloadMateGrowthEvents = () => {
    void handleReloadMateGrowthEventsAction({
      api: getWithMateApi(),
      mateState,
      setMateGrowthEventsFeedback,
      refreshMateGrowthEvents,
    });
  };

  const handleBeginCorrectMateGrowthEvent = (eventId: string, statement: string) => {
    handleBeginCorrectMateGrowthEventAction({
      eventId,
      statement,
      setCorrectingMateGrowthEventId,
      setCorrectingMateGrowthEventStatement,
    });
  };

  const handleCancelCorrectMateGrowthEvent = () => {
    handleCancelCorrectMateGrowthEventAction({
      setCorrectingMateGrowthEventId,
      setCorrectingMateGrowthEventStatement,
    });
  };

  const handleCorrectMateGrowthEvent = (eventId: string, statement: string) => {
    void handleCorrectMateGrowthEventAction({
      eventId,
      statement,
      api: getWithMateApi(),
      setMateGrowthEventsFeedback,
      upsertMateGrowthEventListItem,
      setMateGrowthEventBusyTarget,
      mateState,
      mateGrowthEventBusyTarget,
      runCorrectAction: (api) => api.correctMateGrowthEvent({ eventId, statement }),
      setCancelCorrectMateGrowthEvent: handleCancelCorrectMateGrowthEvent,
    });
  };

  const handleDisableMateGrowthEvent = (eventId: string) => {
    void handleDisableMateGrowthEventAction({
      eventId,
      api: getWithMateApi(),
      setMateGrowthEventsFeedback,
      upsertMateGrowthEventListItem,
      setMateGrowthEventBusyTarget,
      mateState,
      mateGrowthEventBusyTarget,
      runDisableAction: (api) => api.disableMateGrowthEvent({ eventId }),
    });
  };

  const handleForgetMateGrowthEvent = (eventId: string) => {
    void handleForgetMateGrowthEventAction({
      eventId,
      api: getWithMateApi(),
      setMateGrowthEventsFeedback,
      upsertMateGrowthEventListItem,
      setMateGrowthEventBusyTarget,
      mateState,
      mateGrowthEventBusyTarget,
      runForgetAction: (api) => api.forgetMateGrowthEvent({ eventId }),
    });
  };

  const handleUpdateMateGrowthSettings = (input: UpdateMateGrowthSettingsInput) => {
    void handleUpdateMateGrowthSettingsAction({
      api: getWithMateApi(),
      input,
      mateGrowthBusy,
      mateState,
      setMateGrowthBusy,
      setMateGrowthFeedback,
      setMateGrowthSettings,
    });
  };

  const handleResetMate = async () => {
    if (mateResetting) {
      return;
    }

    if (mateState === "not_created") {
      return;
    }

    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      setSettingsFeedback("Mate API が利用できないよ。");
      return;
    }

    const confirmed = window.confirm(buildResetMateConfirmMessage());
    if (!confirmed) {
      return;
    }

    setMateResetting(true);
    setSettingsFeedback("Mate を初期化中...");
    try {
      await withmateApi.resetMate();
      await refreshMateStatus(withmateApi);
      setSettingsFeedback("Mate を初期化したよ。");
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : "Mate の初期化に失敗したよ。");
    } finally {
      setMateResetting(false);
    }
  };

  const upsertProviderInstructionTarget = (target: HomeProviderInstructionTargetDraft): void => {
    const withmateApi = getWithMateApi();
    void upsertProviderInstructionTargetAction({
      target,
      api: withmateApi,
      setSettingsFeedback,
    });
  };

  const updateProviderInstructionTarget = (
    providerId: string,
    patch: Partial<HomeProviderInstructionTargetDraft>,
  ) => {
    const withmateApi = getWithMateApi();
    updateProviderInstructionTargetAction({
      providerId,
      patch,
      providerInstructionTargets,
      settingsDraft,
      setProviderInstructionTargets,
      setSettingsFeedback,
      api: withmateApi,
    });
  };

  const handleChangeProviderInstructionEnabled = (providerId: string, enabled: boolean) => {
    handleChangeProviderInstructionEnabledAction({
      providerId,
      enabled,
      providerInstructionTargets,
      settingsDraft,
      setProviderInstructionTargets,
      setSettingsFeedback,
      api: getWithMateApi(),
    });
  };

  const handleChangeProviderInstructionWriteMode = (providerId: string, writeMode: string) => {
    handleChangeProviderInstructionWriteModeAction({
      providerId,
      writeMode,
      providerInstructionTargets,
      settingsDraft,
      setProviderInstructionTargets,
      setSettingsFeedback,
      api: getWithMateApi(),
    });
  };

  const handleChangeProviderInstructionFailPolicy = (providerId: string, failPolicy: string) => {
    handleChangeProviderInstructionFailPolicyAction({
      providerId,
      failPolicy,
      providerInstructionTargets,
      settingsDraft,
      setProviderInstructionTargets,
      setSettingsFeedback,
      api: getWithMateApi(),
    });
  };

  const handleChangeProviderInstructionInstructionRelativePath = (providerId: string, instructionRelativePath: string) => {
    handleChangeProviderInstructionInstructionRelativePathAction({
      providerId,
      instructionRelativePath,
      providerInstructionTargets,
      settingsDraft,
      setProviderInstructionTargets,
      setSettingsFeedback,
      api: getWithMateApi(),
    });
  };

  const handleBrowseProviderInstructionInstructionRelativePath = async (providerId: string) => {
    const withmateApi = getWithMateApi();
    await handleBrowseProviderInstructionInstructionRelativePathAction({
      providerId,
      providerInstructionTargets,
      settingsDraft,
      setProviderInstructionTargets,
      setSettingsFeedback,
      api: withmateApi,
    });
  };

  const handleChangeProviderEnabled = (providerId: string, enabled: boolean) => {
    handleChangeProviderEnabledAction({
      providerId,
      enabled,
      setSettingsDraft,
    });
  };

  const handleChangeProviderSkillRootPath = (providerId: string, skillRootPath: string) => {
    handleChangeProviderSkillRootPathAction({
      providerId,
      skillRootPath,
      setSettingsDraft,
    });
  };

  const handleChangeMemoryGenerationEnabled = (enabled: boolean) => {
    handleChangeMemoryGenerationEnabledAction({
      enabled,
      setSettingsDraft,
    });
  };

  const handleChangeAutoCollapseActionDockOnSend = (enabled: boolean) => {
    handleChangeAutoCollapseActionDockOnSendAction({
      enabled,
      setSettingsDraft,
    });
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
    handleChangeMemoryExtractionModelAction({
      providerId,
      model,
      modelCatalog,
      setSettingsDraft,
    });
  };

  const handleChangeMemoryExtractionReasoningEffort = (
    providerId: string,
    reasoningEffort: AppSettings["memoryExtractionProviderSettings"][string]["reasoningEffort"],
  ) => {
    handleChangeMemoryExtractionReasoningEffortAction({
      providerId,
      reasoningEffort,
      setSettingsDraft,
    });
  };

  const handleChangeMemoryExtractionThreshold = (providerId: string, value: string) => {
    handleChangeMemoryExtractionThresholdAction({
      providerId,
      value,
      setSettingsDraft,
    });
  };

  const handleChangeMemoryExtractionTimeoutSeconds = (providerId: string, value: string) => {
    handleChangeMemoryExtractionTimeoutSecondsAction({
      providerId,
      value,
      setSettingsDraft,
    });
  };

  const handleChangeCharacterReflectionModel = (providerId: string, model: string) => {
    handleChangeCharacterReflectionModelAction({
      providerId,
      model,
      modelCatalog,
      setSettingsDraft,
    });
  };

  const handleChangeCharacterReflectionReasoningEffort = (
    providerId: string,
    reasoningEffort: AppSettings["characterReflectionProviderSettings"][string]["reasoningEffort"],
  ) => {
    handleChangeCharacterReflectionReasoningEffortAction({
      providerId,
      reasoningEffort,
      setSettingsDraft,
    });
  };

  const handleChangeCharacterReflectionTimeoutSeconds = (providerId: string, value: string) => {
    handleChangeCharacterReflectionTimeoutSecondsAction({
      providerId,
      value,
      setSettingsDraft,
    });
  };

  const handleChangeCharacterReflectionCooldownSeconds = (value: string) => {
    handleChangeCharacterReflectionCooldownSecondsAction({
      value,
      setSettingsDraft,
    });
  };

  const handleChangeCharacterReflectionCharDeltaThreshold = (value: string) => {
    handleChangeCharacterReflectionCharDeltaThresholdAction({
      value,
      setSettingsDraft,
    });
  };

  const handleChangeCharacterReflectionMessageDeltaThreshold = (value: string) => {
    handleChangeCharacterReflectionMessageDeltaThresholdAction({
      value,
      setSettingsDraft,
    });
  };

  const handleChangeMateMemoryGenerationPriorityProvider = (index: number, providerId: string) => {
    handleChangeMateMemoryGenerationPriorityProviderAction({
      index,
      providerId,
      setSettingsDraft,
    });
  };

  const handleChangeMateMemoryGenerationPriorityModel = (index: number, providerId: string, model: string) => {
    handleChangeMateMemoryGenerationPriorityModelAction({
      index,
      providerId,
      model,
      modelCatalog,
      setSettingsDraft,
    });
  };

  const handleChangeMateMemoryGenerationPriorityReasoningEffort = (
    index: number,
    reasoningEffort: AppSettings["mateMemoryGenerationSettings"]["priorityList"][number]["reasoningEffort"],
  ) => {
    handleChangeMateMemoryGenerationPriorityReasoningEffortAction({
      index,
      reasoningEffort,
      setSettingsDraft,
    });
  };

  const handleChangeMateMemoryGenerationPriorityTimeoutSeconds = (index: number, value: string) => {
    handleChangeMateMemoryGenerationPriorityTimeoutSecondsAction({
      index,
      value,
      setSettingsDraft,
    });
  };

  const handleAddMateMemoryGenerationPriority = () => {
    handleAddMateMemoryGenerationPriorityAction({
      modelCatalog,
      setSettingsDraft,
    });
  };

  const handleRemoveMateMemoryGenerationPriority = (index: number) => {
    handleRemoveMateMemoryGenerationPriorityAction({
      index,
      setSettingsDraft,
    });
  };

  const handleChangeMateMemoryGenerationTriggerIntervalMinutes = (value: string) => {
    handleChangeMateMemoryGenerationTriggerIntervalMinutesAction({
      value,
      setSettingsDraft,
    });
  };

  const handleReloadMemoryManagement = () => {
    void handleReloadMemoryManagementAction({
      api: getWithMateApi(),
      usesMemoryManagementWindow,
      memoryManagementFilters,
      beginMemoryManagementRequest,
      isLatestMemoryManagementRequest,
      setMemoryManagementLoaded,
      setMemoryManagementSnapshot,
      setMemoryManagementPages,
      setMemoryManagementFeedback,
    });
  };

  const handleLoadMoreMemoryManagement = (domain: MemoryManagementDomain) => {
    void handleLoadMoreMemoryManagementAction({
      api: getWithMateApi(),
      usesMemoryManagementWindow,
      memoryManagementFilters,
      memoryManagementPages,
      beginMemoryManagementRequest,
      isLatestMemoryManagementRequest,
      setMemoryManagementLoaded,
      setMemoryManagementSnapshot,
      setMemoryManagementPages,
      setMemoryManagementFeedback,
      domain,
    });
  };

  const handleChangeMemoryManagementViewFilters = useCallback((filters: MemoryManagementViewFilters) => {
    void handleChangeMemoryManagementViewFiltersAction({
      api: getWithMateApi(),
      usesMemoryManagementWindow,
      filters,
      beginMemoryManagementRequest,
      isLatestMemoryManagementRequest,
      setMemoryManagementLoaded,
      setMemoryManagementSnapshot,
      setMemoryManagementPages,
      setMemoryManagementFeedback,
      setMemoryManagementFilters,
    });
  }, [usesMemoryManagementWindow]);

  const handleDeleteSessionMemory = async (sessionId: string) => {
    await handleDeleteSessionMemoryAction({
      api: getWithMateApi(),
      usesMemoryManagementWindow,
      memoryManagementFilters,
      memoryManagementPages,
      beginMemoryManagementRequest,
      isLatestMemoryManagementRequest,
      setMemoryManagementLoaded,
      setMemoryManagementSnapshot,
      setMemoryManagementPages,
      setMemoryManagementFeedback,
      setMemoryManagementBusyTarget,
      sessionId,
    });
  };

  const handleDeleteProjectMemoryEntry = async (entryId: string) => {
    await handleDeleteProjectMemoryEntryAction({
      api: getWithMateApi(),
      usesMemoryManagementWindow,
      memoryManagementFilters,
      memoryManagementPages,
      beginMemoryManagementRequest,
      isLatestMemoryManagementRequest,
      setMemoryManagementLoaded,
      setMemoryManagementSnapshot,
      setMemoryManagementPages,
      setMemoryManagementFeedback,
      setMemoryManagementBusyTarget,
      entryId,
    });
  };

  const handleDeleteCharacterMemoryEntry = async (entryId: string) => {
    await handleDeleteCharacterMemoryEntryAction({
      api: getWithMateApi(),
      usesMemoryManagementWindow,
      memoryManagementFilters,
      memoryManagementPages,
      beginMemoryManagementRequest,
      isLatestMemoryManagementRequest,
      setMemoryManagementLoaded,
      setMemoryManagementSnapshot,
      setMemoryManagementPages,
      setMemoryManagementFeedback,
      setMemoryManagementBusyTarget,
      entryId,
    });
  };

  const providerSettingRows = useMemo<HomeProviderSettingRow[]>(
    () => buildHomeProviderSettingRows(modelCatalog, settingsDraft, providerInstructionTargets),
    [
      modelCatalog,
      settingsDraft,
      providerInstructionTargets,
    ],
  );
  const persistedSettingsDraft = useMemo(
    () => buildPersistedAppSettingsFromRows(settingsDraft, providerSettingRows),
    [providerSettingRows, settingsDraft],
  );
  const settingsWindowReady =
    settingsDraftLoaded && modelCatalogLoaded && memoryManagementLoaded && providerInstructionTargetsLoaded;
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

  const handleOpenAppLogFolder = async () => {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      return;
    }

    try {
      await withmateApi.openAppLogFolder();
      setSettingsFeedback("ログフォルダを開いたよ。");
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : "ログフォルダを開けなかったよ。");
    }
  };

  const handleOpenCrashDumpFolder = async () => {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      return;
    }

    try {
      await withmateApi.openCrashDumpFolder();
      setSettingsFeedback("クラッシュダンプフォルダを開いたよ。");
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : "クラッシュダンプフォルダを開けなかったよ。");
    }
  };

  const handleDeleteMateProfileItem = async (itemId: string) => {
    await handleDeleteMateProfileItemAction({
      api: getWithMateApi(),
      usesMemoryManagementWindow,
      memoryManagementFilters,
      memoryManagementPages,
      beginMemoryManagementRequest,
      isLatestMemoryManagementRequest,
      setMemoryManagementLoaded,
      setMemoryManagementSnapshot,
      setMemoryManagementPages,
      setMemoryManagementFeedback,
      setMemoryManagementBusyTarget,
      itemId,
    });
  };

  const handleStartMateEmbeddingDownload = async () => {
    await handleStartMateEmbeddingDownloadAction({
      api: getWithMateApi(),
      setMateEmbeddingBusy,
      setMateEmbeddingFeedback,
      setMateEmbeddingSettings,
    });
  };

  const isMateStateLoading = mateState === null;
  const isMateNotCreated = mateState === "not_created";
  const canUsePrimaryFeatures = mateState !== "not_created" && mateProfile !== null;

  const baseSettingsContentProps: HomeSettingsContentBaseProps = {
    settingsDraft,
    providerSettingRows,
    modelCatalogRevisionLabel: String(modelCatalog?.revision ?? "-"),
    settingsDirty,
    settingsFeedback,
    memoryManagementSnapshot,
    memoryManagementPages,
    memoryManagementLoading: !memoryManagementLoaded,
    memoryManagementBusyTarget,
    memoryManagementFeedback,
    mateGrowthSettings,
    mateGrowthFeedback,
    mateGrowthBusy,
    mateGrowthEvents,
    mateGrowthEventsLoading,
    mateGrowthEventsFeedback,
    mateGrowthEventBusyTarget,
    correctingMateGrowthEventId,
    correctingMateGrowthEventStatement,
    mateEmbeddingSettings,
    mateEmbeddingFeedback,
    mateEmbeddingBusy,
    onChangeMemoryGenerationEnabled: handleChangeMemoryGenerationEnabled,
    onChangeMateMemoryGenerationPriorityProvider: handleChangeMateMemoryGenerationPriorityProvider,
    onChangeMateMemoryGenerationPriorityModel: handleChangeMateMemoryGenerationPriorityModel,
    onChangeMateMemoryGenerationPriorityReasoningEffort: handleChangeMateMemoryGenerationPriorityReasoningEffort,
    onChangeMateMemoryGenerationPriorityTimeoutSeconds: handleChangeMateMemoryGenerationPriorityTimeoutSeconds,
    onAddMateMemoryGenerationPriority: handleAddMateMemoryGenerationPriority,
    onRemoveMateMemoryGenerationPriority: handleRemoveMateMemoryGenerationPriority,
    onChangeMateMemoryGenerationTriggerIntervalMinutes: handleChangeMateMemoryGenerationTriggerIntervalMinutes,
    onChangeAutoCollapseActionDockOnSend: handleChangeAutoCollapseActionDockOnSend,
    onChangeProviderEnabled: handleChangeProviderEnabled,
    onChangeProviderInstructionEnabled: handleChangeProviderInstructionEnabled,
    onChangeProviderInstructionWriteMode: handleChangeProviderInstructionWriteMode,
    onChangeProviderInstructionFailPolicy: handleChangeProviderInstructionFailPolicy,
    onChangeProviderInstructionInstructionRelativePath: handleChangeProviderInstructionInstructionRelativePath,
    onBrowseProviderInstructionInstructionRelativePath: (providerId) =>
      void handleBrowseProviderInstructionInstructionRelativePath(providerId),
    onChangeProviderSkillRootPath: handleChangeProviderSkillRootPath,
    onBrowseProviderSkillRootPath: (providerId) => void handleBrowseProviderSkillRootPath(providerId),
    onChangeMemoryExtractionModel: handleChangeMemoryExtractionModel,
    onChangeMemoryExtractionReasoningEffort: handleChangeMemoryExtractionReasoningEffort,
    onChangeMemoryExtractionThreshold: handleChangeMemoryExtractionThreshold,
    onChangeMemoryExtractionTimeoutSeconds: handleChangeMemoryExtractionTimeoutSeconds,
    onChangeCharacterReflectionModel: handleChangeCharacterReflectionModel,
    onChangeCharacterReflectionReasoningEffort: handleChangeCharacterReflectionReasoningEffort,
    onChangeCharacterReflectionTimeoutSeconds: handleChangeCharacterReflectionTimeoutSeconds,
    onChangeCharacterReflectionCooldownSeconds: handleChangeCharacterReflectionCooldownSeconds,
    onChangeCharacterReflectionCharDeltaThreshold: handleChangeCharacterReflectionCharDeltaThreshold,
    onChangeCharacterReflectionMessageDeltaThreshold: handleChangeCharacterReflectionMessageDeltaThreshold,
    onImportModelCatalog: () => void handleImportModelCatalog(),
    onExportModelCatalog: () => void handleExportModelCatalog(),
    onOpenAppLogFolder: () => void handleOpenAppLogFolder(),
    onOpenCrashDumpFolder: () => void handleOpenCrashDumpFolder(),
    onReloadMemoryManagement: () => void handleReloadMemoryManagement(),
    onChangeMemoryManagementViewFilters: handleChangeMemoryManagementViewFilters,
    onLoadMoreMemoryManagement: (domain) => void handleLoadMoreMemoryManagement(domain),
    onDeleteSessionMemory: (sessionId) => void handleDeleteSessionMemory(sessionId),
    onDeleteProjectMemoryEntry: (entryId) => void handleDeleteProjectMemoryEntry(entryId),
    onDeleteCharacterMemoryEntry: (entryId) => void handleDeleteCharacterMemoryEntry(entryId),
    onDeleteMateProfileItem: (itemId) => void handleDeleteMateProfileItem(itemId),
    onStartMateEmbeddingDownload: () => void handleStartMateEmbeddingDownload(),
    onReloadMateGrowthEvents: () => void handleReloadMateGrowthEvents(),
    onBeginCorrectMateGrowthEvent: handleBeginCorrectMateGrowthEvent,
    onChangeCorrectMateGrowthEventStatement: setCorrectingMateGrowthEventStatement,
    onCancelCorrectMateGrowthEvent: handleCancelCorrectMateGrowthEvent,
    onCorrectMateGrowthEvent: (eventId, statement) => void handleCorrectMateGrowthEvent(eventId, statement),
    onDisableMateGrowthEvent: (eventId) => void handleDisableMateGrowthEvent(eventId),
    onForgetMateGrowthEvent: (eventId) => void handleForgetMateGrowthEvent(eventId),
    onUpdateMateGrowthSettings: (input) => void handleUpdateMateGrowthSettings(input),
    onSaveSettings: () => void handleSaveSettings(),
  };

  const { settingsContent, memoryManagementContent, mateSetupContent, monitorContent } = buildHomeWindowContentSlots({
    settingsContent: buildHomeSettingsContentProps({
      ...baseSettingsContentProps,
      onApplyPendingGrowth: () => void handleApplyPendingGrowth(),
      applyPendingGrowthBusy: mateGrowthApplying,
      canApplyPendingGrowth: mateState === "active",
      onResetMate: () => void handleResetMate(),
      mateResetBusy: mateResetting,
      canResetMate: mateState !== "not_created",
    }),
    memoryManagementContent: buildHomeMemoryManagementContentProps(baseSettingsContentProps),
    mateSetupContent: {
      mode: isMateNotCreated ? "create" : "edit",
      displayName: mateDisplayName,
      creating: mateCreating,
      feedback: mateCreationFeedback,
      onChangeDisplayName: (value) => {
        setMateDisplayName(value);
        setMateCreationFeedback("");
      },
      onSubmit: handleSaveMate,
      onOpenSettings: () => void openSettingsWindow(),
      onCancel: isMateNotCreated ? undefined : () => setMateProfileEditorOpen(false),
      mateDisplayName: mateProfile?.displayName ?? null,
      mateAvatarFilePath: mateProfile?.avatarFilePath ?? "",
      avatarUpdating: mateAvatarUpdating,
      onSelectAvatar: isMateNotCreated ? undefined : () => void handleSelectMateAvatar(),
      onClearAvatar: isMateNotCreated ? undefined : () => void handleClearMateAvatar(),
    },
    monitorContent: {
      runningEntries: runningMonitorEntries,
      nonRunningEntries: nonRunningMonitorEntries,
      runningEmptyMessage: monitorRunningEmptyMessage,
      completedEmptyMessage: monitorCompletedEmptyMessage,
      onOpenSession: (sessionId) => void openSessionWindow(sessionId),
      onOpenCompanionReview: (sessionId) => void openCompanionReviewWindow(sessionId),
    },
  });

  const { recentSessionsPanel, rightPane, launchDialog } = buildHomeDashboardSlots({
    recentSessionsPanel: {
      filteredSessionEntries,
      companionSessions,
      normalizedSessionSearch,
      searchText: sessionSearchText,
      searchIcon: renderSearchIcon(),
      onChangeSearchText: setSessionSearchText,
      onOpenLaunchDialog: openLaunchDialog,
      onOpenSession: (sessionId) => void openSessionWindow(sessionId),
      onOpenCompanionReview: (sessionId) => void openCompanionReviewWindow(sessionId),
      canUsePrimaryFeatures,
    },
    rightPane: {
      rightPaneView,
      runningMonitorEntries,
      nonRunningMonitorEntries,
      monitorRunningEmptyMessage,
      monitorCompletedEmptyMessage,
      mateProfile,
      monitorWindowIcon: renderMonitorWindowIcon(),
      onChangeRightPaneView: setRightPaneView,
      onOpenSessionMonitorWindow: () => void openSessionMonitorWindow(),
      onOpenMemoryManagementWindow: () => void openMemoryManagementWindow(),
      onOpenSettingsWindow: () => void openSettingsWindow(),
      onOpenMateProfile: openMateProfileEditor,
      onOpenMateTalk: () => void openMateTalkWindow(),
      onOpenSession: (sessionId) => void openSessionWindow(sessionId),
      onOpenCompanionReview: (sessionId) => void openCompanionReviewWindow(sessionId),
      canUsePrimaryFeatures,
    },
    launchDialog: {
      open: launchDraft.open,
      mode: launchDraft.mode,
      title: launchDraft.title,
      workspace: launchDraft.workspace,
      launchWorkspacePathLabel,
      enabledLaunchProviders,
      selectedLaunchProviderId: selectedLaunchProvider?.id ?? null,
      canStartSession: canStartSession && canUsePrimaryFeatures,
      launchFeedback,
      launchStarting,
      onClose: closeLaunchDialog,
      onSelectMode: (mode) => {
        setLaunchFeedback("");
        setLaunchDraft((current) => ({ ...current, mode }));
      },
      onChangeTitle: (value) => {
        setLaunchFeedback("");
        setLaunchDraft((current) => ({ ...current, title: value }));
      },
      onBrowseWorkspace: () => void handleBrowseWorkspace(),
      onSelectProvider: handleSelectLaunchProvider,
      onStartSession: (mode) => void handleStartSession(mode),
    },
  });

  return (
    <HomeAppRouter
      desktopRuntime={desktopRuntime}
      homePageClassName={homePageClassName}
      isSettingsWindowMode={isSettingsWindowMode}
      settingsWindowReady={settingsWindowReady}
      settingsContent={settingsContent}
      isMateStateLoading={isMateStateLoading}
      isMateNotCreated={isMateNotCreated}
      mateProfileEditorOpen={mateProfileEditorOpen}
      mateSetupContent={mateSetupContent}
      isMemoryWindowMode={isMemoryWindowMode}
      memoryManagementLoaded={memoryManagementLoaded}
      memoryManagementContent={memoryManagementContent}
      isMonitorWindowMode={isMonitorWindowMode}
      monitorContent={monitorContent}
      recentSessionsPanel={recentSessionsPanel}
      rightPane={rightPane}
      launchDialog={launchDialog}
    />
  );
}
