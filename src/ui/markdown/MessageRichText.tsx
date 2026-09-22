import { memo, useCallback, useEffect, useId, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
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
import {
  markdownComponents,
  renderMarkdownFrontmatter,
} from "./markdown-components.js";
import {
  createFootnoteLabelIdPlugin,
  remarkHtmlLineBreaks as sharedRemarkHtmlLineBreaks,
} from "./markdown-plugins.js";

export type MessageViewMode = "preview" | "source";

type MessageRichTextProps = {
  text: string;
  className?: string;
  forceFullRender?: boolean;
  displayMode?: MessageViewMode;
  onOpenPath?: (target: string) => void;
  resolveImageSource?: (target: string) => Promise<string | null>;
  markdownLinkFileContext?: MarkdownLinkContextMenuRequest["fileContext"];
  glossaryAnnotationMatcher?: GlossaryAnnotationMatcher;
  glossaryAnnotationScopeKey?: string;
  onActivateGlossaryEntry?: (canonicalTerm: string) => void;
};

type MarkdownRenderMode = "light" | "full";

export function resolveMessageMarkdownRenderMode(
  forceFullRender: boolean,
  text: string,
  renderState: { text: string; mode: MarkdownRenderMode },
  shouldDefer: boolean,
): MarkdownRenderMode {
  if (forceFullRender) {
    return "full";
  }
  if (renderState.text === text) {
    return renderState.mode;
  }
  return shouldDefer ? "light" : "full";
}

type MermaidRenderState =
  | { status: "pending" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };

function shouldDeferRichMarkdownRender(): boolean {
  return typeof window !== "undefined";
}

function scheduleFullMarkdownRender(callback: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const browserWindow = window as Window & {
    requestIdleCallback?: (
      callback: IdleRequestCallback,
      options?: IdleRequestOptions,
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  let canceled = false;
  let frameId: number | null = null;
  let idleId: number | null = null;
  const run = () => {
    if (!canceled) {
      callback();
    }
  };

  if (typeof browserWindow.requestIdleCallback === "function") {
    idleId = browserWindow.requestIdleCallback(run, { timeout: 500 });
  } else {
    frameId = browserWindow.requestAnimationFrame(() => {
      frameId = browserWindow.requestAnimationFrame(run);
    });
  }

  return () => {
    canceled = true;
    if (
      idleId !== null &&
      typeof browserWindow.cancelIdleCallback === "function"
    ) {
      browserWindow.cancelIdleCallback(idleId);
    }
    if (frameId !== null) {
      browserWindow.cancelAnimationFrame(frameId);
    }
  };
}

function MessageMarkdownPreview({
  text,
  className = "message-body",
  forceFullRender = false,
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
  const shouldDefer = !forceFullRender && shouldDeferRichMarkdownRender();
  const [copyFeedback, setCopyFeedback] = useState<MessageCopyFeedback | null>(
    null,
  );
  const glossaryAnnotations = useMessageGlossaryAnnotations({
    matcher: glossaryAnnotationMatcher,
    scopeKey: glossaryAnnotationScopeKey,
    text,
    onActivate: onActivateGlossaryEntry,
  });
  const [renderState, setRenderState] = useState<{
    text: string;
    mode: MarkdownRenderMode;
  }>(() => ({
    text,
    mode: shouldDefer ? "light" : "full",
  }));
  const renderMode = resolveMessageMarkdownRenderMode(
    forceFullRender,
    text,
    renderState,
    shouldDefer,
  );
  const isFullRender = renderMode === "full";
  const handleLinkContextMenuResult = useCallback(
    (result: MarkdownLinkContextMenuResult) => {
      setCopyFeedback(
        result.status === "link-copied"
          ? { message: "リンクをコピーしました。", tone: "success" }
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
      enableMermaid: isFullRender,
      markdown: text,
      onCodeBlockCopyResult: handleCodeBlockCopyResult,
      onLinkContextMenuResult: handleLinkContextMenuResult,
      linkFileContext: markdownLinkFileContext,
      onOpenPath,
      resolveImageSource,
    }),
    [
      handleCodeBlockCopyResult,
      handleLinkContextMenuResult,
      isFullRender,
      markdownLinkFileContext,
      onOpenPath,
      resolveImageSource,
      text,
    ],
  );
  const rehypePlugins = useMemo<PluggableList>(
    () => [
      ...(isFullRender
        ? [rehypeKatex, createFootnoteLabelIdPlugin(footnoteLabelId)]
        : []),
      ...(glossaryAnnotations.rehypePlugin
        ? [glossaryAnnotations.rehypePlugin]
        : []),
    ],
    [footnoteLabelId, glossaryAnnotations.rehypePlugin, isFullRender],
  );
  const remarkPlugins = useMemo<PluggableList>(
    () =>
      isFullRender
        ? [
            remarkFrontmatter,
            remarkGfm,
            [remarkMath, { singleDollarTextMath: false }],
            sharedRemarkHtmlLineBreaks,
          ]
        : [
            remarkFrontmatter,
            [remarkMath, { singleDollarTextMath: false }],
            sharedRemarkHtmlLineBreaks,
          ],
    [isFullRender],
  );

  useEffect(() => {
    if (!shouldDefer) {
      setRenderState({ text, mode: "full" });
      return;
    }

    setRenderState({ text, mode: "light" });
    return scheduleFullMarkdownRender(() => {
      setRenderState((current) =>
        current.text === text ? { text, mode: "full" } : current,
      );
    });
  }, [shouldDefer, text]);

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
      data-markdown-render-mode={renderMode}
    >
      <MessageGlossaryAnnotationProvider
        controller={glossaryAnnotations.controller}
      >
        <MarkdownRenderContext.Provider value={markdownRenderContext}>
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
            {text}
          </ReactMarkdown>
        </MarkdownRenderContext.Provider>
      </MessageGlossaryAnnotationProvider>
      {copyFeedback ? (
        <span
          className={`message-copy-toast message-link-copy-toast ${copyFeedback.tone}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {copyFeedback.message}
        </span>
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
      <pre className={`${className} rich-text message-source-text`.trim()}>
        {props.text}
      </pre>
    );
  }

  return <MessageMarkdownPreview {...props} />;
}

export const MessageRichText = memo(MessageRichTextComponent);
