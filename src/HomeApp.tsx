import { useEffect, useMemo, useRef, useState } from "react";

import {
  createDefaultAppSettings,
  getProviderAppSettings,
  type AppSettings,
  type CharacterProfile,
  type CreateSessionInput,
  type ProviderAppSettings,
  type Session,
} from "./app-state.js";
import type { ModelCatalogSnapshot } from "./model-catalog.js";
import {
  SETTINGS_API_KEY_LABEL,
  SETTINGS_API_KEY_PLACEHOLDER,
  SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE,
  SETTINGS_CODING_CREDENTIALS_HELP,
  SETTINGS_RESET_DATABASE_CONFIRM_MESSAGE,
  SETTINGS_RESET_DATABASE_HELP,
  SETTINGS_RESET_DATABASE_LABEL,
  SETTINGS_RESET_DATABASE_SUCCESS_MESSAGE,
  SETTINGS_RELEASE_COMPATIBILITY_NOTE,
} from "./settings-ui.js";
import { buildCardThemeStyle, CharacterAvatar, sessionStateLabel } from "./ui-utils.js";

type LaunchWorkspace = {
  label: string;
  path: string;
  branch: string;
};

function inferWorkspaceFromPath(selectedPath: string): LaunchWorkspace {
  const normalized = selectedPath.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  const label = segments.at(-1) ?? normalized;

  return {
    label,
    path: selectedPath,
    branch: "main",
  };
}

async function openSessionWindow(sessionId: string) {
  if (!window.withmate) {
    return;
  }

  await window.withmate.openSession(sessionId);
}

async function openCharacterEditor(characterId?: string | null) {
  if (!window.withmate) {
    return;
  }

  await window.withmate.openCharacterEditor(characterId);
}

type HomeSessionState = {
  kind: "running" | "interrupted" | "error" | "neutral";
  label: string;
};

type HomeRightPaneView = "monitor" | "characters";

function getHomeSessionState(session: Session): HomeSessionState {
  if (session.status === "running" || session.runState === "running") {
    return {
      kind: "running",
      label: "実行中",
    };
  }

  if (session.runState === "interrupted") {
    return {
      kind: "interrupted",
      label: "中断",
    };
  }

  if (session.runState === "error") {
    return {
      kind: "error",
      label: "エラー",
    };
  }

  if (session.runState && session.runState !== "idle") {
    return {
      kind: "neutral",
      label: session.runState,
    };
  }

  return {
    kind: "neutral",
    label: sessionStateLabel(session),
  };
}

export default function HomeApp() {
  const isDesktopRuntime = typeof window !== "undefined" && !!window.withmate;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [openSessionWindowIds, setOpenSessionWindowIds] = useState<string[]>([]);
  const [sessionSearchText, setSessionSearchText] = useState("");
  const [characterSearchText, setCharacterSearchText] = useState("");
  const [rightPaneView, setRightPaneView] = useState<HomeRightPaneView>("monitor");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsFeedback, setSettingsFeedback] = useState("");
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [systemPromptPrefixDraft, setSystemPromptPrefixDraft] = useState("");
  const [codingProviderSettingsDraft, setCodingProviderSettingsDraft] = useState<Record<string, ProviderAppSettings>>({});
  const [resettingDatabase, setResettingDatabase] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchTitle, setLaunchTitle] = useState("");
  const [launchWorkspace, setLaunchWorkspace] = useState<LaunchWorkspace | null>(null);
  const [launchCharacterId, setLaunchCharacterId] = useState("");
  const [launchCharacterSearchText, setLaunchCharacterSearchText] = useState("");
  const settingsDirtyRef = useRef(false);
  const settingsOpenRef = useRef(false);

  const applyIncomingAppSettings = (settings: AppSettings, options?: { force?: boolean }) => {
    setAppSettings(settings);
    if (options?.force || !settingsOpenRef.current || !settingsDirtyRef.current) {
      setSystemPromptPrefixDraft(settings.systemPromptPrefix);
      setCodingProviderSettingsDraft(settings.codingProviderSettings);
    }
  };

  const syncLaunchCharacterId = (nextCharacters: CharacterProfile[]) => {
    setLaunchCharacterId((current) => {
      if (nextCharacters.find((character) => character.id === current)) {
        return current;
      }

      return nextCharacters[0]?.id ?? "";
    });
  };

  useEffect(() => {
    let active = true;

    if (!window.withmate) {
      return () => {
        active = false;
      };
    }

    void window.withmate.listSessions().then((nextSessions) => {
      if (active) {
        setSessions(nextSessions);
      }
    });
    void window.withmate.getAppSettings().then((settings) => {
      if (!active) {
        return;
      }

      applyIncomingAppSettings(settings);
    });
    void window.withmate.getModelCatalog(null).then((snapshot) => {
      if (active) {
        setModelCatalog(snapshot);
      }
    });

    void window.withmate.listCharacters().then((nextCharacters) => {
      if (!active) {
        return;
      }

      setCharacters(nextCharacters);
      syncLaunchCharacterId(nextCharacters);
    });

    const unsubscribeSessions = window.withmate.subscribeSessions((nextSessions) => {
      if (active) {
        setSessions(nextSessions);
      }
    });

    const unsubscribeCharacters = window.withmate.subscribeCharacters((nextCharacters) => {
      if (!active) {
        return;
      }

      setCharacters(nextCharacters);
      syncLaunchCharacterId(nextCharacters);
    });
    const unsubscribeModelCatalog = window.withmate.subscribeModelCatalog((snapshot) => {
      if (active) {
        setModelCatalog(snapshot);
      }
    });
    const unsubscribeAppSettings = window.withmate.subscribeAppSettings((settings) => {
      if (active) {
        applyIncomingAppSettings(settings);
      }
    });

    return () => {
      active = false;
      unsubscribeSessions();
      unsubscribeCharacters();
      unsubscribeModelCatalog();
      unsubscribeAppSettings();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let receivedSubscriptionUpdate = false;

    if (!window.withmate) {
      return () => {
        active = false;
      };
    }

    const unsubscribeOpenSessionWindowIds = window.withmate.subscribeOpenSessionWindowIds((nextSessionIds) => {
      if (!active) {
        return;
      }

      receivedSubscriptionUpdate = true;
      setOpenSessionWindowIds(nextSessionIds);
    });

    void window.withmate.listOpenSessionWindowIds().then((nextSessionIds) => {
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

  const selectedCharacter = useMemo(
    () => characters.find((character) => character.id === launchCharacterId) ?? characters[0] ?? null,
    [characters, launchCharacterId],
  );

  const normalizedSessionSearch = useMemo(() => sessionSearchText.trim().toLocaleLowerCase(), [sessionSearchText]);
  const matchesSessionSearch = (session: Session) => {
    if (!normalizedSessionSearch) {
      return true;
    }

    const haystacks = [session.taskTitle, session.workspacePath, session.workspaceLabel]
      .map((value) => value.toLocaleLowerCase());
    return haystacks.some((value) => value.includes(normalizedSessionSearch));
  };
  const filteredSessionEntries = useMemo(
    () =>
      sessions.filter(matchesSessionSearch).map((session) => ({
        session,
        state: getHomeSessionState(session),
      })),
    [sessions, normalizedSessionSearch],
  );
  const openSessionWindowIdSet = useMemo(() => new Set(openSessionWindowIds), [openSessionWindowIds]);
  const monitorEntries = useMemo(
    () => filteredSessionEntries.filter(({ session }) => openSessionWindowIdSet.has(session.id)),
    [filteredSessionEntries, openSessionWindowIdSet],
  );
  const runningMonitorEntries = useMemo(
    () => monitorEntries.filter(({ state }) => state.kind === "running"),
    [monitorEntries],
  );
  const nonRunningMonitorEntries = useMemo(
    () => monitorEntries.filter(({ state }) => state.kind !== "running"),
    [monitorEntries],
  );
  const normalizedCharacterSearch = useMemo(() => characterSearchText.trim().toLocaleLowerCase(), [characterSearchText]);
  const filteredCharacters = useMemo(() => {
    if (!normalizedCharacterSearch) {
      return characters;
    }

    return characters.filter((character) => {
      const haystacks = [character.name, character.description].map((value) => value.toLocaleLowerCase());
      return haystacks.some((value) => value.includes(normalizedCharacterSearch));
    });
  }, [characters, normalizedCharacterSearch]);
  const normalizedLaunchCharacterSearch = useMemo(
    () => launchCharacterSearchText.trim().toLocaleLowerCase(),
    [launchCharacterSearchText],
  );
  const filteredLaunchCharacters = useMemo(() => {
    if (!normalizedLaunchCharacterSearch) {
      return characters;
    }

    return characters.filter((character) => {
      const haystacks = [character.name, character.description].map((value) => value.toLocaleLowerCase());
      return haystacks.some((value) => value.includes(normalizedLaunchCharacterSearch));
    });
  }, [characters, normalizedLaunchCharacterSearch]);

  const renderSearchIcon = () => (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M13.9 12.5l3.6 3.6-1.4 1.4-3.6-3.6a6 6 0 1 1 1.4-1.4Zm-4.9.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"
        fill="currentColor"
      />
    </svg>
  );
  const hasOpenSessionWindows = openSessionWindowIds.length > 0;
  const monitorBaseEmptyMessage =
    filteredSessionEntries.length === 0
      ? normalizedSessionSearch
        ? "一致するセッションはないよ。"
        : "表示できるセッションはまだないよ。"
      : hasOpenSessionWindows
        ? "一致する開いているセッションはないよ。"
        : "開いているセッションはないよ。";
  const monitorRunningEmptyMessage =
    monitorEntries.length > 0 ? "実行中はないよ。" : monitorBaseEmptyMessage;
  const monitorCompletedEmptyMessage =
    monitorEntries.length > 0 ? "停止・完了はないよ。" : monitorBaseEmptyMessage;

  const handleBrowseWorkspace = async () => {
    if (!window.withmate) {
      return;
    }

    const selectedPath = await window.withmate.pickDirectory();
    if (!selectedPath) {
      return;
    }

    setLaunchWorkspace(inferWorkspaceFromPath(selectedPath));
  };

  const openLaunchDialog = () => {
    setLaunchTitle("");
    setLaunchWorkspace(null);
    setLaunchCharacterSearchText("");
    setLaunchOpen(true);
  };

  const closeLaunchDialog = () => {
    setLaunchOpen(false);
    setLaunchTitle("");
    setLaunchWorkspace(null);
    setLaunchCharacterSearchText("");
  };

  const handleStartSession = async () => {
    const normalizedLaunchTitle = launchTitle.trim();
    if (!window.withmate || !launchWorkspace || !selectedCharacter || !normalizedLaunchTitle) {
      return;
    }

    const sessionInput: CreateSessionInput = {
      taskTitle: normalizedLaunchTitle,
      workspaceLabel: launchWorkspace.label,
      workspacePath: launchWorkspace.path,
      branch: launchWorkspace.branch,
      characterId: selectedCharacter.id,
      character: selectedCharacter.name,
      characterIconPath: selectedCharacter.iconPath,
      characterThemeColors: selectedCharacter.themeColors,
      approvalMode: "on-request",
    };

    const createdSession = await window.withmate.createSession(sessionInput);
    closeLaunchDialog();
    await openSessionWindow(createdSession.id);
  };

  const handleImportModelCatalog = async () => {
    if (!window.withmate) {
      return;
    }

    try {
      const snapshot = await window.withmate.importModelCatalogFile();
      setSettingsFeedback(snapshot ? `model catalog revision ${snapshot.revision} を読み込んだよ。` : "読み込みをキャンセルしたよ。");
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : "model catalog の読み込みに失敗したよ。");
    }
  };

  const handleResetAppDatabase = async () => {
    if (!window.withmate || resettingDatabase) {
      return;
    }

    const confirmed = window.confirm(SETTINGS_RESET_DATABASE_CONFIRM_MESSAGE);
    if (!confirmed) {
      return;
    }

    setResettingDatabase(true);
    try {
      const result = await window.withmate.resetAppDatabase();
      setSessions(result.sessions);
      setModelCatalog(result.modelCatalog);
      applyIncomingAppSettings(result.appSettings, { force: true });
      setSettingsFeedback(SETTINGS_RESET_DATABASE_SUCCESS_MESSAGE);
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : "DB の初期化に失敗したよ。");
    } finally {
      setResettingDatabase(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!window.withmate) {
      return;
    }

    try {
      const nextSettings = await window.withmate.updateAppSettings({
        systemPromptPrefix: systemPromptPrefixDraft,
        codingProviderSettings: codingProviderSettingsDraft,
      });
      setAppSettings(nextSettings);
      setSystemPromptPrefixDraft(nextSettings.systemPromptPrefix);
      setCodingProviderSettingsDraft(nextSettings.codingProviderSettings);
      setSettingsFeedback("設定を保存したよ。");
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : "設定の保存に失敗したよ。");
    }
  };

  const handleChangeProviderEnabled = (providerId: string, enabled: boolean) => {
    setCodingProviderSettingsDraft((current) => ({
      ...current,
      [providerId]: {
        ...getProviderAppSettings(
          {
            systemPromptPrefix: systemPromptPrefixDraft,
            codingProviderSettings: current,
          },
          providerId,
        ),
        enabled,
      },
    }));
  };

  const handleChangeProviderApiKey = (providerId: string, apiKey: string) => {
    setCodingProviderSettingsDraft((current) => ({
      ...current,
      [providerId]: {
        ...getProviderAppSettings(
          {
            systemPromptPrefix: systemPromptPrefixDraft,
            codingProviderSettings: current,
          },
          providerId,
        ),
        apiKey,
      },
    }));
  };

  const providerSettingRows = useMemo(
    () =>
      (modelCatalog?.providers ?? []).map((provider) => ({
        provider,
        settings: getProviderAppSettings(
          {
            systemPromptPrefix: systemPromptPrefixDraft,
            codingProviderSettings: codingProviderSettingsDraft,
          },
          provider.id,
        ),
      })),
    [codingProviderSettingsDraft, modelCatalog, systemPromptPrefixDraft],
  );
  const settingsDirty = useMemo(() => {
    return (
      systemPromptPrefixDraft !== appSettings.systemPromptPrefix ||
      JSON.stringify(codingProviderSettingsDraft) !== JSON.stringify(appSettings.codingProviderSettings)
    );
  }, [appSettings.codingProviderSettings, appSettings.systemPromptPrefix, codingProviderSettingsDraft, systemPromptPrefixDraft]);

  useEffect(() => {
    settingsDirtyRef.current = settingsDirty;
  }, [settingsDirty]);

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  const handleExportModelCatalog = async () => {
    if (!window.withmate) {
      return;
    }

    try {
      const savedPath = await window.withmate.exportModelCatalogFile();
      setSettingsFeedback(savedPath ? `model catalog を保存したよ: ${savedPath}` : "保存をキャンセルしたよ。");
    } catch (error) {
      setSettingsFeedback(error instanceof Error ? error.message : "model catalog の保存に失敗したよ。");
    }
  };

  if (!isDesktopRuntime) {
    return (
      <div className="page-shell home-page">
        <main className="home-layout home-layout-minimal">
          <section className="panel empty-list-card rise-1">
            <p>Home は Electron から起動してね。</p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="page-shell home-page">
      <main className="home-layout rise-2">

        <section className="panel session-list-panel home-session-list-panel rise-3">
          <div className="home-panel-head">
            <div className="home-panel-copy">
              <h2>Recent Sessions</h2>
            </div>
          </div>

          <div className="toolbar-search-row">
            <label className="toolbar-search-field" aria-label="セッション検索">
              <span className="toolbar-search-icon" aria-hidden="true">
                {renderSearchIcon()}
              </span>
              <input
                className="toolbar-search-input"
                type="text"
                aria-label="セッション検索"
                value={sessionSearchText}
                onChange={(event) => setSessionSearchText(event.target.value)}
              />
            </label>
            <button className="start-session-button" type="button" onClick={() => openLaunchDialog()}>
              New Session
            </button>
          </div>

          <div className="session-card-list home-session-card-list">
            {filteredSessionEntries.length > 0 ? (
              filteredSessionEntries.map(({ session, state }) => (
                <button
                  key={session.id}
                  className="session-card home-session-card"
                  type="button"
                  style={buildCardThemeStyle(session.characterThemeColors)}
                  onClick={() => void openSessionWindow(session.id)}
                >
                  <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="small" className="session-card-avatar" />
                  <div className="session-card-copy">
                    <div className="session-card-topline home-session-card-topline">
                      <strong>{session.taskTitle}</strong>
                      <span className={`session-status home-session-status ${state.kind}`.trim()}>{state.label}</span>
                    </div>
                    <div className="session-card-subline home-session-card-meta">
                      <span>{`Workspace : ${session.workspacePath || session.workspaceLabel}`}</span>
                      <span>{`updatedAt: ${session.updatedAt}`}</span>
                    </div>
                    {session.taskSummary.trim() ? <p className="session-card-summary home-session-card-summary">{session.taskSummary}</p> : null}
                  </div>
                </button>
              ))
            ) : normalizedSessionSearch ? (
              <article className="empty-list-card">
                <p>一致するセッションはないよ。</p>
              </article>
            ) : (
              <article className="empty-list-card">
                <p>まだセッションはないよ。</p>
                <button className="start-session-button" type="button" onClick={() => openLaunchDialog()}>
                  New Session
                </button>
              </article>
            )}
          </div>
        </section>

        <section className="panel home-right-pane rise-3">
          <div className="home-settings-rail">
            <div className="home-pane-toggle" role="tablist" aria-label="Home right pane">
              <button
                className={`home-pane-toggle-button ${rightPaneView === "monitor" ? "active" : ""}`.trim()}
                type="button"
                role="tab"
                aria-selected={rightPaneView === "monitor"}
                onClick={() => setRightPaneView("monitor")}
              >
                Session Monitor
              </button>
              <button
                className={`home-pane-toggle-button ${rightPaneView === "characters" ? "active" : ""}`.trim()}
                type="button"
                role="tab"
                aria-selected={rightPaneView === "characters"}
                onClick={() => setRightPaneView("characters")}
              >
                Characters
              </button>
            </div>
            <button className="launch-toggle home-settings-button" type="button" onClick={() => setSettingsOpen(true)}>
              Settings
            </button>
          </div>

          {rightPaneView === "monitor" ? (
            <section className="home-monitor-panel" role="tabpanel" aria-label="Session Monitor">
              <div className="home-monitor-body">
                <section className="home-monitor-section" aria-labelledby="home-monitor-running">
                  <div className="home-monitor-section-head">
                    <h3 id="home-monitor-running">実行中</h3>
                    <span className="home-monitor-count">{runningMonitorEntries.length}</span>
                  </div>
                  <div className="home-monitor-list">
                    {runningMonitorEntries.length > 0 ? (
                      runningMonitorEntries.map(({ session, state }) => (
                        <button
                          key={session.id}
                          className="home-monitor-row"
                          type="button"
                          onClick={() => void openSessionWindow(session.id)}
                        >
                          <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="tiny" />
                          <div className="home-monitor-row-copy">
                            <strong>{session.taskTitle}</strong>
                            <span>{session.workspaceLabel || session.workspacePath || "workspace 未設定"}</span>
                          </div>
                          <span className={`session-status home-monitor-status ${state.kind}`.trim()}>{state.label}</span>
                        </button>
                      ))
                    ) : (
                      <p className="home-monitor-empty">{monitorRunningEmptyMessage}</p>
                    )}
                  </div>
                </section>

                <section className="home-monitor-section" aria-labelledby="home-monitor-inactive">
                  <div className="home-monitor-section-head">
                    <h3 id="home-monitor-inactive">停止・完了</h3>
                    <span className="home-monitor-count">{nonRunningMonitorEntries.length}</span>
                  </div>
                  <div className="home-monitor-list">
                    {nonRunningMonitorEntries.length > 0 ? (
                      nonRunningMonitorEntries.map(({ session, state }) => (
                        <button
                          key={session.id}
                          className="home-monitor-row"
                          type="button"
                          onClick={() => void openSessionWindow(session.id)}
                        >
                          <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="tiny" />
                          <div className="home-monitor-row-copy">
                            <strong>{session.taskTitle}</strong>
                            <span>{session.workspaceLabel || session.workspacePath || "workspace 未設定"}</span>
                          </div>
                          <span className={`session-status home-monitor-status ${state.kind}`.trim()}>{state.label}</span>
                        </button>
                      ))
                    ) : (
                      <p className="home-monitor-empty">{monitorCompletedEmptyMessage}</p>
                    )}
                  </div>
                </section>
              </div>
            </section>
          ) : (
            <section className="characters-panel home-characters-panel" role="tabpanel" aria-label="Characters">
              <div className="toolbar-search-row home-character-toolbar">
                <label className="toolbar-search-field" aria-label="キャラクター検索">
                  <span className="toolbar-search-icon" aria-hidden="true">
                    {renderSearchIcon()}
                  </span>
                  <input
                    className="toolbar-search-input"
                    type="text"
                    aria-label="キャラクター検索"
                    value={characterSearchText}
                    onChange={(event) => setCharacterSearchText(event.target.value)}
                  />
                </label>
                <button className="launch-toggle" type="button" onClick={() => void openCharacterEditor()}>
                  Add Character
                </button>
              </div>

              <div className="character-list">
                {filteredCharacters.length > 0 ? (
                  filteredCharacters.map((character) => (
                    <button
                      key={character.id}
                      className="character-card"
                      type="button"
                      style={buildCardThemeStyle(character.themeColors)}
                      onClick={() => void openCharacterEditor(character.id)}
                    >
                      <CharacterAvatar character={character} size="small" className="character-card-avatar" />
                      <div className="character-card-copy">
                        <strong>{character.name}</strong>
                      </div>
                    </button>
                  ))
                ) : characters.length > 0 && normalizedCharacterSearch ? (
                  <article className="empty-list-card">
                    <p>一致するキャラはないよ。</p>
                  </article>
                ) : (
                  <article className="empty-list-card">
                    <p>まだキャラはないよ。</p>
                    <button className="launch-toggle" type="button" onClick={() => void openCharacterEditor()}>
                      Add Character
                    </button>
                  </article>
                )}
              </div>
            </section>
          )}
        </section>
      </main>

      {launchOpen ? (
        <div className="launch-modal" role="dialog" aria-modal="true" onClick={() => closeLaunchDialog()}>
          <section className="launch-dialog panel" onClick={(event) => event.stopPropagation()}>
            <div className="launch-dialog-head minimal">
              <button className="diff-close" type="button" onClick={() => closeLaunchDialog()}>
                Close
              </button>
            </div>

            <div className="launch-panel minimal">
              <section className="launch-section minimal">
                <div className="launch-field">
                  <label className="launch-field-label" htmlFor="launch-session-title">
                    セッションタイトル
                  </label>
                  <input
                    id="launch-session-title"
                    className="launch-field-input"
                    type="text"
                    value={launchTitle}
                    onChange={(event) => setLaunchTitle(event.target.value)}
                  />
                </div>
              </section>

              <section className="launch-section workspace-picker minimal">
                <div className="section-head compact-actions">
                  <button className="browse-button" type="button" onClick={() => void handleBrowseWorkspace()}>
                    Browse
                  </button>
                </div>

                <p className={`launch-path${launchWorkspace ? " selected" : ""}`}>{launchWorkspace ? launchWorkspace.path : "workspace"}</p>
              </section>

              <section className="launch-section profile-panel minimal">
                {characters.length > 0 ? (
                  <>
                    <div className="launch-search-row">
                      <label className="toolbar-search-field" aria-label="キャラ検索">
                        <span className="toolbar-search-icon">{renderSearchIcon()}</span>
                        <input
                          className="toolbar-search-input"
                          type="text"
                          value={launchCharacterSearchText}
                          onChange={(event) => setLaunchCharacterSearchText(event.target.value)}
                        />
                      </label>
                    </div>

                    {filteredLaunchCharacters.length > 0 ? (
                      <div className="choice-card-list">
                        {filteredLaunchCharacters.map((character) => (
                          <button
                            key={character.id}
                            className={`choice-card${character.id === selectedCharacter?.id ? " active" : ""}`}
                            style={buildCardThemeStyle(character.themeColors)}
                            type="button"
                            onClick={() => setLaunchCharacterId(character.id)}
                          >
                            <CharacterAvatar character={character} size="small" className="choice-avatar" />
                            <div className="choice-card-copy">
                              <strong>{character.name}</strong>
                              <span>{character.description || "キャラクターを選ぶ"}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <article className="empty-list-card compact">
                        <p>一致するキャラはないよ。</p>
                      </article>
                    )}
                  </>
                ) : (
                  <article className="empty-list-card compact">
                    <p>セッションを始める前にキャラを作ってね。</p>
                    <button className="launch-toggle" type="button" onClick={() => void openCharacterEditor()}>
                      Add Character
                    </button>
                  </article>
                )}

              </section>
            </div>

            <div className="launch-dialog-foot minimal">
              <button
                className="start-session-button"
                type="button"
                disabled={!launchTitle.trim() || !launchWorkspace || !selectedCharacter}
                onClick={() => void handleStartSession()}
              >
                Start New Session
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="launch-modal settings-modal" role="dialog" aria-modal="true" onClick={() => setSettingsOpen(false)}>
          <section className="launch-dialog settings-dialog panel" onClick={(event) => event.stopPropagation()}>
            <div className="launch-dialog-head minimal">
              <button className="diff-close" type="button" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>

            <div className="settings-panel">
              <section className="settings-section">
                <p className="settings-note">{SETTINGS_RELEASE_COMPATIBILITY_NOTE}</p>

                <section className="settings-section-card">
                  <div className="settings-field">
                    <strong>System Prompt Prefix</strong>
                    <p className="settings-help">保存時に先頭へ <code># System Prompt</code> が自動で付く。</p>
                    <textarea
                      value={systemPromptPrefixDraft}
                      onChange={(event) => setSystemPromptPrefixDraft(event.target.value)}
                      rows={8}
                    />
                  </div>
                  <div className="settings-actions">
                    <button className="launch-toggle" type="button" onClick={() => void handleSaveSettings()} disabled={!settingsDirty}>
                      Save Settings
                    </button>
                  </div>
                </section>

                {providerSettingRows.length > 0 ? (
                  <>
                    <section className="settings-section-card">
                      <div className="settings-field">
                        <strong>Coding Agent Providers</strong>
                        <p className="settings-help">有効な coding provider は使える前提で扱う。失敗時は実行時エラーとして返る。</p>
                        <div className="settings-provider-list">
                          {providerSettingRows.map(({ provider, settings }) => (
                            <section key={provider.id} className="settings-provider-card">
                              <label className="settings-provider-toggle">
                                <input
                                  type="checkbox"
                                  checked={settings.enabled}
                                  onChange={(event) => handleChangeProviderEnabled(provider.id, event.target.checked)}
                                />
                                <span>{provider.label}</span>
                              </label>
                            </section>
                          ))}
                        </div>
                      </div>
                    </section>

                    <section className="settings-section-card">
                      <div className="settings-field">
                        <strong>Coding Agent Credentials</strong>
                        <p className="settings-help">{SETTINGS_CODING_CREDENTIALS_HELP}</p>
                        <div className="settings-provider-list">
                          {providerSettingRows.map(({ provider, settings }) => (
                            <section key={provider.id} className="settings-provider-card">
                              <p className="settings-provider-name">{provider.label}</p>
                              <label className="settings-provider-input">
                                <span>{SETTINGS_API_KEY_LABEL}</span>
                                <input
                                  type="password"
                                  value={settings.apiKey}
                                  onChange={(event) => handleChangeProviderApiKey(provider.id, event.target.value)}
                                  placeholder={SETTINGS_API_KEY_PLACEHOLDER}
                                  autoComplete="off"
                                  spellCheck={false}
                                />
                              </label>
                            </section>
                          ))}
                        </div>
                        <p className="settings-note">{SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE}</p>
                      </div>
                    </section>
                  </>
                ) : null}

                <section className="settings-section-card">
                  <div className="settings-field">
                    <strong>Model Catalog</strong>
                    <p className="settings-help">
                      active revision: {modelCatalog?.revision ?? "-"}。DB 初期化を行うと bundled catalog の初期状態へ戻る。
                    </p>
                    <div className="settings-actions">
                      <button className="launch-toggle" type="button" onClick={() => void handleImportModelCatalog()}>
                        Import Models
                      </button>
                      <button className="launch-toggle" type="button" onClick={() => void handleExportModelCatalog()}>
                        Export Models
                      </button>
                    </div>
                  </div>
                </section>

                <section className="settings-section-card danger-zone">
                  <div className="settings-field">
                    <strong>Danger Zone</strong>
                    <p className="settings-help">{SETTINGS_RESET_DATABASE_HELP}</p>
                    <ul className="settings-danger-list">
                      <li>reset 対象: sessions / audit logs / app settings / model catalog</li>
                      <li>reset 非対象: characters（DB 外ファイルなので保持）</li>
                    </ul>
                    <div className="settings-actions">
                      <button className="drawer-toggle danger" type="button" onClick={() => void handleResetAppDatabase()} disabled={resettingDatabase}>
                        {resettingDatabase ? "DB 初期化中..." : SETTINGS_RESET_DATABASE_LABEL}
                      </button>
                    </div>
                  </div>
                </section>

                {settingsFeedback ? <p className="settings-feedback">{settingsFeedback}</p> : null}
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
