import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { UnreadSessionResult } from "../../../src-shared/session/session-turn-state.js";

/** 未読の実行結果を取得し、表示を確認した結果だけを既読にするための API。 */
export type SessionResultReadApi = Pick<
  WithMateWindowApi,
  "getUnreadSessionResult" | "markSessionResultRead" | "onSessionTurnUpdated"
>;

/** 未読の保存済み応答がフォーカス中の画面で実際に表示されたときだけ既読を通知する。 */
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
  /** 本文または確定済みの詳細が可視範囲に重なることを確認し、同じ結果の通知を重複させない。 */
  const check = () => {
    frame = null;
    if (
      !active ||
      !result ||
      pendingTurnId !== null ||
      !document.hasFocus() ||
      document.visibilityState !== "visible"
    )
      return;
    const index = assistantMessageIndexes.get(result.assistantMessageSeq);
    if (index === undefined) return;
    const row = list.querySelector<HTMLElement>(
      `.session-message-virtual-row[data-index="${index}"]`,
    );
    const body = row?.querySelector<HTMLElement>(
      '[data-message-body="true"]:not([data-pending-message-body])',
    );
    if (!body || body.querySelector(":scope > .message-collapsed-preview"))
      return;
    const content = body.hasChildNodes()
      ? body
      : row?.querySelector<HTMLElement>(
          '.session-run-failure, [data-result-details-ready="true"]',
        );
    if (!content) return;
    const bounds = content.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    if (
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      viewport.width <= 0 ||
      viewport.height <= 0 ||
      Math.min(bounds.bottom, viewport.bottom, window.innerHeight) <=
        Math.max(bounds.top, viewport.top, 0) ||
      Math.min(bounds.right, viewport.right, window.innerWidth) <=
        Math.max(bounds.left, viewport.left, 0)
    )
      return;
    const turnId = result.turnId;
    pendingTurnId = turnId;
    void api
      .markSessionResultRead(sessionId, turnId)
      .then((read) => {
        if (active && read && result?.turnId === turnId) result = null;
      })
      .catch((error: unknown) => {
        if (active)
          console.warn("Session result read acknowledgement failed", error);
      })
      .finally(() => {
        pendingTurnId = null;
        if (active && result && result.turnId !== turnId) schedule();
      });
  };
  /** 描画やスクロールの通知をまとめ、可視性の確認を一フレームにつき一回だけ予約する。 */
  const schedule = () => {
    if (active && frame === null) frame = window.requestAnimationFrame(check);
  };
  /** 現在の未読結果を取得し、最新の応答だけを次の可視性確認へ渡す。 */
  const refresh = () => {
    const current = ++revision;
    void api
      .getUnreadSessionResult(sessionId)
      .then((next) => {
        if (active && current === revision) {
          result = next;
          schedule();
        }
      })
      .catch((error: unknown) => {
        if (active && current === revision)
          console.warn("Unread session result could not be loaded", error);
      });
  };
  const unsubscribe = api.onSessionTurnUpdated((id) => {
    if (id === sessionId) refresh();
  });
  const mutation = new window.MutationObserver(schedule);
  mutation.observe(list, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "style",
      "hidden",
      "data-index",
      "data-result-details-ready",
      "data-message-body",
    ],
  });
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
