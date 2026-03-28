import assert from "node:assert/strict";
import test from "node:test";

import {
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
  assert.match(text, /ユーザーの今回の指示を最優先/);
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
