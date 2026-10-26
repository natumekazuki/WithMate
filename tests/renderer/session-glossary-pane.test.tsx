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
// claim = "Glossary検索失敗はaccessibleな失敗通知・開閉状態付きの詳細入口・Retryを提供し、診断原文だけを非modal popupへ関連付ける"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "詳細入口と理由のnative popup関連またはRetryを落とす、または失敗を空結果と誤認させる"
// observable = "失敗alert、詳細buttonのpopovertarget/aria-controls/expanded、非modal dialogのaccessible nameと原文、Retryのaccessible name"
// observation_boundary = "component-behavior"
// scope = "session-glossary-search-error"
// lifecycle = "permanent"
// impact = "障害詳細が一覧を押し下げるか、理由や回復操作へ到達できなくなる"
// distinction = "ユーザー指定popupの宣言と回復経路をSSRのDOMで確認する。型検査はtargetの実際の関連先を確認しない。native開閉とlayoutは実ブラウザーで別途確認する"
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
  const popup = document.getElementById(details.getAttribute("popovertarget")!)!;
  assert.equal(details.getAttribute("aria-controls"), popup.id);
  assert.equal(details.getAttribute("aria-haspopup"), "dialog");
  assert.equal(details.getAttribute("aria-expanded"), "false");
  assert.equal(popup.getAttribute("popover"), "auto");
  assert.equal(popup.getAttribute("role"), "dialog");
  assert.equal(popup.getAttribute("aria-label"), "Glossary Search Failed: Details");
  assert.notEqual(popup.getAttribute("aria-modal"), "true");
  assert.equal(popup.textContent, "×Search failed");
  const reason = popup.querySelector(".glossary-error-detail")!;
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
// claim = "Glossary invalid/unsupported stateは旧用語を出さず、修正対象の案内を常時表示し診断原文はpopupへ関連付ける"
// oracle = { type = "contract", ref = "src/glossary/SessionGlossaryPane.tsx: invalid projection view" }
// fault = "不正・未対応formatを旧用語で表示する、または修正対象の案内を診断popup内に隠す"
// observable = "失敗alert、popup外の修正案内、詳細buttonのpopovertargetと診断原文、旧Runtime termの不在"
// observation_boundary = "component-behavior"
// scope = "session-glossary-invalid-state"
// lifecycle = "permanent"
// @end-test-value
test("SessionGlossaryPaneはinvalid/unsupported時に修正案内を残し旧用語を表示しない", () => {
  for (const state of [
    {
      status: "invalid",
      relativePath: ".withmate/glossary.yaml",
      revision: "b".repeat(64),
      issues: [{ path: "$", code: "INVALID_YAML", message: "Invalid YAML" }],
    },
    {
      status: "unsupported",
      relativePath: ".withmate/glossary.yaml",
      revision: "b".repeat(64),
      schemaVersion: 99,
      issues: [{ path: "schemaVersion", code: "UNSUPPORTED_SCHEMA_VERSION", message: "Unsupported schema" }],
    },
  ] satisfies SessionGlossaryProjection["state"][]) {
    const html = renderToStaticMarkup(
      <SessionGlossaryPane
        {...baseProps}
        projection={{
          ...validProjection,
          sequence: 2,
          state,
        }}
      />,
    );
    const document = new JSDOM(html).window.document;
    const label = state.status === "invalid" ? "Could not load the glossary" : "Unsupported format";
    assert.equal(document.querySelector('[role="alert"]')?.textContent, label);
    const details = document.querySelector(`button[aria-label="${label}: Details"]`)!;
    const popup = document.getElementById(details.getAttribute("popovertarget")!)!;
    assert.equal(popup.getAttribute("popover"), "auto");
    const reason = popup.querySelector(".glossary-error-detail")!;
    assert.equal(reason.textContent, state.status === "invalid" ? "Invalid YAML" : "schemaVersion 99");
    const guidance = document.querySelector(".glossary-error-guidance")!;
    assert.equal(popup.contains(guidance), false);
    assert.equal(guidance.textContent, state.status === "invalid"
      ? "Fix .withmate/glossary.yaml to load the glossary."
      : "Use a supported schemaVersion in .withmate/glossary.yaml.");
    assert.doesNotMatch(html, />Runtime</);
  }
});
