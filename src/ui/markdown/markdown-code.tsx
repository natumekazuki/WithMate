import {
  Children,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { ButtonContent } from "../button-content.js";

import {
  MarkdownRenderContext,
  type MessageCopyFeedback,
} from "./markdown-context.js";
import { MermaidViewport } from "./mermaid-viewport.js";
import {
  renderMermaidWithImages,
  type MermaidImageError,
  type MermaidImageResolver,
} from "./mermaid-images.js";
import {
  markdownSourceAttributes,
  type MarkdownSourceAttributes,
} from "./markdown-source-ranges.js";
import type { Node } from "unist";

/** `pre` が原文のフェンスから生成されたかを調べるために参照する構文木の部分。 */
type HastNode = {
  type?: string;
  position?: { start?: { offset?: number } };
  children?: HastNode[];
};
/** 表示中のSVGと画像エラーを保持し、描画の中断コントローラーで画像URLの寿命を管理する。 */
type MermaidReady = {
  source: string;
  svg: string;
  imageErrors: MermaidImageError[];
  controller: AbortController;
};
/** 計算中や入力中の失敗でも直前の図を保持できる描画状態。 */
type MermaidRenderState =
  | { status: "pending"; previous?: MermaidReady }
  | { status: "ready"; result: MermaidReady }
  | {
      status: "error";
      source: string;
      message: string;
      previous?: MermaidReady;
    };
let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;
/** 必要になったときだけMermaidを読み込み、自動描画を無効にしてstrictで初期化した結果を再利用する。 */
function loadMermaid() {
  mermaidModulePromise ??= import("mermaid").then((module) => {
    module.default.initialize({
      startOnLoad: false,
      suppressErrorRendering: true,
      securityLevel: "strict",
      theme: "base",
    });
    return module;
  });
  return mermaidModulePromise;
}
/** 要素の子を再帰的にたどり、表示される文字・数値だけを並び順どおりに連結する。 */
function extractTextContent(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractTextContent).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return extractTextContent(node.props.children);
  return "";
}
/** コピー用の改行をLFにそろえ、パーサーが末尾に足した改行1つだけを除く。 */
export function resolveCodeBlockText(node: ReactNode): string {
  return extractTextContent(node).replace(/\r\n?/g, "\n").replace(/\n$/, "");
}
/** 原文の開始位置にあるバッククォートまたはチルダを調べ、インデントによるコードブロックと区別する。 */
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
/** 複数クラスの中からパーサーの言語指定を抽出し、比較用に小文字へそろえる。 */
function resolveCodeLanguage(className?: string) {
  return /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1]?.toLowerCase();
}
/** コード表示の基底クラスと、言語指定を含む既存のクラスを併用する。 */
function mergeClassName(baseClassName: string, className?: string) {
  return className ? `${baseClassName} ${className}` : baseClassName;
}
/** フェンス内のテキストをコピーする間は操作を無効にし、成否は会話側に通知する。 */
function CodeBlockCopyButton({
  code,
  onCopyResult,
}: {
  code: string;
  onCopyResult: (feedback: MessageCopyFeedback) => void;
}) {
  const [isCopying, setIsCopying] = useState(false);
  const copyInFlightRef = useRef(false);
  /** 再描画前の連打も抑止し、クリップボードが使えない場合を含めて失敗を通知する。 */
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
      onCopyResult({ message: "Code copied.", tone: "success" });
    } catch {
      onCopyResult({
        message: "Could not copy code.",
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
      aria-label="Copy code"
      title="Copy code"
      aria-busy={isCopying}
      disabled={isCopying}
      onClick={() => void handleCopy()}
    >
      <ButtonContent busy={isCopying}>
        <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
          <path d="M8.5 15.5H7A2.5 2.5 0 0 1 4.5 13V7A2.5 2.5 0 0 1 7 4.5h6A2.5 2.5 0 0 1 15.5 7v1.5" />
          <rect x="8.5" y="8.5" width="11" height="11" rx="3" />
        </svg>
      </ButtonContent>
    </button>
  );
}
/** コピー操作をコード本文とは別の要素に置き、元の `pre` を保持する。 */
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
/** 受信中は前の図を残して描画を間引き、確定本文が描画できなければソースとエラーを表示する。 */
export const MermaidDiagram = memo(function MermaidDiagram({
  source,
  onOpenPath,
  resolveImageSource,
  sourceAttributes,
}: {
  source: string;
  onOpenPath?: (target: string) => void;
  resolveImageSource?: MermaidImageResolver;
  sourceAttributes?: MarkdownSourceAttributes;
}) {
  const context = useContext(MarkdownRenderContext);
  const imageResolver = resolveImageSource ?? context.resolveImageSource;
  const reactId = useId();
  const diagramId = useMemo(
    () => `message-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );
  const diagramSource = source.trim();
  const isStreaming = context.isStreaming ?? false;
  const renderSequence = useRef(0);
  const completed = useRef<{
    source: string;
    resolver: MermaidImageResolver | undefined;
    state: MermaidRenderState;
  } | null>(null);
  const retainedControllers = useRef(new Set<AbortController>());
  const [renderState, setRenderState] = useState<MermaidRenderState>({
    status: "pending",
  });
  const displayed =
    renderState.status === "ready"
      ? renderState.result
      : renderState.status === "pending" ||
          isStreaming ||
          renderState.source !== diagramSource
        ? renderState.previous
        : undefined;

  useEffect(() => {
    for (const controller of retainedControllers.current) {
      if (controller !== displayed?.controller) {
        controller.abort();
        retainedControllers.current.delete(controller);
      }
    }
  }, [displayed]);
  useEffect(
    () => () => {
      for (const controller of retainedControllers.current) controller.abort();
      retainedControllers.current.clear();
    },
    [],
  );

  useEffect(() => {
    const cached = completed.current;
    if (
      cached?.source === diagramSource &&
      cached.resolver === imageResolver &&
      (cached.state.status !== "ready" ||
        !cached.state.result.controller.signal.aborted)
    ) {
      setRenderState(cached.state);
      return;
    }
    let cancelled = false;
    let succeeded = false;
    const controller = new AbortController();
    /** 保留・失敗を挟んでも、表示に使える直近の成功結果を引き継ぐ。 */
    const previousResult = (current: MermaidRenderState) =>
      current.status === "ready" ? current.result : current.previous;
    /** 世代専用の描画IDを使い、取り消されていない描画だけを確定させる。 */
    const run = () => {
      setRenderState((current) => ({
        status: "pending",
        previous: previousResult(current),
      }));
      // Mermaid は描画 ID を使って DOM を削除するため、表示中の SVG の ID を再利用しない。
      const renderId = `${diagramId}-${++renderSequence.current}`;
      loadMermaid()
        .then((module) => {
          controller.signal.throwIfAborted();
          if (!diagramSource) throw new Error("Empty Mermaid diagram.");
          return renderMermaidWithImages(
            module.default,
            renderId,
            diagramSource,
            imageResolver,
            controller.signal,
          );
        })
        .then(({ svg, imageErrors }) => {
          if (cancelled) return;
          succeeded = true;
          retainedControllers.current.add(controller);
          const state: MermaidRenderState = {
            status: "ready",
            result: { source: diagramSource, svg, imageErrors, controller },
          };
          completed.current = {
            source: diagramSource,
            resolver: imageResolver,
            state,
          };
          setRenderState(state);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const message =
            error instanceof Error
              ? error.message
              : "Failed to render Mermaid diagram.";
          completed.current = {
            source: diagramSource,
            resolver: imageResolver,
            state: { status: "error", source: diagramSource, message },
          };
          setRenderState((current) => ({
            status: "error",
            source: diagramSource,
            previous: previousResult(current),
            message,
          }));
        });
    };
    const timer = isStreaming ? window.setTimeout(run, 150) : null;
    if (!isStreaming) run();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (!succeeded) controller.abort();
    };
  }, [diagramId, diagramSource, imageResolver, isStreaming]);
  const busy =
    renderState.status === "pending" ||
    displayed?.source !== diagramSource ||
    (isStreaming && renderState.status === "error");
  if (displayed)
    return (
      <div
        {...sourceAttributes}
        className="message-code-block-shell mermaid"
        aria-busy={busy}
      >
        <MermaidViewport
          key={displayed.source}
          svg={displayed.svg}
          onOpenPath={onOpenPath ?? context.onOpenPath}
          imageErrors={displayed.imageErrors}
        />
      </div>
    );
  return (
    <div
      {...sourceAttributes}
      className="message-code-block-shell mermaid"
      aria-busy={renderState.status === "pending" || isStreaming}
    >
      <div className="message-mermaid fallback">
        {renderState.status === "error" &&
        renderState.source === diagramSource &&
        !isStreaming ? (
          <p className="message-mermaid-error">{renderState.message}</p>
        ) : null}
        <pre className="message-code-block">
          <code className="message-inline-code language-mermaid">{source}</code>
        </pre>
      </div>
    </div>
  );
});
/** 標準の `pre` 属性と、フェンス判定に用いる構文木ノードを受け取る。 */
export type MarkdownPreComponentProps = ComponentPropsWithoutRef<"pre"> & {
  node?: unknown;
};
/** 通常のフェンスにだけコピー操作を付け、Mermaidの場合は操作を持たない図用シェルに置き換える。 */
export function MarkdownPre({
  children,
  node,
  ...props
}: MarkdownPreComponentProps) {
  const { markdown, onCodeBlockCopyResult } = useContext(MarkdownRenderContext);
  const isFenced = isFencedCodeBlock(node as HastNode | undefined, markdown);
  const child = Children.toArray(children)[0];
  const content = (
    <pre
      {...props}
      className={mergeClassName("message-code-block", props.className)}
    >
      {children}
    </pre>
  );
  const codeBlock =
    isFenced && onCodeBlockCopyResult ? (
      <CodeBlockShell
        code={resolveCodeBlockText(children)}
        onCopyResult={onCodeBlockCopyResult}
      >
        {content}
      </CodeBlockShell>
    ) : (
      content
    );
  if (
    isValidElement<{ className?: string; children?: ReactNode }>(child) &&
    resolveCodeLanguage(child.props.className) === "mermaid"
  ) {
    return (
      <MermaidDiagram
        source={extractTextContent(child.props.children)}
        sourceAttributes={markdownSourceAttributes(node as Node | undefined)}
      />
    );
  }
  return codeBlock;
}
