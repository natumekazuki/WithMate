import type { RunSessionTurnRequest, ComposerPreview } from "../../../src-shared/session/runtime-state.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import { getSessionIncarnationId } from "../../../src-shared/session/session-state.js";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { ComposerControllerRegistry, ComposerOwner } from "../composer-controller.js";
import { createComposerPreviewRequest } from "../use-composer-preview-resolution.js";
import type { SessionSubmitCoordinator } from "./session-submit-coordinator.js";
import { resolveComposerSendPreflight } from "../composer/session-composer-feedback.js";
import { SessionTurnAcceptance } from "./session-turn-acceptance.js";
import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";
import type { AuxiliaryDraftPersistenceOwner } from "../auxiliary-draft-persistence-owner.js";

type SessionRunApi = Pick<WithMateWindowApi, "previewComposerInput" | "enqueueSessionTurn" | "getSessionTurnQueueReceipt">;

export async function runMainSessionTurnOperation(input: {
  api: SessionRunApi | null;
  sessionId: string;
  selectedSession: Session;
  request: RunSessionTurnRequest;
  composerRegistry: ComposerControllerRegistry;
  composerOwner: ComposerOwner;
  submitCoordinator: SessionSubmitCoordinator;
  acceptance: SessionTurnAcceptance;
  auxiliaryDraftOwner?: AuxiliaryDraftPersistenceOwner;
  isCurrentSubmission?: () => boolean;
  queueTurn?: boolean;
  clearDraft: boolean;
  collapseActionDock: boolean;
  selectedSessionRunState: Session["runState"] | null;
  blockedReason: string | null;
  isReadOnly: boolean;
  validateWorkspace: () => Promise<unknown>;
  state: {
    setComposerPreview: (preview: ComposerPreview) => void;
    setPendingSubmitSessionId: (update: string | null | ((current: string | null) => string | null)) => void;
    setForceComposerBlockedFeedback: (value: boolean) => void;
    collapseActionDock: () => void;
  };
  log: (event: string, details: Record<string, unknown>) => void;
}): Promise<SessionTurnQueueReceipt | null> {
  const { api, sessionId, composerRegistry, composerOwner, state } = input;
  if (!api) return null;
  const captured = composerRegistry.capture(composerOwner);
  const messageText = input.request.submitSource === "composer" ? captured.draft : input.request.userMessage;
  const request = { ...input.request, userMessage: messageText, incarnationId: getSessionIncarnationId(input.selectedSession) };
  const lease = input.submitCoordinator.tryAcquire(sessionId);
  if (!lease) return null;
  state.setPendingSubmitSessionId(sessionId);
  try {
    if (composerRegistry.isFrozen || input.blockedReason || input.isReadOnly || !(await input.validateWorkspace())) {
      state.setForceComposerBlockedFeedback(true);
      return null;
    }
    if (input.acceptance.hasUncertain(sessionId)) throw new Error("A previous turn's acceptance is unknown. Check Receipt before sending another turn.");
    if (input.auxiliaryDraftOwner) {
      try {
        await input.auxiliaryDraftOwner.flush();
        await input.auxiliaryDraftOwner.reload();
      } catch (error) {
        composerRegistry.setSaveState(composerOwner, "error", "Draft could not be saved.");
        throw error;
      }
      const durable = input.auxiliaryDraftOwner.durableRecord;
      if (composerRegistry.capture(composerOwner).revision !== captured.revision || input.isCurrentSubmission?.() === false) return null;
      if (!durable || durable.auxiliarySessionId !== sessionId || durable.text !== captured.draft) {
        composerRegistry.setSaveState(composerOwner, "error", "Draft could not be saved.");
        return null;
      }
      request.auxiliaryDraftIncarnation = durable.incarnation;
      request.auxiliaryDraftDurableRevision = durable.durableRevision;
    }
    const previewRequest = createComposerPreviewRequest({ api, sessionId });
    if (!previewRequest) return null;
    const preview = await previewRequest(messageText);
    if (composerRegistry.isFrozen || composerRegistry.capture(composerOwner).revision !== captured.revision || input.isCurrentSubmission?.() === false) return null;
    state.setComposerPreview(preview);
    const preflight = resolveComposerSendPreflight({
      runState: input.queueTurn ? "idle" : input.selectedSessionRunState,
      blockedReason: input.blockedReason ?? "", inputErrors: preview.errors, draftText: messageText,
    });
    if (preflight.blockedMessage) {
      state.setForceComposerBlockedFeedback(true);
      return null;
    }
    const receipt = await input.acceptance.submit(api, sessionId, {
      request, owner: composerOwner, revision: captured.revision, clearDraft: input.clearDraft,
      auxiliaryDraftOwner: input.auxiliaryDraftOwner,
    }, composerRegistry);
    state.setForceComposerBlockedFeedback(false);
    input.log("renderer.queue.accepted", { sessionId, clientRequestId: receipt.requestId, state: receipt.state });
    if (input.collapseActionDock) state.collapseActionDock();
    // Queue acceptance is not a saved message or an optimistic running Session.
    return receipt;
  } finally {
    lease.release();
    state.setPendingSubmitSessionId((current) => current === sessionId ? null : current);
  }
}
