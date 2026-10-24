import { useEffect, useRef, useState } from "react";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { LoadingIndicator } from "../loading-indicator.js";
import { HTML_PREVIEW_MAX_BYTES } from "../../../src-shared/file-explorer/session-html-preview-contract.js";

export function HtmlPreview({ html, title, className = "", onFind }: {
  html: string; title: string; className?: string; onFind?: () => void;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const viewport = useRef<HTMLSpanElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const find = useRef(onFind);
  find.current = onFind;
  const [intersects, setIntersects] = useState(false);
  const [state, setState] = useState<{ loading: boolean; url?: string; error?: string; warning?: string }>({ loading: true });

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) setState({ loading: true });
      setIntersects(entry.isIntersecting);
    });
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!intersects) return;
    const api = getWithMateApi();
    if (!api) { setState({ loading: false, error: "HTML Preview is unavailable." }); return; }
    if (new TextEncoder().encode(html).byteLength > HTML_PREVIEW_MAX_BYTES) {
      setState({ loading: false, error: "HTML Preview is limited to 50 MiB. Use Source to view this file." });
      return;
    }
    const id = crypto.randomUUID();
    let canceled = false;
    let failed = false;
    setState({ loading: true });
    const unsubscribe = api.subscribeHtmlPreviewEvents((event) => {
      if (event.id !== id || canceled || failed) return;
      if (event.type === "return-focus" || event.type === "find") {
        root.current?.focus();
        if (event.type === "find") find.current?.();
      } else if (event.type === "error") {
        failed = true;
        setState({ loading: false, error: event.message });
      } else if (event.type === "warning") setState((previous) => ({ ...previous, warning: event.message }));
      else if (event.type === "ready") setState((previous) => ({ ...previous, loading: false }));
    });
    void api.mountHtmlPreview({ id, html }).then((url) => {
      if (!canceled && !failed) setState((previous) => ({ ...previous, url }));
    }, (error: unknown) => {
      if (!canceled && !failed) setState({ loading: false, error: error instanceof Error ? error.message : "HTML Preview failed to load." });
    });
    return () => {
      canceled = true;
      unsubscribe();
      void api.disposeHtmlPreview(id).catch(() => { /* Owner navigation can dispose the document first. */ });
    };
  }, [html, intersects]);

  return <span ref={root} className={`html-preview ${className}`} role="group" tabIndex={0} aria-label={title}
    aria-description="Press Enter to interact with HTML. Press F6 to return to the app."
    onKeyDown={(event) => {
      if (event.key === "Enter" && iframe.current) {
        event.preventDefault();
        iframe.current.focus();
      }
    }}>
    {state.warning && !state.error && <span className="html-preview-notice" role="status">{state.warning}</span>}
    <span ref={viewport} className="html-preview-viewport" aria-busy={state.loading}>
      {intersects && state.url && !state.error && <iframe ref={iframe} className="html-preview-frame"
        src={state.url} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" tabIndex={-1} />}
      {state.error ? <span className="html-preview-notice" role="alert">{state.error}</span>
        : state.loading ? <LoadingIndicator label="Loading HTML preview" /> : null}
    </span>
  </span>;
}
