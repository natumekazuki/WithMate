import { useEffect, useMemo, useState } from "react";

import {
  ensureBrowserMockSessions,
  getCharacterCatalogItem,
  getSessionIdFromLocation,
  saveBrowserMockSessions,
  type ChangedFile,
  type Message,
  type Session,
} from "./mock-data.js";
import { CharacterAvatar, fileKindLabel } from "./mock-ui.js";

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [draft, setDraft] = useState("次は実イベントをこの UI に流して、turn summary を自動生成できるか見たい");
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const [selectedDiff, setSelectedDiff] = useState<{ title: string; file: ChangedFile } | null>(null);

  const selectedId = useMemo(() => getSessionIdFromLocation(), []);

  useEffect(() => {
    let active = true;

    if (window.withmate) {
      if (selectedId) {
        void window.withmate.getSession(selectedId).then((session) => {
          if (active && session) {
            setSessions([session]);
          }
        });
      } else {
        void window.withmate.listSessions().then((nextSessions) => {
          if (active) {
            setSessions(nextSessions);
          }
        });
      }

      return window.withmate.subscribeSessions((nextSessions) => {
        if (!active) {
          return;
        }

        if (selectedId) {
          const matched = nextSessions.find((session) => session.id === selectedId);
          setSessions(matched ? [matched] : []);
          return;
        }

        setSessions(nextSessions);
      });
    }

    const handleStorage = () => {
      if (active) {
        setSessions(ensureBrowserMockSessions());
      }
    };

    setSessions(ensureBrowserMockSessions());
    window.addEventListener("storage", handleStorage);
    return () => {
      active = false;
      window.removeEventListener("storage", handleStorage);
    };
  }, [selectedId]);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null,
    [selectedId, sessions],
  );

  const selectedSessionCharacter = useMemo(
    () => (selectedSession ? getCharacterCatalogItem(selectedSession.character) : null),
    [selectedSession],
  );

  const displayedMessages: Message[] = selectedSession ? selectedSession.messages : [];

  const handleSend = async () => {
    if (!selectedSession) {
      return;
    }

    const nextMessage = draft.trim();
    if (!nextMessage) {
      return;
    }

    const updatedSession: Session = {
      ...selectedSession,
      updatedAt: "just now",
      status: "running",
      runState: "running",
      messages: [...selectedSession.messages, { role: "user", text: nextMessage }],
      stream: [
        {
          mood: "spark" as const,
          time: "just now",
          text: `${selectedSession.character} として次の依頼を受け取った。どこに温度を乗せるか、横でちょっと考えてる。`,
        },
        ...selectedSession.stream,
      ].slice(0, 4),
    };

    if (window.withmate) {
      const savedSession = await window.withmate.updateSession(updatedSession);
      setSessions([savedSession]);
    } else {
      const nextSessions = sessions.map((session) => (session.id === selectedSession.id ? updatedSession : session));
      saveBrowserMockSessions(nextSessions);
      setSessions(nextSessions);
    }

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
          <span className="session-window-title">No Session Selected</span>
        </section>
        <section className="panel empty-session-card rise-2">
          <h2>Home Window から session を開いてね</h2>
          <p>`/session.html?sessionId=...` で対象 session を受け取る形になってるよ。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="page-shell session-page">
      <header className="panel session-window-bar rise-1">
        <span className="session-window-title">{selectedSession.taskTitle}</span>
        <button className="drawer-toggle" type="button" onClick={handleCloseWindow}>
          Close Window
        </button>
      </header>

      <section className="content-grid">
        <section className="panel chat-panel rise-3">
          <div className="message-list">
            {displayedMessages.length === 0 ? (
              <article className="message-row assistant empty-chat-row">
                <CharacterAvatar character={selectedSessionCharacter} size="small" className="message-avatar" />
                <div className="message-card assistant empty-chat">
                  <p className="message-body">ここから最初の依頼を送ると、この session で作業が始まる。</p>
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
                      <p className="message-body">{message.text}</p>

                      {message.artifact ? (
                        <section className="artifact-shell">
                          <div className="artifact-toolbar">
                            <button className="artifact-toggle" type="button" onClick={() => toggleArtifact(artifactKey)}>
                              {artifactExpanded ? "Hide" : "Details"}
                            </button>
                          </div>

                          {artifactExpanded ? (
                            <div className="artifact-block">
                              <div className="artifact-grid">
                                <section className="artifact-section">
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
                                        <p>まだファイル変更はないよ。</p>
                                      </article>
                                    )}
                                  </div>
                                </section>

                                <section className="artifact-section compact">
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
                                <ul className="summary-list">
                                  {message.artifact.activitySummary.map((item) => (
                                    <li key={item}>{item}</li>
                                  ))}
                                </ul>
                              </section>
                            </div>
                          ) : null}
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
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="次の指示を書く"
              />
              <button type="button" onClick={() => void handleSend()}>
                Send
              </button>
            </label>
          </div>
        </section>

        <aside className="panel stream-panel rise-4">
          <div className="stream-list">
            {selectedSession.stream.map((entry, index) => (
              <article key={`${entry.time}-${index}`} className={`stream-card ${entry.mood}`}>
                <div className="stream-card-head">
                  <div className="stream-speaker">
                    <CharacterAvatar character={selectedSessionCharacter} size="tiny" className="stream-entry-avatar" />
                    <p className="stream-time">{entry.time}</p>
                  </div>
                </div>
                <p className="stream-message-body">{entry.text}</p>
              </article>
            ))}
          </div>
        </aside>
      </section>

      {selectedDiff ? (
        <div className="diff-modal" role="dialog" aria-modal="true" onClick={() => setSelectedDiff(null)}>
          <section className="diff-editor panel" onClick={(event) => event.stopPropagation()}>
            <div className="diff-titlebar">
              <h2>{selectedDiff.file.path}</h2>
              <button className="diff-close" type="button" onClick={() => setSelectedDiff(null)}>
                Close
              </button>
            </div>

            <div className="diff-subbar">
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
