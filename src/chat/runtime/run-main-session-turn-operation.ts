import type {
  LiveSessionRunState,
  RunSessionTurnRequest,
  ComposerPreview,
} from "../../../src-shared/session/runtime-state.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type {
  ComposerControllerRegistry,
  ComposerOwner,
} from "../../chat/composer-controller.js";
import { createComposerPreviewRequest } from "../use-composer-preview-resolution.js";
import { resolveComposerPreviewDisplay } from "../composer/composer-preview-config.js";
import {
  applyOptimisticSessionRunUpdate,
  type OwnedLiveSessionRunState,
} from "./session-live-run-state.js";
import {
  convergeRejectedLiveRunState,
  convergeRejectedSessionSnapshot,
  convergeResolvedSessionProjection,
  recoverRejectedSessionSnapshot,
  mergeRejectedSessionDraft,
  fingerprintSessionDraft,
  type SessionSubmitCoordinator,
} from "./session-submit-coordinator.js";
import { resolveComposerSendPreflight } from "../composer/session-composer-feedback.js";
import type { AppSettings } from "../../../src-shared/settings/provider-settings-state.js";

type RevisionPort = { capture(): number; isCurrent(revision: number): boolean };
type SessionRunApi = Pick<
  WithMateWindowApi,
  "previewComposerInput" | "runSessionTurn" | "getSession" | "getLiveSessionRun"
>;
type ComposerPorts = Pick<
  ComposerControllerRegistry,
  "capture" | "clearIfRevision" | "restoreIfRevision"
>;

type StatePorts = {
  setAuthoritativeSessions: (update: (current: Session[]) => Session[]) => void;
  setLiveRunState: (
    update: (current: OwnedLiveSessionRunState) => OwnedLiveSessionRunState,
  ) => void;
  setComposerPreview: (
    preview: ReturnType<typeof resolveComposerPreviewDisplay>,
  ) => void;
  acknowledgePreviewChatMessageCount: (
    sessionId: string,
    messageCount: number,
  ) => void;
  setPendingSubmitSessionId: (
    update: string | null | ((current: string | null) => string | null),
  ) => void;
  setForceComposerBlockedFeedback: (value: boolean) => void;
  collapseActionDock: () => void;
};

export async function runMainSessionTurnOperation(input: {
  api: SessionRunApi | null;
  sessionId: string;
  selectedSession: Session;
  request: RunSessionTurnRequest;
  composerRegistry: ComposerPorts;
  composerOwner: ComposerOwner;
  submitCoordinator: SessionSubmitCoordinator;
  clearDraft: boolean;
  collapseActionDock: boolean;
  isCentralPreviewActive: boolean;
  hasLiveRun: boolean;
  selectedSessionRunState: Session["runState"] | null;
  blockedReason: string | null;
  isReadOnly: boolean;
  userMicrocopyCatalog: AppSettings["userMicrocopyCatalog"];
  currentTimestamp: string;
  validateWorkspace: () => Promise<unknown>;
  state: StatePorts;
  revisions: {
    mutation: RevisionPort;
    projection: RevisionPort;
    liveRun: RevisionPort;
  };
  log: (event: string, details: Record<string, unknown>) => void;
}): Promise<Session | null> {
  const {
    api,
    sessionId,
    selectedSession,
    composerRegistry,
    composerOwner,
    submitCoordinator,
    clearDraft,
    collapseActionDock,
    isCentralPreviewActive,
    hasLiveRun,
    selectedSessionRunState,
    blockedReason,
    isReadOnly,
    userMicrocopyCatalog,
    validateWorkspace,
    state,
    revisions,
    log,
  } = input;
  if (!api) return null;
  const sendCapture = composerRegistry.capture(composerOwner);
  let messageText = input.request.userMessage;
  if (input.request.submitSource === "composer")
    messageText = sendCapture.draft;
  const request: RunSessionTurnRequest = {
    ...input.request,
    userMessage: messageText,
    codexReviewer: selectedSession.codexReviewer,
  };
  const submitLease = submitCoordinator.tryAcquire(sessionId);
  if (!submitLease) {
    state.setForceComposerBlockedFeedback(true);
    return null;
  }
  state.setPendingSubmitSessionId(sessionId);
  const clientRequestId = input.request.clientRequestId;
  const investigationStartedAt = Date.now();
  log("renderer.send.start", {
    sessionId,
    clientRequestId,
    submitSource: input.request.submitSource,
    draftFingerprint: fingerprintSessionDraft(messageText),
    runState: selectedSession.runState,
    status: selectedSession.status,
    messageCount: selectedSession.messages.length,
    hasLiveRun,
    draftChars: messageText.length,
  });
  try {
    if (blockedReason || isReadOnly) {
      state.setForceComposerBlockedFeedback(true);
      return null;
    }
    if (!(await validateWorkspace())) {
      state.setForceComposerBlockedFeedback(true);
      return null;
    }
    const previewRequest = createComposerPreviewRequest({ api, sessionId });
    if (!previewRequest) return null;
    const nextMessage = messageText.trim();
    const preview: ComposerPreview = await previewRequest(messageText);
    const displayPreview = resolveComposerPreviewDisplay(
      preview,
      userMicrocopyCatalog,
    );
    log("renderer.composer-preview.done", {
      sessionId,
      clientRequestId,
      elapsedMs: Date.now() - investigationStartedAt,
      attachmentCount: preview.attachments.length,
      errorCount: preview.errors.length,
    });
    const previewCapture = composerRegistry.capture(composerOwner);
    if (
      previewCapture.revision !== sendCapture.revision ||
      previewCapture.draft !== sendCapture.draft
    )
      return null;
    state.setComposerPreview(displayPreview);
    const preflight = resolveComposerSendPreflight({
      runState: selectedSessionRunState,
      blockedReason: blockedReason ?? "",
      inputErrors: displayPreview.errors,
      draftText: messageText,
    });
    if (preflight.blockedMessage) {
      state.setForceComposerBlockedFeedback(true);
      return null;
    }
    if (collapseActionDock) state.collapseActionDock();
    const clearRevision = clearDraft
      ? composerRegistry.clearIfRevision(composerOwner, sendCapture.revision)
      : null;
    const updatedSession = applyOptimisticSessionRunUpdate({
      session: selectedSession,
      userMessage: nextMessage,
      updatedAt: input.currentTimestamp,
      status: "running",
      updateLiveRunState: state.setLiveRunState,
      applyRunningSession: (runningSession) =>
        state.setAuthoritativeSessions(() => [runningSession]),
    });
    const optimisticSessionMutationRevision = revisions.mutation.capture();
    const optimisticSessionProjectionRevision = revisions.projection.capture();
    const optimisticLiveRunRevision = revisions.liveRun.capture();
    if (isCentralPreviewActive)
      state.acknowledgePreviewChatMessageCount(
        updatedSession.id,
        updatedSession.messages.length,
      );
    log("renderer.optimistic-running-applied", {
      sessionId: updatedSession.id,
      clientRequestId,
      elapsedMs: Date.now() - investigationStartedAt,
      messageCount: updatedSession.messages.length,
      runState: updatedSession.runState,
      status: updatedSession.status,
    });
    try {
      const savedSession = await api.runSessionTurn(sessionId, request);
      const preserveCurrentPin = !revisions.projection.isCurrent(
        optimisticSessionProjectionRevision,
      );
      state.setAuthoritativeSessions((current) => [
        convergeResolvedSessionProjection(
          current.find((session) => session.id === savedSession.id) ??
            selectedSession,
          savedSession,
          preserveCurrentPin,
        ),
      ]);
      log("renderer.run-session-turn.resolved", {
        sessionId: savedSession.id,
        clientRequestId,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: savedSession.messages.length,
        runState: savedSession.runState,
        status: savedSession.status,
      });
      return savedSession;
    } catch (error) {
      if (clearRevision !== null)
        composerRegistry.restoreIfRevision(
          composerOwner,
          clearRevision,
          (draft) => mergeRejectedSessionDraft(request.userMessage, draft),
        );
      const [refreshedSessionResult, refreshedLiveRunResult] =
        await Promise.allSettled([
          api.getSession(sessionId),
          api.getLiveSessionRun(sessionId),
          validateWorkspace(),
        ]);
      const canReplaceOptimisticBody = revisions.mutation.isCurrent(
        optimisticSessionMutationRevision,
      );
      const preserveCurrentPin = !revisions.projection.isCurrent(
        optimisticSessionProjectionRevision,
      );
      if (
        refreshedSessionResult.status === "fulfilled" &&
        canReplaceOptimisticBody
      ) {
        state.setAuthoritativeSessions((current) => {
          const converged = convergeRejectedSessionSnapshot(
            current.find((session) => session.id === sessionId) ??
              selectedSession,
            updatedSession,
            refreshedSessionResult.value,
            true,
            preserveCurrentPin,
          );
          return converged ? [converged] : [];
        });
      } else if (
        canReplaceOptimisticBody &&
        (refreshedLiveRunResult.status === "rejected" ||
          refreshedLiveRunResult.value === null)
      ) {
        state.setAuthoritativeSessions((current) => {
          const recovered = recoverRejectedSessionSnapshot(
            current.find((session) => session.id === sessionId) ??
              selectedSession,
            updatedSession,
            true,
          );
          return recovered ? [recovered] : current;
        });
      }
      if (revisions.liveRun.isCurrent(optimisticLiveRunRevision)) {
        const refreshedLiveRun: LiveSessionRunState | null =
          refreshedLiveRunResult.status === "fulfilled"
            ? refreshedLiveRunResult.value
            : null;
        state.setLiveRunState((current) =>
          convergeRejectedLiveRunState(
            current,
            sessionId,
            refreshedLiveRun,
            optimisticLiveRunRevision,
            optimisticLiveRunRevision,
          ),
        );
      }
      log("renderer.run-session-turn.failed", {
        sessionId: updatedSession.id,
        clientRequestId,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: updatedSession.messages.length,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } finally {
    submitLease.release();
    state.setPendingSubmitSessionId((current) =>
      current === sessionId ? null : current,
    );
    state.setForceComposerBlockedFeedback(false);
  }
}
