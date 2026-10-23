import { useEffect, useMemo, useRef, useState } from "react";

import {
  createDefaultAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import { startAppSettingsSubscription } from "../settings/app-settings-subscription.js";
import {
  projectHomeSessionSummary,
} from "../../src-shared/session/session-state.js";
import {
  type AuxiliarySessionSummary,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { LiveSessionRunStatus } from "../../src-shared/session/live-session-run-status.js";
import { type ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { startModelCatalogSubscription } from "../settings/model-catalog-subscription.js";
import type { OpenSessionWindowIdsState } from "../app/open-session-window-subscription.js";
import type { MemoryV6Diagnostics } from "../../src-shared/memory/memory-diagnostics-state.js";
import {
  buildHomeLaunchProjection,
} from "./home-launch-projection.js";
import { buildHomeLaunchDialogProps } from "./home-launch-dialog-props.js";
import {
  createClosedLaunchDraft,
  applyLaunchWorkspacePathValidation,
  beginLaunchWorkspacePathValidation,
  markLaunchWorkspacePathValidationPending,
  type HomeCharacterLoadStatus,
  type HomeLaunchCharacterCatalog,
  type HomeLaunchDraft,
} from "./home-launch-state.js";
import {
  createDirectoryPathValidationController,
  type DirectoryPathValidationController,
} from "../launch/directory-path-validation.js";
import { resolveSelectedLaunchProviderDraftId } from "../launch/launch-provider-selection.js";
import type { ProviderLaunchLoadStatus } from "../launch/provider-launch-picker.js";
import { buildHomeMateProfileHandlers } from "./home-mate-profile-handlers.js";
import {
  buildHomeSessionProjection,
  type HomeMonitorAuxiliaryDataState,
} from "./home-session-projection.js";
import { buildHomeLaunchHandlers, type HomeLaunchLifetime } from "./home-launch-handlers.js";
import { HomeLaunchResults } from "./HomeLaunchResults.js";
import {
  buildHomeProviderSettingRows,
  buildPersistedAppSettingsFromRows,
  type HomeProviderSettingRow,
} from "../settings/settings-view-model.js";
import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import { HomeAppRouter } from "./HomeAppRouter.js";
import { buildHomeDashboardSlots } from "./HomeDashboardSlots.js";
import { buildHomeRecentSessionsPanelProps } from "./home-recent-sessions-panel-props.js";
import { mergePinnedSessionSummary } from "./session-pinning.js";
import { fetchHomeSessionSummaryPage } from "./home-session-summary-query.js";
import { buildHomeSessionQueryKey, HomeSessionQueryGeneration } from "./home-session-query-generation.js";
import {
  applyHomeSessionSummaryPages,
  createEmptyHomeSessionSummariesState,
  type HomeSessionSummariesState,
} from "./home-session-summaries-state.js";
import { useHomeSessionSummaryRefresh } from "./use-home-session-summary-refresh.js";
import { useHomeSearchInput } from "./use-home-search-input.js";
import { buildHomeRightPaneProps } from "./home-right-pane-props.js";
import { buildHomeWindowContentSlots } from "./HomeWindowContentSlots.js";
import { getHomeWindowMode } from "./home-window-mode.js";
import { useHomeOpenWindowSubscriptions } from "./use-home-open-window-subscriptions.js";
import {
  openCharacterEditorWindow,
  openMemoryV6ReviewWindow,
  openSessionMonitorWindow,
  openSessionWindow,
  openSettingsWindow,
} from "./home-launch-commands.js";
import {
  buildHomeSettingsContentProps,
  type HomeSettingsContentBaseProps,
} from "../settings/home-settings-content-props.js";
import { buildSettingsDraftHandlers } from "../settings/settings-draft-handlers.js";
import { buildSettingsCommandHandlers } from "../settings/settings-command-handlers.js";
import { ProviderQuotaOverview } from "../provider-usage/provider-quota.js";
import { getWithMateApi, isDesktopRuntime, withWithMateApi } from "../app/renderer-withmate-api.js";
import {
  type MateProfile,
  type MateStorageState,
} from "../../src-shared/mate/mate-state.js";
import { buildHomeMateSetupContentProps } from "../mate/home-mate-setup-props.js";
import type { MateAvatarAction } from "../mate/MateSetupPanel.js";
import { buildMateStatusRefreshers } from "../mate/mate-status-refreshers.js";
import { buildHomeMonitorContentProps } from "./home-monitor-content-props.js";
import { renderHomeMonitorWindowIcon } from "./home-icons.js";
import {
  buildSessionWindowRestoreFeedback,
  selectPendingSessionWindowRestoreIds,
} from "./home-session-window-restore.js";
import { runSessionMonitorContextMenu } from "./home-session-monitor-feedback.js";
import type {
  SessionMonitorContextMenuPoint,
  SessionMonitorEntryKind,
} from "../../src-shared/window/withmate-window-types.js";
import {
  createHomeAuxiliarySessionRefresher,
  resolveHomeAuxiliarySessionSummariesState,
} from "./home-active-auxiliary-refresh.js";
import { resolveRandomHomeLaunchFeedback, type HomeLaunchFeedbackSource, type HomeLaunchResult } from "./home-launch-actions.js";

type HomeRightPaneView = "monitor" | "characters" | "previews";

export default function HomeApp() {
  const desktopRuntime = isDesktopRuntime();
  const homeWindowMode = useMemo(() => getHomeWindowMode(), []);
  const isMonitorWindowMode = homeWindowMode === "monitor";
  const isSettingsWindowMode = homeWindowMode === "settings";
  const isMemoryReviewWindowMode = homeWindowMode === "memory-review";
  const [sessionSummariesState, setSessionSummariesState] = useState<HomeSessionSummariesState>(
    createEmptyHomeSessionSummariesState,
  );
  const sessions = sessionSummariesState.summaries;
  const [auxiliarySessionSummaries, setAuxiliarySessionSummaries] = useState<AuxiliarySessionSummary[]>([]);
  const [auxiliaryDataState, setAuxiliaryDataState] = useState<HomeMonitorAuxiliaryDataState>("loading");
  const hasLoadedAuxiliarySessionSummariesRef = useRef(false);
  const auxiliarySessionRefresherRef = useRef<ReturnType<typeof createHomeAuxiliarySessionRefresher> | null>(null);
  const [openSessionWindowIdsState, setOpenSessionWindowIdsState] = useState<OpenSessionWindowIdsState>({
    status: "loading",
    sessionIds: [],
  });
  const openSessionWindowIds = openSessionWindowIdsState.sessionIds;
  const {
    inputText: searchInputText,
    searchText: sessionSearchText,
    onChangeInputText,
    onCompositionStart,
    onCompositionEnd,
  } = useHomeSearchInput();
  const [pendingSessionPinIds, setPendingSessionPinIds] = useState<string[]>([]);
  const [sessionWindowRestoreIds, setSessionWindowRestoreIds] = useState<string[]>([]);
  const [sessionWindowRestorePending, setSessionWindowRestorePending] = useState(false);
  const [sessionWindowRestoreFeedback, setSessionWindowRestoreFeedback] = useState("");
  const [sessionMonitorFeedback, setSessionMonitorFeedback] = useState("");
  const [auxiliaryLoadFeedback, setAuxiliaryLoadFeedback] = useState("");
  const pendingSessionWindowRestoreIds = useMemo(
    () => openSessionWindowIdsState.status === "loaded"
      ? selectPendingSessionWindowRestoreIds(sessionWindowRestoreIds, openSessionWindowIds)
      : [],
    [openSessionWindowIds, openSessionWindowIdsState.status, sessionWindowRestoreIds],
  );
  const [rightPaneView, setRightPaneView] = useState<HomeRightPaneView>("monitor");
  const [settingsFeedback, setSettingsFeedback] = useState("");
  const [sessionCleanupCutoffDate, setSessionCleanupCutoffDate] = useState("");
  const [deletingOldSessions, setDeletingOldSessions] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(createDefaultAppSettings());
  const [memoryV6Diagnostics, setMemoryV6Diagnostics] = useState<MemoryV6Diagnostics | null>(null);
  const [memoryV6DiagnosticsLoadStatus, setMemoryV6DiagnosticsLoadStatus] = useState<ProviderLaunchLoadStatus>("loading");
  const [memoryV6DiagnosticsLoadError, setMemoryV6DiagnosticsLoadError] = useState("");
  const [memoryV6DiagnosticsRetry, setMemoryV6DiagnosticsRetry] = useState(0);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [modelCatalogLoadStatus, setModelCatalogLoadStatus] = useState<ProviderLaunchLoadStatus>("loading");
  const [modelCatalogLoadError, setModelCatalogLoadError] = useState("");
  const [modelCatalogRetry, setModelCatalogRetry] = useState(0);
  const [appSettingsLoadStatus, setAppSettingsLoadStatus] = useState<ProviderLaunchLoadStatus>("loading");
  const [appSettingsLoadError, setAppSettingsLoadError] = useState("");
  const [settingsDraftLoaded, setSettingsDraftLoaded] = useState(!isSettingsWindowMode);
  const [appSettingsRetry, setAppSettingsRetry] = useState(0);
  const [homeStateRetry, setHomeStateRetry] = useState(0);
  const [characterRetry, setCharacterRetry] = useState(0);
  const [characterEntries, setCharacterEntries] = useState<CharacterCatalogEntry[]>([]);
  const [characterListFeedback, setCharacterListFeedback] = useState("");
  const [characterLoadStatus, setCharacterLoadStatus] = useState<HomeCharacterLoadStatus>("loading");
  const [launchDraft, setLaunchDraft] = useState<HomeLaunchDraft>(() => createClosedLaunchDraft());
  const launchDialogAttemptRef = useRef<object | null>(null);
  useEffect(() => () => {
    launchDialogAttemptRef.current = null;
  }, []);
  const [launchCharacterCatalog, setLaunchCharacterCatalog] = useState<HomeLaunchCharacterCatalog>({
    entries: [],
    status: "loading",
  });
  const [launchFeedbackState, setLaunchFeedbackState] = useState({
    message: "",
    source: "launch" as HomeLaunchFeedbackSource,
  });
  const setLaunchFeedback = (message: string, source: HomeLaunchFeedbackSource = "launch") => {
    setLaunchFeedbackState({ message, source });
  };
  const [launchStarting, setLaunchStarting] = useState(false);
  const launchLifetimeRef = useRef<HomeLaunchLifetime>({ starting: false });
  const [launchResults, setLaunchResults] = useState<HomeLaunchResult[]>([]);
  const [mateState, setMateState] = useState<MateStorageState | null>(null);
  const [mateLoadStatus, setMateLoadStatus] = useState<ProviderLaunchLoadStatus>("loading");
  const [mateLoadError, setMateLoadError] = useState("");
  const [mateProfile, setMateProfile] = useState<MateProfile | null>(null);
  const [mateDisplayName, setMateDisplayName] = useState("");
  const [mateCreating, setMateCreating] = useState(false);
  const [mateAvatarAction, setMateAvatarAction] = useState<MateAvatarAction>(null);
  const [mateCreationFeedback, setMateCreationFeedback] = useState("");
  const [mateProfileEditorOpen, setMateProfileEditorOpen] = useState(false);
  const settingsDirtyRef = useRef(false);
  const persistedSettingsDraftRef = useRef<AppSettings | null>(null);
  const settingsHydratedRef = useRef(!isSettingsWindowMode);
  const workspaceValidationControllerRef = useRef<DirectoryPathValidationController | null>(null);
  const sessionQueryGenerationRef = useRef<HomeSessionQueryGeneration | null>(null);
  const pageRequestsRef = useRef(new Map<"recent" | "pinned", object>());
  if (sessionQueryGenerationRef.current === null) {
    sessionQueryGenerationRef.current = new HomeSessionQueryGeneration(
      buildHomeSessionQueryKey(sessionSearchText, openSessionWindowIds),
    );
  }
  const refreshSessionSummaries = useHomeSessionSummaryRefresh({
    enabled: !isSettingsWindowMode && !isMemoryReviewWindowMode,
    sessionSearchText,
    openSessionWindowIds,
    sessionSummariesState,
    setSessionSummariesState,
    sessionQueryGeneration: sessionQueryGenerationRef.current,
  });
  if (workspaceValidationControllerRef.current === null) {
    workspaceValidationControllerRef.current = createDirectoryPathValidationController({
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
  const applyIncomingAppSettings = (settings: AppSettings, options?: { force?: boolean }) => {
    setAppSettings(settings);
    setSettingsDraftLoaded(true);
    setSettingsDraft((current) => {
      const shouldHydrateDrafts =
        options?.force || !isSettingsWindowMode || !settingsHydratedRef.current || !settingsDirtyRef.current;
      return shouldHydrateDrafts ? settings : current;
    });
    if (options?.force || !isSettingsWindowMode || !settingsHydratedRef.current || !settingsDirtyRef.current) {
      settingsHydratedRef.current = true;
    }
  };

  const { refreshMateStatus } = buildMateStatusRefreshers({
    setMateState,
    setMateProfile,
    setMateDisplayName,
    setMateAvatarAction,
  });

  const loadMoreSessionSummaryPage = async (scope: "recent" | "pinned", retry = false): Promise<void> => {
    const api = getWithMateApi();
    const pages = scope === "recent" ? sessionSummariesState.recentPages : sessionSummariesState.pinnedPages;
    const cursor = pages.at(-1)?.page.nextCursor
      ?? (scope === "recent" ? sessionSummariesState.recentCursor : sessionSummariesState.pinnedCursor);
    const hasMore = scope === "recent" ? sessionSummariesState.hasMoreRecent : sessionSummariesState.hasMorePinned;
    const loading = scope === "recent"
      ? sessionSummariesState.loadingRecentPage
      : sessionSummariesState.loadingPinnedPage;
    const status = scope === "recent" ? sessionSummariesState.recentStatus : sessionSummariesState.pinnedStatus;
    const pageErrorKey = scope === "recent" ? "recentPageError" : "pinnedPageError";
    if (!api || !cursor || !hasMore || loading || status !== "loaded" || pageRequestsRef.current.has(scope)
      || (!retry && sessionSummariesState[pageErrorKey])) {
      return;
    }

    const requestToken = sessionQueryGenerationRef.current!.capture();
    pageRequestsRef.current.set(scope, requestToken);
    setSessionSummariesState((current) => ({
      ...current,
      ...(scope === "recent" ? { loadingRecentPage: true } : { loadingPinnedPage: true }),
    }));
    try {
      const page = await fetchHomeSessionSummaryPage(api, scope, cursor, sessionSearchText);
      if (!sessionQueryGenerationRef.current!.isCurrent(requestToken)) {
        return;
      }
      setSessionSummariesState((current) => ({
        ...applyHomeSessionSummaryPages(current, {
          recent: scope === "recent"
            ? [...current.recentPages, { requestCursor: cursor, page }]
            : current.recentPages,
          pinned: scope === "pinned"
            ? [...current.pinnedPages, { requestCursor: cursor, page }]
            : current.pinnedPages,
          open: current.openSummaries,
        }),
        ...(scope === "recent"
          ? { recentCursor: page.nextCursor, hasMoreRecent: page.hasMore, loadingRecentPage: false }
          : { pinnedCursor: page.nextCursor, hasMorePinned: page.hasMore, loadingPinnedPage: false }),
        [pageErrorKey]: "",
      }));
    } catch (error) {
      if (!sessionQueryGenerationRef.current!.isCurrent(requestToken)) {
        return;
      }
      setSessionSummariesState((current) => ({
        ...current,
        ...(scope === "recent" ? { loadingRecentPage: false } : { loadingPinnedPage: false }),
        [pageErrorKey]: error instanceof Error ? error.message : "Could not load more sessions.",
      }));
    } finally {
      if (pageRequestsRef.current.get(scope) === requestToken) pageRequestsRef.current.delete(scope);
    }
  };

  const loadNextSessionSummaryPage = () => {
    if (sessionSummariesState.loadingPinnedPage || sessionSummariesState.loadingRecentPage) {
      return;
    }
    if (sessionSummariesState.hasMorePinned) {
      void loadMoreSessionSummaryPage("pinned");
      return;
    }
    if (sessionSummariesState.hasMoreRecent) {
      void loadMoreSessionSummaryPage("recent");
    }
  };

  const retrySessionSummaryLoad = () => {
    if (sessionSummariesState.recentError || sessionSummariesState.pinnedError) {
      void refreshSessionSummaries("preserve");
      return;
    }
    if (sessionSummariesState.pinnedPageError) void loadMoreSessionSummaryPage("pinned", true);
    if (sessionSummariesState.recentPageError) void loadMoreSessionSummaryPage("recent", true);
  };

  const setSessionPinned = async (sessionId: string, isPinned: boolean) => {
    const api = getWithMateApi();
    if (!api) {
      window.alert("Pinning is available from the Electron desktop app.");
      return;
    }
    setPendingSessionPinIds((current) => current.includes(sessionId) ? current : [...current, sessionId]);
    try {
      const saved = projectHomeSessionSummary(await api.setSessionPinned({ sessionId, isPinned }));
      setSessionSummariesState((current) => ({
        ...current,
        summaries: mergePinnedSessionSummary(current.summaries, saved),
      }));
      void refreshSessionSummaries("preserve");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not update pin.");
    } finally {
      setPendingSessionPinIds((current) => current.filter((id) => id !== sessionId));
    }
  };

  const refreshCharacterEntries = async (
    api: NonNullable<ReturnType<typeof getWithMateApi>>,
  ): Promise<CharacterCatalogEntry[]> => {
    setCharacterLoadStatus("loading");
    setCharacterListFeedback("");
    try {
      const entries = await api.listCharacters();
      setCharacterEntries(entries);
      setCharacterListFeedback("");
      setCharacterLoadStatus("loaded");
      return entries;
    } catch (error) {
      setCharacterLoadStatus("error");
      throw error;
    }
  };

  const refreshMemoryV6Diagnostics = async (
    api: NonNullable<ReturnType<typeof getWithMateApi>>,
  ): Promise<void> => {
    setMemoryV6DiagnosticsLoadStatus("loading");
    setMemoryV6DiagnosticsLoadError("");
    try {
      setMemoryV6Diagnostics(await api.getMemoryV6Diagnostics());
      setMemoryV6DiagnosticsLoadStatus("loaded");
    } catch (error) {
      setMemoryV6DiagnosticsLoadStatus("error");
      setMemoryV6DiagnosticsLoadError(error instanceof Error ? error.message : "Could not load Memory V6 diagnostics.");
      throw error;
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

    if (!isSettingsWindowMode && !isMonitorWindowMode && !isMemoryReviewWindowMode) {
      setMateLoadStatus("loading");
      setMateLoadError("");
      void refreshMateStatus(withmateApi, { isActive: () => active }).then(() => {
        if (active) setMateLoadStatus("loaded");
      }).catch((error) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : "Could not load app state.";
        setMateLoadError(message);
        setMateLoadStatus("error");
      });
    }

    if (isSettingsWindowMode) {
      void refreshMemoryV6Diagnostics(withmateApi).catch(() => undefined);
    }

    return () => { active = false; };
  }, [homeStateRetry, isMemoryReviewWindowMode, isMonitorWindowMode, isSettingsWindowMode, memoryV6DiagnosticsRetry]);

  useEffect(() => {
    if (isSettingsWindowMode || isMonitorWindowMode || isMemoryReviewWindowMode) return;
    const api = getWithMateApi();
    if (!api) return;
    let active = true;
    void refreshCharacterEntries(api).catch((error) => {
      if (active) setCharacterListFeedback(error instanceof Error ? error.message : "Could not load characters.");
    });
    return () => { active = false; };
  }, [characterRetry, isMemoryReviewWindowMode, isMonitorWindowMode, isSettingsWindowMode]);

  useEffect(() => {
    if (isMonitorWindowMode || isMemoryReviewWindowMode) return;
    const api = getWithMateApi();
    if (!api) return;
    let active = true;
    const unsubscribe = startModelCatalogSubscription({
      api,
      enabled: true,
      subscribe: true,
      applyModelCatalog: (snapshot) => {
        if (!active) return;
        setModelCatalog(snapshot);
        setModelCatalogLoadStatus("loaded");
        setModelCatalogLoadError("");
      },
      onInitialLoadError: (error) => {
        if (!active) return;
        setModelCatalog(null);
        setModelCatalogLoadStatus("error");
        setModelCatalogLoadError(error instanceof Error ? error.message : "Could not load model catalog.");
      },
    });
    return () => { active = false; unsubscribe(); };
  }, [isMemoryReviewWindowMode, isMonitorWindowMode, modelCatalogRetry]);

  useEffect(() => {
    if (isMonitorWindowMode || isMemoryReviewWindowMode) return;
    const api = getWithMateApi();
    if (!api) return;
    let active = true;
    const unsubscribe = startAppSettingsSubscription({
      api,
      loadInitial: true,
      applyAppSettings: (settings) => {
        if (!active) return;
        setAppSettingsLoadStatus("loaded");
        setAppSettingsLoadError("");
        applyIncomingAppSettings(settings, { force: isSettingsWindowMode });
      },
      onInitialLoadError: (error) => {
        if (!active) return;
        setAppSettingsLoadStatus("error");
        setAppSettingsLoadError(error instanceof Error ? error.message : "Could not load app settings.");
      },
    });
    return () => { active = false; unsubscribe(); };
  }, [appSettingsRetry, isMemoryReviewWindowMode, isMonitorWindowMode, isSettingsWindowMode]);

  useEffect(() => {
    if (isSettingsWindowMode || isMemoryReviewWindowMode) return;
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
        setCharacterListFeedback(error instanceof Error ? error.message : "Could not refresh characters.");
      }).finally(() => {
        refreshInFlight = false;
      });
    };

    window.addEventListener("focus", refreshCharactersOnFocus);
    return () => window.removeEventListener("focus", refreshCharactersOnFocus);
  }, [isMemoryReviewWindowMode, isMonitorWindowMode, isSettingsWindowMode]);

  useHomeOpenWindowSubscriptions({
    enabled: !isSettingsWindowMode && !isMemoryReviewWindowMode,
    getApi: getWithMateApi,
    setOpenSessionWindowIdsState,
  });

  useEffect(() => {
    const api = getWithMateApi();
    if (!api || isSettingsWindowMode || isMonitorWindowMode || isMemoryReviewWindowMode) {
      return;
    }
    let active = true;
    let receivedSnapshotUpdate = false;
    const unsubscribe = api.subscribeSessionWindowRestoreSet((sessionIds) => {
      if (active) {
        receivedSnapshotUpdate = true;
        setSessionWindowRestoreIds(sessionIds);
      }
    });
    void api.getSessionWindowRestoreSet().then((sessionIds) => {
      if (active && !receivedSnapshotUpdate) {
        setSessionWindowRestoreIds(sessionIds);
      }
    }).catch((error) => {
      if (active) {
        setSessionWindowRestoreFeedback(
          error instanceof Error ? error.message : "Could not load previous sessions.",
        );
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [isMemoryReviewWindowMode, isMonitorWindowMode, isSettingsWindowMode]);

  const restoreSessionWindows = async () => {
    const api = getWithMateApi();
    if (!api || sessionWindowRestorePending) {
      return;
    }
    setSessionWindowRestorePending(true);
    setSessionWindowRestoreFeedback("");
    try {
      const result = await api.restoreSessionWindows();
      setSessionWindowRestoreFeedback(buildSessionWindowRestoreFeedback(result));
    } catch (error) {
      setSessionWindowRestoreFeedback(
        error instanceof Error ? error.message : "Could not restore previous sessions.",
      );
    } finally {
      setSessionWindowRestorePending(false);
    }
  };

  useEffect(() => {
    if (isSettingsWindowMode || isMemoryReviewWindowMode) return;
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      setAuxiliarySessionSummaries([]);
      setAuxiliaryDataState("ready");
      return;
    }

    const refresher = createHomeAuxiliarySessionRefresher({
      fetchAuxiliarySessionSummaries: () => withmateApi.listOpenAuxiliarySessionSummaries(),
      setAuxiliarySessionSummaries: (sessions) => {
        setAuxiliarySessionSummaries((current) =>
          resolveHomeAuxiliarySessionSummariesState(current, sessions),
        );
      },
      onLoadState: (state) => {
        if (state === "ready") {
          hasLoadedAuxiliarySessionSummariesRef.current = true;
        }
        if (state !== "loading" || !hasLoadedAuxiliarySessionSummariesRef.current) {
          setAuxiliaryDataState((current) => state === "loading" && current === "error" ? current : state);
        }
        if (state === "ready") {
          setAuxiliaryLoadFeedback("");
        }
      },
      onError: (error) => {
        console.error(error);
        setAuxiliaryLoadFeedback(error instanceof Error ? error.message : "Could not load Auxiliary sessions.");
      },
    });

    const monitorRunStates = new Map<string, LiveSessionRunStatus>();
    auxiliarySessionRefresherRef.current = refresher;
    const unsubscribeLiveRun = withmateApi.subscribeLiveSessionRunStatus((sessionId, status) => {
      const nextState = { runState: status?.runState, cancellationState: status?.cancellationState, approvalPending: status?.approvalPending };
      const previousState = monitorRunStates.get(sessionId);
      if (previousState
        && previousState.runState === nextState.runState
        && previousState.cancellationState === nextState.cancellationState
        && previousState.approvalPending === nextState.approvalPending) return;
      monitorRunStates.set(sessionId, nextState);
      // Notifications invalidate snapshots; only fresh Main queries supply the display state.
      void refreshSessionSummaries("preserve");
      refresher.refresh();
    });
    const unsubscribeSessionInvalidation = withmateApi.subscribeSessionInvalidation(() => {
      refresher.refresh();
    });
    refresher.refresh();

    return () => {
      auxiliarySessionRefresherRef.current = null;
      refresher.dispose();
      unsubscribeLiveRun();
      unsubscribeSessionInvalidation();
    };
  }, [isMemoryReviewWindowMode, isSettingsWindowMode, openSessionWindowIds, refreshSessionSummaries]);

  const sessionProjection = useMemo(
    () => buildHomeSessionProjection(
      sessions,
      openSessionWindowIds,
      sessionSearchText,
      auxiliarySessionSummaries,
      new Set([...sessionSummariesState.recentPages, ...sessionSummariesState.pinnedPages]
        .flatMap(({ page }) => page.entries.map(({ id }) => id))),
    ),
    [
      auxiliarySessionSummaries,
      openSessionWindowIds,
      sessionSearchText,
      sessions,
      sessionSummariesState.recentPages,
      sessionSummariesState.pinnedPages,
    ],
  );
  const {
    filteredSessionEntries,
    approvalMonitorEntries,
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
      workspacePathInput: launchDraft.workspacePathInput,
      workspaceValidation: launchDraft.workspaceValidation,
      workspaceValidationMessage: launchDraft.workspaceValidationMessage,
      launchCharacterId: launchDraft.characterId,
      launchCharacterSelectionMode: launchDraft.characterSelectionMode,
      characterEntries: launchCharacterCatalog.entries,
      charactersLoaded: launchCharacterCatalog.status === "loaded",
      characterLoadStatus: launchCharacterCatalog.status,
      sessionCharacterUsageLoadStatus: sessionSummariesState.characterUsageStatus,
      openSessionWindowIdsLoadStatus: openSessionWindowIdsState.status,
      appSettings,
      modelCatalog,
      providerLoadStatus: modelCatalogLoadStatus === "error" || appSettingsLoadStatus === "error"
        ? "error"
        : modelCatalogLoadStatus === "loading" || appSettingsLoadStatus === "loading"
          ? "loading"
          : "loaded",
      providerLoadError: modelCatalogLoadStatus === "error"
        ? modelCatalogLoadError
        : appSettingsLoadStatus === "error"
          ? appSettingsLoadError
          : "",
    }),
    [
      appSettings,
      appSettingsLoadError,
      appSettingsLoadStatus,
      launchCharacterCatalog,
      launchDraft,
      modelCatalog,
      modelCatalogLoadError,
      modelCatalogLoadStatus,
      openSessionWindowIdsState.status,
      sessionSummariesState.characterUsageStatus,
    ],
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

  const openSessionsLoadStatus = openSessionWindowIdsState.status === "loaded"
    ? sessionSummariesState.openStatus
    : openSessionWindowIdsState.status;
  const randomLaunchFeedback = launchDraft.characterSelectionMode === "random"
    ? resolveRandomHomeLaunchFeedback(sessionSummariesState.characterUsageStatus, openSessionsLoadStatus)
    : "";
  const launchFeedback = launchFeedbackState.source === "readiness" ? randomLaunchFeedback : launchFeedbackState.message;
  useEffect(() => {
    if (!randomLaunchFeedback) {
      setLaunchFeedbackState((current) => current.source === "readiness" ? { message: "", source: "launch" } : current);
    }
  }, [randomLaunchFeedback]);

  const homeLaunchHandlers = buildHomeLaunchHandlers({
    launchDraft,
    launchDialogAttemptRef,
    launchStarting,
    launchLifetimeRef,
    onDetachedResult: (result) => setLaunchResults((current) => [...current, result]),
    mateState,
    mateProfile,
    enabledLaunchProviders,
    characterEntries: launchCharacterCatalog.entries,
    selectedLaunchProviderId: selectedLaunchProvider?.id ?? null,
    sessions: sessionSummariesState.openSummaries,
    sessionCharacterUsage: sessionSummariesState.characterUsage,
    openSessionWindowIds,
    openSessionWindowIdsLoadStatus: openSessionsLoadStatus,
    sessionCharacterUsageLoadStatus: sessionSummariesState.characterUsageStatus,
    refreshCharacterEntries: async () => {
      const api = getWithMateApi();
      if (!api) {
        throw new Error("A desktop runtime is required to refresh characters.");
      }
      return refreshCharacterEntries(api);
    },
    setLaunchCharacterCatalog,
    setLaunchFeedback,
    setLaunchStarting,
    setLaunchDraft,
    pickWorkspaceDirectory: async () => withWithMateApi((api) => api.pickDirectory()),
    scheduleWorkspaceValidation: (targetPath) => workspaceValidationControllerRef.current?.schedule(targetPath),
    cancelWorkspaceValidation: () => workspaceValidationControllerRef.current?.cancel(),
    openSessionWindow,
    createSession: async (input) => await withWithMateApi((api) => api.createSession(input)),
    upsertSessionSummary: (summary) => {
      setSessionSummariesState((current) => ({
        ...current,
        summaries: [
          summary,
          ...current.summaries.filter((session) => session.id !== summary.id),
        ],
      }));
      void refreshSessionSummaries("preserve");
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
    setMateAvatarAction,
    setLaunchFeedback,
    refreshSessionSummaries: async () => {
      await refreshSessionSummaries("preserve");
    },
  });

  const settingsDraftHandlers = buildSettingsDraftHandlers({
    setSettingsDraft,
    clearSettingsFeedback: () => setSettingsFeedback(""),
  });

  const providerSettingRows = useMemo<HomeProviderSettingRow[]>(
    () => buildHomeProviderSettingRows(modelCatalog, settingsDraft),
    [
      modelCatalog,
      settingsDraft,
    ],
  );
  const persistedSettingsDraft = useMemo(
    () => modelCatalogLoadStatus === "loaded"
      ? buildPersistedAppSettingsFromRows(settingsDraft, providerSettingRows)
      : settingsDraft,
    [modelCatalogLoadStatus, providerSettingRows, settingsDraft],
  );
  persistedSettingsDraftRef.current = persistedSettingsDraft;
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
    getPersistedSettingsDraft: () => persistedSettingsDraftRef.current ?? persistedSettingsDraft,
    setSettingsFeedback,
    setMemoryV6Diagnostics,
    getSessionCleanupCutoffDate: () => sessionCleanupCutoffDate,
    setDeletingOldSessions,
    refreshSessionSummaries: async () => {
      await refreshSessionSummaries("preserve");
    },
    onSettingsSaved: () => {
      const api = getWithMateApi();
      if (!api) {
        return;
      }
      void refreshMemoryV6Diagnostics(api).catch(() => undefined);
    },
  });

  const canUsePrimaryFeatures = mateState !== null;

  const baseSettingsContentProps: HomeSettingsContentBaseProps = {
    settingsDraft,
    providerSettingRows,
    modelCatalogRevisionLabel: String(modelCatalog?.revision ?? "-"),
    memoryV6Diagnostics,
    settingsDraftLoaded,
    memoryV6DiagnosticsLoadStatus,
    memoryV6DiagnosticsLoadError,
    onRetryMemoryV6Diagnostics: () => {
      setMemoryV6DiagnosticsLoadStatus("loading");
      setMemoryV6DiagnosticsRetry((current) => current + 1);
    },
    appSettingsLoadStatus,
    appSettingsLoadError,
    onRetryAppSettings: () => {
      setAppSettingsLoadStatus("loading");
      setAppSettingsLoadError("");
      setAppSettingsRetry((current) => current + 1);
    },
    modelCatalogLoadStatus,
    modelCatalogLoadError,
    onRetryModelCatalog: () => {
      setModelCatalogLoadStatus("loading");
      setModelCatalogLoadError("");
      setModelCatalogRetry((current) => current + 1);
    },
    settingsDirty,
    settingsFeedback,
    sessionCleanupCutoffDate,
    deletingOldSessions,
    onChangeSessionCleanupCutoffDate: setSessionCleanupCutoffDate,
    onOpenMemoryV6Review: () => void openMemoryV6ReviewWindow(),
    ...settingsDraftHandlers,
    ...settingsCommandHandlers,
  };

  const showSessionMonitorContextMenu = (
    kind: SessionMonitorEntryKind,
    sessionId: string,
    point: SessionMonitorContextMenuPoint,
  ) => {
    const api = getWithMateApi();
    if (!api) {
      return;
    }
    runSessionMonitorContextMenu(api, { kind, sessionId, point }, setSessionMonitorFeedback);
  };

  const openMonitorSession = async (sessionId: string, auxiliarySessionId?: string) => {
    setSessionMonitorFeedback("");
    try {
      await openSessionWindow(sessionId, auxiliarySessionId);
    } catch (error) {
      setSessionMonitorFeedback(error instanceof Error ? error.message : "Could not open session window.");
    }
  };


  const monitorFeedback = [sessionMonitorFeedback, sessionSummariesState.openError, auxiliaryLoadFeedback].filter(Boolean).join(" ");
  const retryMonitorLoad = sessionSummariesState.openError || auxiliaryDataState === "error" ? () => {
    if (sessionSummariesState.openError) void refreshSessionSummaries("preserve");
    if (auxiliaryDataState === "error") auxiliarySessionRefresherRef.current?.refresh();
  } : undefined;
  const sessionListFeedback = [
    sessionSummariesState.recentError && `Recent sessions: ${sessionSummariesState.recentError}`,
    sessionSummariesState.pinnedError && `Pinned sessions: ${sessionSummariesState.pinnedError}`,
    sessionSummariesState.recentPageError && `More recent sessions: ${sessionSummariesState.recentPageError}`,
    sessionSummariesState.pinnedPageError && `More pinned sessions: ${sessionSummariesState.pinnedPageError}`,
  ].filter(Boolean).join(" ");
  const sessionListLoadStatus = sessionSummariesState.recentStatus === "loading" || sessionSummariesState.pinnedStatus === "loading"
    ? "loading"
    : sessionSummariesState.recentStatus === "error" || sessionSummariesState.pinnedStatus === "error" ? "error" : "loaded";

  const { settingsContent, mateSetupContent, monitorContent } = buildHomeWindowContentSlots({
    settingsContent: buildHomeSettingsContentProps(baseSettingsContentProps),
    mateSetupContent: buildHomeMateSetupContentProps({
      mateState,
      mateProfile,
      mateDisplayName,
      mateCreating,
      mateAvatarAction,
      mateCreationFeedback,
      onChangeDisplayName: mateProfileHandlers.onChangeDisplayName,
      onSubmit: mateProfileHandlers.onSubmit,
      onOpenSettings: () => void openSettingsWindow(),
      onCancelEdit: mateProfileHandlers.onCancelEdit,
      onSelectAvatar: mateProfileHandlers.onSelectAvatar,
      onClearAvatar: mateProfileHandlers.onClearAvatar,
    }),
    monitorContent: buildHomeMonitorContentProps({
      approvalEntries: approvalMonitorEntries,
      providerQuota: <ProviderQuotaOverview api={getWithMateApi()} />,
      runningEntries: runningMonitorEntries,
      nonRunningEntries: nonRunningMonitorEntries,
      auxiliaryDataState,
      sessionWindowsDataState: openSessionsLoadStatus,
      runningEmptyMessage: monitorRunningEmptyMessage,
      nonRunningEmptyMessage: monitorCompletedEmptyMessage,
      feedback: monitorFeedback,
      onRetry: retryMonitorLoad,
      onOpenSession: openMonitorSession,
      onShowContextMenu: showSessionMonitorContextMenu,
    }),
  });

  const { header, recentSessionsPanel, rightPane, launchDialog } = buildHomeDashboardSlots({
    recentSessionsPanel: buildHomeRecentSessionsPanelProps({
      filteredSessionEntries,
      handlers: {
        onOpenSession: (sessionId) => void openSessionWindow(sessionId),
        onSetSessionPinned: (sessionId, isPinned) => void setSessionPinned(sessionId, isPinned),
      },
      hasMore: sessionSummariesState.hasMoreRecent || sessionSummariesState.hasMorePinned,
      loadingMore: sessionSummariesState.loadingRecentPage || sessionSummariesState.loadingPinnedPage,
      onLoadMore: loadNextSessionSummaryPage,
      pendingSessionPinIds,
      sessionSummaryLoadStatus: sessionListLoadStatus,
      feedback: sessionListFeedback,
      onRetry: retrySessionSummaryLoad,
      launchResults: launchDraft.open ? null : (
        <HomeLaunchResults
          results={launchResults}
          onDismiss={(result) => setLaunchResults((current) => current.filter((entry) => entry !== result))}
        />
      ),
    }),
    rightPane: buildHomeRightPaneProps({
      searchText: sessionSearchText,
      searchInputText,
      canCreateSession: canUsePrimaryFeatures,
      providerQuota: <ProviderQuotaOverview api={getWithMateApi()} />,
      rightPaneView,
      approvalMonitorEntries,
      runningMonitorEntries,
      nonRunningMonitorEntries,
      auxiliaryDataState,
      sessionWindowsDataState: openSessionsLoadStatus,
      monitorRunningEmptyMessage,
      monitorNonRunningEmptyMessage: monitorCompletedEmptyMessage,
      sessionMonitorFeedback: monitorFeedback,
      onRetrySessionSummaries: retryMonitorLoad,
      characterEntries,
      characterLoadStatus,
      characterListFeedback,
      monitorWindowIcon: renderHomeMonitorWindowIcon(),
      handlers: {
        onChangeSearchText: onChangeInputText,
        onSearchCompositionStart: onCompositionStart,
        onSearchCompositionEnd: onCompositionEnd,
        onOpenLaunchDialog: homeLaunchHandlers.onOpenLaunchDialog,
        onChangeRightPaneView: setRightPaneView,
        onOpenSessionMonitorWindow: () => void openSessionMonitorWindow(),
        onOpenSettingsWindow: () => void openSettingsWindow(),
        onRestoreSessionWindows: () => void restoreSessionWindows(),
        onCreateCharacter: () => void openCharacterEditorWindow(),
        onEditCharacter: (characterId) => void openCharacterEditorWindow(characterId),
        onOpenSession: openMonitorSession,
        onShowSessionMonitorContextMenu: showSessionMonitorContextMenu,
      },
      sessionWindowRestoreIds: pendingSessionWindowRestoreIds,
      sessionWindowRestorePending,
      sessionWindowRestoreFeedback,
      mateLoadStatus,
      mateLoadError,
      onRetryMateStatus: () => setHomeStateRetry((current) => current + 1),
      onRetryCharacters: () => setCharacterRetry((current) => current + 1),
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
      onStartSession: () => void homeLaunchHandlers.onStartSession(),
    }),
  });

  return (
    <HomeAppRouter
      desktopRuntime={desktopRuntime}
      homePageClassName={homePageClassName}
      isSettingsWindowMode={isSettingsWindowMode}
      isMemoryReviewWindowMode={isMemoryReviewWindowMode}
      getMemoryReviewApi={getWithMateApi}
      settingsContent={settingsContent}
      mateProfileEditorOpen={mateProfileEditorOpen}
      mateSetupContent={mateSetupContent}
      isMonitorWindowMode={isMonitorWindowMode}
      monitorContent={monitorContent}
      header={header}
      rightPaneLabel={rightPaneView === "monitor" ? "Monitor" : rightPaneView === "previews" ? "Previews" : "Characters"}
      recentSessionsPanel={recentSessionsPanel}
      rightPane={rightPane}
      launchDialog={launchDialog}
    />
  );
}
