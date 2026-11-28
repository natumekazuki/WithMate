import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  restoreComposerTextareaFocusAndCaret,
  restoreCurrentComposerTextareaFocusToEnd,
} from "../../src/chat/composer/composer-textarea-focus.js";

/** Composer の再フォーカスを予約し、指定位置または最新 draft の末尾に caret を戻す契約。 */
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
  /** 予約したコールバックを実行すると、対象にフォーカスし指定位置へ選択範囲を畳むことを確認する。 */
  it("指定した textarea に scheduler 経由でフォーカスと caret を戻す", () => {
    const calls: (() => void)[] = [];
    let didFocus = false;
    let nextRange: [number, number] | null = null;
    const textarea = {
      /** 予約後に対象へのフォーカスが行われたことを記録する。 */
      focus() {
        didFocus = true;
      },
      /** 明示した位置で選択範囲が畳まれたか照合できるよう両端を記録する。 */
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

  /** textarea がなくても予約は行われ、予約した処理を実行しても例外にならないことを確認する。 */
  it("textarea が null の場合は例外にせず noop", () => {
    let calledScheduler = false;
    restoreComposerTextareaFocusAndCaret(null, 5, (callback) => {
      calledScheduler = true;
      callback();
    });
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
  /** 予約後に用意された textarea がフォーカスされ、最新 draft の末尾を選ぶことを確認する。 */
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
      /** 遅れて設定した textarea へのフォーカスを記録する。 */
      focus() {
        didFocus = true;
      },
      /** 最新 draft の長さに対応する選択範囲を記録する。 */
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
