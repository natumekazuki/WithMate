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
        mateAvatarFilePath: state.mateProfile.avatarFilePath,
        themeStyle: state.themeStyle,
        isHeaderExpanded: state.isHeaderExpanded,
        isActionDockExpanded: state.isActionDockExpanded,
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
        onToggleHeaderExpanded: state.onToggleHeaderExpanded,
        onOpenSessionFilesExplorer: state.onOpenSessionFilesExplorer,
        onOpenSessionFilesTerminal: state.onOpenSessionFilesTerminal,
        onCollapseActionDock: state.onCollapseActionDock,
        onExpandActionDock: state.onExpandActionDock,
        sending: state.sending,
        composerCapabilityProps: {
          showAttachmentControls: true,
          showAdditionalDirectoryControls: true,
          showExecutionModeControls: true,
          showCustomAgentPicker: false,
          showSkillPicker: false,
          isAdditionalDirectoryListOpen: state.isAdditionalDirectoryListOpen,
          additionalDirectoryCount: state.additionalDirectoryCount,
          attachmentItems: state.attachmentItems,
          additionalDirectoryItems: state.additionalDirectoryItems,
          approvalOptions: state.approvalOptions,
          selectedApprovalMode: state.selectedApprovalMode,
          sandboxOptions: state.sandboxOptions,
          selectedCodexSandboxMode: state.selectedCodexSandboxMode,
          onPickFile: state.onPickFile,
          onPickFolder: state.onPickFolder,
          onPickImage: state.onPickImage,
          onAddToSessionFiles: state.onAddToSessionFiles,
          onPickSessionFiles: state.onPickSessionFiles,
          onAddAdditionalDirectory: state.onAddAdditionalDirectory,
          onToggleAdditionalDirectoryList: state.onToggleAdditionalDirectoryList,
          onRemoveAttachment: state.onRemoveAttachment,
          onRemoveAdditionalDirectory: state.onRemoveAdditionalDirectory,
          onDraftFocus: state.onDraftFocus,
          onDraftPaste: state.onDraftPaste,
          onDraftSelect: state.onDraftSelect,
          onChangeApprovalMode: state.onChangeApprovalMode,
          onChangeCodexSandboxMode: state.onChangeCodexSandboxMode,
        },
      })}
    />
  );
}
