import { useContext, useEffect, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import type { MarkdownLinkContextMenuRequest } from "../../../src-shared/window/markdown-link-context-menu.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { HtmlPreview } from "../html-preview/HtmlPreview.js";
import { LoadingIndicator } from "../loading-indicator.js";
import { ButtonContent } from "../button-content.js";
import { MarkdownRenderContext } from "./markdown-context.js";
import { MarkdownLink } from "./markdown-links.js";

type PreviewState = { key: string; html?: string; fileName?: string; error?: string };

export function MarkdownHtmlPreview({ path, href, title, children }: { path: string; href: string; title?: string; children: ReactNode }) {
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
  const reloading = revision > 0 && loading;
  return (
    <span className="message-html-preview" aria-label={title || "HTML Preview"}>
      <span className="message-html-preview-header">
        <MarkdownLink href={href} title={path} aria-label={`Open ${path}`}>{children}</MarkdownLink>
        {!unavailable && <span className="message-html-preview-auxiliary">
          <button type="button" onClick={() => setRevision((value) => value + 1)} disabled={loading}
            aria-busy={reloading || undefined} aria-label="Reload HTML Preview" title="Reload HTML Preview">
            <ButtonContent busy={reloading} busyLabel="Reloading HTML Preview"><span aria-hidden="true">↻</span></ButtonContent>
          </button>
        </span>}
      </span>
      <span className="message-html-preview-auxiliary message-html-preview-content" aria-busy={loading}>
        {error ? <span className="message-html-preview-error" role="alert">{error}</span>
          : current?.html !== undefined ? <HtmlPreview html={current.html} title={title || current.fileName || path} />
          : <LoadingIndicator label="Loading HTML preview" />}
      </span>
    </span>
  );
}

export function MarkdownAnchor(props: ComponentPropsWithoutRef<"a"> & { node?: { properties?: Record<string, unknown> } }) {
  const properties = props.node?.properties;
  const path = properties?.["data-codex-visualize-path"];
  const title = properties?.["data-codex-visualize-title"];
  if (typeof path === "string") {
    return <MarkdownHtmlPreview path={path} href={props.href ?? ""} title={typeof title === "string" ? title : undefined}>{props.children}</MarkdownHtmlPreview>;
  }
  return <MarkdownLink {...props} />;
}
