import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  restoreComposerTextareaFocusAndCaret,
  restoreCurrentComposerTextareaFocusToEnd,
} from "../../src/composer-textarea-focus.js";

describe("restoreComposerTextareaFocusAndCaret", () => {
  it("指定した textarea に scheduler 経由でフォーカスと caret を戻す", () => {
    const calls: (() => void)[] = [];
    let didFocus = false;
    let nextRange: [number, number] | null = null;
    const textarea = {
      focus() {
        didFocus = true;
      },
      setSelectionRange(start: number, end: number) {
        nextRange = [start, end];
      },
    } as unknown as HTMLTextAreaElement;

    restoreComposerTextareaFocusAndCaret(textarea, 13, (callback) => {
      calls.push(callback);
    });

    assert.equal(calls.length, 1);
    calls.shift()();

    assert.equal(didFocus, true);
    assert.deepEqual(nextRange, [13, 13]);
  });

  it("textarea が null の場合は例外にせず noop", () => {
    let calledScheduler = false;
    restoreComposerTextareaFocusAndCaret(
      null,
      5,
      (callback) => {
        calledScheduler = true;
        callback();
      },
    );
    assert.equal(calledScheduler, true);
  });

  it("現在の textarea と末尾 caret は scheduler 実行時に読む", () => {
    const calls: (() => void)[] = [];
    let didFocus = false;
    let nextRange: [number, number] | null = null;
    let textarea: HTMLTextAreaElement | null = null;

    restoreCurrentComposerTextareaFocusToEnd(
      () => textarea,
      (callback) => {
        calls.push(callback);
      },
    );

    textarea = {
      value: "updated draft",
      focus() {
        didFocus = true;
      },
      setSelectionRange(start: number, end: number) {
        nextRange = [start, end];
      },
    } as unknown as HTMLTextAreaElement;

    assert.equal(calls.length, 1);
    calls.shift()();

    assert.equal(didFocus, true);
    assert.deepEqual(nextRange, [13, 13]);
  });
});
