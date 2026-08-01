import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  CHARACTER_DEFINITION_MAX_CHARACTERS,
  CHARACTER_DEFINITION_SCHEMA,
  CHARACTER_NOTES_MAX_BYTES,
  collectCharacterDefinitionPathReferences,
  countCharacterDefinitionCharacters,
  isSafeCharacterRelativePath,
  parseCharacterDefinitionMarkdown,
  validateCharacterDefinitionMarkdown,
  validateCharacterNotesMarkdown,
} from "../../src/character/character-definition.js";
import {
  buildDefaultCharacterDefinition,
  buildDefaultCharacterNotes,
} from "../../src/character/character-definition-template.js";

const validCharacterMarkdown = `---
schema: ${CHARACTER_DEFINITION_SCHEMA}
name: "Mia"
description: "A focused coding companion."
---

# Character Runtime Definition

## Experience Goal
- A calm coding partner.

## Work / Response Separation
- Keep coding work accurate while shaping the user-facing response voice.

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

  it("生成した quoted frontmatter の backslash と double quote を round-trip する", () => {
    const name = "Muse \"C:\\Sound\"";
    const description = "音楽は C:\\Music、呼び名は \"Muse\"。";
    const result = parseCharacterDefinitionMarkdown(buildDefaultCharacterDefinition(name, description));

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }

    assert.equal(result.value.frontmatter.name, name);
    assert.equal(result.value.frontmatter.description, description);
  });

  it("手書き quoted frontmatter の未知の backslash sequence は保持する", () => {
    const result = parseCharacterDefinitionMarkdown(validCharacterMarkdown.replace(
      'name: "Mia"',
      'name: "C:\\Muse"',
    ));

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }

    assert.equal(result.value.frontmatter.name, "C:\\Muse");
  });

  it("frontmatter schema と name を必須にする", () => {
    const markdown = `---
schema: legacy-character
name: ""
---

## Experience Goal
- body
`;

    assert.deepEqual(issueCodes(markdown), ["invalid_schema", "missing_name"]);
  });

  it("frontmatter がない character.md を拒否する", () => {
    assert.deepEqual(issueCodes("## Experience Goal\n- body\n"), ["missing_frontmatter"]);
  });

  it("本文が空の character.md を拒否する", () => {
    const markdown = `---
schema: ${CHARACTER_DEFINITION_SCHEMA}
name: Mia
---
`;

    assert.deepEqual(issueCodes(markdown), ["empty_body"]);
  });

  it("null byte と LF 正規化後の 8,000 文字上限を検出する", () => {
    assert.deepEqual(issueCodes(`${validCharacterMarkdown}\0`), ["null_byte"]);

    const prefix = `---
schema: ${CHARACTER_DEFINITION_SCHEMA}
name: Mia
---

`;
    const exactLimitMarkdown = `${prefix}${"あ".repeat(
      CHARACTER_DEFINITION_MAX_CHARACTERS - countCharacterDefinitionCharacters(prefix),
    )}`;

    assert.equal(countCharacterDefinitionCharacters(exactLimitMarkdown), CHARACTER_DEFINITION_MAX_CHARACTERS);
    assert.deepEqual(issueCodes(exactLimitMarkdown), []);
    assert.deepEqual(issueCodes(`${exactLimitMarkdown}a`), ["size_limit_exceeded"]);
    assert.equal(
      countCharacterDefinitionCharacters(exactLimitMarkdown.replaceAll("\n", "\r\n")),
      CHARACTER_DEFINITION_MAX_CHARACTERS,
    );
    assert.equal(
      countCharacterDefinitionCharacters(exactLimitMarkdown.replaceAll("\n", "\r")),
      CHARACTER_DEFINITION_MAX_CHARACTERS,
    );
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

  it("app と authoring Skill が同じ character-notes template を使う", async () => {
    const skillTemplate = await readFile(
      new URL("../../resources/skills/withmate-character-authoring/templates/character-notes.md", import.meta.url),
      "utf8",
    );

    assert.equal(skillTemplate, buildDefaultCharacterNotes());
  });
});
