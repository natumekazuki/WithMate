import { useEffect, useMemo, useRef, useState } from "react";

import { buildHomeLaunchProjection } from "../home/home-launch-projection.js";
import {
  createDefaultAppSettings,
  type AppSettings,
} from "../provider-settings-state.js";
import { getWithMateApi, isDesktopRuntime } from "../renderer-withmate-api.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot, ModelReasoningEffort } from "../model-catalog.js";
import type { MateProfile, MateStorageState } from "../mate/mate-state.js";
import { buildCharacterThemeStyle } from "../theme-utils.js";
import { modelDisplayLabel, modelOptionLabel } from "../ui-utils.js";
import { ChatWindow } from "./chat-window.js";
import { buildMateTalkChatWindowProps, type MateTalkMessage } from "./mate-talk-chat-projection.js";
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

  const enabledProviders = useMemo(() => buildHomeLaunchProjection({
    launchProviderId: providerId,
    launchTitle: "メイトーク",
    launchWorkspace: null,
    appSettings,
    modelCatalog,
  }).enabledLaunchProviders, [appSettings, modelCatalog, providerId]);

  const defaultPriority = appSettings.mateMemoryGenerationSettings.priorityList[0] ?? null;
  const providerCatalog = useMemo<ModelCatalogProvider | null>(() => {
    return enabledProviders.find((provider) => provider.id === providerId) ?? enabledProviders[0] ?? null;
  }, [enabledProviders, providerId]);
  const selectedModel =
    providerCatalog?.models.find((candidate) => candidate.id === model) ??
    providerCatalog?.models.find((candidate) => candidate.id === providerCatalog.defaultModelId) ??
    providerCatalog?.models[0] ??
    null;
  const modelOptions = useMemo(
    () => providerCatalog?.models.map((candidate) => ({ value: candidate.id, label: modelOptionLabel(candidate) })) ?? [],
    [providerCatalog],
  );
  const reasoningOptions = useMemo(
    () => selectedModel?.reasoningEfforts.map((effort) => ({ value: effort, label: effort })) ?? [],
    [selectedModel],
  );
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
    const preferredProviderId =
      enabledProviders.find((provider) => provider.id === defaultPriority?.provider)?.id ??
      enabledProviders[0]?.id ??
      "";
    const nextProviderCatalog = enabledProviders.find((provider) => provider.id === (providerId || preferredProviderId)) ??
      enabledProviders[0] ??
      null;
    const nextProviderId = nextProviderCatalog?.id ?? "";
    const preferredModelId = nextProviderId === defaultPriority?.provider ? defaultPriority.model : "";
    const nextModel =
      nextProviderCatalog?.models.find((candidate) => candidate.id === model) ??
      nextProviderCatalog?.models.find((candidate) => candidate.id === preferredModelId) ??
      nextProviderCatalog?.models.find((candidate) => candidate.id === nextProviderCatalog.defaultModelId) ??
      nextProviderCatalog?.models[0] ??
      null;
    const nextReasoningEffort =
      nextProviderId === defaultPriority?.provider && nextModel?.reasoningEfforts.includes(defaultPriority.reasoningEffort)
        ? defaultPriority.reasoningEffort
        : nextProviderCatalog?.defaultReasoningEffort ??
          (nextModel?.reasoningEfforts.includes(reasoningEffort) ? reasoningEffort : nextModel?.reasoningEfforts[0] ?? "low");

    if (providerId !== nextProviderId) {
      setProviderId(nextProviderId);
    }
    if (model !== (nextModel?.id ?? "")) {
      setModel(nextModel?.id ?? "");
    }
    if (reasoningEffort !== nextReasoningEffort) {
      setReasoningEffort(nextReasoningEffort);
    }
  }, [defaultPriority, enabledProviders, model, providerId, reasoningEffort]);

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
          const nextModelCatalog = providerCatalog?.models.find((candidate) => candidate.id === nextModel) ?? null;
          setModel(nextModel);
          setReasoningEffort((current) =>
            nextModelCatalog?.reasoningEfforts.includes(current)
              ? current
              : nextModelCatalog?.reasoningEfforts[0] ?? providerCatalog?.defaultReasoningEffort ?? current,
          );
        },
        onChangeReasoningEffort: (nextReasoningEffort) => {
          if (selectedModel?.reasoningEfforts.includes(nextReasoningEffort as ModelReasoningEffort)) {
            setReasoningEffort(nextReasoningEffort as ModelReasoningEffort);
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
