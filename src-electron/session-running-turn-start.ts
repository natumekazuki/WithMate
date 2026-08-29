import type { CharacterRuntimeSnapshot } from "../src/character/character-catalog.js";
import type { Message, SessionSummary } from "../src/session-state.js";

export type SessionRunningTurnStartInput = {
  sessionId: string;
  expectedMessageCount: number;
  userMessage: Message;
  updatedAt: string;
  characterRuntimeSnapshot?: CharacterRuntimeSnapshot | null;
};

export type SessionRunningTurnStartResult = {
  summary: SessionSummary;
  characterRuntimeSnapshot: CharacterRuntimeSnapshot | null;
};

export type SessionCharacterAuthoringRuntimeClearInput = {
  sessionId: string;
};

export type SessionCharacterAuthoringRuntimeClearResult = {
  summary: SessionSummary;
  characterRuntimeSnapshot: null;
};
