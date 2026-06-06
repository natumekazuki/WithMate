import assert from "node:assert/strict";
import test from "node:test";
import type { KeyboardEvent } from "react";

import {
  buildComposerDraftKeyDownHandler,
  buildOnDraftCompositionHandlers,
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

test("buildOnDraftCompositionHandlers は start/end handler set を作る", () => {
  const state = createStateMachine();

  const handlers = buildOnDraftCompositionHandlers({
    setComposerCaret: state.setComposerCaret.bind(state),
    setIsComposerImeComposing: state.setIsComposerImeComposing.bind(state),
    getSelectionStart: () => undefined,
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

test("buildComposerDraftKeyDownHandler は workspace path navigation が処理した場合 submit しない", () => {
  const events: string[] = [];
  let activeIndex = 0;
  const event = {
    key: "ArrowDown",
    ctrlKey: false,
    metaKey: false,
    nativeEvent: { isComposing: false },
    preventDefault: () => events.push("prevent"),
  } as KeyboardEvent<HTMLTextAreaElement>;
  const handler = buildComposerDraftKeyDownHandler({
    pathMatches: [
      { path: "src/App.tsx", kind: "file" },
      { path: "src/CompanionReviewApp.tsx", kind: "file" },
    ],
    activeIndex,
    isComposerImeComposing: false,
    onActiveIndexChange: (updater) => {
      activeIndex = typeof updater === "function" ? updater(activeIndex) : updater;
      events.push(`active:${activeIndex}`);
    },
    onWorkspacePathMatchStateChange: () => events.push("match-state"),
    onSelectWorkspacePathMatch: (match) => events.push(`select:${match}`),
    submit: () => events.push("submit"),
  });

  handler(event);

  assert.deepEqual(events, ["prevent", "active:1"]);
});

test("buildComposerDraftKeyDownHandler は workspace path navigation が未処理なら submit へ委譲する", () => {
  const events: string[] = [];
  const event = {
    key: "Enter",
    ctrlKey: true,
    metaKey: false,
    nativeEvent: { isComposing: false },
    preventDefault: () => events.push("prevent"),
  } as KeyboardEvent<HTMLTextAreaElement>;
  const handler = buildComposerDraftKeyDownHandler({
    pathMatches: [],
    activeIndex: 0,
    isComposerImeComposing: false,
    onActiveIndexChange: () => events.push("active"),
    onWorkspacePathMatchStateChange: () => events.push("match-state"),
    onSelectWorkspacePathMatch: (match) => events.push(`select:${match}`),
    submit: (event) => events.push(`submit:${event.key}:${event.ctrlKey}`),
  });

  handler(event);

  assert.deepEqual(events, ["submit:Enter:true"]);
});
