import { useEffect, useMemo, useRef, useState } from "react";

import {
  createDefaultAppSettings,
  type AppSettings,
} from "./provider-settings-state.js";
import { startAppSettingsSubscription } from "./app-settings-subscription.js";
import { type SessionSummary } from "./session-state.js";
import { startSessionSummariesSubscription } from "./session-summary-subscription.js";
import { type ModelCatalogSnapshot } from "./model-catalog.js";
import { startModelCatalogSubscription } from "./model-catalog-subscription.js";
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
import { HomeAppRouter } from "./home/HomeAppRouter.js";
import { buildHomeDashboardSlots } from "./home/HomeDashboardSlots.js";
import { buildHomeRecentSessionsPanelProps } from "./home/home-recent-sessions-panel-props.js";
import { buildHomeRightPaneProps } from "./home/home-right-pane-props.js";
import { buildHomeWindowContentSlots } from "./home/HomeWindowContentSlots.js";
import { getHomeWindowMode } from "./home/home-window-mode.js";
import { useHomeOpenWindowSubscriptions } from "./home/use-home-open-window-subscriptions.js";
import {
  openCompanionReviewWindow,
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
import { buildMateMaintenanceHandlers } from "./mate/mate-maintenance-handlers.js";
import { buildMateStatusRefreshers } from "./mate/mate-status-refreshers.js";
import { buildHomeMonitorContentProps } from "./home/home-monitor-content-props.js";
import { renderHomeMonitorWindowIcon, renderHomeSearchIcon } from "./home/home-icons.js";

type HomeRightPaneView = "monitor" | "mate";

export default function HomeApp() {
  const desktopRuntime = isDesktopRuntime();
  const homeWindowMode = useMemo(() => getHomeWindowMode(), []);
  const isMonitorWindowMode = homeWindowMode === "monitor";
  const isSettingsWindowMode = homeWindowMode === "settings";
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [companionSessions, setCompanionSessions] = useState<CompanionSessionSummary[]>([]);
  const [openSessionWindowIds, setOpenSessionWindowIds] = useState<string[]>([]);
  const [openCompanionReviewWindowIds, setOpenCompanionReviewWindowIds] = useState<string[]>([]);
  const [sessionSearchText, setSessionSearchText] = useState("");
  const [rightPaneView, setRightPaneView] = useState<HomeRightPaneView>("monitor");
  const [settingsFeedback, setSettingsFeedback] = useState("");
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(createDefaultAppSettings());
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [settingsDraftLoaded, setSettingsDraftLoaded] = useState(!isSettingsWindowMode);
  const [modelCatalogLoaded, setModelCatalogLoaded] = useState(!isSettingsWindowMode);
  const [launchDraft, setLaunchDraft] = useState<HomeLaunchDraft>(() => createClosedLaunchDraft());
  const [launchFeedback, setLaunchFeedback] = useState("");
  const [launchStarting, setLaunchStarting] = useState(false);
  const [mateState, setMateState] = useState<MateStorageState | null>(null);
  const [mateProfile, setMateProfile] = useState<MateProfile | null>(null);
  const [mateDisplayName, setMateDisplayName] = useState("");
  const [mateCreating, setMateCreating] = useState(false);
  const [mateAvatarUpdating, setMateAvatarUpdating] = useState(false);
  const [mateResetting, setMateResetting] = useState(false);
  const [mateCreationFeedback, setMateCreationFeedback] = useState("");
  const [mateProfileEditorOpen, setMateProfileEditorOpen] = useState(false);
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

  const { refreshMateStatus } = buildMateStatusRefreshers({
    setMateState,
    setMateProfile,
    setMateDisplayName,
    setMateAvatarUpdating,
  });

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

    let unsubscribeSessions: (() => void) | null = null;
    let unsubscribeCompanionSessions: (() => void) | null = null;

    const startOperationalHomeSummarySubscriptions = () => {
      if (unsubscribeSessions || unsubscribeCompanionSessions) {
        return;
      }

      unsubscribeSessions = startSessionSummariesSubscription({
        api: withmateApi,
        applySummaries: setSessions,
        onInitialLoadError: handleInitialSummaryLoadError,
      });
      unsubscribeCompanionSessions = startCompanionSessionSummariesSubscription({
        api: withmateApi,
        applySummaries: setCompanionSessions,
        onInitialLoadError: handleInitialSummaryLoadError,
      });
    };

    void refreshMateStatus(withmateApi, { isActive: () => active }).then((nextMateState) => {
      if (!active) {
        return;
      }

      if (nextMateState !== "not_created") {
        startOperationalHomeSummarySubscriptions();
      }
    }).catch((error) => {
      if (!active) {
        return;
      }

      setMateState("not_created");
      setMateProfile(null);
      setMateCreationFeedback(error instanceof Error ? error.message : "Mate 状態の取得に失敗したよ。");
    });

    const unsubscribeModelCatalog = startModelCatalogSubscription({
      api: withmateApi,
      enabled: true,
      subscribe: true,
      applyModelCatalog: (snapshot) => {
        setModelCatalog(snapshot);
        setModelCatalogLoaded(true);
      },
      onInitialLoadError: (error) => {
        setMateCreationFeedback(error instanceof Error ? error.message : "Mate 状態の取得に失敗したよ。");
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

  useHomeOpenWindowSubscriptions({
    getApi: getWithMateApi,
    setOpenSessionWindowIds,
    setOpenCompanionReviewWindowIds,
  });

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
    settingsDraftLoaded && modelCatalogLoaded;
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
  });

  const mateMaintenanceHandlers = buildMateMaintenanceHandlers({
    getApi: getWithMateApi,
    mateState,
    mateResetting,
    setMateResetting,
    setSettingsFeedback,
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
    ...settingsDraftHandlers,
    ...settingsCommandHandlers,
  };

  const { settingsContent, mateSetupContent, monitorContent } = buildHomeWindowContentSlots({
    settingsContent: buildHomeSettingsContentProps({
      ...baseSettingsContentProps,
      onResetMate: mateMaintenanceHandlers.onResetMate,
      mateResetBusy: mateResetting,
      canResetMate: mateState !== "not_created",
    }),
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
        onOpenSettingsWindow: () => void openSettingsWindow(),
        onOpenMateProfile: mateProfileHandlers.onOpenProfileEditor,
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
      isMonitorWindowMode={isMonitorWindowMode}
      monitorContent={monitorContent}
      recentSessionsPanel={recentSessionsPanel}
      rightPane={rightPane}
      launchDialog={launchDialog}
    />
  );
}
