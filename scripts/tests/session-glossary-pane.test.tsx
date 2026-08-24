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

test("SessionGlossaryPaneは一覧を用語と検索へ絞りread-onlyで表示する", () => {
  const html = renderToStaticMarkup(
    <SessionGlossaryPane {...baseProps} projection={validProjection} />,
  );
  assert.match(html, /用語を検索/);
  assert.match(html, /Runtime/);
  assert.doesNotMatch(html, />RT</);
  assert.doesNotMatch(html, /1 \/ 1 terms/);
  assert.doesNotMatch(html, /作成|編集|削除|初期化/);
});

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
