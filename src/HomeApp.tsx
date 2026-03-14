import { useEffect, useMemo, useState } from "react";

import { type CharacterProfile, type CreateSessionInput, type Session } from "./app-state.js";
import { approvalModeOptions, CharacterAvatar, sessionStateClassName, sessionStateLabel } from "./ui-utils.js";

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

export default function HomeApp() {
  const isDesktopRuntime = typeof window !== "undefined" && !!window.withmate;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsFeedback, setSettingsFeedback] = useState("");
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchWorkspace, setLaunchWorkspace] = useState<LaunchWorkspace | null>(null);
  const [launchCharacterId, setLaunchCharacterId] = useState("");
  const [launchApproval, setLaunchApproval] = useState("on-request");

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

    void window.withmate.listCharacters().then((nextCharacters) => {
      if (!active) {
        return;
      }

      setCharacters(nextCharacters);
      setLaunchCharacterId((current) => current || nextCharacters[0]?.id || "");
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
      if (!nextCharacters.find((character) => character.id === launchCharacterId)) {
        setLaunchCharacterId(nextCharacters[0]?.id ?? "");
      }
    });

    return () => {
      active = false;
      unsubscribeSessions();
      unsubscribeCharacters();
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
      return;
    }

    const selectedPath = await window.withmate.pickDirectory();
    if (!selectedPath) {
      return;
    }

    setLaunchWorkspace(inferWorkspaceFromPath(selectedPath));
  };

  const handleStartSession = async () => {
    if (!window.withmate || !launchWorkspace || !selectedCharacter) {
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

    const createdSession = await window.withmate.createSession(sessionInput);
    setLaunchOpen(false);
    setLaunchWorkspace(null);
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
        <main className="home-layout">
          <section className="panel empty-list-card rise-1">
            <p>Home は Electron から起動してね。</p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="page-shell home-page">
      <header className="home-toolbar panel rise-1">
        <div className="home-toolbar-brand">
          <span className="home-brand-mark">W</span>
        </div>
        <div className="home-toolbar-actions">
          <button className="launch-toggle" type="button" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <button className="launch-toggle" type="button" onClick={() => void openCharacterEditor()}>
            Add Character
          </button>
          <button className="start-session-button" type="button" onClick={() => setLaunchOpen(true)}>
            New Session
          </button>
        </div>
      </header>

      <main className="home-layout rise-2">
        <section className="panel session-list-panel rise-3">
          {(runningSessions.length > 0 || interruptedSessions.length > 0) ? (
            <div className="session-chip-groups">
              {runningSessions.length > 0 ? (
                <div className="session-chip-row">
                  {runningSessions.map((session) => (
                    <button key={session.id} className="session-chip running" type="button" onClick={() => void openSessionWindow(session.id)}>
                      <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="tiny" />
                      <span>{session.taskTitle}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {interruptedSessions.length > 0 ? (
                <div className="session-chip-row">
                  {interruptedSessions.map((session) => (
                    <button key={session.id} className="session-chip interrupted" type="button" onClick={() => void openSessionWindow(session.id)}>
                      <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="tiny" />
                      <span>{session.taskTitle}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="session-card-list">
            {idleSessions.length > 0 ? (
              idleSessions.map((session) => (
                <button key={session.id} className="session-card" type="button" onClick={() => void openSessionWindow(session.id)}>
                  <CharacterAvatar character={{ name: session.character, iconPath: session.characterIconPath }} size="small" className="session-card-avatar" />
                  <div className="session-card-copy">
                    <div className="session-card-topline">
                      <strong>{session.taskTitle}</strong>
                      <span className={`session-state ${sessionStateClassName(session)}`}>{sessionStateLabel(session)}</span>
                    </div>
                    <div className="session-card-subline">
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

                <p className={`launch-path${launchWorkspace ? " selected" : ""}`}>{launchWorkspace ? launchWorkspace.path : "workspace を選ぶ"}</p>
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
                  <button className="launch-toggle" type="button" onClick={() => void handleImportModelCatalog()}>
                    Import Models
                  </button>
                  <button className="launch-toggle" type="button" onClick={() => void handleExportModelCatalog()}>
                    Export Models
                  </button>
                </div>
                {settingsFeedback ? <p className="settings-feedback">{settingsFeedback}</p> : null}
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
