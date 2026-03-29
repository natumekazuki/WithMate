import path from "node:path";

import { DEFAULT_APPROVAL_MODE } from "../src/approval-mode.js";
import type { CharacterProfile } from "../src/character-state.js";
import { type CharacterUpdateMemoryExtract, type CharacterUpdateWorkspace } from "../src/character-update-state.js";
import type { CharacterMemoryEntry, CharacterScope } from "../src/memory-state.js";
import type { Session } from "../src/session-state.js";
import { buildCharacterUpdateMemoryExtract } from "./character-update-memory-extract.js";
import {
  CHARACTER_UPDATE_SKILL_FILE_PATH,
  buildCharacterUpdateSkillMarkdown,
  buildCharacterUpdateInstructionText,
  getCharacterUpdateInstructionFileName,
} from "./character-update-instructions.js";

export type CharacterUpdateWorkspaceServiceDeps = {
  getCharacter(characterId: string): Promise<CharacterProfile | null>;
  getCharacterDirectoryPath(characterId: string): string;
  getCharacterScopeByCharacterId(characterId: string): CharacterScope | null;
  listCharacterMemoryEntries(characterScopeId: string): CharacterMemoryEntry[];
  writeTextFile(filePath: string, content: string): Promise<void>;
  createSession(input: {
    provider: string;
    taskTitle: string;
    workspaceLabel: string;
    workspacePath: string;
    branch: string;
    sessionKind?: Session["sessionKind"];
    characterId: string;
    character: string;
    characterIconPath: string;
    characterThemeColors: CharacterProfile["themeColors"];
    approvalMode: Session["approvalMode"];
  }): Session;
};

export class CharacterUpdateWorkspaceService {
  constructor(private readonly deps: CharacterUpdateWorkspaceServiceDeps) {}

  async getWorkspace(characterId: string): Promise<CharacterUpdateWorkspace | null> {
    const character = await this.deps.getCharacter(characterId);
    if (!character) {
      return null;
    }

    const workspacePath = this.deps.getCharacterDirectoryPath(characterId);
    return {
      characterId,
      characterName: character.name,
      workspacePath,
      characterMarkdownPath: path.join(workspacePath, "character.md"),
      characterNotesPath: path.join(workspacePath, "character-notes.md"),
      characterImagePath: path.join(workspacePath, "character.png"),
      skillPath: path.join(workspacePath, CHARACTER_UPDATE_SKILL_FILE_PATH),
      codexInstructionPath: path.join(workspacePath, "AGENTS.md"),
      copilotInstructionPath: path.join(workspacePath, "copilot-instructions.md"),
    };
  }

  buildMemoryExtract(characterId: string): CharacterUpdateMemoryExtract {
    const scope = this.deps.getCharacterScopeByCharacterId(characterId);
    if (!scope) {
      return buildCharacterUpdateMemoryExtract(characterId, []);
    }

    return buildCharacterUpdateMemoryExtract(
      characterId,
      this.deps.listCharacterMemoryEntries(scope.id),
    );
  }

  async createUpdateSession(characterId: string, providerId: string): Promise<Session> {
    const character = await this.deps.getCharacter(characterId);
    if (!character) {
      throw new Error("対象キャラクターが見つからないよ。");
    }

    const workspacePath = this.deps.getCharacterDirectoryPath(characterId);
    const instructionFilePath = path.join(
      workspacePath,
      getCharacterUpdateInstructionFileName(providerId),
    );
    await this.deps.writeTextFile(
      instructionFilePath,
      buildCharacterUpdateInstructionText(character.name),
    );
    await this.deps.writeTextFile(
      path.join(workspacePath, CHARACTER_UPDATE_SKILL_FILE_PATH),
      buildCharacterUpdateSkillMarkdown(),
    );

    return this.deps.createSession({
      provider: providerId,
      taskTitle: `${character.name} の更新`,
      workspaceLabel: `${character.name} workspace`,
      workspacePath,
      branch: "main",
      sessionKind: "character-update",
      characterId: character.id,
      character: character.name,
      characterIconPath: character.iconPath,
      characterThemeColors: character.themeColors,
      approvalMode: DEFAULT_APPROVAL_MODE,
    });
  }
}
