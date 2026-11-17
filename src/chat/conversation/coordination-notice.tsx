import { useState, type ReactNode } from "react";
import type { CoordinationIdentity } from "../../../src-shared/coordination/coordination-contract.js";
import { projectMessagePlainText } from "../../../src-shared/session/message-search.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";

export function CoordinationNotice({ id, consultation, target }: { id: string; consultation: string; target: CoordinationIdentity }) {
  const [failure, setFailure] = useState<{ identity: string; text: string } | null>(null);
  const identity = JSON.stringify([id, target.kind, target.sessionId, target.incarnationId]);
  const opening = [...projectMessagePlainText(consultation).replace(/\s+/gu, " ").trim()];
  const preview = opening.slice(0, 120).join("") + (opening.length > 120 ? "…" : "");
  return <div className="coordination-notice">
    <blockquote className="coordination-question">
    <button type="button" className="related-session-route coordination-notice-link" aria-label={`Open Consultation: ${preview || "Consultation"}`} title="Open Consultation"
      disabled={!getWithMateApi()?.openCoordination} onClick={() => {
        setFailure(null);
        void getWithMateApi()?.openCoordination({ id, kind: target.kind, sessionId: target.sessionId, incarnationId: target.incarnationId })
          .catch((error) => setFailure({ identity, text: error instanceof Error ? error.message : "Could not open Coordination." }));
      }}>
      <span className="coordination-notice-preview">{preview || "Consultation"}</span>
      <span className="coordination-notice-open" aria-hidden="true">›</span>
    </button>
    </blockquote>
    {failure?.identity === identity ? <p role="alert">{failure.text}</p> : null}
  </div>;
}

export function ReceivedCoordinationContent({ children, text, consultation }: { children: ReactNode; text: string; consultation?: string }) {
  // Compare only to avoid displaying the same authored question twice, not to infer delivery state.
  if (consultation !== undefined && text !== consultation) {
    return <section className="received-coordination-content" aria-label="Received Content">{children}</section>;
  }
  return <details className="artifact-fold received-coordination-content">
    <summary className="artifact-fold-summary"><span className="artifact-fold-summary-copy"><span>Full Message</span></span></summary>
    <div className="artifact-fold-body">{children}</div>
  </details>;
}
