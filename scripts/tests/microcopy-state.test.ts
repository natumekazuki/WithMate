import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUILT_IN_MICROCOPY_CATALOG,
  createDefaultUserMicrocopyCatalog,
  normalizeUserMicrocopyCatalog,
  resolveMicrocopy,
} from "../../src/microcopy-state.js";

describe("microcopy-state", () => {
  it("user default catalog は built-in default を clone する", () => {
    const catalog = createDefaultUserMicrocopyCatalog();

    assert.deepEqual(catalog, BUILT_IN_MICROCOPY_CATALOG);
    assert.notEqual(catalog["dock.status.preparing"], BUILT_IN_MICROCOPY_CATALOG["dock.status.preparing"]);
  });

  it("normalizeUserMicrocopyCatalog は slot ごとの複数 copy と fallback を扱う", () => {
    const catalog = normalizeUserMicrocopyCatalog({
      "chat.pending.response_waiting": ["  応答待機中  ", "", "出力待機中"],
      "dock.status.working": [],
      unknown: ["ignored"],
    });

    assert.deepEqual(catalog["chat.pending.response_waiting"], ["応答待機中", "出力待機中"]);
    assert.deepEqual(catalog["dock.status.working"], BUILT_IN_MICROCOPY_CATALOG["dock.status.working"]);
    assert.deepEqual(catalog["composer.error.path_not_found"], BUILT_IN_MICROCOPY_CATALOG["composer.error.path_not_found"]);
    assert.equal("unknown" in catalog, false);
  });

  it("normalizeUserMicrocopyCatalog は旧 path error 既定値だけを現在の既定値へ移行する", () => {
    const migrated = normalizeUserMicrocopyCatalog({
      "composer.error.path_not_found": ["指定したパスが見つかりません: {path}"],
    });
    const customized = normalizeUserMicrocopyCatalog({
      "composer.error.path_not_found": ["Custom path error: {path}"],
    });

    assert.deepEqual(
      migrated["composer.error.path_not_found"],
      BUILT_IN_MICROCOPY_CATALOG["composer.error.path_not_found"],
    );
    assert.deepEqual(customized["composer.error.path_not_found"], ["Custom path error: {path}"]);
  });

  it("resolveMicrocopy は同じ seed で安定して variant を選ぶ", () => {
    const userCatalog = normalizeUserMicrocopyCatalog({
      "chat.pending.response_waiting": ["A", "B", "C"],
    });

    const first = resolveMicrocopy({
      slot: "chat.pending.response_waiting",
      userCatalog,
      seedParts: ["session-1", "run-1"],
    });
    const second = resolveMicrocopy({
      slot: "chat.pending.response_waiting",
      userCatalog,
      seedParts: ["session-1", "run-1"],
    });

    assert.equal(first, second);
    assert.ok(["A", "B", "C"].includes(first));
  });
});
