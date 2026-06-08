import type { ApprovalMode } from "../approval-mode.js";
import type { CodexSandboxMode } from "../codex-sandbox-mode.js";
import type { MateTalkPathReference, MateTalkTurnInput } from "../mate/mate-state.js";
import type { ModelReasoningEffort } from "../model-catalog.js";
import type { AppSettings } from "../provider-settings-state.js";

export type MateTalkTurnState = {
  turnId: number;
  messageSequence: number;
};

export type MateTalkTurnMessage = {
  id: string;
  role: "user" | "mate";
  text: string;
};

export class MateTalkTurnController {
  private turnId = 0;
  private messageSequence = 0;

  beginTurn(): MateTalkTurnState {
    this.turnId += 1;
    this.messageSequence += 1;
    return {
      turnId: this.turnId,
      messageSequence: this.messageSequence,
    };
  }

  invalidateTurns(): void {
    this.turnId += 1;
  }

  isLatestTurn(turnId: number): boolean {
    return this.turnId === turnId;
  }
}

export const shouldSubmitMateTalkInputByKey = (eventLike: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}): boolean => {
  if (eventLike.isComposing === true) {
    return false;
  }
  if (eventLike.key !== "Enter") {
    return false;
  }
  if (eventLike.shiftKey === true) {
    return false;
  }
  return eventLike.ctrlKey === true || eventLike.metaKey === true;
};

export type MateTalkSubmitPreflightResult =
  | { status: "ready"; message: string }
  | { status: "blocked"; reason: "empty"; feedback: string }
  | { status: "blocked"; reason: "running" };

export function resolveMateTalkSubmitPreflight({
  draft,
  isRunning,
}: {
  draft: string;
  isRunning: boolean;
}): MateTalkSubmitPreflightResult {
  const message = draft.trim();
  if (!message) {
    return {
      status: "blocked",
      reason: "empty",
      feedback: "入力してから送信してね。",
    };
  }
  if (isRunning) {
    return { status: "blocked", reason: "running" };
  }
  return { status: "ready", message };
}

export function buildMateTalkTurnInput({
  message,
  provider,
  model,
  reasoningEffort,
  attachments,
  additionalDirectories,
  approvalMode,
  codexSandboxMode,
}: {
  message: string;
  provider: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  attachments: MateTalkPathReference[];
  additionalDirectories: string[];
  approvalMode: ApprovalMode;
  codexSandboxMode?: CodexSandboxMode;
}): MateTalkTurnInput {
  return {
    message,
    provider,
    model,
    reasoningEffort,
    attachments,
    additionalDirectories,
    approvalMode,
    ...(codexSandboxMode ? { codexSandboxMode } : {}),
  };
}

export function buildMateTalkUserMessage({
  messageSequence,
  text,
}: {
  messageSequence: number;
  text: string;
}): MateTalkTurnMessage {
  return {
    id: `user-${messageSequence}`,
    role: "user",
    text,
  };
}

export function beginMateTalkTurnSubmission({
  controller,
  message,
}: {
  controller: Pick<MateTalkTurnController, "beginTurn">;
  message: string;
}): MateTalkTurnState & { userMessage: MateTalkTurnMessage } {
  const turnState = controller.beginTurn();
  return {
    ...turnState,
    userMessage: buildMateTalkUserMessage({
      messageSequence: turnState.messageSequence,
      text: message,
    }),
  };
}

export function buildMateTalkAssistantMessage({
  messageSequence,
  text,
}: {
  messageSequence: number;
  text: string;
}): MateTalkTurnMessage {
  return {
    id: `mate-${messageSequence}`,
    role: "mate",
    text,
  };
}

export function buildMateTalkErrorMessage({
  messageSequence,
  error,
  fallback = "返信に失敗したよ。",
}: {
  messageSequence: number;
  error: unknown;
  fallback?: string;
}): MateTalkTurnMessage {
  return {
    id: `mate-error-${messageSequence}`,
    role: "mate",
    text: error instanceof Error ? error.message : fallback,
  };
}

export type MateTalkTurnUpdateResolution =
  | { status: "stale" }
  | { status: "ready"; message: MateTalkTurnMessage };

export type MateTalkTurnFinalization =
  | { status: "stale" }
  | { status: "clear-running" };

export function shouldApplyMateTalkTurnUpdate({
  controller,
  turnId,
}: {
  controller: Pick<MateTalkTurnController, "isLatestTurn">;
  turnId: number;
}): boolean {
  return controller.isLatestTurn(turnId);
}

export function resolveMateTalkAssistantTurnUpdate({
  controller,
  turnId,
  messageSequence,
  text,
}: {
  controller: Pick<MateTalkTurnController, "isLatestTurn">;
  turnId: number;
  messageSequence: number;
  text: string;
}): MateTalkTurnUpdateResolution {
  if (!shouldApplyMateTalkTurnUpdate({ controller, turnId })) {
    return { status: "stale" };
  }
  return {
    status: "ready",
    message: buildMateTalkAssistantMessage({
      messageSequence,
      text,
    }),
  };
}

export function resolveMateTalkErrorTurnUpdate({
  controller,
  turnId,
  messageSequence,
  error,
}: {
  controller: Pick<MateTalkTurnController, "isLatestTurn">;
  turnId: number;
  messageSequence: number;
  error: unknown;
}): MateTalkTurnUpdateResolution {
  if (!shouldApplyMateTalkTurnUpdate({ controller, turnId })) {
    return { status: "stale" };
  }
  return {
    status: "ready",
    message: buildMateTalkErrorMessage({
      messageSequence,
      error,
    }),
  };
}

export function resolveMateTalkTurnFinalization({
  controller,
  turnId,
}: {
  controller: Pick<MateTalkTurnController, "isLatestTurn">;
  turnId: number;
}): MateTalkTurnFinalization {
  return shouldApplyMateTalkTurnUpdate({ controller, turnId })
    ? { status: "clear-running" }
    : { status: "stale" };
}

export function resolveMateTalkActionDockExpandedAfterSubmit({
  isActionDockExpanded,
  appSettings,
}: {
  isActionDockExpanded: boolean;
  appSettings: Pick<AppSettings, "autoCollapseActionDockOnSend">;
}): boolean {
  return appSettings.autoCollapseActionDockOnSend ? false : isActionDockExpanded;
}
