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
  resolveLaunchCharacterId,
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
import type { CharacterCatalogEntry, CharacterDetail } from "./character/character-catalog.js";
import {
  createCharacterEditorDraftFromDetail,
  createNewCharacterEditorDraft,
  formatCharacterEditorError,
  isSettingsCharacterDraftDirty,
  resolveSettingsCharacterSelection,
  type SettingsCharacterEditorDraft,
  updateSettingsCharacterEditorDraft,
} from "./settings/settings-character-editor-state.js";
import { HomeAppRouter } from "./home/HomeAppRouter.js";
import { buildHomeDashboardSlots } from "./home/HomeDashboardSlots.js";
import { buildHomeRecentSessionsPanelProps } from "./home/home-recent-sessions-panel-props.js";
import { buildHomeRightPaneProps } from "./home/home-right-pane-props.js";
import { buildHomeWindowContentSlots } from "./home/HomeWindowContentSlots.js";
import { getHomeWindowMode } from "./home/home-window-mode.js";
import { useHomeOpenWindowSubscriptions } from "./home/use-home-open-window-subscriptions.js";
import {
  openCharacterEditorWindow,
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

type HomeRightPaneView = "monitor" | "characters";

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
  const [characterEntries, setCharacterEntries] = useState<CharacterCatalogEntry[]>([]);
  const [charactersLoaded, setCharactersLoaded] = useState(false);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [selectedCharacterDetail, setSelectedCharacterDetail] = useState<CharacterDetail | null>(null);
  const [characterDraft, setCharacterDraft] = useState<SettingsCharacterEditorDraft>(() => createNewCharacterEditorDraft());
  const [characterEditorBusy, setCharacterEditorBusy] = useState(false);
  const [characterEditorFeedback, setCharacterEditorFeedback] = useState("");
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

  const applyLoadedCharacterEntries = async (
    api: NonNullable<ReturnType<typeof getWithMateApi>>,
    entries: CharacterCatalogEntry[],
    preferredCharacterId?: string | null,
  ) => {
    setCharacterEntries(entries);
    setLaunchDraft((current) => ({
      ...current,
      characterId: resolveLaunchCharacterId(entries, current.characterId),
    }));
    const nextSelectedCharacterId = resolveSettingsCharacterSelection(entries, preferredCharacterId ?? selectedCharacterId);
    setSelectedCharacterId(nextSelectedCharacterId);

    if (!nextSelectedCharacterId) {
      setSelectedCharacterDetail(null);
      setCharacterDraft(createNewCharacterEditorDraft());
      return;
    }

    const detail = await api.getCharacter(nextSelectedCharacterId);
    setSelectedCharacterDetail(detail);
    if (detail) {
      setCharacterDraft(createCharacterEditorDraftFromDetail(detail));
    }
  };

  const refreshCharacterEntries = async (
    api: NonNullable<ReturnType<typeof getWithMateApi>>,
    preferredCharacterId?: string | null,
  ): Promise<CharacterCatalogEntry[]> => {
    const entries = await api.listCharacters();
    await applyLoadedCharacterEntries(api, entries, preferredCharacterId);
    setCharactersLoaded(true);
    return entries;
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

      setCharacterEditorFeedback(
        formatCharacterEditorError(error, "Character 一覧の読み込みに失敗したよ。"),
      );
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

  useEffect(() => {
    const withmateApi = getWithMateApi();
    if (!withmateApi || isSettingsWindowMode || isMonitorWindowMode) {
      return;
    }

    let refreshInFlight = false;
    const refreshCharactersOnFocus = () => {
      if (refreshInFlight) {
        return;
      }
      refreshInFlight = true;
      void refreshCharacterEntries(withmateApi, selectedCharacterId).catch((error) => {
        setCharacterEditorFeedback(formatCharacterEditorError(error, "Character 一覧の再読み込みに失敗したよ。"));
      }).finally(() => {
        refreshInFlight = false;
      });
    };

    window.addEventListener("focus", refreshCharactersOnFocus);
    return () => window.removeEventListener("focus", refreshCharactersOnFocus);
  }, [isMonitorWindowMode, isSettingsWindowMode, selectedCharacterId]);

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
      launchCharacterId: launchDraft.characterId,
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
    refreshCharacterEntries: async () => {
      const api = getWithMateApi();
      if (!api) {
        throw new Error("Character 一覧の再読み込みには desktop runtime が必要だよ。");
      }
      return refreshCharacterEntries(api);
    },
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

  const characterEditorDirty = useMemo(
    () => isSettingsCharacterDraftDirty(characterDraft, selectedCharacterDetail),
    [characterDraft, selectedCharacterDetail],
  );

  const runCharacterEditorCommand = async (
    command: (api: NonNullable<ReturnType<typeof getWithMateApi>>) => Promise<void>,
    fallbackMessage = "Character 操作に失敗したよ。",
  ) => {
    const api = getWithMateApi();
    if (characterEditorBusy) {
      return;
    }
    if (!api) {
      setCharacterEditorFeedback("Character 操作には desktop runtime が必要だよ。");
      return;
    }

    setCharacterEditorBusy(true);
    try {
      await command(api);
    } catch (error) {
      setCharacterEditorFeedback(formatCharacterEditorError(error, fallbackMessage));
    } finally {
      setCharacterEditorBusy(false);
    }
  };

  const characterEditorHandlers = {
    onSelectCharacter: (characterId: string) => {
      if (characterId === selectedCharacterId) {
        return;
      }
      if (characterEditorDirty) {
        setCharacterEditorFeedback("未保存の編集があります。保存またはCancelしてから切り替えてね。");
        return;
      }
      void runCharacterEditorCommand(async (api) => {
        const detail = await api.getCharacter(characterId);
        setSelectedCharacterId(characterId);
        setSelectedCharacterDetail(detail);
        if (detail) {
          setCharacterDraft(createCharacterEditorDraftFromDetail(detail));
          setCharacterEditorFeedback("");
        } else {
          setCharacterEditorFeedback("Character が見つからなかったよ。");
        }
      }, "Character の読み込みに失敗したよ。");
    },
    onNewCharacter: () => {
      if (characterEditorDirty) {
        setCharacterEditorFeedback("未保存の編集があります。保存またはCancelしてから切り替えてね。");
        return;
      }
      setSelectedCharacterId(null);
      setSelectedCharacterDetail(null);
      setCharacterDraft(createNewCharacterEditorDraft());
      setCharacterEditorFeedback("");
    },
    onChangeCharacterDraft: (patch: Partial<SettingsCharacterEditorDraft>) => {
      setCharacterDraft((current) => updateSettingsCharacterEditorDraft(current, patch));
    },
    onImportCharacterDefinitionFile: (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          setCharacterDraft((current) => ({
            ...current,
            definitionMarkdown: reader.result as string,
          }));
          setCharacterEditorFeedback(`${file.name} を読み込んだよ。`);
        }
      };
      reader.onerror = () => {
        setCharacterEditorFeedback("character.md の読み込みに失敗したよ。");
      };
      reader.readAsText(file);
    },
    onPickCharacterIcon: () => {
      void runCharacterEditorCommand(async (api) => {
        const pickedPath = await api.pickImageFile(characterDraft.iconFilePath || undefined);
        if (pickedPath) {
          setCharacterDraft((current) => ({
            ...current,
            iconFilePath: pickedPath,
          }));
        }
      }, "Character icon の選択に失敗したよ。");
    },
    onSaveCharacter: () => {
      void runCharacterEditorCommand(async (api) => {
        const saved = characterDraft.mode === "create"
          ? await api.createCharacter({
              name: characterDraft.name,
              description: characterDraft.description,
              iconFilePath: characterDraft.iconFilePath,
              theme: characterDraft.theme,
              definitionMarkdown: characterDraft.definitionMarkdown,
              notesMarkdown: characterDraft.notesMarkdown,
            })
          : await (async () => {
              if (!characterDraft.characterId) {
                throw new Error("保存対象の Character が選択されていないよ。");
              }
              if (characterDraft.name.trim().length === 0) {
                throw new Error("Character name を入力してね。");
              }
              await api.updateCharacterDefinition({
                characterId: characterDraft.characterId,
                definitionMarkdown: characterDraft.definitionMarkdown,
                notesMarkdown: characterDraft.notesMarkdown,
              });
              return api.updateCharacterMetadata({
                characterId: characterDraft.characterId,
                name: characterDraft.name,
                description: characterDraft.description,
                iconFilePath: characterDraft.iconFilePath,
                theme: characterDraft.theme,
              });
            })();

        setSelectedCharacterId(saved.id);
        setSelectedCharacterDetail(saved);
        setCharacterDraft(createCharacterEditorDraftFromDetail(saved));
        await refreshCharacterEntries(api, saved.id);
        setCharacterEditorFeedback("Character を保存したよ。");
      }, "Character の保存に失敗したよ。");
    },
    onCancelCharacterEdit: () => {
      if (selectedCharacterDetail) {
        setCharacterDraft(createCharacterEditorDraftFromDetail(selectedCharacterDetail));
        setCharacterEditorFeedback("編集を保存前の状態へ戻したよ。");
      } else {
        setCharacterDraft(createNewCharacterEditorDraft());
        setCharacterEditorFeedback("");
      }
    },
    onSetDefaultCharacter: () => {
      void runCharacterEditorCommand(async (api) => {
        if (!characterDraft.characterId) {
          return;
        }
        await api.setDefaultCharacter(characterDraft.characterId);
        await refreshCharacterEntries(api, characterDraft.characterId);
        setCharacterEditorFeedback("Default Character を更新したよ。");
      }, "Default Character の更新に失敗したよ。");
    },
    onArchiveCharacter: () => {
      void runCharacterEditorCommand(async (api) => {
        if (!characterDraft.characterId) {
          return;
        }
        await api.archiveCharacter(characterDraft.characterId);
        await refreshCharacterEntries(api);
        setCharacterEditorFeedback("Character を archive したよ。");
      }, "Character のarchiveに失敗したよ。");
    },
  };

  const isMateStateLoading = mateState === null;
  const canUsePrimaryFeatures = mateState !== null;

  const baseSettingsContentProps: HomeSettingsContentBaseProps = {
    settingsDraft,
    providerSettingRows,
    characterEntries,
    selectedCharacterId,
    characterDraft,
    characterEditorDirty,
    characterEditorBusy,
    characterEditorFeedback,
    modelCatalogRevisionLabel: String(modelCatalog?.revision ?? "-"),
    settingsDirty,
    settingsFeedback,
    ...settingsDraftHandlers,
    ...settingsCommandHandlers,
    ...characterEditorHandlers,
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
      characterEntries,
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
      onSelectMode: homeLaunchHandlers.onChangeMode,
      onChangeTitle: homeLaunchHandlers.onChangeTitle,
      onBrowseWorkspace: () => void homeLaunchHandlers.onBrowseWorkspace(),
      onSelectProvider: homeLaunchHandlers.onSelectLaunchProvider,
      onSelectCharacter: homeLaunchHandlers.onSelectLaunchCharacter,
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
