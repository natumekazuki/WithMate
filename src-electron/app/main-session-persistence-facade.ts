import type { Session } from "../../src-shared/session/session-state.js";
import type { SessionPersistenceService } from "../session/session-persistence-service.js";
import type { SessionTurnTerminalCommit } from "../session/session-turn-terminal-commit.js";
import type { SessionRuntimeMetadataPatchInput, SessionThreadPatchInput } from "../session/session-storage-v6.js";
import type { SessionRuntimeMetadataPatchResult, SessionThreadPatchResult } from "../session/session-storage-v6.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { SetExecutionOptionsResult, SetSessionTitleResult } from "../../src-shared/session/session-mutation-contract.js";
import type { SessionTurnInput, SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";

type ReplaceAllSessionsOptions = {
  broadcast?: boolean;
  invalidateSessionIds?: Iterable<string>;
};

type MainSessionPersistenceFacadeDeps = {
  getSessionPersistenceService(): SessionPersistenceService;
};

export class MainSessionPersistenceFacade {
  constructor(private readonly deps: MainSessionPersistenceFacadeDeps) {}

  async upsertSession(session: Session): Promise<Session> {
    return this.deps.getSessionPersistenceService().upsertSession(session);
  }

  async setSessionTitle(sessionId: string, incarnationId: string, title: string): Promise<SetSessionTitleResult> {
    return this.deps.getSessionPersistenceService().setSessionTitle(sessionId, incarnationId, title);
  }

  async setSessionMessageBookmark(sessionId: string, incarnationId: string, messageIndex: number, isBookmarked: boolean): Promise<void> {
    await this.deps.getSessionPersistenceService().setSessionMessageBookmark(sessionId, incarnationId, messageIndex, isBookmarked);
  }

  async setSessionExecutionOptions(sessionId: string, incarnationId: string, options: SessionExecutionOptions): Promise<SetExecutionOptionsResult> {
    return this.deps.getSessionPersistenceService().setSessionExecutionOptions(sessionId, incarnationId, options);
  }

  async upsertTerminalSession(
    session: Session,
    terminalCommit: SessionTurnTerminalCommit,
  ): Promise<Session> {
    return this.deps.getSessionPersistenceService().upsertTerminalSession(session, terminalCommit);
  }

  async upsertSessionPreservingPin(session: Session): Promise<Session> {
    return this.deps.getSessionPersistenceService().upsertSessionPreservingPin(session);
  }

  async persistRunningTurnStart(session: Session, expectedMessageCount: number): Promise<Session> {
    return this.deps.getSessionPersistenceService().persistRunningTurnStart(session, expectedMessageCount);
  }

  async persistQueuedTurnStart(session: Session, expectedMessageCount: number, queueId: string, turn: SessionTurnInput): Promise<{ session: Session; turn: SessionTurnRecord }> {
    return this.deps.getSessionPersistenceService().persistQueuedTurnStart(session, expectedMessageCount, queueId, turn);
  }

  async appendRunningInput(...args: Parameters<SessionPersistenceService["appendRunningInput"]>): Promise<Session> {
    return this.deps.getSessionPersistenceService().appendRunningInput(...args);
  }

  beginRunningInput(...args: Parameters<SessionPersistenceService["beginRunningInput"]>): Promise<Session> {
    return this.deps.getSessionPersistenceService().beginRunningInput(...args);
  }

  settleRunningInput(...args: Parameters<SessionPersistenceService["settleRunningInput"]>): Promise<Session> {
    return this.deps.getSessionPersistenceService().settleRunningInput(...args);
  }

  async appendTerminalSession(session: Session, terminalCommit: SessionTurnTerminalCommit): Promise<Session> {
    return this.deps.getSessionPersistenceService().appendTerminalSession(session, terminalCommit);
  }

  async checkpointRuntimeMetadata(session: Session, expected: Session): Promise<Session> {
    return this.deps.getSessionPersistenceService().checkpointRuntimeMetadata(session, expected);
  }

  async clearCharacterAuthoringRuntimeState(session: Session): Promise<Session> {
    return this.deps.getSessionPersistenceService().clearCharacterAuthoringRuntimeState(session);
  }

  async replaceAllSessions(nextSessions: Session[], options?: ReplaceAllSessionsOptions): Promise<Session[]> {
    return this.deps.getSessionPersistenceService().replaceAllSessions(nextSessions, options);
  }

  async updateSessionThreadIfMatches(input: SessionThreadPatchInput): Promise<SessionThreadPatchResult | null> {
    return this.deps.getSessionPersistenceService().updateSessionThreadIfMatches(input);
  }

  async updateSessionRuntimeMetadataIfMatches(input: SessionRuntimeMetadataPatchInput): Promise<SessionRuntimeMetadataPatchResult | null> {
    return this.deps.getSessionPersistenceService().updateSessionRuntimeMetadataIfMatches(input);
  }
}
