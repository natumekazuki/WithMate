import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  PROMPT_TEMPLATE_PROMPT_MAX_BYTES,
  normalizePromptTemplateName,
  normalizePromptTemplatePrompt,
} from "../../src/prompt-template.js";
import { PromptTemplateStorage } from "../../src-electron/prompt-template-storage.js";

describe("prompt template contract", () => {
  // @test-value v1
  // kind = "contract"
  // claim = "template名を正規化し空本文と文字数上限超過をvalidationで拒否する"
  // oracle = { type = "contract", ref = "docs/features/prompt-template-workspace.md" }
  // failure_mode = "保存不能または過大なtemplate payloadが永続化境界へ到達する"
  // scope = "prompt template validation"
  // lifecycle = "permanent"
  // @end-test-value
  it("名前を正規化し、空本文と上限超過を拒否する", () => {
    assert.equal(normalizePromptTemplateName("  Review   Brief  "), "Review Brief");
    assert.throws(() => normalizePromptTemplateName("   "), /template name/i);
    assert.throws(() => normalizePromptTemplatePrompt("\n\t"), /prompt/i);
    assert.throws(
      () => normalizePromptTemplatePrompt("a".repeat(PROMPT_TEMPLATE_PROMPT_MAX_BYTES + 1)),
      /256 KiB/,
    );
  });
});

describe("PromptTemplateStorage", () => {
  it("作成・再読込・更新・削除を永続化する", () => {
    const directory = mkdtempSync(join(tmpdir(), "withmate-prompt-templates-"));
    const dbPath = join(directory, "withmate-v6.db");
    try {
      const storage = new PromptTemplateStorage(dbPath);
      const created = storage.createPromptTemplate({ name: "Review Brief", prompt: "brief body" });
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

  // @test-value v1
  // kind = "invariant"
  // claim = "template storageはcase-insensitiveな重複名と存在しないIDの更新を拒否する"
  // oracle = { type = "contract", ref = "docs/features/prompt-template-workspace.md" }
  // failure_mode = "同一視される重複templateを作るか更新を新規作成として扱う"
  // scope = "prompt template storage mutation"
  // lifecycle = "permanent"
  // @end-test-value
  it("大文字小文字だけ異なる重複名と存在しないIDの変更を拒否する", () => {
    const directory = mkdtempSync(join(tmpdir(), "withmate-prompt-templates-"));
    const dbPath = join(directory, "withmate-v6.db");
    let storage: PromptTemplateStorage | null = null;
    try {
      storage = new PromptTemplateStorage(dbPath);
      storage.createPromptTemplate({ name: "Review", prompt: "first" });
      assert.throws(
        () => storage.createPromptTemplate({ name: "review", prompt: "second" }),
        /same name/i,
      );
      assert.throws(
        () => storage.updatePromptTemplate({ id: "missing", name: "Missing", prompt: "body" }),
        /not found/i,
      );
      assert.throws(() => storage.deletePromptTemplate("missing"), /not found/i);
      assert.equal(storage.listPromptTemplates().length, 1);
    } finally {
      storage?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
