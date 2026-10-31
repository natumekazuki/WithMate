import type { ReactNode, Ref } from "react";

import { ButtonContent } from "../button-content.js";
import { MarkdownLink } from "./markdown-links.js";
import type { MarkdownSourceAttributes } from "./markdown-source-ranges.js";

export type MarkdownFilePreviewProps = {
  path: string;
  href: string;
  title?: string;
  children: ReactNode;
  sourceAttributes?: MarkdownSourceAttributes;
};

export function MarkdownFilePreviewFrame({
  path, href, title, link, format, loading, onReload, shellRef, children, sourceAttributes,
}: Omit<MarkdownFilePreviewProps, "children"> & {
  link: ReactNode;
  format: "HTML" | "PDF";
  loading: boolean;
  onReload?: () => void;
  shellRef?: Ref<HTMLSpanElement>;
  children: ReactNode;
}) {
  const reloadLabel = `Reload ${format} Preview`;
  return (
    <span ref={shellRef} className="message-file-preview" data-format={format.toLowerCase()}
      aria-label={title || `${format} Preview`}>
      <span {...sourceAttributes} className="message-file-preview-header">
        <MarkdownLink href={href} title={path} aria-label={`Open ${path}`}>{link}</MarkdownLink>
        {onReload ? <span className="message-file-preview-auxiliary message-file-preview-controls">
          <button type="button" onClick={onReload} disabled={loading}
            aria-busy={loading || undefined} aria-label={reloadLabel} title={reloadLabel}>
            <ButtonContent busy={loading} busyLabel={`Reloading ${format} Preview`}>
              <span aria-hidden="true">↻</span>
            </ButtonContent>
          </button>
        </span> : null}
      </span>
      <span className="message-file-preview-auxiliary message-file-preview-content"
        aria-label={`Embedded ${format}`} aria-busy={loading}>
        {children}
      </span>
    </span>
  );
}
