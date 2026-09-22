import { createContext } from "react";

import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "../../../src-shared/window/markdown-link-context-menu.js";

export type MessageCopyFeedback = {
  message: string;
  tone: "error" | "success";
};

export type MarkdownRenderContextValue = {
  enableMermaid: boolean;
  markdown: string;
  onCodeBlockCopyResult?: (feedback: MessageCopyFeedback) => void;
  onLinkContextMenuResult?: (result: MarkdownLinkContextMenuResult) => void;
  linkFileContext?: MarkdownLinkContextMenuRequest["fileContext"];
  onOpenPath?: (target: string) => void;
  resolveImageSource?: (target: string) => Promise<string | null>;
};

export const MarkdownRenderContext = createContext<MarkdownRenderContextValue>({
  enableMermaid: true,
  markdown: "",
});
