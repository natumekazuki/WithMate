/** ホスト側のテキスト操作の対象にできるのは、表示中の PDF 文書内の選択範囲だけ。 */
export function readPdfSelection(document: Document): string {
  const selection = document.defaultView?.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return "";
  const pages = Array.from(document.querySelectorAll(".pdfViewer"))
    .find((element) => element.contains(selection.anchorNode) && element.contains(selection.focusNode)
      && !element.closest("[hidden]"));
  return pages ? selection.toString().slice(0, 1_000_000) : "";
}
