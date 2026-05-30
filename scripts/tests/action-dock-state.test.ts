import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActionDockCollapseState,
  buildActionDockExpandState,
} from "../../src/action-dock-state.js";

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
  assert.deepEqual(buildActionDockExpandState({ focusComposer: 1 as unknown as boolean }), {
    isActionDockPinnedExpanded: true,
    shouldFocusComposer: true,
  });
});

test("buildActionDockCollapseState は collapse 可能なときだけ pinned expanded を解除する", () => {
  assert.deepEqual(buildActionDockCollapseState(true), {
    isActionDockPinnedExpanded: false,
  });
  assert.equal(buildActionDockCollapseState(false), null);
});
