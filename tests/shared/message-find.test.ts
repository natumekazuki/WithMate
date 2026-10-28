import assert from "node:assert/strict";
import test from "node:test";
import { createMessageSearchProjection, iterateMessageSearchMatches } from "../../src-shared/session/message-find.js";

// @test-value v2
// kind = "contract"
// claim = "Preview検索は表示一致とraw-only出現を統合し、同じ元出現だけを重複排除する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/887" }
// fault = "rawと表示の件数を単純加算するか同文言の別pathを同一出現として捨てる"
// observable = "共有matcherのkind、source offset、rendered occurrence番号と一致件数"
// observation_boundary = "public-boundary"
// scope = "chat raw/rendered search union"
// lifecycle = "permanent"
// impact = "検索件数と次候補移動が重複し、リンク先の一致を見落とす"
// distinction = "型検査とDOM投影testでは原文と表示の出現対応を検証しない。小さい文字列fixtureで順序と範囲を直接検証する"
// @end-test-value
test("表示と原文の同一出現だけを統合する", () => {
  const text = "**needle** [needle](C:/needle/sample.md) needle";
  const projection = createMessageSearchProjection(text);
  const matches = [...iterateMessageSearchMatches(projection, "needle", "preview")];
  assert.deepEqual(matches.map((match) => match.kind), ["rendered", "rendered", "rendered", "source"]);
  assert.deepEqual(matches.slice(0, 3).map((match) => match.renderedOccurrenceIndex), [0, 1, 2]);
  assert.equal(matches[3].startOffset, text.indexOf("needle/sample"));
  assert.deepEqual([...iterateMessageSearchMatches(projection, "sample.md", "preview")], [{ kind: "source", startOffset: text.indexOf("sample.md"), endOffset: text.indexOf("sample.md") + 9 }]);
  assert.equal([...iterateMessageSearchMatches(projection, "needle", "source")].length, 4);
});

// @test-value v2
// kind = "contract"
// claim = "Markdownの変換とfootnote並べ替え後も可視出現は一度、属性・未参照本文など原文固有の出現は残る"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/887" }
// fault = "text node全体のoffset差や同文言の出現順だけで対応付け、entity内の別出現を捨てるか可視本文を二重計上する"
// observable = "Markdown fixtureごとの一致kindと件数、原文固有entity部分のoffset"
// observation_boundary = "public-boundary"
// scope = "Markdown source occurrence mapping"
// lifecycle = "permanent"
// impact = "一般的な引用・コード・脚注を検索すると件数と対象箇所がずれる"
// distinction = "rendererとの文字列一致testは原文位置を観測しない。parser変換の境界だけを小さい表で検証する"
// @end-test-value
test("変換されたMarkdownの元出現を対応付ける", () => {
  for (const [text, query, kinds] of [
    ["> alpha\n> needle", "needle", ["rendered"]],
    ["- alpha\n  needle", "needle", ["rendered"]],
    ["foo \nbar", "foo", ["rendered"]],
    ["- a\n- needle \n  bar", "needle", ["rendered"]],
    ["foo\r\nneedle", "needle", ["rendered"]],
    ["foo\r\nneedle", "foo\r\nneedle", ["rendered"]],
    ["foo\r\nneedle \r\nbar", "needle", ["rendered"]],
    ["a \\*needle\\*", "needle", ["rendered"]],
    ["&amp;amp;", "amp", ["rendered", "source"]],
    ["`needle`", "needle", ["rendered"]],
    ["` needle `", "needle", ["rendered"]],
    ["> `alpha\n> needle`", "needle", ["rendered"]],
    ["```ts\nneedle\nneedle\n```", "needle\nneedle", ["rendered"]],
    ["```ts\r\nneedle\r\n```", "needle", ["rendered"]],
    ["    needle\n    needle", "needle", ["rendered", "rendered"]],
    ["---\nkey: needle\n---", "needle", ["rendered"]],
    ["---\nkey: 'needle needle'\n---", "needle", ["rendered", "rendered"]],
    ["---\nkey: 'C:\\needle'\n---", "needle", ["rendered"]],
    ["---\r\nkey: [needle]\r\n---", "needle", ["rendered"]],
    ["needle[^b]\n\n[^a]: needle\n[^b]: needle", "needle", ["rendered", "rendered", "source"]],
    ["![needle](needle.png)", "needle", ["source", "source"]],
    ["```mermaid\nneedle\n```", "needle", ["source"]],
    ['visualize{"title":"needle.html","path":"C:/needle.html"}', "needle", ["rendered", "source"]],
    ['visualize{"path":"file:///work/needle%20test.html"}', "needle", ["rendered"]],
    [String.raw`:codex-file-citation{path="/work/a\q\"needle.md"}`, "needle", ["rendered"]],
    [String.raw`:codex-file-citation{path="/work/a\q\"needle.md"}`, String.raw`\q`, ["rendered"]],
    [String.raw`:codex-file-citation{path="/work/a\q\"needle.md"}`, '"', ["rendered", "source", "source"]],
    [String.raw`:codex-file-citation{path="C:\\work\\a\q\"needle.md"}`, "needle", ["rendered"]],
    [String.raw`:codex-file-citation{path="/work/a\\needle.md"}`, String.raw`\\`, ["rendered"]],
  ] as const) {
    const matches = [...iterateMessageSearchMatches(createMessageSearchProjection(text, "codex"), query, "preview")];
    assert.deepEqual(matches.map((match) => match.kind), kinds, text);
    if (text === "&amp;amp;") assert.equal(matches[1].startOffset, 1);
    if (text.includes('"title"')) assert.equal(matches[1].startOffset, text.indexOf("needle"));
  }
});
