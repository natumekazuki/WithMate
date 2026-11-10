import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  DEFAULT_MEMORY_RECORDING_FREQUENCIES,
  getMemoryRecordingTrigger,
  validateMemoryRecordingFrequency,
} from "../../src-shared/memory-recording/memory-recording-frequency.js";

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
