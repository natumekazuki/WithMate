import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { OptionalContentConfig } from "pdfjs-dist/types/src/display/optional_content_config.js";
import type { PDFLinkService } from "pdfjs-dist/web/pdf_viewer.mjs";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import "./pdf-sidebar.css";

export type PdfSidebarProps = {
  document: PDFDocumentProxy;
  currentPage: number;
  pageLabels: string[] | null;
  rotation: number;
  optionalContentConfigPromise: Promise<OptionalContentConfig>;
  layerRevision: number;
  onGoToPage: (page: number) => void;
  onGoToDestination: (destination: string | unknown[]) => void;
  onSetOCGState: (action: Parameters<PDFLinkService["executeSetOCGState"]>[0]) => void;
  onOpenLink: (url: string) => void;
  onOpenAttachment: (name: string, bytes: Uint8Array) => void;
  onLayersChanged: (config: OptionalContentConfig) => void;
};

type View = "Thumbnails" | "Outline" | "Layers" | "Attachments" | "Info";
type OutlineNode = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number] & {
  setOCGState?: Parameters<PDFLinkService["executeSetOCGState"]>[0];
};
type ReadResult<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useDocumentData<T>(load: () => Promise<T>, dependencies: readonly unknown[]) {
  const [result, setResult] = useState<ReadResult<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setResult({ status: "loading" });
    void load().then(
      (value) => { if (active) setResult({ status: "ready", value }); },
      (error: unknown) => { if (active) setResult({ status: "error", message: errorMessage(error) }); },
    );
    return () => { active = false; };
  }, [...dependencies, attempt]);
  return { result, retry: () => setAttempt((value) => value + 1) };
}

function ReadFeedback({ result, retry, label }: { result: ReadResult<unknown>; retry: () => void; label: string }) {
  if (result.status === "loading") return <LoadingIndicator label={label} />;
  if (result.status !== "error") return null;
  return <div className="pdf-sidebar-error"><p role="alert">{result.message}</p><button type="button" onClick={retry}>Retry</button></div>;
}

function Thumbnail({ document, pageNumber, label, rotation, selected, onGoToPage, optionalContentConfigPromise, layerRevision }: {
  document: PDFDocumentProxy; pageNumber: number; label: string; rotation: number; selected: boolean;
  onGoToPage: (page: number) => void; optionalContentConfigPromise: Promise<OptionalContentConfig>; layerRevision: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<ReadResult<null>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let active = true;
    let task: RenderTask | undefined;
    setStatus({ status: "loading" });
    void (async () => {
      const page = await document.getPage(pageNumber);
      if (!active) return;
      const angle = (page.rotate + rotation) % 360;
      const original = page.getViewport({ scale: 1, rotation: angle });
      const viewport = page.getViewport({ scale: Math.min(140 / original.width, 156 / original.height), rotation: angle });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      task = page.render({ canvas, viewport, annotationMode: 0, optionalContentConfigPromise });
      await task.promise;
      if (active) setStatus({ status: "ready", value: null });
    })().catch((error: unknown) => { if (active) setStatus({ status: "error", message: errorMessage(error) }); });
    return () => {
      active = false;
      task?.cancel();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [document, pageNumber, rotation, optionalContentConfigPromise, layerRevision, attempt]);
  return <div className="pdf-thumbnail-item">
    <button type="button" className="pdf-thumbnail" aria-label={`Go to page ${label}`} aria-current={selected ? "page" : undefined} onClick={() => onGoToPage(pageNumber)}>
      <span className="pdf-thumbnail-image">
        <canvas ref={canvasRef} aria-hidden="true" hidden={status.status !== "ready"} />
        {status.status === "loading" && <LoadingIndicator label={`Loading page ${label} thumbnail`} />}
        {status.status === "error" && <span>Preview Unavailable</span>}
      </span>
      <span className="pdf-thumbnail-label">{label}</span>
    </button>
    {status.status === "error" && <button type="button" className="pdf-thumbnail-retry" title={status.message} onClick={() => setAttempt((value) => value + 1)} aria-label={`Retry page ${label} thumbnail`}>Retry</button>}
  </div>;
}

function Thumbnails(props: PdfSidebarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: props.document.numPages, getScrollElement: () => scrollRef.current, estimateSize: () => 206, overscan: 2 });
  useEffect(() => { virtualizer.scrollToIndex(props.currentPage - 1, { align: "auto" }); }, [props.currentPage, virtualizer]);
  return <div ref={scrollRef} className="pdf-thumbnail-scroll" tabIndex={0} aria-label="Page Thumbnails">
    <div className="pdf-thumbnail-list" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => <div key={item.key} className="pdf-thumbnail-slot" style={{ transform: `translateY(${item.start}px)` }}>
        <Thumbnail document={props.document} pageNumber={item.index + 1} label={props.pageLabels?.[item.index] || String(item.index + 1)} rotation={props.rotation} selected={props.currentPage === item.index + 1} onGoToPage={props.onGoToPage} optionalContentConfigPromise={props.optionalContentConfigPromise} layerRevision={props.layerRevision} />
      </div>)}
    </div>
  </div>;
}

function OutlineItems({ items, onGoToDestination, onOpenLink, onSetOCGState }: { items: OutlineNode[] } & Pick<PdfSidebarProps, "onGoToDestination" | "onOpenLink" | "onSetOCGState">) {
  return <ul className="pdf-outline-list">{items.map((item, index) => {
    const title = <span style={{ fontWeight: item.bold ? 700 : undefined, fontStyle: item.italic ? "italic" : undefined }}>{item.title}</span>;
    const url = item.url || item.unsafeUrl;
    const content = url || item.dest || item.setOCGState ? <button type="button" className="pdf-outline-link" onClick={() => {
      if (url) onOpenLink(url);
      else if (item.dest) onGoToDestination(item.dest);
      else if (item.setOCGState) onSetOCGState(item.setOCGState);
    }}>{title}</button> : title;
    return <li key={index}>{item.items?.length ? <details open={!(item.count !== undefined && item.count < 0)}><summary>{content}</summary><OutlineItems items={item.items} onGoToDestination={onGoToDestination} onOpenLink={onOpenLink} onSetOCGState={onSetOCGState} /></details> : content}</li>;
  })}</ul>;
}

function Outline(props: PdfSidebarProps) {
  const { result, retry } = useDocumentData(() => props.document.getOutline(), [props.document]);
  return <><ReadFeedback result={result} retry={retry} label="Loading outline" />{result.status === "ready" && result.value && <OutlineItems items={result.value} onGoToDestination={props.onGoToDestination} onOpenLink={props.onOpenLink} onSetOCGState={props.onSetOCGState} />}</>;
}

type LayerOrder = (string | { name: string | null; order: LayerOrder })[];

function LayerItems({ order, config, onChange }: { order: LayerOrder; config: OptionalContentConfig; onChange: () => void }) {
  return <ul className="pdf-layer-list">{order.map((entry, index) => {
    if (typeof entry !== "string") return <li key={index}>{entry.name && <span className="pdf-layer-heading">{entry.name}</span>}<LayerItems order={entry.order} config={config} onChange={onChange} /></li>;
    const group = config.getGroup(entry) as { name: string; visible: boolean } | null;
    if (!group) return null;
    return <li key={entry}><label><input type="checkbox" checked={group.visible} onChange={(event) => { config.setVisibility(entry, event.target.checked); onChange(); }} /><span>{group.name}</span></label></li>;
  })}</ul>;
}

function Attachments(props: PdfSidebarProps) {
  const { result, retry } = useDocumentData(() => props.document.getAttachments(), [props.document]);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  useEffect(() => {
    requestGeneration.current += 1;
    setOpening(null);
    setError(null);
    return () => { requestGeneration.current += 1; };
  }, [props.document]);
  async function open(id: string, filename: string) {
    const generation = requestGeneration.current;
    setOpening(id);
    setError(null);
    try {
      const bytes = await props.document.getAttachmentContent(id);
      if (requestGeneration.current !== generation) return;
      if (!bytes) throw new Error("This attachment has no readable content.");
      props.onOpenAttachment(filename, bytes);
    } catch (reason) {
      if (requestGeneration.current === generation) setError(errorMessage(reason));
    } finally {
      if (requestGeneration.current === generation) setOpening(null);
    }
  }
  return <><ReadFeedback result={result} retry={retry} label="Loading attachments" />{error && <p className="pdf-sidebar-error" role="alert">{error}</p>}
    {result.status === "ready" && result.value && <ul className="pdf-attachment-list">{Array.from(result.value, ([id, attachment]) => <li key={id}>
      <button type="button" disabled={opening !== null} aria-label={`Open ${attachment.filename}`} aria-busy={opening === id} onClick={() => void open(id, attachment.filename)}>
        <span className={opening === id ? "pdf-attachment-name pdf-attachment-name-busy" : "pdf-attachment-name"}>{attachment.filename}</span>
        {opening === id && <LoadingIndicator label={`Opening ${attachment.filename}`} />}
      </button>
      {attachment.description && <p>{attachment.description}</p>}
    </li>)}</ul>}
  </>;
}

function Info(props: PdfSidebarProps) {
  const metadata = useDocumentData(() => props.document.getMetadata(), [props.document]);
  const page = useDocumentData(async () => {
    const value = await props.document.getPage(props.currentPage);
    const viewport = value.getViewport({ scale: 1, rotation: (value.rotate + props.rotation) % 360 });
    return `${(viewport.width / 72 * 25.4).toLocaleString("en-US", { maximumFractionDigits: 1 })} × ${(viewport.height / 72 * 25.4).toLocaleString("en-US", { maximumFractionDigits: 1 })} mm`;
  }, [props.document, props.currentPage, props.rotation]);
  const info = metadata.result.status === "ready" ? metadata.result.value.info as Record<string, unknown> : {};
  return <><ReadFeedback result={metadata.result} retry={metadata.retry} label="Loading document information" />
    <dl className="pdf-document-info">
      {[ ["Title", info.Title], ["Author", info.Author], ["Subject", info.Subject], ["PDF Version", info.PDFFormatVersion] ].map(([label, value]) => typeof value === "string" && value.trim() ? <div key={String(label)}><dt>{String(label)}</dt><dd>{value}</dd></div> : null)}
      <div><dt>Pages</dt><dd>{props.document.numPages.toLocaleString("en-US")}</dd></div>
      <div><dt>Current Page Size</dt><dd>{page.result.status === "ready" ? page.result.value : <ReadFeedback result={page.result} retry={page.retry} label="Loading page size" />}</dd></div>
    </dl>
  </>;
}

export function PdfSidebar(props: PdfSidebarProps) {
  const [view, setView] = useState<View>("Thumbnails");
  const layers = useDocumentData(() => props.optionalContentConfigPromise, [props.optionalContentConfigPromise]);
  const config = layers.result.status === "ready" ? layers.result.value : null;
  return <aside className="pdf-sidebar" aria-label="PDF Sidebar">
    <div className="pdf-sidebar-header"><select aria-label="Sidebar View" value={view} onChange={(event) => setView(event.target.value as View)}>{(["Thumbnails", "Outline", "Layers", "Attachments", "Info"] as const).map((name) => <option key={name}>{name}</option>)}</select></div>
    {view === "Thumbnails" ? <Thumbnails {...props} /> : <div className="pdf-sidebar-content">
      {view === "Outline" && <Outline {...props} />}
      {view === "Layers" && <><ReadFeedback result={layers.result} retry={layers.retry} label="Loading layers" />{config && <LayerItems order={(config.getOrder() || []) as LayerOrder} config={config} onChange={() => props.onLayersChanged(config)} />}</>}
      {view === "Attachments" && <Attachments {...props} />}
      {view === "Info" && <Info {...props} />}
    </div>}
  </aside>;
}
