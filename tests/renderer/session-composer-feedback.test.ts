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

/** Composer の送信可否、抑止理由の表示、送信直前の事前判定を検査する。 */
describe("session composer feedback", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "実行中でもqueue受付可能なら現在turnのinput能力に依存せず送信でき、blank・busy・実エラーは送信を止める"
  // oracle = { type = "contract", ref = "Issue #801: Main/Auxiliary共通のSendは実行中にdurable queueへ受付する" }
  // fault = "queue送信をcurrent-turn input能力で抑止する、またはqueue時に入力検証やbusy guardを省略する"
  // observable = "resolverのisSendDisabled、primaryFeedback、send button title"
  // observation_boundary = "public-boundary"
  // scope = "running composer queue sendability"
  // lifecycle = "permanent"
  // impact = "実行中の次turn受付と不正・重複送信防止を維持する"
  // distinction = "既存idle/busy testではrunning中のqueue能力とcurrent-turn input能力の独立性を検出できない"
  // @end-test-value
  /** 現実行への入力権限がなくても次ターンをキューに登録できる一方、空入力、送信待機、読み取り専用、入力エラーでは送信を止める。 */
  it("queue可能なrunning送信はinput能力不要で、通常の送信guardとfeedbackを使う", () => {
    const options = {
      runState: "running",
      canSendInput: false,
      canQueueTurn: true,
      blockedReason: "",
      inputErrors: [],
      draftText: "next turn",
      forceBlockedFeedback: true,
    };
    const ready = resolveComposerSendabilityState(options);
    assert.equal(ready.isSendDisabled, false);
    assert.equal(
      getComposerSendButtonTitle(ready),
      "Save this input for the next turn",
    );

    const blank = resolveComposerSendabilityState({
      ...options,
      draftText: " \n ",
    });
    assert.equal(blank.isSendDisabled, true);
    assert.equal(blank.primaryFeedback, BLANK_DRAFT_FEEDBACK);
    for (const guard of [
      { busyReason: "Message submission is in progress." },
      { blockedReason: "Read-only session." },
      { inputErrors: ["Path not found."] },
    ]) {
      assert.equal(
        resolveComposerSendabilityState({ ...options, ...guard })
          .isSendDisabled,
        true,
      );
    }
    const invalid = resolveComposerSendabilityState({
      ...options,
      inputErrors: ["Path not found."],
    });
    assert.equal(invalid.primaryFeedback, "Path not found.");
    assert.equal(invalid.shouldShowFeedback, true);
    assert.equal(
      resolveComposerSendabilityState({ ...options, canQueueTurn: false })
        .isSendDisabled,
      true,
    );
  });

  /** 空白だけでは送信できないが、通常入力時は理由をボタンの説明だけに置き、インライン通知を出さない。 */
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

  /** 空入力を理由として強制表示するときは、エラーではなく補助説明として出す。 */
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

  /** 送信開始による下書きクリア後に古い強制表示が残っていても、空入力をエラー扱いしない。 */
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
  /** 送信処理中の連打を止めつつ、待機理由を補助説明やボタンタイトルに重複して出さない。 */
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

    const afterDuplicateSubmit = withForcedComposerBlockedFeedback(
      pending,
      true,
    );
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
  /** 処理待機とパス入力エラーが併存しても、エラーを本文とタイトルに残し、送信を止める。 */
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
    assert.equal(
      afterForcedSubmit.primaryFeedback,
      "Path not found: C:/missing",
    );
    assert.equal(afterForcedSubmit.feedbackTone, "blocked");
    assert.equal(afterForcedSubmit.shouldShowFeedback, true);
    assert.equal(afterForcedSubmit.isSendDisabled, true);
    assert.equal(
      getComposerSendButtonTitle(afterForcedSubmit),
      "Path not found: C:/missing",
    );
  });

  /** 読み取り専用で送れない理由がある場合、強制表示を求められても具体的な理由を置き換えない。 */
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
    assert.equal(
      getComposerSendButtonTitle(state),
      "browse-only session だよ。",
    );
  });

  /** 送信可否と強制表示をまとめて解決し、空入力の補助説明を可視状態にする。 */
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

  /** 抑止理由として意味のあるフィードバックがあれば、事前確認が返すメッセージにそれを使う。 */
  it("send blocked message は primary feedback を優先する", () => {
    const state = buildComposerSendabilityState({
      runState: "idle",
      blockedReason: "読み取り専用だよ。",
      inputErrors: [],
      draftText: "hello",
    });

    assert.equal(getComposerSendBlockedMessage(state), "読み取り専用だよ。");
  });

  /** 送信不可で表示用理由が空の場合に、汎用の抑止メッセージを返す。 */
  it("send blocked message は disabled で primary feedback がなければ fallback を返す", () => {
    const state = buildComposerSendabilityState({
      runState: "idle",
      blockedReason: "",
      inputErrors: [],
      draftText: "",
    });

    assert.equal(
      getComposerSendBlockedMessage(state),
      "Message cannot be sent.",
    );
  });

  /** 送信可能な入力には、抑止メッセージを作らない。 */
  it("send blocked message は送信可能なら null を返す", () => {
    const state = buildComposerSendabilityState({
      runState: "idle",
      blockedReason: "",
      inputErrors: [],
      draftText: "hello",
    });

    assert.equal(getComposerSendBlockedMessage(state), null);
  });

  /** 入力エラーを事前判定のフィードバックと抑止メッセージの双方に反映する。 */
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

  /** 入力が有効な事前判定では送信を許し、抑止メッセージは null にする。 */
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

  /** 個別の説明がない送信不可判定に、呼び出し側が指定した代替文言を使う。 */
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

  /** テキスト専用の事前判定では、空白を除いて本文がなければ empty と呼び出し元指定の案内を返す。 */
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

  /** 実行中は本文が空でなくても、テキスト専用の事前判定が running を理由に拒む。 */
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

  /** 実行待機中でない有効入力は、前後の空白を除いた本文を送信可能として返す。 */
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
