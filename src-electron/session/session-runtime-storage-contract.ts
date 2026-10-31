import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import type { Message, Session, SessionSummary } from "../../src-shared/session/session-state.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";

export type SessionMetadataResult = {
  summary: SessionSummary;
  characterRuntimeSnapshot: CharacterRuntimeSnapshot | null;
  messageCount: number;
};

export type SessionMessageIdentityInput = {
  sessionId: string;
  incarnationId: string;
  messageIndex: number;
};

export type SessionMessageIdentity = Pick<Message, "role" | "text"> & { historyIndex: number };

type SessionAppendOwner = {
  sessionId: string;
  incarnationId: string;
  expectedMessageCount: number;
};

export type SessionSteerAppendInput = SessionAppendOwner & {
  turnId: number;
  userMessage: Message;
  updatedAt: string;
  queuedInput?: { queueId: string; inputTurnId: string };
};

export type SessionTerminalAppendInput = SessionAppendOwner & {
  assistantMessage: Message;
  metadata: Pick<Session, "status" | "runState" | "threadId" | "updatedAt">;
  terminalCommit: SessionTurnTerminalCommit;
};

export type SessionRunMetadataCheckpointInput = {
  sessionId: string;
  incarnationId: string;
  expected: Pick<Session, "status" | "runState" | "threadId">;
  next: Pick<Session, "status" | "runState" | "threadId" | "updatedAt">;
};
