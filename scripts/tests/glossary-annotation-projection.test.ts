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

  it("message文字数上限を超えたtext nodeは注釈せず本文投影へ返せる", () => {
    const matcher = createGlossaryAnnotationMatcher([entry("Runtime")], "revision-1");
    const budget = matcher.createMessageBudget();
    const text = `${"x".repeat(GLOSSARY_ANNOTATION_LIMITS.maxMessageCodeUnits)} Runtime`;

    assert.deepEqual(matcher.matchText(text, budget), []);
    assert.equal(budget.limitReached, true);
  });
});
