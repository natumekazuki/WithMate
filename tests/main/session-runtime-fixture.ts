import {
  SessionRuntimeService,
  type SessionRuntimeServiceDeps,
} from "../../src-electron/session/session-runtime-service.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { Awaitable } from "../../src-electron/storage/persistent-store-lifecycle-service.js";

/** Fixture側で既定の小分け保存を提供できるランタイムの依存操作。 */
type SmallWrites =
  | "persistRunningTurnStart"
  | "appendRunningInput"
  | "checkpointRuntimeMetadata"
  | "appendTerminalSession";
/** ランタイムの部分保存を必要に応じて差し替えつつ、FixtureでSession全体を保存する入口を指定する。 */
export type SessionRuntimeFixtureDeps = Omit<
  SessionRuntimeServiceDeps,
  SmallWrites
> &
  Partial<Pick<SessionRuntimeServiceDeps, SmallWrites>> & {
    /** 履歴を含むSession全体と確定済みの最終テキストをテスト側のストアへ渡す。 */
    upsertSession(
      session: Session,
      options?: { confirmedFinalAssistantText?: string | null },
    ): Awaitable<Session>;
    upsertTerminalSession?: SessionRuntimeServiceDeps["appendTerminalSession"];
  };

/** 履歴全体は fixture のストアが保持し、ランタイムが参照するのはメタデータと現在の Turn 内のメッセージだけである。 */
export class SessionRuntimeFixture extends SessionRuntimeService {
  /** 全履歴を保持するキャッシュと、ランタイム向けの当該ターン投影を使う依存実装を組み立てる。 */
  constructor(deps: SessionRuntimeFixtureDeps) {
    const stored = new Map<string, Session>();
    const turns = new Map<
      number,
      Parameters<SessionRuntimeServiceDeps["createSessionTurn"]>[0]
    >();
    /** メッセージ自体を呼び出し側の指定範囲に絞りながら、件数は全履歴から算出する。 */
    const project = (
      full: Session,
      messages: Session["messages"],
    ): Session => ({ ...full, messages, messageCount: full.messages.length });
    /** 保持済み履歴に新着分を足し、終端の保存を専用フックに任せるか既存ターンの更新で補う。 */
    const write = async (
      session: Session,
      appended: Session["messages"],
      terminal?: Parameters<
        SessionRuntimeServiceDeps["appendTerminalSession"]
      >[1],
      options?: { confirmedFinalAssistantText?: string | null },
    ): Promise<Session> => {
      const previous = stored.get(session.id);
      if (!previous) throw new Error(`Fixture session missing: ${session.id}`);
      const full = {
        ...session,
        messages: [...previous.messages, ...appended],
      };
      delete full.messageCount;
      const saved =
        terminal && deps.upsertTerminalSession
          ? await deps.upsertTerminalSession(full, terminal, options)
          : await deps.upsertSession(full, options);
      stored.set(saved.id, saved);
      if (terminal && !deps.upsertTerminalSession) {
        const turn = turns.get(terminal.turnId);
        if (!turn) throw new Error(`Fixture turn missing: ${terminal.turnId}`);
        await deps.updateSessionTurn(terminal.turnId, {
          ...turn,
          phase: terminal.phase,
          assistantMessageSeq: terminal.assistantMessageSeq,
          threadId: terminal.threadId,
          errorMessage: terminal.errorMessage,
          completedAt: terminal.completedAt,
        });
      }
      return project(saved, session.messages);
    };
    super({
      ...deps,
      beginRunningInput:
        deps.beginRunningInput ??
        (async (
          session,
          text,
          turnId,
          nativeTurnId,
          attachments,
          _origin,
          questionRequestId,
          replyTo,
        ) => {
          const message = {
            role: "user" as const,
            text,
            ...(replyTo ? { replyTo } : {}),
            turnInput: {
              turnId: String(turnId),
              nativeTurnId,
              attachments,
              state: "pending" as const,
              ...(questionRequestId ? { questionRequestId } : {}),
            },
          };
          return write(
            { ...session, messages: [...session.messages, message] },
            [message],
          );
        }),
      settleRunningInput:
        deps.settleRunningInput ??
        (async (session, messageSeq, _turnId, state) => {
          const full = await deps.getSession(session.id);
          if (!full?.messages[messageSeq]?.turnInput)
            throw new Error("Fixture pending input missing");
          if (
            full.messages[messageSeq]!.turnInput!.state !== "pending" &&
            full.messages[messageSeq]!.turnInput!.state !== state
          )
            throw new Error("Fixture input already settled");
          const messages = full.messages.map((message, index) =>
            index === messageSeq && message.turnInput
              ? { ...message, turnInput: { ...message.turnInput, state } }
              : message,
          );
          const saved = await deps.upsertSession({ ...full, messages });
          stored.set(saved.id, saved);
          const count = session.messageCount ?? session.messages.length;
          return project(
            saved,
            session.messages.map((message, index) =>
              count - session.messages.length + index === messageSeq &&
              message.turnInput
                ? { ...message, turnInput: { ...message.turnInput, state } }
                : message,
            ),
          );
        }),
      /** ストアから読み出した全履歴をキャッシュし、初回のランタイム読込にはメタデータのみを返す。 */
      async getSession(id) {
        const full = await deps.getSession(id);
        if (!full) return null;
        stored.set(id, full);
        return project(full, []);
      },
      /** 保存したターンの初期入力を、専用フックを使わない終端更新の基礎として保持する。 */
      async createSessionTurn(input) {
        const turn = await deps.createSessionTurn(input);
        turns.set(turn.id, input);
        return turn;
      },
      /** 起動時のメッセージを全履歴へ反映し、部分保存を差し替えた場合もランタイムには起動分だけを返す。 */
      async persistRunningTurnStart(session, count) {
        if (deps.persistRunningTurnStart) {
          const saved = await deps.persistRunningTurnStart(session, count);
          const previous = stored.get(session.id)!;
          stored.set(session.id, {
            ...saved,
            messages: [...previous.messages, ...session.messages],
          });
          return {
            ...saved,
            messages: session.messages,
            messageCount: count + session.messages.length,
          };
        }
        return write(session, session.messages);
      },
      appendRunningInput:
        deps.appendRunningInput ??
        ((session, text) =>
          write(
            {
              ...session,
              messages: [...session.messages, { role: "user", text }],
            },
            [{ role: "user", text }],
          )),
      checkpointRuntimeMetadata:
        deps.checkpointRuntimeMetadata ?? ((session) => write(session, [])),
      appendTerminalSession:
        deps.appendTerminalSession ??
        ((session, terminal, options) =>
          write(session, session.messages.slice(-1), terminal, options)),
    });
  }
}
