import { useEffect, useMemo, useState } from "react";

import {
  buildCharacterEditorUrl,
  buildNewSession,
  buildSessionUrl,
  ensureBrowserMockCharacters,
  ensureBrowserMockSessions,
  saveBrowserMockCharacters,
  saveBrowserMockSessions,
  type CharacterProfile,
  type CreateSessionInput,
  type Session,
} from "./mock-data.js";
import { approvalModeOptions, CharacterAvatar, sessionStateClassName, sessionStateLabel } from "./mock-ui.js";

type LaunchWorkspace = {
  label: string;
  path: string;
  branch: string;
};

async function openSessionWindow(sessionId: string) {
  if (window.withmate) {
    await window.withmate.openSession(sessionId);
    return;
  }

  const url = buildSessionUrl(sessionId);
  const opened = window.open(url, "_blank", "popup,width=1440,height=940");

  if (!opened) {
    window.location.href = url;
  }
}

async function openCharacterEditor(characterId?: string | null) {
  if (window.withmate) {
    await window.withmate.openCharacterEditor(characterId);
    return;
  }

  const url = buildCharacterEditorUrl(characterId);
  const opened = window.open(url, "_blank", "popup,width=980,height=840");

  if (!opened) {
    window.location.href = url;
  }
}

async function listSessionsForRenderer(): Promise<Session[]> {
  if (window.withmate) {
    return window.withmate.listSessions();
  }

  return ensureBrowserMockSessions();
}

async function listCharactersForRenderer(): Promise<CharacterProfile[]> {
  if (window.withmate) {
    return window.withmate.listCharacters();
  }

  return ensureBrowserMockCharacters();
}

function inferWorkspaceFromPath(selectedPath: string): LaunchWorkspace {
  const normalized = selectedPath.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[/\\]/).filter(Boolean);
  const label = segments.at(-1) ?? normalized;

  return {
    label,
    path: selectedPath,
    branch: "main",
  };
}

export default function HomeApp() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsFeedback, setSettingsFeedback] = useState("");
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchWorkspace, setLaunchWorkspace] = useState<LaunchWorkspace | null>(null);
  const [launchCharacterId, setLaunchCharacterId] = useState<string>("");
  const [launchApproval, setLaunchApproval] = useState("on-request");

  useEffect(() => {
    let active = true;

    void listSessionsForRenderer().then((nextSessions) => {
      if (active) {
        setSessions(nextSessions);
      }
    });

    void listCharactersForRenderer().then((nextCharacters) => {
      if (active) {
        setCharacters(nextCharacters);
        setLaunchCharacterId((current) => current || nextCharacters[0]?.id || "");
      }
    });

    const unsubs: Array<() => void> = [];

    if (window.withmate) {
      unsubs.push(
        window.withmate.subscribeSessions((nextSessions) => {
          if (active) {
            setSessions(nextSessions);
          }
        }),
      );
      unsubs.push(
        window.withmate.subscribeCharacters((nextCharacters) => {
          if (!active) {
            return;
          }

          setCharacters(nextCharacters);
          if (!nextCharacters.find((character) => character.id === launchCharacterId)) {
            setLaunchCharacterId(nextCharacters[0]?.id ?? "");
          }
        }),
      );

      return () => {
        active = false;
        for (const unsub of unsubs) {
          unsub();
        }
      };
    }

    const handleStorage = () => {
      if (!active) {
        return;
      }

      setSessions(ensureBrowserMockSessions());
      const nextCharacters = ensureBrowserMockCharacters();
      setCharacters(nextCharacters);
      if (!nextCharacters.find((character) => character.id === launchCharacterId)) {
        setLaunchCharacterId(nextCharacters[0]?.id ?? "");
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => {
      active = false;
      window.removeEventListener("storage", handleStorage);
    };
  }, [launchCharacterId]);

  const selectedCharacter = useMemo(
    () => characters.find((character) => character.id === launchCharacterId) ?? characters[0] ?? null,
    [characters, launchCharacterId],
  );

  const runningSessions = useMemo(
    () => sessions.filter((session) => session.status === "running" || session.runState === "running"),
    [sessions],
  );
  const interruptedSessions = useMemo(
    () => sessions.filter((session) => session.runState === "interrupted"),
    [sessions],
  );

  const idleSessions = useMemo(
    () => sessions.filter((session) => session.status !== "running" && session.runState !== "running" && session.runState !== "interrupted"),
    [sessions],
  );

  const handleBrowseWorkspace = async () => {
    if (!window.withmate) {
      const enteredPath = window.prompt("workspace のパスを入力してね", launchWorkspace?.path ?? "");
      if (!enteredPath?.trim()) {
        return;
      }

      setLaunchWorkspace(inferWorkspaceFromPath(enteredPath.trim()));
      return;
    }

    const selectedPath = await window.withmate.pickDirectory();
    if (!selectedPath) {
      return;
    }

    setLaunchWorkspace(inferWorkspaceFromPath(selectedPath));
  };

  const handleStartSession = async () => {
    if (!launchWorkspace || !selectedCharacter) {
      return;
    }

    const sessionInput: CreateSessionInput = {
      workspaceLabel: launchWorkspace.label,
      workspacePath: launchWorkspace.path,
      branch: launchWorkspace.branch,
      characterId: selectedCharacter.id,
      character: selectedCharacter.name,
      characterIconPath: selectedCharacter.iconPath,
      approvalMode: launchApproval,
    };

    const createdSession = window.withmate
      ? await window.withmate.createSession(sessionInput)
      : buildNewSession(sessionInput);

    if (!window.withmate) {
      const nextSessions = [createdSession, ...sessions];
      saveBrowserMockSessions(nextSessions);
      setSessions(nextSessions);
    }

    setLaunchOpen(false);
    await openSessionWindow(createdSession.id);
  };

  const handleImportModelCatalog = async () => {
    if (!window.withmate) {
      return;
    }

    try {
      const snapshot = await window.withmate.importModelCatalogFile();
      if (!snapshot) {
        return;
      }

      setSettingsFeedback(`model catalog を revision ${snapshot.revision} として読み込んだよ。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsFeedback(`model catalog の読み込みに失敗したよ。${message}`);
    }
  };

  const handleExportModelCatalog = async () => {
    if (!window.withmate) {
      return;
    }

    try {
      const savedPath = await window.withmate.exportModelCatalogFile();
      if (!savedPath) {
        return;
      }

      setSettingsFeedback(`model catalog を保存したよ。${savedPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsFeedback(`model catalog の保存に失敗したよ。${message}`);
    }
  };

  const handleOpenSettings = () => {
    setSettingsFeedback("");
    setSettingsOpen(true);
  };

  return (
    <div className="page-shell home-page">
      <header className="panel home-toolbar rise-1">
        <div className="app-icon" aria-hidden="true">
          WM
        </div>
        <div className="home-toolbar-actions">
          <button className="launch-toggle" type="button" onClick={handleOpenSettings}>
            Settings
          </button>
          <button className="launch-toggle" type="button" onClick={() => void openCharacterEditor()}>
            Add Character
          </button>
          <button className="launch-toggle" type="button" onClick={() => setLaunchOpen(true)}>
            New Session
          </button>
        </div>
      </header>

      <main className="home-layout home-layout-manage">
        <section className="panel sessions-panel rise-2">
          {runningSessions.length > 0 ? (
            <div className="running-session-strip">
              {runningSessions.map((session) => (
                <button
                  key={`running-${session.id}`}
                  className="running-session-chip"
                  type="button"
                  onClick={() => void openSessionWindow(session.id)}
                >
                  <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="tiny" />
                  <span className={`session-status ${sessionStateClassName(session)}`}>{sessionStateLabel(session)}</span>
                  <span>{session.taskTitle}</span>
                </button>
              ))}
            </div>
          ) : null}

          {interruptedSessions.length > 0 ? (
            <div className="running-session-strip interrupted">
              {interruptedSessions.map((session) => (
                <button
                  key={`interrupted-${session.id}`}
                  className="running-session-chip interrupted"
                  type="button"
                  onClick={() => void openSessionWindow(session.id)}
                >
                  <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="tiny" />
                  <span className={`session-status ${sessionStateClassName(session)}`}>{sessionStateLabel(session)}</span>
                  <span>{session.taskTitle}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="session-list">
            {sessions.length > 0 ? (
              (runningSessions.length > 0 || interruptedSessions.length > 0 ? idleSessions : sessions).map((session) => (
                <button
                  key={session.id}
                  className="session-card"
                  type="button"
                  onClick={() => void openSessionWindow(session.id)}
                >
                  <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="small" className="session-avatar" />
                  <div className="session-main">
                    <div className="session-card-head">
                      <h3>{session.taskTitle}</h3>
                      <span className={`session-status ${sessionStateClassName(session)}`}>{sessionStateLabel(session)}</span>
                    </div>

                    <div className="session-meta-row">
                      <span>{session.workspaceLabel}</span>
                      <span>{session.updatedAt}</span>
                    </div>

                    <p className="session-card-summary">{session.taskSummary}</p>
                  </div>
                </button>
              ))
            ) : (
              <article className="empty-list-card">
                <p>まだセッションはないよ。</p>
              </article>
            )}
          </div>
        </section>

        <section className="panel characters-panel rise-3">
          <div className="character-list">
            {characters.length > 0 ? (
              characters.map((character) => (
                <article key={character.id} className="character-card">
                  <CharacterAvatar character={character} size="small" className="character-card-avatar" />
                  <div className="character-card-copy">
                    <strong>{character.name}</strong>
                    <p>{character.description}</p>
                  </div>
                  <button className="character-edit-button" type="button" onClick={() => void openCharacterEditor(character.id)}>
                    Edit
                  </button>
                </article>
              ))
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
      </main>

      {launchOpen ? (
        <div className="launch-modal" role="dialog" aria-modal="true" onClick={() => setLaunchOpen(false)}>
          <section className="launch-dialog panel" onClick={(event) => event.stopPropagation()}>
            <div className="launch-dialog-head minimal">
              <button className="diff-close" type="button" onClick={() => setLaunchOpen(false)}>
                Close
              </button>
            </div>

            <div className="launch-panel minimal">
              <section className="launch-section workspace-picker minimal">
                <div className="section-head compact-actions">
                  <button className="browse-button" type="button" onClick={() => void handleBrowseWorkspace()}>
                    Browse
                  </button>
                </div>

                <p className={`launch-path${launchWorkspace ? " selected" : ""}`}>
                  {launchWorkspace ? launchWorkspace.path : "workspace を選ぶ"}
                </p>
              </section>

              <section className="launch-section profile-panel minimal">
                {characters.length > 0 ? (
                  <div className="choice-card-list">
                    {characters.map((character) => (
                      <button
                        key={character.id}
                        className={`choice-card${character.id === selectedCharacter?.id ? " active" : ""}`}
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
                    <p>セッションを始める前にキャラを作ってね。</p>
                    <button className="launch-toggle" type="button" onClick={() => void openCharacterEditor()}>
                      Add Character
                    </button>
                  </article>
                )}

                <div className="choice-list">
                  {approvalModeOptions.map((approval) => (
                    <button
                      key={approval.id}
                      className={`choice-chip${approval.id === launchApproval ? " active" : ""}`}
                      type="button"
                      onClick={() => setLaunchApproval(approval.id)}
                    >
                      {approval.label}
                    </button>
                  ))}
                </div>
              </section>
            </div>

            <div className="launch-dialog-foot minimal">
              <button className="start-session-button" type="button" disabled={!launchWorkspace || !selectedCharacter} onClick={() => void handleStartSession()}>
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
                <div className="settings-actions">
                  <button className="launch-toggle" type="button" disabled={!window.withmate} onClick={() => void handleImportModelCatalog()}>
                    Import Models
                  </button>
                  <button className="launch-toggle" type="button" disabled={!window.withmate} onClick={() => void handleExportModelCatalog()}>
                    Export Models
                  </button>
                </div>

                {window.withmate ? null : <p className="settings-note">Electron で開くと使えるよ。</p>}

                {settingsFeedback ? <p className="settings-feedback">{settingsFeedback}</p> : null}
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
