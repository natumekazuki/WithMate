import { createContext, memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList, Plugin } from "unified";
import type { Root } from "mdast";
import { remarkProviderResponse } from "../../../src-shared/text/provider-response-markdown.js";

import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "../../../src-shared/window/markdown-link-context-menu.js";
import { getSessionFileObjectCopyFeedbackTone } from "../../../src-shared/file-explorer/session-file-object-copy-contract.js";
import type { GlossaryAnnotationMatcher } from "../../glossary/glossary-annotation-projection.js";
import {
  MessageGlossaryAnnotationProvider,
  useMessageGlossaryAnnotations,
} from "../../glossary/MessageGlossaryAnnotations.js";
import {
  MarkdownRenderContext,
  type MessageCopyFeedback,
} from "./markdown-context.js";
import { markdownUrlTransform } from "./markdown-links.js";
import type { MarkdownImageContext, MarkdownImageResolver } from "./image-resource-loader.js";
import {
  markdownComponents,
  renderMarkdownFrontmatter,
} from "./markdown-components.js";
import {
  createFootnoteLabelIdPlugin,
  remarkHtmlLineBreaks as sharedRemarkHtmlLineBreaks,
} from "./markdown-plugins.js";
import { createMarkdownParseProjectionPlugin } from "./markdown-parse-projection.js";
import { createKatexProjectionPlugin } from "./markdown-katex-projection.js";

export type MessageViewMode = "preview" | "source";

export type MessageInlineContent = { key: string; position: number; content: ReactNode };

const InlineContentContext = createContext<MessageInlineContent | undefined>(undefined);
const inlineMarkdownComponents: Components = {
  ...markdownComponents,
  div: function InlineContent({ node, className, ...props }) {
    const content = useContext(InlineContentContext);
    return node && className === "message-inline-content"
      ? <div className={className} key={content?.key}>{content?.content}</div>
      : <div className={className} {...props} />;
  },
};

type MessageRichTextProps = {
  text: string;
  sourceStart?: number;
  inlineContent?: MessageInlineContent;
  className?: string;
  forceFullRender?: boolean;
  isStreaming?: boolean;
  streamingTextPresented?: boolean;
  displayMode?: MessageViewMode;
  responseProvider?: string;
  onOpenPath?: (target: string) => void;
  onCopyText?: (text: string) => void;
  onQuoteText?: (text: string) => void;
  onFind?: () => void;
  resolveImageSource?: MarkdownImageResolver;
  markdownLinkFileContext?: MarkdownLinkContextMenuRequest["fileContext"];
  markdownImageContext?: MarkdownImageContext;
  glossaryAnnotationMatcher?: GlossaryAnnotationMatcher;
  glossaryAnnotationScopeKey?: string;
  onActivateGlossaryEntry?: (canonicalTerm: string) => void;
};

function createInlineContentPlugin(position: number): Plugin<[], Root> {
  return () => (tree) => {
    let index = 0;
    for (const node of tree.children) {
      if ((node.position?.start.offset ?? 0) >= position) break;
      index += 1;
      if ((node.position?.end.offset ?? 0) >= position) break;
    }
    // Insert at a block boundary without reparsing fragments or losing document references.
    tree.children.splice(index, 0, {
      type: "paragraph", children: [],
      data: { hName: "div", hProperties: { className: ["message-inline-content"] } },
    });
  };
}

function useStreamingMarkdownText(text: string, isStreaming: boolean, forceFullRender: boolean): string {
  const [snapshot, setSnapshot] = useState(text);
  const latestText = useRef(text);
  const timer = useRef<number | null>(null);
  const immediate = !isStreaming || forceFullRender || !text.startsWith(latestText.current) || typeof window === "undefined";

  useEffect(() => {
    latestText.current = text;
    if (immediate) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      if (snapshot !== text) setSnapshot(text);
    } else if (text !== snapshot && timer.current === null) {
      // Keep the current full rendering while continuous input advances the next snapshot.
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setSnapshot(latestText.current);
      }, 100);
    }
  }, [immediate, snapshot, text]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  return immediate ? text : snapshot;
}

function MessageMarkdownPreview({
  text,
  sourceStart,
  inlineContent,
  className = "message-body",
  forceFullRender = false,
  isStreaming = false,
  streamingTextPresented = false,
  responseProvider,
  onOpenPath,
  onCopyText,
  onQuoteText,
  onFind,
  resolveImageSource,
  markdownLinkFileContext,
  markdownImageContext,
  glossaryAnnotationMatcher,
  glossaryAnnotationScopeKey = "",
  onActivateGlossaryEntry,
}: MessageRichTextProps) {
  const reactId = useId();
  const footnotePrefix = useMemo(
    () => `message-footnote-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}-`,
    [reactId],
  );
  const footnoteLabelId = `${footnotePrefix}footnote-label`;
  const renderText = useStreamingMarkdownText(text, isStreaming, forceFullRender || streamingTextPresented);
  const [copyFeedback, setCopyFeedback] = useState<MessageCopyFeedback | null>(
    null,
  );
  const glossaryAnnotations = useMessageGlossaryAnnotations({
    matcher: glossaryAnnotationMatcher,
    scopeKey: glossaryAnnotationScopeKey,
    text: renderText,
    onActivate: onActivateGlossaryEntry,
  });
  const parseProjection = useMemo(() => createMarkdownParseProjectionPlugin(), [responseProvider]);
  const katexProjection = useMemo(() => createKatexProjectionPlugin(), []);
  const handleLinkContextMenuResult = useCallback(
    (result: MarkdownLinkContextMenuResult) => {
      setCopyFeedback(
        result.status === "link-copied"
          ? { message: "Link copied.", tone: "success" }
          : result.status === "file-copy"
            ? {
                message: result.result.message,
                tone: getSessionFileObjectCopyFeedbackTone(result.result),
              }
            : result.status === "failed"
              ? { message: result.message, tone: "error" }
              : null,
      );
    },
    [],
  );
  const handleCodeBlockCopyResult = useCallback(
    (feedback: MessageCopyFeedback) => {
      setCopyFeedback(feedback);
    },
    [],
  );
  const markdownRenderContext = useMemo<
    import("./markdown-context.js").MarkdownRenderContextValue
  >(
    () => ({
      isStreaming,
      markdown: renderText,
      onCodeBlockCopyResult: handleCodeBlockCopyResult,
      onLinkContextMenuResult: handleLinkContextMenuResult,
      linkFileContext: markdownLinkFileContext,
      imageContext: markdownImageContext,
      onOpenPath,
      onCopyText,
      onQuoteText,
      onFind,
      resolveImageSource,
    }),
    [
      handleCodeBlockCopyResult,
      handleLinkContextMenuResult,
      isStreaming,
      markdownLinkFileContext,
      markdownImageContext,
      onOpenPath,
      onCopyText,
      onQuoteText,
      onFind,
      resolveImageSource,
      renderText,
    ],
  );
  const rehypePlugins = useMemo<PluggableList>(
    () => [
      katexProjection,
      createFootnoteLabelIdPlugin(footnoteLabelId),
      ...(glossaryAnnotations.rehypePlugin
        ? [glossaryAnnotations.rehypePlugin]
        : []),
    ],
    [footnoteLabelId, glossaryAnnotations.rehypePlugin, katexProjection],
  );
  const remarkPlugins = useMemo<PluggableList>(
    () => [
      remarkFrontmatter,
      remarkGfm,
      [remarkMath, { singleDollarTextMath: false }],
      [remarkProviderResponse, responseProvider],
      parseProjection,
      sharedRemarkHtmlLineBreaks,
      ...(inlineContent ? [createInlineContentPlugin(inlineContent.position)] : []),
    ],
    [responseProvider, parseProjection, inlineContent?.position],
  );
  const markdownContent = useMemo(() => (
    <ReactMarkdown
      components={inlineMarkdownComponents}
      rehypePlugins={rehypePlugins}
      urlTransform={markdownUrlTransform}
      remarkPlugins={remarkPlugins}
      remarkRehypeOptions={{
        clobberPrefix: footnotePrefix,
        handlers: { yaml: renderMarkdownFrontmatter },
      }}
    >
      {renderText}
    </ReactMarkdown>
  ), [footnotePrefix, rehypePlugins, remarkPlugins, renderText]);

  useEffect(() => {
    if (!copyFeedback) {
      return;
    }
    const timeout = window.setTimeout(() => setCopyFeedback(null), 2_400);
    return () => window.clearTimeout(timeout);
  }, [copyFeedback]);

  return (
    <div
      className={`${className} rich-text`.trim()}
      data-markdown-render-mode="full"
      data-source-start={sourceStart}
    >
      <MessageGlossaryAnnotationProvider
        controller={glossaryAnnotations.controller}
      >
        <MarkdownRenderContext.Provider value={markdownRenderContext}>
          <InlineContentContext.Provider value={inlineContent}>
            {markdownContent}
          </InlineContentContext.Provider>
        </MarkdownRenderContext.Provider>
      </MessageGlossaryAnnotationProvider>
      {copyFeedback ? createPortal(
        <span
          className={`message-copy-toast message-link-copy-toast ${copyFeedback.tone}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {copyFeedback.message}
        </span>,
        document.body,
      ) : null}
    </div>
  );
}

function MessageRichTextComponent({
  displayMode = "preview",
  ...props
}: MessageRichTextProps) {
  if (displayMode === "source") {
    const className = props.className ?? "message-body";
    if (props.inlineContent) {
      const position = Math.max(0, Math.min(props.inlineContent.position, props.text.length));
      return <>
        {position > 0 ? <pre className={`${className} rich-text message-source-text`.trim()} data-source-start={props.sourceStart}>{props.text.slice(0, position)}</pre> : null}
        {props.inlineContent.content}
        {position < props.text.length ? <pre className={`${className} rich-text message-source-text`.trim()} data-source-start={(props.sourceStart ?? 0) + position}>{props.text.slice(position)}</pre> : null}
      </>;
    }
    return (
      <pre className={`${className} rich-text message-source-text`.trim()} data-source-start={props.sourceStart}>
        {props.text}
      </pre>
    );
  }

  return <MessageMarkdownPreview {...props} />;
}

export const MessageRichText = memo(MessageRichTextComponent);
