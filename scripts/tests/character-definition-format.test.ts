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

    assert.equal(skillTemplate.replace(/\r\n?/g, "\n"), buildDefaultCharacterNotes());
  });

  // @test-value v2
  // kind = "contract"
  // claim = "default builderがBaseline Presenceを含むCharacter Kernelと、会話・作業のevidence分離を備えた推奨構造を返す"
  // oracle = { type = "adr", ref = "docs/adr/011-character-authoring-kernel.md" }
  // fault = "default builderがBaseline PresenceまたはVoice Rulesのない旧Examples中心の定義、作業中の声・検証欄のないnotes、必要な校正記録欄のないnotes、固定返答例の代表的な見出しを返し、full authoringの品質契約と食い違う"
  // observable = "buildDefaultCharacterDefinition()とbuildDefaultCharacterNotes()の戻り値"
  // observation_boundary = "component-behavior"
  // scope = "character-definition-templates"
  // lifecycle = "permanent"
  // impact = "新規draftやCharacter作成の開始点から平常時のCharacter性、作業中の声、校正記録が欠落し、品質契約に沿った改善を始められない"
  // distinction = "storage/editor経路やSkill templateの同一性ではなく、default builder自身の推奨構造を直接観測する"
  // @end-test-value
  it("default Character files は Kernel と evidence 分離の推奨構造を持つ", async () => {
    const definition = buildDefaultCharacterDefinition("Muse");
    const notes = buildDefaultCharacterNotes();

    assert.match(definition, /# Character Kernel/);
    assert.match(definition, /^## Baseline Presence$/m);
    assert.match(definition, /## Identity Core/);
    assert.match(definition, /## Attention and Appraisal/);
    assert.match(definition, /## Social Intent \/ User Relationship/);
    assert.match(definition, /## Emotional Dynamics and Core Tensions/);
    assert.match(definition, /## Thinking and Action Style/);
    assert.match(definition, /作業中にコード・資料・tool結果/);
    assert.match(definition, /### Identity Invariants/);
    assert.match(definition, /### Distributional Tendencies/);
    assert.match(definition, /### Triggered Markers/);
    assert.match(definition, /## State Modulation/);
    assert.match(definition, /作業中・集中・発見・見立ての修正/);
    assert.match(definition, /## Character Priority/);
    assert.match(definition, /## Minimal Reliability/);
    assert.match(definition, /^## Voice Rules$/m);
    for (const section of [
      "Identity Invariants",
      "Distributional Tendencies",
      "Triggered Markers",
    ]) {
      const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(definition, new RegExp(`^### ${escapedSection}$`, "m"));
    }
    assert.doesNotMatch(definition, /^#{2,3} (?:Examples?|Example Responses|Response Examples|Scene Dialogues?)(?: \(.+\))?(?::.*)?$/m);
    assert.doesNotMatch(
      definition,
      /^#{2,3} (?:Work-session Design|Evidence(?: \/ Sources)?|Observation Log|Revision Notes|Validation Summary|Work-session Validation Record)$/m,
    );

    assert.match(notes, /^## Calibration Brief$/m);
    assert.match(notes, /^## Likeness Anchors \/ Protected Traits$/m);
    assert.match(notes, /^## Source Coverage$/m);
    assert.match(notes, /^## Evidence \/ Sources$/m);
    assert.match(notes, /^## Observation Log$/m);
    assert.match(notes, /## Character Kernel Derivation/);
    assert.match(notes, /## Voice Evidence/);
    assert.match(notes, /^## State Modulation$/m);
    assert.match(notes, /## Runtime Handoff/);
    assert.match(notes, /## Conflicts \/ Uncertainty/);
    assert.match(notes, /## Revision Guardrails/);
    assert.match(notes, /^## Validation Summary$/m);
    assert.match(notes, /^### Environment and Provenance$/m);
    assert.match(notes, /^### Main Quality Test Details$/m);
    assert.match(notes, /^### Continuous Conversation Record$/m);
    assert.match(notes, /^## Work-session Design$/m);
    assert.match(notes, /^### Work-session Validation Record$/m);
    assert.match(notes, /Task-execution \/ Conversation-work Continuity/);
    assert.match(notes, /synthetic-event \/ recorded-tool-replay \/ live-tool-execution/);
    for (const axis of ["Work Likeness", "Task Integrity", "Collaboration Comfort"]) {
      assert.match(notes, new RegExp(`^\\| ${axis} \\|`, "m"));
    }
    assert.match(notes, /^- Functional verification: pass \/ fail \/ inconclusive \/ not-run \/ not-applicable$/m);
    assert.match(notes, /Session \/ task ID、候補revision/);
    assert.match(notes, /ユーザー依頼・初期資料やfileの版・受入条件/);
    assert.match(notes, /tool構成・権限・初期状態の復元方法/);
    assert.match(notes, /synthetic-eventやreplayのみのFunctional verificationはnot-run/);
    assert.match(notes, /非公開の内部思考は原出力証拠にしない/);

    for (const section of [
      "Identity Core",
      "Attention and Appraisal",
      "Social Intent / User Relationship",
      "Emotional Dynamics and Core Tensions",
      "Thinking and Action Style",
      "State Modulation",
      "Character Priority",
      "Minimal Reliability",
    ]) {
      const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(definition, new RegExp(`^## ${escapedSection}$`, "m"));
    }
    assert.doesNotMatch(
      definition,
      /^#{2,3} (?:Calibration Brief|Likeness Anchors \/ Protected Traits|Source Coverage|Evidence \/ Sources|Observation Log|Character Kernel Derivation|Voice Evidence|Feedback and Revision Log|User Input Classification|Frontmatter Description|Runtime Handoff|Conflicts \/ Uncertainty|Revision Guardrails|Revision Notes|Validation Summary|Environment and Provenance|Main Quality Test Details|Natural Marker Opportunity Log|Required Diagnostics|Relationship Smoke Test|Continuous Conversation Record|Work-session Design|Work-session Validation Record|Future Improvements)$/m,
    );
    assert.doesNotMatch(
      definition,
      /^### Generalization and Voice$/m,
    );
  });
});
