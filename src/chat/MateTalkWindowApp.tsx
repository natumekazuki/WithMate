import { useEffect, useMemo, useRef, useState } from "react";

import {
  createDefaultAppSettings,
  type AppSettings,
} from "../provider-settings-state.js";
import { getWithMateApi, isDesktopRuntime } from "../renderer-withmate-api.js";
import type { ModelCatalogSnapshot, ModelReasoningEffort } from "../model-catalog.js";
import type { MateProfile, MateStorageState } from "../mate/mate-state.js";
import { buildCharacterThemeStyle } from "../theme-utils.js";
import { modelDisplayLabel } from "../ui-utils.js";
import { ChatWindow } from "./chat-window.js";
import { buildMateTalkChatWindowProps, type MateTalkMessage } from "./mate-talk-chat-projection.js";
import {
  buildMateTalkModelSelection,
  isMateTalkReasoningEffortAllowed,
  resolveMateTalkModelChange,
} from "./mate-talk-model-selection.js";
import { MateTalkTurnController } from "./mate-talk-state.js";

function MateTalkStatusScreen({ message }: { message: string }) {
  return (
    <main className="page-shell session-page">
      <div className="session-plain">
        <p>{message}</p>
      </div>
    </main>
  );
}

export function MateTalkWindowApp() {
  const desktopRuntime = isDesktopRuntime();
  const withmateApi = getWithMateApi();
  const [appSettings, setAppSettings] = useState<AppSettings>(() => createDefaultAppSettings());
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [mateState, setMateState] = useState<MateStorageState | null>(null);
  const [mateProfile, setMateProfile] = useState<MateProfile | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<MateTalkMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [isHeaderExpanded, setIsHeaderExpanded] = useState(true);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ModelReasoningEffort>("low");
  const turnControllerRef = useRef(new MateTalkTurnController());
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

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

  if (!desktopRuntime) {
    return <MateTalkStatusScreen message="メイトークはデスクトップ版で利用できます。" />;
  }
  if (mateState === null) {
    return <MateTalkStatusScreen message="メイトークを準備しています。" />;
  }
  if (mateState === "not_created" || !mateProfile) {
    return <MateTalkStatusScreen message="Mate を作成してからメイトークを開いてね。" />;
  }

  return (
    <ChatWindow
      {...buildMateTalkChatWindowProps({
        mateName: mateProfile.displayName,
        themeStyle,
        isHeaderExpanded,
        messages,
        input,
        feedback,
        modelOptions,
        selectedModel: model,
        selectedModelFallbackLabel: modelDisplayLabel(providerCatalog, model),
        reasoningOptions,
        selectedReasoningEffort: reasoningEffort,
        messageListRef,
        composerTextareaRef,
        onChangeInput: (value) => {
          setInput(value);
          setFeedback("");
        },
        onChangeModel: (nextModel) => {
          const nextSelection = resolveMateTalkModelChange({
            providerCatalog,
            model: nextModel,
            reasoningEffort,
          });
          setModel(nextSelection.model);
          setReasoningEffort(nextSelection.reasoningEffort);
        },
        onChangeReasoningEffort: (nextReasoningEffort) => {
          if (isMateTalkReasoningEffortAllowed(selectedModel, nextReasoningEffort)) {
            setReasoningEffort(nextReasoningEffort);
          }
        },
        onSubmit: () => void handleSubmit(),
        onClose: () => window.close(),
        onToggleHeaderExpanded: () => setIsHeaderExpanded((current) => !current),
        sending,
      })}
    />
  );
}
