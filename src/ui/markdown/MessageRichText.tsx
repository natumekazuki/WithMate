import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";

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
import type { MarkdownImageResolver } from "./image-resource-loader.js";
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

type MessageRichTextProps = {
  text: string;
  sourceStart?: number;
  className?: string;
  forceFullRender?: boolean;
  isStreaming?: boolean;
  displayMode?: MessageViewMode;
  onOpenPath?: (target: string) => void;
  resolveImageSource?: MarkdownImageResolver;
  markdownLinkFileContext?: MarkdownLinkContextMenuRequest["fileContext"];
  glossaryAnnotationMatcher?: GlossaryAnnotationMatcher;
  glossaryAnnotationScopeKey?: string;
  onActivateGlossaryEntry?: (canonicalTerm: string) => void;
};

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
  className = "message-body",
  forceFullRender = false,
  isStreaming = false,
  onOpenPath,
  resolveImageSource,
  markdownLinkFileContext,
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
  const renderText = useStreamingMarkdownText(text, isStreaming, forceFullRender);
  const [copyFeedback, setCopyFeedback] = useState<MessageCopyFeedback | null>(
    null,
  );
  const glossaryAnnotations = useMessageGlossaryAnnotations({
    matcher: glossaryAnnotationMatcher,
    scopeKey: glossaryAnnotationScopeKey,
    text: renderText,
    onActivate: onActivateGlossaryEntry,
  });
  const parseProjection = useMemo(() => createMarkdownParseProjectionPlugin(), []);
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
      onOpenPath,
      resolveImageSource,
    }),
    [
      handleCodeBlockCopyResult,
      handleLinkContextMenuResult,
      isStreaming,
      markdownLinkFileContext,
      onOpenPath,
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
      parseProjection,
      sharedRemarkHtmlLineBreaks,
    ],
    [parseProjection],
  );
  const markdownContent = useMemo(() => (
    <ReactMarkdown
      components={markdownComponents}
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
          {markdownContent}
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
    return (
      <pre className={`${className} rich-text message-source-text`.trim()} data-source-start={props.sourceStart}>
        {props.text}
      </pre>
    );
  }

  return <MessageMarkdownPreview {...props} />;
}

export const MessageRichText = memo(MessageRichTextComponent);
