import { useRef, type CSSProperties } from "react";

import { ChatWindow, type ChatSelectOption } from "./chat-window.js";
import { buildMateTalkChatWindowProps, type MateTalkMessage } from "./mate-talk-chat-projection.js";

export type MateTalkChatWindowProps = {
  mateName: string;
  themeStyle?: CSSProperties;
  isHeaderExpanded: boolean;
  messages: MateTalkMessage[];
  input: string;
  modelOptions: ChatSelectOption[];
  selectedModel: string;
  selectedModelFallbackLabel: string;
  reasoningOptions: ChatSelectOption[];
  selectedReasoningEffort: string;
  onChangeInput: (value: string) => void;
  onChangeModel: (model: string) => void;
  onChangeReasoningEffort: (reasoningEffort: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  onToggleHeaderExpanded: () => void;
  sending?: boolean;
  feedback: string;
};

export function MateTalkChatWindow({
  mateName,
  themeStyle,
  isHeaderExpanded,
  messages,
  input,
  modelOptions,
  selectedModel,
  selectedModelFallbackLabel,
  reasoningOptions,
  selectedReasoningEffort,
  onChangeInput,
  onChangeModel,
  onChangeReasoningEffort,
  onSubmit,
  onClose,
  onToggleHeaderExpanded,
  sending = false,
  feedback,
}: MateTalkChatWindowProps) {
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  return (
    <ChatWindow
      {...buildMateTalkChatWindowProps({
        mateName,
        themeStyle,
        isHeaderExpanded,
        messages,
        input,
        modelOptions,
        selectedModel,
        selectedModelFallbackLabel,
        reasoningOptions,
        selectedReasoningEffort,
        messageListRef,
        composerTextareaRef,
        onChangeInput,
        onChangeModel,
        onChangeReasoningEffort,
        onSubmit,
        onClose,
        onToggleHeaderExpanded,
        sending,
        feedback,
      })}
    />
  );
}
