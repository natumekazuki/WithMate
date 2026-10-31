import { useContext, useEffect, useMemo, useRef, useState } from "react";

import type { SessionFileDescriptor, SessionPdfResourceRequest } from "../../../src-shared/file-explorer/file-explorer-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { PdfFilePreview } from "../../file-explorer/PdfFilePreview.js";
import { PreviewByteAccumulator, SESSION_FILE_LARGE_WARNING_BYTES, SESSION_FILE_READ_CHUNK_BYTES, formatFileByteLength } from "../../file-explorer/file-preview-utils.js";
import { LoadingIndicator } from "../loading-indicator.js";
import { MarkdownRenderContext } from "./markdown-context.js";
import { MarkdownFilePreviewFrame, type MarkdownFilePreviewProps } from "./MarkdownFilePreviewFrame.js";

type PdfLoadState =
  | { status: "waiting" | "inspecting" }
  | { status: "large-warning"; descriptor: SessionFileDescriptor }
  | { status: "loading"; descriptor: SessionFileDescriptor; loadedBytes: number }
  | { status: "ready"; descriptor: SessionFileDescriptor; bytes: Uint8Array }
  | { status: "error"; message: string };

export function MarkdownPdfPreview({ path, href, title, children, sourceAttributes }: MarkdownFilePreviewProps) {
  const { linkFileContext, onCopyText, onQuoteText } = useContext(MarkdownRenderContext);
  const shellRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [reload, setReload] = useState(0);
  const [permittedRevision, setPermittedRevision] = useState<string | null>(null);
  const [state, setState] = useState<PdfLoadState>({ status: "waiting" });
  const [feedback, setFeedback] = useState("");
  const requestKey = JSON.stringify(linkFileContext ? { ...linkFileContext, target: path } : null);
  const request = useMemo<SessionPdfResourceRequest | null>(() => JSON.parse(requestKey), [requestKey]);
  const actionGeneration = useRef(0);

  useEffect(() => {
    if (!shellRef.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    });
    observer.observe(shellRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    const accumulator = new PreviewByteAccumulator();
    const api = getWithMateApi();
    setState({ status: "inspecting" });
    setFeedback("");
    actionGeneration.current++;
    void (async () => {
      try {
        if (!request || !api) throw new Error("PDF preview is unavailable in this context.");
        const descriptor = await api.inspectSessionPdf(request);
        if (!active) return;
        if (descriptor.byteLength >= SESSION_FILE_LARGE_WARNING_BYTES && permittedRevision !== descriptor.revision) {
          setState({ status: "large-warning", descriptor });
          return;
        }
        let offset = 0;
        setState({ status: "loading", descriptor, loadedBytes: offset });
        while (offset < descriptor.byteLength) {
          const chunk = await api.readSessionPdfChunk({ ...request, offset,
            length: SESSION_FILE_READ_CHUNK_BYTES, expectedRevision: descriptor.revision });
          if (!active) return;
          if (chunk.revision !== descriptor.revision || chunk.offset !== offset
            || chunk.totalBytes !== descriptor.byteLength || chunk.nextOffset !== offset + chunk.data.byteLength
            || chunk.nextOffset <= offset || chunk.nextOffset > descriptor.byteLength) {
            throw new Error("File contents changed while they were being read.");
          }
          accumulator.append(new Uint8Array(chunk.data));
          offset = chunk.nextOffset;
          setState({ status: "loading", descriptor, loadedBytes: offset });
        }
        setState({ status: "ready", descriptor, bytes: accumulator.finish(descriptor.byteLength) });
      } catch (error) {
        if (active) setState({ status: "error", message: error instanceof Error ? error.message : "PDF could not be loaded." });
      } finally {
        accumulator.release();
      }
    })();
    return () => { active = false; actionGeneration.current++; accumulator.release(); };
  }, [permittedRevision, reload, request, visible]);

  const copyText = (text: string) => {
    if (onCopyText) { onCopyText(text); return; }
    const generation = actionGeneration.current;
    void Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => {
      if (generation === actionGeneration.current) setFeedback("Text copied.");
    }, () => {
      if (generation === actionGeneration.current) setFeedback("Text could not be copied.");
    });
  };
  const openLink = (target: string) => {
    if (state.status !== "ready" || !request) return;
    const generation = actionGeneration.current;
    void getWithMateApi()?.openSessionFilePreviewWindow({ kind: "link", sessionId: request.sessionId,
      target, baseResource: state.descriptor }).then((result) => {
      if (generation === actionGeneration.current && result.status !== "opened") setFeedback(result.message);
    }, (error: unknown) => {
      if (generation === actionGeneration.current) setFeedback(error instanceof Error ? error.message : "The link could not be opened.");
    });
  };

  const loading = state.status === "inspecting" || state.status === "loading";
  return <MarkdownFilePreviewFrame path={path} href={href} title={title} link={children} format="PDF" sourceAttributes={sourceAttributes}
    shellRef={shellRef} loading={loading} onReload={() => {
      setPermittedRevision(null); setReload((value) => value + 1);
    }}>
      {state.status === "ready" ? <PdfFilePreview key={`${reload}:${state.descriptor.revision}`} bytes={state.bytes}
        name={state.descriptor.name} onCopyText={copyText} onQuoteText={onQuoteText} onOpenLink={openLink} /> :
        <span className="message-file-preview-placeholder" role={state.status === "error" ? "alert" : "status"}>
          {state.status === "waiting" ? "PDF preview loads when visible." :
            state.status === "large-warning" ? <>
              <span>This PDF is {formatFileByteLength(state.descriptor.byteLength)}. Loading it may use significant memory.</span>
              <button type="button" onClick={() => setPermittedRevision(state.descriptor.revision)}>Load Anyway</button>
            </> : state.status === "error" ? state.message :
              <LoadingIndicator label={state.status === "loading"
                ? `Loading PDF: ${formatFileByteLength(state.loadedBytes)} / ${formatFileByteLength(state.descriptor.byteLength)}` : "Loading PDF"} />}
        </span>}
      {feedback ? <span className="message-file-preview-feedback" role="status">{feedback}</span> : null}
  </MarkdownFilePreviewFrame>;
}
