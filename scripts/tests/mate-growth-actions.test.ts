import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyHomePendingGrowth,
  handleApplyPendingGrowth,
  handleCorrectMateGrowthEvent,
  handleDisableMateGrowthEvent,
  handleForgetMateGrowthEvent,
  handleReloadMateGrowthEvents,
  handleUpdateMateGrowthSettings,
  type HomeMateGrowthApi,
  upsertMateGrowthEventListItem,
} from "../../src/mate/mate-growth-actions.js";
import type { MateGrowthEventListItem } from "../../src/mate/mate-growth-events-state.js";
import { type MateGrowthSettings, type UpdateMateGrowthSettingsInput } from "../../src/mate/mate-state.js";

function createEvent(overrides: Partial<MateGrowthEventListItem> = {}): MateGrowthEventListItem {
  return {
    id: "event-1",
    sourceType: "chat",
    sourceSessionId: null,
    growthSourceType: "chat",
    kind: "summary",
    targetSection: "core",
    statement: "base",
    rationalePreview: "rationale",
    confidence: 0.5,
    salienceScore: 0.5,
    recurrenceCount: 1,
    projectionAllowed: true,
    state: "candidate",
    appliedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createSettings(overrides: Partial<MateGrowthSettings> = {}): MateGrowthSettings {
  return {
    enabled: true,
    autoApplyEnabled: true,
    memoryCandidateMode: "manual",
    applyIntervalMinutes: 60,
    modelPreferences: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createApi(overrides: Partial<HomeMateGrowthApi> = {}): HomeMateGrowthApi {
  return {
    applyPendingGrowth: async () => ({
      candidateCount: 1,
      appliedCount: 1,
      skippedCount: 0,
      revisionId: null,
    }),
    listMateGrowthEvents: async () => ({ events: [], limit: 20 }),
    correctMateGrowthEvent: async () => ({ event: null }),
    disableMateGrowthEvent: async () => ({ event: null }),
    forgetMateGrowthEvent: async () => ({ event: null }),
    updateMateGrowthSettings: async () => createSettings(),
    resetMate: async () => {},
    ...overrides,
  };
}

describe("mate-growth-actions", () => {
  it("handleApplyPendingGrowth: Mate 未アクティブ時は guard feedback を返す", async () => {
    const feedback: string[] = [];

    await handleApplyPendingGrowth({
      api: createApi(),
      mateGrowthApplying: false,
      mateState: "not_created",
      setMateGrowthApplying: () => {
        assert.fail("setMateGrowthApplying should not be called");
      },
      setSettingsFeedback: (message) => feedback.push(message),
      refreshMateStatus: async () => "not_created",
      refreshMateGrowthEvents: async () => {
        assert.fail("refreshMateGrowthEvents should not be called");
      },
    });

    assert.deepEqual(feedback, ["Mate がアクティブなときのみ手動適用できるよ。"]);
  });

  it("handleApplyPendingGrowth: 成功時に applying トグルと feedback、更新を実行する", async () => {
    const feedback: string[] = [];
    const applying: boolean[] = [];
    let refreshedStatus = false;
    let refreshedEvents = false;

    const withmateApi = createApi({
      applyPendingGrowth: async () => ({
        candidateCount: 3,
        appliedCount: 2,
        skippedCount: 1,
        revisionId: "rev-007",
      }),
    });

    await handleApplyPendingGrowth({
      api: withmateApi,
      mateGrowthApplying: false,
      mateState: "active",
      setMateGrowthApplying: (value) => applying.push(value),
      setSettingsFeedback: (message) => feedback.push(message),
      refreshMateStatus: async () => {
        refreshedStatus = true;
        return "active";
      },
      refreshMateGrowthEvents: async () => {
        refreshedEvents = true;
      },
    });

    assert.deepEqual(applying, [true, false]);
    assert.equal(refreshedStatus, true);
    assert.equal(refreshedEvents, true);
    assert.deepEqual(feedback, [
      "Mate 成長を適用中...",
      "Mate 成長を手動適用したよ（候補 3 件 / 適用 2 件 / スキップ 1 件 / revisionId rev-007）。",
    ]);
  });

  it("upsertMateGrowthEventListItem: event があれば置換し、無ければ先頭に追加する", () => {
    const current = [createEvent({ id: "event-1", statement: "old" })];
    const replaced = upsertMateGrowthEventListItem(current, createEvent({ id: "event-1", statement: "new" }));
    const inserted = upsertMateGrowthEventListItem(current, createEvent({ id: "event-2", statement: "next" }));

    assert.equal(replaced[0].statement, "new");
    assert.equal(replaced.length, 1);
    assert.equal(inserted[0].id, "event-2");
    assert.equal(inserted[1].id, "event-1");
  });

  it("handleCorrectMateGrowthEvent: result event と createdEvent を upsert し busy target を解放する", async () => {
    const feedback: string[] = [];
    const busyTarget: Array<string | null> = [];
    let eventList: MateGrowthEventListItem[] = [createEvent({ id: "event-1" })];
    let cancelCalled = false;

    await handleCorrectMateGrowthEvent({
      eventId: "event-1",
      statement: "updated",
      api: createApi({
        correctMateGrowthEvent: async () => ({
          event: createEvent({ id: "event-1", statement: "updated" }),
          createdEvent: createEvent({ id: "event-2", statement: "created" }),
        }),
      }),
      setMateGrowthEventsFeedback: (message) => feedback.push(message),
      upsertMateGrowthEventListItem: (nextEvent) => {
        eventList = upsertMateGrowthEventListItem(eventList, nextEvent);
      },
      setMateGrowthEventBusyTarget: (target) => busyTarget.push(target),
      mateState: "active",
      mateGrowthEventBusyTarget: null,
      setCancelCorrectMateGrowthEvent: () => {
        cancelCalled = true;
      },
      runCorrectAction: async (api) => api.correctMateGrowthEvent({
        eventId: "event-1",
        statement: "updated",
      }),
    });

    assert.equal(eventList[0].id, "event-2");
    assert.equal(eventList[1].statement, "updated");
    assert.deepEqual(feedback, ["", "Growth Event を修正したよ。"]);
    assert.deepEqual(busyTarget, ["event-1", null]);
    assert.equal(cancelCalled, true);
  });

  it("handleDisableMateGrowthEvent: disable result を upsert し busy target を解放する", async () => {
    const feedback: string[] = [];
    const busyTarget: Array<string | null> = [];
    const events: MateGrowthEventListItem[] = [];

    await handleDisableMateGrowthEvent({
      eventId: "event-1",
      api: createApi({
        disableMateGrowthEvent: async () => ({
          event: createEvent({ id: "event-1", state: "disabled" }),
        }),
      }),
      setMateGrowthEventsFeedback: (message) => feedback.push(message),
      upsertMateGrowthEventListItem: (nextEvent) => {
        if (nextEvent) {
          events.push(nextEvent);
        }
      },
      setMateGrowthEventBusyTarget: (target) => busyTarget.push(target),
      mateState: "active",
      mateGrowthEventBusyTarget: null,
      runDisableAction: async (api) => api.disableMateGrowthEvent({ eventId: "event-1" }),
    });

    assert.deepEqual(busyTarget, ["event-1", null]);
    assert.equal(events[0]?.state, "disabled");
    assert.deepEqual(feedback, ["", "Growth Event を無効化したよ。"]);
  });

  it("handleForgetMateGrowthEvent: forget result を upsert し busy target を解放する", async () => {
    const feedback: string[] = [];
    const busyTarget: Array<string | null> = [];
    const events: MateGrowthEventListItem[] = [];

    await handleForgetMateGrowthEvent({
      eventId: "event-1",
      api: createApi({
        forgetMateGrowthEvent: async () => ({
          event: createEvent({ id: "event-1", state: "forgotten" }),
        }),
      }),
      setMateGrowthEventsFeedback: (message) => feedback.push(message),
      upsertMateGrowthEventListItem: (nextEvent) => {
        if (nextEvent) {
          events.push(nextEvent);
        }
      },
      setMateGrowthEventBusyTarget: (target) => busyTarget.push(target),
      mateState: "active",
      mateGrowthEventBusyTarget: null,
      runForgetAction: async (api) => api.forgetMateGrowthEvent({ eventId: "event-1" }),
    });

    assert.deepEqual(busyTarget, ["event-1", null]);
    assert.equal(events[0]?.state, "forgotten");
    assert.deepEqual(feedback, ["", "Growth Event を忘却済みにしたよ。"]);
  });

  it("handleUpdateMateGrowthSettings: 成功時と失敗時の feedback を返す", async () => {
    const successFeedback: string[] = [];
    const loading: boolean[] = [];
    const successPayload: MateGrowthSettings[] = [];

    await handleUpdateMateGrowthSettings({
      api: createApi({
        updateMateGrowthSettings: async (input: UpdateMateGrowthSettingsInput) => createSettings({
          enabled: input.enabled ?? true,
          updatedAt: "2026-01-01T12:00:00.000Z",
        }),
      }),
      input: { enabled: false },
      mateGrowthBusy: false,
      mateState: "active",
      setMateGrowthBusy: (value) => loading.push(value),
      setMateGrowthFeedback: (message) => successFeedback.push(message),
      setMateGrowthSettings: (settings) => {
        if (settings) {
          successPayload.push(settings);
        }
      },
    });

    assert.deepEqual(loading, [true, false]);
    assert.equal(successPayload[0].enabled, false);
    assert.deepEqual(successFeedback, ["", "Mate Growth 設定を更新したよ。"]);

    const errorFeedback: string[] = [];
    await handleUpdateMateGrowthSettings({
      api: createApi({
        updateMateGrowthSettings: async () => {
          throw new Error("update failed");
        },
      }),
      input: {},
      mateGrowthBusy: false,
      mateState: "active",
      setMateGrowthBusy: () => {},
      setMateGrowthFeedback: (message) => errorFeedback.push(message),
      setMateGrowthSettings: () => {
        assert.fail("setMateGrowthSettings should not be called");
      },
    });

    assert.deepEqual(errorFeedback, ["", "update failed"]);
  });

  it("handleReloadMateGrowthEvents: 非 active 状態は guard feedback を返す", async () => {
    const feedback: string[] = [];

    await handleReloadMateGrowthEvents({
      api: createApi(),
      mateState: "not_created",
      setMateGrowthEventsFeedback: (message) => feedback.push(message),
      refreshMateGrowthEvents: async () => {
        assert.fail("refreshMateGrowthEvents should not be called");
      },
    });

    assert.deepEqual(feedback, ["Mate 作成後に確認してね。"]);
  });
});

describe("mate-growth-actions (pure)", () => {
  it("applyHomePendingGrowth は API 失敗を伝播する", async () => {
    const api = createApi({
      applyPendingGrowth: async () => {
        throw new Error("apply failed");
      },
    });

    await assert.rejects(
      () => applyHomePendingGrowth(api),
      (error) => error instanceof Error && error.message === "apply failed",
    );
  });
});
