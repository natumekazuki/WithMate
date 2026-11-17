import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CoordinationIdentity } from "../../../src-shared/coordination/coordination-contract.js";
import { projectMessageRenderedSearchText } from "../../../src-shared/session/message-search.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { useCoordinationQuery } from "../../coordination/use-coordination-query.js";
import { ErrorDetailsButton } from "../../ui/error-details.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";

export function CoordinationNotice({ id, consultation, target }: {
  id: string; consultation: string; target: CoordinationIdentity;
}) {
  const [failure, setFailure] = useState<{ identity: string; text: string } | null>(null);
  const statusId = useId();
  const shell = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!shell.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(shell.current);
    return () => observer.disconnect();
  }, []);
  const api = getWithMateApi();
  const query = useCoordinationQuery({ operation: "get", id }, visible && Boolean(api?.executeCoordination));
  const record = query.result && "record" in query.result ? query.result.record : null;
  const status = query.deleted ? "Deleted" : query.error || !api?.executeCoordination ? "State Unavailable"
    : !record ? null : record.state !== "open"
      ? { resolved: "Resolved", withdrawn: "Withdrawn", corrected: "Corrected" }[record.state]
      : record.answers.length ? "Reply Recorded" : record.respondent.kind === "user" ? "Awaiting Your Reply" : "Awaiting Reply";
  const preview = projectMessageRenderedSearchText(consultation).replace(/\s+/gu, " ").trim();
  const identity = JSON.stringify([id, target.kind, target.sessionId, target.incarnationId]);
  return <section ref={shell} className="coordination-notice" aria-label="Consultation">
    <button type="button" className="related-session-route coordination-notice-link" aria-label={`Open Consultation: ${preview}`} aria-describedby={statusId} title={`Open Consultation: ${preview}`}
      disabled={!api?.openCoordination} onClick={() => {
        setFailure(null);
        void getWithMateApi()?.openCoordination({ id, kind: target.kind, sessionId: target.sessionId, incarnationId: target.incarnationId })
          .catch((error) => setFailure({ identity, text: error instanceof Error ? error.message : "Could not open Coordination." }));
      }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z" /><path d="M7 9h10M7 13h6" /></svg>
      <span className="related-session-title">{preview}</span>
      <span id={statusId} className="coordination-notice-state">{status}</span><span aria-hidden="true">›</span>
    </button>
    {query.loading ? <LoadingIndicator inline label="Loading Consultation State" /> : null}
    {query.error && !query.deleted ? <><ErrorDetailsButton message={query.error} label="Consultation State Error" /><button type="button" className="related-session-route" disabled={query.loading} onClick={query.refresh}>Retry</button></> : null}
    {failure?.identity === identity ? <ErrorDetailsButton message={failure.text} label="Could Not Open Consultation" /> : null}
  </section>;
}

export function ReceivedCoordinationContent({ children, text, consultation }: { children: ReactNode; text: string; consultation?: string }) {
  // Compare only to avoid displaying the same authored question twice, not to infer delivery state.
  return consultation === undefined || text !== consultation
    ? <section className="received-coordination-content" aria-label="Received Content">{children}</section>
    : null;
}
