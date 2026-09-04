import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GLOSSARY_ANNOTATION_LIMITS,
  createGlossaryAnnotationMatcher,
} from "../../src/glossary/glossary-annotation-projection.js";
import type { GlossaryEntry } from "../../src/glossary-contract.js";

function entry(term: string, definition = `${term} definition`, aliases: string[] = []): GlossaryEntry {
  return { term, aliases, definition };
}

describe("GLOSSARY-ANNOTATION-PROJECTION", () => {
  // @test-value v1
  // kind = "contract"
  // claim = "重なるGlossary候補では最長一致を選び、aliasの表示注釈をcanonical termへ結び付ける"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "短い候補やalias名をcanonical termより優先し、本文へ誤った用語注釈を付ける"
  // scope = "glossary-message-annotation-matching"
  // lifecycle = "permanent"
  // @end-test-value
  it("重なる候補はYAML順より最長一致を優先し、aliasをcanonical termへ解決する", () => {
    const matcher = createGlossaryAnnotationMatcher([
      entry("Runtime"),
      entry("Session Runtime", "complete", ["実行環境"]),
    ], "revision-1");
    const budget = matcher.createMessageBudget();

    assert.deepEqual(matcher.matchText("Session Runtime と実行環境", budget), [
      {
        start: 0,
        end: 15,
        matchedText: "Session Runtime",
        canonicalTerm: "Session Runtime",
        definition: "complete",
      },
      {
        start: 17,
        end: 21,
        matchedText: "実行環境",
        canonicalTerm: "Session Runtime",
        definition: "complete",
      },
    ]);
  });

  // @test-value v1
  // kind = "contract"
  // claim = "Glossary用語はidentifier内部へ部分一致させず、語境界で区切られた出現だけを注釈する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "長いidentifierの一部を用語として誤注釈し、messageの意味を誤投影する"
  // scope = "glossary-message-annotation-boundary"
  // lifecycle = "permanent"
  // @end-test-value
  it("identifier内部には一致させず、区切られた用語だけを注釈する", () => {
    const matcher = createGlossaryAnnotationMatcher([
      entry("Runtime"),
      entry("API"),
      entry("実行環境"),
    ], "revision-1");

    assert.deepEqual(
      matcher.matchText(
        "SessionRuntime Runtime Runtime2 _Runtime Runtime_ APIを 仮想実行環境と実行環境",
        matcher.createMessageBudget(),
      )
        .map((match) => match.matchedText),
      ["Runtime", "API", "実行環境"],
    );
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "NFKC正規化で一致した注釈もrendererへ返す範囲は元textのUTF-16 offsetを保持する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "正規化後offsetを元textへ適用して別文字を装飾するか範囲外を返す"
  // scope = "glossary-message-annotation-offset"
  // lifecycle = "permanent"
  // @end-test-value
  it("NFKCで一致しても元UTF-16範囲を保持する", () => {
    const matcher = createGlossaryAnnotationMatcher([entry("é")], "revision-1");
    const text = "x e\u0301 y";

    assert.deepEqual(matcher.matchText(text, matcher.createMessageBudget()), [{
      start: 2,
      end: 4,
      matchedText: "e\u0301",
      canonicalTerm: "é",
      definition: "é definition",
    }]);
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "文脈依存の小文字化を含む入力でもcanonical lookupと同じ一致結果と元text範囲を返す"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "case foldingの文脈差でlookupと注釈が不一致になるか、誤ったoffsetを返す"
  // scope = "glossary-message-annotation-normalization"
  // lifecycle = "permanent"
  // @end-test-value
  it("context-sensitive lowercaseでもcanonical lookupと同じ結果と元範囲を使う", () => {
    const matcher = createGlossaryAnnotationMatcher([entry("ΟΣ")], "revision-1");

    assert.deepEqual(matcher.matchText("ΟΣ", matcher.createMessageBudget()), [{
      start: 0,
      end: 2,
      matchedText: "ΟΣ",
      canonicalTerm: "ΟΣ",
      definition: "ΟΣ definition",
    }]);
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "一つのgraphemeが正規化で複数文字へ展開されても、その一部だけの候補を独立範囲として注釈しない"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "元textで分離不能なgrapheme内部へ部分注釈を返しrenderer範囲を壊す"
  // scope = "glossary-message-annotation-grapheme"
  // lifecycle = "permanent"
  // @end-test-value
  it("正規化で展開されたgraphemeの途中だけに一致する候補は別範囲として装飾しない", () => {
    const partialMatcher = createGlossaryAnnotationMatcher([entry("f")], "revision-1");
    const completeMatcher = createGlossaryAnnotationMatcher([entry("ff")], "revision-1");

    assert.deepEqual(partialMatcher.matchText("ﬀ", partialMatcher.createMessageBudget()), []);
    assert.deepEqual(completeMatcher.matchText("ﬀ", completeMatcher.createMessageBudget()), [{
      start: 0,
      end: 1,
      matchedText: "ﬀ",
      canonicalTerm: "ff",
      definition: "ff definition",
    }]);
  });

  // @test-value v1
  // kind = "contract"
  // claim = "URL内部の用語候補は除外し、同じtext nodeにある通常textの用語候補は維持する"
  // oracle = { type = "contract", ref = "docs/features/repository-glossary.md" }
  // failure_mode = "リンクURLを誤注釈するか、URL除外によって同一nodeの通常textまで失う"
  // scope = "glossary-message-annotation-url"
  // lifecycle = "permanent"
  // @end-test-value
  it("URL内部の一致は除外し、同じtext nodeの通常textは維持する", () => {
    const matcher = createGlossaryAnnotationMatcher([entry("Runtime")], "revision-1");

    assert.deepEqual(
      matcher.matchText(
        "https://example.test/Runtime と Runtime、file://repo/Runtime、Runtime@example.test",
        matcher.createMessageBudget(),
      ).map((match) => match.matchedText),
      ["Runtime"],
    );
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "message単位の注釈上限到達後は追加annotationを止め、consumerへ使用済み本文budgetを返す"
  // oracle = { type = "contract", ref = "docs/features/repository-glossary.md" }
  // failure_mode = "注釈件数が上限を超えるか、budgetを過少報告して後続nodeが再処理される"
  // scope = "glossary-message-annotation-limit"
  // lifecycle = "permanent"
  // @end-test-value
  it("message上限に達した後は追加注釈を止めるが本文budgetを明示する", () => {
    const matcher = createGlossaryAnnotationMatcher([entry("用語")], "revision-1");
    const budget = matcher.createMessageBudget();
    const text = Array.from(
      { length: GLOSSARY_ANNOTATION_LIMITS.maxAnnotationsPerMessage + 10 },
      () => "用語",
    ).join(" ");
    const matches = matcher.matchText(text, budget);

    assert.equal(matches.length, GLOSSARY_ANNOTATION_LIMITS.maxAnnotationsPerMessage);
    assert.equal(budget.limitReached, true);
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "matcher候補上限を超えるvalid Glossaryはsource projectionを保ちつつmessage注釈だけを無効化する"
  // oracle = { type = "contract", ref = "docs/features/repository-glossary.md" }
  // failure_mode = "大きいがvalidなGlossary全体をinvalid扱いするか、無制限matcher構築でresource上限を破る"
  // scope = "glossary-message-matcher-limit"
  // lifecycle = "permanent"
  // @end-test-value
  it("matcher候補上限を超えるvalidサイズの用語集は注釈だけを無効化する", () => {
    const entries = Array.from({ length: 500 }, (_, entryIndex) => entry(
      `term-${entryIndex}`,
      "definition",
      Array.from({ length: 20 }, (_, aliasIndex) => `alias-${entryIndex}-${aliasIndex}`),
    ));
    const matcher = createGlossaryAnnotationMatcher(entries, "revision-1");

    assert.equal(matcher.disabledByLimit, true);
    assert.deepEqual(matcher.matchText("term-0", matcher.createMessageBudget()), []);
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "message文字数上限を超えたtext nodeは注釈対象外としても本文projection自体は返す"
  // oracle = { type = "contract", ref = "docs/features/repository-glossary.md" }
  // failure_mode = "過大textの注釈処理を続けるか、注釈不能を理由に本文表示まで欠落させる"
  // scope = "glossary-message-text-limit"
  // lifecycle = "permanent"
  // @end-test-value
  it("message文字数上限を超えたtext nodeは注釈せず本文投影へ返せる", () => {
    const matcher = createGlossaryAnnotationMatcher([entry("Runtime")], "revision-1");
    const budget = matcher.createMessageBudget();
    const text = `${"x".repeat(GLOSSARY_ANNOTATION_LIMITS.maxMessageCodeUnits)} Runtime`;

    assert.deepEqual(matcher.matchText(text, budget), []);
    assert.equal(budget.limitReached, true);
  });
});
