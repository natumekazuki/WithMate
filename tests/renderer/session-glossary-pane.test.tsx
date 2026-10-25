import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
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
  projectionLoading: false,
  projectionError: "",
  searchQuery: "",
  searchEntries: [],
  searchTotal: 0,
  searchLoading: false,
  searchError: "",
  searchStale: false,
  selectedTerm: null,
  onSearchQueryChange() {},
  onLoadMoreSearchResults() {},
  onRetryProjection() {},
  onRetrySearch() {},
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
  assert.match(html, /<span class="sr-only">Search Glossary<\/span>/);
  assert.doesNotMatch(html, /placeholder=/);
  assert.match(html, /Runtime/);
  assert.doesNotMatch(html, />RT</);
  assert.doesNotMatch(html, /1 \/ 1 terms/);
  assert.doesNotMatch(html, /作成|編集|削除|初期化/);
});

// @test-value v2
// kind = "contract"
// claim = "Glossary検索失敗はaccessibleな失敗通知・詳細入口・Retryを提供し、理由は初期状態で閉じて正常な空結果と区別する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "詳細入口と理由の関連またはRetryを落とす、初期状態で理由を展開する、または失敗を空結果と誤認させる"
// observable = "失敗alert、詳細buttonのaria-controls/expanded、理由のhidden、Retryのaccessible name"
// observation_boundary = "component-behavior"
// scope = "session-glossary-search-error"
// lifecycle = "permanent"
// impact = "障害詳細が一覧を押し下げるか、理由や回復操作へ到達できなくなる"
// distinction = "ユーザー指定の必要時開示と回復経路をSSRのDOMで確認する。型検査はhiddenとaria-controlsの実値を確認しない"
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
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelector('[role="alert"]')?.textContent, "Glossary Search Failed");
  const details = document.querySelector('button[aria-label="Glossary Search Failed: Details"]')!;
  assert.equal(details.getAttribute("aria-expanded"), "false");
  const reason = document.getElementById(details.getAttribute("aria-controls")!)!;
  assert.equal(reason.hidden, true);
  assert.equal(reason.textContent, "Search failed");
  assert.ok(document.querySelector('button[aria-label="Retry"]'));
  assert.doesNotMatch(html, /No matching terms/);
});

// @test-value v2
// kind = "security"
// claim = "Glossary definitionはMarkdownやHTMLとして解釈せず、aliasを表示してtextとして安全に完全表示する"
// oracle = { type = "contract", ref = "src/glossary/SessionGlossaryPane.tsx: definition rendering" }
// fault = "definitionをHTML化してmarkup injectionを許すか、aliasとback navigationを失う"
// observable = "escaped definition、literal markdown、alias、Back To Entries label"
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
  assert.match(html, /aria-label="Back To Entries"/);
});

// @test-value v2
// kind = "security"
// claim = "Glossary invalid stateはlast valid entriesを再表示せず、失敗を通知して診断詳細への入口を提供する"
// oracle = { type = "contract", ref = "src/glossary/SessionGlossaryPane.tsx: invalid projection view" }
// fault = "invalid dataのとき古いtermを表示して現在のGlossary状態を誤認させる"
// observable = "失敗alert、詳細buttonと関連付いたissue message、古いRuntime termの不在"
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
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelector('[role="alert"]')?.textContent, "Could not load the glossary");
  const details = document.querySelector('button[aria-label="Could not load the glossary: Details"]')!;
  const reason = document.getElementById(details.getAttribute("aria-controls")!)!;
  assert.equal(reason.hidden, true);
  assert.equal(reason.textContent, "Invalid YAML");
  assert.doesNotMatch(html, />Runtime</);
});
