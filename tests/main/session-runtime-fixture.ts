import { SessionRuntimeService, type SessionRuntimeServiceDeps } from "../../src-electron/session/session-runtime-service.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { Awaitable } from "../../src-electron/storage/persistent-store-lifecycle-service.js";

type SmallWrites = "persistRunningTurnStart" | "appendRunningInput" | "checkpointRuntimeMetadata" | "appendTerminalSession";
export type SessionRuntimeFixtureDeps = Omit<SessionRuntimeServiceDeps, SmallWrites> & Partial<Pick<SessionRuntimeServiceDeps, SmallWrites>> & {
  upsertSession(session: Session, options?: { confirmedFinalAssistantText?: string | null }): Awaitable<Session>;
  upsertTerminalSession?: SessionRuntimeServiceDeps["appendTerminalSession"];
};

/** Full history belongs to the fixture store; the runtime sees metadata and turn-local messages only. */
export class SessionRuntimeFixture extends SessionRuntimeService {
  constructor(deps: SessionRuntimeFixtureDeps) {
    const stored = new Map<string, Session>();
    const turns = new Map<number, Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]>();
    const project = (full: Session, messages: Session["messages"]): Session => ({ ...full, messages, messageCount: full.messages.length });
    const write = async (session: Session, appended: Session["messages"], terminal?: Parameters<SessionRuntimeServiceDeps["appendTerminalSession"]>[1], options?: { confirmedFinalAssistantText?: string | null }): Promise<Session> => {
      const previous = stored.get(session.id);
      if (!previous) throw new Error(`Fixture session missing: ${session.id}`);
      const full = { ...session, messages: [...previous.messages, ...appended] };
      delete full.messageCount;
      const saved = terminal && deps.upsertTerminalSession
        ? await deps.upsertTerminalSession(full, terminal, options)
        : await deps.upsertSession(full, options);
      stored.set(saved.id, saved);
      if (terminal && !deps.upsertTerminalSession) {
        const turn = turns.get(terminal.turnId);
        if (!turn) throw new Error(`Fixture turn missing: ${terminal.turnId}`);
        await deps.updateSessionTurn(terminal.turnId, { ...turn, phase: terminal.phase, assistantMessageSeq: terminal.assistantMessageSeq, threadId: terminal.threadId, errorMessage: terminal.errorMessage, completedAt: terminal.completedAt });
      }
      return project(saved, session.messages);
    };
    super({
      ...deps,
      async getSession(id) {
        const full = await deps.getSession(id);
        if (!full) return null;
        stored.set(id, full);
        return project(full, []);
      },
      async createSessionTurn(input) {
        const turn = await deps.createSessionTurn(input);
        turns.set(turn.id, input);
        return turn;
      },
      async persistRunningTurnStart(session, count) {
        if (deps.persistRunningTurnStart) {
          const saved = await deps.persistRunningTurnStart(session, count);
          const previous = stored.get(session.id)!;
          stored.set(session.id, { ...saved, messages: [...previous.messages, ...session.messages] });
          return { ...saved, messages: session.messages, messageCount: count + session.messages.length };
        }
        return write(session, session.messages);
      },
      appendRunningInput: deps.appendRunningInput ?? ((session, text) => write({ ...session, messages: [...session.messages, { role: "user", text }] }, [{ role: "user", text }])),
      checkpointRuntimeMetadata: deps.checkpointRuntimeMetadata ?? ((session) => write(session, [])),
      appendTerminalSession: deps.appendTerminalSession ?? ((session, terminal, options) => write(session, session.messages.slice(-1), terminal, options)),
    });
  }
}
