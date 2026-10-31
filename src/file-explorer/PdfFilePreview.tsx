import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";

import {
  isPdfReaderFrameMessage,
  PDF_READER_CHANNEL,
  PDF_READER_ORIGIN,
  PDF_READER_THEME_TOKENS,
  PDF_READER_URL,
  type PdfReaderHostMessage,
  type PdfReaderThemeTokens,
} from "../../src-shared/file-explorer/pdf-reader-contract.js";
import { usePreviewWheelZoomStep } from "../settings/preview-zoom-settings-context.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";

export type PdfFilePreviewHandle = { find: () => void };

type PdfFilePreviewProps = {
  ref?: Ref<PdfFilePreviewHandle>;
  bytes: Uint8Array;
  name: string;
  onCopyText: (text: string) => void;
  onQuoteText?: (text: string) => void;
  onOpenLink: (target: string) => void;
};

function readThemeTokens(element: HTMLElement): PdfReaderThemeTokens {
  const style = window.getComputedStyle(element);
  return Object.fromEntries(PDF_READER_THEME_TOKENS.map((token) => [token, style.getPropertyValue(token).trim()]));
}

export function PdfFilePreview({ ref, bytes, name, onCopyText, onQuoteText, onOpenLink }: PdfFilePreviewProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const openLinkButtonRef = useRef<HTMLButtonElement>(null);
  const [instanceId] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [selection, setSelection] = useState("");
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  useEffect(() => { if (pendingLink !== null) openLinkButtonRef.current?.focus(); }, [pendingLink]);
  const cancelLink = () => { setPendingLink(null); frameRef.current?.focus(); };
  const zoomWheelStep = usePreviewWheelZoomStep();
  const zoomWheelStepRef = useRef(zoomWheelStep);
  zoomWheelStepRef.current = zoomWheelStep;
  const initializedRef = useRef(false);
  useImperativeHandle(ref, () => ({ find() {
    if (!initializedRef.current) return;
    frameRef.current?.contentWindow?.postMessage({ channel: PDF_READER_CHANNEL, instanceId, type: "find" } satisfies PdfReaderHostMessage, PDF_READER_ORIGIN);
  } }), [instanceId]);

  useEffect(() => {
    if (!initializedRef.current) return;
    frameRef.current?.contentWindow?.postMessage({ channel: PDF_READER_CHANNEL, instanceId,
      type: "settings", zoomWheelStep } satisfies PdfReaderHostMessage, PDF_READER_ORIGIN);
  }, [instanceId, zoomWheelStep]);
  const callbacksRef = useRef({ onCopyText, onQuoteText, onOpenLink });
  callbacksRef.current = { onCopyText, onQuoteText, onOpenLink };

  useEffect(() => {
    let active = true;
    let sent = false;
    let failed = false;
    const fail = (message: string) => {
      if (!active || failed) return;
      failed = true;
      initializedRef.current = false;
      clearTimeout(startupTimer);
      setError(message);
      setState("error");
    };
    const startupTimer = setTimeout(() => fail(
      "The PDF viewer did not respond within 15 seconds. Reload the preview to try again."), 15_000);
    const send = (message: PdfReaderHostMessage, transfer: Transferable[] = []) => {
      frameRef.current?.contentWindow?.postMessage(message, PDF_READER_ORIGIN, transfer);
    };
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (!active || failed || event.source !== frameRef.current?.contentWindow || event.origin !== PDF_READER_ORIGIN
        || !isPdfReaderFrameMessage(event.data, instanceId)) return;
      const message = event.data;
      if (message.type === "ready") {
        if (sent || !hostRef.current) return;
        clearTimeout(startupTimer);
        sent = true;
        initializedRef.current = true;
        const copy = bytes.slice().buffer;
        send({ channel: PDF_READER_CHANNEL, instanceId, type: "load", bytes: copy, name,
          canQuote: Boolean(callbacksRef.current.onQuoteText), zoomWheelStep: zoomWheelStepRef.current,
          themeTokens: readThemeTokens(hostRef.current) }, [copy]);
        setState("ready");
      } else if (message.type === "loaded") {
        if (sent) setState("ready");
      } else if (message.type === "error") {
        fail(message.message || "The PDF could not be displayed.");
      } else if (message.type === "selection") {
        setSelection(message.text);
      } else if (message.type === "open-link") {
        // A document message can propose a destination, never invoke a host API.
        setPendingLink((current) => current ?? message.target);
      }
    };
    window.addEventListener("message", handleMessage);
    const observer = new MutationObserver(() => {
      if (sent && hostRef.current) send({ channel: PDF_READER_CHANNEL, instanceId, type: "theme", themeTokens: readThemeTokens(hostRef.current) });
    });
    for (let element: HTMLElement | null = hostRef.current; element; element = element.parentElement) {
      observer.observe(element, { attributes: true, attributeFilter: ["class", "style"] });
    }
    return () => {
      active = false;
      clearTimeout(startupTimer);
      initializedRef.current = false;
      observer.disconnect();
      window.removeEventListener("message", handleMessage);
    };
  }, [bytes, instanceId, name]);

  return (
    <span ref={hostRef} className="session-pdf-preview" aria-label="PDF Reader" aria-busy={state === "loading" || undefined}>
      {selection.trim() ? (
        <span className="session-pdf-selection-actions" role="group" aria-label="Selected PDF Text">
          <button type="button" onClick={() => callbacksRef.current.onCopyText(selection)}>Copy</button>
          {onQuoteText ? <button type="button" onClick={() => callbacksRef.current.onQuoteText?.(selection)}>Quote</button> : null}
        </span>
      ) : null}
      {pendingLink !== null ? (
        <span className="session-pdf-link-confirmation" role="region" aria-label="Open PDF Link" onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); cancelLink(); }
        }}>
          <span>Open Link</span>
          <bdi className="session-pdf-link-target">{pendingLink}</bdi>
          <button ref={openLinkButtonRef} type="button" onClick={() => { const target = pendingLink; cancelLink(); callbacksRef.current.onOpenLink(target); }}>Open</button>
          <button type="button" onClick={cancelLink}>Cancel</button>
        </span>
      ) : null}
      {state === "loading" ? <span className="session-pdf-loading"><LoadingIndicator label="Loading PDF" /></span> : null}
      {state === "error" ? <span className="session-file-preview-error" role="alert">{error}</span> : null}
      <iframe ref={frameRef} className="session-pdf-frame" title={`PDF Reader: ${name}`}
        src={`${PDF_READER_URL}#${new URLSearchParams({ instanceId, hostOrigin: window.location.protocol === "file:" ? "null" : window.location.origin })}`} sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer" hidden={state === "error"} />
    </span>
  );
}
