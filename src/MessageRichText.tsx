import { Children, isValidElement, memo, useEffect, useId, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";

import { getWithMateApi } from "./renderer-withmate-api.js";
import { toLocalFileUrl } from "./local-file-url.js";
import { resolveOpenPathFeedback, showOpenPathFeedback } from "./open-path-result.js";

type MessageRichTextProps = {
  text: string;
  className?: string;
  forceFullRender?: boolean;
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

function MermaidDiagram({ source }: { source: string }) {
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
    return <div className="message-mermaid" dangerouslySetInnerHTML={{ __html: renderState.svg }} />;
  }

  return (
    <div className="message-mermaid fallback">
      {renderState.status === "error" ? <p className="message-mermaid-error">{renderState.message}</p> : null}
      <pre className="message-code-block">
        <code className="message-inline-code language-mermaid">{source}</code>
      </pre>
    </div>
  );
}

const markdownComponents: Components = {
  h1: ({ children, className: headingClassName, node, ...props }) => (
    <h3 {...props} className={mergeClassName("message-heading level-1", headingClassName)}>
      {children}
    </h3>
  ),
  h2: ({ children, className: headingClassName, node, ...props }) => (
    <h4 {...props} className={mergeClassName("message-heading level-2", headingClassName)}>
      {children}
    </h4>
  ),
  h3: ({ children, className: headingClassName, node, ...props }) => (
    <h5 {...props} className={mergeClassName("message-heading level-3", headingClassName)}>
      {children}
    </h5>
  ),
  h4: ({ children, className: headingClassName, node, ...props }) => (
    <h5 {...props} className={mergeClassName("message-heading level-3", headingClassName)}>
      {children}
    </h5>
  ),
  h5: ({ children, className: headingClassName, node, ...props }) => (
    <h5 {...props} className={mergeClassName("message-heading level-3", headingClassName)}>
      {children}
    </h5>
  ),
  h6: ({ children, className: headingClassName, node, ...props }) => (
    <h5 {...props} className={mergeClassName("message-heading level-3", headingClassName)}>
      {children}
    </h5>
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
  pre: ({ children, node, ...props }) => {
    const child = Children.toArray(children)[0];
    if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
      const language = resolveCodeLanguage(child.props.className);
      if (language === "mermaid") {
        return <MermaidDiagram source={extractTextContent(child.props.children)} />;
      }
    }
    return (
      <pre {...props} className={mergeClassName("message-code-block", props.className)}>
        {children}
      </pre>
    );
  },
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

type MarkdownImageProps = {
  source: string;
  alt?: string;
  title?: string;
  resolveImageSource?: (target: string) => Promise<string | null>;
};

function MarkdownImage({ source, alt, title, resolveImageSource }: MarkdownImageProps) {
  const canLoadDirectly = !resolveImageSource && isDirectMarkdownImageSource(source);
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
          loading="lazy"
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
    resolveImageSource?: (target: string) => Promise<string | null>;
  },
): Components {
  const enableMermaid = options?.enableMermaid ?? true;
  return {
    ...markdownComponents,
    ...(enableMermaid
      ? {}
      : {
          pre: ({ children, node, ...props }) => (
            <pre {...props} className={mergeClassName("message-code-block", props.className)}>
              {children}
            </pre>
          ),
        }),
    a: ({ children, href, node, ...props }) => {
      const target = href?.trim() ?? "";
      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        handleMarkdownLinkClick(event, target, onOpenPath);
      };

      return (
        <a {...props} href={href} onClick={handleClick}>
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

function MessageRichTextComponent({
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
  const [renderState, setRenderState] = useState<{ text: string; mode: MarkdownRenderMode }>(() => ({
    text,
    mode: shouldDefer ? "light" : "full",
  }));
  const renderMode = resolveMessageMarkdownRenderMode(forceFullRender, text, renderState, shouldDefer);
  const isFullRender = renderMode === "full";
  const components = useMemo(
    () => createMarkdownComponents(onOpenPath, { enableMermaid: isFullRender, resolveImageSource }),
    [isFullRender, onOpenPath, resolveImageSource],
  );
  const rehypePlugins = useMemo<PluggableList>(
    () => (isFullRender ? [rehypeKatex, createFootnoteLabelIdPlugin(footnoteLabelId)] : []),
    [footnoteLabelId, isFullRender],
  );
  const remarkPlugins = useMemo<PluggableList>(
    () => (isFullRender ? [remarkGfm, [remarkMath, { singleDollarTextMath: false }]] : []),
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

  return (
    <div className={`${className} rich-text`.trim()} data-markdown-render-mode={renderMode}>
      <ReactMarkdown
        components={components}
        rehypePlugins={rehypePlugins}
        urlTransform={markdownUrlTransform}
        remarkPlugins={remarkPlugins}
        remarkRehypeOptions={{ clobberPrefix: footnotePrefix }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const MessageRichText = memo(MessageRichTextComponent);
