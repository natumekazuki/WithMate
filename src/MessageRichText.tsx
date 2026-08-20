import {
  Children,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Root } from "mdast";
import type { Node, Parent } from "unist";
import type { Plugin, PluggableList } from "unified";

import { getWithMateApi } from "./renderer-withmate-api.js";
import { toLocalFileUrl } from "./local-file-url.js";
import {
  formatMarkdownFrontmatterSource,
  resolveMarkdownFrontmatterDisplay,
} from "./markdown-frontmatter.js";
import { resolveOpenPathFeedback, showOpenPathFeedback } from "./open-path-result.js";
import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "./markdown-link-context-menu.js";

export type MessageViewMode = "preview" | "source";

type MessageRichTextProps = {
  text: string;
  className?: string;
  forceFullRender?: boolean;
  displayMode?: MessageViewMode;
  onOpenPath?: (target: string) => void;
  resolveImageSource?: (target: string) => Promise<string | null>;
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

type HastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: {
    start?: {
      offset?: number;
    };
  };
};

type MessageCopyFeedback = {
  message: string;
  tone: "error" | "success";
};

const htmlLineBreakPattern = /^<br[ \t]*\/?>$/i;

const remarkHtmlLineBreaks: Plugin<[], Root> = () => (tree) => {
  function visit(node: Node) {
    if (!("children" in node) || !Array.isArray(node.children)) {
      return;
    }

    const parent = node as Parent;
    for (let index = 0; index < parent.children.length; index += 1) {
      const child = parent.children[index];
      if (
        child.type === "html"
        && "value" in child
        && typeof child.value === "string"
        && htmlLineBreakPattern.test(child.value)
      ) {
        parent.children[index] = { type: "break", position: child.position };
        continue;
      }
      visit(child);
    }
  }

  visit(tree);
};

let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;

function loadMermaid() {
  mermaidModulePromise ??= import("mermaid").then((module) => {
    module.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
    });
    return module;
  });
  return mermaidModulePromise;
}

function extractTextContent(node: ReactNode): string {
  if (node == null || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractTextContent).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractTextContent(node.props.children);
  }
  return "";
}

export function resolveCodeBlockText(node: ReactNode): string {
  return extractTextContent(node).replace(/\r\n?/g, "\n").replace(/\n$/, "");
}

function isFencedCodeBlock(node: HastNode | undefined, markdown: string): boolean {
  const startOffset = node?.position?.start?.offset;
  if (typeof startOffset !== "number") {
    return false;
  }
  const openingLine = markdown.slice(startOffset).split(/\r?\n/, 1)[0];
  return /^[ ]{0,3}(?:`{3,}|~{3,})/.test(openingLine);
}

type CodeBlockCopyButtonProps = {
  code: string;
  onCopyResult: (feedback: MessageCopyFeedback) => void;
};

function CodeBlockCopyButton({ code, onCopyResult }: CodeBlockCopyButtonProps) {
  const [isCopying, setIsCopying] = useState(false);
  const copyInFlightRef = useRef(false);

  const handleCopy = async () => {
    if (copyInFlightRef.current) {
      return;
    }
    copyInFlightRef.current = true;
    setIsCopying(true);
    try {
      const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
      if (!writeText) {
        throw new Error("Clipboard API is unavailable.");
      }
      await writeText(code);
      onCopyResult({ message: "コードをコピーしました。", tone: "success" });
    } catch {
      onCopyResult({ message: "コードのコピーに失敗しました。", tone: "error" });
    } finally {
      copyInFlightRef.current = false;
      setIsCopying(false);
    }
  };

  return (
    <button
      className="message-code-copy-button"
      type="button"
      aria-label="コードをコピー"
      title="コードをコピー"
      disabled={isCopying}
      onClick={() => void handleCopy()}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
        <path d="M8.5 15.5H7A2.5 2.5 0 0 1 4.5 13V7A2.5 2.5 0 0 1 7 4.5h6A2.5 2.5 0 0 1 15.5 7v1.5" />
        <rect x="8.5" y="8.5" width="11" height="11" rx="3" />
      </svg>
    </button>
  );
}

function resolveCodeLanguage(className?: string) {
  return /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1]?.toLowerCase();
}

function mergeClassName(baseClassName: string, className?: string) {
  return className ? `${baseClassName} ${className}` : baseClassName;
}

function decodeEncodedWindowsPathSeparators(target: string): string {
  return target.replace(/%5c/gi, "\\");
}

function isWindowsAbsolutePathTarget(target: string): boolean {
  const normalizedTarget = decodeEncodedWindowsPathSeparators(target);
  return /^[a-zA-Z]:[\\/]/.test(normalizedTarget) || /^\\\\[^\\]+\\[^\\]+/.test(normalizedTarget);
}

function hasUnsupportedUrlScheme(target: string): boolean {
  if (isWindowsAbsolutePathTarget(target)) {
    return false;
  }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target);
  if (!schemeMatch) {
    return false;
  }

  const scheme = schemeMatch[1].toLowerCase();
  return scheme !== "http" && scheme !== "https" && scheme !== "file" && scheme !== "mailto" && scheme !== "tel";
}

function isAllowedMarkdownHref(target: string): boolean {
  if (!target || target.startsWith("#") || target.startsWith("//") || isWindowsAbsolutePathTarget(target)) {
    return true;
  }
  return !hasUnsupportedUrlScheme(target);
}

function isAllowedMarkdownImageSource(target: string): boolean {
  if (!target || target.startsWith("//") || isWindowsAbsolutePathTarget(target)) {
    return true;
  }
  if (/^data:image\//i.test(target) || /^blob:/i.test(target)) {
    return true;
  }
  return !hasUnsupportedUrlScheme(target);
}

function isDirectMarkdownImageSource(target: string): boolean {
  return Boolean(
    target
    && (
      target.startsWith("//")
      || isWindowsAbsolutePathTarget(target)
      || /^(?:https?:|file:|data:image\/|blob:)/i.test(target)
    )
  );
}

function shouldLoadMarkdownImageEagerly(target: string): boolean {
  return /^(?:file:|data:image\/|blob:)/i.test(target);
}

const markdownUrlTransform: UrlTransform = (url, key) => {
  if (key === "src") {
    if (!isAllowedMarkdownImageSource(url)) {
      return "";
    }
    if (url.startsWith("//")) {
      return `https:${url}`;
    }
    return isWindowsAbsolutePathTarget(url) ? toLocalFileUrl(decodeEncodedWindowsPathSeparators(url)) : url;
  }
  if (key !== "href") {
    return defaultUrlTransform(url);
  }
  if (!isAllowedMarkdownHref(url)) {
    return "";
  }
  return url.startsWith("//") ? `https:${url}` : url;
};

export function openMarkdownLink(target: string, onOpenPath?: (target: string) => void): void {
  if (onOpenPath) {
    onOpenPath(target);
    return;
  }

  const api = getWithMateApi();
  if (api) {
    void resolveOpenPathFeedback(
      () => api.openPath(target),
      "The path could not be opened.",
    ).then(showOpenPathFeedback);
  }
}

export function handleMarkdownLinkClick(
  event: Pick<MouseEvent<HTMLAnchorElement>, "button" | "defaultPrevented" | "preventDefault">,
  target: string,
  onOpenPath?: (target: string) => void,
): void {
  if (
    !target ||
    target.startsWith("#") ||
    hasUnsupportedUrlScheme(target) ||
    event.defaultPrevented ||
    event.button !== 0
  ) {
    return;
  }

  event.preventDefault();
  openMarkdownLink(target, onOpenPath);
}

type MarkdownLinkContextMenuEvent = {
  clientX: number;
  clientY: number;
  currentTarget: {
    getBoundingClientRect(): Pick<DOMRect, "bottom" | "left">;
  };
  preventDefault(): void;
};

type ShowMarkdownLinkContextMenu = (
  request: MarkdownLinkContextMenuRequest,
) => Promise<MarkdownLinkContextMenuResult>;

export async function handleMarkdownLinkContextMenu(
  event: MarkdownLinkContextMenuEvent,
  target: string,
  showContextMenu?: ShowMarkdownLinkContextMenu,
): Promise<MarkdownLinkContextMenuResult | null> {
  if (!target || target.startsWith("#") || hasUnsupportedUrlScheme(target)) {
    return null;
  }

  const showMenu = showContextMenu ?? getWithMateApi()?.showMarkdownLinkContextMenu;
  if (!showMenu) {
    return null;
  }

  const anchorRect = event.currentTarget.getBoundingClientRect();
  const keyboardTriggered = event.clientX === 0 && event.clientY === 0;
  const point = keyboardTriggered
    ? { x: Math.max(0, Math.round(anchorRect.left)), y: Math.max(0, Math.round(anchorRect.bottom)) }
    : { x: Math.max(0, Math.round(event.clientX)), y: Math.max(0, Math.round(event.clientY)) };

  event.preventDefault();
  try {
    return await showMenu({ target, point });
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "リンクのメニューを開けませんでした。",
    };
  }
}

function replaceFootnoteLabelReference(value: unknown, footnoteLabelId: string) {
  if (value === "footnote-label") {
    return footnoteLabelId;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (entry === "footnote-label" ? footnoteLabelId : entry));
  }
  return value;
}

function createFootnoteLabelIdPlugin(footnoteLabelId: string) {
  return () => (tree: HastNode) => {
    function visit(node: HastNode) {
      if (node.type === "element" && node.properties) {
        if (node.properties.id === "footnote-label") {
          node.properties.id = footnoteLabelId;
        }
        node.properties.ariaDescribedBy = replaceFootnoteLabelReference(node.properties.ariaDescribedBy, footnoteLabelId);
        node.properties["aria-describedby"] = replaceFootnoteLabelReference(
          node.properties["aria-describedby"],
          footnoteLabelId,
        );
      }

      for (const child of node.children ?? []) {
        visit(child);
      }
    }

    visit(tree);
  };
}

function MermaidDiagram({
  source,
  onCopyResult,
}: {
  source: string;
  onCopyResult?: (feedback: MessageCopyFeedback) => void;
}) {
  const reactId = useId();
  const diagramId = useMemo(() => `message-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`, [reactId]);
  const diagramSource = source.trim();
  const [renderState, setRenderState] = useState<MermaidRenderState>({ status: "pending" });

  useEffect(() => {
    let cancelled = false;

    if (!diagramSource) {
      setRenderState({ status: "error", message: "Empty Mermaid diagram." });
      return () => {
        cancelled = true;
      };
    }

    setRenderState({ status: "pending" });
    loadMermaid()
      .then((module) => module.default.render(diagramId, diagramSource))
      .then(({ svg }) => {
        if (!cancelled) {
          setRenderState({ status: "ready", svg });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRenderState({
            status: "error",
            message: error instanceof Error ? error.message : "Failed to render Mermaid diagram.",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [diagramId, diagramSource]);

  if (renderState.status === "ready") {
    return (
      <div className="message-code-block-shell mermaid">
        <div className="message-mermaid" dangerouslySetInnerHTML={{ __html: renderState.svg }} />
        {onCopyResult ? (
          <CodeBlockCopyButton code={resolveCodeBlockText(source)} onCopyResult={onCopyResult} />
        ) : null}
      </div>
    );
  }

  return (
    <div className="message-code-block-shell mermaid">
      <div className="message-mermaid fallback">
        {renderState.status === "error" ? <p className="message-mermaid-error">{renderState.message}</p> : null}
        <pre className="message-code-block">
          <code className="message-inline-code language-mermaid">{source}</code>
        </pre>
      </div>
      {onCopyResult ? (
        <CodeBlockCopyButton code={resolveCodeBlockText(source)} onCopyResult={onCopyResult} />
      ) : null}
    </div>
  );
}

const markdownComponents: Components = {
  h1: ({ children, className: headingClassName, node, ...props }) => (
    <h1 {...props} className={mergeClassName("message-heading level-1", headingClassName)}>
      {children}
    </h1>
  ),
  h2: ({ children, className: headingClassName, node, ...props }) => (
    <h2 {...props} className={mergeClassName("message-heading level-2", headingClassName)}>
      {children}
    </h2>
  ),
  h3: ({ children, className: headingClassName, node, ...props }) => (
    <h3 {...props} className={mergeClassName("message-heading level-3", headingClassName)}>
      {children}
    </h3>
  ),
  h4: ({ children, className: headingClassName, node, ...props }) => (
    <h4 {...props} className={mergeClassName("message-heading level-4", headingClassName)}>
      {children}
    </h4>
  ),
  h5: ({ children, className: headingClassName, node, ...props }) => (
    <h5 {...props} className={mergeClassName("message-heading level-5", headingClassName)}>
      {children}
    </h5>
  ),
  h6: ({ children, className: headingClassName, node, ...props }) => (
    <h6 {...props} className={mergeClassName("message-heading level-6", headingClassName)}>
      {children}
    </h6>
  ),
  hr: ({ className: dividerClassName, node, ...props }) => (
    <hr {...props} className={mergeClassName("message-divider", dividerClassName)} />
  ),
  p: ({ children, className: paragraphClassName, node, ...props }) => (
    <p {...props} className={mergeClassName("message-paragraph", paragraphClassName)}>
      {children}
    </p>
  ),
  ul: ({ children, className: listClassName, node, ...props }) => (
    <ul {...props} className={mergeClassName("message-list", listClassName)}>
      {children}
    </ul>
  ),
  ol: ({ children, className: listClassName, node, ...props }) => (
    <ol {...props} className={mergeClassName("message-list ordered", listClassName)}>
      {children}
    </ol>
  ),
  code: ({ children, className: codeClassName, node, ...props }) => {
    const renderedChildren = typeof children === "string" && children.endsWith("\n")
      ? children.slice(0, -1)
      : children;
    return (
      <code {...props} className={mergeClassName("message-inline-code", codeClassName)}>
        {renderedChildren}
      </code>
    );
  },
  table: ({ children, className: tableClassName, node, ...props }) => (
    <table {...props} className={mergeClassName("message-table", tableClassName)}>
      {children}
    </table>
  ),
  th: ({ children, className: cellClassName, node, ...props }) => (
    <th {...props} className={mergeClassName("message-table-heading", cellClassName)}>
      {children}
    </th>
  ),
  td: ({ children, className: cellClassName, node, ...props }) => (
    <td {...props} className={mergeClassName("message-table-cell", cellClassName)}>
      {children}
    </td>
  ),
  strong: ({ children, className: strongClassName, node, ...props }) => (
    <strong {...props} className={mergeClassName("message-inline-strong", strongClassName)}>
      {children}
    </strong>
  ),
};

function renderMarkdownFrontmatter(_state: unknown, node: Node) {
  const value = "value" in node && typeof node.value === "string" ? node.value : "";
  const display = resolveMarkdownFrontmatterDisplay(value);
  if (display.kind === "table") {
    return {
      type: "element" as const,
      tagName: "table",
      properties: {
        className: ["message-frontmatter-table"],
        "aria-label": "YAML frontmatter",
      },
      children: [{
        type: "element" as const,
        tagName: "tbody",
        properties: {},
        children: display.rows.map((row) => ({
          type: "element" as const,
          tagName: "tr",
          properties: {},
          children: [
            {
              type: "element" as const,
              tagName: "th",
              properties: { scope: "row" },
              children: [{ type: "text" as const, value: row.key }],
            },
            {
              type: "element" as const,
              tagName: "td",
              properties: {},
              children: [{ type: "text" as const, value: row.value }],
            },
          ],
        })),
      }],
    };
  }

  return {
    type: "element" as const,
    tagName: "pre",
    properties: { className: ["message-frontmatter-block"] },
    children: [{
      type: "element" as const,
      tagName: "code",
      properties: { className: ["message-frontmatter-code", "language-yaml"] },
      children: [{ type: "text" as const, value: formatMarkdownFrontmatterSource(value) }],
    }],
  };
}

type MarkdownImageProps = {
  source: string;
  alt?: string;
  title?: string;
  resolveImageSource?: (target: string) => Promise<string | null>;
};

function MarkdownImage({ source, alt, title, resolveImageSource }: MarkdownImageProps) {
  const canLoadDirectly = !resolveImageSource && isDirectMarkdownImageSource(source);
  const shouldLoadEagerly = shouldLoadMarkdownImageEagerly(source);
  const [resolvedSource, setResolvedSource] = useState(canLoadDirectly ? source : "");
  const [loadStatus, setLoadStatus] = useState<"resolving" | "loading" | "ready" | "error">(
    resolveImageSource ? "resolving" : canLoadDirectly ? "loading" : "error",
  );

  useEffect(() => {
    if (!resolveImageSource) {
      return;
    }

    let active = true;
    let ownedObjectUrl: string | null = null;

    setResolvedSource("");
    setLoadStatus("resolving");
    void resolveImageSource(source)
      .then((resolved) => {
        if (!active) {
          if (resolved && resolved !== source && resolved.startsWith("blob:")) {
            URL.revokeObjectURL(resolved);
          }
          return;
        }
        if (!resolved) {
          setLoadStatus("error");
          return;
        }
        if (resolved !== source && resolved.startsWith("blob:")) {
          ownedObjectUrl = resolved;
        }
        setResolvedSource(resolved);
        setLoadStatus("loading");
      })
      .catch(() => {
        if (active) {
          setResolvedSource("");
          setLoadStatus("error");
        }
      });

    return () => {
      active = false;
      if (ownedObjectUrl) {
        URL.revokeObjectURL(ownedObjectUrl);
      }
    };
  }, [resolveImageSource, source]);

  return (
    <span className="message-image-shell">
      {loadStatus === "resolving" || loadStatus === "loading" ? (
        <span className="message-image-loading" role="status">Image loading…</span>
      ) : null}
      {loadStatus === "error" ? (
        <span className="message-image-error" role="alert" title={source}>Image could not be loaded.</span>
      ) : null}
      {resolvedSource ? (
        <img
          className="message-image"
          src={resolvedSource}
          alt={alt ?? ""}
          title={title}
          loading={shouldLoadEagerly ? "eager" : "lazy"}
          fetchPriority={shouldLoadEagerly ? "high" : "auto"}
          onLoad={() => setLoadStatus("ready")}
          onError={() => setLoadStatus("error")}
        />
      ) : null}
    </span>
  );
}

function shouldDeferRichMarkdownRender(): boolean {
  return typeof window !== "undefined";
}

function scheduleFullMarkdownRender(callback: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const browserWindow = window as Window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
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
    if (idleId !== null && typeof browserWindow.cancelIdleCallback === "function") {
      browserWindow.cancelIdleCallback(idleId);
    }
    if (frameId !== null) {
      browserWindow.cancelAnimationFrame(frameId);
    }
  };
}

function createMarkdownComponents(
  onOpenPath?: (target: string) => void,
  options?: {
    enableMermaid?: boolean;
    markdown?: string;
    onCodeBlockCopyResult?: (feedback: MessageCopyFeedback) => void;
    onLinkContextMenuResult?: (result: MarkdownLinkContextMenuResult) => void;
    resolveImageSource?: (target: string) => Promise<string | null>;
  },
): Components {
  const enableMermaid = options?.enableMermaid ?? true;
  return {
    ...markdownComponents,
    pre: ({ children, node, ...props }) => {
      const isFenced = isFencedCodeBlock(node, options?.markdown ?? "");
      const child = Children.toArray(children)[0];
      if (enableMermaid && isValidElement<{ className?: string; children?: ReactNode }>(child)) {
        const language = resolveCodeLanguage(child.props.className);
        if (language === "mermaid") {
          return (
            <MermaidDiagram
              source={extractTextContent(child.props.children)}
              onCopyResult={isFenced ? options?.onCodeBlockCopyResult : undefined}
            />
          );
        }
      }

      const content = (
        <pre {...props} className={mergeClassName("message-code-block", props.className)}>
          {children}
        </pre>
      );
      return isFenced && options?.onCodeBlockCopyResult ? (
        <div className="message-code-block-shell">
          {content}
          <CodeBlockCopyButton
            code={resolveCodeBlockText(children)}
            onCopyResult={options.onCodeBlockCopyResult}
          />
        </div>
      ) : content;
    },
    a: ({ children, href, node, ...props }) => {
      const target = href?.trim() ?? "";
      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        handleMarkdownLinkClick(event, target, onOpenPath);
      };
      const handleContextMenu = (event: MouseEvent<HTMLAnchorElement>) => {
        void handleMarkdownLinkContextMenu(event, target).then((result) => {
          if (result && result.status !== "dismissed") {
            options?.onLinkContextMenuResult?.(result);
          }
        });
      };

      return (
        <a {...props} href={href} onClick={handleClick} onContextMenu={handleContextMenu}>
          {children}
        </a>
      );
    },
    img: ({ src, alt, title }) => {
      const source = typeof src === "string" ? src.trim() : "";
      return source ? (
        <MarkdownImage
          key={`${options?.resolveImageSource ? "resolved" : "direct"}:${source}`}
          source={source}
          alt={alt}
          title={title}
          resolveImageSource={options?.resolveImageSource}
        />
      ) : null;
    },
  };
}

function MessageMarkdownPreview({
  text,
  className = "message-body",
  forceFullRender = false,
  onOpenPath,
  resolveImageSource,
}: MessageRichTextProps) {
  const reactId = useId();
  const footnotePrefix = useMemo(() => `message-footnote-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}-`, [reactId]);
  const footnoteLabelId = `${footnotePrefix}footnote-label`;
  const shouldDefer = !forceFullRender && shouldDeferRichMarkdownRender();
  const [copyFeedback, setCopyFeedback] = useState<MessageCopyFeedback | null>(null);
  const [renderState, setRenderState] = useState<{ text: string; mode: MarkdownRenderMode }>(() => ({
    text,
    mode: shouldDefer ? "light" : "full",
  }));
  const renderMode = resolveMessageMarkdownRenderMode(forceFullRender, text, renderState, shouldDefer);
  const isFullRender = renderMode === "full";
  const handleLinkContextMenuResult = useCallback((result: MarkdownLinkContextMenuResult) => {
    setCopyFeedback(result.status === "copied"
      ? { message: "リンクをコピーしました。", tone: "success" }
      : result.status === "failed"
        ? { message: result.message, tone: "error" }
        : null);
  }, []);
  const handleCodeBlockCopyResult = useCallback((feedback: MessageCopyFeedback) => {
    setCopyFeedback(feedback);
  }, []);
  const components = useMemo(
    () => createMarkdownComponents(onOpenPath, {
      enableMermaid: isFullRender,
      markdown: text,
      onCodeBlockCopyResult: handleCodeBlockCopyResult,
      onLinkContextMenuResult: handleLinkContextMenuResult,
      resolveImageSource,
    }),
    [handleCodeBlockCopyResult, handleLinkContextMenuResult, isFullRender, onOpenPath, resolveImageSource, text],
  );
  const rehypePlugins = useMemo<PluggableList>(
    () => (isFullRender ? [rehypeKatex, createFootnoteLabelIdPlugin(footnoteLabelId)] : []),
    [footnoteLabelId, isFullRender],
  );
  const remarkPlugins = useMemo<PluggableList>(
    () => (
      isFullRender
        ? [remarkFrontmatter, remarkGfm, [remarkMath, { singleDollarTextMath: false }], remarkHtmlLineBreaks]
        : [remarkFrontmatter, remarkHtmlLineBreaks]
    ),
    [isFullRender],
  );

  useEffect(() => {
    if (!shouldDefer) {
      setRenderState({ text, mode: "full" });
      return;
    }

    setRenderState({ text, mode: "light" });
    return scheduleFullMarkdownRender(() => {
      setRenderState((current) => (
        current.text === text
          ? { text, mode: "full" }
          : current
      ));
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
    <div className={`${className} rich-text`.trim()} data-markdown-render-mode={renderMode}>
      <ReactMarkdown
        components={components}
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
