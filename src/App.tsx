import { useEffect, useMemo, useState } from "react";

import {
  buildDiffWindowUrl,
  ensureBrowserMockSessions,
  getSessionIdFromLocation,
  saveBrowserDiffPreview,
  saveBrowserMockSessions,
  type ChangedFile,
  type DiffPreviewPayload,
  type Message,
  type Session,
} from "./mock-data.js";
import { DiffViewer, DiffViewerSubbar } from "./DiffViewer.js";
import {
  bundledModelCatalog,
  DEFAULT_MODEL_ID,
  didModelSelectionFallback,
  getReasoningEffortOptionsForModel,
  resolveModelSelection,
} from "./model-catalog.js";
import {
  approvalModeOptions,
  CharacterAvatar,
  fileKindLabel,
  reasoningDepthLabel,
  resolvedModelSelectionLabel,
} from "./mock-ui.js";

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [draft, setDraft] = useState("");
  const [modelDraft, setModelDraft] = useState(DEFAULT_MODEL_ID);
  const [titleDraft, setTitleDraft] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
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
    if (!selectedSession) {
      return;
    }

    setModelDraft(selectedSession.model);
  }, [selectedSession?.id, selectedSession?.model]);

  const displayedMessages: Message[] = selectedSession ? selectedSession.messages : [];
  const composerModel = modelDraft.trim() || selectedSession?.model || DEFAULT_MODEL_ID;
  const availableReasoningEfforts = useMemo(
    () => getReasoningEffortOptionsForModel(composerModel),
    [composerModel],
  );
  const resolvedSelection = useMemo(
    () =>
      selectedSession
        ? resolveModelSelection(selectedSession.model, selectedSession.reasoningEffort)
        : null,
    [selectedSession],
  );
  const lastUserMessage = useMemo(
    () =>
      selectedSession
        ? [...selectedSession.messages].reverse().find((message) => message.role === "user") ?? null
        : null,
    [selectedSession],
  );

  const sendMessage = async (messageText: string) => {
    if (!selectedSession) {
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

    if (window.withmate) {
      setSessions([updatedSession]);

      try {
        const savedSession = await window.withmate.runSessionTurn(selectedSession.id, nextMessage);
        setSessions([savedSession]);
      } catch (error) {
        console.error(error);
        setSessions([selectedSession]);
      }

      return;
    }

    const nextSessions = sessions.map((session) => (session.id === selectedSession.id ? updatedSession : session));
    saveBrowserMockSessions(nextSessions);
    setSessions(nextSessions);
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

    if (window.withmate) {
      const savedSession = await window.withmate.updateSession(nextSession);
      setSessions([savedSession]);
      setIsEditingTitle(false);
      return;
    }

    const nextSessions = sessions.map((session) => (session.id === selectedSession.id ? nextSession : session));
    saveBrowserMockSessions(nextSessions);
    setSessions(nextSessions);
    setIsEditingTitle(false);
  };

  const handleDeleteSession = async () => {
    if (!selectedSession || selectedSession.runState === "running") {
      return;
    }

    const confirmed = window.confirm(`セッション「${selectedSession.taskTitle}」を削除する？`);
    if (!confirmed) {
      return;
    }

    if (window.withmate) {
      await window.withmate.deleteSession(selectedSession.id);
      handleCloseWindow();
      return;
    }

    const nextSessions = sessions.filter((session) => session.id !== selectedSession.id);
    saveBrowserMockSessions(nextSessions);
    setSessions(nextSessions);
    handleCloseWindow();
  };

  const handleOpenDiffWindow = async (diffPreview: DiffPreviewPayload) => {
    if (window.withmate) {
      await window.withmate.openDiffWindow(diffPreview);
      return;
    }

    const token = crypto.randomUUID();
    saveBrowserDiffPreview(token, diffPreview);
    const url = buildDiffWindowUrl(token);
    const opened = window.open(url, "_blank", "popup,width=1680,height=980");

    if (!opened) {
      window.location.href = url;
    }
  };

  const persistSession = async (nextSession: Session) => {
    if (window.withmate) {
      const savedSession = await window.withmate.updateSession(nextSession);
      setSessions([savedSession]);
      return savedSession;
    }

    const nextSessions = sessions.map((session) => (session.id === nextSession.id ? nextSession : session));
    saveBrowserMockSessions(nextSessions);
    setSessions(nextSessions);
    return nextSession;
  };

  const handleChangeApproval = async (approvalMode: string) => {
    if (!selectedSession || selectedSession.approvalMode === approvalMode) {
      return;
    }

    const nextSession: Session = {
      ...selectedSession,
      approvalMode,
      updatedAt: "just now",
    };

    await persistSession(nextSession);
  };

  const handleCommitModel = async () => {
    if (!selectedSession || selectedSession.runState === "running") {
      return;
    }

    const nextModel = modelDraft.trim() || DEFAULT_MODEL_ID;
    const nextSelection = resolveModelSelection(nextModel, selectedSession.reasoningEffort);
    const nextReasoningEffort = nextSelection.resolvedReasoningEffort;

    setModelDraft(nextModel);

    if (selectedSession.model === nextModel && selectedSession.reasoningEffort === nextReasoningEffort) {
      return;
    }

    await persistSession({
      ...selectedSession,
      model: nextModel,
      reasoningEffort: nextReasoningEffort,
      updatedAt: "just now",
    });
  };

  const handleChangeReasoningEffort = async (reasoningEffort: Session["reasoningEffort"]) => {
    if (!selectedSession || selectedSession.runState === "running") {
      return;
    }

    const nextModel = modelDraft.trim() || selectedSession.model || DEFAULT_MODEL_ID;
    const nextSelection = resolveModelSelection(nextModel, reasoningEffort);

    await persistSession({
      ...selectedSession,
      model: nextModel,
      reasoningEffort: nextSelection.resolvedReasoningEffort,
      updatedAt: "just now",
    });
  };

  const handleResendLastMessage = async () => {
    if (!lastUserMessage || selectedSession?.runState === "running") {
      return;
    }

    await sendMessage(lastUserMessage.text);
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

  const handleModelInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    void handleCommitModel();
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
                <input
                  list="withmate-model-catalog"
                  value={modelDraft}
                  onChange={(event) => setModelDraft(event.target.value)}
                  onBlur={() => void handleCommitModel()}
                  onKeyDown={handleModelInputKeyDown}
                  disabled={selectedSession.runState === "running"}
                />
                <datalist id="withmate-model-catalog">
                  {bundledModelCatalog.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </datalist>
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

              {resolvedSelection && didModelSelectionFallback(resolvedSelection) ? (
                <p className="composer-setting-note">{resolvedModelSelectionLabel(resolvedSelection)}</p>
              ) : null}
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
