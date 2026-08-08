import type { AuditLogSummary } from "../runtime-state.js";
import { applyComposerDraftChangeCommand } from "./composer-draft-handlers.js";

export type RetryBannerKind = "interrupted" | "failed" | "canceled";

export type RetryBannerState = {
  kind: RetryBannerKind;
  badge: string;
  title: string;
  lastRequestText: string;
};

export type RetryDraftRestoreState = {
  draft: string;
  caret: number;
  isRetryDraftReplacePending: false;
  isActionDockPinnedExpanded: true;
};

export function buildRetryDraftRestoreState(messageText: string): RetryDraftRestoreState {
  return {
    draft: messageText,
    caret: messageText.length,
    isRetryDraftReplacePending: false,
    isActionDockPinnedExpanded: true,
  };
}

export async function runRetryResendCommand(input: {
  isDisabled: boolean;
  messageText: string | null | undefined;
  resendMessage: (messageText: string) => Promise<void>;
}): Promise<void> {
  if (input.isDisabled || input.messageText == null) {
    return;
  }

  await input.resendMessage(input.messageText);
}

export function applyRetryDraftRestoreCommand(input: {
  messageText: string;
  setActionDockPinnedExpanded: (expanded: boolean) => void;
  setDraft: (draft: string) => void;
  setCaret: (caret: number) => void;
  syncCaret?: (caret: number) => void;
  setRetryDraftReplacePending: (pending: boolean) => void;
  focusComposer: (caret: number) => void;
}): void {
  const nextState = buildRetryDraftRestoreState(input.messageText);

  input.setActionDockPinnedExpanded(nextState.isActionDockPinnedExpanded);
  applyComposerDraftChangeCommand({
    value: nextState.draft,
    selectionStart: nextState.caret,
    setDraft: input.setDraft,
    setComposerCaret: input.setCaret,
    syncMainComposerCaret: input.syncCaret,
  });
  input.setRetryDraftReplacePending(nextState.isRetryDraftReplacePending);
  input.focusComposer(nextState.caret);
}

export function applyRetryEditCommand(input: {
  isDisabled: boolean;
  messageText: string | null | undefined;
  shouldProtectDraft: boolean;
  requestDraftReplaceConfirmation: () => void;
  restoreDraft: (messageText: string) => void;
}): void {
  if (input.isDisabled || input.messageText == null) {
    return;
  }

  if (input.shouldProtectDraft) {
    input.requestDraftReplaceConfirmation();
    return;
  }

  input.restoreDraft(input.messageText);
}

export function createRetryEditHandler(input: {
  isDisabled: boolean;
  messageText: string | null | undefined;
  shouldProtectDraft: boolean;
  requestDraftReplaceConfirmation: () => void;
  restoreDraft: (messageText: string) => void;
}): () => void {
  return () => applyRetryEditCommand(input);
}

export function applyRetryDraftReplaceConfirmation(input: {
  isDisabled: boolean;
  messageText: string | null | undefined;
  restoreDraft: (messageText: string) => void;
}): void {
  if (input.isDisabled || input.messageText == null) {
    return;
  }

  input.restoreDraft(input.messageText);
}

export function createRetryDraftReplaceConfirmationHandler(input: {
  isDisabled: boolean;
  messageText: string | null | undefined;
  restoreDraft: (messageText: string) => void;
}): () => void {
  return () => applyRetryDraftReplaceConfirmation(input);
}

export function applyCancelRetryDraftReplace(input: {
  setRetryDraftReplacePending: (pending: boolean) => void;
}): void {
  input.setRetryDraftReplacePending(false);
}

export function createCancelRetryDraftReplaceHandler(input: {
  setRetryDraftReplacePending: (pending: boolean) => void;
}): () => void {
  return () => applyCancelRetryDraftReplace(input);
}

export function resolveRetryBannerKind(input: {
  runState: string | null | undefined;
  latestTerminalAuditLogPhase?: AuditLogSummary["phase"] | null;
}): RetryBannerKind | null {
  if (input.runState === "interrupted") {
    return "interrupted";
  }

  if (input.runState === "error") {
    return "failed";
  }

  if (input.runState === "idle" && input.latestTerminalAuditLogPhase === "canceled") {
    return "canceled";
  }

  return null;
}

export function shouldProtectRetryEditDraft(input: {
  retryBanner: Pick<RetryBannerState, "lastRequestText"> | null;
  draft: string;
}): boolean {
  return !!input.retryBanner
    && input.draft.trim().length > 0
    && input.draft !== input.retryBanner.lastRequestText;
}

export function shouldShowRetryBanner(input: {
  hasActiveAuxiliarySession: boolean;
  hasLastUserMessage: boolean;
  isReadOnly: boolean;
  runState: string | null | undefined;
}): boolean {
  return !input.hasActiveAuxiliarySession
    && input.hasLastUserMessage
    && !input.isReadOnly
    && input.runState !== "running";
}

export function isRetryActionDisabled(input: {
  retryBanner: RetryBannerState | null;
  hasLastUserMessage: boolean;
  composerBlocked: boolean;
  isReadOnly: boolean;
  runState: string | null | undefined;
}): boolean {
  return !input.retryBanner
    || !input.hasLastUserMessage
    || input.composerBlocked
    || input.isReadOnly
    || input.runState === "running";
}
