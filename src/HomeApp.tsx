import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createDefaultAppSettings,
  getProviderAppSettings,
  type AppSettings,
  type ProviderInstructionTargetSettings,
  type ProviderInstructionFailPolicy,
  type ProviderInstructionWriteMode,
  DEFAULT_PROVIDER_INSTRUCTION_TARGET_ID,
  getDefaultProviderInstructionRelativePath,
} from "./provider-settings-state.js";
import { type SessionSummary } from "./session-state.js";
import { DEFAULT_APPROVAL_MODE } from "./approval-mode.js";
import { type ModelCatalogSnapshot } from "./model-catalog.js";
import {
  DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS,
  type MemoryManagementViewFilters,
} from "./memory-management-view.js";
import {
  buildMemoryManagementPageRequest,
  type MemoryManagementPageResult,
  mergeMemoryManagementSnapshots,
  removeMateProfileItemFromSnapshot,
  removeCharacterMemoryEntryFromSnapshot,
  removeProjectMemoryEntryFromSnapshot,
  removeSessionMemoryFromSnapshot,
  type MemoryManagementDomain,
  type MemoryManagementDomainPageInfo,
  type MemoryManagementSnapshot,
} from "./memory-management-state.js";
import {
  buildHomeLaunchProjection,
} from "./home-launch-projection.js";
import {
  buildCreateCompanionSessionInputFromLaunchDraft,
  buildCreateSessionInputFromLaunchDraft,
  closeLaunchDraft,
  createClosedLaunchDraft,
  openLaunchDraft,
  resolveLastUsedSessionSelection,
  setLaunchWorkspaceFromPath,
  type HomeLaunchDraft,
} from "./home-launch-state.js";
import { createCompanionSessionSummary, type CompanionSessionSummary } from "./companion-state.js";
import {
  buildHomeSessionProjection,
} from "./home-session-projection.js";
import {
  buildHomeProviderSettingRows,
  buildPersistedAppSettingsFromRows,
  type HomeProviderInstructionTargetSettings,
  buildHomeProviderInstructionTargetUpsertInput,
  type HomeProviderSettingRow,
} from "./home-settings-view-model.js";
import {
  HomeLaunchDialog,
  HomeMonitorContent,
  HomeRecentSessionsPanel,
  HomeRightPane,
  HomeSettingsContent,
  HomeMateSetupPanel,
  HomeMateTalkPanel,
} from "./home-components.js";
import {
  exportHomeModelCatalog,
  importHomeModelCatalog,
  saveHomeSettings,
} from "./home-settings-actions.js";
import { buildResetMateConfirmMessage } from "./settings-ui.js";
import {
  updateCharacterReflectionCharDeltaThreshold,
  updateCharacterReflectionCooldownSeconds,
  updateCharacterReflectionModelDraft,
  updateCharacterReflectionMessageDeltaThreshold,
  updateCharacterReflectionReasoningEffortDraft,
  updateCharacterReflectionTimeoutSecondsDraft,
  updateAutoCollapseActionDockOnSend,
  updateCodingProviderEnabledDraft,
  updateCodingProviderSkillRootPathDraft,
  updateMemoryExtractionModelDraft,
  updateMemoryExtractionReasoningEffortDraft,
  updateMemoryExtractionThresholdDraft,
  updateMemoryExtractionTimeoutSecondsDraft,
  updateMateMemoryGenerationTriggerIntervalMinutesDraft,
  updateMateMemoryGenerationPriorityProviderDraft,
  updateMateMemoryGenerationPriorityModelDraft,
  updateMateMemoryGenerationPriorityReasoningEffortDraft,
  updateMateMemoryGenerationPriorityTimeoutSecondsDraft,
  updateMemoryGenerationEnabled,
  updateSystemPromptPrefix,
} from "./home-settings-draft.js";
import { getWithMateApi, isDesktopRuntime, withWithMateApi } from "./renderer-withmate-api.js";
import { type MateProfile, type MateStorageState } from "./mate-state.js";
import { type MateEmbeddingSettings } from "./mate-embedding-settings.js";

type ApplyPendingGrowthResult = {
  candidateCount?: unknown;
  appliedCount?: unknown;
  skippedCount?: unknown;
  revisionId?: unknown;
};

function buildApplyPendingGrowthFeedback(result: unknown): string {
  if (result === null || typeof result !== "object") {
    return "Mate 成長の手動適用が完了したよ。";
  }

  const typedResult = result as ApplyPendingGrowthResult;
  const parts: string[] = [];

  if (typeof typedResult.candidateCount === "number") {
    parts.push(`候補 ${typedResult.candidateCount} 件`);
  }
  if (typeof typedResult.appliedCount === "number") {
    parts.push(`適用 ${typedResult.appliedCount} 件`);
  }
  if (typeof typedResult.skippedCount === "number") {
    parts.push(`スキップ ${typedResult.skippedCount} 件`);
  }
  if (typeof typedResult.revisionId === "string") {
    parts.push(`revisionId ${typedResult.revisionId}`);
  }

  if (parts.length === 0) {
    return "Mate 成長の手動適用が完了したよ。";
  }

  return `Mate 成長を手動適用したよ（${parts.join(" / ")}）。`;
}

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

async function openMemoryManagementWindow() {
  await withWithMateApi((api) => api.openMemoryManagementWindow());
}

function getMemoryManagementCursor(pages: MemoryManagementPageState, domain: MemoryManagementDomain): number | null {
  if (domain === "session") {
    return pages.session.nextCursor;
  }
  if (domain === "project") {
    return pages.project.nextCursor;
  }
  if (domain === "character") {
    return pages.character.nextCursor;
  }
  if (domain === "mate_profile") {
    return pages.mate_profile.nextCursor;
  }
  return null;
}

type HomeRightPaneView = "monitor" | "mate";
type HomeWindowMode = "home" | "monitor" | "settings" | "memory";

const MEMORY_MANAGEMENT_PAGE_LIMIT = 50;
const MATE_EMBEDDING_SETTINGS_POLL_INTERVAL_MS = 2000;

type MemoryManagementPageState = {
  session: MemoryManagementDomainPageInfo;
  project: MemoryManagementDomainPageInfo;
  character: MemoryManagementDomainPageInfo;
  mate_profile: MemoryManagementDomainPageInfo;
};

type MateTalkMessage = {
  id: string;
  role: "user" | "mate";
  text: string;
};

type HomeProviderInstructionTargetDraft = HomeProviderInstructionTargetSettings;

const EMPTY_MEMORY_MANAGEMENT_PAGE_INFO: MemoryManagementDomainPageInfo = {
  nextCursor: null,
  hasMore: false,
  total: 0,
};

const EMPTY_MEMORY_MANAGEMENT_PAGE_STATE: MemoryManagementPageState = {
  session: EMPTY_MEMORY_MANAGEMENT_PAGE_INFO,
  project: EMPTY_MEMORY_MANAGEMENT_PAGE_INFO,
  character: EMPTY_MEMORY_MANAGEMENT_PAGE_INFO,
  mate_profile: EMPTY_MEMORY_MANAGEMENT_PAGE_INFO,
};

function normalizeMemoryManagementPages(pages: MemoryManagementPageResult["pages"]): MemoryManagementPageState {
  return {
    ...EMPTY_MEMORY_MANAGEMENT_PAGE_STATE,
    session: pages.session,
    project: pages.project,
    character: pages.character,
    mate_profile: pages.mate_profile ?? EMPTY_MEMORY_MANAGEMENT_PAGE_STATE.mate_profile,
  };
}

function getHomeWindowMode(): HomeWindowMode {
  if (typeof window === "undefined") {
    return "home";
  }

  const mode = new URLSearchParams(window.location.search).get("mode");
  return mode === "monitor" || mode === "settings" || mode === "memory" ? mode : "home";
}

function normalizeProviderInstructionTarget(target: ProviderInstructionTargetSettings): HomeProviderInstructionTargetDraft {
  return target;
}

function buildFallbackProviderInstructionTarget(providerId: string): HomeProviderInstructionTargetDraft {
  return {
    providerId,
    targetId: DEFAULT_PROVIDER_INSTRUCTION_TARGET_ID,
    enabled: false,
    rootDirectory: "",
    instructionRelativePath: getDefaultProviderInstructionRelativePath(providerId),
    lastSyncState: "never",
    lastSyncRunId: null,
    lastSyncedRevisionId: null,
    lastErrorPreview: "",
    lastSyncedAt: null,
    writeMode: "managed_block",
    projectionScope: "mate_only",
    failPolicy: "warn_continue",
    requiresRestart: false,
  };
}

function isProviderInstructionWriteMode(value: string): value is ProviderInstructionWriteMode {
  return value === "managed_file" || value === "managed_block";
}

function isProviderInstructionFailPolicy(value: string): value is ProviderInstructionFailPolicy {
  return value === "block_session" || value === "warn_continue";
}

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
  const [mateCreating, setMateCreating] = useState(false);
  const [mateGrowthApplying, setMateGrowthApplying] = useState(false);
  const [mateResetting, setMateResetting] = useState(false);
  const [mateCreationFeedback, setMateCreationFeedback] = useState("");
  const [mateTalkOpen, setMateTalkOpen] = useState(false);
  const [mateTalkInput, setMateTalkInput] = useState("");
  const [mateTalkMessages, setMateTalkMessages] = useState<MateTalkMessage[]>([]);
  const [mateTalkSending, setMateTalkSending] = useState(false);
  const settingsDirtyRef = useRef(false);
  const settingsHydratedRef = useRef(!isSettingsWindowMode);
  const memoryManagementRequestIdRef = useRef(0);
  const mateTalkMessageSequenceRef = useRef(0);
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
    return nextMateState;
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
      ]),
    ]).then(([nextMateState, [settings, snapshot, embeddingSettings]]) => {
      if (!active) {
        return;
      }

      applyIncomingAppSettings(settings, { force: isSettingsWindowMode });
      setModelCatalog(snapshot);
      setMateEmbeddingSettings(embeddingSettings);
      setModelCatalogLoaded(true);

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

  const resetMateTalkState = () => {
    setMateTalkOpen(false);
    setMateTalkInput("");
    setMateTalkMessages([]);
    setMateTalkSending(false);
  };

  const openMateTalk = () => {
    setMateTalkOpen(true);
  };

  const closeMateTalk = () => {
    resetMateTalkState();
  };

  const handleSubmitMateTalk = async () => {
    const normalizedText = mateTalkInput.trim();
    if (!normalizedText || mateTalkSending) {
      return;
    }

    const messageSequence = mateTalkMessageSequenceRef.current + 1;
    mateTalkMessageSequenceRef.current = messageSequence;
    const userMessageId = `user-${messageSequence}`;
    const now = Date.now();

    setMateTalkSending(true);
    setMateTalkMessages((current) => [
      ...current,
      {
        id: userMessageId,
        role: "user",
        text: normalizedText,
      },
    ]);
    setMateTalkInput("");

    try {
      const result = await withWithMateApi((api) => api.runMateTalkTurn({ message: normalizedText }));
      if (!result) {
        throw new Error("メイトークの応答を取得できませんでした。");
      }
      setMateTalkMessages((current) => [
        ...current,
        {
          id: `mate-${messageSequence}-${Date.parse(result.createdAt) || now}`,
          role: "mate",
          text: result.assistantMessage,
        },
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "メイトークの送信に失敗しました。";
      setMateTalkMessages((current) => [
        ...current,
        {
          id: `mate-error-${messageSequence}-${now}`,
          role: "mate",
          text: message,
        },
      ]);
    } finally {
      setMateTalkSending(false);
    }
  };

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

  const handleCreateMate = async () => {
    const displayName = mateDisplayName.trim();
    if (!displayName) {
      setMateCreationFeedback("displayName を入力してね。");
      return;
    }

    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      setMateCreationFeedback("Mate API が利用できないよ。");
      return;
    }

    setMateCreationFeedback("Mate 作成中...");
    setMateCreating(true);
    try {
      const createdProfile = await withmateApi.createMate({ displayName });
      let nextMateState: MateStorageState = "active";
      let nextMateProfile = createdProfile as MateProfile | null;

      try {
        nextMateState = await withmateApi.getMateState();
        if (nextMateState !== "not_created") {
          const loadedProfile = await withmateApi.getMateProfile();
          if (loadedProfile) {
            nextMateProfile = loadedProfile;
          }
        }
      } catch {
      }

      setMateState(nextMateState);
      setMateProfile(nextMateProfile);
      setMateDisplayName("");
      setMateCreationFeedback("");
      if (nextMateState !== "not_created") {
        try {
          const [nextSessions, nextCompanionSessions, nextEmbeddingSettings] = await Promise.all([
            withmateApi.listSessionSummaries(),
            withmateApi.listCompanionSessionSummaries(),
            withmateApi.getMateEmbeddingSettings(),
          ]);
          setSessions(nextSessions);
          setCompanionSessions(nextCompanionSessions);
          setMateEmbeddingSettings(nextEmbeddingSettings);
        } catch (error) {
          setLaunchFeedback(error instanceof Error ? error.message : "Home の読み込みに失敗したよ。");
        }
      }
    } catch (error) {
      setMateCreationFeedback(error instanceof Error ? error.message : "Mate の作成に失敗したよ。");
    } finally {
      setMateCreating(false);
    }
  };

  const resolveLaunchValidationMessage = () => {
    if (mateState === "not_created") {
      return "Mate を作成してから開始してね。";
    }
    if (!launchDraft.title.trim()) {
      return "タイトルを入力してね。";
    }
    if (!launchDraft.workspace) {
      return "workspace を選んでね。";
    }
    if (!mateProfile) {
      return "Mate を確認してから開始してね。";
    }
    if (!selectedLaunchProvider) {
      return "有効な Coding Provider を選んでね。";
    }
    return "";
  };

  const handleStartSession = async (requestedMode: HomeLaunchDraft["mode"] = launchDraft.mode) => {
    if (launchStarting) {
      return;
    }

    const validationMessage = resolveLaunchValidationMessage();
    if (validationMessage) {
      setLaunchFeedback(validationMessage);
      return;
    }

    setLaunchFeedback(requestedMode === "companion" ? "Companion を開始してるよ..." : "Session を開始してるよ...");
    setLaunchStarting(true);
    const lastUsedSelection = resolveLastUsedSessionSelection(sessions, selectedLaunchProvider?.id ?? null);
    try {
      if (requestedMode === "companion") {
        const companionInput = buildCreateCompanionSessionInputFromLaunchDraft({
          draft: launchDraft,
          mateProfile,
          selectedProviderId: selectedLaunchProvider?.id ?? null,
          lastUsedSelection,
        });
        if (!companionInput) {
          setLaunchFeedback("Companion の開始条件が揃ってないよ。");
          return;
        }

        const createdSession = await withWithMateApi((api) => api.createCompanionSession(companionInput));
        if (!createdSession) {
          setLaunchFeedback("Companion を開始できなかったよ。");
          return;
        }

        setCompanionSessions((current) => [
          createCompanionSessionSummary(createdSession),
          ...current.filter((session) => session.id !== createdSession.id),
        ]);
        closeLaunchDialog();
        await withWithMateApi((api) => api.openCompanionReviewWindow(createdSession.id));
        return;
      }

      const sessionInput = buildCreateSessionInputFromLaunchDraft({
        draft: launchDraft,
        mateProfile,
        selectedProviderId: selectedLaunchProvider?.id ?? null,
        approvalMode: DEFAULT_APPROVAL_MODE,
        lastUsedSelection,
      });
      if (!sessionInput) {
        setLaunchFeedback("Session の開始条件が揃ってないよ。");
        return;
      }

      const createdSession = await withWithMateApi((api) => api.createSession(sessionInput));
      if (!createdSession) {
        setLaunchFeedback("Session を開始できなかったよ。");
        return;
      }
      closeLaunchDialog();
      await openSessionWindow(createdSession.id);
    } catch (error) {
      setLaunchFeedback(error instanceof Error ? error.message : "開始に失敗したよ。");
    } finally {
      setLaunchStarting(false);
    }
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
      setAppSettings(result.nextSettings);
      setSettingsDraft(result.nextSettings);
      setSettingsFeedback(result.feedback);
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : "設定の保存に失敗したよ。");
    }
  };

  const handleApplyPendingGrowth = async () => {
    if (mateGrowthApplying) {
      return;
    }

    if (mateState !== "active") {
      setSettingsFeedback("Mate がアクティブなときのみ手動適用できるよ。");
      return;
    }

    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      setSettingsFeedback("Mate API が利用できないよ。");
      return;
    }

    setMateGrowthApplying(true);
    setSettingsFeedback("Mate 成長を適用中...");
    try {
      const result = await withmateApi.applyPendingGrowth();
      setSettingsFeedback(buildApplyPendingGrowthFeedback(result));
      await refreshMateStatus(withmateApi);
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : "Mate 成長の適用に失敗したよ。");
    } finally {
      setMateGrowthApplying(false);
    }
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
      resetMateTalkState();
      setSettingsFeedback("Mate を初期化したよ。");
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : "Mate の初期化に失敗したよ。");
    } finally {
      setMateResetting(false);
    }
  };

  const upsertProviderInstructionTarget = async (target: HomeProviderInstructionTargetDraft): Promise<void> => {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      return;
    }

    try {
      await withmateApi.upsertProviderInstructionTarget(buildHomeProviderInstructionTargetUpsertInput(target));
    } catch (error) {
      setSettingsFeedback(
        error instanceof Error
          ? error.message
          : "Provider Instruction Sync の保存に失敗したよ。",
      );
    }
  };

  const updateProviderInstructionTarget = (
    providerId: string,
    patch: Partial<HomeProviderInstructionTargetDraft>,
  ) => {
    const current = providerInstructionTargets.find((next) => next.providerId === providerId);
    const fallback = buildFallbackProviderInstructionTarget(providerId);
    const nextTarget = {
      ...(current ?? fallback),
      ...patch,
      providerId,
    };
    setProviderInstructionTargets((previous) => {
      const index = previous.findIndex((candidate) => candidate.providerId === providerId);
      if (index === -1) {
        return [...previous, nextTarget];
      }

      const updated = [...previous];
      updated[index] = nextTarget;
      return updated;
    });
    void upsertProviderInstructionTarget(nextTarget);
  };

  const handleChangeProviderInstructionEnabled = (providerId: string, enabled: boolean) => {
    updateProviderInstructionTarget(providerId, { enabled });
  };

  const handleChangeProviderInstructionWriteMode = (providerId: string, writeMode: string) => {
    if (!isProviderInstructionWriteMode(writeMode)) {
      return;
    }
    updateProviderInstructionTarget(providerId, { writeMode });
  };

  const handleChangeProviderInstructionFailPolicy = (providerId: string, failPolicy: string) => {
    if (!isProviderInstructionFailPolicy(failPolicy)) {
      return;
    }
    updateProviderInstructionTarget(providerId, { failPolicy });
  };

  const handleChangeProviderInstructionRootDirectory = (providerId: string, rootDirectory: string) => {
    updateProviderInstructionTarget(providerId, { rootDirectory });
  };

  const handleChangeProviderInstructionInstructionRelativePath = (providerId: string, instructionRelativePath: string) => {
    updateProviderInstructionTarget(providerId, { instructionRelativePath });
  };

  const handleChangeProviderEnabled = (providerId: string, enabled: boolean) => {
    setSettingsDraft((current) => updateCodingProviderEnabledDraft(current, providerId, enabled));
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

  const handleChangeMemoryExtractionTimeoutSeconds = (providerId: string, value: string) => {
    setSettingsDraft((current) => updateMemoryExtractionTimeoutSecondsDraft(current, providerId, value));
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

  const handleChangeCharacterReflectionTimeoutSeconds = (providerId: string, value: string) => {
    setSettingsDraft((current) => updateCharacterReflectionTimeoutSecondsDraft(current, providerId, value));
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

  const handleChangeMateMemoryGenerationPriorityProvider = (providerId: string) => {
    setSettingsDraft((current) => updateMateMemoryGenerationPriorityProviderDraft(current, providerId));
  };

  const handleChangeMateMemoryGenerationPriorityModel = (providerId: string, model: string) => {
    const providerCatalog = modelCatalog?.providers.find((provider) => provider.id === providerId);
    if (!providerCatalog) {
      return;
    }

    setSettingsDraft((current) => updateMateMemoryGenerationPriorityModelDraft(current, providerCatalog, providerId, model));
  };

  const handleChangeMateMemoryGenerationPriorityReasoningEffort = (
    reasoningEffort: AppSettings["mateMemoryGenerationSettings"]["priorityList"][number]["reasoningEffort"],
  ) => {
    setSettingsDraft((current) => updateMateMemoryGenerationPriorityReasoningEffortDraft(current, reasoningEffort));
  };

  const handleChangeMateMemoryGenerationPriorityTimeoutSeconds = (value: string) => {
    setSettingsDraft((current) => updateMateMemoryGenerationPriorityTimeoutSecondsDraft(current, value));
  };

  const handleChangeMateMemoryGenerationTriggerIntervalMinutes = (value: string) => {
    setSettingsDraft((current) => updateMateMemoryGenerationTriggerIntervalMinutesDraft(current, value));
  };

  const handleReloadMemoryManagement = async () => {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !usesMemoryManagementWindow) {
      return;
    }

    const requestId = beginMemoryManagementRequest();
    try {
      setMemoryManagementLoaded(false);
      const page = await withmateApi.getMemoryManagementPage(buildMemoryManagementPageRequest(memoryManagementFilters, {
        limit: MEMORY_MANAGEMENT_PAGE_LIMIT,
      }));
      if (!isLatestMemoryManagementRequest(requestId)) {
        return;
      }
      setMemoryManagementSnapshot(page.snapshot);
      setMemoryManagementPages(normalizeMemoryManagementPages(page.pages));
      setMemoryManagementFeedback("Memory 管理ビューを更新したよ。");
    } catch (error) {
      setMemoryManagementFeedback(error instanceof Error ? error.message : "Memory 一覧の読み込みに失敗したよ。");
    } finally {
      setMemoryManagementLoaded(true);
    }
  };

  const handleLoadMoreMemoryManagement = async (domain: MemoryManagementDomain) => {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !usesMemoryManagementWindow || domain === "all") {
      return;
    }

    const cursor = getMemoryManagementCursor(memoryManagementPages, domain);
    if (cursor === null) {
      return;
    }

    const requestId = beginMemoryManagementRequest();
    try {
      setMemoryManagementLoaded(false);
      const page = await withmateApi.getMemoryManagementPage({
        ...buildMemoryManagementPageRequest(memoryManagementFilters, {
          domain,
          cursor,
          limit: MEMORY_MANAGEMENT_PAGE_LIMIT,
        }),
      });
      if (!isLatestMemoryManagementRequest(requestId)) {
        return;
      }
      setMemoryManagementSnapshot((current) => mergeMemoryManagementSnapshots(current, page.snapshot, domain));
      const normalizedPages = normalizeMemoryManagementPages(page.pages);
      setMemoryManagementPages((current) => ({
        ...current,
        [domain]: normalizedPages[domain],
      }));
      setMemoryManagementFeedback("Memory 管理ビューを追加読み込みしたよ。");
    } catch (error) {
      if (!isLatestMemoryManagementRequest(requestId)) {
        return;
      }
      setMemoryManagementFeedback(error instanceof Error ? error.message : "Memory 一覧の追加読み込みに失敗したよ。");
    } finally {
      if (isLatestMemoryManagementRequest(requestId)) {
        setMemoryManagementLoaded(true);
      }
    }
  };

  const handleChangeMemoryManagementViewFilters = useCallback(async (filters: MemoryManagementViewFilters) => {
    setMemoryManagementFilters(filters);
    const withmateApi = getWithMateApi();
    if (!withmateApi || !usesMemoryManagementWindow) {
      return;
    }

    const requestId = beginMemoryManagementRequest();
    try {
      setMemoryManagementLoaded(false);
      const page = await withmateApi.getMemoryManagementPage(buildMemoryManagementPageRequest(filters, {
        limit: MEMORY_MANAGEMENT_PAGE_LIMIT,
      }));
      if (!isLatestMemoryManagementRequest(requestId)) {
        return;
      }
      setMemoryManagementSnapshot(page.snapshot);
      setMemoryManagementPages(normalizeMemoryManagementPages(page.pages));
    } catch (error) {
      if (!isLatestMemoryManagementRequest(requestId)) {
        return;
      }
      setMemoryManagementFeedback(error instanceof Error ? error.message : "Memory 一覧の読み込みに失敗したよ。");
    } finally {
      if (isLatestMemoryManagementRequest(requestId)) {
        setMemoryManagementLoaded(true);
      }
    }
  }, [usesMemoryManagementWindow]);

  const handleDeleteSessionMemory = async (sessionId: string) => {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !usesMemoryManagementWindow) {
      return;
    }

    try {
      setMemoryManagementBusyTarget(`session:${sessionId}`);
      await withmateApi.deleteSessionMemory(sessionId);
      const requestId = beginMemoryManagementRequest();
      const page = await withmateApi.getMemoryManagementPage(buildMemoryManagementPageRequest(memoryManagementFilters, {
        limit: MEMORY_MANAGEMENT_PAGE_LIMIT,
      }));
      if (!isLatestMemoryManagementRequest(requestId)) {
        return;
      }
      setMemoryManagementSnapshot(removeSessionMemoryFromSnapshot(page.snapshot, sessionId));
      setMemoryManagementPages(normalizeMemoryManagementPages(page.pages));
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
    if (!withmateApi || !usesMemoryManagementWindow) {
      return;
    }

    try {
      setMemoryManagementBusyTarget(`project:${entryId}`);
      await withmateApi.deleteProjectMemoryEntry(entryId);
      const requestId = beginMemoryManagementRequest();
      const page = await withmateApi.getMemoryManagementPage(buildMemoryManagementPageRequest(memoryManagementFilters, {
        limit: MEMORY_MANAGEMENT_PAGE_LIMIT,
      }));
      if (!isLatestMemoryManagementRequest(requestId)) {
        return;
      }
      setMemoryManagementSnapshot(removeProjectMemoryEntryFromSnapshot(page.snapshot, entryId));
      setMemoryManagementPages(normalizeMemoryManagementPages(page.pages));
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
    if (!withmateApi || !usesMemoryManagementWindow) {
      return;
    }

    try {
      setMemoryManagementBusyTarget(`character:${entryId}`);
      await withmateApi.deleteCharacterMemoryEntry(entryId);
      const requestId = beginMemoryManagementRequest();
      const page = await withmateApi.getMemoryManagementPage(buildMemoryManagementPageRequest(memoryManagementFilters, {
        limit: MEMORY_MANAGEMENT_PAGE_LIMIT,
      }));
      if (!isLatestMemoryManagementRequest(requestId)) {
        return;
      }
      setMemoryManagementSnapshot(removeCharacterMemoryEntryFromSnapshot(page.snapshot, entryId));
      setMemoryManagementPages(normalizeMemoryManagementPages(page.pages));
      setMemoryManagementFeedback("Character Memory を削除したよ。");
    } catch (error) {
      setMemoryManagementFeedback(error instanceof Error ? error.message : "Character Memory の削除に失敗したよ。");
    } finally {
      setMemoryManagementBusyTarget(null);
      setMemoryManagementLoaded(true);
    }
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
    const withmateApi = getWithMateApi();
    if (!withmateApi || !usesMemoryManagementWindow) {
      return;
    }

    try {
      setMemoryManagementBusyTarget(`mate_profile:${itemId}`);
      await withmateApi.forgetMateProfileItem(itemId);
      const requestId = beginMemoryManagementRequest();
      const page = await withmateApi.getMemoryManagementPage(buildMemoryManagementPageRequest(memoryManagementFilters, {
        limit: MEMORY_MANAGEMENT_PAGE_LIMIT,
      }));
      if (!isLatestMemoryManagementRequest(requestId)) {
        return;
      }
      setMemoryManagementSnapshot(removeMateProfileItemFromSnapshot(page.snapshot, itemId));
      setMemoryManagementPages(normalizeMemoryManagementPages(page.pages));
      setMemoryManagementFeedback("Mate Profile Item を忘却したよ。");
    } catch (error) {
      setMemoryManagementFeedback(error instanceof Error ? error.message : "Mate Profile Item の忘却に失敗したよ。");
    } finally {
      setMemoryManagementBusyTarget(null);
      setMemoryManagementLoaded(true);
    }
  };

  const handleStartMateEmbeddingDownload = async () => {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      setMateEmbeddingFeedback("Mate Embedding API が利用できないよ。");
      return;
    }

    setMateEmbeddingBusy(true);
    setMateEmbeddingFeedback("");
    try {
      await withmateApi.startMateEmbeddingDownload();
      setMateEmbeddingSettings(await withmateApi.getMateEmbeddingSettings());
      setMateEmbeddingFeedback("モデルの準備を開始したよ。");
    } catch (error) {
      setMateEmbeddingFeedback(error instanceof Error ? error.message : "モデルの準備に失敗したよ。");
    } finally {
      setMateEmbeddingBusy(false);
    }
  };

  const settingsContent = (
    <HomeSettingsContent
      settingsDraft={settingsDraft}
      providerSettingRows={providerSettingRows}
      modelCatalogRevisionLabel={String(modelCatalog?.revision ?? "-")}
      settingsDirty={settingsDirty}
      settingsFeedback={settingsFeedback}
      memoryManagementSnapshot={memoryManagementSnapshot}
      memoryManagementPages={memoryManagementPages}
      memoryManagementLoading={!memoryManagementLoaded}
      memoryManagementBusyTarget={memoryManagementBusyTarget}
      memoryManagementFeedback={memoryManagementFeedback}
      mateEmbeddingSettings={mateEmbeddingSettings}
      mateEmbeddingFeedback={mateEmbeddingFeedback}
      mateEmbeddingBusy={mateEmbeddingBusy}
      onChangeSystemPromptPrefix={(value) => setSettingsDraft((current) => updateSystemPromptPrefix(current, value))}
      onChangeMemoryGenerationEnabled={(enabled) =>
        setSettingsDraft((current) => updateMemoryGenerationEnabled(current, enabled))
      }
      onChangeMateMemoryGenerationPriorityProvider={handleChangeMateMemoryGenerationPriorityProvider}
      onChangeMateMemoryGenerationPriorityModel={handleChangeMateMemoryGenerationPriorityModel}
      onChangeMateMemoryGenerationPriorityReasoningEffort={handleChangeMateMemoryGenerationPriorityReasoningEffort}
      onChangeMateMemoryGenerationPriorityTimeoutSeconds={handleChangeMateMemoryGenerationPriorityTimeoutSeconds}
      onChangeMateMemoryGenerationTriggerIntervalMinutes={handleChangeMateMemoryGenerationTriggerIntervalMinutes}
      onChangeAutoCollapseActionDockOnSend={(enabled) =>
        setSettingsDraft((current) => updateAutoCollapseActionDockOnSend(current, enabled))
      }
      onChangeProviderEnabled={handleChangeProviderEnabled}
      onChangeProviderInstructionEnabled={handleChangeProviderInstructionEnabled}
      onChangeProviderInstructionWriteMode={handleChangeProviderInstructionWriteMode}
      onChangeProviderInstructionFailPolicy={handleChangeProviderInstructionFailPolicy}
      onChangeProviderInstructionRootDirectory={handleChangeProviderInstructionRootDirectory}
      onChangeProviderInstructionInstructionRelativePath={handleChangeProviderInstructionInstructionRelativePath}
      onChangeProviderSkillRootPath={handleChangeProviderSkillRootPath}
      onBrowseProviderSkillRootPath={(providerId) => void handleBrowseProviderSkillRootPath(providerId)}
      onChangeMemoryExtractionModel={handleChangeMemoryExtractionModel}
      onChangeMemoryExtractionReasoningEffort={handleChangeMemoryExtractionReasoningEffort}
      onChangeMemoryExtractionThreshold={handleChangeMemoryExtractionThreshold}
      onChangeMemoryExtractionTimeoutSeconds={handleChangeMemoryExtractionTimeoutSeconds}
      onChangeCharacterReflectionModel={handleChangeCharacterReflectionModel}
      onChangeCharacterReflectionReasoningEffort={handleChangeCharacterReflectionReasoningEffort}
      onChangeCharacterReflectionTimeoutSeconds={handleChangeCharacterReflectionTimeoutSeconds}
      onChangeCharacterReflectionCooldownSeconds={handleChangeCharacterReflectionCooldownSeconds}
      onChangeCharacterReflectionCharDeltaThreshold={handleChangeCharacterReflectionCharDeltaThreshold}
      onChangeCharacterReflectionMessageDeltaThreshold={handleChangeCharacterReflectionMessageDeltaThreshold}
      onImportModelCatalog={() => void handleImportModelCatalog()}
      onExportModelCatalog={() => void handleExportModelCatalog()}
      onOpenAppLogFolder={() => void handleOpenAppLogFolder()}
      onOpenCrashDumpFolder={() => void handleOpenCrashDumpFolder()}
      onReloadMemoryManagement={() => void handleReloadMemoryManagement()}
      onChangeMemoryManagementViewFilters={handleChangeMemoryManagementViewFilters}
      onLoadMoreMemoryManagement={(domain) => void handleLoadMoreMemoryManagement(domain)}
      onDeleteSessionMemory={(sessionId) => void handleDeleteSessionMemory(sessionId)}
      onDeleteProjectMemoryEntry={(entryId) => void handleDeleteProjectMemoryEntry(entryId)}
      onDeleteCharacterMemoryEntry={(entryId) => void handleDeleteCharacterMemoryEntry(entryId)}
      onDeleteMateProfileItem={(itemId) => void handleDeleteMateProfileItem(itemId)}
      onStartMateEmbeddingDownload={() => void handleStartMateEmbeddingDownload()}
      onApplyPendingGrowth={() => void handleApplyPendingGrowth()}
      applyPendingGrowthBusy={mateGrowthApplying}
      canApplyPendingGrowth={mateState === "active"}
      onResetMate={() => void handleResetMate()}
      mateResetBusy={mateResetting}
      canResetMate={mateState !== "not_created"}
      onSaveSettings={() => void handleSaveSettings()}
    />
  );

  const memoryManagementContent = (
    <HomeSettingsContent
      settingsDraft={settingsDraft}
      providerSettingRows={providerSettingRows}
      modelCatalogRevisionLabel={String(modelCatalog?.revision ?? "-")}
      settingsDirty={settingsDirty}
      settingsFeedback={settingsFeedback}
      memoryManagementSnapshot={memoryManagementSnapshot}
      memoryManagementPages={memoryManagementPages}
      memoryManagementLoading={!memoryManagementLoaded}
      memoryManagementBusyTarget={memoryManagementBusyTarget}
      memoryManagementFeedback={memoryManagementFeedback}
      mateEmbeddingSettings={mateEmbeddingSettings}
      mateEmbeddingFeedback={mateEmbeddingFeedback}
      mateEmbeddingBusy={mateEmbeddingBusy}
      memoryManagementOnly
      onChangeSystemPromptPrefix={(value) => setSettingsDraft((current) => updateSystemPromptPrefix(current, value))}
      onChangeMemoryGenerationEnabled={(enabled) =>
        setSettingsDraft((current) => updateMemoryGenerationEnabled(current, enabled))
      }
      onChangeMateMemoryGenerationPriorityProvider={handleChangeMateMemoryGenerationPriorityProvider}
      onChangeMateMemoryGenerationPriorityModel={handleChangeMateMemoryGenerationPriorityModel}
      onChangeMateMemoryGenerationPriorityReasoningEffort={handleChangeMateMemoryGenerationPriorityReasoningEffort}
      onChangeMateMemoryGenerationPriorityTimeoutSeconds={handleChangeMateMemoryGenerationPriorityTimeoutSeconds}
      onChangeMateMemoryGenerationTriggerIntervalMinutes={handleChangeMateMemoryGenerationTriggerIntervalMinutes}
      onChangeAutoCollapseActionDockOnSend={(enabled) =>
        setSettingsDraft((current) => updateAutoCollapseActionDockOnSend(current, enabled))
      }
      onChangeProviderEnabled={handleChangeProviderEnabled}
      onChangeProviderInstructionEnabled={handleChangeProviderInstructionEnabled}
      onChangeProviderInstructionWriteMode={handleChangeProviderInstructionWriteMode}
      onChangeProviderInstructionFailPolicy={handleChangeProviderInstructionFailPolicy}
      onChangeProviderInstructionRootDirectory={handleChangeProviderInstructionRootDirectory}
      onChangeProviderInstructionInstructionRelativePath={handleChangeProviderInstructionInstructionRelativePath}
      onChangeProviderSkillRootPath={handleChangeProviderSkillRootPath}
      onBrowseProviderSkillRootPath={(providerId) => void handleBrowseProviderSkillRootPath(providerId)}
      onChangeMemoryExtractionModel={handleChangeMemoryExtractionModel}
      onChangeMemoryExtractionReasoningEffort={handleChangeMemoryExtractionReasoningEffort}
      onChangeMemoryExtractionThreshold={handleChangeMemoryExtractionThreshold}
      onChangeMemoryExtractionTimeoutSeconds={handleChangeMemoryExtractionTimeoutSeconds}
      onChangeCharacterReflectionModel={handleChangeCharacterReflectionModel}
      onChangeCharacterReflectionReasoningEffort={handleChangeCharacterReflectionReasoningEffort}
      onChangeCharacterReflectionTimeoutSeconds={handleChangeCharacterReflectionTimeoutSeconds}
      onChangeCharacterReflectionCooldownSeconds={handleChangeCharacterReflectionCooldownSeconds}
      onChangeCharacterReflectionCharDeltaThreshold={handleChangeCharacterReflectionCharDeltaThreshold}
      onChangeCharacterReflectionMessageDeltaThreshold={handleChangeCharacterReflectionMessageDeltaThreshold}
      onImportModelCatalog={() => void handleImportModelCatalog()}
      onExportModelCatalog={() => void handleExportModelCatalog()}
      onOpenAppLogFolder={() => void handleOpenAppLogFolder()}
      onOpenCrashDumpFolder={() => void handleOpenCrashDumpFolder()}
      onReloadMemoryManagement={() => void handleReloadMemoryManagement()}
      onChangeMemoryManagementViewFilters={handleChangeMemoryManagementViewFilters}
      onLoadMoreMemoryManagement={(domain) => void handleLoadMoreMemoryManagement(domain)}
      onDeleteSessionMemory={(sessionId) => void handleDeleteSessionMemory(sessionId)}
      onDeleteProjectMemoryEntry={(entryId) => void handleDeleteProjectMemoryEntry(entryId)}
      onDeleteCharacterMemoryEntry={(entryId) => void handleDeleteCharacterMemoryEntry(entryId)}
      onDeleteMateProfileItem={(itemId) => void handleDeleteMateProfileItem(itemId)}
      onStartMateEmbeddingDownload={() => void handleStartMateEmbeddingDownload()}
      onSaveSettings={() => void handleSaveSettings()}
    />
  );

  const mateTalkContent = (
    <HomeMateTalkPanel
      mateName={mateProfile?.displayName ?? "Mate"}
      messages={mateTalkMessages}
      input={mateTalkInput}
      onChangeInput={setMateTalkInput}
      onSubmit={() => void handleSubmitMateTalk()}
      onClose={() => void closeMateTalk()}
      sending={mateTalkSending}
    />
  );

  const mateSetupContent = (
    <HomeMateSetupPanel
      displayName={mateDisplayName}
      creating={mateCreating}
      feedback={mateCreationFeedback}
      onChangeDisplayName={(value) => {
        setMateDisplayName(value);
        setMateCreationFeedback("");
      }}
      onSubmit={handleCreateMate}
      onOpenSettings={() => void openSettingsWindow()}
      mateDisplayName={mateProfile?.displayName ?? null}
    />
  );
  const isMateStateLoading = mateState === null;
  const isMateNotCreated = mateState === "not_created";
  const canUsePrimaryFeatures = mateState !== "not_created" && mateProfile !== null;

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

  if (isMateStateLoading) {
    return (
      <div className={homePageClassName}>
        <main className="home-layout home-layout-minimal">
          <section className="panel empty-list-card rise-1">
            <p>Mate 状態を読み込んでるよ...</p>
          </section>
        </main>
      </div>
    );
  }

  if (isMateNotCreated) {
    return (
      <div className={`${homePageClassName} home-page-settings-window`.trim()}>
        <main className="home-layout home-layout-settings-window">
          <section className="launch-dialog settings-dialog home-mate-setup-shell">
            {mateSetupContent}
          </section>
        </main>
      </div>
    );
  }

  if (isMemoryWindowMode) {
    return (
      <div className={`${homePageClassName} home-page-settings-window`.trim()}>
        <main className="home-layout home-layout-settings-window">
          <section className="launch-dialog settings-dialog panel settings-window-shell memory-window-shell">
            {memoryManagementLoaded ? (
              memoryManagementContent
            ) : (
              <div className="settings-loading-state">
                <p>Memory 管理を読み込み中...</p>
              </div>
            )}
          </section>
        </main>
      </div>
    );
  }

  if (mateTalkOpen) {
    return (
      <div className={`${homePageClassName} home-page-mate-talk`.trim()}>
        <main className="home-layout home-layout-minimal">
          <section className="launch-dialog settings-dialog panel home-mate-talk-shell">
            {mateTalkContent}
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
            <section className="home-monitor-panel compact" aria-label="Session Monitor">
              <HomeMonitorContent
                runningEntries={runningMonitorEntries}
                nonRunningEntries={nonRunningMonitorEntries}
                runningEmptyMessage={monitorRunningEmptyMessage}
                completedEmptyMessage={monitorCompletedEmptyMessage}
                onOpenSession={(sessionId) => void openSessionWindow(sessionId)}
                onOpenCompanionReview={(sessionId) => void withWithMateApi((api) => api.openCompanionReviewWindow(sessionId))}
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
          companionSessions={companionSessions}
          normalizedSessionSearch={normalizedSessionSearch}
          searchText={sessionSearchText}
          searchIcon={renderSearchIcon()}
          onChangeSearchText={setSessionSearchText}
          onOpenLaunchDialog={openLaunchDialog}
          onOpenSession={(sessionId) => void openSessionWindow(sessionId)}
          onOpenCompanionReview={(sessionId) => void withWithMateApi((api) => api.openCompanionReviewWindow(sessionId))}
          canUsePrimaryFeatures={canUsePrimaryFeatures}
        />

        <HomeRightPane
          rightPaneView={rightPaneView}
          runningMonitorEntries={runningMonitorEntries}
          nonRunningMonitorEntries={nonRunningMonitorEntries}
          monitorRunningEmptyMessage={monitorRunningEmptyMessage}
          monitorCompletedEmptyMessage={monitorCompletedEmptyMessage}
          mateProfile={mateProfile}
          monitorWindowIcon={renderMonitorWindowIcon()}
          onChangeRightPaneView={setRightPaneView}
          onOpenSessionMonitorWindow={() => void openSessionMonitorWindow()}
          onOpenMemoryManagementWindow={() => void openMemoryManagementWindow()}
          onOpenSettingsWindow={() => void openSettingsWindow()}
          onOpenMateTalk={() => void openMateTalk()}
          onOpenSession={(sessionId) => void openSessionWindow(sessionId)}
          onOpenCompanionReview={(sessionId) => void withWithMateApi((api) => api.openCompanionReviewWindow(sessionId))}
          canUsePrimaryFeatures={canUsePrimaryFeatures}
        />
      </main>

      <HomeLaunchDialog
        open={launchDraft.open}
        mode={launchDraft.mode}
        title={launchDraft.title}
        workspace={launchDraft.workspace}
        launchWorkspacePathLabel={launchWorkspacePathLabel}
        enabledLaunchProviders={enabledLaunchProviders}
        selectedLaunchProviderId={selectedLaunchProvider?.id ?? null}
        canStartSession={canStartSession && canUsePrimaryFeatures}
        launchFeedback={launchFeedback}
        launchStarting={launchStarting}
        onClose={closeLaunchDialog}
        onSelectMode={(mode) => {
          setLaunchFeedback("");
          setLaunchDraft((current) => ({ ...current, mode }));
        }}
        onChangeTitle={(value) => {
          setLaunchFeedback("");
          setLaunchDraft((current) => ({ ...current, title: value }));
        }}
        onBrowseWorkspace={() => void handleBrowseWorkspace()}
        onSelectProvider={(providerId) => {
          setLaunchFeedback("");
          const provider = enabledLaunchProviders.find((candidate) => candidate.id === providerId) ?? null;
          const model =
            provider?.models.find((candidate) => candidate.id === provider.defaultModelId) ??
            provider?.models[0] ??
            null;
          setLaunchDraft((current) => ({
            ...current,
            providerId,
            model: model?.id ?? current.model,
            reasoningEffort: model?.reasoningEfforts[0] ?? provider?.defaultReasoningEffort ?? current.reasoningEffort,
          }));
        }}
        onStartSession={(mode) => void handleStartSession(mode)}
      />

    </div>
  );
}
