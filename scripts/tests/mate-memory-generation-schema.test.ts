import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseMateMemoryGenerationResponse,
  type MateMemoryGenerationParseDefaults,
} from "../../src-electron/mate-memory-generation-schema.js";

describe("parseMateMemoryGenerationResponse", () => {
  it("required field が揃っていれば defaults を補完して Memories を返す", () => {
    const defaults: MateMemoryGenerationParseDefaults = {
      sourceType: "session",
      sourceSessionId: "session-1",
      sourceAuditLogId: 22,
      projectDigestId: "digest-1",
    };

    const result = parseMateMemoryGenerationResponse(
      {
        memories: [{
          statement: "  会話を要約すると進捗が追いやすい  ",
          growthSourceType: "assistant_inference",
          kind: "observation",
          targetSection: "core",
          confidence: 78.9,
          salienceScore: 99.4,
          tags: [
            { type: "Topic", value: "work" },
            { type: "  ", value: "empty" },
            { value: "noType" },
            { type: "topic", value: "focus" },
          ],
        }],
      },
      defaults,
    );

    assert.equal(result.memories.length, 1);
    assert.equal(result.memories[0].sourceType, "session");
    assert.equal(result.memories[0].sourceSessionId, "session-1");
    assert.equal(result.memories[0].sourceAuditLogId, 22);
    assert.equal(result.memories[0].projectDigestId, "digest-1");
    assert.equal(result.memories[0].statement, "会話を要約すると進捗が追いやすい");
    assert.equal(result.memories[0].confidence, 78);
    assert.equal(result.memories[0].salienceScore, 99);
    assert.deepEqual(result.memories[0].tags, [
      { type: "Topic", value: "work" },
      { type: "topic", value: "focus" },
    ]);
  });

  it("sourceType は memory または defaults で補完される", () => {
    const withDefault = parseMateMemoryGenerationResponse({
      memories: [{
        statement: "保存先の文脈は明確化される",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 10,
        salienceScore: 20,
      }],
    }, {
      sourceType: "system",
    });
    const withMemorySource = parseMateMemoryGenerationResponse({
      memories: [{
        statement: "明示的な sourceType を優先する",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 10,
        salienceScore: 20,
        sourceType: "manual",
      }],
    }, {
      sourceType: "system",
    });

    assert.equal(withDefault.memories[0].sourceType, "system");
    assert.equal(withMemorySource.memories[0].sourceType, "manual");
  });

  it("remember/forceRemember は retention='force' に変換する", () => {
    const result = parseMateMemoryGenerationResponse({
      memories: [{
        statement: "意図的に保持したい知見",
        growthSourceType: "assistant_inference",
        kind: "preference",
        targetSection: "work_style",
        confidence: 55,
        salienceScore: 40,
        remember: true,
      }, {
        statement: "後続でも維持する必要あり",
        growthSourceType: "assistant_inference",
        kind: "preference",
        targetSection: "work_style",
        confidence: 70,
        salienceScore: 60,
        forceRemember: true,
      }],
    }, {
      sourceType: "session",
    });

    assert.equal(result.memories[0].retention, "force");
    assert.equal(result.memories[1].retention, "force");
  });

  it("memories が空配列なら OK", () => {
    const result = parseMateMemoryGenerationResponse({
      memories: [],
    }, {
      sourceType: "session",
    });

    assert.deepEqual(result, { memories: [] });
  });

  it("enum 以外や必須項目欠落で日本語 Error を投げる", () => {
    assert.throws(() => parseMateMemoryGenerationResponse({
      memories: [{
        statement: "不正な kind",
        growthSourceType: "assistant_inference",
        kind: "invalid_kind",
        targetSection: "core",
        confidence: 50,
        salienceScore: 50,
      }],
    }, {
      sourceType: "session",
    }), /kind が不正だよ。/);

    assert.throws(() => parseMateMemoryGenerationResponse({
      memories: [{
        growthSourceType: "assistant_inference",
        kind: "preference",
        targetSection: "core",
        confidence: 50,
        salienceScore: 50,
      }],
    }, {
      sourceType: "session",
    }), /statement が必要だよ。/);

    assert.throws(() => parseMateMemoryGenerationResponse({}, {
      sourceType: "session",
    }), /memories 配列が必要だよ。/);

    assert.throws(() => parseMateMemoryGenerationResponse({
      memories: [{
        statement: "0-100 を外れた値",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 300,
        salienceScore: -1,
      }],
    }, {
      sourceType: "session",
    }), /confidence が 0-100 の整数でないよ。/);
  });
});
