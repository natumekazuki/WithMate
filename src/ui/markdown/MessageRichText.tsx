import { Fragment, createContext, memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
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
import { rehypeSourceRanges, remarkReferenceSourceRanges } from "./markdown-source-ranges.js";

export type MessageViewMode = "preview" | "source";

export type MessageInlineContent = { key: string; position: number; content: ReactNode; stableOwner?: boolean };

function inlineContentList(value: MessageInlineContent | readonly MessageInlineContent[] | undefined): readonly MessageInlineContent[] {
  return value ? Array.isArray(value) ? value : [value as MessageInlineContent] : [];
}

const InlineContentContext = createContext<readonly MessageInlineContent[]>([]);
const InlineContent: NonNullable<Components["div"]> = function InlineContent({ node, className, ...props }) {
  const contents = useContext(InlineContentContext);
  const match = className?.match(/(?:^|\s)message-inline-content-(\d+)(?:\s|$)/);
  const content = match ? contents[Number(match[1])] : undefined;
  return node && match
    ? <div className="message-inline-content" key={content?.key}>{content?.content}</div>
    : <div className={className} {...props} />;
};
const inlineMarkdownComponents = {
  ...markdownComponents,
  div: InlineContent,
  "withmate-stable-inline": InlineContent,
} as Components;

type MessageRichTextProps = {
  text: string;
  embeddedMedia?: "allow" | "text";
  sourceStart?: number;
  inlineContent?: MessageInlineContent | readonly MessageInlineContent[];
  selectedRanges?: Array<{ start: number; end: number }>;
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

function createInlineContentPlugin(contents: readonly MessageInlineContent[]): Plugin<[], Root> {
  return () => (tree) => {
    const original = tree.children.slice();
    const insertions = contents.map((content, contentIndex) => {
      let index = 0;
      for (const node of original) {
        if ((node.position?.start.offset ?? 0) >= content.position) break;
        index += 1;
        if ((node.position?.end.offset ?? 0) >= content.position) break;
      }
      return { index, contentIndex };
    }).sort((a, b) => b.index - a.index || b.contentIndex - a.contentIndex);
    for (const { index, contentIndex } of insertions) tree.children.splice(index, 0, {
      type: "paragraph", children: [],
      // Give stateful content a separate ReactMarkdown sibling key from ordinary cards.
      data: { hName: contents[contentIndex].stableOwner ? "withmate-stable-inline" : "div", hProperties: { className: ["message-inline-content", `message-inline-content-${contentIndex}`] } },
    });
  };
}

function createQuestionSelectionPlugin(ranges: Array<{ start: number; end: number }>): Plugin<[], Root> {
  return () => (tree) => {
    for (const node of tree.children) {
      const blocks = node.type === "list" ? node.children : [node];
      for (const block of blocks) {
        if (!ranges.some((range) => range.start === block.position?.start.offset && range.end === block.position?.end.offset)) continue;
        const paragraph = block.type === "listItem" ? block.children.find((child) => child.type === "paragraph") : block.type === "paragraph" ? block : undefined;
        if (!paragraph || paragraph.type !== "paragraph") continue;
        paragraph.children.unshift({ type: "text", value: "✓ " });
        const data = block.data ?? (block.data = {});
        const properties = data.hProperties ?? (data.hProperties = {});
        const classes = properties.className;
        properties.className = [...(Array.isArray(classes) ? classes : typeof classes === "string" ? [classes] : []), "elicitation-record-selected"];
      }
    }
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
  embeddedMedia = "allow",
  sourceStart,
  inlineContent,
  selectedRanges,
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
      rehypeSourceRanges,
      katexProjection,
      createFootnoteLabelIdPlugin(footnoteLabelId),
      ...(glossaryAnnotations.rehypePlugin
        ? [glossaryAnnotations.rehypePlugin]
        : []),
    ],
    [footnoteLabelId, glossaryAnnotations.rehypePlugin, katexProjection],
  );
  const inlineContents = inlineContentList(inlineContent);
  const inlinePositions = JSON.stringify(inlineContents.map(({ position, stableOwner }) => [position, Boolean(stableOwner)]));
  const remarkPlugins = useMemo<PluggableList>(
    () => [
      remarkFrontmatter,
      remarkGfm,
      [remarkMath, { singleDollarTextMath: false }],
      [remarkProviderResponse, responseProvider],
      parseProjection,
      sharedRemarkHtmlLineBreaks,
      remarkReferenceSourceRanges,
      ...(selectedRanges?.length ? [createQuestionSelectionPlugin(selectedRanges)] : []),
      ...(inlineContents.length ? [createInlineContentPlugin(inlineContents)] : []),
    ],
    [responseProvider, parseProjection, inlinePositions, selectedRanges],
  );
  const markdownContent = useMemo(() => (
    <ReactMarkdown
      components={embeddedMedia === "text" ? {
        ...inlineMarkdownComponents,
        img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
        pre: ({ children }) => <pre>{children}</pre>,
      } : inlineMarkdownComponents}
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
  ), [embeddedMedia, footnotePrefix, rehypePlugins, remarkPlugins, renderText]);

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
          <InlineContentContext.Provider value={inlineContents}>
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
    const sourceContent = (start: number, end: number) => {
      const pieces: ReactNode[] = [];
      let offset = start;
      for (const range of [...props.selectedRanges ?? []].sort((a, b) => a.start - b.start)) {
        const rangeStart = Math.max(range.start, start, offset);
        const rangeEnd = Math.min(range.end, end);
        if (rangeEnd <= rangeStart) continue;
        pieces.push(props.text.slice(offset, rangeStart));
        pieces.push(<span className="elicitation-record-selected" key={`${range.start}:${range.end}`}>{rangeStart === range.start ? "✓ " : ""}{props.text.slice(rangeStart, rangeEnd)}</span>);
        offset = rangeEnd;
      }
      pieces.push(props.text.slice(offset, end));
      return pieces;
    };
    const contents = inlineContentList(props.inlineContent).slice().sort((a, b) => a.position - b.position);
    if (contents.length) {
      let offset = 0;
      const fragments = contents.map((content) => {
        const position = Math.max(offset, Math.min(content.position, props.text.length));
        const fragment = <Fragment key={content.key}>{position > offset ? <pre className={`${className} rich-text message-source-text`.trim()} data-source-start={(props.sourceStart ?? 0) + offset}>{sourceContent(offset, position)}</pre> : null}{content.content}</Fragment>;
        offset = position;
        return fragment;
      });
      return <>{fragments}{offset < props.text.length ? <pre className={`${className} rich-text message-source-text`.trim()} data-source-start={(props.sourceStart ?? 0) + offset}>{sourceContent(offset, props.text.length)}</pre> : null}</>;
    }
    return (
      <pre className={`${className} rich-text message-source-text`.trim()} data-source-start={props.sourceStart}>
        {sourceContent(0, props.text.length)}
      </pre>
    );
  }

  return <MessageMarkdownPreview {...props} />;
}

export const MessageRichText = memo(MessageRichTextComponent);
