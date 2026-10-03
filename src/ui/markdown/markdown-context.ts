import { createContext } from "react";
import type { MarkdownImageResolver } from "./image-resource-loader.js";

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
  resolveImageSource?: MarkdownImageResolver;
};

export const MarkdownRenderContext = createContext<MarkdownRenderContextValue>({
  enableMermaid: true,
  markdown: "",
});
