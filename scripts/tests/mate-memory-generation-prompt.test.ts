import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildMateMemoryGenerationPrompt,
  MATE_MEMORY_GENERATION_OUTPUT_SCHEMA,
} from "../../src-electron/mate-memory-generation-prompt.js";

describe("mate-memory-generation-prompt", () => {
  it("schema は memories と保存 field を必須化する", () => {
    const prompt = buildMateMemoryGenerationPrompt({
      recentConversationText: "ユーザー: 今日は API トークンを共有しないでください。",
      existingTagCatalog: [
        { tagType: "Topic", tagValue: "work" },
      ],
      sourceDefaults: {
        sourceType: "session",
        sourceSessionId: "session-1",
        sourceAuditLogId: 12,
        projectDigestId: "digest-1",
      },
      mateName: "Test Mate",
      mateSummary: "要件確認を支援する Mate",
    }).outputSchema as {
      required: string[];
      properties: {
        memories: {
          items: {
            required: string[];
          };
        };
      };
    };

    assert.deepEqual(prompt.required, ["memories"]);
    assert.deepEqual(prompt.properties.memories.items.required, [
      "statement",
      "growthSourceType",
      "kind",
      "targetSection",
      "confidence",
      "salienceScore",
      "tags",
      "remember",
      "sourceType",
      "sourceSessionId",
      "sourceAuditLogId",
      "projectDigestId",
    ]);
  });

  it("既存タグ一覧・保存方針・機密除外方針を prompt に含める", () => {
    const result = buildMateMemoryGenerationPrompt({
      recentConversationText: "昨日の会話で作業内容を整理した。",
      existingTagCatalog: [
        { tagType: "Topic", tagValue: "planning" },
        { tagType: "Scope", tagValue: "frontend" },
      ],
      sourceDefaults: {
        sourceType: "system",
      },
      mateName: "MateName",
      mateSummary: "短縮メモ担当",
    });

    assert.match(result.userText, /# Existing tag catalog/);
    assert.match(result.userText, /planning/);
    assert.match(result.userText, /frontend/);
    assert.match(result.userText, /sourceType: system/);
    assert.match(result.userText, /MateName/);
    assert.match(result.systemText, /schema-valid/);
    assert.match(result.systemText, /機密情報/);
    assert.match(result.systemText, /既存 tag catalog/);
  });

  it("出力スキーマ定義が export される", () => {
    assert.equal(MATE_MEMORY_GENERATION_OUTPUT_SCHEMA.type, "object");
    assert.equal(typeof MATE_MEMORY_GENERATION_OUTPUT_SCHEMA.properties.memories, "object");
    assert.equal(
      MATE_MEMORY_GENERATION_OUTPUT_SCHEMA.properties.memories.items.required.includes("statement"),
      true,
    );
  });
});
