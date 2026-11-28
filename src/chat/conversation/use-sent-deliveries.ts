import { useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "../../../src-shared/session/session-state.js";
import { conversationPeerKey } from "../../../src-shared/session/conversation-threads.js";
import type {
  SentInstructionCard,
  SentInstructionCardRequest,
} from "../../../src-shared/session/session-execution-read.js";
import type { SessionExecutionReadResult } from "../../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import type { TurnInputReadContext } from "./turn-input-details.js";
import {
  createSentBodyReader,
  type SentBodyRead,
  type SentBodyReader,
} from "./sent-instruction-body.js";

/** 送信先の受付に基づく通常送信の読取成功ページ。 */
type SentPage = Extract<
  SessionExecutionReadResult<"list_sent_deliveries">,
  { ok: true }
>;
/** 送信元に表示する通常送信一件のメタデータ。 */
export type SentDelivery = SentPage["items"][number];
/** 実行中 Turn に送った追加指示の読取成功ページ。 */
type SteerPage = Extract<
  SessionExecutionReadResult<"list_sent_steers">,
  { ok: true }
>;
/** 送信元に表示する追加指示一件のメタデータ。 */
export type SentSteer = SteerPage["items"][number];
/** 配置判定用の送信情報と、必要になったときだけ使う本文の取得口。 */
export type SentInstruction = SentInstructionCard & { bodyRead: SentBodyRead };
/** 通常送信は受付 ID、追加指示は送信先とメッセージ連番から表示用のキーを得る。 */
export const sentInstructionKey = (item: SentInstructionCard) =>
  "receiptId" in item
    ? item.receiptId
    : `steer:${conversationPeerKey(item.target)}:${item.messageSeq}`;

/** 取得したカードに、その読取範囲の本文リーダーと版を対応付ける。 */
type CatalogueItem = {
  card: SentInstructionCard;
  read: SentBodyReader;
  revision: number;
};
/** 送信元と読み取った履歴・Turn の範囲を特定できるカード一覧。 */
type Catalogue = { owner: string; scope: string; items: CatalogueItem[] };
/** 送信先の変更を判定する ID を返す。Auxiliary が送信先なら親 Main も含める。 */
const recipientIds = ({ target }: SentInstructionCard) =>
  target.kind === "auxiliary"
    ? [target.sessionId, target.mainSessionId]
    : [target.sessionId];

/** 表示位置の決定には件数を絞った一覧を使う。本文は描画された個々のカードが持つ。 */
export function useSentDeliveries(
  context: TurnInputReadContext | undefined,
  messages: readonly Message[],
  liveTurnId: string | null | undefined,
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
  const sourceOwner = JSON.stringify([
    context?.ownerSessionId,
    context?.target && conversationPeerKey(context.target),
  ]);
  const identity = JSON.stringify([sourceOwner, messageSeqs, liveTurnIds]);
  const scope = useMemo(
    (): SentInstructionCardRequest | null =>
      context && (messageSeqs.length || liveTurnIds.length)
        ? { target: context.target, messageSeqs, liveTurnIds }
        : null,
    [identity],
  );
  const owner = context?.ownerSessionId;
  const reader = useMemo(
    () => (owner && scope ? createSentBodyReader(owner, scope) : null),
    [owner, scope, enabled],
  );
  const [data, setData] = useState<Catalogue | null>(null);
  const current = useRef<Catalogue | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const retry = useRef<() => void>(undefined);
  // 送信元 Turn の保存済み応答のシーケンスがこの列に届く前でも、その Turn の行がある場合がある。
  // 現時点で表示位置があり、送信元の incarnation が同じカードだけを残す。
  const visibleSeqs = new Set(messageSeqs);
  const visibleTurns = new Set([...(responseTurnIds ?? []), ...liveTurnIds]);
  /** 読み込み済みの応答 Turn または保存済みメッセージにカードを置けるかを判定する。 */
  const hasPlacement = (item: SentInstructionCard) =>
    visibleTurns.has(item.sourceTurnId) ||
    (item.sourceMessageSeq !== null && visibleSeqs.has(item.sourceMessageSeq));
  const hasPlacementRef = useRef(hasPlacement);
  hasPlacementRef.current = hasPlacement;
  const bridgeTurnsRef = useRef(new Set<string>());
  bridgeTurnsRef.current = new Set(
    responseTurnIds?.flatMap((turn, index) =>
      turn && savedSeqs?.[index] === undefined ? [turn] : [],
    ),
  );

  useEffect(() => {
    setError("");
    setBusy(false);
    if (!enabled || !scope || !owner || !reader) return;
    const api = getWithMateApi();
    if (!api?.readSessionExecution) {
      setError("Saved outgoing messages are unavailable.");
      return;
    }
    let active = true;
    let inFlight = false;
    let scheduled = false;
    let changed = 0;
    const unknownRecipients = new Set<string>();
    /** 通常送信を先に、各種別内は連番順に並べて現在の読取範囲へ発行する。 */
    const publish = (items: Iterable<CatalogueItem>) => {
      const result = {
        owner: sourceOwner,
        scope: identity,
        items: [...items].sort(
          ({ card: a }, { card: b }) =>
            Number("receiptId" in b) - Number("receiptId" in a) ||
            a.sequence - b.sequence,
        ),
      };
      current.current = result;
      setData(result);
    };
    /** カードをページ単位で読み足し、途中の無効化で古くなった読み取りは打ち切る。 */
    const load = async () => {
      if (!active) return;
      const version = changed;
      const revision = ++generation.current;
      inFlight = true;
      unknownRecipients.clear();
      setError("");
      setBusy(true);
      const read = new Map<string, CatalogueItem>();
      const previous =
        current.current?.owner === sourceOwner
          ? current.current.items.filter(({ card }) =>
              hasPlacementRef.current(card),
            )
          : [];
      const visible = new Map(
        previous.map((item) => [sentInstructionKey(item.card), item]),
      );
      let cursors: SentInstructionCardRequest["cursors"];
      try {
        do {
          const response = await api.readSessionExecution(
            owner,
            "list_sent_instruction_cards",
            { ...scope, ...(cursors ? { cursors } : {}) },
          );
          if (!active || version !== changed) return;
          if (!response.ok) {
            if (
              response.code === "EXECUTION_TARGET_DELETED" ||
              response.code === "EXECUTION_TARGET_REPLACED"
            )
              publish([]);
            setError(response.message);
            return;
          }
          if (
            response.items.some((item) =>
              recipientIds(item).some((id) => unknownRecipients.has(id)),
            )
          ) {
            changed++;
            return;
          }
          for (const card of response.items) {
            const key = sentInstructionKey(card);
            const item = { card, read: reader, revision };
            read.set(key, item);
            visible.set(key, item);
          }
          if (
            response.cursors.receipts === null &&
            response.cursors.steers === null
          ) {
            // 保存済みの送信元位置を含まない読み取りでは、一時表示中の Turn 上のカードを無効にはできない。
            for (const item of previous) {
              const { card } = item;
              const key = sentInstructionKey(card);
              if (
                !read.has(key) &&
                bridgeTurnsRef.current.has(card.sourceTurnId) &&
                !liveTurnIds.includes(card.sourceTurnId) &&
                (card.sourceMessageSeq === null ||
                  !visibleSeqs.has(card.sourceMessageSeq))
              ) {
                read.set(key, item);
              }
            }
            publish(read.values());
            return;
          }
          // この範囲の全件走査が成功するまでは、見つからないカードを削除済みとして扱わない。
          publish(visible.values());
          cursors = response.cursors;
        } while (active);
      } catch (failure) {
        if (active && version === changed)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not read outgoing messages.",
          );
      } finally {
        inFlight = false;
        if (active) {
          if (version !== changed) schedule();
          else setBusy(false);
        }
      }
    };
    /** 未実行の再読取を一件にまとめ、進行中の読取とは重ねない。 */
    const schedule = () => {
      if (inFlight || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        void load();
      });
    };
    /** 現在の読取を旧版にして、最新の一覧の取得を予約する。 */
    const invalidate = () => {
      changed++;
      schedule();
    };
    /** 表示中の送信元セッションのイベントだけで一覧を無効にする。 */
    const sourceChanged = (id: string) => {
      if (id === scope.target.sessionId) invalidate();
    };
    const subscriptions = [
      api.onSessionSentDeliveriesChanged?.(sourceChanged),
      // 既存の送信元位置の確認には、送信元のキューイベントを使う。
      api.onSessionTurnQueueChanged?.(sourceChanged),
      api.subscribeSessionInvalidation?.((event) => {
        if (event.detailChanged === false) return;
        const items =
          current.current?.owner === sourceOwner
            ? current.current.items
                .map((item) => item.card)
                .filter(hasPlacementRef.current)
            : [];
        if (
          event.scope === "all" ||
          event.sessionIds.includes(scope.target.sessionId) ||
          items.some((item) =>
            recipientIds(item).some((id) => event.sessionIds.includes(id)),
          )
        )
          invalidate();
        else if (inFlight)
          for (const id of event.sessionIds) unknownRecipients.add(id);
      }),
    ];
    retry.current = invalidate;
    schedule();
    return () => {
      active = false;
      retry.current = undefined;
      for (const unsubscribe of subscriptions) unsubscribe?.();
    };
  }, [enabled, owner, scope, identity, reader, sourceOwner]);

  const eligible =
    data?.owner === sourceOwner && (data.scope === identity || enabled);
  const items = eligible
    ? data.items
        .filter(({ card }) => hasPlacement(card))
        .map(({ card: item, read, revision }): SentInstruction => ({
          ...item,
          bodyRead: {
            key: {
              sourceTurnId: item.sourceTurnId,
              sequence: item.sequence,
              recipient: item.target,
              ...("receiptId" in item
                ? { receiptId: item.receiptId }
                : { messageSeq: item.messageSeq }),
            },
            read,
            revision: "receiptId" in item ? 0 : revision,
            enabled,
          },
        }))
    : [];
  return {
    items,
    error,
    busy,
    /** 現在の読取範囲が有効なら一覧を再取得する。 */
    retry: () => retry.current?.(),
  };
}
