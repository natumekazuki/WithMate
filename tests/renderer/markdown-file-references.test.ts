import assert from "node:assert/strict";
import test from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Link, Root, RootContent } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import {
  codexFileReferencesFromMarkdown,
  codexFileReferencesSyntax,
} from "../../src-shared/text/codex-file-references.js";
import { remarkProviderResponse } from "../../src-shared/text/provider-response-markdown.js";

function parse(source: string): Root {
  return fromMarkdown(source, {
    extensions: [codexFileReferencesSyntax()],
    mdastExtensions: [codexFileReferencesFromMarkdown()],
  });
}

function links(tree: Root | RootContent): Link[] {
  return tree.type === "link" ? [tree]
    : "children" in tree ? tree.children.flatMap(links) : [];
}

function visualize(path: string): string {
  return `visualize${JSON.stringify({ path, mode: "wide", title: "成果物" })}`;
}

// @test-value v2
// kind = "invariant"
// claim = "両file参照記法は元pathのlink targetとsource位置を保持し、visualizeはfile名labelとtitle・modeのpreview metadataを持つ"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "記法が文字列として残る、visualizeのlabelに長い絶対pathを表示する、またはtargetのpathを変形する"
// observable = "public Markdown parser出力のlink URL、children、source offsets、hPropertiesとremark consumer出力"
// observation_boundary = "consumer"
// scope = "assistant file-reference markdown parsing"
// lifecycle = "permanent"
// impact = "利用者がHTMLやOffice成果物のpathを通常のファイル操作へ渡せなくなる"
// distinction = "type/buildは入力記法から生成されるMarkdown nodeと原文offsetの正しさを検証しない。少数の短い入力で継続検証できる"
// @end-test-value
test("file references preserve links and exact offsets with visualize preview metadata", () => {
  const sources = ["html", "xlsx", "docx", "pptx", "pdf"].flatMap((extension) => {
    const path = `C:/work/日本語 _[成果💡] (1).${extension}`;
    return [
      { path, source: visualize(path) },
      { path, source: `:codex-file-citation{path="${path}" artifact_kind="workbook" purpose="output" sheet="Sheet 1" range="C27"}` },
    ];
  });
  for (const { path, source } of sources) {
    const body = `前 **強調** ${source} 後`;
    const tree = parse(body);
    const references = links(tree);
    assert.equal(references.length, 1);
    assert.equal(decodeURIComponent(references[0].url), path);
    assert.deepEqual(references[0].children, [{ type: "text", value: source.startsWith("visualize") ? `日本語 _[成果💡] (1).${path.split(".").pop()}` : path }]);
    assert.deepEqual(references[0].data?.hProperties, source.startsWith("visualize") ? {
      "data-codex-visualize-path": path,
      "data-codex-visualize-title": "成果物",
      "data-codex-visualize-mode": "wide",
    } : undefined);
    assert.equal(body.slice(references[0].position?.start.offset, references[0].position?.end.offset), source);
    assert.deepEqual(unified().use(remarkParse).use(remarkProviderResponse, "codex").parse(body), tree);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "絶対local pathのliteral/escaped引用とJSON引用は元targetを保持し、visualizeのWindows pathとfile URLは復号したfile名labelを表示する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "Markdownのescape処理や属性decodeにより異なるファイルpathになる"
// observable = "public Markdown parser出力のlink URLとtext label"
// observation_boundary = "consumer"
// scope = "local file-reference path preservation"
// lifecycle = "permanent"
// impact = "成果物と異なるpathが開かれたり正しいファイルが見つからなくなる"
// distinction = "型検査と通常Markdown link testでは独自JSON/属性構文のdecodeを通らない。少数の固定入力でpath契約を検証する"
// @end-test-value
test("literal and escaped local paths preserve their exact file targets", () => {
  const cases = [
    { source: String.raw`:codex-file-citation{path="C:\work\new_file (1).html"}`, path: String.raw`C:\work\new_file (1).html` },
    { source: String.raw`:codex-file-citation{path="C:\\work\\new_file (1).html"}`, path: String.raw`C:\work\new_file (1).html` },
    { source: String.raw`:codex-file-citation{path="\\server\share\book.xlsx"}`, path: String.raw`\\server\share\book.xlsx` },
    { source: String.raw`:codex-file-citation{path="\\\\server\\share\\book.xlsx"}`, path: String.raw`\\server\share\book.xlsx` },
    { source: String.raw`:codex-file-citation{path="/work/quote\"_file.docx"}`, path: '/work/quote"_file.docx' },
    { source: ':codex-file-citation{path="file:///C:/work/a%20b.pptx"}', path: "file:///C:/work/a%20b.pptx" },
    { source: visualize(String.raw`C:\work\new_file [1].pdf`), path: String.raw`C:\work\new_file [1].pdf`, label: "new_file [1].pdf" },
    { source: visualize("file:///C:/work/a%20b.html"), path: "file:///C:/work/a%20b.html", label: "a b.html" },
  ];
  for (const { source, path, label } of cases) {
    const references = links(parse(source));
    assert.equal(references.length, 1, source);
    assert.equal(/^file:/u.test(path) ? references[0].url : decodeURIComponent(references[0].url), path);
    assert.deepEqual(references[0].children, [{ type: "text", value: label ?? path }]);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "コード例と成立したMarkdown link／image内ではfile参照記法を新しいlinkとして解釈しない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "literalコードが操作可能になる、既存link内に入れ子linkが生成される、またはimageのaltを変形する"
// observable = "public Markdown parser出力のcode/inlineCode値とlink／image・参照形式のAST"
// observation_boundary = "consumer"
// scope = "file-reference Markdown contexts"
// lifecycle = "permanent"
// impact = "コード例を成果物と誤認し、元のMarkdown linkの操作先や画像代替textが変わる"
// distinction = "buildと型はMarkdown文脈による解析分岐を検査しない。標準parserのconsumer境界で短い文脈例を検証する"
// @end-test-value
test("code and existing Markdown link contexts retain literal references", () => {
  for (const source of [visualize("/work/view.html"), ':codex-file-citation{path="/work/book.xlsx"}']) {
    for (const wrapped of [`\`${source}\``, `\`\`\`text\n${source}\n\`\`\``, `    ${source}`]) {
      const tree = parse(wrapped);
      assert.deepEqual(links(tree), []);
      const first = tree.children[0];
      if (first.type === "code") assert.equal(first.value, source);
      else {
        assert.equal(first.type, "paragraph");
        assert.equal(first.children[0].type, "inlineCode");
        assert.equal(first.children[0].value, source);
      }
    }
    for (const wrapped of [
      `[${source}](https://example.com)`,
      `[${source}][result]\n\n[result]: https://example.com`,
      `[${source}]\n\n[${source}]: https://example.com`,
    ]) {
      assert.deepEqual(parse(wrapped), fromMarkdown(wrapped));
    }
    for (const wrapped of [
      `![${source}](image.png)`,
      `![${source}][image]\n\n[image]: image.png`,
    ]) {
      assert.deepEqual(parse(wrapped), fromMarkdown(wrapped));
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "通常textの角括弧や未閉じlabel内でも完成したCodex file参照を正確なpathへのlinkとして解釈する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#assistant-file-references" }
// fault = "成立しないMarkdown labelまで既存linkと判定し、完成した成果物参照を操作不能なraw記法として残す"
// observable = "public Markdown parserとremark consumerのlink target・label・source offset"
// observation_boundary = "consumer"
// scope = "Codex file referenceの通常角括弧文脈"
// lifecycle = "permanent"
// impact = "通常の補足表現に含まれる生成成果物を開けず、表示と検索に内部属性が露出する"
// distinction = "型検査や既存link除外testでは、未成立labelと完成した参照の組合せを判定できない。短い固定文字列で両parser consumerを検証する"
// @end-test-value
test("ordinary brackets and unresolved labels allow completed file references", () => {
  for (const { path, source } of [
    { path: "/work/a.html", source: visualize("/work/a.html") },
    { path: "/work/a.xlsx", source: ':codex-file-citation{path="/work/a.xlsx"}' },
  ]) {
    for (const wrapped of [`[${source}]`, `参考 [${source}]`, `未閉じ [ ${source}`, `[[${source}]]`, `![${source}]`, `[${source}][undefined]`]) {
      const tree = parse(wrapped);
      const references = links(tree);
      assert.equal(references.length, 1, wrapped);
      assert.equal(references[0].url, path);
      assert.deepEqual(references[0].children, [{ type: "text", value: source.startsWith("visualize") ? "a.html" : path }]);
      assert.equal(wrapped.slice(references[0].position?.start.offset, references[0].position?.end.offset), source);
      assert.deepEqual(unified().use(remarkParse).use(remarkProviderResponse, "codex").parse(wrapped), tree);
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "不正・非local・live・未完の参照は完了済みlocal file linkとして扱わない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "HTTPやlive参照がlocal file操作へ渡る、またはstream中の未完pathが操作可能になる"
// observable = "public Markdown parser出力のlinkの有無とstream完了後のtarget"
// observation_boundary = "consumer"
// scope = "file-reference validation and incremental input"
// lifecycle = "permanent"
// impact = "無関係なURLや不完全なpathを成果物として誤って操作する"
// distinction = "静的検査はruntime文字列の妥当性とstream prefixを検証できない。小さい入力集合と単一参照のprefixで継続負担を限定する"
// @end-test-value
test("invalid nonlocal live and incomplete references never become file links", () => {
  const invalid = [
    "visualize{broken}", "visualize[]", 'visualize{"title":"no path"}',
    'visualize{"path":"/a.html","mode":"live"}',
    ':codex-file-citation{path="/a.xlsx" mode="live"}',
    ':codex-file-citation{path="/a.xlsx" path="/b.xlsx"}',
    ':codex-file-citation{path="/a.xlsx"purpose="output"}',
    ':codex-file-citation{path=/a.xlsx}',
    ...["", "relative.html", "https://example.com/a.html", "javascript:alert(1)", "//example.com/a.html", "artifact://book", "file://%", "/bad\u0000.html", "/bad\ud800.html", "/bad\udc00.html"].flatMap((path) => [
      visualize(path), `:codex-file-citation{path="${path}"}`,
    ]),
  ];
  for (const source of invalid) assert.deepEqual(links(parse(source)), [], source);
  for (const reference of [visualize("/work/a.html"), ':codex-file-citation{path="/work/a.xlsx" purpose="output"}']) {
    for (let offset = 1; offset < reference.length; offset++) {
      assert.deepEqual(links(parse(`前 ${reference.slice(0, offset)}`)), [], `prefix ${offset}`);
    }
    const completed = `前 ${reference} 後 **完了**`;
    assert.equal(links(parse(completed)).length, 1);
    assert.deepEqual(unified().use(remarkParse).use(remarkProviderResponse, "codex").parse(completed), parse(completed));
  }
});
