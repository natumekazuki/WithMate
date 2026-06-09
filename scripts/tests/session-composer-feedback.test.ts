import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BLANK_DRAFT_FEEDBACK,
  buildComposerSendabilityState,
  getComposerSendBlockedMessage,
  getComposerSendButtonTitle,
  resolveComposerSendPreflight,
  resolveTextComposerSubmitPreflight,
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
