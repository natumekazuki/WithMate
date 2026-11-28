import {
  createMessageSearchProjection,
  type MessageSearchProjection,
} from "../../../src-shared/session/message-find.js";
import type { TextSearchMatch } from "../../../src-shared/text/find-text-matches.js";

/** テキストだけでなく画像・図・数式などの表示内容も、ソース一致の移動先として認める。 */
function hasRenderedSourceContent(element: HTMLElement): boolean {
  const nonTextContent =
    "hr, .message-image-shell, .message-mermaid, .katex, .katex-error";
  return Boolean(
    element.textContent?.trim() ||
    element.matches(nonTextContent) ||
    element.querySelector(nonTextContent),
  );
}

/** 似たラベルを探すのではなく、元の Markdown の一致箇所に対応する最小の描画要素を探す。 */
export function resolveMessageSourceMatchTarget(
  body: HTMLElement,
  match: TextSearchMatch,
): HTMLElement | null {
  let target: HTMLElement | null = null;
  let definitionTarget: HTMLElement | null = null;
  let targetLength = Infinity;
  for (const richText of body.querySelectorAll<HTMLElement>(
    ":scope > .rich-text",
  )) {
    const sourceStart = Number(richText.dataset.sourceStart ?? 0);
    const start = match.startOffset - sourceStart;
    const end = match.endOffset - sourceStart;
    if (start < 0) continue;
    for (const element of richText.querySelectorAll<HTMLElement>(
      "[data-md-source-start], [data-md-definition-start]",
    )) {
      const rangeStart = Number(element.dataset.mdSourceStart);
      const rangeEnd = Number(element.dataset.mdSourceEnd);
      if (
        rangeStart <= start &&
        rangeEnd >= end &&
        rangeEnd - rangeStart <= targetLength
      ) {
        target = element;
        targetLength = rangeEnd - rangeStart;
      }
      if (
        !definitionTarget &&
        Number(element.dataset.mdDefinitionStart) <= start &&
        Number(element.dataset.mdDefinitionEnd) >= end &&
        hasRenderedSourceContent(element)
      ) {
        definitionTarget = element;
      }
    }
  }
  // 明示的な参照があれば、範囲を含む祖先要素よりも正確に参照先の定義を特定できる。
  if (definitionTarget) return definitionTarget;
  // 段落や空の祖先要素だけでは、省かれた画像などの非表示の内容を特定できない。
  return target && !target.matches("p") && hasRenderedSourceContent(target)
    ? target
    : null;
}

/** 表示中のメッセージだけの検索投影を保持し、本文と応答 Provider が同じときに再利用する。 */
export function createMessageSearchProjectionCache(provider?: string) {
  let entries = new Map<
    string,
    {
      text: string;
      responseProvider: string | undefined;
      projection: MessageSearchProjection;
    }
  >();
  return (
    messages: readonly { text: string; role?: string }[],
    messageKeys: readonly string[] | undefined,
    mode: "preview" | "source",
    enabled: boolean,
  ): MessageSearchProjection[] => {
    if (!enabled) {
      entries.clear();
      return [];
    }
    // 現在の会話投影に含まれる本文だけを保持し、履歴の置換・追加取得で蓄積しない。
    const nextEntries = new Map<
      string,
      {
        text: string;
        responseProvider: string | undefined;
        projection: MessageSearchProjection;
      }
    >();
    const texts = messages.map((message, index) => {
      const key = messageKeys?.[index] ?? String(index);
      const text = message.text;
      const responseProvider =
        message.role === "assistant" ? provider : undefined;
      const previous = entries.get(key);
      const entry =
        previous?.text === text &&
        previous.responseProvider === responseProvider
          ? previous
          : undefined;
      if (mode === "source") {
        if (entry) nextEntries.set(key, entry);
        return createMessageSearchProjection(text, responseProvider, "source");
      }
      const next = entry ?? {
        text,
        responseProvider,
        projection: createMessageSearchProjection(text, responseProvider),
      };
      nextEntries.set(key, next);
      return next.projection;
    });
    entries = nextEntries;
    return texts;
  };
}

const MESSAGE_RENDERED_SEARCH_EXCLUDED_SELECTOR = [
  ".message-inline-content",
  ".message-image-shell",
  ".message-file-preview-auxiliary",
  ".message-mermaid",
  ".katex",
  ".katex-error",
  "[data-footnote-ref]",
  "[data-footnote-backref]",
  "[id$='footnote-label']",
  "script",
  "style",
].join(",");

/** 補助 UI・生成要素・整形用改行を除き、検索対象となる表示テキストまたは語間の空白を選ぶ。 */
export function isMessageRenderedSearchTextNode(node: Text): boolean {
  const text = node.textContent ?? "";
  const parent = node.parentElement;
  if (
    !text ||
    !parent ||
    parent.closest(MESSAGE_RENDERED_SEARCH_EXCLUDED_SELECTOR)
  ) {
    return false;
  }
  if (text.trim()) {
    return true;
  }

  if (/\r|\n/.test(text) || !node.previousSibling || !node.nextSibling) {
    return false;
  }

  const nextElement =
    node.nextSibling?.nodeType === 1 ? (node.nextSibling as Element) : null;
  if (nextElement?.matches("[data-footnote-backref]")) {
    return false;
  }

  return parent.matches(
    "p, li, td, th, h1, h2, h3, h4, h5, h6, strong, em, a, del",
  );
}
