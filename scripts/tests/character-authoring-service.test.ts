import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { DEFAULT_CHARACTER_THEME } from "../../src/character/character-catalog.js";
import { buildNewSession, type CreateSessionInput } from "../../src/session-state.js";
import {
  CharacterAuthoringService,
  CHARACTER_AUTHORING_SKILL_NAME,
} from "../../src-electron/character-authoring-service.js";

describe("CharacterAuthoringService", () => {
  it("workspace に固定 Skill と authoring 成果物を作成し character-authoring session を作る", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-character-authoring-"));
    const createdInputs: CreateSessionInput[] = [];
    const service = new CharacterAuthoringService({
      bundledSkillPath: path.resolve("resources", "skills", CHARACTER_AUTHORING_SKILL_NAME),
      getCharacter: () => ({
        id: "char-muse",
        name: "Muse",
        description: "作業を一緒に進める相手",
        iconFilePath: "",
        theme: DEFAULT_CHARACTER_THEME,
        state: "active",
        isDefault: false,
        createdAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
        archivedAt: null,
        definitionMarkdown: "",
        notesMarkdown: "",
      }),
      getCharacterDirectory: (characterId) => path.join(tempDirectory, "characters", characterId),
      async createSession(input) {
        createdInputs.push(input);
        return buildNewSession(input);
      },
    });

    try {
      const result = await service.startSession({
        mode: "improve",
        characterId: "char-muse",
        name: "Muse",
        description: "作業を一緒に進める相手",
        definitionMarkdown: "",
        notesMarkdown: "",
      });

      assert.equal(result.session.sessionKind, "character-authoring");
      assert.equal(createdInputs[0]?.sessionKind, "character-authoring");
      assert.equal(createdInputs[0]?.approvalMode, DEFAULT_APPROVAL_MODE);
      assert.deepEqual(createdInputs[0]?.characterThemeColors, DEFAULT_CHARACTER_THEME);
      assert.equal(createdInputs[0]?.allowedAdditionalDirectories?.length, 0);
      assert.equal(createdInputs[0]?.provider, "codex");
      assert.equal(createdInputs[0]?.model, undefined);
      assert.equal(createdInputs[0]?.reasoningEffort, undefined);
      assert.equal(result.workspacePath, path.join(tempDirectory, "characters", "char-muse"));

      const rootEntries = await readdir(result.workspacePath);
      assert.deepEqual(rootEntries.sort(), [
        ".agents",
        "AGENTS.md",
        "AUTHORING_PROMPT.md",
        "character-notes.md",
        "character.md",
        "input.json",
      ]);

      const skillMarkdown = await readFile(
        path.join(result.workspacePath, ".agents", "skills", CHARACTER_AUTHORING_SKILL_NAME, "SKILL.md"),
        "utf8",
      );
      assert.match(skillMarkdown, /name: withmate-character-authoring/);

      const characterMarkdown = await readFile(path.join(result.workspacePath, "character.md"), "utf8");
      assert.match(characterMarkdown, /name: "Muse"/);
      assert.match(characterMarkdown, /description: "作業を一緒に進める相手"/);

      const notesMarkdown = await readFile(path.join(result.workspacePath, "character-notes.md"), "utf8");
      assert.match(notesMarkdown, /## Revision Log/);
      assert.match(notesMarkdown, /## Do Not Reintroduce/);

      const agentsMarkdown = await readFile(path.join(result.workspacePath, "AGENTS.md"), "utf8");
      assert.match(agentsMarkdown, new RegExp(`必ず ${CHARACTER_AUTHORING_SKILL_NAME} Skill を使う。`));
      assert.doesNotMatch(agentsMarkdown, /Grow From Conversations/);

      const inputJson = await readFile(path.join(result.workspacePath, "input.json"), "utf8");
      assert.match(inputJson, /"skill": "withmate-character-authoring"/);
      assert.match(inputJson, /"skillPath": ".agents\/skills\/withmate-character-authoring"/);
      assert.doesNotMatch(inputJson, /[A-Z]:\\\\/);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("improve mode では既存 Character の本文を seed にする", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-character-authoring-"));
    const service = new CharacterAuthoringService({
      bundledSkillPath: path.resolve("resources", "skills", CHARACTER_AUTHORING_SKILL_NAME),
      getCharacterDirectory: (characterId) => path.join(tempDirectory, "characters", characterId),
      getCharacter: () => ({
        id: "char-muse",
        name: "Muse",
        description: "既存説明",
        iconFilePath: "",
        theme: DEFAULT_CHARACTER_THEME,
        state: "active",
        isDefault: false,
        createdAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
        archivedAt: null,
        definitionMarkdown: "# Existing character",
        notesMarkdown: "# Existing notes",
      }),
      async createSession(input) {
        return buildNewSession(input);
      },
    });

    try {
      const result = await service.startSession({
        mode: "improve",
        characterId: "char-muse",
        name: "",
      });

      assert.equal(await readFile(path.join(result.workspacePath, "character.md"), "utf8"), "# Existing character");
      assert.equal(await readFile(path.join(result.workspacePath, "character-notes.md"), "utf8"), "# Existing notes");
      assert.equal(result.session.characterId, "char-muse");
      assert.equal(result.workspacePath, path.join(tempDirectory, "characters", "char-muse"));
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("provider 指定時も model / depth は session 側の既定値解決に任せる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-character-authoring-"));
    const createdInputs: CreateSessionInput[] = [];
    const service = new CharacterAuthoringService({
      bundledSkillPath: path.resolve("resources", "skills", CHARACTER_AUTHORING_SKILL_NAME),
      getCharacter: () => ({
        id: "char-muse",
        name: "Muse",
        description: "",
        iconFilePath: "",
        theme: DEFAULT_CHARACTER_THEME,
        state: "active",
        isDefault: false,
        createdAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
        archivedAt: null,
        definitionMarkdown: "# Existing character",
        notesMarkdown: "# Existing notes",
      }),
      getCharacterDirectory: (characterId) => path.join(tempDirectory, "characters", characterId),
      async createSession(input) {
        createdInputs.push(input);
        return buildNewSession(input);
      },
    });

    try {
      const result = await service.startSession({
        mode: "improve",
        characterId: "char-muse",
        name: "Muse",
        provider: "copilot",
      });

      assert.equal(createdInputs[0]?.provider, "copilot");
      assert.equal(createdInputs[0]?.model, undefined);
      assert.equal(createdInputs[0]?.reasoningEffort, undefined);
      const skillMarkdown = await readFile(
        path.join(result.workspacePath, ".github", "skills", CHARACTER_AUTHORING_SKILL_NAME, "SKILL.md"),
        "utf8",
      );
      assert.match(skillMarkdown, /name: withmate-character-authoring/);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("characterId 未確定の authoring session は開始しない", async () => {
    const service = new CharacterAuthoringService({
      bundledSkillPath: path.resolve("resources", "skills", CHARACTER_AUTHORING_SKILL_NAME),
      getCharacter: () => null,
      getCharacterDirectory: () => null,
      async createSession(input) {
        return buildNewSession(input);
      },
    });

    await assert.rejects(
      () => service.startSession({
        mode: "create",
        name: "Muse",
      }),
      /保存済み Character/,
    );
  });

  it("authoring 補助ファイルと Skill directory は次回起動時に作り直す", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-character-authoring-"));
    const workspacePath = path.join(tempDirectory, "characters", "char-muse");
    const service = new CharacterAuthoringService({
      bundledSkillPath: path.resolve("resources", "skills", CHARACTER_AUTHORING_SKILL_NAME),
      getCharacter: () => ({
        id: "char-muse",
        name: "Muse",
        description: "既存説明",
        iconFilePath: "",
        theme: DEFAULT_CHARACTER_THEME,
        state: "active",
        isDefault: false,
        createdAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
        archivedAt: null,
        definitionMarkdown: "# Existing character",
        notesMarkdown: "# Existing notes",
      }),
      getCharacterDirectory: () => workspacePath,
      async createSession(input) {
        return buildNewSession(input);
      },
    });

    try {
      await service.startSession({
        mode: "improve",
        characterId: "char-muse",
        name: "Muse",
      });

      await writeFile(path.join(workspacePath, "AGENTS.md"), "stale agents", "utf8");
      await writeFile(path.join(workspacePath, "AUTHORING_PROMPT.md"), "stale prompt", "utf8");
      await writeFile(path.join(workspacePath, "input.json"), "{\"stale\":true}\n", "utf8");
      const staleSkillFilePath = path.join(
        workspacePath,
        ".agents",
        "skills",
        CHARACTER_AUTHORING_SKILL_NAME,
        "STALE.md",
      );
      await mkdir(path.dirname(staleSkillFilePath), { recursive: true });
      await writeFile(staleSkillFilePath, "stale", "utf8");

      await service.startSession({
        mode: "improve",
        characterId: "char-muse",
        name: "Muse",
      });

      assert.match(await readFile(path.join(workspacePath, "AGENTS.md"), "utf8"), /Character Authoring Workspace/);
      assert.match(await readFile(path.join(workspacePath, "AUTHORING_PROMPT.md"), "utf8"), /Muse Character Authoring/);
      assert.match(await readFile(path.join(workspacePath, "input.json"), "utf8"), /"skill": "withmate-character-authoring"/);
      await assert.rejects(() => readFile(staleSkillFilePath, "utf8"));
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
