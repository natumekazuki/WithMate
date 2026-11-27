import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import {
  PDF_READER_CHANNEL,
  PDF_READER_THEME_TOKENS,
  type PdfReaderFrameMessage,
  type PdfReaderHostMessage,
} from "../../src-shared/file-explorer/pdf-reader-contract.js";
import { PdfReaderApp } from "./PdfReaderApp.js";
import { readPdfSelection } from "./pdf-reader-selection.js";
import "./pdf-reader.css";

const parameters = new URLSearchParams(location.hash.slice(1));
const instanceId = parameters.get("instanceId") ?? "";
const hostOrigin = parameters.get("hostOrigin") ?? "";
type FramePayload = PdfReaderFrameMessage extends infer Message
  ? Message extends PdfReaderFrameMessage ? Omit<Message, "channel" | "instanceId"> : never : never;

function send(message: FramePayload) {
  window.parent.postMessage({ ...message, channel: PDF_READER_CHANNEL, instanceId }, hostOrigin === "null" ? "*" : hostOrigin);
}

function applyTheme(tokens: Record<string, string>) {
  for (const token of PDF_READER_THEME_TOKENS) {
    if (typeof tokens[token] === "string" && tokens[token]) document.documentElement.style.setProperty(token, tokens[token]);
  }
}

function App() {
  const [file, setFile] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [zoomWheelStep, setZoomWheelStep] = useState<number | null>(5);
  const [findRevision, setFindRevision] = useState(0);
  useEffect(() => {
    let loaded = false;
    const receive = (event: MessageEvent<PdfReaderHostMessage>) => {
      const message = event.data;
      if (event.source !== window.parent || event.origin !== hostOrigin || !message
        || message.channel !== PDF_READER_CHANNEL || message.instanceId !== instanceId) return;
      if (message.type === "load" && !loaded && message.bytes instanceof ArrayBuffer && typeof message.name === "string") {
        loaded = true;
        applyTheme(message.themeTokens);
        setZoomWheelStep(message.zoomWheelStep);
        setFile({ bytes: new Uint8Array(message.bytes), name: message.name });
      } else if (message.type === "theme") {
        applyTheme(message.themeTokens);
      } else if (message.type === "settings") {
        setZoomWheelStep(message.zoomWheelStep);
      } else if (message.type === "find") {
        setFindRevision((current) => current + 1);
      } else if (loaded && message.type === "get-selection" && typeof message.requestId === "string"
        && message.requestId.length > 0 && message.requestId.length <= 128) {
        send({ type: "selection", text: readPdfSelection(document), requestId: message.requestId });
      }
    };
    const selection = () => send({ type: "selection", text: readPdfSelection(document) });
    window.addEventListener("message", receive);
    document.addEventListener("selectionchange", selection);
    send({ type: "ready" });
    return () => {
      window.removeEventListener("message", receive);
      document.removeEventListener("selectionchange", selection);
    };
  }, []);
  return file ? <PdfReaderApp file={file} zoomWheelStep={zoomWheelStep} findRevision={findRevision}
    onLoaded={() => send({ type: "loaded" })}
    onError={(message) => send({ type: "error", message })}
    onSelection={(text) => send({ type: "selection", text })}
    onOpenLink={(target) => send({ type: "open-link", target })} /> : null;
}

createRoot(document.getElementById("root")!).render(<App />);
