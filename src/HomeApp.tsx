import { useEffect, useMemo, useState } from "react";

import {
  buildNewSession,
  buildSessionUrl,
  characterCatalog,
  ensureMockSessions,
  getCharacterCatalogItem,
  saveMockSessions,
  workspacePresets,
} from "./mock-data.js";
import { CharacterAvatar, statusLabel } from "./mock-ui.js";

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

export default function HomeApp() {
  const [sessions, setSessions] = useState(() => ensureMockSessions());
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchWorkspaceId, setLaunchWorkspaceId] = useState("");
  const [launchCharacter, setLaunchCharacter] = useState(characterCatalog[0].name);
  const [launchApproval, setLaunchApproval] = useState("on-request");

  useEffect(() => {
    const handleStorage = () => {
      setSessions(ensureMockSessions());
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const selectedWorkspace = useMemo(
    () => workspacePresets.find((workspace) => workspace.id === launchWorkspaceId) ?? null,
    [launchWorkspaceId],
  );

  const selectedCharacter = useMemo(
    () => getCharacterCatalogItem(launchCharacter),
    [launchCharacter],
  );

  const handleBrowseWorkspace = () => {
    if (workspacePresets.length === 0) {
      return;
    }

    if (!launchWorkspaceId) {
      setLaunchWorkspaceId(workspacePresets[0].id);
      return;
    }

    const currentIndex = workspacePresets.findIndex((workspace) => workspace.id === launchWorkspaceId);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % workspacePresets.length;
    setLaunchWorkspaceId(workspacePresets[nextIndex].id);
  };

  const handleStartSession = async () => {
    if (!selectedWorkspace) {
      return;
    }

    const createdSession = buildNewSession({
      workspace: selectedWorkspace,
      character: selectedCharacter,
      approvalMode: launchApproval,
    });

    const nextSessions = [createdSession, ...sessions];
    saveMockSessions(nextSessions);
    setSessions(nextSessions);
    setLaunchOpen(false);
    await openSessionWindow(createdSession.id);
  };

  return (
    <div className="page-shell home-page">
      <header className="panel app-badge rise-1">
        <div className="app-icon" aria-hidden="true">
          WM
        </div>
        <div className="app-brand-copy">
          <p className="kicker">Home Window</p>
          <h1>WithMate Session Manager</h1>
          <p>session と character を管理して、ここから Session Window を起動する。</p>
        </div>
        <button className="launch-toggle" type="button" onClick={() => setLaunchOpen(true)}>
          New Session
        </button>
      </header>

      <main className="home-layout">
        <section className="panel home-status-card rise-2">
          <div className="panel-head compact-head">
            <div>
              <p className="kicker">Mock Status</p>
              <h2>Window Routing</h2>
            </div>
            <span className="pill">{sessions.length}</span>
          </div>

          <div className="window-chip-list">
            <article className="window-chip active">
              <span>home entry</span>
              <strong>/index.html</strong>
            </article>
            <article className="window-chip">
              <span>session entry</span>
              <strong>/session.html?sessionId=...</strong>
            </article>
          </div>
        </section>

        <section className="panel sessions-panel rise-3">
          <div className="panel-head compact-head">
            <div>
              <p className="kicker">Resume Picker</p>
              <h2>Recent Sessions</h2>
            </div>
            <span className="pill">{sessions.length}</span>
          </div>

          <div className="session-list">
            {sessions.map((session) => {
              const sessionCharacter = getCharacterCatalogItem(session.character);

              return (
                <button
                  key={session.id}
                  className="session-card"
                  type="button"
                  onClick={() => void openSessionWindow(session.id)}
                >
                  <CharacterAvatar character={sessionCharacter} size="small" className="session-avatar" />
                  <div className="session-main">
                    <div className="session-card-head">
                      <h3>{session.taskTitle}</h3>
                      <span className={`session-status ${session.status}`}>{statusLabel(session.status)}</span>
                    </div>

                    <div className="session-meta-row">
                      <span>{session.workspaceLabel}</span>
                      <span>{session.provider}</span>
                      <span>{session.updatedAt}</span>
                    </div>

                    <p className="session-card-summary">{session.taskSummary}</p>

                    <div className="session-character-row">
                      <span>{session.character}</span>
                      <span>{session.threadLabel}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="panel catalog-panel rise-4">
          <div className="panel-head compact-head">
            <div>
              <p className="kicker">Character Catalog</p>
              <h2>Loaded Characters</h2>
            </div>
            <span className="pill">{characterCatalog.length}</span>
          </div>

          <div className="catalog-grid">
            {characterCatalog.map((character) => (
              <article key={character.id} className="catalog-card">
                <CharacterAvatar character={character} size="small" className="catalog-avatar" />
                <div className="catalog-copy">
                  <strong>{character.name}</strong>
                  <p>{character.tone}</p>
                  <span className="tag">{character.streamMode}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>

      {launchOpen ? (
        <div className="launch-modal" role="dialog" aria-modal="true" onClick={() => setLaunchOpen(false)}>
          <section className="launch-dialog panel" onClick={(event) => event.stopPropagation()}>
            <div className="launch-dialog-head">
              <div>
                <p className="kicker">New Session</p>
                <h2>Launch Panel</h2>
              </div>
              <button className="diff-close" type="button" onClick={() => setLaunchOpen(false)}>
                Close
              </button>
            </div>

            <div className="launch-panel">
              <section className="launch-section workspace-picker">
                <div className="section-head">
                  <div>
                    <p className="kicker">Workspace Picker</p>
                    <h3>{selectedWorkspace ? selectedWorkspace.label : "workspace を選ぶ"}</h3>
                  </div>
                  <button className="browse-button" type="button" onClick={handleBrowseWorkspace}>
                    Browse
                  </button>
                </div>

                <p className="launch-path">
                  {selectedWorkspace ? selectedWorkspace.path : "作業ディレクトリがまだ選ばれてない。Browse か下の候補から選ぶ。"}
                </p>

                <div className="workspace-chip-list">
                  {workspacePresets.map((workspace) => (
                    <button
                      key={workspace.id}
                      className={`workspace-chip${workspace.id === launchWorkspaceId ? " active" : ""}`}
                      type="button"
                      onClick={() => setLaunchWorkspaceId(workspace.id)}
                    >
                      <strong>{workspace.label}</strong>
                      <span>{workspace.hint}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="launch-section profile-panel">
                <div className="section-head">
                  <div>
                    <p className="kicker">Launch Profile</p>
                    <h3>起動条件</h3>
                  </div>
                  <span className="pill">Codex</span>
                </div>

                <div className="profile-row">
                  <span className="profile-label">Character</span>
                  <div className="choice-card-list">
                    {characterCatalog.map((character) => (
                      <button
                        key={character.id}
                        className={`choice-card${character.name === launchCharacter ? " active" : ""}`}
                        type="button"
                        onClick={() => setLaunchCharacter(character.name)}
                      >
                        <CharacterAvatar character={character} size="small" className="choice-avatar" />
                        <div className="choice-card-copy">
                          <strong>{character.name}</strong>
                          <span>{character.tone}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="profile-row">
                  <span className="profile-label">Approval</span>
                  <div className="choice-list">
                    {[
                      { id: "on-request", label: "on-request" },
                      { id: "never", label: "never" },
                      { id: "untrusted", label: "untrusted" },
                    ].map((approval) => (
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
                </div>

                <div className="profile-grid">
                  <article>
                    <span className="profile-label">Tone</span>
                    <strong>{selectedCharacter.tone}</strong>
                  </article>
                  <article>
                    <span className="profile-label">Stream</span>
                    <strong>{selectedCharacter.streamMode}</strong>
                  </article>
                </div>
              </section>

              <section className="launch-section launch-summary">
                <div className="section-head">
                  <div>
                    <p className="kicker">Launch Summary</p>
                    <h3>この条件で開始</h3>
                  </div>
                  <span className={`launch-state${selectedWorkspace ? " ready" : ""}`}>
                    {selectedWorkspace ? "Ready" : "Workspace Required"}
                  </span>
                </div>

                <div className="summary-grid">
                  <article>
                    <span className="profile-label">Workspace</span>
                    <strong>{selectedWorkspace ? selectedWorkspace.label : "未選択"}</strong>
                  </article>
                  <article>
                    <span className="profile-label">Character</span>
                    <strong>{selectedCharacter.name}</strong>
                  </article>
                  <article>
                    <span className="profile-label">Provider</span>
                    <strong>Codex</strong>
                  </article>
                  <article>
                    <span className="profile-label">Approval</span>
                    <strong>{launchApproval}</strong>
                  </article>
                </div>

                <button className="start-session-button" type="button" disabled={!selectedWorkspace} onClick={() => void handleStartSession()}>
                  Start New Session
                </button>
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
