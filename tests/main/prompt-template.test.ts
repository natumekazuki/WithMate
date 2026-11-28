import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  PROMPT_TEMPLATE_PROMPT_MAX_BYTES,
  normalizePromptTemplateName,
  normalizePromptTemplatePrompt,
} from "../../src-shared/prompt-template.js";
import { PromptTemplateStorage } from "../../src-electron/prompt-templates/prompt-template-storage.js";

/** 保存前に適用されるテンプレート名と本文の入力制約を検証する。 */
describe("prompt template contract", () => {
  /** 名前の連続空白は一つにまとめ、空白だけの名前・本文と上限を1バイト超えた本文を受け付けない。 */
  it("名前を正規化し、空本文と上限超過を拒否する", () => {
    assert.equal(
      normalizePromptTemplateName("  Review   Brief  "),
      "Review Brief",
    );
    assert.throws(() => normalizePromptTemplateName("   "), /template name/i);
    assert.throws(() => normalizePromptTemplatePrompt("\n\t"), /prompt/i);
    assert.throws(
      () =>
        normalizePromptTemplatePrompt(
          "a".repeat(PROMPT_TEMPLATE_PROMPT_MAX_BYTES + 1),
        ),
      /256 KiB/,
    );
  });
});

/** 一時SQLiteデータベースを使い、テンプレートの保存・再読込と無効な更新の拒否を検証する。 */
describe("PromptTemplateStorage", () => {
  /** 作成した本文をDBの再オープン後に読み出せて、同じIDを更新・削除すると一覧から消える。 */
  it("作成・再読込・更新・削除を永続化する", () => {
    const directory = mkdtempSync(join(tmpdir(), "withmate-prompt-templates-"));
    const dbPath = join(directory, "withmate-v6.db");
    try {
      const storage = new PromptTemplateStorage(dbPath);
      const created = storage.createPromptTemplate({
        name: "Review Brief",
        prompt: "brief body",
      });
      assert.equal(storage.listPromptTemplates()[0]?.id, created.id);
      storage.close();

      const reopened = new PromptTemplateStorage(dbPath);
      const persisted = reopened.listPromptTemplates()[0];
      assert.equal(persisted?.prompt, "brief body");
      const updated = reopened.updatePromptTemplate({
        id: created.id,
        name: "Review Brief Updated",
        prompt: "updated body",
      });
      assert.equal(updated.name, "Review Brief Updated");
      reopened.deletePromptTemplate(created.id);
      assert.deepEqual(reopened.listPromptTemplates(), []);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "PromptTemplateStorageは名前重複と存在しないIDへの更新・削除を拒否する"
  // oracle = { type = "contract", ref = "PromptTemplateStorage mutation validation contract" }
  // fault = "大文字小文字だけ異なる重複名や未知IDの操作が成功し、保存状態を壊す"
  // observable = "各操作の例外と残存template件数"
  // observation_boundary = "public-boundary"
  // scope = "PromptTemplateStorage duplicate and missing ID validation"
  // lifecycle = "permanent"
  // @end-test-value
  /** 大文字小文字のみ異なる名前の作成と未知IDの更新・削除を拒否し、既存の1件を残す。 */
  it("大文字小文字だけ異なる重複名と存在しないIDの変更を拒否する", () => {
    const directory = mkdtempSync(join(tmpdir(), "withmate-prompt-templates-"));
    const dbPath = join(directory, "withmate-v6.db");
    let storage: PromptTemplateStorage | null = null;
    try {
      storage = new PromptTemplateStorage(dbPath);
      storage.createPromptTemplate({ name: "Review", prompt: "first" });
      assert.throws(
        () =>
          storage!.createPromptTemplate({ name: "review", prompt: "second" }),
        /same name/i,
      );
      assert.throws(
        () =>
          storage!.updatePromptTemplate({
            id: "missing",
            name: "Missing",
            prompt: "body",
          }),
        /not found/i,
      );
      assert.throws(
        () => storage!.deletePromptTemplate("missing"),
        /not found/i,
      );
      assert.equal(storage!.listPromptTemplates().length, 1);
    } finally {
      storage?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
