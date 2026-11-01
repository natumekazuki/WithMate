import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type { MemoryTargetSelector } from "../../src-shared/memory/memory-contract.js";
import {
  DEFAULT_MEMORY_RECORDING_FREQUENCIES,
  getMemoryRecordingTrigger,
  validateMemoryRecordingFrequency,
} from "../../src-shared/memory-recording/memory-recording-frequency.js";
import {
  createTargetMemoryFinalSchema,
  validateCharacterMemoryFinal,
  validateTargetMemoryFinal,
  type CharacterMemoryValidationContext,
  type TargetMemoryValidationContext,
} from "../../src-shared/memory-recording/memory-recording-candidates.js";

const project: MemoryTargetSelector = { owner: "project", scope: "project", project: { type: "id", id: "project-a" } };
const characterContext: CharacterMemoryValidationContext = {
  target: { owner: "character", scope: "character", character: { type: "id", id: "character-a" } },
  history: { fromMessageSeq: 10, throughMessageSeq: 20 },
  messages: [
    { seq: 10, processing: false, operations: [], runChecks: [] },
    { seq: 12, processing: true,
      operations: [{ index: 0 }],
      runChecks: [{ index: 3 }] },
    { seq: 20, processing: true, operations: [], runChecks: [] },
  ],
};
const targetContext: TargetMemoryValidationContext = { ...characterContext, allowedTargets: new Map([["project", project]]) };
const grounding = [{ basis: "user_statement", refs: [{ kind: "message", seq: 12 }] }];
function episodeFinal(episode: Record<string, unknown> = {}, candidate: Record<string, unknown> = {}) {
  return { outcome: "candidates", episodes: [{ episode: {
    title: " 紅茶の話 ", body: " 一緒に紅茶を選んだ。 ", preview: " 紅茶を選んだ。 ", observedFact: " 紅茶を選んだ ", ...episode,
  }, grounding, ...candidate }] };
}
function targetFinal(candidate: Record<string, unknown> = {}) {
  return { outcome: "candidates", entries: [{ targetSlot: "project", kind: "decision", title: " 判断 ",
    body: " 合意した判断を使う。 ", preview: " 判断を使う。 ", grounding, ...candidate }] };
}

// @test-value v2
// kind = "invariant"
// claim = "二用途の既定5/5と有効頻度を返し、不正設定は救済せず拒否する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory生成の純粋な用途契約" }
// fault = "不正頻度を既定値に変換するか、非有限idleや安全でない整数を受け入れる"
// observable = "既定値、正規化値、validatorのZodError"
// observation_boundary = "component-behavior"
// scope = "memory-recording-frequency"
// lifecycle = "permanent"
// distinction = "外部の数値入力と境界値の拒否は型検査では観測できない"
// @end-test-value
test("頻度の既定値と入力境界を用途別に維持する", () => {
  assert.deepEqual(DEFAULT_MEMORY_RECORDING_FREQUENCIES, {
    "character-memory": { turnCount: 5, idleMinutes: 5 }, "target-memory": { turnCount: 5, idleMinutes: 5 },
  });
  assert.deepEqual(validateMemoryRecordingFrequency({ turnCount: 1, idleMinutes: 0.25 }), { turnCount: 1, idleMinutes: 0.25 });
  assert.equal(validateMemoryRecordingFrequency({ turnCount: Number.MAX_SAFE_INTEGER, idleMinutes: 5 }).turnCount, Number.MAX_SAFE_INTEGER);
  for (const turnCount of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "5"]) {
    assert.throws(() => validateMemoryRecordingFrequency({ turnCount, idleMinutes: 5 }), z.ZodError);
  }
  for (const idleMinutes of [0, -1, NaN, Infinity, -Infinity, "5"]) {
    assert.throws(() => validateMemoryRecordingFrequency({ turnCount: 5, idleMinutes }), z.ZodError);
  }
  for (const value of [undefined, null, {}, { turnCount: 5 }, { turnCount: 5, idleMinutes: 5, owner: "other" }]) {
    assert.throws(() => validateMemoryRecordingFrequency(value), z.ZodError);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "0件は非起動、N到達は件数、端数は非実行中かつidle到達だけで起動条件を返す"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory生成の純粋な用途契約" }
// fault = "空の会話を起動するか、実行中の端数をidleで起動し、用途やownerの頻度を混ぜる"
// observable = "各ownerと用途の入力に対するnone/turn_count/idle"
// observation_boundary = "component-behavior"
// scope = "memory-recording-trigger"
// lifecycle = "permanent"
// distinction = "時刻を固定した入力で閾値の等号と実行中分岐を直接検証する"
// @end-test-value
test("純粋判定は件数とidleを分け、呼出元の会話ごとの頻度を使う", () => {
  const input = { pendingTurnCount: 0, frequency: { turnCount: 5, idleMinutes: 5 }, isConversationRunning: false, idleMinutes: 10 };
  assert.equal(getMemoryRecordingTrigger(input), "none");
  assert.equal(getMemoryRecordingTrigger({ ...input, pendingTurnCount: 5, isConversationRunning: true }), "turn_count");
  assert.equal(getMemoryRecordingTrigger({ ...input, pendingTurnCount: 8 }), "turn_count");
  assert.equal(getMemoryRecordingTrigger({ ...input, pendingTurnCount: 4, idleMinutes: 4.99 }), "none");
  assert.equal(getMemoryRecordingTrigger({ ...input, pendingTurnCount: 4, idleMinutes: 5 }), "idle");
  assert.equal(getMemoryRecordingTrigger({ ...input, pendingTurnCount: 1, isConversationRunning: true }), "none");
  const calls = [
    { owner: "main", purpose: "character-memory", input: { ...input, pendingTurnCount: 2, idleMinutes: 0 } },
    { owner: "main", purpose: "target-memory", input: { ...input, pendingTurnCount: 2, idleMinutes: 0, frequency: { turnCount: 2, idleMinutes: 0.5 } } },
    { owner: "aux-a", purpose: "target-memory", input: { ...input, pendingTurnCount: 1, idleMinutes: 0.5, frequency: { turnCount: 2, idleMinutes: 0.5 } } },
    { owner: "aux-b", purpose: "target-memory", input },
  ];
  assert.deepEqual(calls.map((call) => getMemoryRecordingTrigger(call.input)), ["none", "turn_count", "idle", "none"]);
  assert.equal(getMemoryRecordingTrigger(calls[0].input), "none");
});

// @test-value v2
// kind = "invariant"
// claim = "日常のmessage根拠でCharacter候補を正規化し、保存先はアプリのCharacterに固定する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory生成の純粋な用途契約" }
// fault = "雑談に操作成功を必須化するか、episodeの事実/観察を失い、モデルの保存先を採用する"
// observable = "正規化episode、context由来target、明示no_candidates、入力への非書換え"
// observation_boundary = "component-behavior"
// scope = "character-memory-final"
// lifecycle = "permanent"
// distinction = "実際のunknown出力から既存episode検証と本文正規化の接続を観測する"
// @end-test-value
test("Character候補は日常会話と明示的な候補なしを扱う", () => {
  const value = episodeFinal({ motif: " tea " });
  const result = validateCharacterMemoryFinal(value, characterContext);
  assert.deepEqual(result.target, characterContext.target);
  assert.equal(result.final.outcome, "candidates");
  if (result.final.outcome !== "candidates") throw new Error("candidate missing");
  assert.deepEqual(result.final.episodes[0].episode, { title: "紅茶の話", body: "一緒に紅茶を選んだ。", preview: "紅茶を選んだ。", observedFact: "紅茶を選んだ", motif: "tea" });
  assert.equal(value.episodes[0].episode.title, " 紅茶の話 ");
  assert.deepEqual(validateCharacterMemoryFinal({ outcome: "no_candidates" }, characterContext).final, { outcome: "no_candidates" });
  const observation = validateCharacterMemoryFinal(episodeFinal({ observedFact: undefined, characterObservation: " 楽しかった " }, {
    grounding: [{ basis: "character_interpretation", refs: [{ kind: "message", seq: 12 }] }],
  }), characterContext);
  assert.equal(observation.final.outcome, "candidates");
  assert.throws(() => validateCharacterMemoryFinal(episodeFinal({ observedFact: undefined }), characterContext), z.ZodError);
});

// @test-value v2
// kind = "invariant"
// claim = "対象候補は許可slotだけを使い、通常appendと同じ本文/tag正規化を返す"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory生成の純粋な用途契約" }
// fault = "許可外targetへ保存候補を振り替えるか、tag正規化を二重定義して通常appendと異なる値にする"
// observable = "slotに対応するtarget、trim済み本文、canonical tag、許可外slot拒否"
// observation_boundary = "component-behavior"
// scope = "target-memory-final"
// lifecycle = "permanent"
// distinction = "contextの異なるslot許可集合と実正規化値は型だけでは保証できない"
// @end-test-value
test("対象候補は許可slotを解決し、Memoryの正規化を共用する", () => {
  const result = validateTargetMemoryFinal(targetFinal({ tags: [{ type: " Topic ", value: " V6 " }, { type: "topic", value: "v6" }] }), targetContext);
  assert.equal(result.outcome, "candidates");
  if (result.outcome !== "candidates") throw new Error("candidate missing");
  assert.deepEqual(result.entries[0].target, project);
  assert.equal(result.entries[0].title, "判断");
  assert.equal(result.entries[0].body, "合意した判断を使う。");
  assert.deepEqual(result.entries[0].tags, [{ type: "Topic", value: "V6", canonicalType: "topic", canonicalValue: "v6" }]);
  assert.throws(() => validateTargetMemoryFinal(targetFinal({ targetSlot: "user-global" }), targetContext), z.ZodError);
  assert.throws(() => validateTargetMemoryFinal(targetFinal(), { ...targetContext, allowedTargets: new Map() }), z.ZodError);
  assert.deepEqual(validateTargetMemoryFinal({ outcome: "no_candidates" }, { ...targetContext, allowedTargets: new Map() }), { outcome: "no_candidates" });
  const schema = z.toJSONSchema(createTargetMemoryFinalSchema(targetContext), { io: "input" });
  assert.match(JSON.stringify(schema), /"enum":\["project"\]/);
});

// @test-value v2
// kind = "invariant"
// claim = "finalの構造と未知fieldをstrictに拒否し、不正な空候補を正常0件に変えない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory生成の純粋な用途契約" }
// fault = "unknown fieldのidentityやsupersedesを透過するか、壊れた出力を候補なしで救済する"
// observable = "両用途のroot/候補/episode/根拠でのZodError"
// observation_boundary = "public-boundary"
// scope = "memory-recording-output-shape"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// distinction = "モデルの未知JSON入力はTypeScript型を通らずschema実行が必要"
// @end-test-value
test("両用途は未知fieldや空候補配列を保存候補として通さない", () => {
  for (const value of [null, [], {}, { outcome: "failed" }, { outcome: "no_candidates", entries: [] }, { outcome: "candidates", entries: [] }]) {
    assert.throws(() => validateTargetMemoryFinal(value, targetContext), z.ZodError);
  }
  for (const value of [null, {}, { outcome: "no_candidates", owner: "other" }, { outcome: "candidates", episodes: [] }, episodeFinal({}, { other: true }), episodeFinal({ target: project })]) {
    assert.throws(() => validateCharacterMemoryFinal(value, characterContext), z.ZodError);
  }
  for (const key of ["owner", "target", "project", "entryId", "idempotencyKey", "supersedes", "files", "authority"]) {
    assert.throws(() => validateTargetMemoryFinal(targetFinal({ [key]: project }), targetContext), z.ZodError);
  }
  assert.throws(() => validateTargetMemoryFinal(targetFinal({ grounding: [{ ...grounding[0], extra: true }] }), targetContext), z.ZodError);
  assert.throws(() => validateTargetMemoryFinal(targetFinal({ grounding: [] }), targetContext), z.ZodError);
  assert.throws(() => validateTargetMemoryFinal(targetFinal({ kind: "proposal" }), targetContext), z.ZodError);
});

// @test-value v2
// kind = "invariant"
// claim = "両用途の本文・tagは既存Memoryの長さとUnicode制約で拒否される"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory生成の純粋な用途契約" }
// fault = "候補経路で本文上限や不正Unicodeを素通しし、保存時まで不適合な候補を返す"
// observable = "上限内候補の受理と不正候補のZodError"
// observation_boundary = "component-behavior"
// scope = "memory-recording-content-values"
// lifecycle = "permanent"
// distinction = "既存append testだけでは新しい二用途からの共用経路は通らない"
// @end-test-value
test("本文の境界値とtag制約は既存Memoryと一致する", () => {
  const limits = { title: 160, body: 8000, preview: 280 };
  for (const [field, limit] of Object.entries(limits)) {
    assert.doesNotThrow(() => validateTargetMemoryFinal(targetFinal({ [field]: ` ${"a".repeat(limit)} ` }), targetContext));
    assert.doesNotThrow(() => validateCharacterMemoryFinal(episodeFinal({ [field]: "a".repeat(limit) }), characterContext));
    for (const value of ["a".repeat(limit + 1), " ", "x\0y", "\ud800", 12]) {
      assert.throws(() => validateTargetMemoryFinal(targetFinal({ [field]: value }), targetContext), z.ZodError);
      assert.throws(() => validateCharacterMemoryFinal(episodeFinal({ [field]: value }), characterContext), z.ZodError);
    }
  }
  assert.doesNotThrow(() => validateTargetMemoryFinal(targetFinal({ tags: Array.from({ length: 20 }, (_, i) => ({ type: "topic", value: String(i) })) }), targetContext));
  for (const tags of [Array.from({ length: 21 }, () => ({ type: "topic", value: "x" })), [{ type: "x".repeat(49), value: "x" }], [{ type: "x", value: "y", extra: true }]]) {
    assert.throws(() => validateTargetMemoryFinal(targetFinal({ tags }), targetContext), z.ZodError);
  }
  assert.throws(() => validateCharacterMemoryFinal(episodeFinal({ motif: "m".repeat(97) }), characterContext), z.ZodError);
});

// @test-value v2
// kind = "invariant"
// claim = "候補は許可された実在根拠と少なくとも一つのprocessing根拠を必要とする"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory生成の純粋な用途契約" }
// fault = "範囲外/不存在/過去contextのみの根拠を今回の記録候補として認める"
// observable = "seq/index/kindとprocessing所属による候補受理またはZodError"
// observation_boundary = "component-behavior"
// scope = "memory-recording-evidence-scope"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// distinction = "固定context内の参照存在とprocessing所属は型やschema構造だけでは分からない"
// @end-test-value
test("固定historyとprocessingの実在根拠だけを受け付ける", () => {
  const messages = [
    { seq: 9, processing: true, operations: [], runChecks: [] },
    ...characterContext.messages,
    { seq: 21, processing: true, operations: [], runChecks: [] },
  ];
  for (const ref of [{ kind: "message", seq: 9 }, { kind: "message", seq: 21 }, { kind: "message", seq: 13 },
    { kind: "message", seq: 10 }, { kind: "message", seq: -1 }, { kind: "message", seq: 12.5 },
    { kind: "message", seq: 12, index: 0 }, { kind: "operation", seq: 12 }, { kind: "operation", seq: 12, index: 99 },
    { kind: "run_check", seq: 12, index: -1 }, { kind: "file", seq: 12 }]) {
    const candidate = { grounding: [{ basis: "user_statement", refs: [ref] }] };
    assert.throws(() => validateTargetMemoryFinal(targetFinal(candidate), { ...targetContext, messages }), z.ZodError);
    assert.throws(() => validateCharacterMemoryFinal(episodeFinal({}, candidate), { ...characterContext, messages }), z.ZodError);
  }
  assert.throws(() => validateTargetMemoryFinal(targetFinal({ grounding: [{ basis: "user_statement", refs: [] }] }), targetContext), z.ZodError);
  assert.doesNotThrow(() => validateTargetMemoryFinal(targetFinal({ grounding: [{ basis: "user_statement", refs: [{ kind: "message", seq: 10 }, { kind: "message", seq: 20 }] }] }), targetContext));
});

// @test-value v2
// kind = "invariant"
// claim = "実行結果の根拠は保存操作/checkを参照し、対象知識へCharacter解釈を入れない"
// oracle = { type = "contract", ref = "docs/design/background-execution.md#memory生成の純粋な用途契約" }
// fault = "発言だけを操作結果の根拠として認めるか、Characterの主観を対象知識として返す"
// observable = "操作/check参照とbasisを保持した候補、またはZodError"
// observation_boundary = "component-behavior"
// scope = "memory-recording-grounding-basis"
// lifecycle = "permanent"
// distinction = "参照の実在だけでは保証できないbasisと参照種別/用途の対応を両validatorで観測する"
// @end-test-value
test("実行結果の参照種別とCharacter解釈の用途境界を守る", () => {
  for (const ref of [{ kind: "operation", seq: 12, index: 0 }, { kind: "run_check", seq: 12, index: 3 }]) {
    const candidate = { grounding: [{ basis: "execution_result", refs: [ref] }] };
    const target = validateTargetMemoryFinal(targetFinal(candidate), targetContext);
    const character = validateCharacterMemoryFinal(episodeFinal({}, candidate), characterContext);
    if (target.outcome !== "candidates" || character.final.outcome !== "candidates") throw new Error("candidate missing");
    assert.deepEqual(target.entries[0].grounding, candidate.grounding);
    assert.deepEqual(character.final.episodes[0].grounding, candidate.grounding);
  }
  const messageOnly = { grounding: [{ basis: "execution_result", refs: [{ kind: "message", seq: 12 }] }] };
  assert.throws(() => validateTargetMemoryFinal(targetFinal(messageOnly), targetContext), z.ZodError);
  assert.throws(() => validateCharacterMemoryFinal(episodeFinal({}, messageOnly), characterContext), z.ZodError);
  assert.throws(() => validateTargetMemoryFinal(targetFinal({ grounding: [{ basis: "character_interpretation", refs: [{ kind: "message", seq: 12 }] }] }), targetContext), z.ZodError);
  assert.throws(() => validateTargetMemoryFinal(targetFinal({ grounding: [{ basis: "unagreed_proposal", refs: [{ kind: "message", seq: 12 }] }] }), targetContext), z.ZodError);
  assert.doesNotThrow(() => validateTargetMemoryFinal(targetFinal({ grounding: [{ basis: "agreed_decision", refs: [{ kind: "message", seq: 12 }] }] }), targetContext));
});
