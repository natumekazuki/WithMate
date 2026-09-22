import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BLANK_DRAFT_FEEDBACK,
  buildComposerSendabilityState,
  getComposerSendBlockedMessage,
  getComposerSendButtonTitle,
  resolveComposerSendabilityState,
  resolveComposerSendPreflight,
  resolveTextComposerSubmitPreflight,
  withForcedComposerBlockedFeedback,
} from "../../src/chat/composer/session-composer-feedback.js";

describe("session composer feedback", () => {
  it("blank draft は通常時は disabled だが inline feedback を出さない", () => {
    const state = buildComposerSendabilityState({
      runState: "idle",
      blockedReason: "",
      inputErrors: [],
      draftText: "   ",
    });

    assert.equal(state.isSendDisabled, true);
    assert.equal(state.shouldShowFeedback, false);
    assert.equal(getComposerSendButtonTitle(state), BLANK_DRAFT_FEEDBACK);
  });

  it("forced feedback で blank draft 理由を helper として表示する", () => {
    const state = withForcedComposerBlockedFeedback(
      buildComposerSendabilityState({
        runState: "idle",
        blockedReason: "",
        inputErrors: [],
        draftText: "",
      }),
      true,
    );

    assert.equal(state.shouldShowFeedback, true);
    assert.equal(state.feedbackTone, "helper");
    assert.equal(state.primaryFeedback, BLANK_DRAFT_FEEDBACK);
  });

  it("送信開始時に draft clear と古い forced feedback が交差しても error feedback にしない", () => {
    const beforeSend = resolveComposerSendabilityState({
      runState: "idle",
      blockedReason: "",
      inputErrors: [],
      draftText: "hello",
      forceBlockedFeedback: true,
    });
    const afterDraftClear = resolveComposerSendabilityState({
      runState: "idle",
      blockedReason: "",
      inputErrors: [],
      draftText: "",
      forceBlockedFeedback: true,
    });

    assert.equal(beforeSend.shouldShowFeedback, false);
    assert.equal(afterDraftClear.primaryFeedback, BLANK_DRAFT_FEEDBACK);
    assert.equal(afterDraftClear.feedbackTone, "helper");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "busy状態は送信を抑止しつつvisible helper feedbackへ昇格せず、spinner/status表示へ委ねる"
  // oracle = { type = "contract", ref = "src/chat/composer/session-composer-feedback.ts" }
  // fault = "busy reasonがhelper/error表示またはSend button titleへ再表示され、送信抑止まで失われる"
  // observable = "isSendDisabled、shouldShowFeedback、feedbackTone、primaryFeedback、send button title"
  // observation_boundary = "public-boundary"
  // scope = "composer busy sendability feedback"
  // lifecycle = "permanent"
  // impact = "通常待機文を重複表示せず、busy中の送信抑止とaccessible statusを両立する"
  // distinction = "busy単独ではfeedbackを出さず、実際のinput error併存は別契約で確認する"
  // @end-test-value
  it("submit pending は送信を抑止するが helper feedback と button title を表示しない", () => {
    const pending = buildComposerSendabilityState({
      runState: "idle",
      busyReason: "Message submission is in progress.",
      blockedReason: "",
      inputErrors: [],
      draftText: "hello",
    });

    assert.equal(pending.isSendDisabled, true);
    assert.equal(pending.shouldShowFeedback, false);
    assert.equal(pending.feedbackTone, null);
    assert.equal(pending.primaryFeedback, "");
    assert.equal(getComposerSendButtonTitle(pending), undefined);

    const afterDuplicateSubmit = withForcedComposerBlockedFeedback(pending, true);
    assert.equal(afterDuplicateSubmit.isSendDisabled, true);
    assert.equal(afterDuplicateSubmit.primaryFeedback, "");
    assert.equal(afterDuplicateSubmit.feedbackTone, null);
    assert.equal(afterDuplicateSubmit.shouldShowFeedback, false);
    assert.equal(getComposerSendButtonTitle(afterDuplicateSubmit), undefined);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "busy状態でも実際のinput errorはblocked feedbackと送信抑止を維持する"
  // oracle = { type = "contract", ref = "src/chat/composer/session-composer-feedback.ts" }
  // fault = "busy表示整理で実際のinput errorが消える、またはerrorとbusyの併存時に送信が許可される"
  // observable = "primaryFeedback、feedbackTone、shouldShowFeedback、isSendDisabled、send button title"
  // observation_boundary = "public-boundary"
  // scope = "composer busy and input error feedback"
  // lifecycle = "permanent"
  // impact = "待機表示を抑えながらpath等の実エラーを利用者へ通知する"
  // distinction = "busy単独のspinner/status契約と、busyに実errorを併存させたblocked契約を分離して確認する"
  // @end-test-value
  it("submit pending 中も実際の input error は blocked feedback を維持する", () => {
    const state = buildComposerSendabilityState({
      runState: "idle",
      busyReason: "Message submission is in progress.",
      blockedReason: "",
      inputErrors: ["Path not found: C:/missing"],
      draftText: "hello",
    });

    assert.equal(state.primaryFeedback, "Path not found: C:/missing");
    assert.equal(state.feedbackTone, "blocked");
    assert.equal(state.shouldShowFeedback, true);
    assert.equal(state.isSendDisabled, true);

    const afterForcedSubmit = withForcedComposerBlockedFeedback(state, true);
    assert.equal(afterForcedSubmit.primaryFeedback, "Path not found: C:/missing");
    assert.equal(afterForcedSubmit.feedbackTone, "blocked");
    assert.equal(afterForcedSubmit.shouldShowFeedback, true);
    assert.equal(afterForcedSubmit.isSendDisabled, true);
    assert.equal(getComposerSendButtonTitle(afterForcedSubmit), "Path not found: C:/missing");
  });

  it("既存の blocked reason がある時は forced feedback で上書きしない", () => {
    const state = withForcedComposerBlockedFeedback(
      buildComposerSendabilityState({
        runState: "idle",
        blockedReason: "browse-only session だよ。",
        inputErrors: [],
        draftText: "hello",
      }),
      true,
    );

    assert.equal(state.primaryFeedback, "browse-only session だよ。");
    assert.equal(getComposerSendButtonTitle(state), "browse-only session だよ。");
  });

  it("sendability resolver は forced blocked feedback までまとめて反映する", () => {
    const state = resolveComposerSendabilityState({
      runState: "idle",
      blockedReason: "",
      inputErrors: [],
      draftText: "",
      forceBlockedFeedback: true,
    });

    assert.equal(state.isSendDisabled, true);
    assert.equal(state.primaryFeedback, BLANK_DRAFT_FEEDBACK);
    assert.equal(state.shouldShowFeedback, true);
  });

  it("send blocked message は primary feedback を優先する", () => {
    const state = buildComposerSendabilityState({
      runState: "idle",
      blockedReason: "読み取り専用だよ。",
      inputErrors: [],
      draftText: "hello",
    });

    assert.equal(getComposerSendBlockedMessage(state), "読み取り専用だよ。");
  });

  it("send blocked message は disabled で primary feedback がなければ fallback を返す", () => {
    const state = buildComposerSendabilityState({
      runState: "idle",
      blockedReason: "",
      inputErrors: [],
      draftText: "",
    });

    assert.equal(getComposerSendBlockedMessage(state), "Message cannot be sent.");
  });

  it("send blocked message は送信可能なら null を返す", () => {
    const state = buildComposerSendabilityState({
      runState: "idle",
      blockedReason: "",
      inputErrors: [],
      draftText: "hello",
    });

    assert.equal(getComposerSendBlockedMessage(state), null);
  });

  it("send preflight は sendability と blocked message をまとめて返す", () => {
    const result = resolveComposerSendPreflight({
      runState: "idle",
      blockedReason: "",
      inputErrors: ["path が見つからないよ。"],
      draftText: "hello",
    });

    assert.equal(result.sendability.primaryFeedback, "path が見つからないよ。");
    assert.equal(result.blockedMessage, "path が見つからないよ。");
  });

  it("send preflight は送信可能なら blocked message を返さない", () => {
    const result = resolveComposerSendPreflight({
      runState: "idle",
      blockedReason: "",
      inputErrors: [],
      draftText: "hello",
    });

    assert.equal(result.sendability.isSendDisabled, false);
    assert.equal(result.blockedMessage, null);
  });

  it("send preflight は primary feedback がなければ指定 fallback を返す", () => {
    const result = resolveComposerSendPreflight({
      runState: "idle",
      blockedReason: "",
      inputErrors: [],
      draftText: "",
      fallbackBlockedMessage: "送信条件を確認してください。",
    });

    assert.equal(result.blockedMessage, "送信条件を確認してください。");
  });

  it("text composer submit preflight は空入力を指定 feedback 付き blocked にする", () => {
    assert.deepEqual(
      resolveTextComposerSubmitPreflight({
        draftText: " \n ",
        isRunning: false,
        emptyFeedback: "入力してから送信してね。",
      }),
      {
        status: "blocked",
        reason: "empty",
        feedback: "入力してから送信してね。",
      },
    );
  });

  it("text composer submit preflight は running 中なら blocked にする", () => {
    assert.deepEqual(
      resolveTextComposerSubmitPreflight({
        draftText: " hello ",
        isRunning: true,
      }),
      {
        status: "blocked",
        reason: "running",
      },
    );
  });

  it("text composer submit preflight は送信可能な本文を trim して返す", () => {
    assert.deepEqual(
      resolveTextComposerSubmitPreflight({
        draftText: " hello ",
        isRunning: false,
      }),
      {
        status: "ready",
        message: "hello",
      },
    );
  });
});
