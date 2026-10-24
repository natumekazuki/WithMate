import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { createPdfReader, FindState, ScrollMode, SpreadMode, type PdfPosition, type PdfReaderEngine } from "./pdf-reader-engine.js";
import { PdfSidebar } from "./PdfSidebar.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { useViewportPan } from "../ui/viewport-pan.js";
import "pdfjs-dist/web/pdf_viewer.css";

type ReaderFile = { name: string; bytes: Uint8Array; incarnation?: number };
type ReaderProps = {
  file: ReaderFile;
  zoomWheelStep: number | null;
  findRevision: number;
  onLoaded: () => void;
  onError: (message: string) => void;
  onSelection: (text: string) => void;
  onOpenLink: (target: string) => void;
};
type PasswordRequest = { submit: (password: string) => void; incorrect: boolean };
type FindOptions = { caseSensitive: boolean; entireWord: boolean; matchDiacritics: boolean };

function PasswordPrompt({ request, onCancel }: { request: PasswordRequest; onCancel: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const submit = () => { const password = value; setValue(""); request.submit(password); };
  useEffect(() => { setValue(""); inputRef.current?.focus(); }, [request]);
  return <div className="pdf-password-backdrop">
    <div className="pdf-password" role="dialog" aria-modal="true" aria-label="PDF Password"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
        if (event.key === "Enter" && event.target === inputRef.current) { event.preventDefault(); submit(); }
        if (event.key === "Tab") {
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("input,button:not(:disabled)"));
          if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
        }
      }}>
      <label htmlFor="pdf-password">PDF Password</label>
      <input ref={inputRef} id="pdf-password" type="password" autoComplete="off" value={value}
        aria-invalid={request.incorrect || undefined} onChange={(event) => setValue(event.currentTarget.value)} />
      {request.incorrect && <p role="alert">The password is incorrect. Try again.</p>}
      <div className="pdf-password-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="button" onClick={submit}>Unlock</button></div>
    </div>
  </div>;
}

function PdfDocumentView({ file, zoomWheelStep, findRevision, onLoaded, onError, onSelection, onOpenLink, onOpenAttachment, active = true }: ReaderProps & {
  onOpenAttachment: (name: string, bytes: Uint8Array) => void;
  active?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PdfReaderEngine | null>(null);
  const callbacks = useRef({ onLoaded, onError, onSelection, onOpenLink, onOpenAttachment });
  callbacks.current = { onLoaded, onError, onSelection, onOpenLink, onOpenAttachment };
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState<PasswordRequest | null>(null);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [labels, setLabels] = useState<string[] | null>(null);
  const [scale, setScale] = useState(1);
  const [scaleValue, setScaleValue] = useState("page-width");
  const [rotation, setRotation] = useState(0);
  const [layout, setLayout] = useState("continuous");
  const [sidebar, setSidebar] = useState(false);
  const [layerRevision, setLayerRevision] = useState(0);
  const optionalContentConfigPromise = useMemo(() => pdf ? engineRef.current!.viewer.optionalContentConfigPromise.then((config) => {
    if (!config) throw new Error("PDF layers are unavailable.");
    return config;
  }) : null, [pdf, layerRevision]);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [findOptions, setFindOptions] = useState<FindOptions>({ caseSensitive: false, entireWord: false, matchDiacritics: false });
  const [findCount, setFindCount] = useState({ current: 0, total: 0 });
  const [findPending, setFindPending] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);
  const history = useRef<{ back: PdfPosition[]; forward: PdfPosition[] }>({ back: [], forward: [] });
  const position = useRef<PdfPosition>({ page: 1, left: 0, top: 0, scale: 1, rotation: 0 });
  const [historyCount, setHistoryCount] = useState({ back: 0, forward: 0 });
  const pan = useViewportPan(file.name);
  const updateHistory = () => setHistoryCount({ back: history.current.back.length, forward: history.current.forward.length });
  const rememberPosition = useCallback(() => {
    engineRef.current?.viewer.update();
    history.current.back.push({ ...position.current });
    history.current.forward = [];
    updateHistory();
  }, []);
  const moveHistory = useCallback((direction: "back" | "forward") => {
    const engine = engineRef.current;
    engine?.viewer.update();
    const target = history.current[direction].pop();
    if (!engine || !target) return;
    history.current[direction === "back" ? "forward" : "back"].push({ ...position.current });
    engine.viewer.pagesRotation = target.rotation;
    engine.viewer.scrollPageIntoView({ pageNumber: target.page,
      destArray: [null, { name: "XYZ" }, target.left, target.top, target.scale] });
    updateHistory();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const pages = pagesRef.current;
    if (!container || !pages) return;
    let active = true;
    const reportError = (message: string) => { if (active) { setError(message); setPassword(null); callbacks.current.onError(message); } };
    let engine: PdfReaderEngine;
    try { engine = createPdfReader(container, pages, {
      openLink: (target) => callbacks.current.onOpenLink(target),
      beforeNavigate: rememberPosition,
      back: () => moveHistory("back"), forward: () => moveHistory("forward"),
      error: reportError,
      password: (submit, incorrect) => setPassword({ submit: (value) => { setPassword(null); submit(value); }, incorrect }),
      attachment: (name, bytes) => callbacks.current.onOpenAttachment(name, bytes),
    }); } catch (failure) {
      reportError(failure instanceof Error ? failure.message : "The PDF reader could not be started.");
      return;
    }
    engineRef.current = engine;
    engine.eventBus.on("optionalcontentconfigchanged", () => { if (active) setLayerRevision((value) => value + 1); });
    engine.eventBus.on("pagesinit", () => { if (active) engine.viewer.currentScaleValue = "page-width"; });
    engine.eventBus.on("pagechanging", ({ pageNumber, pageLabel }: { pageNumber: number; pageLabel: string | null }) => {
      if (active) { setPage(pageNumber); setPageInput(pageLabel ?? String(pageNumber)); }
    });
    engine.eventBus.on("scalechanging", ({ scale: next }: { scale: number }) => {
      if (active) { setScale(next); setScaleValue(engine.viewer.currentScaleValue); }
    });
    engine.eventBus.on("rotationchanging", ({ pagesRotation }: { pagesRotation: number }) => { if (active) setRotation(pagesRotation); });
    engine.eventBus.on("scrollmodechanged", ({ mode }: { mode: number }) => {
      if (active && mode === ScrollMode.PAGE) setLayout("single");
    });
    engine.eventBus.on("updateviewarea", ({ location }: { location: { pageNumber: number; left: number; top: number } }) => {
      position.current = { page: location.pageNumber, left: location.left, top: location.top,
        scale: engine.viewer.currentScale, rotation: engine.viewer.pagesRotation };
      if (active) setScaleValue(engine.viewer.currentScaleValue);
    });
    engine.eventBus.on("updatefindmatchescount", ({ matchesCount }: { matchesCount: { current: number; total: number } }) => {
      if (active) setFindCount(matchesCount);
    });
    engine.eventBus.on("updatefindcontrolstate", ({ state, matchesCount }: { state: number; matchesCount: { current: number; total: number } }) => {
      if (active) { setFindPending(state === FindState.PENDING); setFindCount(matchesCount); }
    });
    let firstRendered = false;
    engine.eventBus.on("pagerendered", ({ error: renderError }: { error?: unknown }) => {
      if (!active) return;
      if (renderError) { reportError(renderError instanceof Error ? renderError.message : "A PDF page could not be rendered."); return; }
      if (!firstRendered) { firstRendered = true; setReady(true); callbacks.current.onLoaded(); }
    });
    void engine.load(file.bytes).then(async (document) => {
      await Promise.race([engine.viewer.firstPagePromise, engine.viewer.pagesPromise]);
      if (!active) return;
      setPdf(document);
      setPassword(null);
      const pageLabels = await document.getPageLabels();
      if (active) { engine.viewer.setPageLabels(pageLabels); setLabels(pageLabels); setPageInput(pageLabels?.[0] ?? "1"); }
      await engine.viewer.pagesPromise;
    }).catch((failure) => { if (active) reportError(failure instanceof Error ? failure.message : "The PDF could not be loaded."); });
    const selection = () => {
      const current = window.getSelection();
      const anchor = current?.anchorNode;
      const focus = current?.focusNode;
      if (current && anchor && focus && pages.contains(anchor) && pages.contains(focus)) {
        callbacks.current.onSelection(current.toString().slice(0, 1_000_000));
      } else if (!current || current.isCollapsed) callbacks.current.onSelection("");
    };
    document.addEventListener("selectionchange", selection);
    return () => {
      active = false;
      document.removeEventListener("selectionchange", selection);
      callbacks.current.onSelection("");
      engine.destroy();
      engineRef.current = null;
    };
  }, [file, moveHistory, rememberPosition]);

  const openFind = useCallback(() => { setFindOpen(true); requestAnimationFrame(() => { findInputRef.current?.focus(); findInputRef.current?.select(); }); }, []);
  const closeFind = () => { setFindOpen(false); engineRef.current?.eventBus.dispatch("findbarclose", { source: null }); containerRef.current?.focus(); };
  useEffect(() => { if (active && ready && !password && findRevision > 0) openFind(); }, [active, ready, password, findRevision, openFind]);
  const find = useCallback((again = false, previous = false) => {
    engineRef.current?.eventBus.dispatch("find", { source: null, type: again ? "again" : "", query,
      ...findOptions, highlightAll: true, findPrevious: previous });
  }, [query, findOptions]);
  useEffect(() => { if (findOpen) find(); }, [find, findOpen]);
  const setZoom = useCallback((value: number) => {
    const viewer = engineRef.current?.viewer;
    if (!viewer) return;
    viewer.currentScale = value;
    setScaleValue(viewer.currentScaleValue);
  }, []);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault(); event.stopPropagation();
      if (zoomWheelStep !== null && engineRef.current) {
        const viewer = engineRef.current.viewer;
        setZoom(Math.min(8, Math.max(0.1, viewer.currentScale + (event.deltaY < 0 ? 1 : -1) * zoomWheelStep / 100)));
      }
    };
    container.addEventListener("wheel", wheel, { passive: false });
    return () => container.removeEventListener("wheel", wheel);
  }, [zoomWheelStep, setZoom]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!active || password) return;
      const modifier = event.ctrlKey || event.metaKey;
      const target = event.target as HTMLElement | null;
      if (modifier && event.key.toLowerCase() === "f") { event.preventDefault(); openFind(); }
      else if (modifier && event.key.toLowerCase() === "g") { event.preventDefault(); find(true, event.shiftKey); }
      else if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); moveHistory("back"); }
      else if (event.altKey && event.key === "ArrowRight") { event.preventDefault(); moveHistory("forward"); }
      else if (event.key === "Escape" && findOpen && !password) { event.preventDefault(); closeFind(); }
      else if (!target?.matches("input,textarea,select,button") && !modifier && (event.key === "Home" || event.key === "End")) {
        event.preventDefault(); engineRef.current?.linkService.goToPage(event.key === "Home" ? 1 : pdf?.numPages ?? 1);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, find, findOpen, moveHistory, openFind, password, pdf]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const viewer = engineRef.current?.viewer;
      if (!viewer?.pdfDocument) return;
      if (["page-width", "page-fit"].includes(viewer.currentScaleValue)) viewer.currentScaleValue = viewer.currentScaleValue;
      viewer.update();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const changeZoom = (change: number) => {
    const viewer = engineRef.current?.viewer;
    if (viewer) setZoom(Math.max(0.1, Math.min(8, Math.round((viewer.currentScale + change) * 100) / 100)));
  };
  const goToPage = (value: string | number) => {
    if (!pdf) return;
    const labelIndex = typeof value === "string" ? labels?.indexOf(value) ?? -1 : -1;
    const target = labelIndex >= 0 ? labelIndex + 1 : Number(value);
    if (Number.isInteger(target) && target >= 1 && target <= pdf.numPages) engineRef.current?.linkService.goToPage(target);
    else setPageInput(labels?.[page - 1] ?? String(page));
  };
  return <section className="pdf-reader-document" aria-label={`PDF: ${file.name}`} aria-busy={!ready && !password && !error || undefined}>
    <div className="pdf-reader-toolbar" role="toolbar" aria-label="PDF Viewing Controls">
      <button type="button" disabled={!ready} aria-pressed={sidebar} title="Sidebar" aria-label="Toggle PDF sidebar" onClick={() => setSidebar((value) => !value)}>☷</button>
      <div className="pdf-control-group" role="group" aria-label="PDF Navigation">
        <button type="button" title="Back" aria-label="Previous view" disabled={!historyCount.back} onClick={() => moveHistory("back")}>←</button>
        <button type="button" title="Forward" aria-label="Next view" disabled={!historyCount.forward} onClick={() => moveHistory("forward")}>→</button>
        <button type="button" title="Previous Page" aria-label="Previous page" disabled={!ready || page <= 1} onClick={() => goToPage(page - 1)}>‹</button>
        <input className="pdf-page-input" aria-label="Page number or label" value={pageInput} disabled={!ready}
          onChange={(event) => setPageInput(event.currentTarget.value)} onBlur={() => setPageInput(labels?.[page - 1] ?? String(page))}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); goToPage(pageInput); } }} />
        <span className="pdf-page-count" aria-label={`${pdf?.numPages ?? 0} pages`}>/ {pdf?.numPages ?? "—"}</span>
        <button type="button" title="Next Page" aria-label="Next page" disabled={!ready || page >= (pdf?.numPages ?? 1)} onClick={() => goToPage(page + 1)}>›</button>
      </div>
      <div className="pdf-control-group" role="group" aria-label="PDF Zoom">
        <button type="button" aria-label="Zoom out" disabled={!ready || scale <= 0.1} onClick={() => changeZoom(-0.1)}>−</button>
        <button type="button" className="pdf-zoom-value" aria-label="Reset PDF zoom to 100%" disabled={!ready} onClick={() => setZoom(1)}>{Math.round(scale * 100)}%</button>
        <button type="button" aria-label="Zoom in" disabled={!ready || scale >= 8} onClick={() => changeZoom(0.1)}>＋</button>
        <select aria-label="PDF zoom mode" value={scaleValue === "page-width" || scaleValue === "page-fit" ? scaleValue : "custom"} disabled={!ready} onChange={(event) => { if (engineRef.current) engineRef.current.viewer.currentScaleValue = event.currentTarget.value; }}>
          <option value="custom" disabled>Custom</option><option value="page-width">Width</option><option value="page-fit">Page</option>
        </select>
      </div>
      <button type="button" disabled={!ready} aria-label="Rotate clockwise" title="Rotate Clockwise" onClick={() => {
        if (engineRef.current) engineRef.current.viewer.pagesRotation = (rotation + 90) % 360;
      }}>↻</button>
      <select aria-label="Page layout" disabled={!ready} value={layout} onChange={(event) => {
        const value = event.currentTarget.value; setLayout(value);
        const viewer = engineRef.current?.viewer;
        if (!viewer) return;
        viewer.scrollMode = value === "single" ? ScrollMode.PAGE : ScrollMode.VERTICAL;
        viewer.spreadMode = value === "spread" ? SpreadMode.ODD : value === "cover" ? SpreadMode.EVEN : SpreadMode.NONE;
      }}><option value="continuous">Continuous</option><option value="single">Single Page</option><option value="spread">Two Pages</option><option value="cover">Two Pages With Cover</option></select>
      <button type="button" disabled={!ready} aria-pressed={findOpen} onClick={openFind}>Find</button>
    </div>
    {findOpen && <div className="pdf-findbar" role="search" aria-label="Find in PDF" onKeyDown={(event) => {
      if (event.key === "Enter") { event.preventDefault(); find(true, event.shiftKey); }
    }}>
      <input ref={findInputRef} type="search" aria-label="Find text in PDF" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
      <button type="button" aria-label="Previous match" disabled={!query} onClick={() => find(true, true)}>↑</button>
      <button type="button" aria-label="Next match" disabled={!query} onClick={() => find(true)}>↓</button>
      <span className="pdf-find-count" role="status" aria-live="polite">{findPending ? <LoadingIndicator label="Searching PDF" inline /> : `${findCount.current} / ${findCount.total}`}</span>
      <label><input type="checkbox" checked={findOptions.caseSensitive} onChange={(event) => { const checked = event.currentTarget.checked; setFindOptions((value) => ({ ...value, caseSensitive: checked })); }} />Match Case</label>
      <label><input type="checkbox" checked={findOptions.entireWord} onChange={(event) => { const checked = event.currentTarget.checked; setFindOptions((value) => ({ ...value, entireWord: checked })); }} />Whole Words</label>
      <label><input type="checkbox" checked={findOptions.matchDiacritics} onChange={(event) => { const checked = event.currentTarget.checked; setFindOptions((value) => ({ ...value, matchDiacritics: checked })); }} />Match Diacritics</label>
      <button type="button" aria-label="Close PDF search" onClick={closeFind}>×</button>
    </div>}
    {error && <p className="pdf-reader-error" role="alert">{error}</p>}
    <div className="pdf-reader-body">
      {pdf && optionalContentConfigPromise && <aside className="pdf-reader-sidebar-host" hidden={!sidebar} aria-label="PDF Sidebar"><PdfSidebar document={pdf} currentPage={page} pageLabels={labels} rotation={rotation}
        optionalContentConfigPromise={optionalContentConfigPromise} layerRevision={layerRevision}
        onGoToPage={goToPage} onGoToDestination={(destination) => { void engineRef.current?.linkService.goToDestination(destination); }}
        onSetOCGState={(action) => { void engineRef.current?.linkService.executeSetOCGState(action); }}
        onOpenLink={onOpenLink} onOpenAttachment={onOpenAttachment}
        onLayersChanged={(config) => { if (engineRef.current) engineRef.current.viewer.optionalContentConfigPromise = Promise.resolve(config); }} /></aside>}
      <div className="pdf-reader-pages-host">
        <div ref={containerRef} className={`pdf-reader-scrollport${pan.isPanning ? " is-panning" : ""}`} tabIndex={0} aria-label="PDF Pages"
          onPointerDown={pan.startPan} onPointerMove={pan.movePan} onPointerUp={pan.stopPan} onPointerCancel={pan.stopPan} onLostPointerCapture={pan.handlePanCaptureLoss}
          onClickCapture={(event) => { if (event.ctrlKey) { event.preventDefault(); event.stopPropagation(); } }}
          onAuxClick={(event) => event.preventDefault()}>
          <div ref={pagesRef} className="pdfViewer" />
        </div>
        {!ready && !password && !error && <div className="pdf-reader-loading"><LoadingIndicator label="Rendering PDF" /></div>}
      </div>
    </div>
    {password && <PasswordPrompt request={password} onCancel={() => {
      engineRef.current?.destroy(); setPassword(null); setError("PDF opening was cancelled. Reload to enter a password again.");
      onError("PDF opening was cancelled. Reload to enter a password again.");
    }} />}
  </section>;
}

function AttachmentContent({ attachment, props, onOpenAttachment }: { attachment: ReaderFile; props: ReaderProps; onOpenAttachment: (name: string, bytes: Uint8Array) => void }) {
  const extension = attachment.name.split(".").at(-1)?.toLowerCase();
  const isPdf = extension === "pdf";
  const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" } as Record<string, string>)[extension ?? ""];
  const [url, setUrl] = useState("");
  const [imageError, setImageError] = useState(false);
  useEffect(() => {
    if (!mime) return;
    const source = URL.createObjectURL(new Blob([attachment.bytes.slice().buffer], { type: mime }));
    setUrl(source);
    return () => URL.revokeObjectURL(source);
  }, [attachment, mime]);
  if (isPdf) return <PdfDocumentView {...props} file={attachment} onLoaded={() => undefined} onError={() => undefined} onOpenAttachment={onOpenAttachment} />;
  if (mime) return imageError ? <p className="pdf-reader-error" role="alert">This image attachment could not be displayed.</p>
    : <div className="pdf-attachment-image"><img src={url || undefined} alt={attachment.name} onError={() => setImageError(true)} /></div>;
  if (/^(txt|md|csv|json|jsonc|yaml|yml|log|xml|html|css|js|ts)$/.test(extension ?? "")) {
    try { return <pre className="pdf-attachment-text" tabIndex={0}>{new TextDecoder("utf-8", { fatal: true }).decode(attachment.bytes)}</pre>; }
    catch { return <p className="pdf-reader-error" role="alert">This attachment is not supported UTF-8 text.</p>; }
  }
  return <p className="pdf-reader-error" role="status">This attachment type cannot be previewed. No file was saved or executed.</p>;
}

export function PdfReaderApp(props: ReaderProps) {
  const [attachment, setAttachment] = useState<ReaderFile | null>(null);
  const incarnation = useRef(0);
  const openAttachment = useCallback((name: string, bytes: Uint8Array) => {
    props.onSelection("");
    setAttachment({ name, bytes: bytes.slice(), incarnation: ++incarnation.current });
  }, [props.onSelection]);
  return <main className="pdf-reader-app">
    <div className="pdf-primary-document" hidden={Boolean(attachment)}><PdfDocumentView {...props} active={!attachment} onOpenAttachment={openAttachment} /></div>
    {attachment && <section className="pdf-attachment" aria-label={`Attachment: ${attachment.name}`}>
      <header><button type="button" onClick={() => { props.onSelection(""); setAttachment(null); }}>← Back To Document</button><strong>{attachment.name}</strong></header>
      <AttachmentContent key={attachment.incarnation} attachment={attachment} props={props} onOpenAttachment={openAttachment} />
    </section>}
  </main>;
}
