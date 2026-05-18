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

export function resolveMateTalkActionDockExpandedAfterSubmit({
  isActionDockExpanded,
  appSettings,
}: {
  isActionDockExpanded: boolean;
  appSettings: Pick<AppSettings, "autoCollapseActionDockOnSend">;
}): boolean {
  return appSettings.autoCollapseActionDockOnSend ? false : isActionDockExpanded;
}
