import { createContext } from "react";
import type {
  MarkdownImageContext,
  MarkdownImageResolver,
} from "./image-resource-loader.js";

import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "../../../src-shared/window/markdown-link-context-menu.js";

/** コピー操作の結果を通知する本文と、成否に応じた表示種別。 */
export type MessageCopyFeedback = {
  message: string;
  tone: "error" | "success";
};

/** Markdown 本文と、その描画に許可されたリンク・画像・コピー・引用操作を子要素へ渡す。 */
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

/** 描画要素で共有する操作の提供口。提供元がなければ空の本文だけを持つ。 */
export const MarkdownRenderContext = createContext<MarkdownRenderContextValue>({
  markdown: "",
});
