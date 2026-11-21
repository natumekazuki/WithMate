/** Only the visible PDF document's range is eligible for host text actions. */
export function readPdfSelection(document: Document): string {
  const selection = document.defaultView?.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return "";
  const pages = Array.from(document.querySelectorAll(".pdfViewer"))
    .find((element) => element.contains(selection.anchorNode) && element.contains(selection.focusNode)
      && !element.closest("[hidden]"));
  return pages ? selection.toString().slice(0, 1_000_000) : "";
}
