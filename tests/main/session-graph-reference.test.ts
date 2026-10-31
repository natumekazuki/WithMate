import assert from "node:assert/strict";
import test from "node:test";

import { isSessionGraphReferenceHref } from "../../src-shared/session-graph/session-graph-reference.js";
import { resolveOpenPathTarget } from "../../src-electron/files/open-path.js";

// @test-value v2
// kind = "invariant"
// claim = "明示した絶対ファイルパスと対応schemeの完全URLは、対象の存在や登録rootに依存せず参照形式として受理する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/894" }
// fault = "一部の絶対path形式を拒否するか、保存時に存在やroot登録を要求する"
// observable = "各hrefに対する形式validatorの戻り値"
// observation_boundary = "public-boundary"
// scope = "session-graph-reference-href"
// lifecycle = "permanent"
// impact = "SessionFolderや登録root外の成果物を一意な参照として記録できなくなる"
// distinction = "文字列型・長さのschemaだけではOS別pathとschemeごとの形式を区別できず、少数の同期入力で検証できる"
// @end-test-value
test("reference href accepts absolute paths and complete supported URLs", () => {
  const hrefs = [
    "C:\\outside-roots\\not-created\\review result.md",
    "D:/session-folder/review.md",
    "\\\\server\\share\\artifact.md",
    "/outside-roots/not-created/review result.md",
    "/",
    "file:///C:/session-folder/review%20result.md",
    "file:///tmp/review%20result.md",
    "file:/tmp/review.md",
    "file:///",
    "file:/",
    "file://server/share/review.md",
    "file://localhost/tmp/review.md",
    "https://example.com/review?q=a%2Fb#heading%202",
    "HTTP://localhost:8080/review",
    "mailto:reviewer@example.com?subject=Review%20result",
    "tel:+81-3-1234-5678;ext=12",
  ];
  for (const href of hrefs) assert.equal(isSessionGraphReferenceHref(href), true, href);
});

// @test-value v2
// kind = "invariant"
// claim = "相対・drive相対・protocol-relative・不完全または未対応schemeの参照を補完せず拒否する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/894" }
// fault = "URL parserやopen resolverの自動補完で相対・不完全入力を受理する"
// observable = "各hrefに対する形式validatorの戻り値"
// observation_boundary = "public-boundary"
// scope = "session-graph-reference-href"
// lifecycle = "permanent"
// impact = "参照が別のWorkspaceやSessionFolderを基準に保存され、意図した成果物を開けなくなる"
// distinction = "string schemaや既存open resolverは補完前入力の完全性を保証せず、短い入力表でこの境界を継続確認する"
// @end-test-value
test("reference href rejects ambiguous paths and incomplete URLs before supplementation", () => {
  const hrefs = [
    "", "review.md", "./review.md", "../review.md", "~/review.md",
    "C:review.md", "C:", "\\review.md", "\\\\server", "\\\\server\\",
    "//example.com/review", "//server/share/review.md",
    "https:", "https:example.com", "https:/example.com", "https:///example.com",
    "https://", "https://?q=review", "https://example.com:invalid", "https://example.com\\review",
    "mailto:", "mailto:?subject=Review", "mailto://reviewer@example.com",
    "tel:", "tel:#extension", "tel://1234", "tel:12 34",
    "file:", "file://", "file://?view=1", "file://#part", "file:review.md", "file:C:review.md", "file:///C:review.md",
    "file://server", "file://server/", "file:///tmp/%zz.md", "file:///tmp/%00.md",
    "ftp://example.com/review", "javascript:alert(1)",
    " https://example.com", "https://example.com\n", "/tmp/review\u0000.md",
  ];
  for (const href of hrefs) assert.equal(isSessionGraphReferenceHref(href), false, href);
});

// @test-value v2
// kind = "invariant"
// claim = "受理した参照を共通openへ渡すと外部URLのquery・fragment・encodingが保たれ、明示file URLは指定した絶対pathになる"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/894" }
// fault = "保存形式と共通openの分類が食い違うか、外部URLを再構成してencoded queryやfragmentを変える"
// observable = "共通open resolverのexternal targetまたはlocal targetPath"
// observation_boundary = "consumer"
// scope = "session-graph-reference-href-common-open"
// lifecycle = "permanent"
// impact = "参照クリックが別のURLや別のfileを開く"
// distinction = "validatorのboolean確認だけでは下流resolverとの分類整合と値の保持を保証できず、IOなしの3入力で確認する"
// @end-test-value
test("accepted reference hrefs retain their targets through the common open resolver", () => {
  for (const href of [
    "https://example.com/review?q=a%2Fb&name=%E8%A8%AD%E8%A8%88#part%202",
    "mailto:reviewer@example.com?subject=Review%20result#notes",
  ]) {
    assert.equal(isSessionGraphReferenceHref(href), true);
    assert.deepEqual(resolveOpenPathTarget(href), { type: "external-url", target: href });
  }
  const href = "file:///C:/outside-roots/review%20result%23final.md?view=1#notes";
  assert.equal(isSessionGraphReferenceHref(href), true);
  assert.deepEqual(resolveOpenPathTarget(href), {
    type: "local-path", targetPath: "C:\\outside-roots\\review result#final.md",
  });
});
