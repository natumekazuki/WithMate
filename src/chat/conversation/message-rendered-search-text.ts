import { createMessageSearchProjection, type MessageSearchProjection } from "../../../src-shared/session/message-find.js";

export function createMessageSearchProjectionCache(provider?: string) {
  let entries = new Map<string, { text: string; responseProvider: string | undefined; projection: MessageSearchProjection }>();
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
    const nextEntries = new Map<string, { text: string; responseProvider: string | undefined; projection: MessageSearchProjection }>();
    const texts = messages.map((message, index) => {
      const key = messageKeys?.[index] ?? String(index);
      const text = message.text;
      const responseProvider = message.role === "assistant" ? provider : undefined;
      const previous = entries.get(key);
      const entry = previous?.text === text && previous.responseProvider === responseProvider ? previous : undefined;
      if (mode === "source") {
        if (entry) nextEntries.set(key, entry);
        return createMessageSearchProjection(text, responseProvider, "source");
      }
      const next = entry ?? { text, responseProvider, projection: createMessageSearchProjection(text, responseProvider) };
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
  "[data-footnote-ref]",
  "[data-footnote-backref]",
  "[id$='footnote-label']",
  "script",
  "style",
].join(",");

export function isMessageRenderedSearchTextNode(node: Text): boolean {
  const text = node.textContent ?? "";
  const parent = node.parentElement;
  if (!text || !parent || parent.closest(MESSAGE_RENDERED_SEARCH_EXCLUDED_SELECTOR)) {
    return false;
  }
  if (text.trim()) {
    return true;
  }

  if (/\r|\n/.test(text) || !node.previousSibling || !node.nextSibling) {
    return false;
  }

  const nextElement = node.nextSibling?.nodeType === 1 ? node.nextSibling as Element : null;
  if (nextElement?.matches("[data-footnote-backref]")) {
    return false;
  }

  return parent.matches("p, li, td, th, h1, h2, h3, h4, h5, h6, strong, em, a, del");
}
