import assert from "node:assert/strict";
import test from "node:test";

import { shouldShowRetiredCompanionAuxiliaryHeaderActions } from "../../src/companion-retirement.js";

test("retired Companionは新規Auxiliary actionを隠し、既存active AuxiliaryのReturnだけを表示する", () => {
  assert.equal(shouldShowRetiredCompanionAuxiliaryHeaderActions({
    hasSnapshot: true,
    hasActiveAuxiliarySession: false,
  }), false);
  assert.equal(shouldShowRetiredCompanionAuxiliaryHeaderActions({
    hasSnapshot: true,
    hasActiveAuxiliarySession: true,
  }), true);
  assert.equal(shouldShowRetiredCompanionAuxiliaryHeaderActions({
    hasSnapshot: false,
    hasActiveAuxiliarySession: true,
  }), false);
});
