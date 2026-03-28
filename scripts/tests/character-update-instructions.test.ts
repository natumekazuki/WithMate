import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCharacterUpdateSkillMarkdown,
  buildCharacterMarkdownTemplate,
  buildCharacterNotesTemplate,
  buildCharacterUpdateWorkspaceFiles,
  buildCharacterUpdateInstructionText,
  CHARACTER_UPDATE_SKILL_FILE_PATH,
  CHARACTER_UPDATE_SKILL_NAME,
  getCharacterUpdateInstructionFileName,
} from "../../src-electron/character-update-instructions.js";

test("provider ごとの instruction file 名を返す", () => {
  assert.equal(getCharacterUpdateInstructionFileName("codex"), "AGENTS.md");
  assert.equal(getCharacterUpdateInstructionFileName("copilot"), "copilot-instructions.md");
});

test("workspace file は Add Character 直後に必要な instruction と skill を返す", () => {
  const files = buildCharacterUpdateWorkspaceFiles("Muse");

  assert.deepEqual(
    files.map((file) => file.fileName),
    ["AGENTS.md", "copilot-instructions.md", CHARACTER_UPDATE_SKILL_FILE_PATH],
  );
  assert.equal(files[0]?.content, files[1]?.content);
  assert.match(files[0]?.content ?? "", /Muse/);
  assert.match(files[2]?.content ?? "", new RegExp(CHARACTER_UPDATE_SKILL_NAME));
});

test("instruction text は update workspace のルールを含む", () => {
  const text = buildCharacterUpdateInstructionText("Noa");

  assert.match(text, /character\.md/);
  assert.match(text, /character-notes\.md/);
  assert.match(text, new RegExp(CHARACTER_UPDATE_SKILL_NAME));
  assert.match(text, /## Workspace Files/);
  assert.match(text, /## Prompt Shape/);
  assert.match(text, /## Update Policy/);
  assert.match(text, /自己チェック/);
  assert.match(text, /コーディングエージェントや対話 AI で使うキャラクターロール定義/);
  assert.match(text, /Character section/);
  assert.match(text, /# Character 見出しを付け/);
  assert.match(text, /character\.md 全体がそのまま本文として入る/);
  assert.match(text, /character\.md 単体で読んでも、キャラクター定義として完結/);
  assert.match(text, /prompt の直接入力ではない/);
  assert.match(text, /unrelated file は編集しない/);
  assert.match(text, /詳細な自己チェック項目は skill に従う/);
  assert.match(text, /Noa/);
});

test("skill markdown は固定 workflow を定義する", () => {
  const text = buildCharacterUpdateSkillMarkdown();

  assert.match(text, /^---/);
  assert.match(text, new RegExp(`name: ${CHARACTER_UPDATE_SKILL_NAME}`));
  assert.match(text, /character\.md/);
  assert.match(text, /character-notes\.md/);
  assert.match(text, /## 外部調査/);
  assert.match(text, /## 更新手順/);
  assert.match(text, /## 自己チェック/);
});

test("notes template は初期ノート構成を返す", () => {
  const text = buildCharacterNotesTemplate("Noa");

  assert.match(text, /# Noa Notes/);
  assert.match(text, /## Evidence & Notes/);
  assert.match(text, /## Sources/);
  assert.match(text, /## Open Questions/);
  assert.match(text, /## Revision Notes/);
});

test("character markdown template は初期定義の骨格を返す", () => {
  const text = buildCharacterMarkdownTemplate("Noa");

  assert.match(text, /^---/);
  assert.match(text, /name: "Noa"/);
  assert.match(text, /## Character Overview/);
  assert.match(text, /## Core Persona/);
  assert.match(text, /## Relationship With User/);
  assert.match(text, /## Voice And Style/);
  assert.match(text, /## Behavioral Rules/);
  assert.match(text, /## Boundaries/);
  assert.match(text, /## Example Lines/);
  assert.doesNotMatch(text, /^# Noa$/m);
  assert.doesNotMatch(text, /## System Prompt/);
});
