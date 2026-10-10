import { getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import type { SessionMetadataResult, SessionMessageIdentityInput, SessionMessageIdentity } from "../session/session-runtime-storage-contract.js";
import {
  type CharacterAffectTurnSettlementStorageAccess,
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
  storage: CharacterAffectTurnSettlementStorageAccess;
  startupRecoveryCutoff: string;
  readyCursor?: CharacterAffectTurnDrainCursor;
  getSessionMetadata(sessionId: string): Promise<SessionMetadataResult | null>;
  getSessionMessageIdentity(input: SessionMessageIdentityInput): Promise<SessionMessageIdentity | null>;
  settle(item: PendingCharacterAffectTurnSettlement): Promise<boolean>;
  onDiscard(item: PendingCharacterAffectTurnSettlement): void;
  onFailure(item: PendingCharacterAffectTurnSettlement, error: unknown): void;
  isCurrentGeneration?: () => boolean | Promise<boolean>;
  now?: () => string;
}): Promise<CharacterAffectTurnDrainResult> {
  const isCurrentGeneration = input.isCurrentGeneration ?? (() => true);
  const invalidated = (): CharacterAffectTurnDrainResult => ({
    retryRequired: true,
    nextReadyCursor: undefined,
  });

  if (!await isCurrentGeneration()) {
    return invalidated();
  }
  const observedAt = (input.now ?? (() => new Date().toISOString()))();
  if (!await isCurrentGeneration()) {
    return invalidated();
  }
  const recoveryPending = await input.storage.listUnreadyPendingBefore(
    observedAt,
    UNREADY_RECOVERY_LIMIT,
  );
  for (const item of recoveryPending) {
    const metadata = await input.getSessionMetadata(item.sessionId);
    if (!await isCurrentGeneration()) {
      return invalidated();
    }
    const message = metadata && hasSettlementSessionOwner(metadata.summary, item)
      ? await input.getSessionMessageIdentity({
        sessionId: item.sessionId,
        incarnationId: getSessionIncarnationId(metadata.summary),
        messageIndex: item.assistantMessageIndex,
      })
      : null;
    if (!await isCurrentGeneration()) {
      return invalidated();
    }
    if (message?.role === "assistant" && message.text === item.assistantMessage) {
      if (!await isCurrentGeneration()) {
        return invalidated();
      }
      await input.storage.markReady(item.correlationId);
    } else if (item.createdAt < input.startupRecoveryCutoff) {
      if (!await isCurrentGeneration()) {
        return invalidated();
      }
      input.onDiscard(item);
      if (!await isCurrentGeneration()) {
        return invalidated();
      }
      await input.storage.markDiscarded(item.correlationId);
    }
  }

  if (!await isCurrentGeneration()) {
    return invalidated();
  }
  let pending = await input.storage.listDueReadyPending(observedAt, READY_SETTLEMENT_LIMIT, input.readyCursor);
  if (!await isCurrentGeneration()) {
    return invalidated();
  }
  if (pending.length === 0 && input.readyCursor) {
    pending = await input.storage.listDueReadyPending(observedAt, READY_SETTLEMENT_LIMIT);
    if (!await isCurrentGeneration()) {
      return invalidated();
    }
  }
  if (pending.length === 0) {
    if (!await isCurrentGeneration()) {
      return invalidated();
    }
    return {
      retryRequired: await input.storage.hasRecoverablePending(),
      nextReadyCursor: undefined,
    };
  }

  const last = pending.at(-1)!;
  const nextReadyCursor = pending.length === READY_SETTLEMENT_LIMIT
    ? { createdAt: last.createdAt, correlationId: last.correlationId }
    : undefined;
  let retryRequired = recoveryPending.length > 0 || pending.length === READY_SETTLEMENT_LIMIT;
  for (const item of pending) {
    if (!await isCurrentGeneration()) {
      return invalidated();
    }
    try {
      const settled = await input.settle(item);
      if (!await isCurrentGeneration()) {
        return invalidated();
      }
      retryRequired ||= !settled;
    } catch (error) {
      if (!await isCurrentGeneration()) {
        return invalidated();
      }
      retryRequired = true;
      input.onFailure(item, error);
      if (!await isCurrentGeneration()) {
        return invalidated();
      }
    }
  }

  if (!await isCurrentGeneration()) {
    return invalidated();
  }
  retryRequired ||= await input.storage.hasRecoverablePending();
  return { retryRequired, nextReadyCursor };
}
