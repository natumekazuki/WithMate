import { useEffect, useMemo, useState } from "react";

import {
  getSessionIdFromLocation,
  type ChangedFile,
  type DiffPreviewPayload,
  type Message,
  type Session,
} from "./app-state.js";
import { DiffViewer, DiffViewerSubbar } from "./DiffViewer.js";
import {
  getProviderCatalog,
  getReasoningEffortOptionsForModel,
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "./model-catalog.js";
import {
  approvalModeOptions,
  CharacterAvatar,
  fileKindLabel,
  modelDisplayLabel,
  modelOptionLabel,
  reasoningDepthLabel,
} from "./ui-utils.js";

export default function App() {
  const isDesktopRuntime = typeof window !== "undefined" && !!window.withmate;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [draft, setDraft] = useState("");
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const [selectedDiff, setSelectedDiff] = useState<{ title: string; file: ChangedFile } | null>(null);

  const selectedId = useMemo(() => getSessionIdFromLocation(), []);

  useEffect(() => {
    let active = true;

    if (!window.withmate) {
      return () => {
        active = false;
      };
    }

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

    const unsubscribe = window.withmate.subscribeSessions((nextSessions) => {
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

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedId]);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null,
    [selectedId, sessions],
  );

  const selectedSessionCharacter = useMemo(
    () =>
      selectedSession
        ? { name: selectedSession.character, iconPath: selectedSession.characterIconPath }
        : null,
    [selectedSession],
  );

  useEffect(() => {
    if (!selectedSession || isEditingTitle) {
      return;
    }

    setTitleDraft(selectedSession.taskTitle);
  }, [isEditingTitle, selectedSession]);

  useEffect(() => {
    let active = true;

    if (!window.withmate) {
      return () => {
        active = false;
      };
    }

    void window.withmate.getModelCatalog(selectedSession?.catalogRevision ?? null).then((snapshot) => {
      if (active) {
        setModelCatalog(snapshot);
      }
    });

    const unsubscribe = window.withmate.subscribeModelCatalog((snapshot) => {
      if (!active) {
        return;
      }

      if (selectedSession?.catalogRevision && snapshot.revision !== selectedSession.catalogRevision) {
        return;
      }

      if (active) {
        setModelCatalog(snapshot);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedSession?.catalogRevision]);

  const displayedMessages: Message[] = selectedSession ? selectedSession.messages : [];
  const selectedProviderCatalog = useMemo(
    () => (modelCatalog && selectedSession ? getProviderCatalog(modelCatalog.providers, selectedSession.provider) : null),
    [modelCatalog, selectedSession],
  );
  const availableReasoningEfforts = useMemo(
    () =>
      selectedProviderCatalog && selectedSession
        ? getReasoningEffortOptionsForModel(selectedProviderCatalog, selectedSession.model)
        : [],
    [selectedProviderCatalog, selectedSession],
  );
  const modelOptions = useMemo(() => {
    if (!selectedProviderCatalog) {
      return [];
    }

    const options = [...selectedProviderCatalog.models];
    if (!selectedSession) {
      return options;
    }

    const hasSelectedModel = options.some((model) => model.id === selectedSession.model);
    if (!hasSelectedModel) {
      options.unshift({
        id: selectedSession.model,
        label: selectedSession.model,
        reasoningEfforts: availableReasoningEfforts.length > 0 ? [...availableReasoningEfforts] : [selectedSession.reasoningEffort],
      });
    }

    return options;
  }, [availableReasoningEfforts, selectedProviderCatalog, selectedSession]);
  const lastUserMessage = useMemo(
    () =>
      selectedSession
        ? [...selectedSession.messages].reverse().find((message) => message.role === "user") ?? null
        : null,
    [selectedSession],
  );

  const sendMessage = async (messageText: string) => {
    if (!window.withmate || !selectedSession) {
      return;
    }

    const nextMessage = messageText.trim();
    if (!nextMessage) {
      return;
    }

    setDraft("");

    const updatedSession: Session = {
      ...selectedSession,
      updatedAt: "just now",
      status: "running",
      runState: "running",
      messages: [...selectedSession.messages, { role: "user", text: nextMessage }],
    };

    setSessions([updatedSession]);

    try {
      const savedSession = await window.withmate.runSessionTurn(selectedSession.id, nextMessage);
      setSessions([savedSession]);
    } catch (error) {
      console.error(error);
      setSessions([selectedSession]);
    }
  };

  const handleSend = async () => {
    await sendMessage(draft);
  };

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey) || selectedSession?.runState === "running") {
      return;
    }

    event.preventDefault();
    void handleSend();
  };

  const persistSession = async (nextSession: Session) => {
    if (!window.withmate) {
      throw new Error("Session Window は Electron から開いてね。");
    }

    const savedSession = await window.withmate.updateSession(nextSession);
    setSessions([savedSession]);
    return savedSession;
  };

  const handleChangeApproval = async (approvalMode: string) => {
    if (!selectedSession) {
      return;
    }

    const nextSession: Session = {
      ...selectedSession,
      approvalMode,
      updatedAt: "just now",
    };

    await persistSession(nextSession);
  };

  const handleStartTitleEdit = () => {
    if (!selectedSession || selectedSession.runState === "running") {
      return;
    }

    setTitleDraft(selectedSession.taskTitle);
    setIsEditingTitle(true);
  };

  const handleCancelTitleEdit = () => {
    setTitleDraft(selectedSession?.taskTitle ?? "");
    setIsEditingTitle(false);
  };

  const handleSaveTitle = async () => {
    if (!selectedSession) {
      return;
    }

    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      setTitleDraft(selectedSession.taskTitle);
      setIsEditingTitle(false);
      return;
    }

    if (nextTitle === selectedSession.taskTitle) {
      setIsEditingTitle(false);
      return;
    }

    const nextSession: Session = {
      ...selectedSession,
      taskTitle: nextTitle,
      updatedAt: "just now",
    };

    await persistSession(nextSession);
    setIsEditingTitle(false);
  };

  const handleDeleteSession = async () => {
    if (!window.withmate || !selectedSession || selectedSession.runState === "running") {
      return;
    }

    const confirmed = window.confirm(`セッション「${selectedSession.taskTitle}」を削除する？`);
    if (!confirmed) {
      return;
    }

    await window.withmate.deleteSession(selectedSession.id);
    handleCloseWindow();
  };

  const handleOpenDiffWindow = async (diffPreview: DiffPreviewPayload) => {
    if (!window.withmate) {
      return;
    }

    await window.withmate.openDiffWindow(diffPreview);
  };

  const handleChangeModel = async (model: string) => {
    if (!selectedSession || !selectedProviderCatalog) {
      return;
    }

    const selection = resolveModelSelection(selectedProviderCatalog, model, selectedSession.reasoningEffort);
    const nextSession: Session = {
      ...selectedSession,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
      updatedAt: "just now",
    };

    await persistSession(nextSession);
  };

  const handleChangeReasoningEffort = async (reasoningEffort: Session["reasoningEffort"]) => {
    if (!selectedSession || !selectedProviderCatalog) {
      return;
    }

    const selection = resolveModelSelection(selectedProviderCatalog, selectedSession.model, reasoningEffort);
    const nextSession: Session = {
      ...selectedSession,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
      updatedAt: "just now",
    };

    await persistSession(nextSession);
  };

  const handleResendLastMessage = async () => {
    if (!lastUserMessage) {
      return;
    }

    await sendMessage(lastUserMessage.text);
  };

  const handleCloseWindow = () => {
    window.close();
  };

  const handleTitleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleSaveTitle();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      handleCancelTitleEdit();
    }
  };

  const toggleArtifact = (artifactKey: string) => {
    setExpandedArtifacts((current) => ({
      ...current,
      [artifactKey]: !current[artifactKey],
    }));
  };

  if (!isDesktopRuntime) {
    return (
      <div className="page-shell session-page">
        <section className="panel empty-session-card rise-2">
          <p>Session Window は Electron から開いてね。</p>
        </section>
      </div>
    );
  }

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
        <div className="session-title-shell">
          {isEditingTitle ? (
            <label className="session-title-editor">
              <input value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={handleTitleInputKeyDown} />
              <div className="session-title-actions">
                <button className="drawer-toggle compact" type="button" onClick={() => void handleSaveTitle()}>
                  Save
                </button>
                <button className="drawer-toggle compact secondary" type="button" onClick={handleCancelTitleEdit}>
                  Cancel
                </button>
              </div>
            </label>
          ) : (
            <>
              <span className="session-window-title">{selectedSession.taskTitle}</span>
              <div className="session-title-actions">
                <button className="drawer-toggle compact secondary" type="button" onClick={handleStartTitleEdit} disabled={selectedSession.runState === "running"}>
                  Rename
                </button>
                <button className="drawer-toggle compact danger" type="button" onClick={() => void handleDeleteSession()} disabled={selectedSession.runState === "running"}>
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
        <div className="session-window-controls">
          <div className="choice-list session-approval-list" role="group" aria-label="承認モード">
            {approvalModeOptions.map((approval) => (
              <button
                key={approval.id}
                className={`choice-chip${approval.id === selectedSession.approvalMode ? " active" : ""}`}
                type="button"
                onClick={() => void handleChangeApproval(approval.id)}
              >
                {approval.label}
              </button>
            ))}
          </div>
          <button className="drawer-toggle" type="button" onClick={handleCloseWindow}>
            Close Window
          </button>
        </div>
      </header>

      <section className="content-grid session-content-grid">
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
                                          {file.diffRows.length > 0 ? (
                                            <button className="diff-button" type="button" onClick={() => setSelectedDiff({ title: message.artifact!.title, file })}>
                                              Open Diff
                                            </button>
                                          ) : null}
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

            {selectedSession.runState === "running" ? (
              <article className="message-row assistant pending-row">
                <CharacterAvatar character={selectedSessionCharacter} size="small" className="message-avatar" />
                <div className="message-card assistant pending-message-card" aria-live="polite" aria-busy="true">
                  <div className="typing-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </article>
            ) : null}
          </div>

          <div className="composer">
            {selectedSession.runState === "interrupted" && lastUserMessage ? (
              <div className="resume-banner">
                <button type="button" onClick={() => void handleResendLastMessage()}>
                  同じ依頼を再送
                </button>
                <p>{lastUserMessage.text}</p>
              </div>
            ) : null}
            <label className="composer-box">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                disabled={selectedSession.runState === "running"}
              />
              <button
                className={selectedSession.runState === "running" ? "loading" : ""}
                type="button"
                onClick={() => void handleSend()}
                disabled={selectedSession.runState === "running"}
              >
                {selectedSession.runState === "running" ? "..." : "Send"}
              </button>
            </label>

            <div className="composer-settings">
              <div className="composer-setting-field">
                <span>Model</span>
                <select
                  value={selectedSession.model}
                  onChange={(event) => void handleChangeModel(event.target.value)}
                  disabled={selectedSession.runState === "running"}
                >
                  {modelOptions.length > 0 ? (
                    modelOptions.map((model) => (
                      <option key={model.id} value={model.id}>
                        {modelOptionLabel(model)}
                      </option>
                    ))
                  ) : (
                    <option value={selectedSession.model}>{modelDisplayLabel(selectedProviderCatalog, selectedSession.model)}</option>
                  )}
                </select>
              </div>

              <div className="composer-setting-field">
                <span>Depth</span>
                <div className="choice-list composer-depth-list" role="group" aria-label="推論の深さ">
                  {availableReasoningEfforts.map((reasoningEffort) => (
                    <button
                      key={reasoningEffort}
                      className={`choice-chip${reasoningEffort === selectedSession.reasoningEffort ? " active" : ""}`}
                      type="button"
                      onClick={() => void handleChangeReasoningEffort(reasoningEffort)}
                      disabled={selectedSession.runState === "running"}
                    >
                      {reasoningDepthLabel(reasoningEffort)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>
      </section>

      {selectedDiff ? (
        <div className="diff-modal" role="dialog" aria-modal="true" onClick={() => setSelectedDiff(null)}>
          <section className="diff-editor panel" onClick={(event) => event.stopPropagation()}>
            <div className="diff-titlebar">
              <h2>{selectedDiff.file.path}</h2>
              <div className="diff-titlebar-actions">
                <button className="diff-close diff-popout" type="button" onClick={() => void handleOpenDiffWindow(selectedDiff)}>
                  Open In Window
                </button>
                <button className="diff-close" type="button" onClick={() => setSelectedDiff(null)}>
                  Close
                </button>
              </div>
            </div>

            <DiffViewerSubbar file={selectedDiff.file} />
            <DiffViewer file={selectedDiff.file} />
          </section>
        </div>
      ) : null}
    </div>
  );
}

