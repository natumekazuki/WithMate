import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManagedBlock,
  removeManagedBlock,
  removeManagedBlockWithMarkerAttributes,
  upsertManagedBlock,
  upsertManagedBlockWithMarkerAttributes,
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

test("属性付き managed block は属性順が違っても差し替える", () => {
  const existing = [
    "Header",
    "<!-- WITHMATE:BEGIN mode=managed-block block=mate-profile target=main provider=codex -->",
    "## Old title",
    "old body",
    "<!-- WITHMATE:END target=main provider=codex block=mate-profile mode=managed-block -->",
    "Footer",
    "",
  ].join("\n");

  const updated = upsertManagedBlockWithMarkerAttributes(existing, {
    blockId: "mate-profile",
    title: "New Profile",
    content: "new body",
    markerAttributes: {
      provider: "codex",
      target: "main",
      mode: "managed-block",
    },
  });

  assert.equal(updated.includes("old body"), false);
  assert.equal(updated.includes("new body"), true);
  assert.equal(updated.includes("provider=codex target=main mode=managed-block block=mate-profile"), true);
  assert.equal(updated.includes("Footer"), true);
});

test("属性付き managed block は一致する属性の block だけ削除する", () => {
  const existing = [
    "Header",
    "<!-- WITHMATE:BEGIN provider=codex target=feature mode=managed-block block=mate-profile -->",
    "## Feature",
    "feature body",
    "<!-- WITHMATE:END provider=codex target=feature mode=managed-block block=mate-profile -->",
    "<!-- WITHMATE:BEGIN mode=managed-block block=mate-profile target=main provider=codex -->",
    "## Main",
    "main body",
    "<!-- WITHMATE:END target=main provider=codex block=mate-profile mode=managed-block -->",
    "Footer",
    "",
  ].join("\n");

  const updated = removeManagedBlockWithMarkerAttributes(existing, {
    blockId: "mate-profile",
    markerAttributes: {
      provider: "codex",
      target: "main",
      mode: "managed-block",
    },
  });

  assert.equal(updated.includes("main body"), false);
  assert.equal(updated.includes("feature body"), true);
  assert.equal(updated.includes("Footer"), true);
});

test("属性付き managed block が重複すると例外になる", () => {
  const existing = [
    "Header",
    "<!-- WITHMATE:BEGIN mode=managed-block block=mate-profile target=main provider=codex -->",
    "## Main",
    "main body 1",
    "<!-- WITHMATE:END target=main provider=codex block=mate-profile mode=managed-block -->",
    "<!-- WITHMATE:BEGIN provider=codex target=main mode=managed-block block=mate-profile -->",
    "## Main",
    "main body 2",
    "<!-- WITHMATE:END provider=codex target=main mode=managed-block block=mate-profile -->",
    "Footer",
    "",
  ].join("\n");

  assert.throws(() => {
    upsertManagedBlockWithMarkerAttributes(existing, {
      blockId: "mate-profile",
      title: "New Profile",
      content: "new body",
      markerAttributes: {
        provider: "codex",
        target: "main",
        mode: "managed-block",
      },
    });
  }, /duplicate managed block|重複 managed block/);
});

test("属性付き managed block の BEGIN/END 不整合は例外になる", () => {
  const existing = [
    "Header",
    "<!-- WITHMATE:BEGIN mode=managed-block block=mate-profile target=main provider=codex -->",
    "## Main",
    "main body",
    "Footer",
    "",
  ].join("\n");

  assert.throws(() => {
    removeManagedBlockWithMarkerAttributes(existing, {
      blockId: "mate-profile",
      markerAttributes: {
        provider: "codex",
        target: "main",
        mode: "managed-block",
      },
    });
  }, /malformed marker|BEGIN/);
});

test("空の属性は属性付き block に一致しない", () => {
  const existing = [
    "Header",
    "<!-- WITHMATE:BEGIN provider=codex target=main mode=managed-block block=mate-profile -->",
    "## Main",
    "main body",
    "<!-- WITHMATE:END provider=codex target=main mode=managed-block block=mate-profile -->",
    "Footer",
    "",
  ].join("\n");

  const updated = removeManagedBlockWithMarkerAttributes(existing, {
    blockId: "mate-profile",
    markerAttributes: {},
  });

  assert.equal(updated, existing);
});
