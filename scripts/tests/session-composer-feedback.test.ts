import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BLANK_DRAFT_FEEDBACK,
  buildComposerSendabilityState,
  getComposerSendBlockedMessage,
  getComposerSendButtonTitle,
  withForcedComposerBlockedFeedback,
} from "../../src/session-composer-feedback.js";

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

  it("forced blocked feedback で blank draft 理由を表示する", () => {
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
    assert.equal(state.feedbackTone, "blocked");
    assert.equal(state.primaryFeedback, BLANK_DRAFT_FEEDBACK);
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

    assert.equal(getComposerSendBlockedMessage(state), "送信できない状態だよ。");
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
});
