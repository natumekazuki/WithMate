import { useContext, useEffect, useMemo, useState } from "react";
import type { MarkdownLinkContextMenuRequest } from "../../../src-shared/window/markdown-link-context-menu.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { HtmlPreview } from "../html-preview/HtmlPreview.js";
import { LoadingIndicator } from "../loading-indicator.js";
import { MarkdownRenderContext } from "./markdown-context.js";
import { MarkdownFilePreviewFrame, type MarkdownFilePreviewProps } from "./MarkdownFilePreviewFrame.js";

type PreviewState = { key: string; html?: string; fileName?: string; error?: string };

export function MarkdownHtmlPreview({ path, href, title, children }: MarkdownFilePreviewProps) {
  const { linkFileContext } = useContext(MarkdownRenderContext);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<PreviewState | null>(null);
  const contextKey = JSON.stringify(linkFileContext);
  const fileContext = useMemo<MarkdownLinkContextMenuRequest["fileContext"]>(
    () => contextKey === undefined ? undefined : JSON.parse(contextKey),
    [contextKey],
  );
  const key = JSON.stringify([contextKey, path, revision]);
  const current = state?.key === key ? state : null;
  let filePath = path;
  if (/^file:/iu.test(path)) {
    filePath = decodeURIComponent(new URL(path).pathname);
  }
  const unsupported = !/\.html?$/iu.test(filePath);
  const unavailable = unsupported ? "Only HTML files (.html or .htm) can be previewed."
    : !linkFileContext ? "HTML preview requires a session." : null;

  useEffect(() => {
    if (unavailable) return;
    let canceled = false;
    const api = getWithMateApi();
    if (!api) {
      setState({ key, error: "HTML preview is unavailable." });
      return;
    }
    void api.readSessionHtmlPreview({ ...fileContext!, target: path }).then(
      (result) => { if (!canceled) setState({ key, ...result }); },
      (error: unknown) => {
        if (!canceled) setState({ key, error: error instanceof Error && error.message ? error.message : "The HTML file could not be read." });
      },
    );
    return () => { canceled = true; };
  }, [key, fileContext, path, unavailable]);

  const error = unavailable ?? current?.error;
  const loading = !error && current?.html === undefined;
  return (
    <MarkdownFilePreviewFrame path={path} href={href} title={title} link={children} format="HTML"
      loading={loading} onReload={unavailable ? undefined : () => setRevision((value) => value + 1)}>
      {error ? <span className="message-file-preview-placeholder" role="alert">{error}</span>
        : current?.html !== undefined ? <HtmlPreview html={current.html} title={title || current.fileName || path} />
        : <span className="message-file-preview-placeholder"><LoadingIndicator label="Loading HTML preview" /></span>}
    </MarkdownFilePreviewFrame>
  );
}
