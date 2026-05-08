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
