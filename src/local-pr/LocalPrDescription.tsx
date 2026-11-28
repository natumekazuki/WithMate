import { useMemo, useRef, useState } from "react";
import type { LocalPrWindowApi } from "../../src-shared/local-pr/local-pr-contract.js";
import { ComposerAttachmentMenu } from "../chat/composer-attachment-menu.js";
import { buildComposerReferenceInsertionState } from "../chat/composer/session-composer-paths.js";
import { collectPastedClipboardFiles, collectPastedSessionAttachments } from "../chat/composer-paste-handlers.js";
import { usePastedFileReplacement } from "../chat/use-pasted-file-replacement.js";
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const { confirmReplacement, replacementDialog, notifyReuse, reuseNotice } = usePastedFileReplacement("local-pr", !disabled);

  async function attach(kind: Parameters<LocalPrWindowApi["pickAttachment"]>[0]) {
    const start = field.current?.selectionStart ?? text.length;
    const end = field.current?.selectionEnd ?? start;
    setPicking(true);
    setError(null);
    try {
      const paths = await api.pickAttachment(kind);
      const insertion = buildComposerReferenceInsertionState(text.slice(0, start) + text.slice(end), start,
        paths.map((path) => ({ path, presentation: kind === "image" || kind === "session-image" ? "image" : "path" })));
      if (!insertion) return;
      if (insertion.draft.length > 20000) {
        setError("The attachment reference exceeds the description length limit.");
        return;
      }
      onChange(insertion.draft);
      requestAnimationFrame(() => {
        field.current?.focus();
        field.current?.setSelectionRange(insertion.caret, insertion.caret);
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
          <textarea ref={field} disabled={disabled || picking} aria-labelledby="local-pr-description-label" value={text} maxLength={20000} onChange={(event) => onChange(event.target.value)}
            onPaste={(event) => {
              if (!collectPastedClipboardFiles(event.clipboardData).length) return;
              event.preventDefault();
              const clipboardData = event.clipboardData;
              const start = event.currentTarget.selectionStart;
              const end = event.currentTarget.selectionEnd;
              setPicking(true);
              setError(null);
              void collectPastedSessionAttachments({ clipboardData, preventDefault() {}, sessionId: "", currentTimestampLabel: () => new Date().toISOString(),
                isFileBacked: (file) => api.isClipboardFileBacked(file as File), confirmReplacement, onReuse: notifyReuse,
                savePastedSessionFile: ({ sessionId: _sessionId, ...request }) => api.savePastedFile(request),
              }).then((references) => {
                const insertion = buildComposerReferenceInsertionState(text.slice(0, start) + text.slice(end), start, references);
                if (insertion && insertion.draft.length <= 20000) onChange(insertion.draft);
                else if (insertion) setError("The attachment reference exceeds the description length limit.");
              }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
                .finally(() => setPicking(false));
            }} />
          <ComposerAttachmentMenu disabled={disabled || picking} busy={picking} isOpen={menuOpen} onOpenChange={setMenuOpen}
            onPickFile={() => void attach("file")} onPickFolder={() => void attach("folder")} onPickImage={() => void attach("image")}
            onAddToSessionFiles={() => void attach("session-copy")} onPickSessionFiles={() => void attach("session-file")}
            onPickSessionFolder={() => void attach("session-folder")} onPickSessionImage={() => void attach("session-image")} />
        </>}
      {error && <p className="local-pr-warning" role="alert">{error}</p>}
      {replacementDialog}
      {reuseNotice}
    </div>
  );
}
