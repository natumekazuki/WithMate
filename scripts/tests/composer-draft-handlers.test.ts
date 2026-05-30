import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOnDraftCompositionEndHandler,
  buildOnDraftCompositionStartHandler,
  buildOnDraftSelectHandler,
} from "../../src/chat/composer-draft-handlers.js";

const createStateMachine = () => {
  const state = {
    composerCaret: -1,
    isComposing: false,
    mainCaret: -1,
  };

  return {
    get composerCaret() {
      return state.composerCaret;
    },
    get isComposing() {
      return state.isComposing;
    },
    get mainCaret() {
      return state.mainCaret;
    },
    setComposerCaret(value: number) {
      state.composerCaret = value;
    },
    setIsComposerImeComposing(value: boolean) {
      state.isComposing = value;
    },
    setMainComposerCaret(value: number) {
      state.mainCaret = value;
    },
  };
};

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

test("buildOnDraftCompositionStartHandler は composing フラグを true にする", () => {
  const state = createStateMachine();

  const handler = buildOnDraftCompositionStartHandler({
    setIsComposerImeComposing: state.setIsComposerImeComposing.bind(state),
  });

  handler();

  assert.equal(state.isComposing, true);
});

test("buildOnDraftCompositionEndHandler は main mirror があると caret を同期する", () => {
  const state = createStateMachine();

  const handler = buildOnDraftCompositionEndHandler({
    setComposerCaret: state.setComposerCaret.bind(state),
    setIsComposerImeComposing: state.setIsComposerImeComposing.bind(state),
    getSelectionStart: () => 5,
    getFallbackSelectionStart: () => 20,
    syncMainComposerCaret: state.setMainComposerCaret.bind(state),
  });

  handler();

  assert.equal(state.isComposing, false);
  assert.equal(state.composerCaret, 5);
  assert.equal(state.mainCaret, 5);
});

test("buildOnDraftCompositionEndHandler は選択位置が未取得時に fallback を使う", () => {
  const state = createStateMachine();

  const handler = buildOnDraftCompositionEndHandler({
    setComposerCaret: state.setComposerCaret.bind(state),
    setIsComposerImeComposing: state.setIsComposerImeComposing.bind(state),
    getSelectionStart: () => undefined,
    getFallbackSelectionStart: () => 20,
  });

  handler();

  assert.equal(state.isComposing, false);
  assert.equal(state.composerCaret, 20);
  assert.equal(state.mainCaret, -1);
});
