import type { Session } from "../src/session-state.js";
import {
  CharacterAffectTurnSettlementStorage,
  hasCommittedAssistantMessage,
  hasSettlementSessionOwner,
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
  isCurrentGeneration?: () => boolean;
  now?: () => string;
}): Promise<CharacterAffectTurnDrainResult> {
  const isCurrentGeneration = input.isCurrentGeneration ?? (() => true);
  const invalidated = (): CharacterAffectTurnDrainResult => ({
    retryRequired: true,
    nextReadyCursor: undefined,
  });

  if (!isCurrentGeneration()) {
    return invalidated();
  }
  const observedAt = (input.now ?? (() => new Date().toISOString()))();
  if (!isCurrentGeneration()) {
    return invalidated();
  }
  const recoveryPending = input.storage.listUnreadyPendingBefore(
    observedAt,
    UNREADY_RECOVERY_LIMIT,
  );
  for (const item of recoveryPending) {
    const session = await input.getSession(item.sessionId);
    if (!isCurrentGeneration()) {
      return invalidated();
    }
    if (
      session
      && hasSettlementSessionOwner(session, item)
      && hasCommittedAssistantMessage(session.messages, item)
    ) {
      if (!isCurrentGeneration()) {
        return invalidated();
      }
      input.storage.markReady(item.correlationId);
    } else if (item.createdAt < input.startupRecoveryCutoff) {
      if (!isCurrentGeneration()) {
        return invalidated();
      }
      input.onDiscard(item);
      if (!isCurrentGeneration()) {
        return invalidated();
      }
      input.storage.markDiscarded(item.correlationId);
    }
  }

  if (!isCurrentGeneration()) {
    return invalidated();
  }
  let pending = input.storage.listDueReadyPending(observedAt, READY_SETTLEMENT_LIMIT, input.readyCursor);
  if (!isCurrentGeneration()) {
    return invalidated();
  }
  if (pending.length === 0 && input.readyCursor) {
    pending = input.storage.listDueReadyPending(observedAt, READY_SETTLEMENT_LIMIT);
    if (!isCurrentGeneration()) {
      return invalidated();
    }
  }
  if (pending.length === 0) {
    if (!isCurrentGeneration()) {
      return invalidated();
    }
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
    if (!isCurrentGeneration()) {
      return invalidated();
    }
    if (!session || !hasSettlementSessionOwner(session, item)) {
      if (!isCurrentGeneration()) {
        return invalidated();
      }
      input.onDiscard(item);
      if (!isCurrentGeneration()) {
        return invalidated();
      }
      input.storage.markDiscarded(item.correlationId);
      continue;
    }
    try {
      const settled = await input.settle(item, session);
      if (!isCurrentGeneration()) {
        return invalidated();
      }
      retryRequired ||= !settled;
    } catch (error) {
      if (!isCurrentGeneration()) {
        return invalidated();
      }
      retryRequired = true;
      input.onFailure(item, error);
      if (!isCurrentGeneration()) {
        return invalidated();
      }
    }
  }

  if (!isCurrentGeneration()) {
    return invalidated();
  }
  retryRequired ||= input.storage.hasRecoverablePending();
  return { retryRequired, nextReadyCursor };
}
