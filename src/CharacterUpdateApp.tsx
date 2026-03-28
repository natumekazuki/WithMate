import { useEffect, useMemo, useState } from "react";

import type { AuditLogEntry, LiveSessionRunState, Session } from "./app-state.js";
import {
  buildCharacterUpdateLatestCommandView,
  selectLatestCharacterUpdateSession,
  type CharacterUpdatePaneTabKey,
} from "./character-update-projection.js";
import { CharacterAvatar } from "./ui-utils.js";
import { getCharacterIdFromLocation, isCharacterUpdateMode, type CharacterProfile } from "./character-state.js";
import type { CharacterUpdateMemoryExtract, CharacterUpdateWorkspace } from "./character-update-state.js";
import { createDefaultAppSettings, getProviderAppSettings, type AppSettings } from "./provider-settings-state.js";
import type { ModelCatalogSnapshot } from "./model-catalog.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { liveRunStepStatusLabel } from "./ui-utils.js";

function getUpdateCharacterId(): string | null {
  return isCharacterUpdateMode() ? getCharacterIdFromLocation() : null;
}

export default function CharacterUpdateApp() {
  const desktopRuntime = isDesktopRuntime();
  const characterId = useMemo(() => getUpdateCharacterId(), []);
  const [character, setCharacter] = useState<CharacterProfile | null>(null);
  const [workspace, setWorkspace] = useState<CharacterUpdateWorkspace | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [memoryExtract, setMemoryExtract] = useState<CharacterUpdateMemoryExtract | null>(null);
  const [linkedSessionLiveRun, setLinkedSessionLiveRun] = useState<LiveSessionRunState | null>(null);
  const [linkedSessionAuditLogs, setLinkedSessionAuditLogs] = useState<AuditLogEntry[]>([]);
  const [activePaneTab, setActivePaneTab] = useState<CharacterUpdatePaneTabKey>("latest-command");
  const [loadingExtract, setLoadingExtract] = useState(false);
  const [startingSession, setStartingSession] = useState(false);

  useEffect(() => {
    let active = true;
    const api = getWithMateApi();
    if (!api || !characterId) {
      return () => {
        active = false;
      };
    }

    void Promise.all([
      api.getCharacter(characterId),
      api.getCharacterUpdateWorkspace(characterId),
      api.listSessions(),
      api.getAppSettings(),
      api.getModelCatalog(null),
    ]).then(([nextCharacter, nextWorkspace, nextSessions, nextSettings, nextCatalog]) => {
      if (!active) {
        return;
      }
      setCharacter(nextCharacter);
      setWorkspace(nextWorkspace);
      setSessions(nextSessions);
      setAppSettings(nextSettings);
      setModelCatalog(nextCatalog);
    });

    const unsubscribeCharacters = api.subscribeCharacters(() => {
      void api.getCharacter(characterId).then((nextCharacter) => {
        if (active) {
          setCharacter(nextCharacter);
        }
      });
      void api.getCharacterUpdateWorkspace(characterId).then((nextWorkspace) => {
        if (active) {
          setWorkspace(nextWorkspace);
        }
      });
    });
    const unsubscribeSessions = api.subscribeSessions((nextSessions) => {
      if (active) {
        setSessions(nextSessions);
      }
    });
    const unsubscribeAppSettings = api.subscribeAppSettings((nextSettings) => {
      if (active) {
        setAppSettings(nextSettings);
      }
    });
    const unsubscribeModelCatalog = api.subscribeModelCatalog((nextCatalog) => {
      if (active) {
        setModelCatalog(nextCatalog);
      }
    });

    return () => {
      active = false;
      unsubscribeCharacters();
      unsubscribeSessions();
      unsubscribeAppSettings();
      unsubscribeModelCatalog();
    };
  }, [characterId]);

  const enabledProviders = useMemo(() => {
    return (modelCatalog?.providers ?? []).filter((provider) => getProviderAppSettings(appSettings, provider.id).enabled);
  }, [appSettings, modelCatalog]);

  useEffect(() => {
    if (!enabledProviders.find((provider) => provider.id === selectedProviderId)) {
      setSelectedProviderId(enabledProviders[0]?.id ?? "");
    }
  }, [enabledProviders, selectedProviderId]);

  const selectedInstructionPath = useMemo(() => {
    if (!workspace) {
      return "";
    }
    return selectedProviderId === "copilot" ? workspace.copilotInstructionPath : workspace.codexInstructionPath;
  }, [selectedProviderId, workspace]);
  const linkedSession = useMemo(
    () => selectLatestCharacterUpdateSession(sessions, characterId),
    [characterId, sessions],
  );
  const latestCommandView = useMemo(
    () => buildCharacterUpdateLatestCommandView({
      liveRun: linkedSessionLiveRun,
      auditLogs: linkedSessionAuditLogs,
    }),
    [linkedSessionAuditLogs, linkedSessionLiveRun],
  );
  const hasRunningLinkedCommand = useMemo(
    () =>
      linkedSession?.status === "running"
      || (linkedSessionLiveRun?.steps ?? []).some((step) => step.status === "in_progress"),
    [linkedSession?.status, linkedSessionLiveRun?.steps],
  );

  useEffect(() => {
    if (hasRunningLinkedCommand) {
      setActivePaneTab("latest-command");
    }
  }, [hasRunningLinkedCommand]);

  useEffect(() => {
    let active = true;
    const api = getWithMateApi();
    const linkedSessionId = linkedSession?.id;
    if (!api || !linkedSessionId) {
      setLinkedSessionLiveRun(null);
      setLinkedSessionAuditLogs([]);
      return () => {
        active = false;
      };
    }

    void Promise.all([
      api.getLiveSessionRun(linkedSessionId),
      api.listSessionAuditLogs(linkedSessionId),
    ]).then(([nextLiveRun, nextAuditLogs]) => {
      if (!active) {
        return;
      }
      setLinkedSessionLiveRun(nextLiveRun);
      setLinkedSessionAuditLogs(nextAuditLogs);
    });

    const unsubscribeLiveRun = api.subscribeLiveSessionRun((sessionId, state) => {
      if (active && sessionId === linkedSessionId) {
        setLinkedSessionLiveRun(state);
      }
    });

    return () => {
      active = false;
      unsubscribeLiveRun();
    };
  }, [linkedSession?.id, linkedSession?.updatedAt]);

  const handleExtract = async () => {
    const api = getWithMateApi();
    if (!api || !characterId || loadingExtract) {
      return;
    }
    setLoadingExtract(true);
    try {
      setMemoryExtract(await api.extractCharacterUpdateMemory(characterId));
    } finally {
      setLoadingExtract(false);
    }
  };

  const handleCopy = async () => {
    if (!memoryExtract?.text) {
      return;
    }
    await navigator.clipboard.writeText(memoryExtract.text);
  };

  const handleStartSession = async () => {
    const api = getWithMateApi();
    if (!api || !characterId || !selectedProviderId || startingSession) {
      return;
    }
    setStartingSession(true);
    try {
      const session = await api.createCharacterUpdateSession(characterId, selectedProviderId);
      setActivePaneTab("latest-command");
      await api.openSession(session.id);
    } finally {
      setStartingSession(false);
    }
  };

  if (!desktopRuntime) {
    return (
      <div className="page-shell character-update-page">
        <main className="character-update-layout">
          <section className="panel empty-list-card rise-1">
            <p>Character Update は Electron から開いてね。</p>
          </section>
        </main>
      </div>
    );
  }

  if (!characterId) {
    return (
      <div className="page-shell character-update-page">
        <main className="character-update-layout">
          <section className="panel empty-list-card rise-1">
            <p>characterId が見つからないよ。</p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="page-shell character-update-page">
      <header className="panel session-window-bar rise-1">
        <span className="session-window-title">
          {character ? `${character.name} Update Workspace` : "Character Update Workspace"}
        </span>
        <button className="drawer-toggle" type="button" onClick={() => window.close()}>
          Close Window
        </button>
      </header>

      <main className="character-update-layout rise-2">
        <section className="panel character-update-main">
          <div className="character-update-head">
            <CharacterAvatar
              character={{ name: character?.name ?? "Character", iconPath: character?.iconPath ?? "" }}
              size="large"
              className="character-editor-avatar"
            />
            <div className="character-update-head-copy">
              <strong>{character?.name ?? "Character"}</strong>
              <span>{workspace?.workspacePath ?? ""}</span>
            </div>
          </div>

          <section className="character-update-section">
            <strong>Provider</strong>
            <div className="choice-list launch-provider-list" role="listbox" aria-label="Character Update Provider">
              {enabledProviders.map((provider) => (
                <button
                  key={provider.id}
                  className={`choice-chip${provider.id === selectedProviderId ? " active" : ""}`}
                  type="button"
                  aria-selected={provider.id === selectedProviderId}
                  onClick={() => setSelectedProviderId(provider.id)}
                >
                  {provider.label}
                </button>
              ))}
            </div>
          </section>

          <section className="character-update-section">
            <strong>Files</strong>
            <div className="character-update-file-list">
              <code>{workspace?.characterMarkdownPath ?? ""}</code>
              <code>{workspace?.characterNotesPath ?? ""}</code>
              <code>{selectedInstructionPath}</code>
            </div>
          </section>

          <section className="character-update-section">
            <div className="character-update-actions">
              <button
                className="start-session-button"
                type="button"
                onClick={() => void handleStartSession()}
                disabled={!selectedProviderId || startingSession}
              >
                {startingSession ? "Starting..." : "Start Update Session"}
              </button>
            </div>
          </section>
        </section>

        <aside className="panel character-update-side">
          <section className="command-monitor-shell character-update-monitor-shell" aria-label="Character Update 右ペイン">
            <div className="command-monitor-head">
              <div className="character-update-pane-toggle" role="tablist" aria-label="Character Update 右ペイン表示切り替え">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activePaneTab === "latest-command"}
                  className={`character-update-pane-toggle-button${activePaneTab === "latest-command" ? " active" : ""}`}
                  onClick={() => setActivePaneTab("latest-command")}
                >
                  LatestCommand
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activePaneTab === "memory-extract"}
                  className={`character-update-pane-toggle-button${activePaneTab === "memory-extract" ? " active" : ""}`}
                  onClick={() => setActivePaneTab("memory-extract")}
                >
                  MemoryExtract
                </button>
              </div>
            </div>

            <div className="command-monitor-content">
              <div className="command-monitor-stack">
                {activePaneTab === "latest-command" ? (
                  latestCommandView ? (
                    <div className="command-monitor-card">
                      <div className="command-monitor-card-head">
                        <div className="command-monitor-meta">
                          <span className={`live-run-step-status ${latestCommandView.status}`}>
                            {liveRunStepStatusLabel(latestCommandView.status)}
                          </span>
                          <span className="live-run-step-type">Command</span>
                          <span className="command-monitor-source">
                            {latestCommandView.sourceLabel === "live" ? "RUN LIVE" : "LAST RUN"}
                          </span>
                        </div>
                      </div>

                      <div className="live-run-command-summary" aria-label="実行コマンド">
                        <span className="live-run-command-prefix" aria-hidden="true">
                          $
                        </span>
                        <code className="live-run-command-text">{latestCommandView.summary}</code>
                      </div>

                      {latestCommandView.details ? (
                        <details className="command-monitor-details live-run-step-details">
                          <summary>command_execution の詳細</summary>
                          <pre>{latestCommandView.details}</pre>
                        </details>
                      ) : null}

                      {linkedSessionLiveRun?.errorMessage ? (
                        <div className="live-run-error-block" role="alert">
                          <strong>実行エラー</strong>
                          <p className="live-run-error">{linkedSessionLiveRun.errorMessage}</p>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="command-monitor-empty-shell" />
                  )
                ) : null}

                {activePaneTab === "memory-extract" ? (
                  <div className="command-monitor-card">
                    <div className="character-update-extract-head">
                      <div className="command-monitor-meta">
                        <strong>Memory Extract</strong>
                        <span className="command-monitor-source">{memoryExtract?.entryCount ?? 0}</span>
                      </div>
                      <div className="character-update-extract-actions">
                        <button className="launch-toggle compact" type="button" onClick={() => void handleExtract()} disabled={loadingExtract}>
                          {loadingExtract ? "Extracting..." : "Refresh"}
                        </button>
                        <button className="launch-toggle compact" type="button" onClick={() => void handleCopy()} disabled={!memoryExtract?.text}>
                          Copy
                        </button>
                      </div>
                    </div>
                    <textarea
                      className="character-update-extract"
                      value={memoryExtract?.text ?? ""}
                      readOnly
                      spellCheck={false}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}
