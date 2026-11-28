import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActionDockCollapseState,
  buildActionDockExpandState,
  buildActionDockRuntimeState,
  shouldFocusComposerForActionDockExpand,
} from "../../src/chat/approval/action-dock-state.js";

/** 通常はピン留めで展開を決め、強制理由が一つでもあればピン留めなしでも展開して閉じられない状態にする。 */
test("buildActionDockRuntimeState は pinned と force reasons から表示 state を解決する", () => {
  assert.deepEqual(
    buildActionDockRuntimeState({
      isActionDockPinnedExpanded: false,
      forceReasons: [false, false],
    }),
    {
      shouldForceActionDockExpanded: false,
      isActionDockExpanded: false,
      canCollapseActionDock: true,
    },
  );
  assert.deepEqual(
    buildActionDockRuntimeState({
      isActionDockPinnedExpanded: true,
      forceReasons: [false, false],
    }),
    {
      shouldForceActionDockExpanded: false,
      isActionDockExpanded: true,
      canCollapseActionDock: true,
    },
  );
  assert.deepEqual(
    buildActionDockRuntimeState({
      isActionDockPinnedExpanded: false,
      forceReasons: [false, true],
    }),
    {
      shouldForceActionDockExpanded: true,
      isActionDockExpanded: true,
      canCollapseActionDock: false,
    },
  );
});

/** 展開を要求するとピン留めを有効にするが、入力欄のフォーカスは要求されたときだけ有効になる。 */
test("buildActionDockExpandState は pinned expanded と composer focus 要否を返す", () => {
  assert.deepEqual(buildActionDockExpandState(), {
    isActionDockPinnedExpanded: true,
    shouldFocusComposer: false,
  });
  assert.deepEqual(buildActionDockExpandState({ focusComposer: false }), {
    isActionDockPinnedExpanded: true,
    shouldFocusComposer: false,
  });
  assert.deepEqual(buildActionDockExpandState({ focusComposer: true }), {
    isActionDockPinnedExpanded: true,
    shouldFocusComposer: true,
  });
  assert.deepEqual(
    buildActionDockExpandState({ focusComposer: 1 as unknown as boolean }),
    {
      isActionDockPinnedExpanded: true,
      shouldFocusComposer: true,
    },
  );
});

/** 展開で Composer にフォーカスするのは、Turn が実行中でないときに限る。 */
test("shouldFocusComposerForActionDockExpand は running 中だけ focus を抑止する", () => {
  assert.equal(
    shouldFocusComposerForActionDockExpand({ isRunning: false }),
    true,
  );
  assert.equal(
    shouldFocusComposerForActionDockExpand({ isRunning: true }),
    false,
  );
});

/** 折りたためる場合だけ展開のピン留めを解除し、強制展開時は状態を変更しない。 */
test("buildActionDockCollapseState は collapse 可能なときだけ pinned expanded を解除する", () => {
  assert.deepEqual(buildActionDockCollapseState(true), {
    isActionDockPinnedExpanded: false,
  });
  assert.equal(buildActionDockCollapseState(false), null);
});
