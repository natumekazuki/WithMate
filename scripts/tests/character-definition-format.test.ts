import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHARACTER_DEFINITION_MAX_BYTES,
  CHARACTER_DEFINITION_SCHEMA,
  CHARACTER_NOTES_MAX_BYTES,
  collectCharacterDefinitionPathReferences,
  isSafeCharacterRelativePath,
  parseCharacterDefinitionMarkdown,
  validateCharacterDefinitionMarkdown,
  validateCharacterNotesMarkdown,
} from "../../src/character/character-definition.js";

const validCharacterMarkdown = `---
schema: ${CHARACTER_DEFINITION_SCHEMA}
name: "Mia"
description: "A focused coding companion."
---

# Character Runtime Definition

## Identity
- A calm coding partner.

## Assets
- icon_path: \`./character.png\`
![Mia icon](./character.png)
`;

function issueCodes(markdown: string): string[] {
  return validateCharacterDefinitionMarkdown(markdown).map((issue) => issue.code);
}

describe("character-definition-format", () => {
  it("V5 Core の character.md を parse する", () => {
    const result = parseCharacterDefinitionMarkdown(validCharacterMarkdown);

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }

    assert.deepEqual(result.value.frontmatter, {
      schema: CHARACTER_DEFINITION_SCHEMA,
      name: "Mia",
      description: "A focused coding companion.",
    });
    assert.match(result.value.body, /# Character Runtime Definition/);
  });

  it("frontmatter schema と name を必須にする", () => {
    const markdown = `---
schema: legacy-character
name: ""
---

## Identity
- body
`;

    assert.deepEqual(issueCodes(markdown), ["invalid_schema", "missing_name"]);
  });

  it("frontmatter がない character.md を拒否する", () => {
    assert.deepEqual(issueCodes("## Identity\n- body\n"), ["missing_frontmatter"]);
  });

  it("本文が空の character.md を拒否する", () => {
    const markdown = `---
schema: ${CHARACTER_DEFINITION_SCHEMA}
name: Mia
---
`;

    assert.deepEqual(issueCodes(markdown), ["empty_body"]);
  });

  it("null byte と size limit を検出する", () => {
    assert.deepEqual(issueCodes(`${validCharacterMarkdown}\0`), ["null_byte"]);

    const largeMarkdown = `---
schema: ${CHARACTER_DEFINITION_SCHEMA}
name: Mia
---

${"a".repeat(CHARACTER_DEFINITION_MAX_BYTES)}
`;

    assert.deepEqual(issueCodes(largeMarkdown), ["size_limit_exceeded"]);
  });

  it("path reference を収集し、unsafe な相対 path を拒否する", () => {
    const markdown = `---
schema: ${CHARACTER_DEFINITION_SCHEMA}
name: Mia
---

## Assets
- icon_path: \`./character.png\`
![safe](assets/icon.png)
![absolute](/Users/example/secret.png)
![traversal](../secret.png)
`;

    assert.deepEqual(collectCharacterDefinitionPathReferences(markdown), [
      "./character.png",
      "assets/icon.png",
      "/Users/example/secret.png",
      "../secret.png",
    ]);

    assert.deepEqual(issueCodes(markdown), [
      "unsafe_path_reference",
      "unsafe_path_reference",
    ]);
  });

  it("external URL と anchor は path safety の対象外にする", () => {
    assert.equal(isSafeCharacterRelativePath("https://example.com/icon.png"), true);
    assert.equal(isSafeCharacterRelativePath("#identity"), true);
    assert.equal(isSafeCharacterRelativePath("./character.png"), true);
    assert.equal(isSafeCharacterRelativePath("/tmp/character.png"), false);
    assert.equal(isSafeCharacterRelativePath("C:\\Users\\example\\secret.png"), false);
    assert.equal(isSafeCharacterRelativePath("C:/Users/example/secret.png"), false);
    assert.equal(isSafeCharacterRelativePath("file:///Users/example/secret.png"), false);
    assert.equal(isSafeCharacterRelativePath("..\\secret.png"), false);
  });

  it("character-notes.md は runtime schema を要求せず補助ファイルとして検証する", () => {
    assert.deepEqual(validateCharacterNotesMarkdown("# Notes\n\n- ok"), []);
    assert.deepEqual(validateCharacterNotesMarkdown("note\0").map((issue) => issue.code), ["null_byte"]);
    assert.deepEqual(
      validateCharacterNotesMarkdown("a".repeat(CHARACTER_NOTES_MAX_BYTES + 1)).map((issue) => issue.code),
      ["size_limit_exceeded"],
    );
  });
});
