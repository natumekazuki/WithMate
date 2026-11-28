import { conversationPeerKey } from "../../src-shared/session/conversation-threads.js";
import { executionWindowRequestSchemas } from "../../src-shared/session/session-execution-read.js";
import type { SentDelivery, SentInstruction, SentSteer } from "../../src/chat/conversation/use-sent-deliveries.js";
import type { SentInstructionBody, SentInstructionCard } from "../../src-shared/session/session-execution-read.js";

function cardOf(item: SentDelivery | SentSteer): SentInstructionCard {
  if ("receiptId" in item) {
    const { text: _text, coordination, ...card } = item;
    return { ...card, ...(coordination && { coordination: { id: coordination.id } }) };
  }
  const { text: _text, ...card } = item;
  return card;
}

function bodyOf(item: SentDelivery | SentSteer): SentInstructionBody {
  const coordination = "receiptId" in item ? item.coordination : undefined;
  return { kind: "receiptId" in item ? "receipt" : "steer", sequence: item.sequence,
    text: coordination?.text ?? item.text, consultation: coordination?.consultation };
}

/** 行単体のテストでは、配信の詳細とは別に、あらかじめ用意した本文を読む処理を渡す。 */
export function sentInstructionFixtureItem(item: SentDelivery | SentSteer): SentInstruction {
  return { ...cardOf(item), bodyRead: {
    enabled: true, revision: 0, read: async () => bodyOf(item),
    key: { recipient: item.target, sequence: item.sequence, sourceTurnId: item.sourceTurnId,
      ...("receiptId" in item ? { receiptId: item.receiptId } : { messageSeq: item.messageSeq }) },
  } };
}

/** あらかじめ用意した受付記録と Steer の証拠を、GUI の二つの読み取り境界に対応する形で返す。 */
export function sentInstructionReaderFixture(items: readonly (SentDelivery | SentSteer)[], operation: string, request: unknown) {
  if (operation === "list_sent_instruction_cards") {
    return {
      ok: true, cursors: { receipts: null, steers: null },
      items: items.map(cardOf),
    };
  }
  if (operation === "read_sent_instruction_bodies") {
    const { cards } = executionWindowRequestSchemas.read_sent_instruction_bodies.parse(request);
    return { ok: true, items: cards.flatMap((key) => {
      const exact = items.find((item) => item.sequence === key.sequence && item.sourceTurnId === key.sourceTurnId
        && conversationPeerKey(item.target) === conversationPeerKey(key.recipient)
        && ("receiptId" in key ? "receiptId" in item && item.receiptId === key.receiptId : "messageSeq" in item && item.messageSeq === key.messageSeq));
      return exact ? [bodyOf(exact)] : [];
    }) };
  }
  return undefined;
}
