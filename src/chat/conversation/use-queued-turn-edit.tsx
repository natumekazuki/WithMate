import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";
import { ComposerControllerRegistry, type ComposerOwner } from "../composer-controller.js";

type EditPhase = "beginning" | "editing" | "saving" | "canceling" | "unavailable";
export type QueuedTurnEdit = { receipt: SessionTurnQueueReceipt; phase: EditPhase; error: string };
export const queuedTurnEditOwner = (sessionId: string): ComposerOwner => ({ kind: "queue-edit", id: sessionId });
export const isQueuedTurnEditBusy = (edit: QueuedTurnEdit) => edit.phase === "beginning" || edit.phase === "saving" || edit.phase === "canceling";

type QueueEditContextValue = {
  edits: Readonly<Record<string, QueuedTurnEdit>>;
  begin(receipt: SessionTurnQueueReceipt): void;
};
export const QueuedTurnEditContext = createContext<QueueEditContextValue | null>(null);
export const useQueuedTurnEditContext = () => useContext(QueuedTurnEditContext);

export function useQueuedTurnEdit(api: WithMateWindowApi | null, registry: ComposerControllerRegistry) {
  const [edits, setEdits] = useState<Record<string, QueuedTurnEdit>>({});
  const current = useRef(edits);
  const put = useCallback((sessionId: string, edit: QueuedTurnEdit | null) => {
    const next = { ...current.current };
    if (edit) next[sessionId] = edit;
    else delete next[sessionId];
    current.current = next;
    setEdits(next);
  }, []);
  const begin = useCallback(async (receipt: SessionTurnQueueReceipt) => {
    if (!api || registry.isFrozen || current.current[receipt.sessionId]) return;
    const owner = queuedTurnEditOwner(receipt.sessionId);
    registry.replaceDraft(owner, receipt.captured.request.userMessage, { start: receipt.captured.request.userMessage.length, end: receipt.captured.request.userMessage.length });
    const pending: QueuedTurnEdit = { receipt, phase: "beginning", error: "" };
    put(receipt.sessionId, pending);
    try {
      const accepted = await api.beginQueuedSessionTurnEdit(receipt.sessionId, { incarnationId: receipt.incarnationId, id: receipt.id });
      if (current.current[receipt.sessionId] !== pending) return;
      registry.replaceDraft(owner, accepted.captured.request.userMessage, { start: accepted.captured.request.userMessage.length, end: accepted.captured.request.userMessage.length });
      put(receipt.sessionId, { receipt: accepted, phase: "editing", error: "" });
    } catch (error) {
      if (current.current[receipt.sessionId] === pending) put(receipt.sessionId, { receipt, phase: "unavailable", error: `Editing could not be started. Cancel Edit to return to your draft. ${error instanceof Error ? error.message : String(error)}` });
    }
  }, [api, registry, put]);
  const finish = useCallback(async (sessionId: string, submit: boolean) => {
    const edit = current.current[sessionId];
    if (!api || !edit || registry.isFrozen || isQueuedTurnEditBusy(edit) || submit && edit.phase !== "editing") return;
    const owner = queuedTurnEditOwner(sessionId);
    const text = registry.get(owner).draft;
    if (submit && (!text.trim() || registry.get(owner).preview.errors.length)) return;
    const pending: QueuedTurnEdit = { ...edit, phase: submit ? "saving" : "canceling", error: "" };
    put(sessionId, pending);
    try {
      const request = { incarnationId: edit.receipt.incarnationId, id: edit.receipt.id };
      if (submit) await api.updateQueuedSessionTurn(sessionId, { ...request, userMessage: text });
      else await api.cancelQueuedSessionTurnEdit(sessionId, request);
      if (current.current[sessionId] !== pending) return;
      registry.discardOwner(owner);
      put(sessionId, null);
      return true;
    } catch (error) {
      if (current.current[sessionId] === pending) put(sessionId, { ...edit, error: `${submit ? "The update could not be confirmed. Your edit is preserved. Check the queue before trying again." : "The end of editing could not be confirmed. Your edit is preserved."} ${error instanceof Error ? error.message : String(error)}` });
    }
  }, [api, registry, put]);
  return {
    edits, begin,
    canChangeDraft: (sessionId: string) => current.current[sessionId]?.phase === "editing" || current.current[sessionId]?.phase === "unavailable",
    submit: (sessionId: string) => finish(sessionId, true), cancel: (sessionId: string) => finish(sessionId, false),
  };
}
