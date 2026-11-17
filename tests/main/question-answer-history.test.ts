import test from "node:test";
import assert from "node:assert/strict";
import { questionAnswerHistory } from "../../src-electron/session/question-answer-history.js";
import type { LiveElicitationRequest } from "../../src-shared/session/runtime-state.js";
import { normalizeMessage } from "../../src-shared/session/session-state.js";

const request: LiveElicitationRequest = {
  requestId: "question", provider: "opencode", kind: "question", mode: "form", message: "Choose",
  fields: [
    { type: "select", name: "choice", title: "Choice", required: true, options: [{ value: "a", label: "Option A" }] },
    { type: "text", name: "comment", title: "Comment", required: true },
    { type: "text", name: "secret", title: "Secret", required: true, secret: true },
  ],
};

// @test-value v2
// kind = "contract"
// claim = "通常質問の送信値に一致する選択と自由入力だけを表示用に保持し、秘密入力を保持しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#question-forms" }
// fault = "選択値と候補の対応を失う、未送信値を表示する、または秘密値を質問履歴へ保存する"
// observable = "選択index・自由入力・秘密fieldの投影結果"
// observation_boundary = "consumer"
// scope = "question-answer-history"
// lifecycle = "permanent"
// risk_tags = ["privacy"]
// impact = "利用者が選んでいない回答を履歴で誤認するか、秘密値が露出する"
// distinction = "型検査とフォーム表示testは保存前の値と秘密fieldの一致を検証しない"
// @end-test-value
test("question history retains matching choices and text but not secrets", () => {
  const result = questionAnswerHistory(request, { action: "accept", content: { choice: "a", comment: "line one\nline two", secret: "sensitive" },
    answerPresentation: { choice: { selected: [0], text: [] }, comment: { selected: [], text: ["line one\nline two"] }, secret: { selected: [], text: ["sensitive"] } } });
  assert.deepEqual(result, [{ selected: [0], text: [] }, { selected: [], text: ["line one\nline two"] }, undefined]);
  assert.doesNotMatch(JSON.stringify(result), /sensitive/);
  assert.deepEqual(questionAnswerHistory(request, { action: "accept", content: { choice: "a" }, answerPresentation: { choice: { selected: [], text: ["other"] } } }), [undefined, undefined, undefined]);
});

// @test-value v2
// kind = "contract"
// claim = "通常質問以外と取消には回答表示を作らず、複数選択と自由入力をそれぞれ保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#question-forms" }
// fault = "一般フォームの値を質問履歴へ保存するか、複数候補や自由回答を欠落させる"
// observable = "一般フォーム・取消時の結果と複数回答の投影"
// observation_boundary = "consumer"
// scope = "question-answer-history"
// lifecycle = "permanent"
// risk_tags = ["privacy"]
// impact = "一般フォームの入力が意図せず保存されるか、回答を正しく見返せない"
// distinction = "adapter往復testは質問履歴への保存境界を検証しない"
// @end-test-value
test("question history excludes generic forms and keeps multi-select answers", () => {
  const multi: LiveElicitationRequest = { ...request, fields: [{ type: "multi-select", name: "choices", title: "Choices", required: true,
    options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], allowFreeText: true }] };
  const response = { action: "accept" as const, content: { choices: ["custom", "b", "a"] },
    answerPresentation: { choices: { selected: [1, 0], text: ["custom"] } } };
  assert.deepEqual(questionAnswerHistory(multi, response), [{ selected: [1, 0], text: ["custom"] }]);
  assert.equal(questionAnswerHistory({ ...multi, retainQuestionAnswer: false }, response), undefined);
  assert.equal(questionAnswerHistory({ ...multi, kind: undefined, provider: "copilot" }, response), undefined);
  assert.equal(questionAnswerHistory(multi, { action: "cancel" }), undefined);
});

// @test-value v2
// kind = "contract"
// claim = "通常質問の選択と自由回答はmessage JSONを正規化して再読込しても対応を保つ"
// oracle = { type = "contract", ref = "docs/design/database-schema.md: 質問formの記録" }
// fault = "保存済み回答を正規化時に捨てるか、候補のindexを別の選択肢へ対応付ける"
// observable = "JSON round-trip後の質問記録と表示用回答"
// observation_boundary = "consumer"
// scope = "question answer message normalization"
// lifecycle = "permanent"
// impact = "会話の再表示で選択と自由回答を見返せない"
// distinction = "live recordのtestは保存用message正規化を通らない"
// @end-test-value
test("saved question answer survives message normalization", () => {
  const message = { role: "assistant", text: "Choose", elicitationRecords: [{ requestId: "q", kind: "question", message: "Choose", status: "answered",
    fields: [{ title: "Choose", options: ["A", "B"], answer: { selected: [1], text: ["custom\ntext"] } }] }] };
  assert.deepEqual(normalizeMessage(JSON.parse(JSON.stringify(message)))?.elicitationRecords?.[0].fields[0], message.elicitationRecords[0].fields[0]);
});
