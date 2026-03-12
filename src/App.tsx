import { useEffect, useMemo, useState } from "react";

import {
  ensureMockSessions,
  getCharacterCatalogItem,
  getSessionIdFromLocation,
  saveMockSessions,
  type ChangedFile,
  type Message,
  type Session,
} from "./mock-data.js";
import { CharacterAvatar, fileKindLabel } from "./mock-ui.js";

export default function App() {
  const [sessions, setSessions] = useState<Session[]>(() => ensureMockSessions());
  const [draft, setDraft] = useState("次は実イベントをこの UI に流して、turn summary を自動生成できるか見たい");
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const [selectedDiff, setSelectedDiff] = useState<{ title: string; file: ChangedFile } | null>(null);

  useEffect(() => {
    const handleStorage = () => {
      setSessions(ensureMockSessions());
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const selectedId = useMemo(() => getSessionIdFromLocation(), []);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null,
    [selectedId, sessions],
  );

  const selectedSessionCharacter = useMemo(
    () => (selectedSession ? getCharacterCatalogItem(selectedSession.character) : null),
    [selectedSession],
  );

  const displayedMessages: Message[] = selectedSession ? selectedSession.messages : [];

  const handleSend = () => {
    if (!selectedSession) {
      return;
    }

    const nextMessage = draft.trim();
    if (!nextMessage) {
      return;
    }

    const nextSessions = sessions.map((session) =>
      session.id === selectedSession.id
        ? {
            ...session,
            updatedAt: "just now",
            status: "running" as const,
            runState: "running",
            messages: [...session.messages, { role: "user" as const, text: nextMessage }],
            stream: [
              {
                mood: "spark" as const,
                time: "just now",
                text: `${session.character} として次の依頼を受け取った。どこに温度を乗せるか、横でちょっと考えてる。`,
              },
              ...session.stream,
            ].slice(0, 4),
          }
        : session,
    );

    saveMockSessions(nextSessions);
    setSessions(nextSessions);
    setDraft("");
  };

  const toggleArtifact = (artifactKey: string) => {
    setExpandedArtifacts((current) => ({
      ...current,
      [artifactKey]: !current[artifactKey],
    }));
  };

  const handleCloseWindow = () => {
    window.close();
    window.location.href = "/";
  };

  if (!selectedSession || !selectedSessionCharacter) {
    return (
      <div className="page-shell session-page">
        <section className="panel session-window-bar rise-1">
          <div>
            <p className="kicker">Session Window</p>
            <h2>No Session Selected</h2>
          </div>
        </section>
        <section className="panel empty-session-card rise-2">
          <p className="kicker">Waiting</p>
          <h2>Home Window から session を開いてね</h2>
          <p>`/session.html?sessionId=...` で対象 session を受け取る前提のモックだよ。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="page-shell session-page">
      <header className="panel session-window-bar rise-1">
        <div>
          <p className="kicker">Session Window</p>
          <h2>{selectedSession.threadLabel}</h2>
        </div>
        <button className="drawer-toggle" type="button" onClick={handleCloseWindow}>
          Close Window
        </button>
      </header>

      <header className="panel workspace-header rise-2">
        <div className="header-copy">
          <p className="kicker">Current Session</p>
          <h2>{selectedSession.taskTitle}</h2>
          <p>{selectedSession.taskSummary}</p>
        </div>

        <div className="header-side">
          <section className="header-character-card">
            <CharacterAvatar character={selectedSessionCharacter} size="medium" className="header-avatar" />
            <div className="header-character-copy">
              <p className="kicker">Character Locked</p>
              <h3>{selectedSession.character}</h3>
              <p>{selectedSession.characterTone}</p>
            </div>
          </section>

          <div className="header-rails">
            <div className="header-rail primary">
              <span className="rail-label">workspace</span>
              <strong>{selectedSession.workspacePath}</strong>
            </div>
            <div className="header-rail-grid">
              <div className="header-rail">
                <span className="rail-label">provider</span>
                <strong>{selectedSession.provider}</strong>
              </div>
              <div className="header-rail">
                <span className="rail-label">branch</span>
                <strong>{selectedSession.branch}</strong>
              </div>
              <div className="header-rail">
                <span className="rail-label">run</span>
                <strong>{selectedSession.runState}</strong>
              </div>
              <div className="header-rail">
                <span className="rail-label">approval</span>
                <strong>{selectedSession.approvalMode}</strong>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section className="content-grid">
        <section className="panel chat-panel rise-3">
          <div className="panel-head compact-head">
            <div>
              <p className="kicker">Work Chat</p>
              <h2>Coding Agent Run</h2>
            </div>
            <div className="tag-row">
              <span className="status-chip accent">{selectedSession.runState}</span>
              <span className="status-chip">{selectedSession.threadLabel}</span>
            </div>
          </div>

          <div className="message-list">
            {displayedMessages.length === 0 ? (
              <article className="message-row assistant empty-chat-row">
                <CharacterAvatar character={selectedSessionCharacter} size="small" className="message-avatar" />
                <div className="message-card assistant empty-chat">
                  <div className="message-head">
                    <div className="message-speaker">
                      <p className="message-role">{selectedSession.character}</p>
                      <span className="message-voice">session ready</span>
                    </div>
                    <span className="message-badge">ready</span>
                  </div>
                  <p className="message-body">workspace とキャラクターは固定された。ここから最初の依頼を送ると、この session で作業が始まる。</p>
                </div>
              </article>
            ) : (
              displayedMessages.map((message, index) => {
                const artifactKey = `${selectedSession.id}-${index}`;
                const artifactExpanded = expandedArtifacts[artifactKey] ?? false;
                const isAssistant = message.role === "assistant";

                return (
                  <article
                    key={`${message.role}-${index}`}
                    className={`message-row ${message.role}${message.accent ? " accent" : ""}`}
                  >
                    {isAssistant ? <CharacterAvatar character={selectedSessionCharacter} size="small" className="message-avatar" /> : null}
                    <div className={`message-card ${message.role}${message.accent ? " accent" : ""}`}>
                      <div className="message-head">
                        <div className="message-speaker">
                          <p className="message-role">{isAssistant ? selectedSession.character : "You"}</p>
                          <span className="message-voice">{isAssistant ? selectedSession.characterTone : "prompt"}</span>
                        </div>
                        <span className="message-badge">{isAssistant ? "response" : "prompt"}</span>
                      </div>
                      <p className="message-body">{message.text}</p>

                      {message.artifact ? (
                        <section className="artifact-shell">
                          <div className="artifact-toolbar">
                            <div className="artifact-head-copy">
                              <p className="kicker">{message.artifact.title}</p>
                              <p>{message.artifact.changedFiles.length} files changed / {message.artifact.runChecks.length} checks</p>
                            </div>
                            <button className="artifact-toggle" type="button" onClick={() => toggleArtifact(artifactKey)}>
                              {artifactExpanded ? "Hide Summary" : "Show Summary"}
                            </button>
                          </div>

                          {artifactExpanded ? (
                            <div className="artifact-block">
                              <div className="artifact-grid">
                                <section className="artifact-section">
                                  <h3>What Changed</h3>
                                  <div className="artifact-file-list">
                                    {message.artifact.changedFiles.length > 0 ? (
                                      message.artifact.changedFiles.map((file) => (
                                        <article key={`${file.kind}-${file.path}`} className="artifact-file-item">
                                          <div className="artifact-file-meta">
                                            <span className={`file-kind ${file.kind}`}>{fileKindLabel(file.kind)}</span>
                                            <code>{file.path}</code>
                                          </div>
                                          <p>{file.summary}</p>
                                          <button className="diff-button" type="button" onClick={() => setSelectedDiff({ title: message.artifact!.title, file })}>
                                            Open Diff
                                          </button>
                                        </article>
                                      ))
                                    ) : (
                                      <article className="artifact-file-item empty-state-card">
                                        <p>まだファイル変更はない。まずは workspace を読んで最初の実行に入る段階。</p>
                                      </article>
                                    )}
                                  </div>
                                </section>

                                <section className="artifact-section compact">
                                  <h3>Run Summary</h3>
                                  <div className="check-list">
                                    {message.artifact.runChecks.map((check) => (
                                      <div key={check.label} className="check-item">
                                        <span>{check.label}</span>
                                        <strong>{check.value}</strong>
                                      </div>
                                    ))}
                                  </div>
                                </section>
                              </div>

                              <section className="artifact-section compact">
                                <h3>Activity Notes</h3>
                                <ul className="summary-list">
                                  {message.artifact.activitySummary.map((item) => (
                                    <li key={item}>{item}</li>
                                  ))}
                                </ul>
                              </section>
                            </div>
                          ) : (
                            <div className="artifact-preview">
                              <span>{message.artifact.changedFiles.length} files changed</span>
                              <span>{message.artifact.runChecks.map((check) => `${check.label}: ${check.value}`).join(" / ")}</span>
                            </div>
                          )}
                        </section>
                      ) : null}
                    </div>
                  </article>
                );
              })
            )}
          </div>

          <div className="composer">
            <label className="composer-box">
              <div className="composer-copy">
                <p className="kicker">Prompt</p>
                <p>{selectedSession.character} のロールは保持したまま、coding task を継続する。</p>
              </div>
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
              <button type="button" onClick={handleSend}>
                Send
              </button>
            </label>
          </div>
        </section>

        <aside className="panel stream-panel rise-4">
          <div className="panel-head compact-head">
            <div>
              <p className="kicker">Character Stream</p>
              <h2>On-Air Stream</h2>
            </div>
            <span className="emotion-pill">{selectedSession.characterTone}</span>
          </div>

          <section className="stream-stage">
            <div className="stream-stage-copy">
              <p className="kicker">Pinned Character</p>
              <h3>{selectedSession.character}</h3>
              <p>
                coding agent の実行面とは別に、同じキャラが横で見ていて、思ったことをぽろっと流し続ける。
                暇なときに目をやると、作業と並走している感じが出る面。
              </p>
            </div>

            <div className="stream-stage-side">
              <CharacterAvatar character={selectedSessionCharacter} size="large" className="stream-stage-avatar" />
              <div className="stage-pills">
                <span className="tag active">{selectedSession.streamMode}</span>
                <span className="tag">{selectedSession.updatedAt}</span>
                <span className="tag">{selectedSession.workspaceLabel}</span>
              </div>
            </div>
          </section>

          <div className="stream-list">
            {selectedSession.stream.map((entry, index) => (
              <article key={`${entry.time}-${index}`} className={`stream-card ${entry.mood}`}>
                <div className="stream-card-head">
                  <div className="stream-speaker">
                    <CharacterAvatar character={selectedSessionCharacter} size="tiny" className="stream-entry-avatar" />
                    <div>
                      <p className="stream-time">{entry.time}</p>
                      <strong>{selectedSession.character}</strong>
                    </div>
                  </div>
                  <span className="stream-mood">{entry.mood}</span>
                </div>
                <p>{entry.text}</p>
              </article>
            ))}
          </div>

          <section className="character-lock">
            <CharacterAvatar character={selectedSessionCharacter} size="medium" className="lock-avatar" />
            <div>
              <p className="kicker">Roleplay Injection</p>
              <h3>{selectedSession.character}</h3>
              <p>
                system prompt にはこのキャラ定義を安定注入する前提。Work Chat は実務を崩さず、
                こっちはキャラの温度と距離感を持続させる役割に寄せる。
              </p>
            </div>
          </section>
        </aside>
      </section>

      {selectedDiff ? (
        <div className="diff-modal" role="dialog" aria-modal="true" onClick={() => setSelectedDiff(null)}>
          <section className="diff-editor panel" onClick={(event) => event.stopPropagation()}>
            <div className="diff-titlebar">
              <div>
                <p className="kicker">Diff Viewer</p>
                <h2>{selectedDiff.file.path}</h2>
              </div>
              <button className="diff-close" type="button" onClick={() => setSelectedDiff(null)}>
                Close
              </button>
            </div>

            <div className="diff-subbar">
              <span className="file-kind edit">{selectedDiff.title}</span>
              <span className={`file-kind ${selectedDiff.file.kind}`}>{fileKindLabel(selectedDiff.file.kind)}</span>
            </div>

            <div className="diff-columns-head">
              <span>Before</span>
              <span>After</span>
            </div>

            <div className="diff-grid">
              {selectedDiff.file.diffRows.map((row, index) => (
                <div key={`${selectedDiff.file.path}-${index}`} className={`diff-row ${row.kind}`}>
                  <span className="diff-line-number">{row.leftNumber ?? ""}</span>
                  <code className="diff-cell before">{row.leftText ?? ""}</code>
                  <span className="diff-line-number">{row.rightNumber ?? ""}</span>
                  <code className="diff-cell after">{row.rightText ?? ""}</code>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
