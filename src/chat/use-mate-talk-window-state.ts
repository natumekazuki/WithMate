import { type ClipboardEvent, useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from "../approval-mode.js";
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
  appendAdditionalDirectoryPath,
  appendMissingPathReferenceAttachments,
  buildAdditionalDirectoryItems,
  buildPathReferenceAttachmentItems,
  buildPathReferenceInsertionState,
  buildPathReferenceRemovalState,
  pickComposerReferencePath,
  removeAdditionalDirectoryPath,
  removePathReferenceAttachments,
  resolveReferencePathsForInsertion,
  resolvePickedPathBaseDirectory,
  resolvePathReferenceRemovalTargets,
  type ComposerPathPickerKind,
  toDirectoryPath,
} from "../session-composer-paths.js";
import { buildCharacterThemeStyle } from "../theme-utils.js";
import { currentTimestampLabel } from "../time-state.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";
import {
  copyMessageTextToClipboard,
  createQuotedMessageInsertion,
  insertComposerTextAtCaret,
} from "./message-text-actions.js";
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

  const handleCopyMessageText = (text: string) => {
    void copyMessageTextToClipboard(
      text,
      (normalized) => navigator.clipboard.writeText(normalized),
    ).catch((error) => {
      console.error(error);
      setFeedback("コピーに失敗したよ。");
    });
  };

  const handleQuoteMessageText = (text: string) => {
    if (sending) {
      return;
    }

    const textarea = composerTextareaRef.current;
    const insertion = createQuotedMessageInsertion(
      text,
      input,
      textarea?.selectionStart ?? inputCaret,
    );
    if (!insertion) {
      return;
    }
    const { draft: nextInput, caret: nextCaret } = insertion;
    setInput(nextInput);
    setInputCaret(nextCaret);
    setFeedback("");

    restoreComposerTextareaFocusAndCaret(textarea, nextCaret);
  };

  const insertReferencePaths = (selectedPaths: string[], kind: ComposerPathPickerKind) => {
    if (selectedPaths.length === 0) {
      return;
    }

    const textarea = composerTextareaRef.current;
    const normalizedPaths = resolveReferencePathsForInsertion(selectedPaths, null);
    const caret = textarea?.selectionStart ?? inputCaret;
    const insertionState = buildPathReferenceInsertionState(input, caret, normalizedPaths);
    if (!insertionState) {
      return;
    }
    const { draft: nextInput, caret: nextCaret } = insertionState;

    setInput(nextInput);
    setInputCaret(nextCaret);
    setFeedback("");
    setPathReferences((current) => appendMissingPathReferenceAttachments(current, normalizedPaths, kind));

    restoreComposerTextareaFocusAndCaret(textarea, nextCaret);
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
    if (!selectedPath) {
      return;
    }

    setPickerBaseDirectory(resolvePickedPathBaseDirectory(kind, selectedPath));
    insertReferencePath(selectedPath, kind);
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
    setPickerBaseDirectory(toDirectoryPath(selectedPaths[0]));
    insertReferencePaths(savedPaths, "file");
  };

  const pickSessionFiles = async () => {
    if (!withmateApi || sending) {
      return;
    }

    const selectedPaths = await withmateApi.pickSessionFiles(sessionFilesSessionIdRef.current);
    if (selectedPaths.length === 0) {
      return;
    }

    setPickerBaseDirectory(toDirectoryPath(selectedPaths[0]));
    insertReferencePaths(selectedPaths, "file");
  };

  const handleDraftPaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!withmateApi || sending) {
      return;
    }

    const files = Array.from(event.clipboardData.files);
    const itemFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    const pastedFiles = files.length > 0 ? files : itemFiles;
    if (pastedFiles.length === 0) {
      return;
    }

    event.preventDefault();
    const savedPaths: string[] = [];
    for (const file of pastedFiles) {
      const buffer = await file.arrayBuffer();
      const fileName = file.name.trim() || `pasted-${currentTimestampLabel().replace(/[:/\\\s]+/g, "-")}.png`;
      const savedPath = await withmateApi.savePastedSessionFile({
        sessionId: sessionFilesSessionIdRef.current,
        fileName,
        data: buffer,
      });
      savedPaths.push(savedPath);
    }

    insertReferencePaths(savedPaths, "file");
  };

  const openSessionFilesDirectory = async () => {
    if (!withmateApi) {
      return;
    }
    await withmateApi.openSessionFilesDirectory(sessionFilesSessionIdRef.current);
  };

  const openSessionFilesTerminal = async () => {
    if (!withmateApi) {
      return;
    }
    await withmateApi.openSessionFilesTerminal(sessionFilesSessionIdRef.current);
  };

  const removePathReference = (targets: string[]) => {
    const removalTargets = resolvePathReferenceRemovalTargets(targets);
    const { draft: nextInput, caret: nextCaret } = buildPathReferenceRemovalState(
      input,
      removalTargets,
    );
    setInput(nextInput);
    setInputCaret(nextCaret);
    setPathReferences((current) => removePathReferenceAttachments(current, removalTargets));
  };

  const addAdditionalDirectory = async () => {
    if (!withmateApi || sending) {
      return;
    }

    const selectedPath = await withmateApi.pickDirectory(pickerBaseDirectory || null);
    if (!selectedPath) {
      return;
    }

    setPickerBaseDirectory(selectedPath);
    setAdditionalDirectories((current) => appendAdditionalDirectoryPath(current, selectedPath));
    setIsAdditionalDirectoryListOpen(true);
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
    onToggleAdditionalDirectoryList: () => setIsAdditionalDirectoryListOpen((current) => !current),
    onRemoveAttachment: removePathReference,
    onRemoveAdditionalDirectory: (directoryPath: string) => {
      setAdditionalDirectories((current) => removeAdditionalDirectoryPath(current, directoryPath));
    },
    onDraftFocus: () => {},
    onDraftPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void handleDraftPaste(event),
    onDraftSelect: (selectionStart: number) => setInputCaret(selectionStart),
    onChangeApprovalMode: (value: ApprovalMode) => setSelectedApprovalMode(normalizeApprovalMode(value)),
    onChangeCodexSandboxMode: (value: CodexSandboxMode) =>
      setSelectedCodexSandboxMode(normalizeCodexSandboxMode(value)),
    onChangeModel: handleChangeModel,
    onChangeReasoningEffort: handleChangeReasoningEffort,
    onSubmit: () => void handleSubmit(),
    onToggleHeaderExpanded: () => setIsHeaderExpanded((current) => !current),
    onOpenSessionFilesExplorer: () => void openSessionFilesDirectory(),
    onOpenSessionFilesTerminal: () => void openSessionFilesTerminal(),
    onCollapseActionDock: () => setIsActionDockExpanded(false),
    onExpandActionDock: () => setIsActionDockExpanded(true),
    sending,
  };
}
