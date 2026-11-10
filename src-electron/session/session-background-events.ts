import type { Session } from "../../src-shared/session/session-state.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";

/** Saved facts for purpose controllers, independent of OS notifications. */
export type SessionBackgroundEvent =
  | Readonly<{ kind: "terminal_saved"; session: Session; terminal: SessionTurnTerminalCommit }>
  | Readonly<{ kind: "run_state"; session: Session; running: boolean }>;
