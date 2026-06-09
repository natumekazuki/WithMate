import { useEffect, useMemo, useRef, useState } from "react";

import {
  createDefaultAppSettings,
  type AppSettings,
} from "./provider-settings-state.js";
import { startAppSettingsSubscription } from "./app-settings-subscription.js";
import { type SessionSummary } from "./session-state.js";
import { type ModelCatalogSnapshot } from "./model-catalog.js";
import {
  DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS,
  type MemoryManagementViewFilters,
} from "./memory/memory-management-view.js";
import {
  buildMemoryManagementPageRequest,
  type MemoryManagementSnapshot,
} from "./memory/memory-management-state.js";
import {
  buildHomeLaunchProjection,
} from "./home/home-launch-projection.js";
import { buildHomeLaunchDialogProps } from "./home/home-launch-dialog-props.js";
import {
  createClosedLaunchDraft,
  type HomeLaunchDraft,
} from "./home/home-launch-state.js";
import { resolveSelectedLaunchProviderDraftId } from "./launch/launch-provider-selection.js";
import { type CompanionSessionSummary } from "./companion-state.js";
import { buildHomeMateProfileHandlers } from "./home/home-mate-profile-handlers.js";
import {
  buildHomeSessionProjection,
} from "./home/home-session-projection.js";
import { buildHomeLaunchHandlers } from "./home/home-launch-handlers.js";
import {
  buildHomeProviderSettingRows,
  buildPersistedAppSettingsFromRows,
  type HomeProviderInstructionTargetSettings,
  type HomeProviderSettingRow,
} from "./settings/settings-view-model.js";
import { HomeAppRouter } from "./home/HomeAppRouter.js";
import { buildHomeDashboardSlots } from "./home/HomeDashboardSlots.js";
import { buildHomeRecentSessionsPanelProps } from "./home/home-recent-sessions-panel-props.js";
import { buildHomeRightPaneProps } from "./home/home-right-pane-props.js";
import { buildHomeWindowContentSlots } from "./home/HomeWindowContentSlots.js";
import { getHomeWindowMode } from "./home/home-window-mode.js";
import { useHomeOpenWindowSubscriptions } from "./home/use-home-open-window-subscriptions.js";
import {
  openCompanionReviewWindow,
  openMateTalkWindow,
  openMemoryManagementWindow,
  openSessionMonitorWindow,
  openSessionWindow,
  openSettingsWindow,
} from "./home/home-launch-commands.js";
import {
  EMPTY_MEMORY_MANAGEMENT_PAGE_STATE,
  normalizeMemoryManagementPages,
  type MemoryManagementPageState,
} from "./memory/memory-management-page-state.js";
import {
  normalizeProviderInstructionTarget,
  type HomeProviderInstructionTargetDraft,
} from "./settings/provider-instruction-target-draft.js";
import {
  buildHomeMemoryManagementContentProps,
  buildHomeSettingsContentProps,
  type HomeSettingsContentBaseProps,
} from "./settings/home-settings-content-props.js";
import { buildProviderInstructionTargetHandlers } from "./settings/provider-instruction-target-handlers.js";
import { buildSettingsDraftHandlers } from "./settings/settings-draft-handlers.js";
import { buildSettingsCommandHandlers } from "./settings/settings-command-handlers.js";
import { buildMemoryManagementHandlers } from "./memory/memory-management-handlers.js";
import { getWithMateApi, isDesktopRuntime, withWithMateApi } from "./renderer-withmate-api.js";
import {
  type MateGrowthSettings,
  type MateProfile,
  type MateStorageState,
} from "./mate/mate-state.js";
import { buildHomeMateSetupContentProps } from "./mate/home-mate-setup-props.js";
import { type MateEmbeddingSettings } from "./mate/mate-embedding-settings.js";
import type { MateGrowthEventListItem } from "./mate/mate-growth-events-state.js";
import {
  upsertMateGrowthEventListItem as upsertMateGrowthEventListItemAction,
} from "./mate/mate-growth-actions.js";
import { buildMateGrowthHandlers } from "./mate/mate-growth-handlers.js";
import { MEMORY_MANAGEMENT_PAGE_LIMIT } from "./memory/memory-management-actions.js";
import { buildMateMaintenanceHandlers } from "./mate/mate-maintenance-handlers.js";
import { buildMateStatusRefreshers } from "./mate/mate-status-refreshers.js";
import { buildHomeMonitorContentProps } from "./home/home-monitor-content-props.js";
import { renderHomeMonitorWindowIcon, renderHomeSearchIcon } from "./home/home-icons.js";

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

  const { refreshMateStatus, refreshMateGrowthEvents } = buildMateStatusRefreshers({
    setMateState,
    setMateProfile,
    setMateDisplayName,
    setMateEmbeddingSettings,
    setMateEmbeddingFeedback,
    setMateEmbeddingBusy,
    setMateGrowthSettings,
    setMateGrowthFeedback,
    setMateGrowthBusy,
    setMateGrowthEvents,
    setMateGrowthEventsFeedback,
    setMateGrowthEventsLoading,
    setMateGrowthEventBusyTarget,
    setCorrectingMateGrowthEventId,
    setCorrectingMateGrowthEventStatement,
    setMateAvatarUpdating,
    stopMateEmbeddingSettingsPolling,
  });

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
        withmateApi.getModelCatalog(null),
        withmateApi.getMateEmbeddingSettings(),
        withmateApi.getMateGrowthSettings(),
      ]),
    ]).then(([nextMateState, [snapshot, embeddingSettings, growthSettings]]) => {
      if (!active) {
        return;
      }

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
        if (usesMemoryManagementWindow) {
          setMemoryManagementLoaded(true);
        }
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

  useHomeOpenWindowSubscriptions({
    getApi: getWithMateApi,
    setOpenSessionWindowIds,
    setOpenCompanionReviewWindowIds,
  });

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
  } = sessionProjection;
  const launchProjection = useMemo(
    () => buildHomeLaunchProjection({
      launchProviderId: launchDraft.providerId,
      launchMode: launchDraft.mode,
      launchTitle: launchDraft.title,
      launchWorkspace: launchDraft.workspace,
      appSettings,
      modelCatalog,
    }),
    [appSettings, launchDraft, modelCatalog],
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
    selectedLaunchProviderId: selectedLaunchProvider?.id ?? null,
    sessions,
    setLaunchFeedback,
    setLaunchStarting,
    setLaunchDraft,
    pickWorkspaceDirectory: async () => withWithMateApi((api) => api.pickDirectory()),
    openSessionWindow,
    openCompanionReviewWindow,
    openMateTalkWindow,
    createSession: async (input) => await withWithMateApi((api) => api.createSession(input)),
    createCompanionSession: async (input) => await withWithMateApi((api) => api.createCompanionSession(input)),
    upsertSessionSummary: (summary) => {
      setSessions((current) => [
        summary,
        ...current.filter((session) => session.id !== summary.id),
      ]);
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
    setSessions,
    setCompanionSessions,
    setMateEmbeddingSettings,
    setMateGrowthSettings,
    setMateGrowthFeedback,
    setMateGrowthEvents,
    setMateGrowthEventsFeedback,
    setCorrectingMateGrowthEventId,
    setCorrectingMateGrowthEventStatement,
    refreshMateGrowthEvents,
  });

  const upsertMateGrowthEventListItem = (nextEvent: MateGrowthEventListItem | null) => {
    setMateGrowthEvents((current) => upsertMateGrowthEventListItemAction(current, nextEvent));
  };

  const mateGrowthHandlers = buildMateGrowthHandlers({
    getApi: getWithMateApi,
    mateState,
    mateGrowthApplying,
    mateGrowthBusy,
    mateGrowthEventBusyTarget,
    setMateGrowthApplying,
    setMateGrowthBusy,
    setSettingsFeedback,
    setMateGrowthFeedback,
    setMateGrowthSettings,
    setMateGrowthEventsFeedback,
    setMateGrowthEventBusyTarget,
    setCorrectingMateGrowthEventId,
    setCorrectingMateGrowthEventStatement,
    upsertMateGrowthEventListItem,
    refreshMateStatus,
    refreshMateGrowthEvents,
  });

  const providerInstructionTargetHandlers = buildProviderInstructionTargetHandlers({
    providerInstructionTargets,
    settingsDraft,
    setProviderInstructionTargets,
    setSettingsFeedback,
    getApi: getWithMateApi,
  });

  const settingsDraftHandlers = buildSettingsDraftHandlers({
    modelCatalog,
    setSettingsDraft,
  });

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

  const memoryManagementHandlers = buildMemoryManagementHandlers({
    getApi: getWithMateApi,
    usesMemoryManagementWindow,
    memoryManagementFilters,
    memoryManagementPages,
    beginMemoryManagementRequest,
    isLatestMemoryManagementRequest,
    setMemoryManagementLoaded,
    setMemoryManagementFilters,
    setMemoryManagementSnapshot,
    setMemoryManagementPages,
    setMemoryManagementFeedback,
    setMemoryManagementBusyTarget,
  });

  const settingsCommandHandlers = buildSettingsCommandHandlers({
    getApi: getWithMateApi,
    settingsDraft,
    persistedSettingsDraft,
    providerInstructionTargets,
    setAppSettings,
    setSettingsDraft,
    setProviderInstructionTargets,
    setSettingsFeedback,
    onChangeProviderSkillRootPath: settingsDraftHandlers.onChangeProviderSkillRootPath,
    onChangeProviderSkillRelativePath: settingsDraftHandlers.onChangeProviderSkillRelativePath,
  });

  const mateMaintenanceHandlers = buildMateMaintenanceHandlers({
    getApi: getWithMateApi,
    mateState,
    mateResetting,
    setMateResetting,
    setSettingsFeedback,
    setMateEmbeddingBusy,
    setMateEmbeddingFeedback,
    setMateEmbeddingSettings,
    refreshMateStatus,
  });

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
    ...settingsDraftHandlers,
    ...providerInstructionTargetHandlers,
    ...memoryManagementHandlers,
    ...settingsCommandHandlers,
    onStartMateEmbeddingDownload: mateMaintenanceHandlers.onStartMateEmbeddingDownload,
    onReloadMateGrowthEvents: mateGrowthHandlers.onReloadMateGrowthEvents,
    onBeginCorrectMateGrowthEvent: mateGrowthHandlers.onBeginCorrectMateGrowthEvent,
    onChangeCorrectMateGrowthEventStatement: mateGrowthHandlers.onChangeCorrectMateGrowthEventStatement,
    onCancelCorrectMateGrowthEvent: mateGrowthHandlers.onCancelCorrectMateGrowthEvent,
    onCorrectMateGrowthEvent: mateGrowthHandlers.onCorrectMateGrowthEvent,
    onDisableMateGrowthEvent: mateGrowthHandlers.onDisableMateGrowthEvent,
    onForgetMateGrowthEvent: mateGrowthHandlers.onForgetMateGrowthEvent,
    onUpdateMateGrowthSettings: mateGrowthHandlers.onUpdateMateGrowthSettings,
  };

  const { settingsContent, memoryManagementContent, mateSetupContent, monitorContent } = buildHomeWindowContentSlots({
    settingsContent: buildHomeSettingsContentProps({
      ...baseSettingsContentProps,
      onApplyPendingGrowth: mateGrowthHandlers.onApplyPendingGrowth,
      applyPendingGrowthBusy: mateGrowthApplying,
      canApplyPendingGrowth: mateState === "active",
      onResetMate: mateMaintenanceHandlers.onResetMate,
      mateResetBusy: mateResetting,
      canResetMate: mateState !== "not_created",
    }),
    memoryManagementContent: buildHomeMemoryManagementContentProps(baseSettingsContentProps),
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
        onOpenCompanionReview: (sessionId) => void openCompanionReviewWindow(sessionId),
      },
      canUsePrimaryFeatures,
    }),
    rightPane: buildHomeRightPaneProps({
      rightPaneView,
      runningMonitorEntries,
      nonRunningMonitorEntries,
      mateProfile,
      monitorWindowIcon: renderHomeMonitorWindowIcon(),
      handlers: {
        onChangeRightPaneView: setRightPaneView,
        onOpenSessionMonitorWindow: () => void openSessionMonitorWindow(),
        onOpenMemoryManagementWindow: () => void openMemoryManagementWindow(),
        onOpenSettingsWindow: () => void openSettingsWindow(),
        onOpenMateProfile: mateProfileHandlers.onOpenProfileEditor,
        onOpenMateTalk: homeLaunchHandlers.onOpenMateTalkLaunchDialog,
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
      onSelectMode: homeLaunchHandlers.onChangeMode,
      onChangeTitle: homeLaunchHandlers.onChangeTitle,
      onBrowseWorkspace: () => void homeLaunchHandlers.onBrowseWorkspace(),
      onSelectProvider: homeLaunchHandlers.onSelectLaunchProvider,
      onStartSession: (mode) => void homeLaunchHandlers.onStartSession(mode),
    }),
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
