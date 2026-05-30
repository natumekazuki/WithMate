import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActionDockCollapseState,
  buildActionDockExpandState,
  buildActionDockRuntimeState,
} from "../../src/action-dock-state.js";

test("buildActionDockRuntimeState は pinned と force reasons から表示 state を解決する", () => {
  assert.deepEqual(buildActionDockRuntimeState({
    isActionDockPinnedExpanded: false,
    forceReasons: [false, false],
  }), {
    shouldForceActionDockExpanded: false,
    isActionDockExpanded: false,
    canCollapseActionDock: true,
  });
  assert.deepEqual(buildActionDockRuntimeState({
    isActionDockPinnedExpanded: true,
    forceReasons: [false, false],
  }), {
    shouldForceActionDockExpanded: false,
    isActionDockExpanded: true,
    canCollapseActionDock: true,
  });
  assert.deepEqual(buildActionDockRuntimeState({
    isActionDockPinnedExpanded: false,
    forceReasons: [false, true],
  }), {
    shouldForceActionDockExpanded: true,
    isActionDockExpanded: true,
    canCollapseActionDock: false,
  });
});

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
