const MESSAGE_RENDERED_SEARCH_EXCLUDED_SELECTOR = [
  ".message-image-shell",
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
