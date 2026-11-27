import { useMemo, useRef, useState } from "react";
import type { LocalPrWindowApi } from "../../src-shared/local-pr/local-pr-contract.js";
import { formatMarkdownImageReference } from "../../src-shared/files/composer-image-reference.js";
import { ButtonContent } from "../ui/button-content.js";
import { MessageRichText } from "../ui/markdown/MessageRichText.js";
import { useMarkdownImageResolver, type MarkdownImageApi } from "../ui/markdown/image-resource-loader.js";

// The PR preload ignores renderer Session identity; Main reads in the owning Session.
const imageContext = { sessionId: "" };

export function LocalPrDescription({ api, text, revision }: {
  api: LocalPrWindowApi;
  text: string;
  revision: number;
}) {
  const imageApi = useMemo<MarkdownImageApi>(() => ({
    inspectSessionImage: ({ target }) => api.inspectImage(target),
    readSessionImageChunk: ({ target, offset, length, expectedRevision }) =>
      api.readImageChunk({ target, offset, length, expectedRevision }),
  }), [api]);
  const resolveImageSource = useMarkdownImageResolver(imageApi, imageContext, revision);
  return <MessageRichText className="local-pr-description" text={text} resolveImageSource={resolveImageSource} />;
}

export function LocalPrDescriptionEditor({ api, text, onChange, disabled }: {
  api: LocalPrWindowApi;
  text: string;
  onChange: (text: string) => void;
  disabled: boolean;
}) {
  const [preview, setPreview] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  async function insertImage() {
    const start = field.current?.selectionStart ?? text.length;
    const end = field.current?.selectionEnd ?? start;
    setPicking(true);
    setError(null);
    try {
      const path = await api.pickImage();
      if (!path) return;
      const prefix = text.slice(0, start);
      const suffix = text.slice(end);
      const reference = formatMarkdownImageReference(path);
      const insertion = `${prefix && !prefix.endsWith("\n") ? "\n" : ""}${reference}${suffix && !suffix.startsWith("\n") ? "\n" : ""}`;
      const next = prefix + insertion + suffix;
      if (next.length > 20000) {
        setError("The image reference exceeds the description length limit.");
        return;
      }
      onChange(next);
      requestAnimationFrame(() => {
        field.current?.focus();
        field.current?.setSelectionRange(prefix.length + insertion.length, prefix.length + insertion.length);
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPicking(false);
    }
  }
  return (
    <div className="local-pr-description-editor">
      <div className="local-pr-description-toolbar">
        <span id="local-pr-description-label">Description</span>
        <div className="session-file-preview-segmented" role="group" aria-label="Description Mode">
          <button type="button" disabled={picking} aria-pressed={!preview} className={!preview ? "is-active" : undefined} onClick={() => setPreview(false)}>Write Markdown</button>
          <button type="button" disabled={picking} aria-pressed={preview} className={preview ? "is-active" : undefined} onClick={() => setPreview(true)}>Preview</button>
        </div>
      </div>
      {preview
        ? <div aria-label="Description Preview">{text.trim() ? <LocalPrDescription api={api} text={text} revision={0} /> : <p>No description.</p>}</div>
        : <>
          <textarea ref={field} disabled={disabled || picking} aria-labelledby="local-pr-description-label" value={text} maxLength={20000} onChange={(event) => onChange(event.target.value)} />
          <button type="button" disabled={disabled || picking} aria-busy={picking} onClick={() => void insertImage()}>
            <ButtonContent busy={picking} busyLabel="Selecting Image">Insert Image</ButtonContent>
          </button>
        </>}
      {error && <p className="local-pr-warning" role="alert">{error}</p>}
    </div>
  );
}
