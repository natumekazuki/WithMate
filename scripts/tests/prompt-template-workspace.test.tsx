import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PromptTemplateWorkspace } from "../../src/prompt-templates/PromptTemplateWorkspace.js";

test("PromptTemplateWorkspace は一覧・編集・挿入を一つの中央surfaceに配置する", () => {
  const markup = renderToStaticMarkup(
    <PromptTemplateWorkspace
      api={{
        listPromptTemplates: async () => [],
        createPromptTemplate: async () => [],
        updatePromptTemplate: async () => [],
        deletePromptTemplate: async () => [],
        subscribePromptTemplates: () => () => {},
      }}
      onClose={() => {}}
      onInsert={() => {}}
    />,
  );

  assert.match(markup, />Templates</);
  assert.match(markup, /＋ 新規/);
  assert.match(markup, /名前/);
  assert.match(markup, /aria-label="プロンプト"/);
  assert.match(markup, />挿入</);
  assert.match(markup, />戻る</);
  assert.doesNotMatch(markup, /よく使うプロンプト/);
});
