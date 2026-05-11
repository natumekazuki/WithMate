import { getWithMateApi, isDesktopRuntime } from "../renderer-withmate-api.js";
import { modelDisplayLabel } from "../ui-utils.js";
import { ChatWindow } from "./chat-window.js";
import { buildMateTalkChatWindowProps } from "./mate-talk-chat-projection.js";
import { useMateTalkWindowState } from "./use-mate-talk-window-state.js";

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
  const withmateApi = getWithMateApi();
  const desktopRuntime = isDesktopRuntime();
  const state = useMateTalkWindowState({ withmateApi });

  if (!desktopRuntime) {
    return <MateTalkStatusScreen message="メイトークはデスクトップ版で利用できます。" />;
  }
  if (state.mateState === null) {
    return <MateTalkStatusScreen message="メイトークを準備しています。" />;
  }
  if (state.mateState === "not_created" || !state.mateProfile) {
    return <MateTalkStatusScreen message="Mate を作成してからメイトークを開いてね。" />;
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
        onClose: () => window.close(),
        onToggleHeaderExpanded: state.onToggleHeaderExpanded,
        sending: state.sending,
      })}
    />
  );
}
