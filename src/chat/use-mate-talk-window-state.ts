import { type ClipboardEvent, useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from "../approval-mode.js";
import {
  addAllowedAdditionalDirectory,
  removeAllowedAdditionalDirectory,
  resolveAdditionalDirectoryPickerBase,
} from "../additional-directory-state.js";
import { DEFAULT_CODEX_SANDBOX_MODE, normalizeCodexSandboxMode, type CodexSandboxMode } from "../codex-sandbox-mode.js";
import { restoreComposerTextareaFocusAndCaret } from "../composer-textarea-focus.js";
import type { MateProfile, MateStorageState } from "../mate/mate-state.js";
import type { MateTalkPathReference } from "../mate/mate-state.js";
import type { ModelCatalogSnapshot, ModelReasoningEffort } from "../model-catalog.js";
import { getApprovalOptionsForProvider, getSandboxOptionsForProvider } from "../provider-runtime-options.js";
import {
  createDefaultAppSettings,
  type AppSettings,
} from "../provider-settings-state.js";
import {
  appendMissingPathReferenceAttachments,
  buildAdditionalDirectoryItems,
  buildPathReferenceAttachmentItems,
  pickComposerReferencePath,
  removePathReferenceAttachments,
  resolveReferencePathsForInsertion,
  resolvePathReferenceRemovalTargets,
  type ComposerPathPickerKind,
} from "../session-composer-paths.js";
import { buildCharacterThemeStyle } from "../theme-utils.js";
import { currentTimestampLabel } from "../time-state.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";
import {
  createCopyMessageTextHandler,
} from "./message-text-actions.js";
import { createPastedSessionAttachmentHandler } from "./composer-paste-handlers.js";
import { buildOnDraftSelectHandler } from "./composer-draft-handlers.js";
import type { MateTalkMessage } from "./mate-talk-chat-projection.js";
import {
  buildMateTalkModelSelection,
  isMateTalkReasoningEffortAllowed,
  resolveMateTalkModelChange,
} from "./mate-talk-model-selection.js";
import {
  MateTalkTurnController,
  resolveMateTalkActionDockExpandedAfterSubmit,
} from "./mate-talk-state.js";
import {
  applyPickedAdditionalDirectoryUiStateCommand,
  applyPickedComposerReferencePathCommand,
  applySelectedPathReferenceInsertionCommand,
  applySessionFilesReferencePathsCommand,
  createActionDockCollapseHandler,
  createActionDockExpandHandler,
  createAdditionalDirectoryListToggleHandler,
  createHeaderExpandedToggleHandler,
  createPathReferenceRemovalHandler,
  createQuoteMessageTextHandler,
  createSessionFilesOpenHandler,
} from "./session-shell-handlers.js";

function getMateTalkLaunchParams(): { providerId: string; model: string; reasoningEffort: ModelReasoningEffort } {
  if (typeof window === "undefined") {
    return { providerId: "", model: "", reasoningEffort: "low" };
  }
  const query = new URLSearchParams(window.location.search);
  const reasoningEffort = query.get("reasoningEffort");
  return {
    providerId: query.get("provider")?.trim() ?? "",
    model: query.get("model")?.trim() ?? "",
    reasoningEffort: reasoningEffort === "minimal" || reasoningEffort === "low" || reasoningEffort === "medium" || reasoningEffort === "high" || reasoningEffort === "xhigh"
      ? reasoningEffort
      : "low",
  };
}

export function useMateTalkWindowState({
  withmateApi,
}: {
  withmateApi: WithMateWindowApi | null;
}) {
  const launchParams = useMemo(() => getMateTalkLaunchParams(), []);
  const [appSettings, setAppSettings] = useState<AppSettings>(() => createDefaultAppSettings());
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [mateState, setMateState] = useState<MateStorageState | null>(null);
  const [mateProfile, setMateProfile] = useState<MateProfile | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<MateTalkMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [isHeaderExpanded, setIsHeaderExpanded] = useState(false);
  const [isActionDockExpanded, setIsActionDockExpanded] = useState(true);
  const [providerId, setProviderId] = useState(launchParams.providerId);
  const [model, setModel] = useState(launchParams.model);
  const [reasoningEffort, setReasoningEffort] = useState<ModelReasoningEffort>(launchParams.reasoningEffort);
  const turnControllerRef = useRef(new MateTalkTurnController());
  const sessionFilesSessionIdRef = useRef(`mate-talk-${Date.now().toString(36)}`);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [inputCaret, setInputCaret] = useState(0);
  const [pickerBaseDirectory, setPickerBaseDirectory] = useState("");
  const [pathReferences, setPathReferences] = useState<MateTalkPathReference[]>([]);
  const [additionalDirectories, setAdditionalDirectories] = useState<string[]>([]);
  const [isAdditionalDirectoryListOpen, setIsAdditionalDirectoryListOpen] = useState(false);
  const [selectedApprovalMode, setSelectedApprovalMode] = useState<ApprovalMode>(DEFAULT_APPROVAL_MODE);
  const [selectedCodexSandboxMode, setSelectedCodexSandboxMode] =
    useState<CodexSandboxMode>(DEFAULT_CODEX_SANDBOX_MODE);

  useEffect(() => {
    if (!withmateApi) {
      setFeedback("Mate API が利用できないよ。");
      return () => {};
    }

    let active = true;
    void Promise.all([
      withmateApi.getAppSettings(),
      withmateApi.getModelCatalog(null),
      withmateApi.getMateState(),
      withmateApi.getMateProfile(),
    ]).then(([settings, snapshot, nextMateState, profile]) => {
      if (!active) {
        return;
      }
      setAppSettings(settings);
      setModelCatalog(snapshot);
      setMateState(nextMateState);
      setMateProfile(profile);
    }).catch((error) => {
      if (active) {
        setFeedback(error instanceof Error ? error.message : "メイトークの初期化に失敗したよ。");
      }
    });

    const unsubscribeModelCatalog = withmateApi.subscribeModelCatalog((snapshot) => {
      if (active) {
        setModelCatalog(snapshot);
      }
    });
    const unsubscribeAppSettings = withmateApi.subscribeAppSettings((settings) => {
      if (active) {
        setAppSettings(settings);
      }
    });

    return () => {
      active = false;
      unsubscribeModelCatalog();
      unsubscribeAppSettings();
    };
  }, [withmateApi]);

  const modelSelection = useMemo(() => buildMateTalkModelSelection({
    appSettings,
    modelCatalog,
    providerId,
    model,
    reasoningEffort,
  }), [appSettings, modelCatalog, model, providerId, reasoningEffort]);
  const {
    providerCatalog,
    selectedModel,
    modelOptions,
    reasoningOptions,
  } = modelSelection;
  const themeStyle = useMemo(
    () => buildCharacterThemeStyle(
      mateProfile
        ? {
            main: mateProfile.themeMain,
            sub: mateProfile.themeSub,
          }
        : undefined,
    ),
    [mateProfile],
  );

  useEffect(() => {
    if (providerId !== modelSelection.providerId) {
      setProviderId(modelSelection.providerId);
    }
    if (model !== modelSelection.model) {
      setModel(modelSelection.model);
    }
    if (reasoningEffort !== modelSelection.reasoningEffort) {
      setReasoningEffort(modelSelection.reasoningEffort);
    }
  }, [model, modelSelection, providerId, reasoningEffort]);

  const handleChangeInput = (value: string) => {
    setInput(value);
    setFeedback("");
  };

  const handleChangeInputWithCaret = (value: string, selectionStart = value.length) => {
    setInputCaret(selectionStart);
    handleChangeInput(value);
  };

  const handleChangeModel = (nextModel: string) => {
    const nextSelection = resolveMateTalkModelChange({
      providerCatalog,
      model: nextModel,
      reasoningEffort,
    });
    setModel(nextSelection.model);
    setReasoningEffort(nextSelection.reasoningEffort);
  };

  const handleChangeReasoningEffort = (nextReasoningEffort: string) => {
    if (isMateTalkReasoningEffortAllowed(selectedModel, nextReasoningEffort)) {
      setReasoningEffort(nextReasoningEffort);
    }
  };

  const handleCopyMessageText = createCopyMessageTextHandler({
    writeText: (normalized) => navigator.clipboard.writeText(normalized),
    onFailure: (error) => {
      console.error(error);
      setFeedback("コピーに失敗したよ。");
    },
  });

  const handleQuoteMessageText = createQuoteMessageTextHandler({
    isBlocked: () => sending,
    notifyBlocked: () => {},
    getComposerState: () => ({
      draft: input,
      fallbackCaret: inputCaret,
      textarea: composerTextareaRef.current,
    }),
    applyInsertion: ({ draft: nextInput, caret: nextCaret }) => {
      setInput(nextInput);
      setInputCaret(nextCaret);
      setFeedback("");
    },
    restoreComposerTextareaFocusAndCaret,
  });

  const insertReferencePaths = (selectedPaths: string[], kind: ComposerPathPickerKind) => {
    const textarea = composerTextareaRef.current;
    const normalizedPaths = resolveReferencePathsForInsertion(selectedPaths, null);
    applySelectedPathReferenceInsertionCommand({
      draft: input,
      fallbackCaret: inputCaret,
      selectedPaths,
      textarea,
      workspacePath: null,
      applyInsertion: ({ draft: nextInput, caret: nextCaret }) => {
        setInput(nextInput);
        setInputCaret(nextCaret);
        setFeedback("");
        setPathReferences((current) => appendMissingPathReferenceAttachments(current, normalizedPaths, kind));
      },
      restoreComposerTextareaFocusAndCaret,
    });
  };

  const insertReferencePath = (selectedPath: string, kind: ComposerPathPickerKind) => {
    insertReferencePaths([selectedPath], kind);
  };

  const pickAndInsertPath = async (kind: ComposerPathPickerKind) => {
    if (!withmateApi) {
      return;
    }

    const initialPath = pickerBaseDirectory || null;
    const selectedPath = await pickComposerReferencePath(kind, initialPath, withmateApi);
    applyPickedComposerReferencePathCommand({
      kind,
      selectedPath,
      setPickerBaseDirectory,
      insertReferencePath,
    });
  };

  const addToSessionFiles = async () => {
    if (!withmateApi || sending) {
      return;
    }

    const selectedPaths = await withmateApi.pickFiles(pickerBaseDirectory || null);
    if (selectedPaths.length === 0) {
      return;
    }

    const savedPaths = await withmateApi.copyFilesToSessionFiles(sessionFilesSessionIdRef.current, selectedPaths);
    applySessionFilesReferencePathsCommand({
      selectedPaths,
      referencePaths: savedPaths,
      setPickerBaseDirectory,
      insertReferencePaths: (referencePaths) => insertReferencePaths(referencePaths, "file"),
    });
  };

  const pickSessionFiles = async () => {
    if (!withmateApi || sending) {
      return;
    }

    const selectedPaths = await withmateApi.pickSessionFiles(sessionFilesSessionIdRef.current);
    if (selectedPaths.length === 0) {
      return;
    }

    applySessionFilesReferencePathsCommand({
      selectedPaths,
      referencePaths: selectedPaths,
      setPickerBaseDirectory,
      insertReferencePaths: (referencePaths) => insertReferencePaths(referencePaths, "file"),
    });
  };

  const handleDraftPaste = createPastedSessionAttachmentHandler({
    alertError: (message) => setFeedback(message),
    canPaste: () => !!withmateApi && !sending,
    currentTimestampLabel,
    fallbackErrorMessage: "貼り付けたファイルの保存に失敗したよ。",
    getSavePastedSessionFile: () => {
      return withmateApi ? (request) => withmateApi.savePastedSessionFile(request) : null;
    },
    getSessionId: () => sessionFilesSessionIdRef.current,
    insertReferencePaths: (referencePaths) => insertReferencePaths(referencePaths, "file"),
  });

  const openSessionFilesDirectory = createSessionFilesOpenHandler({
    getSessionId: () => sessionFilesSessionIdRef.current,
    getOpenSessionFiles: () => {
      return withmateApi
        ? (sessionId) => withmateApi.openSessionFilesDirectory(sessionId)
        : null;
    },
    alertError: (message) => setFeedback(message),
    fallbackErrorMessage: "session files directory を開けなかったよ。",
  });

  const openSessionFilesTerminal = createSessionFilesOpenHandler({
    getSessionId: () => sessionFilesSessionIdRef.current,
    getOpenSessionFiles: () => {
      return withmateApi
        ? (sessionId) => withmateApi.openSessionFilesTerminal(sessionId)
        : null;
    },
    alertError: (message) => setFeedback(message),
    fallbackErrorMessage: "session files terminal を開けなかったよ。",
  });

  const removePathReference = createPathReferenceRemovalHandler({
    getDraft: () => input,
    normalizeAttachmentPathCandidates: resolvePathReferenceRemovalTargets,
    applyRemoval: ({ draft: nextInput, caret: nextCaret }, removalTargets) => {
      setInput(nextInput);
      setInputCaret(nextCaret);
      setPathReferences((current) => removePathReferenceAttachments(current, removalTargets));
    },
  });

  const addAdditionalDirectory = async () => {
    if (!withmateApi || sending) {
      return;
    }

    const selectedPath = await withmateApi.pickDirectory(resolveAdditionalDirectoryPickerBase(pickerBaseDirectory));
    if (!selectedPath) {
      return;
    }

    applyPickedAdditionalDirectoryUiStateCommand({
      selectedPath,
      setPickerBaseDirectory,
      applyPickedDirectory: (directoryPath) => {
        setAdditionalDirectories((current) => addAllowedAdditionalDirectory(current, directoryPath));
      },
      setAdditionalDirectoryListOpen: setIsAdditionalDirectoryListOpen,
    });
  };

  const pathReferenceItems = useMemo(
    () =>
      buildPathReferenceAttachmentItems(pathReferences),
    [pathReferences],
  );
  const additionalDirectoryItems = useMemo(
    () =>
      buildAdditionalDirectoryItems(additionalDirectories, true),
    [additionalDirectories],
  );
  const approvalOptions = useMemo(
    () => getApprovalOptionsForProvider(providerId),
    [providerId],
  );
  const sandboxOptions = useMemo(
    () => getSandboxOptionsForProvider(providerId),
    [providerId],
  );

  useEffect(() => {
    if (!approvalOptions.some((option) => option.value === selectedApprovalMode)) {
      setSelectedApprovalMode(approvalOptions[0]?.value ?? DEFAULT_APPROVAL_MODE);
    }
  }, [approvalOptions, selectedApprovalMode]);

  useEffect(() => {
    if (sandboxOptions.length > 0 && !sandboxOptions.some((option) => option.value === selectedCodexSandboxMode)) {
      setSelectedCodexSandboxMode(sandboxOptions[0]?.value ?? DEFAULT_CODEX_SANDBOX_MODE);
    }
  }, [sandboxOptions, selectedCodexSandboxMode]);

  const handleSubmit = async () => {
    const normalizedText = input.trim();
    if (!normalizedText) {
      setFeedback("入力してから送信してね。");
      return;
    }
    if (sending) {
      return;
    }

    const { turnId, messageSequence } = turnControllerRef.current.beginTurn();
    const userMessage: MateTalkMessage = {
      id: `user-${messageSequence}`,
      role: "user",
      text: normalizedText,
    };

    setSending(true);
    setFeedback("");
    setMessages((current) => [...current, userMessage]);
    const turnAttachments = pathReferences;
    const turnAdditionalDirectories = additionalDirectories;
    const turnApprovalMode = selectedApprovalMode;
    const turnCodexSandboxMode = sandboxOptions.length > 0 ? selectedCodexSandboxMode : undefined;
    setInput("");
    setInputCaret(0);
    setPathReferences([]);
    setIsActionDockExpanded((current) =>
      resolveMateTalkActionDockExpandedAfterSubmit({
        isActionDockExpanded: current,
        appSettings,
      }),
    );

    try {
      if (!withmateApi) {
        throw new Error("Mate API が利用できないよ。");
      }
      const result = await withmateApi.runMateTalkTurn({
        message: normalizedText,
        provider: providerId,
        model,
        reasoningEffort,
        attachments: turnAttachments,
        additionalDirectories: turnAdditionalDirectories,
        approvalMode: turnApprovalMode,
        ...(turnCodexSandboxMode ? { codexSandboxMode: turnCodexSandboxMode } : {}),
      });
      if (!turnControllerRef.current.isLatestTurn(turnId)) {
        return;
      }
      setMessages((current) => [
        ...current,
        {
          id: `mate-${messageSequence}`,
          role: "mate",
          text: result.assistantMessage,
        },
      ]);
    } catch (error) {
      if (!turnControllerRef.current.isLatestTurn(turnId)) {
        return;
      }
      setMessages((current) => [
        ...current,
        {
          id: `mate-error-${messageSequence}`,
          role: "mate",
          text: error instanceof Error ? error.message : "返信に失敗したよ。",
        },
      ]);
    } finally {
      if (!turnControllerRef.current.isLatestTurn(turnId)) {
        return;
      }
      setSending(false);
    }
  };

  return {
    mateState,
    mateProfile,
    themeStyle,
    isHeaderExpanded,
    isActionDockExpanded,
    messages,
    input,
    feedback,
    modelOptions,
    selectedModel,
    providerCatalog,
    reasoningOptions,
    selectedReasoningEffort: reasoningEffort,
    messageListRef,
    composerTextareaRef,
    attachmentItems: pathReferenceItems,
    additionalDirectoryItems,
    isAdditionalDirectoryListOpen,
    additionalDirectoryCount: additionalDirectories.length,
    approvalOptions,
    selectedApprovalMode,
    sandboxOptions,
    selectedCodexSandboxMode,
    onChangeInput: handleChangeInputWithCaret,
    onCopyMessageText: handleCopyMessageText,
    onQuoteMessageText: handleQuoteMessageText,
    onPickFile: () => void pickAndInsertPath("file"),
    onPickFolder: () => void pickAndInsertPath("folder"),
    onPickImage: () => void pickAndInsertPath("image"),
    onAddToSessionFiles: () => void addToSessionFiles(),
    onPickSessionFiles: () => void pickSessionFiles(),
    onAddAdditionalDirectory: () => void addAdditionalDirectory(),
    onToggleAdditionalDirectoryList: createAdditionalDirectoryListToggleHandler({
      setAdditionalDirectoryListOpen: setIsAdditionalDirectoryListOpen,
    }),
    onRemoveAttachment: removePathReference,
    onRemoveAdditionalDirectory: (directoryPath: string) => {
      setAdditionalDirectories((current) => removeAllowedAdditionalDirectory(current, directoryPath));
    },
    onDraftFocus: () => {},
    onDraftPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void handleDraftPaste(event),
    onDraftSelect: buildOnDraftSelectHandler({
      setComposerCaret: setInputCaret,
    }),
    onChangeApprovalMode: (value: ApprovalMode) => setSelectedApprovalMode(normalizeApprovalMode(value)),
    onChangeCodexSandboxMode: (value: CodexSandboxMode) =>
      setSelectedCodexSandboxMode(normalizeCodexSandboxMode(value)),
    onChangeModel: handleChangeModel,
    onChangeReasoningEffort: handleChangeReasoningEffort,
    onSubmit: () => void handleSubmit(),
    onToggleHeaderExpanded: createHeaderExpandedToggleHandler({
      isEditingTitle: false,
      setHeaderExpanded: setIsHeaderExpanded,
    }),
    onOpenSessionFilesExplorer: () => void openSessionFilesDirectory(),
    onOpenSessionFilesTerminal: () => void openSessionFilesTerminal(),
    onCollapseActionDock: createActionDockCollapseHandler({
      canCollapse: true,
      setPinnedExpanded: setIsActionDockExpanded,
    }),
    onExpandActionDock: createActionDockExpandHandler({
      defaultOptions: { focusComposer: false },
      setPinnedExpanded: setIsActionDockExpanded,
      focusComposer: () => {},
    }),
    sending,
  };
}
