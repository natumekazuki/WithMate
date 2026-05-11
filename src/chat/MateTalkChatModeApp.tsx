import { getWithMateApi, isDesktopRuntime } from "../renderer-withmate-api.js";
import { modelDisplayLabel } from "../ui-utils.js";
import { ChatWindow, ChatWindowStatusScreen } from "./chat-window.js";
import { buildMateTalkChatWindowProps } from "./mate-talk-chat-projection.js";
import { useMateTalkWindowState } from "./use-mate-talk-window-state.js";

export function MateTalkChatModeApp() {
  const withmateApi = getWithMateApi();
  const state = useMateTalkWindowState({ withmateApi });

  if (!isDesktopRuntime() || !withmateApi) {
    return <ChatWindowStatusScreen message="メイトークはデスクトップ版で利用できます。" />;
  }
  if (state.mateState === null) {
    return <ChatWindowStatusScreen message="メイトークを準備しています。" />;
  }
  if (state.mateState === "not_created" || !state.mateProfile) {
    return <ChatWindowStatusScreen message="Mate を作成してからメイトークを開いてね。" />;
  }

  return (
    <ChatWindow
      {...buildMateTalkChatWindowProps({
        mateName: state.mateProfile.displayName,
        themeStyle: state.themeStyle,
        isHeaderExpanded: state.isHeaderExpanded,
        messages: state.messages,
        input: state.input,
        feedback: state.feedback,
        modelOptions: state.modelOptions,
        selectedModel: state.selectedModel?.id ?? "",
        selectedModelFallbackLabel: modelDisplayLabel(state.providerCatalog, state.selectedModel?.id ?? ""),
        reasoningOptions: state.reasoningOptions,
        selectedReasoningEffort: state.selectedReasoningEffort,
        messageListRef: state.messageListRef,
        composerTextareaRef: state.composerTextareaRef,
        onChangeInput: state.onChangeInput,
        onChangeModel: state.onChangeModel,
        onChangeReasoningEffort: state.onChangeReasoningEffort,
        onSubmit: state.onSubmit,
        onOpenHome: () => {
          void withmateApi.openHomeWindow().finally(() => window.close());
        },
        onToggleHeaderExpanded: state.onToggleHeaderExpanded,
        sending: state.sending,
      })}
    />
  );
}
