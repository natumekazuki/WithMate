import { currentIsoTimestamp } from "./time-state.js";

export type CharacterUpdateWorkspace = {
  characterId: string;
  characterName: string;
  workspacePath: string;
  characterMarkdownPath: string;
  codexInstructionPath: string;
  copilotInstructionPath: string;
};

export type CharacterUpdateMemoryExtract = {
  characterId: string;
  generatedAt: string;
  entryCount: number;
  text: string;
};

export function createEmptyCharacterUpdateMemoryExtract(characterId: string): CharacterUpdateMemoryExtract {
  return {
    characterId,
    generatedAt: currentIsoTimestamp(),
    entryCount: 0,
    text: "",
  };
}
