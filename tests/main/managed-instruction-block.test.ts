import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManagedBlock,
  removeManagedBlock,
  removeManagedBlockWithMarkerAttributes,
  upsertManagedBlock,
  upsertManagedBlockWithMarkerAttributes,
} from "../../src-electron/skills/managed-instruction-block.js";

/** 管理IDと本文を持つブロックの開始・終了マーカーを含む出力形式を固定する。 */
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

/** 管理対象のない文書に、ユーザー本文を残して区切り付きのブロックを追記する。 */
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

/** 同じIDのブロックを新本文へ置き換え、前後のユーザー領域を残す。 */
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

/** 指定IDの領域だけを除去し、他の管理ブロックやユーザー領域を保つ。 */
test("removeManagedBlock は blockId を取り除き、他領域を残す", () => {
  const existing = [
    "User before",
    "<!-- WITHMATE:BEGIN mate-profile -->",
    "## Keep Me",
    "managed body",
    "<!-- WITHMATE:END mate-profile -->",
    "User after",
    "",
  ].join("\n");

  const updated = removeManagedBlock(existing, "mate-profile");

  assert.equal(updated, ["User before", "", "User after", ""].join("\n"));
});

/** 生成・更新・削除それぞれが、マーカーに使えないIDを受理しないことを確かめる。 */
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

/** 削除対象がなくてもユーザー本文を保ち、末尾の余分な改行だけを正規化する。 */
test("removeManagedBlock は未存在時にユーザー領域を維持して末尾改行を安定化する", () => {
  const existing = "User area\n\n\n";

  const updated = removeManagedBlock(existing, "mate-profile");

  assert.equal(updated, "User area\n");
});

/** 属性列の順序に依存せず対象を識別し、新しいブロックと後続の本文を残す。 */
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
  assert.equal(
    updated.includes(
      "provider=codex target=main mode=managed-block block=mate-profile",
    ),
    true,
  );
  assert.equal(updated.includes("Footer"), true);
});

/** 同じ種類のブロックが併存しても、指定した属性と一致する領域だけを除去する。 */
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

/** 同じ属性集合を持つ候補が複数ある場合に、任意の一件を変更せず例外にする。 */
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

/** 対象Providerとtargetが同じでも、管理modeの相違は別対象への変更でなくマーカー不一致として扱う。 */
test("provider/target が一致する marker の mode mismatch は marker mismatch 例外になる", () => {
  const existing = [
    "Header",
    "<!-- WITHMATE:BEGIN provider=codex target=main mode=managed-file block=mate-profile -->",
    "## Main",
    "old body",
    "<!-- WITHMATE:END provider=codex target=main mode=managed-file block=mate-profile -->",
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
  }, /marker mismatch|mode/);
});

/** 開始・終了マーカーの属性が一致しないとき、領域を推測して更新せずエラーにする。 */
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

/** 属性指定なしの削除では、属性付きの既存領域を誤って対象にしない。 */
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
