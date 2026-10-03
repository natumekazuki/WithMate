import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import type { Message, SessionSummary } from "../../src-shared/session/session-state.js";

export type SessionRunningTurnStartInput = {
  sessionId: string;
  incarnationId?: string;
  expectedMessageCount: number;
  userMessage: Message;
  updatedAt: string;
  characterRuntimeSnapshot?: CharacterRuntimeSnapshot | null;
};

export type SessionRunningTurnStartResult = {
  summary: SessionSummary;
  characterRuntimeSnapshot: CharacterRuntimeSnapshot | null;
};

export function assertCharacterDefinitionSnapshotUpdate(
  current: CharacterRuntimeSnapshot | null | undefined,
  next: CharacterRuntimeSnapshot | null | undefined,
  characterId: string,
): void {
  if (!current && !next) return;
  if (!current && next?.characterId === characterId) return;
  if (!current || !next || current.characterId !== characterId || next.characterId !== characterId
    || current.name !== next.name || current.description !== next.description
    || current.iconFilePath !== next.iconFilePath
    || current.theme.main !== next.theme.main || current.theme.sub !== next.theme.sub) {
    throw new Error("The Character definition update does not match the saved Session identity.");
  }
}

export type SessionCharacterAuthoringRuntimeClearInput = {
  sessionId: string;
  incarnationId?: string;
};

export type SessionCharacterAuthoringRuntimeClearResult = {
  summary: SessionSummary;
  characterRuntimeSnapshot: null;
};
