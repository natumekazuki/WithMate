import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  createDefaultAppSettings,
  type AppSettings,
} from "./provider-settings-state.js";
import { startAppSettingsSubscription } from "./app-settings-subscription.js";
import { type SessionCharacterUsage, type SessionSummary } from "./session-state.js";
import {
  startSessionSummaryInvalidationSubscription,
  type SessionSummariesLoadStatus,
} from "./session-summary-subscription.js";
import {
  type AuxiliarySessionSummary,
} from "./auxiliary-session-state.js";
import { type ModelCatalogSnapshot } from "./model-catalog.js";
import { startModelCatalogSubscription } from "./model-catalog-subscription.js";
import type { OpenSessionWindowIdsState } from "./open-session-window-subscription.js";
import type { MemoryV6Diagnostics } from "./memory-v6/memory-diagnostics-state.js";
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
import {
  buildHomeSessionSummaryEntries,
  fetchHomeSessionSummaryPage,
  fetchHomeSessionSummaryPages,
  fetchHomeSessionSummarySnapshot,
  listOpenSessionSummaryEntries,
  type HomeLoadedSessionSummaryPage,
  type HomeSessionSummaryPageCollection,
} from "./home/home-session-summary-query.js";
import {
  buildHomeSessionQueryKey,
  HomeSessionQueryGeneration,
} from "./home/home-session-query-generation.js";
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

type HomeRightPaneView = "monitor" | "characters";

type HomeSessionSummariesState = {
  status: SessionSummariesLoadStatus;
  summaries: SessionSummary[];
  recentPages: HomeLoadedSessionSummaryPage[];
  recentCursor: string | null;
  hasMoreRecent: boolean;
  pinnedPages: HomeLoadedSessionSummaryPage[];
  pinnedCursor: string | null;
  hasMorePinned: boolean;
  loadingRecentPage: boolean;
  loadingPinnedPage: boolean;
  openSummaries: SessionSummary[];
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
  const settingsDirtyRef = useRef(false);
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
      setLaunchFeedback(error instanceof Error ? error.message : "Home のSession一覧読み込みに失敗したよ。");
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
      setLaunchFeedback(error instanceof Error ? error.message : "Session一覧の追加読み込みに失敗したよ。");
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
      void refreshSessionSummariesRef.current("preserve");
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

    let unsubscribeCompanionSessions: (() => void) | null = null;
    unsubscribeCompanionSessions = startCompanionSessionSummariesSubscription({
      api: withmateApi,
      applySummaries: setCompanionSessions,
      onInitialLoadError: handleInitialSummaryLoadError,
    });

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
      unsubscribeCompanionSessions?.();
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
    sessionCharacterUsage: sessionSummariesState.characterUsage,
    openSessionWindowIds,
    openSessionWindowIdsLoadStatus: openSessionWindowIdsState.status,
    sessionCharacterUsageLoadStatus: sessionSummariesState.characterUsageStatus,
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
      void refreshSessionSummariesRef.current("preserve");
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
    refreshSessionSummaries: async () => {
      await refreshSessionSummariesRef.current("preserve");
    },
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
        setSettingsFeedback(error instanceof Error ? error.message : "Memory V6 diagnostics の再読み込みに失敗したよ。");
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
      hasMore: sessionSummariesState.hasMoreRecent || sessionSummariesState.hasMorePinned,
      loadingMore: sessionSummariesState.loadingRecentPage || sessionSummariesState.loadingPinnedPage,
      onLoadMore: loadNextSessionSummaryPage,
      pendingSessionPinIds,
    }),
    rightPane: buildHomeRightPaneProps({
      rightPaneView,
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
