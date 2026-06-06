import assert from "node:assert/strict";
import test from "node:test";

import {
  addAllowedAdditionalDirectory,
  removeAllowedAdditionalDirectory,
} from "../../src/additional-directory-state.js";

test("addAllowedAdditionalDirectory は directory を正規化して末尾へ追加し重複を避ける", () => {
  assert.deepEqual(
    addAllowedAdditionalDirectory(["C:/workspace/a"], "C:/workspace/b"),
    ["C:/workspace/a", "C:/workspace/b"],
  );
  assert.deepEqual(
    addAllowedAdditionalDirectory(["C:/workspace/a"], "C:/workspace/a"),
    ["C:/workspace/a"],
  );
  assert.deepEqual(
    addAllowedAdditionalDirectory(["C:/workspace/a"], "C:\\workspace\\a"),
    ["C:/workspace/a"],
  );
  assert.deepEqual(
    addAllowedAdditionalDirectory(["C:/workspace/a"], "D:\\assets"),
    ["C:/workspace/a", "D:/assets"],
  );
});

test("addAllowedAdditionalDirectory は nullish input を空配列として扱う", () => {
  assert.deepEqual(addAllowedAdditionalDirectory(null, "C:/workspace/a"), ["C:/workspace/a"]);
  assert.deepEqual(addAllowedAdditionalDirectory(undefined, "C:/workspace/a"), ["C:/workspace/a"]);
});

test("removeAllowedAdditionalDirectory は directory を正規化して一致する directory だけを除く", () => {
  assert.deepEqual(
    removeAllowedAdditionalDirectory(
      ["C:/workspace/a", "C:/workspace/b", "C:/workspace/a"],
      "C:/workspace/a",
    ),
    ["C:/workspace/b"],
  );
  assert.deepEqual(
    removeAllowedAdditionalDirectory(["C:/workspace/a"], "C:/workspace/missing"),
    ["C:/workspace/a"],
  );
  assert.deepEqual(
    removeAllowedAdditionalDirectory(
      ["C:\\workspace\\a", "D:/assets"],
      "C:/workspace/a",
    ),
    ["D:/assets"],
  );
});
