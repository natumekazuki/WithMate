export type HomeMateTalkTurnState = {
  turnId: number;
  messageSequence: number;
};

export class HomeMateTalkTurnController {
  private turnId = 0;
  private messageSequence = 0;

  beginTurn(): HomeMateTalkTurnState {
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
