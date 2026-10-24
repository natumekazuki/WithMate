import { useEffect, useMemo, useRef, useState } from "react";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { SessionGraphWindowPayload, SessionGraphViewState } from "../../src-shared/session-graph/session-graph-window-contract.js";
import { getWithMateApi } from "../app/renderer-withmate-api.js";
import { ButtonContent } from "../ui/button-content.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { SessionGraphPreview } from "./SessionGraphPreview.js";

export default function SessionGraphWindowApp() {
  const api = getWithMateApi();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [payload, setPayload] = useState<SessionGraphWindowPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [opening, setOpening] = useState(false);
  const [openingSession, setOpeningSession] = useState(false);
  const stateRef = useRef<SessionGraphViewState | null>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const menuTriggerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    if (!api || !token) { setError("This graph window is not available."); setLoading(false); return; }
    void api.getSessionGraphWindowPayload(token).then((value) => {
      if (!active) return;
      if (!value) throw new Error("This graph window is no longer available.");
      stateRef.current = value.state;
      document.title = value.windowTitle;
      setPayload(value);
    }).catch((cause) => { if (active) setError(String(cause instanceof Error ? cause.message : cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, token, retry]);
  const adapter = useMemo<Pick<WithMateWindowApi, "readSessionGraph" | "subscribeSessionGraph"> | null>(() => api ? ({
    readSessionGraph: (_sessionId, operation, request) => api.readSessionGraphWindow(token, operation, request),
    subscribeSessionGraph: (listener) => api.subscribeSessionGraph(listener),
  }) : null, [api, token]);
  const openWindow = async (state: SessionGraphViewState) => {
    if (!api || opening) return;
    setOpening(true); setError("");
    try { await api.openSessionGraphWindow({ fromToken: token, state }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setOpening(false); }
  };
  const closeMenu = () => { if (menuRef.current) menuRef.current.open = false; menuTriggerRef.current?.focus(); };
  return <div className="session-graph-window session-page">
    {loading ? <LoadingIndicator label="Loading Session Graph" /> : null}
    {error ? <div className="session-graph-load-status" role="alert">{error}{!payload ? <button type="button" onClick={() => setRetry((current) => current + 1)}>Retry</button> : null}</div> : null}
    {payload && adapter && api ? <SessionGraphPreview api={adapter} sessionId={payload.ownerSessionId} initialState={payload.state}
      onStateChange={(state) => { stateRef.current = state; void api.updateSessionGraphWindowState(token, state).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }}
      onOpenPath={(target) => { void api.openSessionGraphWindowReference(token, target).then((result) => {
        if (result.status !== "opened") setError(result.message);
      }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }}
      onOpenWindow={(state) => void openWindow(state)}
      toolbarActions={<>
        <button type="button" title="Open Graph In New Window" aria-label="Open Graph In New Window" aria-busy={opening || undefined} disabled={opening} onClick={() => { if (stateRef.current) void openWindow(stateRef.current); }}><ButtonContent busy={opening}>↗</ButtonContent></button>
        <details ref={menuRef} className="session-graph-window-menu" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeMenu(); } }}>
          <summary ref={menuTriggerRef} aria-label="Graph Actions" title="Graph Actions">⋯</summary>
          <button type="button" disabled={openingSession} aria-busy={openingSession || undefined} onClick={() => {
            if (!stateRef.current) return;
            setOpeningSession(true); setError("");
            void api.openSessionGraphInSession(token, stateRef.current).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => { setOpeningSession(false); closeMenu(); });
          }}><ButtonContent busy={openingSession}>Open In Session</ButtonContent></button>
        </details>
      </>} /> : null}
  </div>;
}
