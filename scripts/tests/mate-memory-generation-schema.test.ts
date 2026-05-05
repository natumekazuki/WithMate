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
          relation: "reinforces",
          targetClaimKey: "existing-claim-1",
          relatedRefs: ["existing-claim-1", "existing-claim-2"],
          supersedesRefs: ["old-claim"],
          newTags: [
            { type: "Focus", value: "timing", reason: "既存 catalog に無かったため" },
          ],
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
    assert.equal(result.memories[0].relation, "reinforces");
    assert.equal(result.memories[0].targetClaimKey, "existing-claim-1");
    assert.deepEqual(result.memories[0].tags, [
      { type: "Topic", value: "work" },
      { type: "topic", value: "focus" },
    ]);
  });

  it("existingTagCatalog がある場合、tags は一致する catalog の canonical 値で返される", () => {
    const defaults: MateMemoryGenerationParseDefaults = {
      sourceType: "session",
      existingTagCatalog: [{
        tagType: "Topic",
        tagValue: "Work",
        tagValueNormalized: "work",
      }],
    };

    const result = parseMateMemoryGenerationResponse({
      memories: [{
        statement: "既存 catalog の canonical 値を使う",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 80,
        salienceScore: 80,
        tags: [
          { type: "topic", value: "work" },
        ],
      }],
    }, defaults);

    assert.deepEqual(result.memories[0].tags, [{ type: "Topic", value: "Work" }]);
  });

  it("existingTagCatalog は normalized value と canonical tagValue の両方で照合し、重複 tags を畳む", () => {
    const defaults: MateMemoryGenerationParseDefaults = {
      sourceType: "session",
      existingTagCatalog: [{
        tagType: "Topic",
        tagValue: "C++",
        tagValueNormalized: "cpp",
      }],
    };

    const result = parseMateMemoryGenerationResponse({
      memories: [{
        statement: "normalized と canonical の両方で既存 catalog を再利用する",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 80,
        salienceScore: 80,
        tags: [
          { type: "topic", value: "cpp" },
          { type: "topic", value: "C++" },
          { type: "Topic", value: "C++" },
        ],
      }],
    }, defaults);

    assert.deepEqual(result.memories[0].tags, [{ type: "Topic", value: "C++" }]);
    assert.deepEqual(result.memories[0].newTags, []);
  });

  it("existingTagCatalog にない tags は reason を付けて newTags へ移し、既存 newTags と重複を除去する", () => {
    const defaults: MateMemoryGenerationParseDefaults = {
      sourceType: "session",
      existingTagCatalog: [{
        tagType: "Topic",
        tagValue: "Work",
      }],
    };

    const result = parseMateMemoryGenerationResponse({
      memories: [{
        statement: "unknown タグは newTags へ移す",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 80,
        salienceScore: 80,
        tags: [
          { type: "Topic", value: "work" },
          { type: "Unknown", value: "focus" },
          { type: "Unknown", value: "FOCUS" },
        ],
        newTags: [{ type: "Unknown", value: "focus", reason: "既に newTags を提案" }],
      }],
    }, defaults);

    assert.deepEqual(result.memories[0].tags, [{ type: "Topic", value: "Work" }]);
    assert.deepEqual(result.memories[0].newTags, [{
      type: "Unknown",
      value: "focus",
      reason: "既に newTags を提案",
    }]);
  });

  it("existingTagCatalog に一致する newTags は canonical tags へ戻し、未知 newTags だけ残す", () => {
    const defaults: MateMemoryGenerationParseDefaults = {
      sourceType: "session",
      existingTagCatalog: [{
        tagType: "Topic",
        tagValue: "Work",
        tagValueNormalized: "work",
      }, {
        tagType: "Style",
        tagValue: "Brief",
        tagValueNormalized: "",
      }],
    };

    const result = parseMateMemoryGenerationResponse({
      memories: [{
        statement: "existing catalog と newTags の重複を正規化する",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 80,
        salienceScore: 80,
        tags: [
          { type: "topic", value: "work" },
        ],
        newTags: [
          { type: "topic", value: "WORK", reason: "既存 catalog と重複" },
          { type: "style", value: "brief", reason: "normalized fallback で既存 catalog と重複" },
          { type: "Area", value: "focus", reason: "本当に新規" },
        ],
      }],
    }, defaults);

    assert.deepEqual(result.memories[0].tags, [
      { type: "Topic", value: "Work" },
      { type: "Style", value: "Brief" },
    ]);
    assert.deepEqual(result.memories[0].newTags, [{
      type: "Area",
      value: "focus",
      reason: "本当に新規",
    }]);
  });

  it("existingTagCatalog 未指定なら従来どおり tags をそのまま受け入れる", () => {
    const result = parseMateMemoryGenerationResponse({
      memories: [{
        statement: "catalog なしの後方互換を維持する",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 80,
        salienceScore: 80,
        tags: [
          { type: "TOPIC", value: "WORK" },
        ],
      }],
    }, {
      sourceType: "session",
    });

    assert.deepEqual(result.memories[0].tags, [{ type: "TOPIC", value: "WORK" }]);
  });

  it("relation 以外の relation 系 field は schema 互換として許容する", () => {
    const result = parseMateMemoryGenerationResponse({
      memories: [{
        statement: "関連情報を保持する",
        growthSourceType: "assistant_inference",
        kind: "relationship",
        targetSection: "bond",
        confidence: 60,
        salienceScore: 60,
        relation: "updates",
        targetClaimKey: "target-claim",
        relatedRefs: ["claim-a", "claim-b"],
        supersedesRefs: ["claim-old"],
        newTags: [{ type: "Area", value: "new", reason: "新規追加" }],
      }],
    }, {
      sourceType: "session",
    });

    assert.equal(result.memories[0].relation, "updates");
    assert.equal(result.memories[0].targetClaimKey, "target-claim");
  });

  it("typed ref と profile_item ref を受けて string ref 互換も保つ", () => {
    const result = parseMateMemoryGenerationResponse({
      memories: [{
        statement: "typed refs を混在して保持する",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 70,
        salienceScore: 80,
        relatedRefs: [
          "existing-1",
          { type: "memory", id: "existing-2" },
          { type: "profile_item", id: "profile-1" },
        ],
        supersedesRefs: [{ type: "profile_item", id: "profile-2" }],
        newTags: [{ type: "Area", value: "new", reason: "参照を作るため" }],
      }],
    }, {
      sourceType: "session",
    });

    assert.deepEqual(result.memories[0].relatedRefs, [
      { type: "memory", id: "existing-1" },
      { type: "memory", id: "existing-2" },
      { type: "profile_item", id: "profile-1" },
    ]);
    assert.deepEqual(result.memories[0].supersedesRefs, [{
      type: "profile_item",
      id: "profile-2",
    }]);
  });

  it("relation refs が省略された場合は保存入力でも省略を維持する", () => {
    const result = parseMateMemoryGenerationResponse({
      memories: [{
        statement: "refs を返さない旧形式",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 70,
        salienceScore: 80,
      }],
    }, {
      sourceType: "session",
    });

    assert.equal("relatedRefs" in result.memories[0], false);
    assert.equal("supersedesRefs" in result.memories[0], false);
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

  it("mate_talk sourceType を defaults で補完できる", () => {
    const withMateTalk = parseMateMemoryGenerationResponse({
      memories: [{
        statement: "MateTalk 経由の文脈を識別できる",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 42,
        salienceScore: 55,
      }],
    }, {
      sourceType: "mate_talk",
    });

    assert.equal(withMateTalk.memories[0].sourceType, "mate_talk");
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

  it("relatedRefs / supersedesRefs / newTags は不正な型で Error", () => {
    assert.throws(() => parseMateMemoryGenerationResponse({
      memories: [{
        statement: "bad relatedRefs",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 50,
        salienceScore: 50,
        relatedRefs: "not-array",
      }],
    }, {
      sourceType: "session",
    }), /relatedRefs が不正だよ。/);

    assert.throws(() => parseMateMemoryGenerationResponse({
      memories: [{
        statement: "bad supersedesRefs",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 50,
        salienceScore: 50,
        supersedesRefs: ["valid", 2 as unknown],
      }],
    }, {
      sourceType: "session",
    }), /supersedesRefs が不正だよ。/);

    assert.throws(() => parseMateMemoryGenerationResponse({
      memories: [{
        statement: "bad newTags",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 50,
        salienceScore: 50,
        newTags: "not-array" as unknown,
      }],
    }, {
      sourceType: "session",
    }), /newTags が不正だよ。/);

    assert.throws(() => parseMateMemoryGenerationResponse({
      memories: [{
        statement: "bad newTags item",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 50,
        salienceScore: 50,
        newTags: [{ type: "Topic", value: "", reason: "理由あり" }],
      }],
    }, {
      sourceType: "session",
    }), /newTags が不正だよ。/);

    assert.throws(() => parseMateMemoryGenerationResponse({
      memories: [{
        statement: "bad newTags reason",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 50,
        salienceScore: 50,
        newTags: [{ type: "Topic", value: "focus", reason: "" }],
      }],
    }, {
      sourceType: "session",
    }), /newTags が不正だよ。/);

    assert.throws(() => parseMateMemoryGenerationResponse({
      memories: [{
        statement: "bad typed ref",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "core",
        confidence: 50,
        salienceScore: 50,
        relatedRefs: [{ type: "profile", id: "x" }],
        newTags: [{ type: "Topic", value: "focus", reason: "新規" }],
      }],
    }, {
      sourceType: "session",
    }), /relatedRefs が不正だよ。/);
  });
});
