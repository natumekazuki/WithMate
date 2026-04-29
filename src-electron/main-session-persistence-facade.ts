import { currentTimestampLabel } from "../src/time-state.js";
import type { Session } from "../src/session-state.js";
import type { SessionPersistenceService } from "./session-persistence-service.js";
import type { SessionStorageRead } from "./persistent-store-lifecycle-service.js";
import { sessionSummariesToSessions } from "./session-summary-adapter.js";

type ReplaceAllSessionsOptions = {
  broadcast?: boolean;
  invalidateSessionIds?: Iterable<string>;
};

type MainSessionPersistenceFacadeDeps = {
  getSessions(): Session[];
  setSessions(nextSessions: Session[]): void;
  getSessionPersistenceService(): SessionPersistenceService;
  getSessionStorage(): SessionStorageRead;
};

function isRunningSession(session: Session): boolean {
  return session.status === "running" || session.runState === "running";
}

function buildInterruptedSession(session: Session): Session {
  const interruptedMessage = "前回の実行はアプリ終了で中断された可能性があるよ。必要ならもう一度送ってね。";
  const lastMessage = session.messages.at(-1);
  const nextMessages =
    lastMessage?.role === "assistant" && lastMessage.text === interruptedMessage
      ? session.messages
      : [
          ...session.messages,
          {
            role: "assistant" as const,
            text: interruptedMessage,
            accent: true,
          },
        ];

  return {
    ...session,
    status: "idle",
    runState: "interrupted",
    updatedAt: currentTimestampLabel(),
    messages: nextMessages,
  };
}

export class MainSessionPersistenceFacade {
  constructor(private readonly deps: MainSessionPersistenceFacadeDeps) {}

  upsertSession(session: Session): Session {
    return this.deps.getSessionPersistenceService().upsertSession(session);
  }

  replaceAllSessions(nextSessions: Session[], options?: ReplaceAllSessionsOptions): Session[] {
    return this.deps.getSessionPersistenceService().replaceAllSessions(nextSessions, options);
  }

  recoverInterruptedSessions(): void {
    const runningSessions = this.deps.getSessions().filter(isRunningSession);
    if (runningSessions.length === 0) {
      return;
    }

    const storage = this.deps.getSessionStorage();
    for (const session of runningSessions) {
      const hydratedSession = storage.getSession(session.id);
      if (!hydratedSession) {
        continue;
      }

      this.upsertSession(buildInterruptedSession(hydratedSession));
    }

    this.deps.setSessions(sessionSummariesToSessions(storage.listSessionSummaries()));
  }
}
