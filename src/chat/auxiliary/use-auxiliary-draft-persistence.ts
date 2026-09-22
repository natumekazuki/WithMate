import { useCallback, useMemo, useRef } from "react";

import type { AuxiliaryDraftRecord } from "../../../src-shared/auxiliary/auxiliary-draft-contract.js";
import type { AuxiliarySession } from "../../../src-shared/auxiliary/auxiliary-session-state.js";
import type { WithMateWindowAuxiliaryApi } from "../../../src-shared/ipc/withmate-window-api.js";
import { currentTimestampLabel } from "../../../src-shared/time-state.js";
import {
  AuxiliaryDraftPersistenceOwner,
  type AuxiliaryDraftPersistenceSaveResult,
} from "../auxiliary-draft-persistence-owner.js";
import { ComposerControllerRegistry, type ComposerOwner } from "../composer-controller.js";

export type AuxiliaryDraftPersistence = {
  getOwner(session: AuxiliarySession): AuxiliaryDraftPersistenceOwner | null;
  observeSave(sessionId: string, draftRevision: number, operation: Promise<void>): Promise<void>;
  changeDraft(session: AuxiliarySession, value: string, selectionStart: number): Promise<void>;
  retrySave(session: AuxiliarySession): void;
  trackSend<T>(operation: Promise<T>): Promise<T>;
  waitForPendingSends(): Promise<void>;
  flushAll(): Promise<void>;
  pendingSessionIds(): string[];
};

export function useAuxiliaryDraftPersistence(input: {
  api: WithMateWindowAuxiliaryApi | null;
  composerRegistry: ComposerControllerRegistry;
  touchRecency(id: string, updatedAt: string): void;
  isFrozen(): boolean;
}): AuxiliaryDraftPersistence {
  const ownersRef = useRef(new Map<string, AuxiliaryDraftPersistenceOwner>());
  const pendingSendsRef = useRef(new Set<Promise<unknown>>());
  const inputRef = useRef(input);
  inputRef.current = input;

  const getOwner = useCallback((session: AuxiliarySession) => {
    const { api } = inputRef.current;
    if (!api) return null;
    let owner = ownersRef.current.get(session.id);
    if (owner) return owner;
    let fixedIncarnation: string | null = null;
    owner = new AuxiliaryDraftPersistenceOwner({
      load: async () => {
        const status = await api.getAuxiliarySessionStatus(session.id);
        const record = await api.getAuxiliaryDraft(session.id);
        if (!status
          || !record
          || record.auxiliarySessionId !== session.id
          || status.id !== session.id
          || status.parentSessionId !== session.parentSessionId
          || !status.incarnation
          || record.parentSessionId !== status.parentSessionId
          || record.incarnation !== status.incarnation) {
          return null;
        }
        if (fixedIncarnation && fixedIncarnation !== record.incarnation) return null;
        fixedIncarnation = record.incarnation;
        return record;
      },
      now: currentTimestampLabel,
      save: async (record: AuxiliaryDraftRecord): Promise<AuxiliaryDraftPersistenceSaveResult> => {
        if (fixedIncarnation && record.incarnation !== fixedIncarnation) {
          return { outcome: "stale" };
        }
        const result = await api.saveAuxiliaryDraft({
          auxiliarySessionId: record.auxiliarySessionId,
          parentSessionId: record.parentSessionId,
          incarnation: record.incarnation,
          expectedDurableRevision: record.durableRevision,
          text: record.text,
          updatedAt: record.updatedAt,
        });
        if (result.outcome !== "saved" || !result.ack) {
          return result.outcome === "saved" ? { outcome: "rejected" } : { outcome: result.outcome };
        }
        return {
          outcome: "saved",
          record: { ...record, durableRevision: result.ack.durableRevision, updatedAt: result.ack.updatedAt },
        };
      },
    });
    ownersRef.current.set(session.id, owner);
    return owner;
  }, []);

  const ownerForId = useCallback((sessionId: string): ComposerOwner => ({ kind: "auxiliary", id: sessionId }), []);

  const observeSave = useCallback(async (sessionId: string, draftRevision: number, operation: Promise<void>) => {
    const owner = ownerForId(sessionId);
    inputRef.current.composerRegistry.setSaveState(owner, "saving");
    try {
      await operation;
      if (inputRef.current.composerRegistry.capture(owner).revision === draftRevision) {
        inputRef.current.composerRegistry.setSaveState(owner, "saved");
      }
    } catch (error) {
      console.error(error);
      if (inputRef.current.composerRegistry.capture(owner).revision === draftRevision) {
        inputRef.current.composerRegistry.setSaveState(owner, "error", "Draft could not be saved.");
      }
    }
  }, [ownerForId]);

  const changeDraft = useCallback(async (session: AuxiliarySession, value: string, selectionStart: number) => {
    if (inputRef.current.isFrozen()) return;
    const owner = ownerForId(session.id);
    const previousDraft = inputRef.current.composerRegistry.get(owner).draft;
    inputRef.current.composerRegistry.setDraft(owner, value, { start: selectionStart, end: selectionStart });
    if (previousDraft !== value) inputRef.current.touchRecency(session.id, currentTimestampLabel());
    const draftRevision = inputRef.current.composerRegistry.capture(owner).revision;
    const persistenceOwner = getOwner(session);
    if (persistenceOwner) await observeSave(session.id, draftRevision, persistenceOwner.enqueue(value));
  }, [getOwner, observeSave, ownerForId]);

  const retrySave = useCallback((session: AuxiliarySession) => {
    if (inputRef.current.isFrozen()) return;
    const persistenceOwner = getOwner(session);
    if (!persistenceOwner) return;
    const owner = ownerForId(session.id);
    const operation = persistenceOwner.hasPending
      ? persistenceOwner.flush()
      : persistenceOwner.enqueue(inputRef.current.composerRegistry.get(owner).draft);
    void observeSave(session.id, inputRef.current.composerRegistry.capture(owner).revision, operation);
  }, [getOwner, observeSave, ownerForId]);

  const trackSend = useCallback(<T,>(operation: Promise<T>) => {
    const tracked = operation as Promise<unknown>;
    pendingSendsRef.current.add(tracked);
    const release = () => pendingSendsRef.current.delete(tracked);
    void operation.then(release, release);
    return operation;
  }, []);

  const waitForPendingSends = useCallback(async () => {
    await Promise.allSettled(Array.from(pendingSendsRef.current));
  }, []);

  const flushAll = useCallback(async () => {
    await Promise.all(Array.from(ownersRef.current.values(), (owner) => owner.flush()));
  }, []);

  const pendingSessionIds = useCallback(() => Array.from(ownersRef.current.entries())
    .filter(([, owner]) => owner.hasPending)
    .map(([sessionId]) => sessionId), []);

  return useMemo(() => ({ getOwner, observeSave, changeDraft, retrySave, trackSend, waitForPendingSends, flushAll, pendingSessionIds }), [changeDraft, flushAll, getOwner, observeSave, pendingSessionIds, retrySave, trackSend, waitForPendingSends]);
}
