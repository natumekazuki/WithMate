import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManagedBlock,
  removeManagedBlock,
  upsertManagedBlock,
} from "../../src-electron/managed-instruction-block.js";

test("buildManagedBlock は管理ブロック形式を安定して生成する", () => {
  const block = buildManagedBlock({
    blockId: "mate-profile",
    title: "Mate Profile",
    content: "line1\nline2\n\n",
  });

  assert.equal(
    block,
    [
      "<!-- WITHMATE:BEGIN mate-profile -->",
      "## Mate Profile",
      "line1",
      "line2",
      "<!-- WITHMATE:END mate-profile -->",
    ].join("\n"),
  );
});

test("upsertManagedBlock は既存がなければ末尾に追加する", () => {
  const existing = "User note\n";
  const updated = upsertManagedBlock(existing, {
    blockId: "mate-profile",
    title: "Mate Profile",
    content: "auto-managed body",
  });

  assert.equal(
    updated,
    [
      "User note",
      "<!-- WITHMATE:BEGIN mate-profile -->",
      "## Mate Profile",
      "auto-managed body",
      "<!-- WITHMATE:END mate-profile -->",
      "",
    ].join("\n"),
  );
});

test("upsertManagedBlock は既存の同一 blockId を差し替える", () => {
  const existing =
    [
      "Header",
      "<!-- WITHMATE:BEGIN mate-profile -->",
      "## Old title",
      "old body",
      "<!-- WITHMATE:END mate-profile -->",
      "Footer",
    ].join("\n") + "\n";

  const updated = upsertManagedBlock(existing, {
    blockId: "mate-profile",
    title: "New Profile",
    content: "new body",
  });

  assert.equal(
    updated,
    [
      "Header",
      "<!-- WITHMATE:BEGIN mate-profile -->",
      "## New Profile",
      "new body",
      "<!-- WITHMATE:END mate-profile -->",
      "Footer",
      "",
    ].join("\n"),
  );
});

test("removeManagedBlock は blockId を取り除き、他領域を残す", () => {
  const existing =
    [
      "User before",
      "<!-- WITHMATE:BEGIN mate-profile -->",
      "## Keep Me",
      "managed body",
      "<!-- WITHMATE:END mate-profile -->",
      "User after",
      "",
    ].join("\n");

  const updated = removeManagedBlock(existing, "mate-profile");

  assert.equal(
    updated,
    ["User before", "", "User after", ""].join("\n"),
  );
});

test("無効な blockId はエラーを投げる", () => {
  assert.throws(() => {
    buildManagedBlock({
      blockId: "Mate_Profile",
      title: "bad",
      content: "",
    });
  });
  assert.throws(() => {
    upsertManagedBlock("text", {
      blockId: "-bad-id",
      title: "bad",
      content: "",
    });
  });
  assert.throws(() => {
    removeManagedBlock("text", "BadUpper");
  });
});

test("removeManagedBlock は未存在時にユーザー領域を維持して末尾改行を安定化する", () => {
  const existing = "User area\n\n\n";

  const updated = removeManagedBlock(existing, "mate-profile");

  assert.equal(updated, "User area\n");
});
