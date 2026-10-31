import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  restoreComposerTextareaFocusAndCaret,
  restoreCurrentComposerTextareaFocusToEnd,
} from "../../src/chat/composer/composer-textarea-focus.js";

describe("restoreComposerTextareaFocusAndCaret", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "指定textareaへのfocusとcaret復元はscheduler callback実行時に行われる"
  // oracle = { type = "contract", ref = "composer textarea focus restoration" }
  // fault = "scheduler登録前にDOMを操作するかcaret位置が失われる"
  // observable = "queued callback and focus/selection calls"
  // observation_boundary = "public-boundary"
  // scope = "composer-textarea-focus-caret"
  // lifecycle = "permanent"
  // @end-test-value
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
    const callback = calls.shift();
    assert.ok(callback);
    callback();

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

  // @test-value v2
  // kind = "invariant"
  // claim = "現在textareaと最新draft長はscheduler実行時に解決される"
  // oracle = { type = "contract", ref = "composer textarea focus restoration" }
  // fault = "古いtextareaまたは古いdraft長へfocus/caretを戻す"
  // observable = "focus target and end selection after deferred callback"
  // observation_boundary = "public-boundary"
  // scope = "composer-current-textarea-caret"
  // lifecycle = "permanent"
  // @end-test-value
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
    const callback = calls.shift();
    assert.ok(callback);
    callback();

    assert.equal(didFocus, true);
    assert.deepEqual(nextRange, [13, 13]);
  });
});
