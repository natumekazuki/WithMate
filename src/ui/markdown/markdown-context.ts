import { createContext } from "react";
import type { MarkdownImageContext, MarkdownImageResolver } from "./image-resource-loader.js";

import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "../../../src-shared/window/markdown-link-context-menu.js";

export type MessageCopyFeedback = {
  message: string;
  tone: "error" | "success";
};

export type MarkdownRenderContextValue = {
  isStreaming?: boolean;
  markdown: string;
  onCodeBlockCopyResult?: (feedback: MessageCopyFeedback) => void;
  onLinkContextMenuResult?: (result: MarkdownLinkContextMenuResult) => void;
  linkFileContext?: MarkdownLinkContextMenuRequest["fileContext"];
  imageContext?: MarkdownImageContext;
  onOpenPath?: (target: string) => void;
  onCopyText?: (text: string) => void;
  onQuoteText?: (text: string) => void;
  onFind?: () => void;
  resolveImageSource?: MarkdownImageResolver;
};

export const MarkdownRenderContext = createContext<MarkdownRenderContextValue>({
  markdown: "",
});
