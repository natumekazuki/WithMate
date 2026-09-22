import type { Session } from "../../src-shared/session/session-state.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";
import type { SessionStorageWrite } from "../storage/persistent-store-lifecycle-service.js";

export type SessionStorageCommandAdapter = {
  upsertStoredSession(session: Session, operation: "create" | "upsert"): Session | Promise<Session>;
  upsertStoredTerminalSession(session: Session, terminalCommit: SessionTurnTerminalCommit): Session | Promise<Session>;
};

export function createSessionStorageCommandAdapter(
  getStorage: () => SessionStorageWrite,
): SessionStorageCommandAdapter {
  return {
    upsertStoredSession(session, operation) {
      const storage = getStorage();
      if (operation === "create") {
        return storage.insertSession(session);
      }
      if (!storage.updateSession) {
        throw new Error("Storage for updating an existing Session is unavailable.");
      }
      return storage.updateSession(session);
    },
    upsertStoredTerminalSession(session, terminalCommit) {
      const storage = getStorage();
      if (!storage.updateTerminalSession) {
        throw new Error("Atomic commit storage for the terminal Session is unavailable.");
      }
      return storage.updateTerminalSession(session, terminalCommit);
    },
  };
}
