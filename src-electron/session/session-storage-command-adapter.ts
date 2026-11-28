import type { Session } from "../../src-shared/session/session-state.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";
import type { SessionStorageWrite } from "../storage/persistent-store-lifecycle-service.js";

/** Session の新規作成・既存更新と、Turn 終了に伴う一括保存を分ける書き込み窓口。 */
export type SessionStorageCommandAdapter = {
  /** 操作種別に従って新規作成または既存 Session の更新を実行する。 */
  upsertStoredSession(
    session: Session,
    operation: "create" | "upsert",
  ): Session | Promise<Session>;
  /** Session 更新と対象 Turn の確定を一体で保存する。通常更新には代替しない。 */
  upsertStoredTerminalSession(
    session: Session,
    terminalCommit: SessionTurnTerminalCommit,
  ): Session | Promise<Session>;
};

/** 各呼び出し時に現行の書き込み先を取得し、要求された操作が利用できる場合だけ実行するアダプターを作る。 */
export function createSessionStorageCommandAdapter(
  getStorage: () => SessionStorageWrite,
): SessionStorageCommandAdapter {
  return {
    /** create は必ず専用の挿入経路を使い、既存更新が使えなければ例外を返す。 */
    upsertStoredSession(session, operation) {
      const storage = getStorage();
      if (operation === "create") {
        return storage.insertSession(session);
      }
      if (!storage.updateSession) {
        throw new Error(
          "Storage for updating an existing Session is unavailable.",
        );
      }
      return storage.updateSession(session);
    },
    /** アトミックな終了保存をストレージが実装していない場合は、部分的な保存をせずに拒否する。 */
    upsertStoredTerminalSession(session, terminalCommit) {
      const storage = getStorage();
      if (!storage.updateTerminalSession) {
        throw new Error(
          "Atomic commit storage for the terminal Session is unavailable.",
        );
      }
      return storage.updateTerminalSession(session, terminalCommit);
    },
  };
}
