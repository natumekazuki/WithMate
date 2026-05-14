import { useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from "../approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE, normalizeCodexSandboxMode, type CodexSandboxMode } from "../codex-sandbox-mode.js";
import type { MateProfile, MateStorageState } from "../mate/mate-state.js";
import type { ModelCatalogSnapshot, ModelReasoningEffort } from "../model-catalog.js";
import { getApprovalOptionsForProvider, getSandboxOptionsForProvider } from "../provider-runtime-options.js";
import {
  createDefaultAppSettings,
  type AppSettings,
} from "../provider-settings-state.js";
import {
  buildAdditionalDirectoryDisplay,
  compactPathForDisplay,
  formatPathReference,
  normalizePathForReference,
  splitPathForDisplay,
  toDirectoryPath,
} from "../session-composer-paths.js";
import { buildCharacterThemeStyle } from "../theme-utils.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";
import type { MateTalkMessage } from "./mate-talk-chat-projection.js";
import {
  buildMateTalkModelSelection,
  isMateTalkReasoningEffortAllowed,
  resolveMateTalkModelChange,
} from "./mate-talk-model-selection.js";
import { MateTalkTurnController } from "./mate-talk-state.js";

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
  const [providerId, setProviderId] = useState(launchParams.providerId);
  const [model, setModel] = useState(launchParams.model);
  const [reasoningEffort, setReasoningEffort] = useState<ModelReasoningEffort>(launchParams.reasoningEffort);
  const turnControllerRef = useRef(new MateTalkTurnController());
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [inputCaret, setInputCaret] = useState(0);
  const [pickerBaseDirectory, setPickerBaseDirectory] = useState("");
  const [pathReferences, setPathReferences] = useState<Array<{ path: string; kind: "file" | "folder" | "image" }>>([]);
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

  const insertReferencePath = (selectedPath: string, kind: "file" | "folder" | "image") => {
    const textarea = composerTextareaRef.current;
    const normalizedPath = normalizePathForReference(selectedPath);
    const referenceToken = formatPathReference(normalizedPath);
    const caret = textarea?.selectionStart ?? inputCaret;
    const leadingSpacer = caret > 0 && !/\s/.test(input[caret - 1] ?? "") ? " " : "";
    const trailingSpacer = input.length > caret && !/\s/.test(input[caret] ?? "") ? " " : "";
    const insertion = `${leadingSpacer}${referenceToken}${trailingSpacer}`;
    const nextInput = `${input.slice(0, caret)}${insertion}${input.slice(caret)}`;
    const nextCaret = caret + insertion.length;

    setInput(nextInput);
    setInputCaret(nextCaret);
    setFeedback("");
    setPathReferences((current) => {
      if (current.some((entry) => entry.path === normalizedPath)) {
        return current;
      }
      return [...current, { path: normalizedPath, kind }];
    });

    window.requestAnimationFrame(() => {
      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const pickAndInsertPath = async (kind: "file" | "folder" | "image") => {
    if (!withmateApi) {
      return;
    }

    const initialPath = pickerBaseDirectory || null;
    const selectedPath = kind === "folder"
      ? await withmateApi.pickDirectory(initialPath)
      : kind === "image"
        ? await withmateApi.pickImageFile(initialPath)
        : await withmateApi.pickFile(initialPath);
    if (!selectedPath) {
      return;
    }

    setPickerBaseDirectory(kind === "folder" ? selectedPath : toDirectoryPath(selectedPath));
    insertReferencePath(selectedPath, kind);
  };

  const removePathReference = (targets: string[]) => {
    const normalizedTargets = new Set(targets.map((target) => normalizePathForReference(target)));
    const escapedTokens = Array.from(normalizedTargets)
      .map((target) => formatPathReference(target))
      .map((target) => target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    let nextInput = input;
    for (const escapedToken of escapedTokens) {
      nextInput = nextInput.replace(
        new RegExp(`(^|[\\s(])${escapedToken}(?=\\s|$|[),.;:!?])`),
        (_match, leadingWhitespace: string) => leadingWhitespace || "",
      );
    }

    nextInput = nextInput
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n");
    setInput(nextInput);
    setInputCaret(nextInput.length);
    setPathReferences((current) => current.filter((entry) => !normalizedTargets.has(entry.path)));
  };

  const addAdditionalDirectory = async () => {
    if (!withmateApi || sending) {
      return;
    }

    const selectedPath = await withmateApi.pickDirectory(pickerBaseDirectory || null);
    if (!selectedPath) {
      return;
    }

    const normalizedPath = normalizePathForReference(selectedPath);
    setPickerBaseDirectory(selectedPath);
    setAdditionalDirectories((current) => Array.from(new Set([...current, normalizedPath])));
    setIsAdditionalDirectoryListOpen(true);
  };

  const pathReferenceItems = useMemo(
    () =>
      pathReferences.map((entry) => {
        const { basename, parentPath } = splitPathForDisplay(entry.path);
        const kindLabel = entry.kind === "folder" ? "フォルダ" : entry.kind === "image" ? "画像" : "ファイル";
        return {
          key: `${entry.kind}:${entry.path}`,
          kind: entry.kind,
          kindLabel,
          locationLabel: "参照",
          primaryLabel: basename || entry.path,
          secondaryLabel: parentPath ? compactPathForDisplay(parentPath, 42) : "ルート",
          title: entry.path,
          removeTargets: [entry.path],
        };
      }),
    [pathReferences],
  );
  const additionalDirectoryItems = useMemo(
    () =>
      additionalDirectories.map((directoryPath) => {
        const directoryDisplay = buildAdditionalDirectoryDisplay(directoryPath);
        return {
          key: directoryPath,
          path: directoryPath,
          primaryLabel: directoryDisplay.primaryLabel,
          secondaryLabel: directoryDisplay.secondaryLabel,
          title: directoryDisplay.title,
          canRemove: true,
        };
      }),
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
    setInput("");
    setInputCaret(0);
    setPathReferences([]);

    try {
      if (!withmateApi) {
        throw new Error("Mate API が利用できないよ。");
      }
      const result = await withmateApi.runMateTalkTurn({
        message: normalizedText,
        provider: providerId,
        model,
        reasoningEffort,
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
    onPickFile: () => void pickAndInsertPath("file"),
    onPickFolder: () => void pickAndInsertPath("folder"),
    onPickImage: () => void pickAndInsertPath("image"),
    onAddAdditionalDirectory: () => void addAdditionalDirectory(),
    onToggleAdditionalDirectoryList: () => setIsAdditionalDirectoryListOpen((current) => !current),
    onRemoveAttachment: removePathReference,
    onRemoveAdditionalDirectory: (directoryPath: string) => {
      setAdditionalDirectories((current) => current.filter((entry) => entry !== directoryPath));
    },
    onDraftFocus: () => {},
    onDraftSelect: (selectionStart: number) => setInputCaret(selectionStart),
    onChangeApprovalMode: (value: ApprovalMode) => setSelectedApprovalMode(normalizeApprovalMode(value)),
    onChangeCodexSandboxMode: (value: CodexSandboxMode) =>
      setSelectedCodexSandboxMode(normalizeCodexSandboxMode(value)),
    onChangeModel: handleChangeModel,
    onChangeReasoningEffort: handleChangeReasoningEffort,
    onSubmit: () => void handleSubmit(),
    onToggleHeaderExpanded: () => setIsHeaderExpanded((current) => !current),
    sending,
  };
}
