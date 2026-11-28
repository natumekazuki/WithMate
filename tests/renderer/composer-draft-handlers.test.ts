import assert from "node:assert/strict";
import test from "node:test";

import {
  applyComposerDraftClearCommand,
  applyComposerDraftChangeCommand,
  buildOnDraftCompositionHandlers,
  buildOnDraftCompositionEndHandler,
  buildOnDraftCompositionStartHandler,
  buildOnDraftSelectHandler,
} from "../../src/chat/composer-draft-handlers.js";

/** 入力欄の状態とMainへの同期、通知の順番を個別に観測できるスタブを作る。 */
const createStateMachine = () => {
  const state = {
    composerCaret: -1,
    draft: "",
    events: [] as string[],
    isComposing: false,
    mainCaret: -1,
  };

  return {
    /** 入力欄自体のキャレット位置を読む。 */
    get composerCaret() {
      return state.composerCaret;
    },
    /** 最後に設定された下書きを読む。 */
    get draft() {
      return state.draft;
    },
    /** 通知解除、本文、位置の変更順を記録した履歴を返す。 */
    get events() {
      return state.events;
    },
    /** 現在のIME変換状態を読む。 */
    get isComposing() {
      return state.isComposing;
    },
    /** Main側に最後に同期されたキャレット位置を読む。 */
    get mainCaret() {
      return state.mainCaret;
    },
    /** 入力欄のキャレットを記録し、Main側とは別の操作として追跡する。 */
    setComposerCaret(value: number) {
      state.composerCaret = value;
      state.events.push(`caret:${value}`);
    },
    /** 下書きを記録し、空文字への更新も履歴に残す。 */
    setDraft(value: string) {
      state.draft = value;
      state.events.push(`draft:${value}`);
    },
    /** IME変換中かどうかを、本文変更の履歴とは別に保存する。 */
    setIsComposerImeComposing(value: boolean) {
      state.isComposing = value;
    },
    /** Main側のキャレットを同期した値と順番を記録する。 */
    setMainComposerCaret(value: number) {
      state.mainCaret = value;
      state.events.push(`main:${value}`);
    },
    /** 変更多重通知ではなく、既存のフィードバックを解除した時点を記録する。 */
    clearFeedback() {
      state.events.push("clear-feedback");
    },
  };
};

/** 入力の変更では、旧フィードバックを先に解除し、本文、入力欄の位置、Main側の位置の順に反映する。 */
test("applyComposerDraftChangeCommand は draft / caret / main caret / feedback を更新する", () => {
  const state = createStateMachine();

  applyComposerDraftChangeCommand({
    value: "hello",
    selectionStart: 3,
    setDraft: state.setDraft.bind(state),
    setComposerCaret: state.setComposerCaret.bind(state),
    syncMainComposerCaret: state.setMainComposerCaret.bind(state),
    clearFeedback: state.clearFeedback.bind(state),
  });

  assert.equal(state.draft, "hello");
  assert.equal(state.composerCaret, 3);
  assert.equal(state.mainCaret, 3);
  assert.deepEqual(state.events, [
    "clear-feedback",
    "draft:hello",
    "caret:3",
    "main:3",
  ]);
});

/** 選択開始位置がない入力変更では、入力欄の末尾をキャレット位置にする。 */
test("applyComposerDraftChangeCommand は selectionStart なしなら draft 末尾を caret にする", () => {
  const state = createStateMachine();

  applyComposerDraftChangeCommand({
    value: "hello",
    setDraft: state.setDraft.bind(state),
    setComposerCaret: state.setComposerCaret.bind(state),
  });

  assert.equal(state.composerCaret, 5);
});

/** 入力欄のキャレット更新がなくても、下書きとMain側の位置は反映する。 */
test("applyComposerDraftChangeCommand は caret setter なしで draft と main mirror だけ反映できる", () => {
  const state = createStateMachine();

  applyComposerDraftChangeCommand({
    value: "$review\n",
    selectionStart: 8,
    setDraft: state.setDraft.bind(state),
    syncMainComposerCaret: state.setMainComposerCaret.bind(state),
  });

  assert.equal(state.draft, "$review\n");
  assert.equal(state.composerCaret, -1);
  assert.equal(state.mainCaret, 8);
  assert.deepEqual(state.events, ["draft:$review\n", "main:8"]);
});

/** 位置の更新を依頼しなければ、本文だけを空にする。 */
test("applyComposerDraftClearCommand は draft だけを空にできる", () => {
  const state = createStateMachine();
  state.setDraft("hello");
  state.events.length = 0;

  applyComposerDraftClearCommand({
    setDraft: state.setDraft.bind(state),
  });

  assert.equal(state.draft, "");
  assert.equal(state.composerCaret, -1);
  assert.deepEqual(state.events, ["draft:"]);
});

/** 位置を明示したクリアでは、入力欄とMain側にも同じ位置を反映する。 */
test("applyComposerDraftClearCommand は caret reset と main mirror 同期を任意で行う", () => {
  const state = createStateMachine();
  state.setDraft("hello");
  state.events.length = 0;

  applyComposerDraftClearCommand({
    setDraft: state.setDraft.bind(state),
    setComposerCaret: state.setComposerCaret.bind(state),
    syncMainComposerCaret: state.setMainComposerCaret.bind(state),
    nextCaret: 0,
  });

  assert.equal(state.draft, "");
  assert.equal(state.composerCaret, 0);
  assert.equal(state.mainCaret, 0);
  assert.deepEqual(state.events, ["draft:", "caret:0", "main:0"]);
});

/** 範囲選択から受け取った位置を入力欄とMain側で共有する。 */
test("buildOnDraftSelectHandler は composer caret と main caret mirror を更新する", () => {
  const state = createStateMachine();

  const handler = buildOnDraftSelectHandler({
    setComposerCaret: state.setComposerCaret.bind(state),
    syncMainComposerCaret: state.setMainComposerCaret.bind(state),
  });

  handler(11);

  assert.equal(state.composerCaret, 11);
  assert.equal(state.mainCaret, 11);
});

/** IME変換の開始で、変換中の状態に切り替える。 */
test("buildOnDraftCompositionStartHandler は composing フラグを true にする", () => {
  const state = createStateMachine();

  const handler = buildOnDraftCompositionStartHandler({
    setIsComposerImeComposing: state.setIsComposerImeComposing.bind(state),
  });

  handler();

  assert.equal(state.isComposing, true);
});

/** IME確定時は取得できた位置を優先し、Main側にも同期する。 */
test("buildOnDraftCompositionEndHandler は main mirror があると caret を同期する", () => {
  const state = createStateMachine();

  const handler = buildOnDraftCompositionEndHandler({
    setComposerCaret: state.setComposerCaret.bind(state),
    setIsComposerImeComposing: state.setIsComposerImeComposing.bind(state),
    /** 確定時に入力欄から実際の選択開始を取得できた状況を作る。 */
    getSelectionStart: () => 5,
    /** 実際の位置を取得できる場合には使ってはいけない代替値を用意する。 */
    getFallbackSelectionStart: () => 20,
    syncMainComposerCaret: state.setMainComposerCaret.bind(state),
  });

  handler();

  assert.equal(state.isComposing, false);
  assert.equal(state.composerCaret, 5);
  assert.equal(state.mainCaret, 5);
});

/** 実際の位置を取得できないIME確定では、入力欄だけに代替位置を反映する。 */
test("buildOnDraftCompositionEndHandler は選択位置が未取得時に fallback を使う", () => {
  const state = createStateMachine();

  const handler = buildOnDraftCompositionEndHandler({
    setComposerCaret: state.setComposerCaret.bind(state),
    setIsComposerImeComposing: state.setIsComposerImeComposing.bind(state),
    /** IME確定時点では入力欄の選択位置を読めないことを表す。 */
    getSelectionStart: () => undefined,
    /** 入力欄の位置が読めない場合に採用する位置を返す。 */
    getFallbackSelectionStart: () => 20,
  });

  handler();

  assert.equal(state.isComposing, false);
  assert.equal(state.composerCaret, 20);
  assert.equal(state.mainCaret, -1);
});

/** IMEの開始と確定を組み合わせ、確定時の代替位置を両方へ反映する。 */
test("buildOnDraftCompositionHandlers は start/end handler set を作る", () => {
  const state = createStateMachine();

  const handlers = buildOnDraftCompositionHandlers({
    setComposerCaret: state.setComposerCaret.bind(state),
    setIsComposerImeComposing: state.setIsComposerImeComposing.bind(state),
    /** 開始と確定の一連の操作でも、確定時の選択位置を未取得にする。 */
    getSelectionStart: () => undefined,
    /** 確定時に入力欄とMain側で一致すべき代替位置を返す。 */
    getFallbackSelectionStart: () => 9,
    syncMainComposerCaret: state.setMainComposerCaret.bind(state),
  });

  handlers.onDraftCompositionStart();
  assert.equal(state.isComposing, true);

  handlers.onDraftCompositionEnd();
  assert.equal(state.isComposing, false);
  assert.equal(state.composerCaret, 9);
  assert.equal(state.mainCaret, 9);
});
