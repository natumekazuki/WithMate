import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { UnreadSessionResult } from "../../../src-shared/session/session-turn-state.js";

export type SessionResultReadApi = Pick<WithMateWindowApi,
  "getUnreadSessionResult" | "markSessionResultRead" | "onSessionTurnUpdated"
>;

export function observeSessionResultRead(input: {
  api: SessionResultReadApi;
  sessionId: string;
  list: HTMLElement;
  assistantMessageIndexes: ReadonlyMap<number, number>;
}): () => void {
  const { api, sessionId, list, assistantMessageIndexes } = input;
  const document = list.ownerDocument;
  const window = document.defaultView!;
  let active = true;
  let revision = 0;
  let result: UnreadSessionResult | null = null;
  let pendingTurnId: number | null = null;
  let frame: number | null = null;
  const check = () => {
    frame = null;
    if (!active || !result || pendingTurnId !== null || !document.hasFocus() || document.visibilityState !== "visible") return;
    const index = assistantMessageIndexes.get(result.assistantMessageSeq);
    if (index === undefined) return;
    const row = list.querySelector<HTMLElement>(`.session-message-virtual-row[data-index="${index}"]`);
    const body = row?.querySelector<HTMLElement>('[data-message-body="true"]:not([data-pending-message-body])');
    if (!body || body.querySelector(":scope > .message-collapsed-preview")) return;
    const content = body.hasChildNodes() ? body : row?.querySelector<HTMLElement>(".session-run-failure");
    if (!content) return;
    const bounds = content.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || viewport.width <= 0 || viewport.height <= 0
      || Math.min(bounds.bottom, viewport.bottom, window.innerHeight) <= Math.max(bounds.top, viewport.top, 0)
      || Math.min(bounds.right, viewport.right, window.innerWidth) <= Math.max(bounds.left, viewport.left, 0)) return;
    const turnId = result.turnId;
    pendingTurnId = turnId;
    void api.markSessionResultRead(sessionId, turnId).then((read) => {
      if (active && read && result?.turnId === turnId) result = null;
    }).catch((error: unknown) => {
      if (active) console.warn("Session result read acknowledgement failed", error);
    }).finally(() => {
      pendingTurnId = null;
      if (active && result && result.turnId !== turnId) schedule();
    });
  };
  const schedule = () => {
    if (active && frame === null) frame = window.requestAnimationFrame(check);
  };
  const refresh = () => {
    const current = ++revision;
    void api.getUnreadSessionResult(sessionId).then((next) => {
      if (active && current === revision) { result = next; schedule(); }
    }).catch((error: unknown) => {
      if (active && current === revision) console.warn("Unread session result could not be loaded", error);
    });
  };
  const unsubscribe = api.onSessionTurnUpdated((id) => { if (id === sessionId) refresh(); });
  const mutation = new window.MutationObserver(schedule);
  mutation.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "hidden", "data-index"] });
  const resize = new window.ResizeObserver(schedule);
  resize.observe(list);
  list.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("focus", refresh);
  window.addEventListener("resize", schedule);
  document.addEventListener("visibilitychange", schedule);
  refresh();
  return () => {
    active = false;
    unsubscribe();
    mutation.disconnect();
    resize.disconnect();
    if (frame !== null) window.cancelAnimationFrame(frame);
    list.removeEventListener("scroll", schedule);
    window.removeEventListener("focus", refresh);
    window.removeEventListener("resize", schedule);
    document.removeEventListener("visibilitychange", schedule);
  };
}
