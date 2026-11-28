import type {
  SessionTurnInput,
  SessionTurnRecord,
} from "../../src-shared/session/session-turn-state.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

/** Turn 作成と更新の保存境界。同期ストアと Worker 経由の非同期ストアの両方を扱う。 */
type SessionTurnServiceStorage = {
  /** 指定の入力から Turn の新規レコードを保存する。 */
  createSessionTurn(input: SessionTurnInput): Awaitable<SessionTurnRecord>;
  /** 指定 ID の Turn を更新し、ストアが保存した正本を返す。 */
  updateSessionTurn(
    id: number,
    input: SessionTurnInput,
  ): Awaitable<SessionTurnRecord>;
};

/** Turn の作成・更新をストアへ委ね、その保存が成功したときだけ更新を通知する。 */
export class SessionTurnService {
  /** 保存処理と、保存後のレコードを配信する通知先を設定する。 */
  public constructor(
    private readonly storage: SessionTurnServiceStorage,
    private readonly onUpdated: (turn: SessionTurnRecord) => void,
  ) {}

  /** Turn を作成して保存後のレコードを通知・返却する。保存失敗を補完しない。 */
  public async createSessionTurn(
    input: SessionTurnInput,
  ): Promise<SessionTurnRecord> {
    const turn = await this.storage.createSessionTurn(input);
    this.onUpdated(turn);
    return turn;
  }

  /** 指定 Turn を更新し、実際に保存できた値を通知して返す。 */
  public async updateSessionTurn(
    id: number,
    input: SessionTurnInput,
  ): Promise<SessionTurnRecord> {
    const turn = await this.storage.updateSessionTurn(id, input);
    this.onUpdated(turn);
    return turn;
  }
}
