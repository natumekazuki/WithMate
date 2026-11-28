import { useMemo, useState } from "react";
import type { LocalPrWindowApi } from "../../src-shared/local-pr/local-pr-contract.js";
import { LocalPrAttachmentEditor } from "./LocalPrAttachmentEditor.js";
import { resolveOpenPathFeedback, showOpenPathFeedback } from "../file-explorer/open-path-result.js";
import { MessageRichText } from "../ui/markdown/MessageRichText.js";
import { useMarkdownImageResolver, type MarkdownImageApi } from "../ui/markdown/image-resource-loader.js";

// PR の preload は renderer が渡した Session の識別情報を無視し、Main は所有元の Session で読み取る。
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
  return <MessageRichText className="local-pr-description" text={text} resolveImageSource={resolveImageSource}
    onOpenPath={(target) => { void resolveOpenPathFeedback(() => api.openAttachment(target), "The path could not be opened.").then(showOpenPathFeedback); }} />;
}

export function LocalPrDescriptionEditor({ api, text, onChange, disabled, onAttachmentBusy }: {
  api: LocalPrWindowApi;
  text: string;
  onChange: (text: string) => void;
  disabled: boolean;
  onAttachmentBusy: (busy: boolean) => void;
}) {
  const [preview, setPreview] = useState(false);
  const [picking, setPicking] = useState(false);
  return (
    <div className="local-pr-description-editor">
      <div className="local-pr-description-toolbar">
        <span id="local-pr-description-label">Description</span>
        <div className="session-file-preview-segmented" role="group" aria-label="Description Mode">
          <button type="button" disabled={disabled || picking} aria-pressed={!preview} className={!preview ? "is-active" : undefined} onClick={() => setPreview(false)}>Write Markdown</button>
          <button type="button" disabled={disabled || picking} aria-pressed={preview} className={preview ? "is-active" : undefined} onClick={() => setPreview(true)}>Preview</button>
        </div>
      </div>
      {preview
        ? <div aria-label="Description Preview">{text.trim() ? <LocalPrDescription api={api} text={text} revision={0} /> : <p>No description.</p>}</div>
        : <LocalPrAttachmentEditor api={api} text={text} onChange={onChange} disabled={disabled} onBusyChange={(value) => { setPicking(value); onAttachmentBusy(value); }} />}
    </div>
  );
}
