import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  type AuditLogEntry,
  createDefaultAppSettings,
  type ComposerPreview,
  currentTimestampLabel,
  getProviderAppSettings,
  getSessionIdFromLocation,
  type ChangedFile,
  type CharacterProfile,
  type DiffPreviewPayload,
  type LiveSessionRunState,
  type Message,
  type RunSessionTurnRequest,
  type Session,
  type AppSettings,
} from "./app-state.js";
import { DiffViewer, DiffViewerSubbar } from "./DiffViewer.js";
import {
  getProviderCatalog,
  getReasoningEffortOptionsForModel,
  resolveModelSelection,
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
import { MessageRichText } from "./MessageRichText.js";

type ActivePathReference = {
  query: string;
  start: number;
  end: number;
};

function getActivePathReference(value: string, caret: number): ActivePathReference | null {
  const prefix = value.slice(0, caret);
  const match = /(^|[\s(])@(?:"([^"\r\n]*)|([^\s@"\r\n]*))$/.exec(prefix);
  if (!match) {
    return null;
  }

  const query = (match[2] ?? match[3] ?? "").replace(/\\/g, "/");
  const start = (match.index ?? 0) + match[1].length;

  return {
    query,
    start,
    end: caret,
  };
}

function formatPathReference(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

function normalizePathForReference(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function toWorkspaceRelativeReference(workspacePath: string, selectedPath: string): string | null {
  const normalizedWorkspacePath = normalizePathForReference(workspacePath).replace(/\/+$/, "");
  const normalizedSelectedPath = normalizePathForReference(selectedPath);
  const workspacePrefix = `${normalizedWorkspacePath}/`;
  if (!normalizedSelectedPath.toLocaleLowerCase().startsWith(workspacePrefix.toLocaleLowerCase())) {
    return null;
  }

  return normalizedSelectedPath.slice(workspacePrefix.length);
}

export default function App() {
  const isDesktopRuntime = typeof window !== "undefined" && !!window.withmate;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [draft, setDraft] = useState("");
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const [selectedDiff, setSelectedDiff] = useState<{ title: string; file: ChangedFile } | null>(null);
  const [auditLogsOpen, setAuditLogsOpen] = useState(false);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [liveRun, setLiveRun] = useState<LiveSessionRunState | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [resolvedCharacter, setResolvedCharacter] = useState<CharacterProfile | null | undefined>(undefined);
  const [composerPreview, setComposerPreview] = useState<ComposerPreview>({ attachments: [], errors: [] });
  const [pickerBaseDirectory, setPickerBaseDirectory] = useState("");
  const [composerCaret, setComposerCaret] = useState(0);
  const [workspacePathMatches, setWorkspacePathMatches] = useState<string[]>([]);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

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
  const isSelectedCharacterMissing = useMemo(
    () => !!selectedSession && !!selectedSession.characterId && resolvedCharacter === null,
    [resolvedCharacter, selectedSession],
  );
  const isCharacterResolutionPending = useMemo(
    () => !!selectedSession && !!selectedSession.characterId && resolvedCharacter === undefined,
    [resolvedCharacter, selectedSession],
  );
  const isSelectedProviderEnabled = useMemo(
    () => !!selectedSession && getProviderAppSettings(appSettings, selectedSession.provider).enabled,
    [appSettings, selectedSession],
  );
  const sessionExecutionBlockedReason = useMemo(() => {
    if (!selectedSession) {
      return "";
    }

    if (isCharacterResolutionPending) {
      return "この session の character 状態を確認しているよ。少し待ってね。";
    }

    if (isSelectedCharacterMissing) {
      return "この session は元の character が見つからないため、過去ログの閲覧のみできるよ。";
    }

    if (!isSelectedProviderEnabled) {
      return "この provider は Settings で無効になっているよ。Home の Settings で有効化してね。";
    }

    return "";
  }, [isCharacterResolutionPending, isSelectedCharacterMissing, isSelectedProviderEnabled, selectedSession]);

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

    void window.withmate.getModelCatalog(null).then((snapshot) => {
      if (active) {
        setModelCatalog(snapshot);
      }
    });

    const unsubscribe = window.withmate.subscribeModelCatalog((snapshot) => {
      if (!active) {
        return;
      }
      setModelCatalog(snapshot);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedSession?.id]);

  useEffect(() => {
    let active = true;
    if (!window.withmate) {
      return () => {
        active = false;
      };
    }

    void window.withmate.getAppSettings().then((settings) => {
      if (active) {
        setAppSettings(settings);
      }
    });

    const unsubscribe = window.withmate.subscribeAppSettings((settings) => {
      if (active) {
        setAppSettings(settings);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const withmateApi = window.withmate;
    if (!withmateApi || !selectedSession?.characterId) {
      setResolvedCharacter(selectedSession ? null : undefined);
      return () => {
        active = false;
      };
    }

    setResolvedCharacter(undefined);
    const refreshCharacterResolution = () => {
      void withmateApi.getCharacter(selectedSession.characterId).then((character) => {
        if (active) {
          setResolvedCharacter(character);
        }
      });
    };

    refreshCharacterResolution();
    const unsubscribe = withmateApi.subscribeCharacters(() => {
      refreshCharacterResolution();
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedSession?.characterId, selectedSession?.id]);

  const displayedMessages: Message[] = selectedSession ? selectedSession.messages : [];

  useEffect(() => {
    setDraft("");
    setComposerPreview({ attachments: [], errors: [] });
    setPickerBaseDirectory(selectedSession?.workspacePath ?? "");
    setComposerCaret(0);
    setWorkspacePathMatches([]);
    setLiveRun(null);
  }, [selectedSession?.id]);

  useLayoutEffect(() => {
    if (!messageListRef.current) {
      return;
    }

    messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [selectedSession?.id, displayedMessages.length, liveRun?.assistantText, liveRun?.steps.length]);

  useEffect(() => {
    let active = true;

    if (!window.withmate || !selectedSession) {
      if (active) {
        setAuditLogs([]);
      }
      return () => {
        active = false;
      };
    }

    void window.withmate.listSessionAuditLogs(selectedSession.id).then((nextAuditLogs) => {
      if (active) {
        setAuditLogs(nextAuditLogs);
      }
    });

    return () => {
      active = false;
    };
  }, [selectedSession?.id, selectedSession?.updatedAt, selectedSession?.runState, displayedMessages.length]);

  useEffect(() => {
    let active = true;

    if (!window.withmate || !selectedSession) {
      setLiveRun(null);
      return () => {
        active = false;
      };
    }

    void window.withmate.getLiveSessionRun(selectedSession.id).then((state) => {
      if (active) {
        setLiveRun(state);
      }
    });

    const unsubscribe = window.withmate.subscribeLiveSessionRun((sessionId, state) => {
      if (!active || sessionId !== selectedSession.id) {
        return;
      }

      setLiveRun(state);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedSession?.id]);

  useEffect(() => {
    let active = true;
    const withmateApi = window.withmate;
    if (!withmateApi || !selectedSession) {
      setComposerPreview({ attachments: [], errors: [] });
      return () => {
        active = false;
      };
    }

    const timeoutId = window.setTimeout(() => {
      void withmateApi.previewComposerInput(selectedSession.id, draft).then((preview) => {
        if (active) {
          setComposerPreview(preview);
        }
      }).catch((error) => {
        if (active) {
          setComposerPreview({
            attachments: [],
            errors: [error instanceof Error ? error.message : "添付の解決に失敗したよ。"],
          });
        }
      });
    }, 120);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [draft, selectedSession]);
  useEffect(() => {
    let active = true;
    const withmateApi = window.withmate;
    const activeReference = selectedSession ? getActivePathReference(draft, composerCaret) : null;

    if (!withmateApi || !selectedSession || selectedSession.runState === "running" || !activeReference || !activeReference.query.trim()) {
      setWorkspacePathMatches([]);
      return () => {
        active = false;
      };
    }

    const timeoutId = window.setTimeout(() => {
      void withmateApi.searchWorkspaceFiles(selectedSession.id, activeReference.query).then((matches) => {
        if (active) {
          setWorkspacePathMatches(matches);
        }
      }).catch(() => {
        if (active) {
          setWorkspacePathMatches([]);
        }
      });
    }, 100);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [draft, composerCaret, selectedSession]);
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

    if (sessionExecutionBlockedReason) {
      throw new Error(sessionExecutionBlockedReason);
    }

    const nextMessage = messageText.trim();
    const preview = await window.withmate.previewComposerInput(selectedSession.id, messageText);
    setComposerPreview(preview);
    if (preview.errors.length > 0) {
      throw new Error(preview.errors[0] ?? "添付の解決に失敗したよ。");
    }

    if (!nextMessage) {
      return;
    }

    setDraft("");
    const updatedSession: Session = {
      ...selectedSession,
      updatedAt: currentTimestampLabel(),
      status: "running",
      runState: "running",
      messages: [...selectedSession.messages, { role: "user", text: nextMessage }],
    };

    setSessions([updatedSession]);

    try {
      const request: RunSessionTurnRequest = {
        userMessage: messageText,
      };
      const savedSession = await window.withmate.runSessionTurn(selectedSession.id, request);
      setSessions([savedSession]);
    } catch (error) {
      console.error(error);
      setSessions([selectedSession]);
    }
  };

  const handleSend = async () => {
    try {
      await sendMessage(draft);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "送信に失敗したよ。");
    }
  };

  const handleCancelRun = async () => {
    if (!window.withmate || !selectedSession || selectedSession.runState !== "running") {
      return;
    }

    try {
      await window.withmate.cancelSessionRun(selectedSession.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "キャンセルに失敗したよ。");
    }
  };

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== "Enter" ||
      (!event.ctrlKey && !event.metaKey) ||
      selectedSession?.runState === "running" ||
      !!sessionExecutionBlockedReason
    ) {
      return;
    }

    event.preventDefault();
    void handleSend();
  };

  const handleSelectWorkspacePathMatch = (match: string) => {
    const textarea = composerTextareaRef.current;
    const activeReference = getActivePathReference(draft, composerCaret);
    if (!textarea || !activeReference) {
      return;
    }

    const replacement = formatPathReference(match);
    const nextDraft = `${draft.slice(0, activeReference.start)}${replacement}${draft.slice(activeReference.end)}`;
    const nextCaret = activeReference.start + replacement.length;
    setDraft(nextDraft);
    setComposerCaret(nextCaret);
    setWorkspacePathMatches([]);

    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
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
    if (!selectedSession || selectedSession.runState === "running" || approvalMode === selectedSession.approvalMode) {
      return;
    }

    const nextSession: Session = {
      ...selectedSession,
      approvalMode,
      updatedAt: currentTimestampLabel(),
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
      updatedAt: currentTimestampLabel(),
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
    if (!selectedSession || !selectedProviderCatalog || !modelCatalog) {
      return;
    }

    const selection = resolveModelSelection(selectedProviderCatalog, model, selectedSession.reasoningEffort);
    const nextSession: Session = {
      ...selectedSession,
      catalogRevision: modelCatalog.revision,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
      threadId: "",
      updatedAt: currentTimestampLabel(),
    };

    await persistSession(nextSession);
  };

  const handleChangeReasoningEffort = async (reasoningEffort: Session["reasoningEffort"]) => {
    if (!selectedSession || !selectedProviderCatalog || !modelCatalog) {
      return;
    }

    const selection = resolveModelSelection(selectedProviderCatalog, selectedSession.model, reasoningEffort);
    const nextSession: Session = {
      ...selectedSession,
      catalogRevision: modelCatalog.revision,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
      threadId: "",
      updatedAt: currentTimestampLabel(),
    };

    await persistSession(nextSession);
  };

  const handleResendLastMessage = async () => {
    if (!lastUserMessage || sessionExecutionBlockedReason) {
      return;
    }

    await sendMessage(lastUserMessage.text);
  };

  const handleCloseWindow = () => {
    window.close();
  };

  const handleOpenInlinePath = async (target: string) => {
    if (!window.withmate) {
      return;
    }

    try {
      await window.withmate.openPath(target, { baseDirectory: selectedSession?.workspacePath ?? null });
    } catch {
      // 読みやすさ改善が主目的なので、開けない場合は UI を壊さない
    }
  };

  const toDirectoryPath = (selectedPath: string) => {
    const normalized = selectedPath.replace(/[\\/]+$/, "");
    const lastSlashIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
    if (lastSlashIndex < 0) {
      return normalized;
    }

    return normalized.slice(0, lastSlashIndex);
  };

  const insertReferencePath = (selectedPath: string) => {
    const textarea = composerTextareaRef.current;
    const referencePath = selectedSession
      ? toWorkspaceRelativeReference(selectedSession.workspacePath, selectedPath) ?? normalizePathForReference(selectedPath)
      : normalizePathForReference(selectedPath);
    const referenceToken = formatPathReference(referencePath);
    const currentCaret = textarea?.selectionStart ?? composerCaret;
    const leadingSpacer = currentCaret > 0 && !/\s/.test(draft[currentCaret - 1] ?? "") ? " " : "";
    const trailingSpacer = draft.length > currentCaret && !/\s/.test(draft[currentCaret] ?? "") ? " " : "";
    const insertion = `${leadingSpacer}${referenceToken}${trailingSpacer}`;
    const nextDraft = `${draft.slice(0, currentCaret)}${insertion}${draft.slice(currentCaret)}`;
    const nextCaret = currentCaret + insertion.length;

    setDraft(nextDraft);
    setComposerCaret(nextCaret);
    setWorkspacePathMatches([]);

    window.requestAnimationFrame(() => {
      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const handleRemoveAttachmentReference = (attachmentPathCandidates: string[]) => {
    const escapedCandidates = attachmentPathCandidates
      .map((candidate) => formatPathReference(candidate))
      .map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    let nextDraft = draft;
    for (const escapedCandidate of escapedCandidates) {
      nextDraft = nextDraft.replace(
        new RegExp(`(^|[\\s(])${escapedCandidate}(?=\\s|$|[),.;:!?])`),
        (_match, leadingWhitespace: string) => leadingWhitespace || "",
      );
    }

    nextDraft = nextDraft
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n");

    setDraft(nextDraft);
    setComposerCaret(nextDraft.length);
    setWorkspacePathMatches([]);
  };

  const handlePickFile = async () => {
    if (!window.withmate) {
      return;
    }

    const selectedPath = await window.withmate.pickFile(pickerBaseDirectory || selectedSession?.workspacePath || null);
    if (!selectedPath) {
      return;
    }

    setPickerBaseDirectory(toDirectoryPath(selectedPath));
    insertReferencePath(selectedPath);
  };

  const handlePickFolder = async () => {
    if (!window.withmate) {
      return;
    }

    const selectedPath = await window.withmate.pickDirectory(pickerBaseDirectory || selectedSession?.workspacePath || null);
    if (!selectedPath) {
      return;
    }

    setPickerBaseDirectory(selectedPath);
    insertReferencePath(selectedPath);
  };

  const handlePickImage = async () => {
    if (!window.withmate) {
      return;
    }

    const selectedPath = await window.withmate.pickImageFile(pickerBaseDirectory || selectedSession?.workspacePath || null);
    if (!selectedPath) {
      return;
    }

    setPickerBaseDirectory(toDirectoryPath(selectedPath));
    insertReferencePath(selectedPath);
  };

  const auditPhaseLabel = (phase: AuditLogEntry["phase"]) => {
    switch (phase) {
      case "running":
      case "started":
        return "RUNNING";
      case "completed":
        return "DONE";
      case "canceled":
        return "CANCELED";
      case "failed":
        return "FAIL";
      default:
        return phase;
    }
  };

  const operationTypeLabel = (type: string) => {
    switch (type) {
      case "agent_message":
        return "Message";
      case "command_execution":
        return "Command";
      case "file_change":
        return "File";
      case "mcp_tool_call":
        return "MCP";
      case "web_search":
        return "Web";
      case "todo_list":
        return "Todo";
      case "reasoning":
        return "Reasoning";
      case "error":
        return "Error";
      default:
        return type;
    }
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
          <button className="drawer-toggle compact secondary" type="button" onClick={() => setAuditLogsOpen(true)}>
            Audit Log
          </button>
          <button className="drawer-toggle" type="button" onClick={handleCloseWindow}>
            Close Window
          </button>
        </div>
      </header>

      <section className="content-grid session-content-grid">
        <section className="panel chat-panel rise-3">
          <div className="message-list" ref={messageListRef}>
            {displayedMessages.length > 0 ? (
              displayedMessages.map((message, index) => {
                const artifactKey = `${selectedSession.id}-${index}`;
                const artifactExpanded = expandedArtifacts[artifactKey] ?? false;
                const isAssistant = message.role === "assistant";
                const artifactHasSnapshotRisk =
                  message.artifact?.runChecks.some((check) => check.label.startsWith("snapshot ")) ?? false;
                const artifactOperations =
                  message.artifact?.operationTimeline ??
                  message.artifact?.activitySummary.map((item) => ({
                    type: "summary",
                    summary: item,
                    details: undefined,
                  })) ??
                  [];

                return (
                  <article
                    key={`${message.role}-${index}`}
                    className={`message-row ${message.role}${message.accent ? " accent" : ""}`}
                  >
                    {isAssistant ? <CharacterAvatar character={selectedSessionCharacter} size="small" className="message-avatar" /> : null}
                    <div className={`message-card ${message.role}${message.accent ? " accent" : ""}`}>
                      <MessageRichText text={message.text} onOpenPath={handleOpenInlinePath} />

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
                                        <p>
                                          {artifactHasSnapshotRisk
                                            ? "差分は見つからなかったけど、snapshot の上限や省略で取りこぼしがあるかもしれないよ。"
                                            : "まだファイル変更はないよ。"}
                                        </p>
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
                                <ul className="artifact-operation-list">
                                  {artifactOperations.map((operation, operationIndex) => (
                                    <li key={`${operation.type}-${operationIndex}`} className={`artifact-operation-item ${operation.type}`}>
                                      <div className="artifact-operation-head">
                                        <span className={`artifact-operation-type ${operation.type}`}>{operationTypeLabel(operation.type)}</span>
                                      </div>
                                      {operation.type === "agent_message" ? (
                                        <div className="artifact-operation-message">
                                          <MessageRichText text={operation.summary} onOpenPath={handleOpenInlinePath} />
                                        </div>
                                      ) : (
                                        <p>{operation.summary}</p>
                                      )}
                                      {operation.details ? <pre>{operation.details}</pre> : null}
                                    </li>
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
            ) : null}

            {selectedSession.runState === "running" ? (
              <article className="message-row assistant pending-row">
                <CharacterAvatar character={selectedSessionCharacter} size="small" className="message-avatar" />
                <div className="message-card assistant pending-message-card" aria-live="polite" aria-busy="true">
                  {liveRun?.assistantText ? <MessageRichText text={liveRun.assistantText} onOpenPath={handleOpenInlinePath} /> : null}
                  {!liveRun?.assistantText ? (
                    <div className="typing-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                  ) : null}
                  {liveRun && (liveRun.steps.length > 0 || liveRun.errorMessage || liveRun.usage) ? (
                    <div className="live-run-shell">
                      {liveRun.steps.length > 0 ? (
                        <ul className="live-run-step-list">
                          {liveRun.steps.map((step) => (
                            <li key={step.id} className={`live-run-step ${step.status}`}>
                              <div className="live-run-step-head">
                                <span className={`live-run-step-status ${step.status}`}>{step.status}</span>
                                <strong>{step.type}</strong>
                              </div>
                              <p>{step.summary}</p>
                              {step.details ? <pre>{step.details}</pre> : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {liveRun.usage ? (
                        <div className="live-run-usage">
                          <span>input {liveRun.usage.inputTokens}</span>
                          <span>cached {liveRun.usage.cachedInputTokens}</span>
                          <span>output {liveRun.usage.outputTokens}</span>
                        </div>
                      ) : null}
                      {liveRun.errorMessage ? <p className="live-run-error">{liveRun.errorMessage}</p> : null}
                    </div>
                  ) : null}
                </div>
              </article>
            ) : null}
          </div>

          <div className="composer">
            {sessionExecutionBlockedReason ? (
              <div className="resume-banner browse-only-banner">
                <p>{sessionExecutionBlockedReason}</p>
              </div>
            ) : null}
            {selectedSession.runState === "interrupted" && lastUserMessage ? (
              <div className="resume-banner">
                <button type="button" onClick={() => void handleResendLastMessage()} disabled={!!sessionExecutionBlockedReason}>
                  同じ依頼を再送
                </button>
                <p>{lastUserMessage.text}</p>
              </div>
            ) : null}
            <div className="composer-attachments-toolbar">
              <button className="drawer-toggle compact secondary" type="button" onClick={() => void handlePickFile()} disabled={selectedSession.runState === "running" || !!sessionExecutionBlockedReason}>
                File
              </button>
              <button className="drawer-toggle compact secondary" type="button" onClick={() => void handlePickFolder()} disabled={selectedSession.runState === "running" || !!sessionExecutionBlockedReason}>
                Folder
              </button>
              <button className="drawer-toggle compact secondary" type="button" onClick={() => void handlePickImage()} disabled={selectedSession.runState === "running" || !!sessionExecutionBlockedReason}>
                Image
              </button>
            </div>
            {composerPreview.attachments.length > 0 ? (
              <div className="composer-attachment-list">
                {composerPreview.attachments.map((attachment) => {
                  return (
                    <div key={attachment.id} className={`composer-attachment-chip ${attachment.kind}`}>
                      <span className="composer-attachment-source">@</span>
                      <span className="composer-attachment-path">{attachment.displayPath}</span>
                      <button
                        type="button"
                        onClick={() =>
                          handleRemoveAttachmentReference(
                            [
                              attachment.workspaceRelativePath,
                              attachment.displayPath,
                              normalizePathForReference(attachment.absolutePath),
                            ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0),
                          )
                        }
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {composerPreview.errors.length > 0 ? (
              <div className="composer-error-list" role="alert">
                {composerPreview.errors.map((error) => (
                  <p key={error}>{error}</p>
                ))}
              </div>
            ) : null}
            <label className="composer-box">
              <textarea
                ref={composerTextareaRef}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setComposerCaret(event.target.selectionStart ?? event.target.value.length);
                }}
                onKeyDown={handleComposerKeyDown}
                onSelect={(event) => setComposerCaret(event.currentTarget.selectionStart ?? 0)}
                disabled={selectedSession.runState === "running" || !!sessionExecutionBlockedReason}
              />
              <button
                className={selectedSession.runState === "running" ? "danger" : ""}
                type="button"
                onClick={() => void (selectedSession.runState === "running" ? handleCancelRun() : handleSend())}
                disabled={selectedSession.runState !== "running" && (composerPreview.errors.length > 0 || !!sessionExecutionBlockedReason)}
              >
                {selectedSession.runState === "running" ? "Cancel" : "Send"}
              </button>
            </label>
            {workspacePathMatches.length > 0 ? (
              <div className="composer-path-match-list" role="listbox" aria-label="@path 候補">
                {workspacePathMatches.map((match) => (
                  <button
                    key={match}
                    type="button"
                    className="composer-path-match"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handleSelectWorkspacePathMatch(match)}
                  >
                    {match}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="composer-settings">
              <div className="composer-setting-field composer-setting-approval">
                <span>Approval</span>
                <div className="choice-list session-approval-list" role="group" aria-label="承認モード">
                  {approvalModeOptions.map((approval) => (
                    <button
                      key={approval.id}
                      className={`choice-chip${approval.id === selectedSession.approvalMode ? " active" : ""}`}
                      type="button"
                      onClick={() => void handleChangeApproval(approval.id)}
                      disabled={selectedSession.runState === "running"}
                    >
                      {approval.label}
                    </button>
                  ))}
                </div>
              </div>

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
                <select
                  value={selectedSession.reasoningEffort}
                  onChange={(event) => void handleChangeReasoningEffort(event.target.value as Session["reasoningEffort"])}
                  disabled={selectedSession.runState === "running"}
                  aria-label="推論の深さ"
                >
                  {availableReasoningEfforts.map((reasoningEffort) => (
                    <option key={reasoningEffort} value={reasoningEffort}>
                      {reasoningDepthLabel(reasoningEffort)}
                    </option>
                  ))}
                </select>
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

      {auditLogsOpen ? (
        <div className="diff-modal" role="dialog" aria-modal="true" onClick={() => setAuditLogsOpen(false)}>
          <section className="audit-log-panel panel" onClick={(event) => event.stopPropagation()}>
            <div className="diff-titlebar">
              <h2>Audit Log</h2>
              <div className="diff-titlebar-actions">
                <button className="diff-close" type="button" onClick={() => setAuditLogsOpen(false)}>
                  Close
                </button>
              </div>
            </div>

            <div className="audit-log-list">
              {auditLogs.length > 0 ? (
                auditLogs.map((entry) => (
                  <article key={entry.id} className={`audit-log-card ${entry.phase}`}>
                    <div className="audit-log-head">
                      <span className={`file-kind ${
                        entry.phase === "completed"
                          ? "add"
                          : entry.phase === "failed"
                            ? "delete"
                            : entry.phase === "canceled"
                              ? "edit"
                              : "edit"
                      }`}>
                        {auditPhaseLabel(entry.phase)}
                      </span>
                      <span className="audit-log-time">{entry.createdAt}</span>
                    </div>

                    <div className="audit-log-meta">
                      <span>{entry.provider}</span>
                      <span>{entry.model}</span>
                      <span>{entry.reasoningEffort}</span>
                      <span>{entry.approvalMode}</span>
                    </div>

                    <details className="audit-log-fold">
                      <summary>
                        <strong>System Prompt</strong>
                      </summary>
                      <section className="audit-log-section">
                        <pre>{entry.systemPromptText || "-"}</pre>
                      </section>
                    </details>

                    <details className="audit-log-fold" open>
                      <summary>
                        <strong>Input Prompt</strong>
                      </summary>
                      <section className="audit-log-section">
                        <pre>{entry.inputPromptText || "-"}</pre>
                      </section>
                    </details>

                    <details className="audit-log-fold">
                      <summary>
                        <strong>Composed Prompt</strong>
                      </summary>
                      <section className="audit-log-section">
                        <pre>{entry.composedPromptText || "-"}</pre>
                      </section>
                    </details>

                    <details className="audit-log-fold">
                      <summary>
                        <strong>Response</strong>
                      </summary>
                      <section className="audit-log-section">
                        <pre>{entry.assistantText || "-"}</pre>
                      </section>
                    </details>

                    <details className="audit-log-fold">
                      <summary>
                        <strong>Operations</strong>
                      </summary>
                      <section className="audit-log-section">
                        {entry.operations.length > 0 ? (
                          <ul className="audit-log-operations">
                            {entry.operations.map((operation, index) => (
                              <li key={`${entry.id}-${operation.type}-${index}`}>
                                <div className="audit-log-operation-head">
                                  <span>{operation.type}</span>
                                  <strong>{operation.summary}</strong>
                                </div>
                                {operation.details ? <pre>{operation.details}</pre> : null}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="audit-log-empty">記録された操作はまだないよ。</p>
                        )}
                      </section>
                    </details>

                    {entry.usage ? (
                      <details className="audit-log-fold compact">
                        <summary>
                          <strong>Usage</strong>
                        </summary>
                        <section className="audit-log-section compact">
                          <div className="audit-log-meta">
                            <span>input {entry.usage.inputTokens}</span>
                            <span>cached {entry.usage.cachedInputTokens}</span>
                            <span>output {entry.usage.outputTokens}</span>
                          </div>
                        </section>
                      </details>
                    ) : null}

                    {entry.errorMessage ? (
                      <details className="audit-log-fold compact">
                        <summary>
                          <strong>Error</strong>
                        </summary>
                        <section className="audit-log-section compact">
                          <pre>{entry.errorMessage}</pre>
                        </section>
                      </details>
                    ) : null}

                    <details className="audit-log-fold audit-log-raw">
                      <summary>
                        <strong>Raw Items</strong>
                      </summary>
                      <pre>{entry.rawItemsJson}</pre>
                    </details>
                  </article>
                ))
              ) : (
                <article className="empty-list-card compact">
                  <p>まだ監査ログはないよ。</p>
                </article>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

