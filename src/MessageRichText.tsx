import { Children, isValidElement, useEffect, useId, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { getWithMateApi } from "./renderer-withmate-api.js";

type MessageRichTextProps = {
  text: string;
  className?: string;
  onOpenPath?: (target: string) => void;
};

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

function hasUnsupportedUrlScheme(target: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(target)) {
    return false;
  }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target);
  if (!schemeMatch) {
    return false;
  }

  const scheme = schemeMatch[1].toLowerCase();
  return scheme !== "http" && scheme !== "https" && scheme !== "file" && scheme !== "mailto" && scheme !== "tel";
}

function isWindowsAbsolutePathTarget(target: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(target) || /^\\\\[^\\]+\\[^\\]+/.test(target);
}

function isAllowedMarkdownHref(target: string): boolean {
  if (!target || target.startsWith("#") || target.startsWith("//") || isWindowsAbsolutePathTarget(target)) {
    return true;
  }
  return !hasUnsupportedUrlScheme(target);
}

const markdownUrlTransform: UrlTransform = (url, key) => {
  if (key !== "href") {
    return defaultUrlTransform(url);
  }
  return isAllowedMarkdownHref(url) ? url : "";
};

export function openMarkdownLink(target: string, onOpenPath?: (target: string) => void): void {
  if (onOpenPath) {
    onOpenPath(target);
    return;
  }

  void getWithMateApi()?.openPath(target);
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
  code: ({ children, className: codeClassName, node, ...props }) => (
    <code {...props} className={mergeClassName("message-inline-code", codeClassName)}>
      {children}
    </code>
  ),
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
  img: () => null,
};

function createMarkdownComponents(onOpenPath?: (target: string) => void): Components {
  return {
    ...markdownComponents,
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
  };
}

export function MessageRichText({ text, className = "message-body", onOpenPath }: MessageRichTextProps) {
  const reactId = useId();
  const footnotePrefix = useMemo(() => `message-footnote-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}-`, [reactId]);
  const footnoteLabelId = `${footnotePrefix}footnote-label`;
  const components = useMemo(() => createMarkdownComponents(onOpenPath), [onOpenPath]);
  const rehypePlugins = useMemo(() => [rehypeKatex, createFootnoteLabelIdPlugin(footnoteLabelId)], [footnoteLabelId]);

  return (
    <div className={`${className} rich-text`.trim()}>
      <ReactMarkdown
        components={components}
        rehypePlugins={rehypePlugins}
        urlTransform={markdownUrlTransform}
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
        remarkRehypeOptions={{ clobberPrefix: footnotePrefix }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
