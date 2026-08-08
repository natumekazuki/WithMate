import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveConversationTimingContext } from "../../src-electron/conversation-timing.js";

describe("resolveConversationTimingContext", () => {
  it("固定したoffset付き日時と曜日から経過時間・今日・累積を算出する", () => {
    const observedAt = new Date("2026-08-04T12:32:00.000Z");
    const result = resolveConversationTimingContext({
      currentSessionLastCompletedAt: "2026-08-04T10:19:00.000Z",
      sameCharacterOtherSessionLastCompletedAt: "2026-08-01T07:20:00.000Z",
      sameCharacterCompletedTurns: [
        {
          startedAt: "2026-08-04T11:00:00.000Z",
          completedAt: "2026-08-04T11:30:00.000Z",
        },
        {
          startedAt: "2026-08-03T13:30:00.000Z",
          completedAt: "2026-08-03T14:30:00.000Z",
        },
      ],
    }, observedAt, () => 9 * 60);

    assert.equal(result.observedAt, "2026-08-04T21:32:00.000+09:00");
    assert.equal(result.observedDayOfWeek, "tuesday");
    assert.deepEqual(result.currentSession, {
      lastCompletedAt: "2026-08-04T19:19:00.000+09:00",
      elapsedMs: 2 * 60 * 60_000 + 13 * 60_000,
    });
    assert.deepEqual(result.sameCharacterOtherSession, {
      lastCompletedAt: "2026-08-01T16:20:00.000+09:00",
      elapsedMs: 3 * 24 * 60 * 60_000 + 5 * 60 * 60_000 + 12 * 60_000,
    });
    assert.deepEqual(result.sameCharacterSharedWork, {
      todayCompletedTurnDurationMs: 30 * 60_000,
      totalCompletedTurnDurationMs: 90 * 60_000,
    });
  });

  it("ローカル日付境界を使い、parse不能・未来・負の実行時間を除外する", () => {
    const observedAt = new Date("2026-08-04T00:30:00.000Z");
    const result = resolveConversationTimingContext({
      currentSessionLastCompletedAt: "invalid",
      sameCharacterOtherSessionLastCompletedAt: "2026-08-04T00:31:00.000Z",
      sameCharacterCompletedTurns: [
        {
          startedAt: "2026-08-03T14:40:00.000Z",
          completedAt: "2026-08-03T14:50:00.000Z",
        },
        { startedAt: "invalid", completedAt: "2026-08-03T15:10:00.000Z" },
        {
          startedAt: "2026-08-03T16:00:00.000Z",
          completedAt: "2026-08-03T15:00:00.000Z",
        },
        {
          startedAt: "2026-08-04T00:20:00.000Z",
          completedAt: "2026-08-04T00:40:00.000Z",
        },
      ],
    }, observedAt, () => 9 * 60);

    assert.equal(result.currentSession, null);
    assert.equal(result.sameCharacterOtherSession, null);
    assert.deepEqual(result.sameCharacterSharedWork, {
      todayCompletedTurnDurationMs: 0,
      totalCompletedTurnDurationMs: 10 * 60_000,
    });
  });

  it("DST切替をまたぐ履歴は各instantのoffsetで表示し、ローカル日付へ集計する", () => {
    const observedAt = new Date("2026-03-08T16:00:00.000Z");
    const dstTransitionAt = Date.parse("2026-03-08T07:00:00.000Z");
    const result = resolveConversationTimingContext({
      currentSessionLastCompletedAt: "2026-03-08T04:30:00.000Z",
      sameCharacterOtherSessionLastCompletedAt: null,
      sameCharacterCompletedTurns: [
        {
          startedAt: "2026-03-08T04:20:00.000Z",
          completedAt: "2026-03-08T04:30:00.000Z",
        },
      ],
    }, observedAt, (date) => date.getTime() < dstTransitionAt ? -5 * 60 : -4 * 60);

    assert.equal(result.observedAt, "2026-03-08T12:00:00.000-04:00");
    assert.equal(result.observedDayOfWeek, "sunday");
    assert.deepEqual(result.currentSession, {
      lastCompletedAt: "2026-03-07T23:30:00.000-05:00",
      elapsedMs: 11 * 60 * 60_000 + 30 * 60_000,
    });
    assert.deepEqual(result.sameCharacterSharedWork, {
      todayCompletedTurnDurationMs: 0,
      totalCompletedTurnDurationMs: 10 * 60_000,
    });
  });

  it("Character owner不明は共同作業時間を未取得にし、ownerあり履歴なしは0にする", () => {
    const observedAt = new Date("2026-08-04T12:00:00.000Z");
    assert.equal(resolveConversationTimingContext({
      currentSessionLastCompletedAt: null,
      sameCharacterOtherSessionLastCompletedAt: null,
      sameCharacterCompletedTurns: null,
    }, observedAt, () => 9 * 60).sameCharacterSharedWork, null);
    assert.deepEqual(resolveConversationTimingContext({
      currentSessionLastCompletedAt: null,
      sameCharacterOtherSessionLastCompletedAt: null,
      sameCharacterCompletedTurns: [],
    }, observedAt, () => 9 * 60).sameCharacterSharedWork, {
      todayCompletedTurnDurationMs: 0,
      totalCompletedTurnDurationMs: 0,
    });
  });
});
