import { useEffect, useRef, useState } from "react";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { LoadingIndicator } from "../loading-indicator.js";
import type { HtmlPreviewLayout, HtmlPreviewRect } from "../../../src-shared/window/html-preview.js";
import { HTML_PREVIEW_MAX_BYTES } from "../../../src-shared/file-explorer/session-html-preview-contract.js";

function intersect(left: HtmlPreviewRect, right: HtmlPreviewRect): HtmlPreviewRect {
  const x = Math.max(left.x, right.x), y = Math.max(left.y, right.y);
  return { x, y, width: Math.max(0, Math.min(left.x + left.width, right.x + right.width) - x),
    height: Math.max(0, Math.min(left.y + left.height, right.y + right.height) - y) };
}

function measure(element: HTMLElement): HtmlPreviewLayout {
  const rect = element.getBoundingClientRect();
  const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  let clip = intersect(bounds, { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.visibility === "hidden" || style.display === "none") return { bounds, clip, visible: false };
    if (/(auto|scroll|hidden|clip)/u.test(`${style.overflowX} ${style.overflowY}`)) {
      const box = ancestor.getBoundingClientRect();
      const parentClip = { x: box.x + ancestor.clientLeft, y: box.y + ancestor.clientTop,
        width: ancestor.clientWidth, height: ancestor.clientHeight };
      // Each axis clips independently; overflow-visible must not trim that axis.
      if (style.overflowX === "visible") { parentClip.x = clip.x; parentClip.width = clip.width; }
      if (style.overflowY === "visible") { parentClip.y = clip.y; parentClip.height = clip.height; }
      clip = intersect(clip, parentClip);
    }
  }
  const occluded = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], [role="listbox"], :popover-open')]
    .some((surface) => !surface.contains(element) && surface.checkVisibility()
      && (surface.getAttribute("aria-modal") === "true"
        || (intersect(clip, surface.getBoundingClientRect()).width > 0
          && intersect(clip, surface.getBoundingClientRect()).height > 0)));
  return { bounds, clip,
    visible: !document.hidden && !occluded && clip.width > 0 && clip.height > 0 };
}

export function HtmlPreview({ html, title, className = "", onFind }: {
  html: string; title: string; className?: string; onFind?: () => void;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const viewport = useRef<HTMLSpanElement>(null);
  const currentId = useRef<string | null>(null);
  const find = useRef(onFind);
  find.current = onFind;
  const [intersects, setIntersects] = useState(false);
  const [state, setState] = useState<{ loading: boolean; error?: string; warning?: string }>({ loading: true });

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setIntersects(entry.isIntersecting));
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
    currentId.current = id;
    let canceled = false;
    let frame = 0;
    let lastLayout = "";
    let failed = false;
    setState({ loading: true });
    const unsubscribe = api.subscribeHtmlPreviewEvents((event) => {
      if (event.id !== id || canceled) return;
      if (event.type === "return-focus" || event.type === "find") {
        root.current?.focus();
        if (event.type === "find") find.current?.();
      } else if (event.type === "error") {
        failed = true;
        setState({ loading: false, error: event.message });
      } else if (event.type === "warning") setState((previous) => ({ ...previous, warning: event.message }));
    });
    const position = () => {
      if (canceled || failed || !viewport.current) return;
      const layout = measure(viewport.current);
      const serialized = JSON.stringify(layout);
      if (serialized !== lastLayout) {
        api.layoutHtmlPreview(id, layout);
        lastLayout = serialized;
      }
      frame = requestAnimationFrame(position);
    };
    void api.mountHtmlPreview({ id, html }).then(() => {
      if (canceled) return;
      setState((previous) => ({ ...previous, loading: false }));
      position();
    }, (error: unknown) => {
      if (!canceled && !failed) setState({ loading: false, error: error instanceof Error ? error.message : "HTML Preview failed to load." });
    });
    return () => {
      canceled = true;
      currentId.current = null;
      cancelAnimationFrame(frame);
      unsubscribe();
      void api.disposeHtmlPreview(id).catch(() => { /* Owner navigation can dispose the view first. */ });
    };
  }, [html, intersects]);

  return <span ref={root} className={`html-preview ${className}`} role="group" tabIndex={0} aria-label={title}
    aria-description="Press Enter to interact with HTML. Press F6 to return to the app."
    onKeyDown={(event) => {
      if (event.key === "Enter" && currentId.current) {
        event.preventDefault();
        getWithMateApi()?.focusHtmlPreview(currentId.current);
      }
    }}>
    {state.warning && !state.error && <span className="html-preview-notice" role="status">{state.warning}</span>}
    <span ref={viewport} className="html-preview-viewport" aria-busy={state.loading}>
      {state.error ? <span className="html-preview-notice" role="alert">{state.error}</span>
        : state.loading ? <LoadingIndicator label="Loading HTML preview" /> : null}
    </span>
  </span>;
}
