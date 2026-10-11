import { useEffect, useRef, useState } from "react";
import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";
import type { SessionTurnQueueApi } from "./use-session-turn-queue.js";
import { SessionTurnQueueRow } from "./session-turn-queue-row.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";

export function SessionTurnQueueHistory({ api, sessionId, incarnationId, busyId, onCancel, onRelease, onSendInput }: {
  api?: SessionTurnQueueApi; sessionId: string; incarnationId: string; busyId: string | null;
  onCancel: (receipt: SessionTurnQueueReceipt) => void; onRelease: (receipt: SessionTurnQueueReceipt) => void;
  onSendInput?: (receipt: SessionTurnQueueReceipt) => void;
}) {
  const [page, setPage] = useState<{ receipts: SessionTurnQueueReceipt[]; cursor?: number; previous: Array<number | undefined>; next: number | null; selectedId: string; loaded: boolean }>({ receipts: [], previous: [], next: null, selectedId: "", loaded: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef<{ cursor?: number; previous: Array<number | undefined> }>({ previous: [] });
  const generation = useRef(0);
  useEffect(() => () => { ++generation.current; }, []);
  const load = async (cursor?: number, previous: Array<number | undefined> = []) => {
    if (!api?.listSessionTurnQueueReceipts) return;
    const request = ++generation.current;
    requestRef.current = { cursor, previous };
    setLoading(true); setError("");
    try {
      const result = await api.listSessionTurnQueueReceipts(sessionId, { cursor, limit: 30 });
      if (generation.current !== request) return;
      const receipts = result.receipts.filter((receipt) => receipt.sessionId === sessionId && receipt.incarnationId === incarnationId);
      setPage({ receipts, cursor, previous, next: result.nextCursor, selectedId: receipts[0]?.id ?? "", loaded: true });
    } catch (failure) {
      if (generation.current === request) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { if (generation.current === request) setLoading(false); }
  };
  if (!api?.listSessionTurnQueueReceipts) return null;
  const selected = page.receipts.find((receipt) => receipt.id === page.selectedId);
  return <details className="session-turn-queue-history" onToggle={(event) => { if (event.currentTarget.open && !page.loaded && !loading && !error) void load(); }}>
    <summary>Queue Receipts</summary>
    <div className="session-turn-queue-status">
      <button type="button" className="drawer-toggle compact secondary" disabled={loading} onClick={() => void load(page.cursor, page.previous)}>Refresh Receipts</button>
      {page.previous.length > 0 ? <button type="button" className="drawer-toggle compact secondary" disabled={loading} onClick={() => void load(page.previous.at(-1), page.previous.slice(0, -1))}>Previous Receipts</button> : null}
      {page.next !== null ? <button type="button" className="drawer-toggle compact secondary" disabled={loading} onClick={() => void load(page.next!, [...page.previous, page.cursor])}>Next Receipts</button> : null}
      {loading ? <LoadingIndicator inline label="Loading queue receipts" /> : null}
    </div>
    {error ? <div className="pending-run-error-note" role="alert">{error}<button type="button" className="drawer-toggle compact secondary" disabled={loading} onClick={() => void load(requestRef.current.cursor, requestRef.current.previous)}>Retry Receipts</button></div> : null}
    {page.receipts.length > 0 ? <label>Turn Receipt <select aria-label="Turn Receipt" value={page.selectedId} onChange={(event) => setPage((current) => ({ ...current, selectedId: event.target.value }))}>
      {page.receipts.map((receipt) => <option key={receipt.id} value={receipt.id}>{`#${receipt.sequence} ${receipt.state[0].toUpperCase() + receipt.state.slice(1)} — ${receipt.captured.request.userMessage.slice(0, 60)}`}</option>)}
    </select></label> : null}
    {selected ? <SessionTurnQueueRow receipt={selected} showTerminalStatus busy={busyId !== null} onCancel={onCancel} onRelease={onRelease} onSendInput={onSendInput} /> : null}
  </details>;
}
