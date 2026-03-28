import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCharacterMarkdownTemplate,
  buildCharacterNotesTemplate,
  buildCharacterUpdateInstructionFiles,
  buildCharacterUpdateInstructionText,
  getCharacterUpdateInstructionFileName,
} from "../../src-electron/character-update-instructions.js";

test("provider ごとの instruction file 名を返す", () => {
  assert.equal(getCharacterUpdateInstructionFileName("codex"), "AGENTS.md");
  assert.equal(getCharacterUpdateInstructionFileName("copilot"), "copilot-instructions.md");
});

test("instruction file は Add Character 直後に必要な 2 ファイル分を返す", () => {
  const files = buildCharacterUpdateInstructionFiles("Muse");

  assert.deepEqual(
    files.map((file) => file.fileName),
    ["AGENTS.md", "copilot-instructions.md"],
  );
  assert.ok(files.every((file) => file.content === files[0]?.content));
  assert.match(files[0]?.content ?? "", /Muse/);
});

test("instruction text は update workspace のルールを含む", () => {
  const text = buildCharacterUpdateInstructionText("Noa");

  assert.match(text, /character\.md/);
  assert.match(text, /character-notes\.md/);
  assert.match(text, /## 優先順位/);
  assert.match(text, /1\. ユーザーの今回の指示/);
  assert.match(text, /既存の character\.md を先に読み/);
  assert.match(text, /無意味に全消ししない/);
  assert.match(text, /自己チェック/);
  assert.match(text, /禁止、許可、判断基準、優先順位/);
  assert.match(text, /コーディングエージェントや対話 AI で使うキャラクターロール定義/);
  assert.match(text, /Character section/);
  assert.match(text, /# Character 見出しを付け/);
  assert.match(text, /character\.md 全体がそのまま本文として入る/);
  assert.match(text, /character\.md 単体で読んでも、キャラクター定義として完結/);
  assert.match(text, /prompt の直接入力ではない/);
  assert.match(text, /Noa/);
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
