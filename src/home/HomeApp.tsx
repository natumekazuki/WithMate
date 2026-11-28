import { useEffect, useMemo, useRef, useState } from "react";

import {
  createDefaultAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import { startAppSettingsSubscription } from "../settings/app-settings-subscription.js";
import { projectHomeSessionSummary } from "../../src-shared/session/session-state.js";
import { type ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { startModelCatalogSubscription } from "../settings/model-catalog-subscription.js";
import type { OpenSessionWindowIdsState } from "../app/open-session-window-subscription.js";
import { buildHomeLaunchProjection } from "./home-launch-projection.js";
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
import { buildHomeSessionProjection } from "./home-session-projection.js";
import {
  buildHomeLaunchHandlers,
  type HomeLaunchLifetime,
} from "./home-launch-handlers.js";
import { HomeLaunchResults } from "./HomeLaunchResults.js";
import {
  buildHomeProviderSettingRows,
  type HomeProviderSettingRow,
} from "../settings/settings-view-model.js";
import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import { HomeAppRouter } from "./HomeAppRouter.js";
import { buildHomeDashboardSlots } from "./HomeDashboardSlots.js";
import { buildHomeRecentSessionsPanelProps } from "./home-recent-sessions-panel-props.js";
import { mergePinnedSessionSummary } from "./session-pinning.js";
import { fetchHomeSessionSummaryPage } from "./home-session-summary-query.js";
import {
  buildHomeSessionQueryKey,
  HomeSessionQueryGeneration,
} from "./home-session-query-generation.js";
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
import { useSettingsFeedback } from "../settings/use-settings-feedback.js";
import { ProviderQuotaOverview } from "../provider-usage/provider-quota.js";
import {
  getWithMateApi,
  isDesktopRuntime,
  withWithMateApi,
} from "../app/renderer-withmate-api.js";
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
import { useHomeSessionMonitor } from "./use-home-session-monitor.js";
import {
  resolveRandomHomeLaunchReadiness,
  type HomeLaunchFeedbackSource,
  type HomeLaunchResult,
} from "./home-launch-actions.js";

import { homeRightPaneLabels, type HomeRightPaneView } from "./HomeHeader.js";

/** 表示モードに応じて Home、Monitor、設定に必要な購読と操作を各画面へ接続する。 */
export default function HomeApp() {
  const desktopRuntime = isDesktopRuntime();
  const homeWindowMode = useMemo(() => getHomeWindowMode(), []);
  const isMonitorWindowMode = homeWindowMode === "monitor";
  const isSettingsWindowMode = homeWindowMode === "settings";
  const [sessionSummariesState, setSessionSummariesState] =
    useState<HomeSessionSummariesState>(createEmptyHomeSessionSummariesState);
  const sessions = sessionSummariesState.summaries;
  const [openSessionWindowIdsState, setOpenSessionWindowIdsState] =
    useState<OpenSessionWindowIdsState>({
      status: "loading",
      sessionIds: [],
    });
  const openSessionWindowIds = openSessionWindowIdsState.sessionIds;
  const monitorSnapshot = useHomeSessionMonitor(
    !isSettingsWindowMode,
    openSessionWindowIds,
  );
  const {
    inputText: searchInputText,
    searchText: sessionSearchText,
    onChangeInputText,
    onCompositionStart,
    onCompositionEnd,
  } = useHomeSearchInput();
  const [pendingSessionPinIds, setPendingSessionPinIds] = useState<string[]>(
    [],
  );
  const [sessionWindowRestoreIds, setSessionWindowRestoreIds] = useState<
    string[]
  >([]);
  const [sessionWindowRestorePending, setSessionWindowRestorePending] =
    useState(false);
  const [sessionWindowRestoreFeedback, setSessionWindowRestoreFeedback] =
    useState("");
  const [sessionMonitorFeedback, setSessionMonitorFeedback] = useState("");
  const pendingSessionWindowRestoreIds = useMemo(
    () =>
      openSessionWindowIdsState.status === "loaded"
        ? selectPendingSessionWindowRestoreIds(
            sessionWindowRestoreIds,
            openSessionWindowIds,
          )
        : [],
    [
      openSessionWindowIds,
      openSessionWindowIdsState.status,
      sessionWindowRestoreIds,
    ],
  );
  const [rightPaneView, setRightPaneView] =
    useState<HomeRightPaneView>("monitor");
  const {
    settingsFeedback,
    settingsErrors,
    setSettingsFeedback,
    clearSettingsFeedback,
  } = useSettingsFeedback();
  const [sessionCleanupCutoffDate, setSessionCleanupCutoffDate] = useState("");
  const [deletingOldSessions, setDeletingOldSessions] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>(
    createDefaultAppSettings(),
  );
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(
    createDefaultAppSettings(),
  );
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(
    null,
  );
  const [modelCatalogLoadStatus, setModelCatalogLoadStatus] =
    useState<ProviderLaunchLoadStatus>("loading");
  const [modelCatalogLoadError, setModelCatalogLoadError] = useState("");
  const [modelCatalogRetry, setModelCatalogRetry] = useState(0);
  const [appSettingsLoadStatus, setAppSettingsLoadStatus] =
    useState<ProviderLaunchLoadStatus>("loading");
  const [appSettingsLoadError, setAppSettingsLoadError] = useState("");
  const [settingsDraftLoaded, setSettingsDraftLoaded] =
    useState(!isSettingsWindowMode);
  const [appSettingsRetry, setAppSettingsRetry] = useState(0);
  const [homeStateRetry, setHomeStateRetry] = useState(0);
  const [characterRetry, setCharacterRetry] = useState(0);
  const [characterEntries, setCharacterEntries] = useState<
    CharacterCatalogEntry[]
  >([]);
  const [characterListFeedback, setCharacterListFeedback] = useState("");
  const [characterLoadStatus, setCharacterLoadStatus] =
    useState<HomeCharacterLoadStatus>("loading");
  const [launchDraft, setLaunchDraft] = useState<HomeLaunchDraft>(() =>
    createClosedLaunchDraft(),
  );
  const launchDialogAttemptRef = useRef<object | null>(null);
  useEffect(
    () => () => {
      launchDialogAttemptRef.current = null;
    },
    [],
  );
  const [launchCharacterCatalog, setLaunchCharacterCatalog] =
    useState<HomeLaunchCharacterCatalog>({
      entries: [],
      status: "loading",
    });
  const [launchFeedbackState, setLaunchFeedbackState] = useState({
    message: "",
    source: "launch" as HomeLaunchFeedbackSource,
  });
  /** 起動時の通知を、準備待ちや作成失敗の表示を分けられるよう発生元と一緒に保存する。 */
  const setLaunchFeedback = (
    message: string,
    source: HomeLaunchFeedbackSource = "launch",
  ) => {
    setLaunchFeedbackState({ message, source });
  };
  const [launchStarting, setLaunchStarting] = useState(false);
  const launchLifetimeRef = useRef<HomeLaunchLifetime>({ starting: false });
  const [launchResults, setLaunchResults] = useState<HomeLaunchResult[]>([]);
  const [mateState, setMateState] = useState<MateStorageState | null>(null);
  const [mateLoadStatus, setMateLoadStatus] =
    useState<ProviderLaunchLoadStatus>("loading");
  const [mateLoadError, setMateLoadError] = useState("");
  const [mateProfile, setMateProfile] = useState<MateProfile | null>(null);
  const [mateDisplayName, setMateDisplayName] = useState("");
  const [mateCreating, setMateCreating] = useState(false);
  const [mateAvatarAction, setMateAvatarAction] =
    useState<MateAvatarAction>(null);
  const [mateCreationFeedback, setMateCreationFeedback] = useState("");
  const [mateProfileEditorOpen, setMateProfileEditorOpen] = useState(false);
  const settingsDirtyRef = useRef(false);
  const settingsDraftRef = useRef<AppSettings | null>(null);
  const settingsHydratedRef = useRef(!isSettingsWindowMode);
  const workspaceValidationControllerRef =
    useRef<DirectoryPathValidationController | null>(null);
  const sessionQueryGenerationRef = useRef<HomeSessionQueryGeneration | null>(
    null,
  );
  const pageRequestsRef = useRef(new Map<"recent" | "pinned", object>());
  if (sessionQueryGenerationRef.current === null) {
    sessionQueryGenerationRef.current = new HomeSessionQueryGeneration(
      buildHomeSessionQueryKey(sessionSearchText, openSessionWindowIds),
    );
  }
  const refreshSessionSummaries = useHomeSessionSummaryRefresh({
    enabled: !isSettingsWindowMode,
    sessionSearchText,
    openSessionWindowIds,
    sessionSummariesState,
    setSessionSummariesState,
    sessionQueryGeneration: sessionQueryGenerationRef.current,
  });
  if (workspaceValidationControllerRef.current === null) {
    workspaceValidationControllerRef.current =
      createDirectoryPathValidationController({
        /** Desktop API に候補を照会し、API が使えない環境では検証不可を返す。 */
        validate: async (targetPath) =>
          (await withWithMateApi((api) =>
            api.validateWorkspaceDirectory(targetPath),
          )) ?? { valid: false, reason: "unavailable" },
        /** 入力値を検証が予約された候補として起動の下書きに反映する。 */
        onScheduled: (targetPath) => {
          setLaunchDraft((current) =>
            beginLaunchWorkspacePathValidation(current, targetPath),
          );
        },
        /** 照会開始時に対象の候補を検証中にする。 */
        onValidationStart: (targetPath) => {
          setLaunchDraft((current) =>
            markLaunchWorkspacePathValidationPending(current, targetPath),
          );
        },
        /** 照会結果を、対象パスと照合して現在の起動の下書きに反映する。 */
        onResult: (targetPath, result) => {
          setLaunchDraft((current) =>
            applyLaunchWorkspacePathValidation(current, targetPath, result),
          );
        },
      });
  }

  useEffect(() => () => workspaceValidationControllerRef.current?.cancel(), []);
  /** 受信した保存済み設定を反映する。設定ウィンドウの編集中の下書きは強制指定がなければ保持する。 */
  const applyIncomingAppSettings = (
    settings: AppSettings,
    options?: { force?: boolean },
  ) => {
    setAppSettings(settings);
    setSettingsDraftLoaded(true);
    setSettingsDraft((current) => {
      const shouldHydrateDrafts =
        options?.force ||
        !isSettingsWindowMode ||
        !settingsHydratedRef.current ||
        !settingsDirtyRef.current;
      return shouldHydrateDrafts ? settings : current;
    });
    if (
      options?.force ||
      !isSettingsWindowMode ||
      !settingsHydratedRef.current ||
      !settingsDirtyRef.current
    ) {
      settingsHydratedRef.current = true;
    }
  };

  const { refreshMateStatus } = buildMateStatusRefreshers({
    setMateState,
    setMateProfile,
    setMateDisplayName,
    setMateAvatarAction,
  });

  /** 指定した一覧の次ページを取得し、検索や開いているウィンドウの条件が変わっていない場合だけ反映する。 */
  const loadMoreSessionSummaryPage = async (
    scope: "recent" | "pinned",
    retry = false,
  ): Promise<void> => {
    const api = getWithMateApi();
    const pages =
      scope === "recent"
        ? sessionSummariesState.recentPages
        : sessionSummariesState.pinnedPages;
    const cursor =
      pages.at(-1)?.page.nextCursor ??
      (scope === "recent"
        ? sessionSummariesState.recentCursor
        : sessionSummariesState.pinnedCursor);
    const hasMore =
      scope === "recent"
        ? sessionSummariesState.hasMoreRecent
        : sessionSummariesState.hasMorePinned;
    const loading =
      scope === "recent"
        ? sessionSummariesState.loadingRecentPage
        : sessionSummariesState.loadingPinnedPage;
    const status =
      scope === "recent"
        ? sessionSummariesState.recentStatus
        : sessionSummariesState.pinnedStatus;
    const pageErrorKey =
      scope === "recent" ? "recentPageError" : "pinnedPageError";
    if (
      !api ||
      !cursor ||
      !hasMore ||
      loading ||
      status !== "loaded" ||
      pageRequestsRef.current.has(scope) ||
      (!retry && sessionSummariesState[pageErrorKey])
    ) {
      return;
    }

    const requestToken = sessionQueryGenerationRef.current!.capture();
    pageRequestsRef.current.set(scope, requestToken);
    setSessionSummariesState((current) => ({
      ...current,
      ...(scope === "recent"
        ? { loadingRecentPage: true }
        : { loadingPinnedPage: true }),
    }));
    try {
      const page = await fetchHomeSessionSummaryPage(
        api,
        scope,
        cursor,
        sessionSearchText,
      );
      if (!sessionQueryGenerationRef.current!.isCurrent(requestToken)) {
        return;
      }
      setSessionSummariesState((current) => ({
        ...applyHomeSessionSummaryPages(current, {
          recent:
            scope === "recent"
              ? [...current.recentPages, { requestCursor: cursor, page }]
              : current.recentPages,
          pinned:
            scope === "pinned"
              ? [...current.pinnedPages, { requestCursor: cursor, page }]
              : current.pinnedPages,
          open: current.openSummaries,
        }),
        ...(scope === "recent"
          ? {
              recentCursor: page.nextCursor,
              hasMoreRecent: page.hasMore,
              loadingRecentPage: false,
            }
          : {
              pinnedCursor: page.nextCursor,
              hasMorePinned: page.hasMore,
              loadingPinnedPage: false,
            }),
        [pageErrorKey]: "",
      }));
    } catch (error) {
      if (!sessionQueryGenerationRef.current!.isCurrent(requestToken)) {
        return;
      }
      setSessionSummariesState((current) => ({
        ...current,
        ...(scope === "recent"
          ? { loadingRecentPage: false }
          : { loadingPinnedPage: false }),
        [pageErrorKey]:
          error instanceof Error
            ? error.message
            : "Could not load more sessions.",
      }));
    } finally {
      if (pageRequestsRef.current.get(scope) === requestToken)
        pageRequestsRef.current.delete(scope);
    }
  };

  /** 一方の一覧を取得中なら待ち、次の取得ではピン留め一覧を履歴より優先する。 */
  const loadNextSessionSummaryPage = () => {
    if (
      sessionSummariesState.loadingPinnedPage ||
      sessionSummariesState.loadingRecentPage
    ) {
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

  /** 先頭ページの失敗なら一覧を再取得し、追加ページだけの失敗なら該当する一覧の続きから再試行する。 */
  const retrySessionSummaryLoad = () => {
    if (
      sessionSummariesState.recentError ||
      sessionSummariesState.pinnedError
    ) {
      void refreshSessionSummaries("preserve");
      return;
    }
    if (sessionSummariesState.pinnedPageError)
      void loadMoreSessionSummaryPage("pinned", true);
    if (sessionSummariesState.recentPageError)
      void loadMoreSessionSummaryPage("recent", true);
  };

  /** ピン留めの永続化中は対象行を操作待ちにし、確定した要約を先に反映してから一覧を再取得する。 */
  const setSessionPinned = async (sessionId: string, isPinned: boolean) => {
    const api = getWithMateApi();
    if (!api) {
      window.alert("Pinning is available from the Electron desktop app.");
      return;
    }
    setPendingSessionPinIds((current) =>
      current.includes(sessionId) ? current : [...current, sessionId],
    );
    try {
      const saved = projectHomeSessionSummary(
        await api.setSessionPinned({ sessionId, isPinned }),
      );
      setSessionSummariesState((current) => ({
        ...current,
        summaries: mergePinnedSessionSummary(current.summaries, saved),
      }));
      void refreshSessionSummaries("preserve");
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "Could not update pin.",
      );
    } finally {
      setPendingSessionPinIds((current) =>
        current.filter((id) => id !== sessionId),
      );
    }
  };

  /** Character 一覧を Desktop API から取得して表示状態を更新し、失敗時の通知は呼び出し元に任せる。 */
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

  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();

    if (!withmateApi) {
      return () => {
        active = false;
      };
    }

    if (!isSettingsWindowMode && !isMonitorWindowMode) {
      setMateLoadStatus("loading");
      setMateLoadError("");
      void refreshMateStatus(withmateApi, {
        /** 終了した購読の応答で Mate の表示を更新しない。 */
        isActive: () => active,
      })
        .then(() => {
          if (active) setMateLoadStatus("loaded");
        })
        .catch((error) => {
          if (!active) return;
          const message =
            error instanceof Error
              ? error.message
              : "Could not load app state.";
          setMateLoadError(message);
          setMateLoadStatus("error");
        });
    }

    return () => {
      active = false;
    };
  }, [homeStateRetry, isMonitorWindowMode, isSettingsWindowMode]);

  useEffect(() => {
    if (isSettingsWindowMode || isMonitorWindowMode) return;
    const api = getWithMateApi();
    if (!api) return;
    let active = true;
    void refreshCharacterEntries(api).catch((error) => {
      if (active)
        setCharacterListFeedback(
          error instanceof Error ? error.message : "Could not load characters.",
        );
    });
    return () => {
      active = false;
    };
  }, [characterRetry, isMonitorWindowMode, isSettingsWindowMode]);

  useEffect(() => {
    if (isMonitorWindowMode) return;
    const api = getWithMateApi();
    if (!api) return;
    let active = true;
    const unsubscribe = startModelCatalogSubscription({
      api,
      enabled: true,
      subscribe: true,
      /** 購読中のカタログを採用し、取得エラー表示を取り除く。 */
      applyModelCatalog: (snapshot) => {
        if (!active) return;
        setModelCatalog(snapshot);
        setModelCatalogLoadStatus("loaded");
        setModelCatalogLoadError("");
      },
      /** カタログの初回取得に失敗したら古いスナップショットを破棄し、再試行できるエラーにする。 */
      onInitialLoadError: (error) => {
        if (!active) return;
        setModelCatalog(null);
        setModelCatalogLoadStatus("error");
        setModelCatalogLoadError(
          error instanceof Error
            ? error.message
            : "Could not load model catalog.",
        );
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [isMonitorWindowMode, modelCatalogRetry]);

  useEffect(() => {
    if (isMonitorWindowMode) return;
    const api = getWithMateApi();
    if (!api) return;
    let active = true;
    const unsubscribe = startAppSettingsSubscription({
      api,
      loadInitial: true,
      /** 購読中の設定を受け取り、編集中の下書きとは分けて保存済みの値を更新する。 */
      applyAppSettings: (settings) => {
        if (!active) return;
        setAppSettingsLoadStatus("loaded");
        setAppSettingsLoadError("");
        applyIncomingAppSettings(settings);
      },
      /** 設定の初回取得が失敗したことを、取得の再試行と分けて表示に残す。 */
      onInitialLoadError: (error) => {
        if (!active) return;
        setAppSettingsLoadStatus("error");
        setAppSettingsLoadError(
          error instanceof Error
            ? error.message
            : "Could not load app settings.",
        );
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [appSettingsRetry, isMonitorWindowMode, isSettingsWindowMode]);

  useEffect(() => {
    if (isSettingsWindowMode) return;
    const withmateApi = getWithMateApi();
    if (!withmateApi || isSettingsWindowMode || isMonitorWindowMode) {
      return;
    }

    let refreshInFlight = false;
    /** ウィンドウへ戻ったら Character 一覧を再取得する。すでに取得中なら重ねて実行しない。 */
    const refreshCharactersOnFocus = () => {
      if (refreshInFlight) {
        return;
      }
      refreshInFlight = true;
      void refreshCharacterEntries(withmateApi)
        .catch((error) => {
          setCharacterListFeedback(
            error instanceof Error
              ? error.message
              : "Could not refresh characters.",
          );
        })
        .finally(() => {
          refreshInFlight = false;
        });
    };

    window.addEventListener("focus", refreshCharactersOnFocus);
    return () => window.removeEventListener("focus", refreshCharactersOnFocus);
  }, [isMonitorWindowMode, isSettingsWindowMode]);

  useHomeOpenWindowSubscriptions({
    enabled: !isSettingsWindowMode,
    getApi: getWithMateApi,
    setOpenSessionWindowIdsState,
  });

  useEffect(() => {
    const api = getWithMateApi();
    if (!api || isSettingsWindowMode || isMonitorWindowMode) {
      return;
    }
    let active = true;
    let snapshotRevision = 0;
    let loading = false;
    let loadError: string | null = null;
    /** 復元候補の取得エラーだけを消し、その後に出た別の復元結果は保持する。 */
    const clearLoadError = () => {
      const previousError = loadError;
      loadError = null;
      if (previousError !== null) {
        setSessionWindowRestoreFeedback((feedback) =>
          feedback === previousError ? "" : feedback,
        );
      }
    };
    const unsubscribe = api.subscribeSessionWindowRestoreSet((sessionIds) => {
      if (active) {
        snapshotRevision += 1;
        setSessionWindowRestoreIds(sessionIds);
        clearLoadError();
      }
    });
    /** 復元候補を取得する。取得中に購読から新しい一覧を受け取ったら応答やエラーで上書きしない。 */
    const loadSnapshot = () => {
      const revision = snapshotRevision;
      loading = true;
      void api
        .getSessionWindowRestoreSet()
        .then((sessionIds) => {
          if (active && revision === snapshotRevision) {
            setSessionWindowRestoreIds(sessionIds);
            clearLoadError();
          }
        })
        .catch((error) => {
          if (active && revision === snapshotRevision) {
            loadError =
              error instanceof Error
                ? error.message
                : "Could not load previous sessions.";
            setSessionWindowRestoreFeedback(loadError);
          }
        })
        .finally(() => {
          loading = false;
        });
    };
    /** 復元候補の取得に失敗している場合だけ、再フォーカスで再試行する。 */
    const retryOnFocus = () => {
      if (loadError !== null && !loading) loadSnapshot();
    };
    loadSnapshot();
    window.addEventListener("focus", retryOnFocus);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("focus", retryOnFocus);
    };
  }, [isMonitorWindowMode, isSettingsWindowMode]);

  /** 復元操作を多重実行せず、Desktop API から返った結果や取得失敗を Home の操作結果に反映する。 */
  const restoreSessionWindows = async () => {
    const api = getWithMateApi();
    if (!api || sessionWindowRestorePending) {
      return;
    }
    setSessionWindowRestorePending(true);
    setSessionWindowRestoreFeedback("");
    try {
      const result = await api.restoreSessionWindows();
      setSessionWindowRestoreFeedback(
        buildSessionWindowRestoreFeedback(result),
      );
    } catch (error) {
      setSessionWindowRestoreFeedback(
        error instanceof Error
          ? error.message
          : "Could not restore previous sessions.",
      );
    } finally {
      setSessionWindowRestorePending(false);
    }
  };

  const historyProjection = useMemo(
    () =>
      buildHomeSessionProjection(
        sessions,
        openSessionWindowIds,
        sessionSearchText,
        [],
        new Set(
          [
            ...sessionSummariesState.recentPages,
            ...sessionSummariesState.pinnedPages,
          ].flatMap(({ page }) => page.entries.map(({ id }) => id)),
        ),
      ),
    [
      openSessionWindowIds,
      sessionSearchText,
      sessions,
      sessionSummariesState.recentPages,
      sessionSummariesState.pinnedPages,
    ],
  );
  const { filteredSessionEntries } = historyProjection;
  const sessionProjection = useMemo(
    () =>
      buildHomeSessionProjection(
        monitorSnapshot.entries,
        monitorSnapshot.entries.map(({ id }) => id),
        sessionSearchText,
        monitorSnapshot.auxiliarySessions,
      ),
    [
      monitorSnapshot.entries,
      monitorSnapshot.auxiliarySessions,
      sessionSearchText,
    ],
  );
  const {
    approvalMonitorEntries,
    runningMonitorEntries,
    nonRunningMonitorEntries,
    monitorRunningEmptyMessage,
    monitorCompletedEmptyMessage,
  } = sessionProjection;
  const launchProjection = useMemo(
    () =>
      buildHomeLaunchProjection({
        modelCatalog,
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
        sessionCharacterUsageLoadStatus:
          sessionSummariesState.characterUsageStatus,
        openSessionWindowIdsLoadStatus: openSessionWindowIdsState.status,
        appSettings,
        providerLoadStatus:
          modelCatalogLoadStatus === "error" ||
          appSettingsLoadStatus === "error"
            ? "error"
            : modelCatalogLoadStatus === "loading" ||
                appSettingsLoadStatus === "loading"
              ? "loading"
              : "loaded",
        providerLoadError:
          modelCatalogLoadStatus === "error"
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

  const openSessionsLoadStatus =
    openSessionWindowIdsState.status === "loaded"
      ? sessionSummariesState.openStatus
      : openSessionWindowIdsState.status;
  const randomLaunchReadiness =
    launchDraft.characterSelectionMode === "random"
      ? resolveRandomHomeLaunchReadiness(
          sessionSummariesState.characterUsageStatus,
          openSessionsLoadStatus,
        )
      : null;
  const launchFeedback =
    launchFeedbackState.source === "launch" ? launchFeedbackState.message : "";
  const launchCreationError =
    launchFeedbackState.source === "creation-error"
      ? launchFeedbackState.message
      : "";
  const randomLaunchWaiting = randomLaunchReadiness !== null;
  useEffect(() => {
    if (!randomLaunchWaiting) {
      setLaunchFeedbackState((current) =>
        current.source === "readiness"
          ? { message: "", source: "launch" }
          : current,
      );
    }
  }, [randomLaunchWaiting]);

  const homeLaunchHandlers = buildHomeLaunchHandlers({
    launchDraft,
    launchDialogAttemptRef,
    launchStarting,
    launchLifetimeRef,
    /** ダイアログを離れた後に完了した起動の結果を、ダイアログ外で確認できるよう蓄積する。 */
    onDetachedResult: (result) =>
      setLaunchResults((current) => [...current, result]),
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
    /** 起動用の Character 候補を更新し、Desktop API がない場合は準備の失敗として通知できるよう例外にする。 */
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
    /** 起動先を選ぶために Desktop のディレクトリ選択を要求する。 */
    pickWorkspaceDirectory: async () =>
      withWithMateApi((api) => api.pickDirectory()),
    /** 入力された候補の検証を、ワークスペース専用のコントローラーに予約する。 */
    scheduleWorkspaceValidation: (targetPath) =>
      workspaceValidationControllerRef.current?.schedule(targetPath),
    /** 起動先の変更やダイアログの終了時に、予約済みのパス検証を取り消す。 */
    cancelWorkspaceValidation: () =>
      workspaceValidationControllerRef.current?.cancel(),
    openSessionWindow,
    /** 起動の入力を Desktop API に渡し、保存された Session の応答を起動処理に返す。 */
    createSession: async (input) =>
      await withWithMateApi((api) => api.createSession(input)),
    /** 起動結果を一覧の先頭に反映し、同じ ID の行を取り除いてから現在の条件で一覧を再取得する。 */
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
    /** Mate の更新後に既存の取得範囲を維持して Session 一覧を再取得する。 */
    refreshSessionSummaries: async () => {
      await refreshSessionSummaries("preserve");
    },
  });

  const settingsDraftHandlers = buildSettingsDraftHandlers({
    setSettingsDraft,
    clearSettingsFeedback,
  });

  const providerSettingRows = useMemo<HomeProviderSettingRow[]>(
    () => buildHomeProviderSettingRows(modelCatalog, settingsDraft),
    [modelCatalog, settingsDraft],
  );
  settingsDraftRef.current = settingsDraft;
  const settingsDirty = useMemo(() => {
    return JSON.stringify(settingsDraft) !== JSON.stringify(appSettings);
  }, [appSettings, settingsDraft]);

  useEffect(() => {
    settingsDirtyRef.current = settingsDirty;
  }, [settingsDirty]);

  const settingsCommandHandlers = buildSettingsCommandHandlers({
    getApi: getWithMateApi,
    persistedSettingsDraft: settingsDraft,
    setAppSettings,
    setSettingsDraft,
    /** 非同期操作からも直近の設定下書きを参照できるようにする。 */
    getPersistedSettingsDraft: () => settingsDraftRef.current ?? settingsDraft,
    setSettingsFeedback,
    /** 削除操作の対象を決めるため、設定画面で入力された基準日を渡す。 */
    getSessionCleanupCutoffDate: () => sessionCleanupCutoffDate,
    setDeletingOldSessions,
    /** 設定画面の操作で一覧が変わった後、表示中のページ範囲を保って再取得する。 */
    refreshSessionSummaries: async () => {
      await refreshSessionSummaries("preserve");
    },
  });

  const canUsePrimaryFeatures = mateState !== null;

  const baseSettingsContentProps: HomeSettingsContentBaseProps = {
    settingsDraft,
    providerSettingRows,
    modelDiscovery: modelCatalog?.discovery,
    settingsDraftLoaded,
    appSettingsLoadStatus,
    appSettingsLoadError,
    /** 設定取得の失敗を消して読み込み中に戻し、初回取得をやり直す。 */
    onRetryAppSettings: () => {
      setAppSettingsLoadStatus("loading");
      setAppSettingsLoadError("");
      setAppSettingsRetry((current) => current + 1);
    },
    modelCatalogLoadStatus,
    modelCatalogLoadError,
    /** カタログ取得の失敗を消して読み込み中に戻し、購読と初回取得を開始し直す。 */
    onRetryModelCatalog: () => {
      setModelCatalogLoadStatus("loading");
      setModelCatalogLoadError("");
      setModelCatalogRetry((current) => current + 1);
    },
    settingsDirty,
    settingsFeedback,
    settingsErrors,
    sessionCleanupCutoffDate,
    deletingOldSessions,
    onChangeSessionCleanupCutoffDate: setSessionCleanupCutoffDate,
    ...settingsDraftHandlers,
    ...settingsCommandHandlers,
  };

  /** Monitor 上の行の種類・対象 ID・座標を Desktop のメニューへ渡し、操作の結果を Monitor に反映する。 */
  const showSessionMonitorContextMenu = (
    kind: SessionMonitorEntryKind,
    sessionId: string,
    point: SessionMonitorContextMenuPoint,
  ) => {
    const api = getWithMateApi();
    if (!api) {
      return;
    }
    runSessionMonitorContextMenu(
      api,
      { kind, sessionId, point },
      setSessionMonitorFeedback,
    );
  };

  /** Monitor の行が示す Main または Auxiliary を開き、失敗は Monitor の通知に残す。 */
  const openMonitorSession = async (
    sessionId: string,
    auxiliarySessionId?: string,
  ) => {
    setSessionMonitorFeedback("");
    try {
      await openSessionWindow(sessionId, auxiliarySessionId);
    } catch (error) {
      setSessionMonitorFeedback(
        error instanceof Error
          ? error.message
          : "Could not open session window.",
      );
    }
  };

  const monitorFeedback = [sessionMonitorFeedback, monitorSnapshot.feedback]
    .filter(Boolean)
    .join(" ");
  const sessionListFeedback = [
    sessionSummariesState.recentError &&
      `Recent sessions: ${sessionSummariesState.recentError}`,
    sessionSummariesState.pinnedError &&
      `Pinned sessions: ${sessionSummariesState.pinnedError}`,
    sessionSummariesState.recentPageError &&
      `More recent sessions: ${sessionSummariesState.recentPageError}`,
    sessionSummariesState.pinnedPageError &&
      `More pinned sessions: ${sessionSummariesState.pinnedPageError}`,
  ]
    .filter(Boolean)
    .join(" ");
  const sessionListLoadStatus =
    sessionSummariesState.recentStatus === "loading" ||
    sessionSummariesState.pinnedStatus === "loading"
      ? "loading"
      : sessionSummariesState.recentStatus === "error" ||
          sessionSummariesState.pinnedStatus === "error"
        ? "error"
        : "loaded";

  const { settingsContent, mateSetupContent, monitorContent } =
    buildHomeWindowContentSlots({
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
        /** Mate の設定画面から独立したアプリ設定ウィンドウを開く。 */
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
        auxiliaryDataState:
          monitorSnapshot.status === "loaded"
            ? "ready"
            : monitorSnapshot.status,
        auxiliaryRefreshing: monitorSnapshot.refreshing,
        sessionWindowsDataState: monitorSnapshot.status,
        runningEmptyMessage: monitorRunningEmptyMessage,
        nonRunningEmptyMessage: monitorCompletedEmptyMessage,
        feedback: monitorFeedback,
        onRetry: monitorSnapshot.feedback ? monitorSnapshot.retry : undefined,
        onOpenSession: openMonitorSession,
        onShowContextMenu: showSessionMonitorContextMenu,
      }),
    });

  const { header, recentSessionsPanel, rightPane, launchDialog } =
    buildHomeDashboardSlots({
      recentSessionsPanel: buildHomeRecentSessionsPanelProps({
        filteredSessionEntries,
        handlers: {
          /** 履歴行から、追加の Auxiliary 指定なしで対象 Session を開く。 */
          onOpenSession: (sessionId) => void openSessionWindow(sessionId),
          /** 履歴行のピン切替を、保存待ちと一覧更新を扱う処理へ渡す。 */
          onSetSessionPinned: (sessionId, isPinned) =>
            void setSessionPinned(sessionId, isPinned),
        },
        hasMore:
          sessionSummariesState.hasMoreRecent ||
          sessionSummariesState.hasMorePinned,
        loadingMore:
          sessionSummariesState.loadingRecentPage ||
          sessionSummariesState.loadingPinnedPage,
        onLoadMore: loadNextSessionSummaryPage,
        pendingSessionPinIds,
        sessionSummaryLoadStatus: sessionListLoadStatus,
        feedback: sessionListFeedback,
        onRetry: retrySessionSummaryLoad,
        launchResults: launchDraft.open ? null : (
          <HomeLaunchResults
            results={launchResults}
            onDismiss={(result) =>
              setLaunchResults((current) =>
                current.filter((entry) => entry !== result),
              )
            }
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
        auxiliaryDataState:
          monitorSnapshot.status === "loaded"
            ? "ready"
            : monitorSnapshot.status,
        auxiliaryRefreshing: monitorSnapshot.refreshing,
        sessionWindowsDataState: monitorSnapshot.status,
        monitorRunningEmptyMessage,
        monitorNonRunningEmptyMessage: monitorCompletedEmptyMessage,
        sessionMonitorFeedback: monitorFeedback,
        onRetrySessionSummaries: monitorSnapshot.feedback
          ? monitorSnapshot.retry
          : undefined,
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
          /** Home 内の表示タブは変えず、独立した Monitor ウィンドウを開く。 */
          onOpenSessionMonitorWindow: () => void openSessionMonitorWindow(),
          /** Home 右ペインから独立したアプリ設定ウィンドウを開く。 */
          onOpenSettingsWindow: () => void openSettingsWindow(),
          /** 復元候補を開く操作を、進行中かどうかと結果表示を管理する処理へ渡す。 */
          onRestoreSessionWindows: () => void restoreSessionWindows(),
          /** 対象 ID を指定せず、新規 Character 用のエディターを開く。 */
          onCreateCharacter: () => void openCharacterEditorWindow(),
          /** 選択した Character の ID を渡して既存項目のエディターを開く。 */
          onEditCharacter: (characterId) =>
            void openCharacterEditorWindow(characterId),
          onOpenSession: openMonitorSession,
          onShowSessionMonitorContextMenu: showSessionMonitorContextMenu,
        },
        sessionWindowRestoreIds: pendingSessionWindowRestoreIds,
        sessionWindowRestorePending,
        sessionWindowRestoreFeedback,
        mateLoadStatus,
        mateLoadError,
        /** Mate の取得だけを再実行するため、対応する取得世代を進める。 */
        onRetryMateStatus: () => setHomeStateRetry((current) => current + 1),
        /** Character 一覧の取得を取り直す。Mate の再取得は発火しない。 */
        onRetryCharacters: () => setCharacterRetry((current) => current + 1),
      }),
      launchDialog: buildHomeLaunchDialogProps({
        draft: launchDraft,
        projection: launchProjection,
        canUsePrimaryFeatures,
        launchFeedback,
        randomLaunchReadiness,
        launchCreationError,
        launchStarting,
        onClose: homeLaunchHandlers.onCloseLaunchDialog,
        onChangeTitle: homeLaunchHandlers.onChangeTitle,
        onSelectRole: homeLaunchHandlers.onSelectLaunchRole,
        onChangeWorkspacePath: homeLaunchHandlers.onChangeWorkspacePath,
        /** ダイアログの参照操作を、ディレクトリ選択と候補反映を扱う起動処理へ渡す。 */
        onBrowseWorkspace: () => void homeLaunchHandlers.onBrowseWorkspace(),
        onSelectSessionFolder: homeLaunchHandlers.onSelectSessionFolder,
        onSelectProvider: homeLaunchHandlers.onSelectLaunchProvider,
        onSelectCharacter: homeLaunchHandlers.onSelectLaunchCharacter,
        onSelectRandomCharacter:
          homeLaunchHandlers.onSelectRandomLaunchCharacter,
        /** ダイアログの確定操作を、下書きの検証と Session 作成を扱う起動処理へ渡す。 */
        onStartSession: () => void homeLaunchHandlers.onStartSession(),
      }),
    });

  return (
    <HomeAppRouter
      desktopRuntime={desktopRuntime}
      homePageClassName={homePageClassName}
      isSettingsWindowMode={isSettingsWindowMode}
      settingsContent={settingsContent}
      mateProfileEditorOpen={mateProfileEditorOpen}
      mateSetupContent={mateSetupContent}
      isMonitorWindowMode={isMonitorWindowMode}
      monitorContent={monitorContent}
      header={header}
      rightPaneLabel={homeRightPaneLabels[rightPaneView]}
      recentSessionsPanel={recentSessionsPanel}
      rightPane={rightPane}
      launchDialog={launchDialog}
    />
  );
}
