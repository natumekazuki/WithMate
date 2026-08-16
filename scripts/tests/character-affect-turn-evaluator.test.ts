import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCharacterAffectTurnPrompt,
  normalizeCharacterAffectTurnEvaluation,
  toAffectEventInputs,
} from "../../src-electron/character-affect-turn-evaluator.js";

function character() {
  return {
    characterId: "character-a",
    name: "A",
    description: "",
    iconFilePath: "",
    theme: { main: "#111111", sub: "#222222" },
    definitionMarkdown: "# Definition",
    definitionSha256: "definition-sha",
    definitionByteSize: 12,
    snapshotAt: "2026-08-09T00:00:00.000Z",
  };
}

describe("character affect turn evaluator", () => {
  it("one-turn eventと最小contextだけを評価promptへ渡す", () => {
    const prompt = buildCharacterAffectTurnPrompt({
      character: character(),
      context: {
        schemaVersion: "withmate-character-context-v1",
        characterId: "character-a",
        sessionId: "session-a",
        baseline: { definitionSha256: "definition-sha", snapshotAt: "2026-08-09T00:00:00.000Z" },
        affect: {
          mode: "active",
          effective: [{
            layer: "session",
            targetType: "task",
            targetId: "current-task",
            family: "interest",
            label: "interest",
            valence: 0.4,
            intensity: 0.6,
          }],
          evaluatedAt: "2026-08-09T00:00:00.000Z",
          version: "affect-v1-42",
          updatedAt: "2026-08-09T00:01:00.000Z",
        },
        memory: {
          items: [{
            id: "memory-secret",
            title: "Private title",
            preview: "Private preview",
            body: "RAW MEMORY BODY MUST NOT LEAK",
            target: { owner: "character", scope: "character", character: { type: "id", id: "character-a" } },
            tags: [],
            createdAt: "2026-08-09T00:00:00.000Z",
            updatedAt: "2026-08-09T00:00:00.000Z",
          }],
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
        scope: { userId: "local-user", characterId: "character-a", sessionId: "session-a" },
      },
      userMessage: "直ったね",
      assistantMessage: "うん、通ったよ。",
    });

    assert.match(prompt.userText, /affect-v1-42/);
    assert.match(prompt.userText, /2026-08-09T00:00:00\.000Z/);
    assert.equal(JSON.parse(prompt.userText).currentAffect.evaluatedAt, "2026-08-09T00:00:00.000Z");
    assert.match(prompt.userText, /直ったね/);
    assert.doesNotMatch(prompt.userText, /RAW MEMORY BODY MUST NOT LEAK/);
    assert.doesNotMatch(prompt.userText, /Private title/);
    assert.match(prompt.systemText, /Do not diagnose or label the user's emotions/);
  });

  it("structured candidateをserver-owned identityとidempotencyへ変換する", () => {
    const evaluation = normalizeCharacterAffectTurnEvaluation({
      candidates: [{
        layer: "relationship",
        targetType: "user",
        targetId: "local-user",
        family: "affinity",
        label: "trust",
        valence: 0.7,
        arousal: null,
        intensity: 0.55,
        reason: "The user and Character resolved the task together.",
        evidence: "The user acknowledged the successful result.",
      }],
    });
    assert.ok(evaluation);

    const events = toAffectEventInputs({
      evaluation,
      characterId: "character-a",
      sessionId: "session-a",
      userId: "local-user",
      occurredAt: "2026-08-09T00:00:00.000Z",
      idempotencyPrefix: "turn:session-a:42",
    });

    assert.equal(events[0]?.characterId, "character-a");
    assert.equal(events[0]?.idempotencyKey, "turn:session-a:42:0");
    assert.equal(events[0]?.value.arousal, undefined);
  });

  it("範囲外または空のcandidateを拒否する", () => {
    assert.equal(normalizeCharacterAffectTurnEvaluation({
      candidates: [{
        layer: "session",
        targetType: "task",
        targetId: "current-task",
        family: "interest",
        label: "interest",
        valence: 2,
        arousal: null,
        intensity: 0.5,
        reason: "reason",
        evidence: "evidence",
      }],
    }), null);
    assert.equal(normalizeCharacterAffectTurnEvaluation({
      candidates: [{
        layer: "session",
        targetType: "task",
        targetId: "current-task",
        family: "unknown",
        label: "free label",
        valence: 0,
        arousal: null,
        intensity: 0.5,
        reason: "reason",
        evidence: "evidence",
      }],
    }), null);
  });
});
