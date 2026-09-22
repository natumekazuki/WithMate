import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUILT_IN_MICROCOPY_CATALOG,
  createDefaultUserMicrocopyCatalog,
  hasCustomMicrocopyVariants,
  migratePersistedUserMicrocopyCatalog,
  normalizeUserMicrocopyCatalog,
  resolveMicrocopy,
} from "../../src-shared/settings/microcopy-state.js";

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

  // @test-value v2
  // kind = "invariant"
  // claim = "保存済みmicrocopyは旧同梱variant列の内容と順序が完全一致するslotだけを英語既定へ移行する"
  // oracle = { type = "contract", ref = "Issue #731 microcopy migration boundary" }
  // fault = "並べ替え・追加候補・任意customを旧既定と誤認して上書きする"
  // observable = "migratePersistedUserMicrocopyCatalog の各slot結果と changed"
  // observation_boundary = "public-boundary"
  // scope = "microcopy-built-in-migration"
  // lifecycle = "permanent"
  // impact = "ユーザーが保存したmicrocopyとvariant選択の安定性が失われる"
  // distinction = "保存ownerの再起動確認だけではslot単位の完全一致判定を直接確認できない"
  // @end-test-value
  it("migratePersistedUserMicrocopyCatalog は旧同梱variantの完全一致だけを移行する", () => {
    const migration = migratePersistedUserMicrocopyCatalog({
      "chat.pending.response_waiting": ["出力を待機しています", "応答を準備しています"],
      "retry.interrupted.title": ["前回の依頼は中断されたままです", "別の文言"],
      "dock.status.working": ["処理を実行中", "手入力の追加候補"],
      "dock.status.responding": ["応答を生成中"],
      "composer.error.path_not_found": ["指定したパスが見つかりません: {path}"],
    });
    assert.equal(migration.changed, true);
    const migrated = migration.value as Record<string, unknown>;
    assert.deepEqual(migrated["chat.pending.response_waiting"], [
      "出力を待機しています",
      "応答を準備しています",
    ]);
    assert.deepEqual(migrated["dock.status.responding"], [
      "Generating a response",
    ]);
    assert.deepEqual(
      migrated["dock.status.working"],
      ["処理を実行中", "手入力の追加候補"],
    );
    assert.deepEqual(
      migrated["composer.error.path_not_found"],
      ["Path not found: {path}"],
    );

    const customized = normalizeUserMicrocopyCatalog({
      "composer.error.path_not_found": ["Custom path error: {path}"],
    });

    assert.deepEqual(
      migrated["composer.error.path_not_found"],
      BUILT_IN_MICROCOPY_CATALOG["composer.error.path_not_found"],
    );
    assert.deepEqual(customized["composer.error.path_not_found"], ["Custom path error: {path}"]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "microcopy normalizer は既存custom値をbuilt-in英語へ置換せず、そのまま保持する"
  // oracle = { type = "contract", ref = "Microcopy custom preservation" }
  // fault = "旧既定と同じ内容でないcustom値を正規化時に上書きする"
  // observable = "normalizeUserMicrocopyCatalog のcustom slot結果"
  // observation_boundary = "public-boundary"
  // scope = "microcopy-custom-preservation"
  // lifecycle = "permanent"
  // impact = "ユーザーが明示した任意言語の設定内容が失われる"
  // distinction = "migration helperの旧同梱完全一致判定とは異なるnormalizerの保全契約を確認する"
  // @end-test-value
  it("normalizeUserMicrocopyCatalog は旧値を明示customとして保持する", () => {
    const customized = normalizeUserMicrocopyCatalog({
      "composer.error.path_not_found": ["Custom path error: {path}"],
      "dock.status.working": ["処理を実行中"],
    });

    assert.deepEqual(customized["composer.error.path_not_found"], ["Custom path error: {path}"]);
    assert.deepEqual(customized["dock.status.working"], ["処理を実行中"]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "microcopy slotはvariant列全体をbuilt-inと比較し、混在customを既定文として省略しない"
  // oracle = { type = "contract", ref = "docs/design/session-character-copy.md#rendering-policy" }
  // fault = "選択されたvariantだけを比較してcustom variantを見落とし、custom表示を隠す"
  // observable = "built-in textを選ぶ混在catalogのresolve結果とhasCustomMicrocopyVariantsの判定"
  // observation_boundary = "public-boundary"
  // scope = "microcopy-visible-custom-variants"
  // lifecycle = "permanent"
  // impact = "ユーザーが保存したcustom microcopyが選択seedによって偶然表示されない場合に失われる"
  // distinction = "resolved textの一致とvariant列のcustom差分を別値として同時に確認する"
  // @end-test-value
  it("mixed microcopy variant は built-in が選ばれても custom として可視保持する", () => {
    const slot = "retry.failed.title" as const;
    const builtInTitle = BUILT_IN_MICROCOPY_CATALOG[slot][0]!;
    const userCatalog = normalizeUserMicrocopyCatalog({
      [slot]: [builtInTitle, "Custom failure title"],
    });

    assert.equal(
      resolveMicrocopy({ slot, userCatalog, seedParts: ["mixed", 1] }),
      builtInTitle,
    );
    assert.equal(hasCustomMicrocopyVariants(userCatalog, slot), true);
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
