import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  type AuditLogEntry,
  createDefaultAppSettings,
  type ComposerPreview,
  currentTimestampLabel,
  DEFAULT_CHARACTER_THEME_COLORS,
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
import { buildCharacterThemeStyle } from "./theme-utils.js";
import {
  approvalModeOptions,
  CharacterAvatar,
  fileKindLabel,
  liveRunStepDetailsLabel,
  liveRunStepStatusLabel,
  modelDisplayLabel,
  modelOptionLabel,
  operationTypeLabel,
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

function liveRunStepBucketPriority(status: string): number {
  switch (status) {
    case "failed":
    case "canceled":
    case "in_progress":
      return 0;
    case "completed":
      return 1;
    case "pending":
      return 2;
    default:
      return 2;
  }
}

function liveRunStepToneClassName(status: string): string {
  switch (status) {
    case "in_progress":
    case "completed":
    case "failed":
    case "canceled":
    case "pending":
      return status;
    default:
      return "unknown";
  }
}

type ParsedFileChangeSummaryLine = {
  actionLabel: string;
  toneClassName: "add" | "edit" | "delete" | "rename";
  path: string;
};

const FILE_CHANGE_SUMMARY_ACTION_META: Record<string, Pick<ParsedFileChangeSummaryLine, "actionLabel" | "toneClassName">> = {
  add: { actionLabel: "ADD", toneClassName: "add" },
  added: { actionLabel: "ADD", toneClassName: "add" },
  create: { actionLabel: "ADD", toneClassName: "add" },
  created: { actionLabel: "ADD", toneClassName: "add" },
  new: { actionLabel: "ADD", toneClassName: "add" },
  edit: { actionLabel: "EDIT", toneClassName: "edit" },
  edited: { actionLabel: "EDIT", toneClassName: "edit" },
  modify: { actionLabel: "EDIT", toneClassName: "edit" },
  modified: { actionLabel: "EDIT", toneClassName: "edit" },
  update: { actionLabel: "EDIT", toneClassName: "edit" },
  updated: { actionLabel: "EDIT", toneClassName: "edit" },
  delete: { actionLabel: "DEL", toneClassName: "delete" },
  deleted: { actionLabel: "DEL", toneClassName: "delete" },
  remove: { actionLabel: "DEL", toneClassName: "delete" },
  removed: { actionLabel: "DEL", toneClassName: "delete" },
  move: { actionLabel: "MOVE", toneClassName: "rename" },
  moved: { actionLabel: "MOVE", toneClassName: "rename" },
  rename: { actionLabel: "MOVE", toneClassName: "rename" },
  renamed: { actionLabel: "MOVE", toneClassName: "rename" },
};

function parseFileChangeSummary(summary: string): ParsedFileChangeSummaryLine[] | null {
  const lines = summary
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return null;
  }

  const parsedLines = lines.map((line) => {
    const separatorIndex = line.indexOf(": ");
    if (separatorIndex <= 0) {
      return null;
    }

    const actionToken = line.slice(0, separatorIndex).trim().toLowerCase();
    const path = line.slice(separatorIndex + 2).trim();
    const actionMeta = FILE_CHANGE_SUMMARY_ACTION_META[actionToken];
    if (!actionMeta || !path) {
      return null;
    }

    return {
      actionLabel: actionMeta.actionLabel,
      toneClassName: actionMeta.toneClassName,
      path,
    } satisfies ParsedFileChangeSummaryLine;
  });

  return parsedLines.every((line) => line !== null) ? parsedLines : null;
}

function buildDisplayedMessagesScrollSignature(messages: Message[]): string {
  return messages
    .map((message) => {
      const artifact = message.artifact
        ? [
            message.artifact.title,
            message.artifact.activitySummary.join("\u001f"),
            message.artifact.runChecks.map((check) => `${check.label}=${check.value}`).join("\u001f"),
            message.artifact.changedFiles
              .map((file) => `${file.kind}:${file.path}:${file.summary}:${file.diffRows.length}`)
              .join("\u001f"),
            message.artifact.operationTimeline
              ? message.artifact.operationTimeline
                  .map((operation) => `${operation.type}:${operation.summary}:${operation.details ?? ""}`)
                  .join("\u001f")
              : "",
          ].join("\u001e")
        : "";

      return [message.role, message.accent ? "1" : "0", message.text, artifact].join("\u001d");
    })
    .join("\u001c");
}

function buildLiveRunScrollSignature(liveRun: LiveSessionRunState | null): string {
  if (!liveRun) {
    return "";
  }

  return [
    liveRun.assistantText,
    liveRun.errorMessage,
    liveRun.usage
      ? [liveRun.usage.inputTokens, liveRun.usage.cachedInputTokens, liveRun.usage.outputTokens].join(":")
      : "",
    liveRun.steps
      .map((step) => [step.id, step.type, step.status, step.summary, step.details ?? ""].join("\u001d"))
      .join("\u001c"),
  ].join("\u001b");
}

export default function App() {
  const isDesktopRuntime = typeof window !== "undefined" && !!window.withmate;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [draft, setDraft] = useState("");
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const [selectedDiff, setSelectedDiff] = useState<DiffPreviewPayload | null>(null);
  const [auditLogsOpen, setAuditLogsOpen] = useState(false);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [liveRun, setLiveRun] = useState<LiveSessionRunState | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [resolvedCharacter, setResolvedCharacter] = useState<CharacterProfile | null | undefined>(undefined);
  const [composerPreview, setComposerPreview] = useState<ComposerPreview>({ attachments: [], errors: [] });
  const [pickerBaseDirectory, setPickerBaseDirectory] = useState("");
  const [composerCaret, setComposerCaret] = useState(0);
  const [workspacePathMatches, setWorkspacePathMatches] = useState<string[]>([]);
  const [isMessageListFollowing, setIsMessageListFollowing] = useState(true);
  const [hasMessageListUnread, setHasMessageListUnread] = useState(false);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageListSignatureRef = useRef("");
  const messageListSessionIdRef = useRef<string | null>(null);

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
  const sessionThemeStyle = useMemo(
    () => (selectedSession ? buildCharacterThemeStyle(selectedSession.characterThemeColors) : undefined),
    [selectedSession],
  );
  const selectedDiffThemeStyle = useMemo(
    () => (selectedDiff ? buildCharacterThemeStyle(selectedDiff.themeColors) : undefined),
    [selectedDiff],
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
      return "この provider は Settings の Coding Agent Providers で無効になっているよ。Home の Settings で有効化してね。";
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
  const displayedMessagesScrollSignature = useMemo(
    () => buildDisplayedMessagesScrollSignature(displayedMessages),
    [displayedMessages],
  );
  const liveRunScrollSignature = useMemo(() => buildLiveRunScrollSignature(liveRun), [liveRun]);
  const messageListScrollSignature = useMemo(
    () =>
      [
        selectedSession?.id ?? "",
        selectedSession?.runState ?? "",
        displayedMessagesScrollSignature,
        liveRunScrollSignature,
      ].join("\u001a"),
    [displayedMessagesScrollSignature, liveRunScrollSignature, selectedSession?.id, selectedSession?.runState],
  );

  useEffect(() => {
    setDraft("");
    setComposerPreview({ attachments: [], errors: [] });
    setPickerBaseDirectory(selectedSession?.workspacePath ?? "");
    setComposerCaret(0);
    setWorkspacePathMatches([]);
    setLiveRun(null);
  }, [selectedSession?.id]);

  useLayoutEffect(() => {
    const messageListElement = messageListRef.current;
    const selectedSessionId = selectedSession?.id ?? null;
    const currentSignature = messageListScrollSignature;
    const wasSameSession = messageListSessionIdRef.current === selectedSessionId;
    const hasSignatureChanged = messageListSignatureRef.current !== currentSignature;

    if (!messageListElement) {
      messageListSessionIdRef.current = selectedSessionId;
      messageListSignatureRef.current = currentSignature;
      return;
    }

    if (!wasSameSession) {
      messageListSessionIdRef.current = selectedSessionId;
      messageListSignatureRef.current = currentSignature;
      setIsMessageListFollowing(true);
      setHasMessageListUnread(false);
      messageListElement.scrollTop = messageListElement.scrollHeight;
      return;
    }

    if (!hasSignatureChanged) {
      return;
    }

    messageListSignatureRef.current = currentSignature;

    if (isMessageListFollowing) {
      messageListElement.scrollTop = messageListElement.scrollHeight;
      return;
    }

    setHasMessageListUnread(true);
  }, [isMessageListFollowing, messageListScrollSignature, selectedSession?.id]);

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

  const scrollMessageListToBottom = () => {
    const messageListElement = messageListRef.current;
    if (!messageListElement) {
      return;
    }

    messageListElement.scrollTop = messageListElement.scrollHeight;
  };

  const handleMessageListScroll = () => {
    const messageListElement = messageListRef.current;
    if (!messageListElement) {
      return;
    }

    const bottomGap = Math.max(0, messageListElement.scrollHeight - messageListElement.clientHeight - messageListElement.scrollTop);
    const nextFollowing = bottomGap <= 80;

    setIsMessageListFollowing((current) => (current === nextFollowing ? current : nextFollowing));
    if (nextFollowing) {
      setHasMessageListUnread(false);
    }
  };

  const handleJumpToMessageListBottom = () => {
    setIsMessageListFollowing(true);
    setHasMessageListUnread(false);
    scrollMessageListToBottom();
  };

  const orderedLiveRunSteps = useMemo(
    () =>
      (liveRun?.steps ?? [])
        .map((step, index) => ({ step, index }))
        .sort((left, right) => {
          const bucketDiff =
            liveRunStepBucketPriority(left.step.status) - liveRunStepBucketPriority(right.step.status);
          return bucketDiff !== 0 ? bucketDiff : left.index - right.index;
        })
        .map(({ step }) => step),
    [liveRun?.steps],
  );

  const hasInProgressLiveRunStep = useMemo(
    () => orderedLiveRunSteps.some((step) => step.status === "in_progress"),
    [orderedLiveRunSteps],
  );

  const liveRunUsageEntries = useMemo(() => {
    if (!liveRun?.usage) {
      return [];
    }

    const entries = [
      { key: "input", label: "input", value: liveRun.usage.inputTokens },
      { key: "output", label: "output", value: liveRun.usage.outputTokens },
    ];

    if (liveRun.usage.cachedInputTokens > 0) {
      entries.splice(1, 0, {
        key: "cached",
        label: "cached",
        value: liveRun.usage.cachedInputTokens,
      });
    }

    return entries;
  }, [liveRun?.usage]);

  const liveRunAssistantText = liveRun?.assistantText ?? "";
  const hasLiveRunAssistantText = liveRunAssistantText.length > 0;
  const hasVisibleLiveRunShell = Boolean(
    liveRun && (orderedLiveRunSteps.length > 0 || liveRun.errorMessage || liveRunUsageEntries.length > 0),
  );
  const pendingIndicatorCharacterName = useMemo(() => {
    const candidateNames = [selectedSessionCharacter?.name, resolvedCharacter?.name]
      .map((name) => name?.trim() ?? "")
      .filter(Boolean);

    return candidateNames[0] ?? "";
  }, [resolvedCharacter?.name, selectedSessionCharacter?.name]);
  const pendingRunIndicatorText = hasInProgressLiveRunStep
    ? pendingIndicatorCharacterName
      ? `${pendingIndicatorCharacterName}が作業を進めています`
      : "作業を進めています"
    : hasLiveRunAssistantText
      ? pendingIndicatorCharacterName
        ? `${pendingIndicatorCharacterName}が返答を続けています`
        : "返答を続けています"
      : pendingIndicatorCharacterName
        ? `${pendingIndicatorCharacterName}が返答を準備しています`
        : "返答を準備しています";
  const pendingRunIndicatorAnnouncement = pendingRunIndicatorText;

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
    <div className="page-shell session-page" style={sessionThemeStyle}>
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
              <span className="session-window-title session-title-accent">{selectedSession.taskTitle}</span>
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
          <div className="message-list" ref={messageListRef} onScroll={handleMessageListScroll}>
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
                                            <button
                                              className="diff-button"
                                              type="button"
                                              onClick={() =>
                                                setSelectedDiff({
                                                  title: message.artifact!.title,
                                                  file,
                                                  themeColors:
                                                    selectedSession?.characterThemeColors ?? DEFAULT_CHARACTER_THEME_COLORS,
                                                })
                                              }
                                            >
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
                <div className="message-card assistant pending-message-card">
                  <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
                    {pendingRunIndicatorAnnouncement}
                  </span>
                  <div className="live-run-shell-status pending-run-indicator" aria-hidden="true">
                    <span className="live-run-shell-status-badge">実行中</span>
                    <span className="live-run-shell-status-text">{pendingRunIndicatorText}</span>
                    <span className="typing-dots pending-run-indicator-dots">
                      <span />
                      <span />
                      <span />
                    </span>
                  </div>
                  {hasLiveRunAssistantText ? <MessageRichText text={liveRunAssistantText} onOpenPath={handleOpenInlinePath} /> : null}
                  {liveRun && hasVisibleLiveRunShell ? (
                    <div className="live-run-shell">
                      {orderedLiveRunSteps.length > 0 ? (
                        <ul className="live-run-step-list">
                          {orderedLiveRunSteps.map((step) => {
                            const toneClassName = liveRunStepToneClassName(step.status);
                            const parsedFileChangeSummary = step.type === "file_change" ? parseFileChangeSummary(step.summary) : null;

                            return (
                              <li key={step.id} className={`live-run-step ${toneClassName} ${step.type}`}>
                                <div className="live-run-step-head">
                                  <span className={`live-run-step-status ${toneClassName}`}>{liveRunStepStatusLabel(step.status)}</span>
                                  <span className="live-run-step-type">{operationTypeLabel(step.type)}</span>
                                </div>
                                {parsedFileChangeSummary ? (
                                  <div className="live-run-step-summary live-run-file-change-summary">
                                    <ul className="live-run-file-change-list" aria-label="変更対象ファイル">
                                      {parsedFileChangeSummary.map((change, index) => (
                                        <li key={`${change.path}-${index}`} className="live-run-file-change-item">
                                          <span className={`live-run-file-change-kind ${change.toneClassName}`}>{change.actionLabel}</span>
                                          <code className="live-run-file-change-path">{change.path}</code>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                ) : step.type === "command_execution" ? (
                                  <div className="live-run-step-summary live-run-command-summary" aria-label="実行コマンド">
                                    <span className="live-run-command-prefix" aria-hidden="true">
                                      $
                                    </span>
                                    <code className="live-run-command-text">{step.summary}</code>
                                  </div>
                                ) : (
                                  <p className="live-run-step-summary">{step.summary}</p>
                                )}
                                {step.details ? (
                                  <details className="live-run-step-details">
                                    <summary>{liveRunStepDetailsLabel(step.type)}</summary>
                                    <pre>{step.details}</pre>
                                  </details>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                      {liveRun.errorMessage ? (
                        <div className="live-run-error-block" role="alert">
                          <strong>実行エラー</strong>
                          <p className="live-run-error">{liveRun.errorMessage}</p>
                        </div>
                      ) : null}
                      {liveRunUsageEntries.length > 0 ? (
                        <div className="live-run-usage">
                          {liveRunUsageEntries.map((entry) => (
                            <span key={entry.key}>
                              {entry.label} {entry.value}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </article>
            ) : null}

          </div>

          {!isMessageListFollowing ? (
            <aside className={`message-follow-banner ${hasMessageListUnread ? "has-unread" : "idle"}`} aria-live="polite">
              <div className="message-follow-banner-copy">
                <span className="message-follow-banner-badge">{hasMessageListUnread ? "新着あり" : "読み返し中"}</span>
                <p>{hasMessageListUnread ? "追従を止めている間に新しい表示が来たよ。" : "今は読み返し位置を維持しているよ。"}</p>
              </div>
              <button type="button" className="message-follow-banner-button" onClick={handleJumpToMessageListBottom}>
                末尾へ移動
              </button>
            </aside>
          ) : null}

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
                className={selectedSession.runState === "running" ? "danger session-send-button" : "session-send-button"}
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
          <section
            className="diff-editor panel theme-accent"
            style={selectedDiffThemeStyle}
            onClick={(event) => event.stopPropagation()}
          >
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

