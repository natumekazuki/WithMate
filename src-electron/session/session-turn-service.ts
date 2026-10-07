import type { SessionTurnInput, SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

type SessionTurnServiceStorage = {
  createSessionTurn(input: SessionTurnInput): Awaitable<SessionTurnRecord>;
  updateSessionTurn(id: number, input: SessionTurnInput): Awaitable<SessionTurnRecord>;
};

export class SessionTurnService {
  public constructor(
    private readonly storage: SessionTurnServiceStorage,
    private readonly onUpdated: (turn: SessionTurnRecord) => void,
  ) {}

  public async createSessionTurn(input: SessionTurnInput): Promise<SessionTurnRecord> {
    const turn = await this.storage.createSessionTurn(input);
    this.onUpdated(turn);
    return turn;
  }

  public async updateSessionTurn(id: number, input: SessionTurnInput): Promise<SessionTurnRecord> {
    const turn = await this.storage.updateSessionTurn(id, input);
    this.onUpdated(turn);
    return turn;
  }
}
