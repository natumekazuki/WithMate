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
import { getMessageHistoryIndex } from "../../../src-shared/session/conversation-page.js";

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
  onSubmitted?: () => void;
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
    commitSubmission?: (publish: () => void) => void;
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
  let acceptanceStarted = false;
  state.setPendingSubmitSessionId(sessionId);
  try {
    if (composerRegistry.isFrozen || input.blockedReason || input.isReadOnly || !messageText.trim()) {
      state.setForceComposerBlockedFeedback(true);
      return null;
    }
    if (input.acceptance.hasUncertain(sessionId)) throw new Error("A previous turn's acceptance is unknown. Check Receipt before sending another turn.");
    const publish = () => input.acceptance.submissions.start({
      sessionId, incarnationId: request.incarnationId, requestId: request.clientRequestId!,
      historyMessageCount: input.selectedSession.messageCount ?? input.selectedSession.messages.reduce((count, message, index) => Math.max(count, getMessageHistoryIndex(message, index) + 1), 0),
      userMessage: messageText, queuedBehindRun: input.selectedSessionRunState === "running", error: "",
    });
    if (state.commitSubmission) state.commitSubmission(publish);
    else publish();
    state.setForceComposerBlockedFeedback(false);
    if (input.collapseActionDock) state.collapseActionDock();
    input.onSubmitted?.();
    const workspaceAvailable = await input.validateWorkspace();
    if (composerRegistry.isFrozen || composerRegistry.capture(composerOwner).revision !== captured.revision || input.isCurrentSubmission?.() === false) {
      input.acceptance.submissions.forget([request.clientRequestId!]);
      return null;
    }
    if (!workspaceAvailable) throw new Error("Workspace is not available. Your draft is preserved.");
    if (input.auxiliaryDraftOwner) {
      try {
        await input.auxiliaryDraftOwner.flush();
        await input.auxiliaryDraftOwner.reload();
      } catch (error) {
        composerRegistry.setSaveState(composerOwner, "error", "Draft could not be saved.");
        throw error;
      }
      const durable = input.auxiliaryDraftOwner.durableRecord;
      if (composerRegistry.isFrozen || composerRegistry.capture(composerOwner).revision !== captured.revision || input.isCurrentSubmission?.() === false) {
        input.acceptance.submissions.forget([request.clientRequestId!]);
        return null;
      }
      if (!durable || durable.auxiliarySessionId !== sessionId || durable.text !== captured.draft) {
        composerRegistry.setSaveState(composerOwner, "error", "Draft could not be saved.");
        throw new Error("Draft could not be saved. Your draft is preserved.");
      }
      request.auxiliaryDraftIncarnation = durable.incarnation;
      request.auxiliaryDraftDurableRevision = durable.durableRevision;
    }
    const previewRequest = createComposerPreviewRequest({ api, sessionId });
    if (!previewRequest) throw new Error("Composer input could not be checked. Your draft is preserved.");
    const preview = await previewRequest(messageText);
    if (composerRegistry.isFrozen || composerRegistry.capture(composerOwner).revision !== captured.revision || input.isCurrentSubmission?.() === false) {
      input.acceptance.submissions.forget([request.clientRequestId!]);
      return null;
    }
    state.setComposerPreview(preview);
    const preflight = resolveComposerSendPreflight({
      runState: input.queueTurn ? "idle" : input.selectedSessionRunState,
      blockedReason: input.blockedReason ?? "", inputErrors: preview.errors, draftText: messageText,
    });
    if (preflight.blockedMessage) {
      state.setForceComposerBlockedFeedback(true);
      throw new Error(preflight.blockedMessage);
    }
    acceptanceStarted = true;
    const receipt = await input.acceptance.submit(api, sessionId, {
      request, owner: composerOwner, revision: captured.revision, clearDraft: input.clearDraft,
      auxiliaryDraftOwner: input.auxiliaryDraftOwner,
    }, composerRegistry);
    input.log("renderer.queue.accepted", { sessionId, clientRequestId: receipt.requestId, state: receipt.state });
    return receipt;
  } catch (error) {
    if (!acceptanceStarted && (composerRegistry.isFrozen || composerRegistry.capture(composerOwner).revision !== captured.revision || input.isCurrentSubmission?.() === false)) {
      input.acceptance.submissions.forget([request.clientRequestId!]);
      return null;
    }
    input.acceptance.submissions.fail(request.clientRequestId!, error instanceof Error ? error.message : String(error), input.acceptance.hasUncertain(sessionId));
    throw error;
  } finally {
    lease.release();
    state.setPendingSubmitSessionId((current) => current === sessionId ? null : current);
  }
}
