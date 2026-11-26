import { useState } from "react";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { AuxiliarySession } from "../../../src-shared/auxiliary/auxiliary-session-state.js";
import type { AuxiliaryDraftPersistence } from "../auxiliary/use-auxiliary-draft-persistence.js";
import type { ComposerControllerRegistry, ComposerOwner } from "../composer-controller.js";
import { createSessionTurnClientRequestId, type SessionSubmitCoordinator } from "./session-submit-coordinator.js";
import { resolveSessionRunErrorMessage } from "./session-live-run-state.js";

export function useSessionTurnInput(input: {
  api: Pick<WithMateWindowApi, "previewComposerInput" | "steerSessionTurn" | "steerAuxiliarySessionTurn"> | null;
  composerRegistry: ComposerControllerRegistry;
  drafts: AuxiliaryDraftPersistence;
  submitCoordinator: SessionSubmitCoordinator;
}) {
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, { revision: number; message: string }>>({});

  const send = async (target: {
    owner: ComposerOwner;
    auxiliarySession: AuxiliarySession | null;
    replyTo?: import("../../../src-shared/session/session-reply.js").SessionReply;
    onAccepted?(): void;
    turnId: string | null;
    canSendInput: boolean;
    blockedReason: string;
    isReadOnly: boolean;
    isCurrent(): boolean;
    isCurrentOwner(): boolean;
    retainDetail(): () => void;
    onBlocked(): void;
  }) => {
    const { api, composerRegistry: registry } = input;
    const { owner, turnId } = target;
    if (!api || !target.canSendInput || !turnId || registry.isFrozen || target.blockedReason || target.isReadOnly) return;
    if (owner.kind === "auxiliary" && !target.auxiliarySession) return;
    const captured = registry.capture(owner);
    const current = registry.get(owner);
    if (!captured.draft.trim() || current.isImeComposing || current.saveState === "error" || current.preview.errors.length > 0) {
      target.onBlocked();
      return;
    }
    // Send and direct Steer can run before React commits their disabled states.
    // Both submit the same composer revision, so share the synchronous owner lease.
    const lease = input.submitCoordinator.tryAcquire(owner.id);
    if (!lease) return;
    setPendingIds((previous) => new Set(previous).add(owner.id));
    setErrors((previous) => { const next = { ...previous }; delete next[owner.id]; return next; });
    const releaseDetail = target.retainDetail();
    const operation = async () => {
      let submission: Awaited<ReturnType<AuxiliaryDraftPersistence["prepareSubmission"]>> = null;
      try {
        if (target.auxiliarySession) {
          submission = await input.drafts.prepareSubmission(target.auxiliarySession, captured, "input");
          if (!submission) return;
        }
        const preview = await api.previewComposerInput(owner.id, captured.draft);
        if (registry.isFrozen || !target.isCurrent() || registry.capture(owner).revision !== captured.revision) return;
        registry.setPreview(owner, preview);
        if (preview.errors.length > 0) { target.onBlocked(); return; }
        const request = {
          expectedTurnId: turnId,
          userMessage: captured.draft,
          ...(target.replyTo ? { replyTo: target.replyTo } : {}),
          clientRequestId: createSessionTurnClientRequestId(),
          ...(submission ? { auxiliaryDraftIncarnation: submission.durable.incarnation, auxiliaryDraftDurableRevision: submission.durable.durableRevision } : {}),
        };
        const result = submission
          ? await submission.consume(() => api.steerAuxiliarySessionTurn(owner.id, request))
          : await api.steerSessionTurn(owner.id, request);
        if (result.turnId !== turnId) throw new Error("Input acceptance could not be confirmed.");
        target.onAccepted?.();
        if (!target.isCurrentOwner()) return;
        if (submission) submission.clear();
        else registry.clearIfRevision(owner, captured.revision);
        await submission?.reload().catch(() => undefined);
      } catch (error) {
        await submission?.reload().catch(() => undefined);
        if (!target.isCurrentOwner()) return;
        setErrors((previous) => ({ ...previous, [owner.id]: {
          revision: captured.revision,
          message: `Input to ${owner.kind === "auxiliary" ? "Auxiliary" : "Main"} was not confirmed. Your draft is preserved. ${resolveSessionRunErrorMessage(error, "Could not send input.")}`,
        } }));
      } finally {
        releaseDetail();
        lease.release();
        setPendingIds((previous) => {
          const next = new Set(previous);
          next.delete(owner.id);
          return next;
        });
      }
    };
    await (owner.kind === "auxiliary" ? input.drafts.trackSend(operation()) : operation());
  };
  return { send, pendingIds, errors };
}
