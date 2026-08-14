import type { Session } from "../src/session-state.js";
import {
  CharacterAffectTurnSettlementStorage,
  hasCommittedAssistantMessage,
  type PendingCharacterAffectTurnSettlement,
} from "./character-affect-turn-settlement-storage.js";

const UNREADY_RECOVERY_LIMIT = 100;
const READY_SETTLEMENT_LIMIT = 100;

export type CharacterAffectTurnDrainCursor = Pick<
  PendingCharacterAffectTurnSettlement,
  "createdAt" | "correlationId"
>;

export type CharacterAffectTurnDrainResult = {
  retryRequired: boolean;
  nextReadyCursor: CharacterAffectTurnDrainCursor | undefined;
};

export async function drainCharacterAffectTurnSettlementBatch(input: {
  storage: CharacterAffectTurnSettlementStorage;
  startupRecoveryCutoff: string;
  readyCursor?: CharacterAffectTurnDrainCursor;
  getSession(sessionId: string): Promise<Session | null>;
  settle(
    item: PendingCharacterAffectTurnSettlement,
    session: Session,
  ): Promise<boolean>;
  onDiscard(item: PendingCharacterAffectTurnSettlement): void;
  onFailure(item: PendingCharacterAffectTurnSettlement, error: unknown): void;
  now?: () => string;
}): Promise<CharacterAffectTurnDrainResult> {
  const observedAt = (input.now ?? (() => new Date().toISOString()))();
  const recoveryPending = input.storage.listUnreadyPendingBefore(
    observedAt,
    UNREADY_RECOVERY_LIMIT,
  );
  for (const item of recoveryPending) {
    const session = await input.getSession(item.sessionId);
    if (
      session
      && session.characterId === item.characterId
      && hasCommittedAssistantMessage(session.messages, item)
    ) {
      input.storage.markReady(item.correlationId);
    } else if (item.createdAt < input.startupRecoveryCutoff) {
      input.onDiscard(item);
      input.storage.markDiscarded(item.correlationId);
    }
  }

  let pending = input.storage.listDueReadyPending(observedAt, READY_SETTLEMENT_LIMIT, input.readyCursor);
  if (pending.length === 0 && input.readyCursor) {
    pending = input.storage.listDueReadyPending(observedAt, READY_SETTLEMENT_LIMIT);
  }
  if (pending.length === 0) {
    return {
      retryRequired: input.storage.hasRecoverablePending(),
      nextReadyCursor: undefined,
    };
  }

  const last = pending.at(-1)!;
  const nextReadyCursor = pending.length === READY_SETTLEMENT_LIMIT
    ? { createdAt: last.createdAt, correlationId: last.correlationId }
    : undefined;
  let retryRequired = recoveryPending.length > 0 || pending.length === READY_SETTLEMENT_LIMIT;
  for (const item of pending) {
    const session = await input.getSession(item.sessionId);
    if (!session || session.characterId !== item.characterId) {
      input.onDiscard(item);
      input.storage.markDiscarded(item.correlationId);
      continue;
    }
    try {
      const settled = await input.settle(item, session);
      retryRequired ||= !settled;
    } catch (error) {
      retryRequired = true;
      input.onFailure(item, error);
    }
  }

  retryRequired ||= input.storage.hasRecoverablePending();
  return { retryRequired, nextReadyCursor };
}
