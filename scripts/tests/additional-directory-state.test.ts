import assert from "node:assert/strict";
import test from "node:test";

import {
  addAllowedAdditionalDirectory,
  buildSessionWithAddedAdditionalDirectory,
  buildSessionWithRemovedAdditionalDirectory,
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
  assert.deepEqual(
    addAllowedAdditionalDirectory(["C:/Workspace/A/"], "c:\\workspace\\a"),
    ["C:/Workspace/A"],
  );
  assert.deepEqual(
    addAllowedAdditionalDirectory(["C:/"], "C:\\"),
    ["C:/"],
  );
  assert.deepEqual(
    addAllowedAdditionalDirectory(["//Server/Share"], "//server/share"),
    ["//Server/Share"],
  );
  assert.deepEqual(
    addAllowedAdditionalDirectory(["/tmp/Test"], "/tmp/test"),
    ["/tmp/Test", "/tmp/test"],
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
  assert.deepEqual(
    removeAllowedAdditionalDirectory(
      ["C:/Workspace/A/", "D:/assets"],
      "c:\\workspace\\a",
    ),
    ["D:/assets"],
  );
  assert.deepEqual(
    removeAllowedAdditionalDirectory(["/tmp/Test", "/tmp/test"], "/tmp/test"),
    ["/tmp/Test"],
  );
  assert.deepEqual(
    removeAllowedAdditionalDirectory(["C:/", "D:/assets"], "C:\\"),
    ["D:/assets"],
  );
  assert.deepEqual(
    removeAllowedAdditionalDirectory(["//Server/Share", "/tmp/test"], "//SERVER/share"),
    ["/tmp/test"],
  );
});

test("buildSessionWithAddedAdditionalDirectory は session shape を保って directory を追加する", () => {
  const session = {
    id: "session-1",
    allowedAdditionalDirectories: ["C:/workspace/a"],
    title: "Session",
  };

  assert.deepEqual(
    buildSessionWithAddedAdditionalDirectory(session, "C:\\workspace\\b"),
    {
      id: "session-1",
      allowedAdditionalDirectories: ["C:/workspace/a", "C:/workspace/b"],
      title: "Session",
    },
  );
});

test("buildSessionWithRemovedAdditionalDirectory は削除できる場合だけ session patch を返す", () => {
  const session = {
    id: "session-1",
    allowedAdditionalDirectories: ["C:/workspace/a", "D:/assets"],
    title: "Session",
  };

  assert.deepEqual(
    buildSessionWithRemovedAdditionalDirectory(session, "c:\\workspace\\a"),
    {
      id: "session-1",
      allowedAdditionalDirectories: ["D:/assets"],
      title: "Session",
    },
  );
  assert.equal(buildSessionWithRemovedAdditionalDirectory(session, "C:/missing"), null);
});
