import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionGlossaryPane } from "../../src/glossary/SessionGlossaryPane.js";
import type { SessionGlossaryProjection } from "../../src/glossary-contract.js";

const validProjection: SessionGlossaryProjection = {
  sessionId: "session-1",
  scopeRevision: "scope-1",
  sequence: 1,
  checkout: {
    repositoryName: "WithMate",
    branch: "feat-glossary",
    pathLabel: "feat-repository-glossary",
  },
  state: {
    status: "valid",
    relativePath: ".withmate/glossary.yaml",
    revision: "a".repeat(64),
    entries: [{
      term: "Runtime",
      aliases: ["RT"],
      definition: "<strong>plain</strong> **not markdown**\nsecond line",
    }],
  },
};

const baseProps = {
  searchQuery: "",
  searchEntries: [],
  searchTotal: 0,
  searchLoading: false,
  searchError: "",
  selectedTerm: null,
  onSearchQueryChange() {},
  onLoadMoreSearchResults() {},
  onSelectTerm() {},
  onBackToList() {},
};

// @test-value v1
// kind = "invariant"
// claim = "Glossary paneは用語一覧と検索に限定したread-only surfaceとして表示する"
// oracle = { type = "adr", ref = "docs/adr/022-repository-glossary-boundary.md" }
// failure_mode = "Session paneがGlossary mutation ownerを持つ、または検索導線を欠く"
// scope = "session-glossary-pane-read-only-boundary"
// lifecycle = "permanent"
// @end-test-value
test("SessionGlossaryPaneは一覧を用語と検索へ絞りread-onlyで表示する", () => {
  const html = renderToStaticMarkup(
    <SessionGlossaryPane {...baseProps} projection={validProjection} />,
  );
  assert.match(html, /<span class="sr-only">用語集を検索<\/span>/);
  assert.doesNotMatch(html, /placeholder=/);
  assert.match(html, /Runtime/);
  assert.doesNotMatch(html, />RT</);
  assert.doesNotMatch(html, /1 \/ 1 terms/);
  assert.doesNotMatch(html, /作成|編集|削除|初期化/);
});

// @test-value v1
// kind = "security"
// claim = "Glossary definitionはHTMLやMarkdownとして解釈せずplain textで完全表示する"
// oracle = { type = "adr", ref = "docs/adr/022-repository-glossary-boundary.md" }
// failure_mode = "definition内markupが実行・装飾される、または内容が省略され定義を確認できない"
// scope = "session-glossary-definition-rendering"
// lifecycle = "permanent"
// @end-test-value
test("SessionGlossaryPaneはdefinitionをMarkdownやHTMLとして解釈せず完全表示する", () => {
  const html = renderToStaticMarkup(
    <SessionGlossaryPane {...baseProps} projection={validProjection} selectedTerm="Runtime" />,
  );
  assert.match(html, /&lt;strong&gt;plain&lt;\/strong&gt; \*\*not markdown\*\*/);
  assert.doesNotMatch(html, /<strong>plain<\/strong>/);
  assert.match(html, />RT</);
  assert.doesNotMatch(html, /Aliases:/);
  assert.match(html, /aria-label="用語一覧へ戻る"/);
});

// @test-value v1
// kind = "invariant"
// claim = "Glossary missing状態は内部file pathや常設説明を出さず短い空状態として表示する"
// oracle = { type = "contract", ref = "docs/features/repository-glossary.md" }
// failure_mode = "存在しないGlossaryで個人pathを露出する、または不要な説明でpaneを埋める"
// scope = "session-glossary-pane-missing-state"
// lifecycle = "permanent"
// @end-test-value
test("SessionGlossaryPaneはmissingを説明文やfile pathなしの短い状態として表示する", () => {
  const html = renderToStaticMarkup(
    <SessionGlossaryPane
      {...baseProps}
      projection={{
        ...validProjection,
        sequence: 2,
        state: {
          status: "missing",
          relativePath: ".withmate/glossary.yaml",
          revision: null,
        },
      }}
    />,
  );
  assert.match(html, />用語集なし</);
  assert.doesNotMatch(html, /\.withmate\/glossary\.yaml/);
  assert.doesNotMatch(html, /作成されると/);
});

// @test-value v1
// kind = "invariant"
// claim = "Glossaryがinvalidへ遷移したら以前のvalid entriesを表示せずerror stateへ切り替える"
// oracle = { type = "contract", ref = "docs/features/repository-glossary.md" }
// failure_mode = "破損後も古い用語を現行定義として表示し続ける"
// scope = "session-glossary-pane-invalid-state"
// lifecycle = "permanent"
// @end-test-value
test("SessionGlossaryPaneはinvalid時にlast valid entriesを表示しない", () => {
  const html = renderToStaticMarkup(
    <SessionGlossaryPane
      {...baseProps}
      projection={{
        ...validProjection,
        sequence: 2,
        state: {
          status: "invalid",
          relativePath: ".withmate/glossary.yaml",
          revision: "b".repeat(64),
          issues: [{ path: "$", code: "INVALID_YAML", message: "Invalid YAML" }],
        },
      }}
    />,
  );
  assert.match(html, /用語集を読み込めません/);
  assert.match(html, /Invalid YAML/);
  assert.doesNotMatch(html, />Runtime</);
});
