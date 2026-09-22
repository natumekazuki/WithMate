import {
  Children,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

import {
  MarkdownRenderContext,
  type MessageCopyFeedback,
} from "./markdown-context.js";

type HastNode = {
  type?: string;
  position?: { start?: { offset?: number } };
  children?: HastNode[];
};
type MermaidRenderState =
  | { status: "pending" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };
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
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractTextContent).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return extractTextContent(node.props.children);
  return "";
}
export function resolveCodeBlockText(node: ReactNode): string {
  return extractTextContent(node).replace(/\r\n?/g, "\n").replace(/\n$/, "");
}
function isFencedCodeBlock(
  node: HastNode | undefined,
  markdown: string,
): boolean {
  const startOffset = node?.position?.start?.offset;
  if (typeof startOffset !== "number") return false;
  return /^[ ]{0,3}(?:`{3,}|~{3,})/.test(
    markdown.slice(startOffset).split(/\r?\n/, 1)[0],
  );
}
function resolveCodeLanguage(className?: string) {
  return /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1]?.toLowerCase();
}
function mergeClassName(baseClassName: string, className?: string) {
  return className ? `${baseClassName} ${className}` : baseClassName;
}
function CodeBlockCopyButton({
  code,
  onCopyResult,
}: {
  code: string;
  onCopyResult: (feedback: MessageCopyFeedback) => void;
}) {
  const [isCopying, setIsCopying] = useState(false);
  const copyInFlightRef = useRef(false);
  const handleCopy = async () => {
    if (copyInFlightRef.current) return;
    copyInFlightRef.current = true;
    setIsCopying(true);
    try {
      const writeText = navigator.clipboard?.writeText?.bind(
        navigator.clipboard,
      );
      if (!writeText) throw new Error("Clipboard API is unavailable.");
      await writeText(code);
      onCopyResult({ message: "コードをコピーしました。", tone: "success" });
    } catch {
      onCopyResult({
        message: "コードのコピーに失敗しました。",
        tone: "error",
      });
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
function CodeBlockShell({
  children,
  code,
  onCopyResult,
}: {
  children: ReactNode;
  code: string;
  onCopyResult: (feedback: MessageCopyFeedback) => void;
}) {
  return (
    <div className="message-code-block-shell copyable">
      <div className="message-code-block-actions">
        <CodeBlockCopyButton code={code} onCopyResult={onCopyResult} />
      </div>
      {children}
    </div>
  );
}
function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const diagramId = useMemo(
    () => `message-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );
  const diagramSource = source.trim();
  const [renderState, setRenderState] = useState<MermaidRenderState>({
    status: "pending",
  });
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
        if (!cancelled) setRenderState({ status: "ready", svg });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setRenderState({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Failed to render Mermaid diagram.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [diagramId, diagramSource]);
  if (renderState.status === "ready")
    return (
      <div className="message-code-block-shell mermaid">
        <div
          className="message-mermaid"
          dangerouslySetInnerHTML={{ __html: renderState.svg }}
        />
      </div>
    );
  return (
    <div className="message-code-block-shell mermaid">
      <div className="message-mermaid fallback">
        {renderState.status === "error" ? (
          <p className="message-mermaid-error">{renderState.message}</p>
        ) : null}
        <pre className="message-code-block">
          <code className="message-inline-code language-mermaid">{source}</code>
        </pre>
      </div>
    </div>
  );
}
export type MarkdownPreComponentProps = ComponentPropsWithoutRef<"pre"> & {
  node?: unknown;
};
export function MarkdownPre({
  children,
  node,
  ...props
}: MarkdownPreComponentProps) {
  const { enableMermaid, markdown, onCodeBlockCopyResult } = useContext(
    MarkdownRenderContext,
  );
  const isFenced = isFencedCodeBlock(node as HastNode | undefined, markdown);
  const child = Children.toArray(children)[0];
  if (
    enableMermaid &&
    isValidElement<{ className?: string; children?: ReactNode }>(child) &&
    resolveCodeLanguage(child.props.className) === "mermaid"
  )
    return <MermaidDiagram source={extractTextContent(child.props.children)} />;
  const content = (
    <pre
      {...props}
      className={mergeClassName("message-code-block", props.className)}
    >
      {children}
    </pre>
  );
  return isFenced && onCodeBlockCopyResult ? (
    <CodeBlockShell
      code={resolveCodeBlockText(children)}
      onCopyResult={onCodeBlockCopyResult}
    >
      {content}
    </CodeBlockShell>
  ) : (
    content
  );
}
