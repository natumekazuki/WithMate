import type { AppSettings } from "../provider-settings-state.js";

export type MateTalkTurnState = {
  turnId: number;
  messageSequence: number;
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
  | { status: "blocked"; reason: "sending" };

export function resolveMateTalkSubmitPreflight({
  draft,
  sending,
}: {
  draft: string;
  sending: boolean;
}): MateTalkSubmitPreflightResult {
  const message = draft.trim();
  if (!message) {
    return {
      status: "blocked",
      reason: "empty",
      feedback: "入力してから送信してね。",
    };
  }
  if (sending) {
    return { status: "blocked", reason: "sending" };
  }
  return { status: "ready", message };
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
