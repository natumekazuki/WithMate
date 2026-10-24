import { useContext, type ComponentPropsWithoutRef } from "react";

import { MarkdownHtmlPreview } from "./MarkdownHtmlPreview.js";
import { MarkdownRenderContext } from "./markdown-context.js";
import { MarkdownLink } from "./markdown-links.js";
import { MarkdownPdfPreview } from "./markdown-pdf.js";

export function MarkdownAnchor(props: ComponentPropsWithoutRef<"a"> & { node?: { properties?: Record<string, unknown> } }) {
  const { linkFileContext } = useContext(MarkdownRenderContext);
  const properties = props.node?.properties;
  const path = properties?.["data-codex-visualize-path"];
  const title = properties?.["data-codex-visualize-title"];
  if (typeof path === "string") {
    let filePath = path;
    try {
      if (/^file:/iu.test(path)) filePath = decodeURIComponent(new URL(path).pathname);
    } catch {
      return <MarkdownLink {...props} />;
    }
    const Preview = /\.html?$/iu.test(filePath) ? MarkdownHtmlPreview
      : /\.pdf$/iu.test(filePath) ? MarkdownPdfPreview : null;
    if (Preview) return <Preview key={JSON.stringify([path, linkFileContext])}
      path={path} href={props.href ?? ""} title={typeof title === "string" ? title : undefined}>
      {props.children}
    </Preview>;
  }
  return <MarkdownLink {...props} />;
}
