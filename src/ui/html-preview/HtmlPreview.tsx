import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { LoadingIndicator } from "../loading-indicator.js";
import { HTML_PREVIEW_MAX_BYTES } from "../../../src-shared/file-explorer/session-html-preview-contract.js";
import type { HtmlPreviewMountResult, HtmlPreviewPrompt, HtmlPreviewSource } from "../../../src-shared/window/html-preview.js";

export function HtmlPreview({ html, source, title, className = "", onFind }: {
  html: string; source: HtmlPreviewSource; title: string; className?: string; onFind?: () => void;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const viewport = useRef<HTMLSpanElement>(null);
  const guestHost = useRef<HTMLSpanElement>(null);
  const guest = useRef<HTMLElement | null>(null);
  const previewId = useRef<string | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const promptTitleId = useId();
  const promptDetailId = useId();
  const sourceKey = JSON.stringify(source);
  const stableSource = useMemo<HtmlPreviewSource>(() => JSON.parse(sourceKey), [sourceKey]);
  const find = useRef(onFind);
  find.current = onFind;
  const [intersects, setIntersects] = useState(false);
  const [reload, setReload] = useState(0);
  const [promptBusy, setPromptBusy] = useState(false);
  const [state, setState] = useState<{ loading: boolean; mount?: HtmlPreviewMountResult; error?: string; warning?: string; prompt?: HtmlPreviewPrompt | null }>({ loading: true });
  const latestPrompt = useRef(state.prompt);
  latestPrompt.current = state.prompt;

  useLayoutEffect(() => {
    if (!intersects || !state.mount || state.error || !guestHost.current) return;
    const view = document.createElement("webview");
    view.className = "html-preview-frame";
    view.setAttribute("partition", state.mount.partition);
    view.setAttribute("allowpopups", "");
    view.setAttribute("src", state.mount.url);
    view.setAttribute("title", title);
    view.setAttribute("aria-label", title);
    view.tabIndex = -1;
    guest.current = view;
    guestHost.current.append(view);
    return () => { guest.current = null; view.remove(); };
  }, [intersects, state.mount, state.error]);

  useLayoutEffect(() => {
    guest.current?.setAttribute("title", title);
    guest.current?.setAttribute("aria-label", title);
  }, [title, state.mount]);

  useLayoutEffect(() => {
    if (state.prompt) cancelButton.current?.focus();
    if (guestHost.current) guestHost.current.inert = !!state.prompt;
    if (guest.current) guest.current.style.pointerEvents = state.prompt ? "none" : "";
  }, [state.prompt, state.mount]);

  const respond = (choice: number | null) => {
    const api = getWithMateApi();
    const id = previewId.current;
    const prompt = state.prompt;
    if (!api || !id || !prompt || promptBusy) return;
    setPromptBusy(true);
    void api.respondHtmlPreview(id, prompt.requestId, choice).then(() => {
      if (previewId.current !== id) return;
      if (latestPrompt.current?.requestId !== prompt.requestId) return;
      setState((previous) => previous.prompt?.requestId === prompt.requestId ? { ...previous, prompt: null } : previous);
      setPromptBusy(false);
      root.current?.focus();
    }, (error: unknown) => {
      if (previewId.current !== id) return;
      if (latestPrompt.current?.requestId !== prompt.requestId) return;
      setPromptBusy(false);
      setState((previous) => ({ ...previous, warning: error instanceof Error ? error.message : "The preview request could not be answered." }));
    });
  };

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
    previewId.current = id;
    let canceled = false;
    let failed = false;
    setState({ loading: true });
    setPromptBusy(false);
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
      else if (event.type === "prompt") {
        setPromptBusy(false);
        setState((previous) => ({ ...previous, prompt: event.prompt }));
        if (!event.prompt) root.current?.focus();
      }
    });
    void api.mountHtmlPreview({ id, html, source: stableSource }).then((mount) => {
      if (!canceled && !failed) setState((previous) => ({ ...previous, mount }));
    }, (error: unknown) => {
      if (!canceled && !failed) setState({ loading: false, error: error instanceof Error ? error.message : "HTML Preview failed to load." });
    });
    return () => {
      canceled = true;
      if (previewId.current === id) previewId.current = null;
      unsubscribe();
      void api.disposeHtmlPreview(id).catch(() => { /* Owner navigation can dispose the document first. */ });
    };
  }, [html, stableSource, intersects, reload]);

  return <span ref={root} className={`html-preview ${className}`} role="group" tabIndex={0} aria-label={title}
    aria-description="Press Enter to interact with HTML. Press F6 to return to the app."
    onKeyDown={(event) => {
      if (event.key === "Enter" && event.target === event.currentTarget && guest.current && !state.prompt) {
        event.preventDefault();
        guest.current.focus();
      }
    }}>
    {state.warning && !state.error && <span className="html-preview-notice" role="status">{state.warning}</span>}
    <span ref={viewport} className="html-preview-viewport" aria-busy={state.loading}>
      <span ref={guestHost} className="html-preview-guest-host" />
      {state.prompt && <span className="html-preview-prompt-backdrop"><span className="html-preview-prompt" role="dialog" aria-modal="true"
        aria-labelledby={promptTitleId} aria-describedby={promptDetailId} aria-busy={promptBusy}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); respond(null); }
          if (event.key === "Tab") {
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
            if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
            else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
          }
        }}>
        <strong id={promptTitleId}>{state.prompt.title}</strong>
        <span id={promptDetailId} className="html-preview-prompt-detail">{state.prompt.detail}</span>
        <span className="html-preview-prompt-actions">
          <button ref={cancelButton} type="button" disabled={promptBusy} onClick={() => respond(null)}>Cancel</button>
          {state.prompt.choices.map((choice, index) => <button key={index} type="button" disabled={promptBusy} onClick={() => respond(index)}>{choice}</button>)}
        </span>
      </span></span>}
      {state.error ? <span className="html-preview-notice"><span role="alert">{state.error}</span>{" "}
        <button type="button" onClick={() => setReload((value) => value + 1)}>Reload</button></span>
        : state.loading && !state.prompt ? <LoadingIndicator label="Loading HTML preview" /> : null}
    </span>
  </span>;
}
