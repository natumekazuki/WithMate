import { useEffect, useRef, useState } from "react";
import type { Message } from "../../../src-shared/session/session-state.js";
import type { SessionExecutionReadResult } from "../../../src-shared/session/session-execution-window-contract.js";
import { conversationPeerKey } from "../../../src-shared/session/conversation-threads.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import type { TurnInputReadContext } from "./turn-input-details.js";

/** 発行済み相談を、読取範囲と次のカーソルに沿って取得したページ。 */
type Page = Extract<
  SessionExecutionReadResult<"list_issued_coordinations">,
  { ok: true }
>;
/** 応答行に配置するための送信元位置を持つ発行済み相談。 */
export type IssuedCoordination = Page["items"][number];
/** 現在の読取結果と、範囲変更後も応答行に表示位置がある既読項目を分けて保つ。 */
type Snapshot = {
  owner: string;
  key: string;
  page: Page;
  retained: IssuedCoordination[];
};

/** 再取得しても閲覧済みの先頭範囲を保つ。正本は引き続き永続化済みのレコード。 */
export function useIssuedCoordinations(
  context: TurnInputReadContext | undefined,
  messages: readonly Message[],
  liveTurnId: string | undefined,
  enabled: boolean,
  savedSeqs?: readonly (number | undefined)[],
  responseTurnIds?: readonly (string | undefined)[],
) {
  const messageSeqs = [
    ...new Set(
      (savedSeqs ?? messages.map((message) => message.historyIndex)).filter(
        (seq) => seq !== undefined,
      ),
    ),
  ].slice(0, 180);
  const liveTurnIds = liveTurnId ? [liveTurnId] : [];
  const owner = JSON.stringify([
    context?.ownerSessionId,
    context?.target && conversationPeerKey(context.target),
  ]);
  const key = JSON.stringify([owner, messageSeqs, liveTurnIds]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const saved = useRef(snapshot);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const commands = useRef<{
    key: string;
    /** 現在の範囲を先頭から更新するか、指定カーソルの続きから読む。 */
    load(cursor?: string): Promise<void>;
  } | null>(null);
  // 読み取り権限は、正本のシーケンス番号か実行中の Turn に基づく。
  // 読み取り済みのレコードの行は、保持している応答上に引き続き表示される場合がある。
  const visibleTurns = new Set([...(responseTurnIds ?? []), ...liveTurnIds]);
  /** 相談を、表示対象の送信元 Turn または保存済みメッセージに置けるかを判定する。 */
  const hasPlacement = (item: IssuedCoordination) =>
    visibleTurns.has(item.sourceTurnId) ||
    (item.sourceMessageSeq !== null &&
      messageSeqs.includes(item.sourceMessageSeq));
  const placement = useRef(hasPlacement);
  placement.current = hasPlacement;
  const bridgedTurns = useRef(new Set<string>());
  bridgedTurns.current = new Set(
    responseTurnIds?.flatMap((turn, index) =>
      turn && savedSeqs?.[index] === undefined ? [turn] : [],
    ),
  );
  useEffect(() => {
    setError("");
    setBusy(false);
    if (!enabled || !context || (!messageSeqs.length && !liveTurnIds.length))
      return;
    const { ownerSessionId, target } = context;
    const api = getWithMateApi();
    let active = true;
    let reading = false;
    let refreshPending = false;
    /** ページを読み足すか、先頭から既読範囲まで取り直し、取得範囲外の必要な項目を保持する。 */
    async function read(cursor?: string) {
      if (!api?.readSessionExecution) {
        setError("Saved Coordination reads are unavailable.");
        return;
      }
      const previous = saved.current?.key === key ? saved.current.page : null;
      const requestedCount =
        cursor === undefined ? Math.max(20, previous?.items.length ?? 0) : 20;
      const items: IssuedCoordination[] = [];
      let nextCursor = cursor;
      let page: Page;
      do {
        const result = await api.readSessionExecution(
          ownerSessionId,
          "list_issued_coordinations",
          {
            target,
            messageSeqs,
            liveTurnIds,
            ...(nextCursor ? { cursor: nextCursor } : {}),
            limit: 20,
          },
        );
        if (!active) return;
        if (!result.ok) {
          if (
            result.code === "EXECUTION_TARGET_DELETED" ||
            result.code === "EXECUTION_TARGET_REPLACED"
          ) {
            saved.current = null;
            setSnapshot(null);
          }
          setError(result.message);
          return;
        }
        page = result;
        items.push(...page.items);
        nextCursor = page.nextCursor ?? undefined;
      } while (nextCursor !== undefined && items.length < requestedCount);
      const observed = new Map(
        (cursor && previous ? previous.items : []).map((item) => [
          item.id,
          item,
        ]),
      );
      for (const item of items) observed.set(item.id, item);
      // キーセットはレコード ID 順。最後に取得した ID より後の項目が見つからなくても、
      // その送信元 seq が保存済みになっていることだけで、削除とはみなさない。
      const known = saved.current?.owner === owner ? saved.current : null;
      const retained = known
        ? [...known.page.items, ...known.retained].filter(
            (item) =>
              !observed.has(item.id) &&
              placement.current(item) &&
              ((nextCursor !== undefined && item.id > nextCursor) ||
                (bridgedTurns.current.has(item.sourceTurnId) &&
                  !liveTurnIds.includes(item.sourceTurnId) &&
                  (item.sourceMessageSeq === null ||
                    !messageSeqs.includes(item.sourceMessageSeq)))),
          )
        : [];
      const next = {
        owner,
        key,
        page: { ...page, items: [...observed.values()] },
        retained,
      };
      saved.current = next;
      setSnapshot(next);
    }
    /** 同時に一件だけ読み、読取中に届いた更新通知をまとめて追いつく。 */
    async function load(cursor?: string) {
      if (!active) return;
      if (reading) {
        if (cursor === undefined) refreshPending = true;
        return;
      }
      reading = true;
      setBusy(true);
      do {
        refreshPending = false;
        setError("");
        try {
          await read(cursor);
        } catch (reason) {
          if (active)
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not read Coordination.",
            );
        }
        // 「さらに読み込む」で直前に広げた先頭範囲も含め、先頭から再取得して追いつく。
        cursor = undefined;
      } while (active && refreshPending);
      reading = false;
      if (active) setBusy(false);
    }
    commands.current = { key, load };
    const unsubscribe = api?.subscribeCoordinationChanged?.(({ initiator }) => {
      if (
        initiator.kind === target.kind &&
        initiator.sessionId === target.sessionId &&
        initiator.incarnationId === target.incarnationId
      )
        void load();
    });
    void load();
    return () => {
      active = false;
      commands.current = null;
      unsubscribe?.();
    };
  }, [key, enabled]);
  const page = snapshot?.key === key ? snapshot.page : null;
  const items =
    snapshot?.owner === owner && (page || enabled)
      ? [...snapshot.page.items, ...snapshot.retained].filter(hasPlacement)
      : [];
  /** 表示が有効で、操作が現在の読取範囲に属する場合だけ読み取る。 */
  const load = (cursor?: string) => {
    if (enabled && commands.current?.key === key)
      void commands.current.load(cursor);
  };
  return {
    items,
    nextCursor: page?.nextCursor ?? null,
    error,
    busy,
    /** 続きからではなく先頭から再取得する。 */
    retry: () => load(),
    /** 他の読取が進んでいなければ、現在のカーソルの続きから取得する。 */
    loadMore: () => {
      if (page?.nextCursor && !busy) load(page.nextCursor);
    },
  };
}
