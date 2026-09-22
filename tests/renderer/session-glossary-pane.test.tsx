import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionGlossaryPane } from "../../src/glossary/SessionGlossaryPane.js";
import type { SessionGlossaryProjection } from "../../src-shared/glossary/glossary-contract.js";

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

// @test-value v2
// kind = "contract"
// claim = "Glossary paneはvalid projectionをterm listと検索導線だけでread-only表示し、編集操作や内部revisionを公開しない"
// oracle = { type = "contract", ref = "src/glossary/SessionGlossaryPane.tsx: valid projection view" }
// fault = "aliases・revision・編集操作を誤って表示し、session glossaryをread-only境界から外す"
// observable = "term、search label、revision/editing markupの有無"
// observation_boundary = "component-behavior"
// scope = "session-glossary-valid-pane"
// lifecycle = "permanent"
// @end-test-value
test("SessionGlossaryPaneは一覧を用語と検索へ絞りread-onlyで表示する", () => {
  const html = renderToStaticMarkup(
    <SessionGlossaryPane {...baseProps} projection={validProjection} />,
  );
  assert.match(html, /<span class="sr-only">Search glossary<\/span>/);
  assert.doesNotMatch(html, /placeholder=/);
  assert.match(html, /Runtime/);
  assert.doesNotMatch(html, />RT</);
  assert.doesNotMatch(html, /1 \/ 1 terms/);
  assert.doesNotMatch(html, /作成|編集|削除|初期化/);
});

// @test-value v2
// kind = "contract"
// claim = "Glossary検索の失敗は空結果表示へ置換せず、errorだけを表示する"
// oracle = { type = "contract", ref = "Issue #731 glossary search state distinction" }
// fault = "検索失敗時にNo matching termsを併記して失敗を空結果と誤認させる"
// observable = "検索errorのalertと空結果メッセージの有無"
// observation_boundary = "component-behavior"
// scope = "session-glossary-search-error"
// lifecycle = "permanent"
// @end-test-value
test("SessionGlossaryPaneは検索失敗を空結果として表示しない", () => {
  const html = renderToStaticMarkup(
    <SessionGlossaryPane
      {...baseProps}
      searchQuery="unknown"
      searchError="Search failed"
      projection={validProjection}
    />,
  );
  assert.match(html, /class="glossary-search-error" role="alert">Search failed/);
  assert.doesNotMatch(html, /No matching terms/);
});

// @test-value v2
// kind = "security"
// claim = "Glossary definitionはMarkdownやHTMLとして解釈せず、aliasを表示してtextとして安全に完全表示する"
// oracle = { type = "contract", ref = "src/glossary/SessionGlossaryPane.tsx: definition rendering" }
// fault = "definitionをHTML化してmarkup injectionを許すか、aliasとback navigationを失う"
// observable = "escaped definition、literal markdown、alias、Back to glossary entries label"
// observation_boundary = "component-behavior"
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
  assert.match(html, /aria-label="Back to glossary entries"/);
});

// @test-value v2
// kind = "contract"
// claim = "Glossary missing stateはfile pathや不要な説明を含めず短いNo glossary found状態を表示する"
// oracle = { type = "contract", ref = "src/glossary/SessionGlossaryPane.tsx: missing projection view" }
// fault = "missing stateでinternal file pathまたは将来説明を表示し、現在利用できる情報を越えて案内する"
// observable = "No glossary found labelとrelative path・旧説明文の不在"
// observation_boundary = "component-behavior"
// scope = "session-glossary-missing-state"
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
  assert.match(html, />No glossary found</);
  assert.doesNotMatch(html, /\.withmate\/glossary\.yaml/);
  assert.doesNotMatch(html, /作成されると/);
});

// @test-value v2
// kind = "security"
// claim = "Glossary invalid stateはlast valid entriesを再表示せず、failure stateとdiagnostic messageを表示する"
// oracle = { type = "contract", ref = "src/glossary/SessionGlossaryPane.tsx: invalid projection view" }
// fault = "invalid dataのとき古いtermを表示して現在のGlossary状態を誤認させる"
// observable = "Could not load the glossary、issue message、古いRuntime termの不在"
// observation_boundary = "component-behavior"
// scope = "session-glossary-invalid-state"
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
  assert.match(html, /Could not load the glossary/);
  assert.match(html, /Invalid YAML/);
  assert.doesNotMatch(html, />Runtime</);
});
