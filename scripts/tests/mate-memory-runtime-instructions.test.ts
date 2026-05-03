import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import type { MateMemoryGenerationPrompt } from "../../src-electron/mate-memory-generation-prompt.js";
import { buildMateMemoryRuntimeInstructionFiles } from "../../src-electron/mate-memory-runtime-instructions.js";
import { buildMateMemoryGenerationLogicalPrompt, buildMateMemoryGenerationPrompt } from "../../src-electron/mate-memory-generation-prompt.js";

function createPromptInput(): Parameters<typeof buildMateMemoryGenerationPrompt>[0] {
  return {
    recentConversationText: "テスト会話",
    existingTagCatalog: [{ tagType: "Topic", tagValue: "memory" }],
  };
}

function buildInput(providerIds: string[]) {
  const prompt = buildMateMemoryGenerationPrompt(createPromptInput());
  const logicalPrompt = buildMateMemoryGenerationLogicalPrompt(prompt);

  return {
    prompt,
    logicalPrompt,
    providerIds,
    metadata: {
      appName: "WithMate",
      mateName: "Alice",
      mateSummary: "テストMate",
    },
  };
}

test("codex/copilot の instruction file が生成される", () => {
  const files = buildMateMemoryRuntimeInstructionFiles(buildInput(["codex", "copilot"]));

  const paths = files.map((file) => file.relativePath).sort();
  assert.deepEqual(paths, [
    path.join(".github", "copilot-instructions.md"),
    path.join("AGENTS.md"),
  ]);
});

test("provider の重複は除去される", () => {
  const files = buildMateMemoryRuntimeInstructionFiles(buildInput([
    "codex",
    "Copilot",
    "copilot",
    "CUSTOM_PROVIDER",
    "custom_provider",
  ]));

  const paths = files.map((file) => file.relativePath).sort();
  assert.deepEqual(paths, [
    path.join(".github", "copilot-instructions.md"),
    path.join(".github", "custom_provider-instructions.md"),
    "AGENTS.md",
  ]);
});

test("不正 provider は既存の resolver と同様に例外になる", () => {
  const input = buildInput(["codex", "../outside"]);
  assert.throws(() => buildMateMemoryRuntimeInstructionFiles(input), /Invalid providerId/);
});

test("生成内容に Memory 生成専用・秘密情報禁止・structured output・ファイル編集禁止が含まれる", () => {
  const files = buildMateMemoryRuntimeInstructionFiles(buildInput(["codex", "copilot"]));
  const content = files[0]?.content ?? "";

  assert.match(content, /Memory 生成専用/);
  assert.match(content, /秘密情報\/API key\/password\/token\/path\/URL/);
  assert.match(content, /structured output/);
  assert.match(content, /ファイル編集は禁止/);
  assert.equal(content.includes("C:/"), false);
  assert.equal(content.includes("D:/"), false);
});
