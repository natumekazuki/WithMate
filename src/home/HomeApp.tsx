import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  createDefaultAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import { startAppSettingsSubscription } from "../settings/app-settings-subscription.js";
import {
  projectHomeSessionSummary,
  type HomeSessionSummary,
  type SessionCharacterUsage,
} from "../../src-shared/session/session-state.js";
import {
  startSessionSummaryInvalidationSubscription,
  type SessionSummariesLoadStatus,
} from "../chat/runtime/session-summary-subscription.js";
import {
  type AuxiliarySessionSummary,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
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
  resolveLaunchCharacterId,
  type HomeCharacterLoadStatus,
  type HomeLaunchDraft,
} from "./home-launch-state.js";
import {
  createHomeLaunchWorkspaceValidationController,
  type HomeLaunchWorkspaceValidationController,
} from "./home-launch-workspace-validation.js";
import { resolveSelectedLaunchProviderDraftId } from "../launch/launch-provider-selection.js";
import type { ProviderLaunchLoadStatus } from "../launch/provider-launch-picker.js";
import { buildHomeMateProfileHandlers } from "./home-mate-profile-handlers.js";
import {
  buildHomeSessionProjection,
  type HomeMonitorAuxiliaryDataState,
} from "./home-session-projection.js";
import { buildHomeLaunchHandlers } from "./home-launch-handlers.js";
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
import {
  buildHomeSessionSummaryEntries,
  fetchHomeSessionSummaryPage,
  fetchHomeSessionSummaryPages,
  fetchHomeSessionSummarySnapshot,
  listOpenSessionSummaryEntries,
  type HomeLoadedSessionSummaryPage,
  type HomeSessionSummaryPageCollection,
} from "./home-session-summary-query.js";
import {
  buildHomeSessionQueryKey,
  HomeSessionQueryGeneration,
} from "./home-session-query-generation.js";
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
import { getWithMateApi, isDesktopRuntime, withWithMateApi } from "../app/renderer-withmate-api.js";
import {
  type MateProfile,
  type MateStorageState,
} from "../../src-shared/mate/mate-state.js";
import { buildHomeMateSetupContentProps } from "../mate/home-mate-setup-props.js";
import { buildMateStatusRefreshers } from "../mate/mate-status-refreshers.js";
import { buildHomeMonitorContentProps } from "./home-monitor-content-props.js";
import { renderHomeMonitorWindowIcon, renderHomeSearchIcon } from "./home-icons.js";
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

type HomeRightPaneView = "monitor" | "characters";

type HomeSessionSummariesState = {
  status: SessionSummariesLoadStatus;
  summaries: HomeSessionSummary[];
  recentPages: HomeLoadedSessionSummaryPage[];
  recentCursor: string | null;
  hasMoreRecent: boolean;
  pinnedPages: HomeLoadedSessionSummaryPage[];
  pinnedCursor: string | null;
  hasMorePinned: boolean;
  loadingRecentPage: boolean;
  loadingPinnedPage: boolean;
  openSummaries: HomeSessionSummary[];
  characterUsageStatus: SessionSummariesLoadStatus;
  characterUsage: SessionCharacterUsage[];
};

type HomeSessionSummaryRefreshMode = "replace" | "preserve";

function createEmptyHomeSessionSummariesState(): HomeSessionSummariesState {
  return {
    status: "loading",
    summaries: [],
    recentPages: [],
    recentCursor: null,
    hasMoreRecent: false,
    pinnedPages: [],
    pinnedCursor: null,
    hasMorePinned: false,
    loadingRecentPage: false,
    loadingPinnedPage: false,
    openSummaries: [],
    characterUsageStatus: "loading",
    characterUsage: [],
  };
}

function applyHomeSessionSummaryPages(
  current: HomeSessionSummariesState,
  pages: HomeSessionSummaryPageCollection,
): HomeSessionSummariesState {
  const recentPage = pages.recent.at(-1)?.page;
  const pinnedPage = pages.pinned.at(-1)?.page;
  return {
    ...current,
    summaries: buildHomeSessionSummaryEntries(pages),
    recentPages: pages.recent,
    recentCursor: recentPage?.nextCursor ?? null,
    hasMoreRecent: recentPage?.hasMore ?? false,
    pinnedPages: pages.pinned,
    pinnedCursor: pinnedPage?.nextCursor ?? null,
    hasMorePinned: pinnedPage?.hasMore ?? false,
    openSummaries: pages.open,
  };
}

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
  const [openSessionWindowIdsState, setOpenSessionWindowIdsState] = useState<OpenSessionWindowIdsState>({
    status: "loading",
    sessionIds: [],
  });
  const openSessionWindowIds = openSessionWindowIdsState.sessionIds;
  const [sessionSearchText, setSessionSearchText] = useState("");
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
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [modelCatalogLoadStatus, setModelCatalogLoadStatus] = useState<ProviderLaunchLoadStatus>("loading");
  const [modelCatalogLoadError, setModelCatalogLoadError] = useState("");
  const [appSettingsLoadStatus, setAppSettingsLoadStatus] = useState<ProviderLaunchLoadStatus>("loading");
  const [appSettingsLoadError, setAppSettingsLoadError] = useState("");
  const [characterEntries, setCharacterEntries] = useState<CharacterCatalogEntry[]>([]);
  const [characterListFeedback, setCharacterListFeedback] = useState("");
  const [charactersLoaded, setCharactersLoaded] = useState(false);
  const [characterLoadStatus, setCharacterLoadStatus] = useState<HomeCharacterLoadStatus>("loading");
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
  const settingsDirtyRef = useRef(false);
  const persistedSettingsDraftRef = useRef<AppSettings | null>(null);
  const settingsHydratedRef = useRef(!isSettingsWindowMode);
  const workspaceValidationControllerRef = useRef<HomeLaunchWorkspaceValidationController | null>(null);
  const sessionQueryKey = buildHomeSessionQueryKey(sessionSearchText, openSessionWindowIds);
  const sessionQueryGenerationRef = useRef<HomeSessionQueryGeneration | null>(null);
  const previousSessionSearchTextRef = useRef(sessionSearchText);
  const sessionRefreshModeRef = useRef<HomeSessionSummaryRefreshMode>("replace");
  if (sessionQueryGenerationRef.current === null) {
    sessionQueryGenerationRef.current = new HomeSessionQueryGeneration(sessionQueryKey);
  }
  const refreshSessionSummariesRef = useRef<
    (mode?: HomeSessionSummaryRefreshMode) => Promise<void>
  >(() => Promise.resolve());
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

  useLayoutEffect(() => {
    const searchChanged = previousSessionSearchTextRef.current !== sessionSearchText;
    sessionQueryGenerationRef.current!.syncQueryKey(sessionQueryKey);
    sessionRefreshModeRef.current = searchChanged ? "replace" : "preserve";
    previousSessionSearchTextRef.current = sessionSearchText;
    if (isSettingsWindowMode || isMemoryReviewWindowMode || !getWithMateApi()) {
      return;
    }
    if (searchChanged) {
      setSessionSummariesState(createEmptyHomeSessionSummariesState());
    }
  }, [isMemoryReviewWindowMode, isSettingsWindowMode, sessionQueryKey, sessionSearchText]);

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

  const refreshBoundedSessionSummaries = async (
    mode: HomeSessionSummaryRefreshMode = "preserve",
  ): Promise<void> => {
    const api = getWithMateApi();
    if (!api) {
      return;
    }

    const requestToken = sessionQueryGenerationRef.current!.beginRequest();
    const searchText = sessionSearchText;
    const currentOpenSessionIds = openSessionWindowIds;
    const currentPages: HomeSessionSummaryPageCollection = {
      recent: sessionSummariesState.recentPages,
      pinned: sessionSummariesState.pinnedPages,
      open: sessionSummariesState.openSummaries,
    };
    if (mode === "replace") {
      setSessionSummariesState(createEmptyHomeSessionSummariesState());
    } else {
      setSessionSummariesState((current) => ({
        ...current,
        loadingRecentPage: false,
        loadingPinnedPage: false,
      }));
    }

    try {
      const refreshedPages = mode === "replace"
        ? await fetchHomeSessionSummarySnapshot(api, searchText, currentOpenSessionIds).then((snapshot) => ({
          recent: [{ requestCursor: null, page: snapshot.recent }],
          pinned: [{ requestCursor: null, page: snapshot.pinned }],
          open: snapshot.open,
          characterUsage: snapshot.characterUsage,
        }))
        : await Promise.all([
          fetchHomeSessionSummaryPages(api, "recent", searchText, currentPages.recent.length),
          fetchHomeSessionSummaryPages(api, "pinned", searchText, currentPages.pinned.length),
          listOpenSessionSummaryEntries(api, currentOpenSessionIds),
          api.listSessionCharacterUsage(),
        ]).then(([recent, pinned, open, characterUsage]) => ({
          recent,
          pinned,
          open,
          characterUsage,
        }));
      if (!sessionQueryGenerationRef.current!.isCurrent(requestToken)) {
        return;
      }
      setSessionSummariesState((current) => ({
        ...applyHomeSessionSummaryPages(current, refreshedPages),
        status: "loaded",
        loadingRecentPage: false,
        loadingPinnedPage: false,
        characterUsageStatus: "loaded",
        characterUsage: refreshedPages.characterUsage,
      }));
    } catch (error) {
      if (!sessionQueryGenerationRef.current!.isCurrent(requestToken)) {
        return;
      }
      setSessionSummariesState((current) => ({
        ...current,
        status: "error",
        characterUsageStatus: "error",
      }));
      setLaunchFeedback(error instanceof Error ? error.message : "Could not load Home sessions.");
    }
  };
  refreshSessionSummariesRef.current = refreshBoundedSessionSummaries;

  const loadMoreSessionSummaryPage = async (scope: "recent" | "pinned"): Promise<void> => {
    const api = getWithMateApi();
    const pages = scope === "recent" ? sessionSummariesState.recentPages : sessionSummariesState.pinnedPages;
    const cursor = pages.at(-1)?.page.nextCursor
      ?? (scope === "recent" ? sessionSummariesState.recentCursor : sessionSummariesState.pinnedCursor);
    const hasMore = scope === "recent" ? sessionSummariesState.hasMoreRecent : sessionSummariesState.hasMorePinned;
    const loading = scope === "recent"
      ? sessionSummariesState.loadingRecentPage
      : sessionSummariesState.loadingPinnedPage;
    if (!api || !cursor || !hasMore || loading) {
      return;
    }

    const requestToken = sessionQueryGenerationRef.current!.beginRequest();
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
      }));
    } catch (error) {
      if (!sessionQueryGenerationRef.current!.isCurrent(requestToken)) {
        return;
      }
      setSessionSummariesState((current) => ({
        ...current,
        ...(scope === "recent" ? { loadingRecentPage: false } : { loadingPinnedPage: false }),
      }));
      setLaunchFeedback(error instanceof Error ? error.message : "Could not load more sessions.");
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
      void refreshSessionSummariesRef.current("preserve");
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
      applyLoadedCharacterEntries(entries);
      setCharacterListFeedback("");
      setCharactersLoaded(true);
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
    setMemoryV6Diagnostics(await api.getMemoryV6Diagnostics());
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
      setLaunchFeedback(error instanceof Error ? error.message : "Could not load Home.");
    };

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
      setMateCreationFeedback(error instanceof Error ? error.message : "Could not load app state.");
    });

    void refreshCharacterEntries(withmateApi).catch((error) => {
      if (!active) {
        return;
      }

      setCharacterListFeedback(error instanceof Error ? error.message : "Could not load characters.");
    });
    void refreshMemoryV6Diagnostics(withmateApi).catch((error) => {
      if (!active) {
        return;
      }

      setSettingsFeedback(error instanceof Error ? error.message : "Could not load Memory V6 diagnostics.");
    });

    const unsubscribeModelCatalog = startModelCatalogSubscription({
      api: withmateApi,
      enabled: true,
      subscribe: true,
      applyModelCatalog: (snapshot) => {
        setModelCatalog(snapshot);
        setModelCatalogLoadStatus("loaded");
        setModelCatalogLoadError("");
        setModelCatalogLoadSettled(true);
      },
      onInitialLoadError: (error) => {
        const message = error instanceof Error ? error.message : "Could not load model catalog.";
        setModelCatalog(null);
        setModelCatalogLoadStatus("error");
        setModelCatalogLoadError(message);
        setModelCatalogLoadSettled(true);
        setSettingsFeedback(message);
      },
    });
    const unsubscribeAppSettings = startAppSettingsSubscription({
      api: withmateApi,
      loadInitial: true,
      applyAppSettings: (settings) => {
        setAppSettingsLoadStatus("loaded");
        setAppSettingsLoadError("");
        applyIncomingAppSettings(settings, { force: isSettingsWindowMode });
      },
      onInitialLoadError: (error) => {
        const message = error instanceof Error ? error.message : "Could not load app state.";
        setAppSettingsLoadStatus("error");
        setAppSettingsLoadError(message);
        setMateCreationFeedback(message);
      },
    });

    return () => {
      active = false;
      unsubscribeModelCatalog();
      unsubscribeAppSettings();
    };
  }, []);

  useEffect(() => {
    if (isSettingsWindowMode || isMemoryReviewWindowMode || !getWithMateApi()) {
      return;
    }

    const timer = window.setTimeout(() => {
      void refreshSessionSummariesRef.current(sessionRefreshModeRef.current);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [isMemoryReviewWindowMode, isSettingsWindowMode, openSessionWindowIds, sessionSearchText]);

  useEffect(() => {
    if (isSettingsWindowMode || isMemoryReviewWindowMode) {
      return;
    }

    return startSessionSummaryInvalidationSubscription({
      api: getWithMateApi(),
      onInvalidation: () => {
        void refreshSessionSummariesRef.current("preserve");
      },
    });
  }, [isMemoryReviewWindowMode, isSettingsWindowMode]);

  useEffect(() => {
    if (isSettingsWindowMode || isMemoryReviewWindowMode || !getWithMateApi()) {
      return;
    }

    let refreshInFlight = false;
    const refreshOnFocus = () => {
      if (refreshInFlight) {
        return;
      }
      refreshInFlight = true;
      void refreshSessionSummariesRef.current("preserve").finally(() => {
        refreshInFlight = false;
      });
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [isMemoryReviewWindowMode, isSettingsWindowMode]);

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
        setCharacterListFeedback(error instanceof Error ? error.message : "Could not refresh characters.");
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
          setAuxiliaryDataState(state);
        }
        if (state === "ready" || (state === "loading" && !hasLoadedAuxiliarySessionSummariesRef.current)) {
          setAuxiliaryLoadFeedback("");
        }
      },
      onError: (error) => {
        console.error(error);
        setAuxiliaryLoadFeedback(error instanceof Error ? error.message : "Could not load Auxiliary sessions.");
      },
    });

    refresher.refresh();
    const unsubscribeLiveRun = withmateApi.subscribeLiveSessionRun(() => {
      refresher.refresh();
    });
    const unsubscribeSessionInvalidation = withmateApi.subscribeSessionInvalidation(() => {
      refresher.refresh();
    });

    return () => {
      refresher.dispose();
      unsubscribeLiveRun();
      unsubscribeSessionInvalidation();
    };
  }, [openSessionWindowIds]);

  const sessionProjection = useMemo(
    () => buildHomeSessionProjection(
      sessions,
      openSessionWindowIds,
      sessionSearchText,
      auxiliarySessionSummaries,
    ),
    [
      auxiliarySessionSummaries,
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
      characterEntries,
      charactersLoaded,
      characterLoadStatus,
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
      characterEntries,
      characterLoadStatus,
      charactersLoaded,
      launchDraft,
      modelCatalog,
      modelCatalogLoadError,
      modelCatalogLoadStatus,
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

  const homeLaunchHandlers = buildHomeLaunchHandlers({
    launchDraft,
    launchStarting,
    mateState,
    mateProfile,
    enabledLaunchProviders,
    characterEntries,
    selectedLaunchProviderId: selectedLaunchProvider?.id ?? null,
    sessions,
    sessionCharacterUsage: sessionSummariesState.characterUsage,
    openSessionWindowIds,
    openSessionWindowIdsLoadStatus: openSessionWindowIdsState.status,
    sessionCharacterUsageLoadStatus: sessionSummariesState.characterUsageStatus,
    refreshCharacterEntries: async () => {
      const api = getWithMateApi();
      if (!api) {
        throw new Error("A desktop runtime is required to refresh characters.");
      }
      return refreshCharacterEntries(api);
    },
    setCharactersLoaded,
    setCharacterLoadStatus,
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
      void refreshSessionSummariesRef.current("preserve");
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
    refreshSessionSummaries: async () => {
      await refreshSessionSummariesRef.current("preserve");
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
    () => buildPersistedAppSettingsFromRows(settingsDraft, providerSettingRows),
    [providerSettingRows, settingsDraft],
  );
  persistedSettingsDraftRef.current = persistedSettingsDraft;
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
    getPersistedSettingsDraft: () => persistedSettingsDraftRef.current ?? persistedSettingsDraft,
    setSettingsFeedback,
    setMemoryV6Diagnostics,
    getSessionCleanupCutoffDate: () => sessionCleanupCutoffDate,
    setDeletingOldSessions,
    refreshSessionSummaries: async () => {
      await refreshSessionSummariesRef.current("preserve");
    },
    onSettingsSaved: () => {
      const api = getWithMateApi();
      if (!api) {
        return;
      }
      void refreshMemoryV6Diagnostics(api).catch((error) => {
        setSettingsFeedback(error instanceof Error ? error.message : "Could not refresh Memory V6 diagnostics.");
      });
    },
  });

  const isMateStateLoading = mateState === null;
  const canUsePrimaryFeatures = mateState !== null;

  const baseSettingsContentProps: HomeSettingsContentBaseProps = {
    settingsDraft,
    providerSettingRows,
    modelCatalogRevisionLabel: String(modelCatalog?.revision ?? "-"),
    memoryV6Diagnostics,
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


  const monitorFeedback = sessionMonitorFeedback || auxiliaryLoadFeedback;

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
      auxiliaryDataState,
      sessionWindowsDataState: openSessionWindowIdsState.status,
      runningEmptyMessage: monitorRunningEmptyMessage,
      nonRunningEmptyMessage: monitorCompletedEmptyMessage,
      feedback: monitorFeedback,
      onOpenSession: openMonitorSession,
      onShowContextMenu: showSessionMonitorContextMenu,
    }),
  });

  const { recentSessionsPanel, rightPane, launchDialog } = buildHomeDashboardSlots({
    recentSessionsPanel: buildHomeRecentSessionsPanelProps({
      filteredSessionEntries,
      normalizedSessionSearch,
      searchText: sessionSearchText,
      searchIcon: renderHomeSearchIcon(),
      handlers: {
        onChangeSearchText: setSessionSearchText,
        onOpenLaunchDialog: homeLaunchHandlers.onOpenLaunchDialog,
        onOpenSession: (sessionId) => void openSessionWindow(sessionId),
        onSetSessionPinned: (sessionId, isPinned) => void setSessionPinned(sessionId, isPinned),
      },
      canUsePrimaryFeatures,
      hasMore: sessionSummariesState.hasMoreRecent || sessionSummariesState.hasMorePinned,
      loadingMore: sessionSummariesState.loadingRecentPage || sessionSummariesState.loadingPinnedPage,
      onLoadMore: loadNextSessionSummaryPage,
      pendingSessionPinIds,
      sessionSummaryLoadStatus: sessionSummariesState.status,
    }),
    rightPane: buildHomeRightPaneProps({
      rightPaneView,
      runningMonitorEntries,
      nonRunningMonitorEntries,
      auxiliaryDataState,
      sessionWindowsDataState: openSessionWindowIdsState.status,
      monitorRunningEmptyMessage,
      monitorNonRunningEmptyMessage: monitorCompletedEmptyMessage,
      sessionMonitorFeedback: monitorFeedback,
      characterEntries,
      characterLoadStatus,
      characterListFeedback,
      monitorWindowIcon: renderHomeMonitorWindowIcon(),
      handlers: {
        onChangeRightPaneView: setRightPaneView,
        onOpenSessionMonitorWindow: () => void openSessionMonitorWindow(),
        onOpenSettingsWindow: () => void openSettingsWindow(),
        onRestoreSessionWindows: () => void restoreSessionWindows(),
        onCreateCharacter: () => void openCharacterEditorWindow(),
        onEditCharacter: (characterId) => void openCharacterEditorWindow(characterId),
        onOpenSession: openMonitorSession,
        onShowSessionMonitorContextMenu: showSessionMonitorContextMenu,
      },
      canUsePrimaryFeatures,
      sessionWindowRestoreIds: pendingSessionWindowRestoreIds,
      sessionWindowRestorePending,
      sessionWindowRestoreFeedback,
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
