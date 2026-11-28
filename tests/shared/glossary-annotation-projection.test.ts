import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GLOSSARY_ANNOTATION_LIMITS,
  createGlossaryAnnotationMatcher,
} from "../../src/glossary/glossary-annotation-projection.js";
import type { GlossaryEntry } from "../../src-shared/glossary/glossary-contract.js";

/** 用語と別名を比較するため、定義を省略できる用語集項目を組み立てる。 */
function entry(
  term: string,
  definition = `${term} definition`,
  aliases: string[] = [],
): GlossaryEntry {
  return { term, aliases, definition };
}

/** 用語注釈の範囲、別名解決、再投影と上限の扱いを確認する。 */
describe("GLOSSARY-ANNOTATION-PROJECTION", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "message投影の再利用でも先行node変更後の共有budgetとrangeは新規投影と一致する"
  // oracle = { type = "contract", ref = "docs/design/message-rich-text.md#repository-glossary-annotation" }
  // fault = "cached nodeが以前の残budgetを使い、注釈上限または本文文字数上限を超える"
  // observable = "nodeごとの注釈rangeと最終message budget"
  // observation_boundary = "consumer"
  // scope = "glossary message projection budget replay"
  // lifecycle = "permanent"
  // distinction = "単発matcher testでは観測しない、node再利用と先行node変更を通したbudgetの整合を小さな固定入力で検証する"
  // @end-test-value
  /** 再利用されたテキストノードでも、新しい描画で残っている注釈数と文字数の上限が適用され、初回検索と同じ結果になる。 */
  it("再利用したnodeにも現在の共有budgetを適用する", () => {
    const matcher = createGlossaryAnnotationMatcher([entry("Runtime")], "r1");
    const owner = matcher.createMessageProjection();
    for (const first of [
      "Runtime ".repeat(199),
      "Runtime ".repeat(198),
      `${"x ".repeat(49_997)}x`,
      "x",
    ]) {
      const budget = owner.begin();
      const freshBudget = matcher.createMessageBudget();
      for (const text of [first, "Runtime Runtime"]) {
        assert.deepEqual(
          owner.matchText(text, budget),
          matcher.matchText(text, freshBudget),
        );
      }
      owner.finish();
      assert.deepEqual(budget, freshBudget);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "append末尾投影は結合文字、Greek lowercase、空白、NFKC展開と本文置換でも全文投影のUTF-16 rangeを維持する"
  // oracle = { type = "contract", ref = "docs/design/message-rich-text.md#repository-glossary-annotation" }
  // fault = "末尾graphemeまたはcasing contextを確定済みとして再利用し、古いrangeや不正offsetを返す"
  // observable = "各snapshotの注釈rangeとbudget、結合文字の明示UTF-16 range"
  // observation_boundary = "consumer"
  // scope = "glossary append Unicode projection"
  // lifecycle = "permanent"
  // distinction = "既存の単発Unicode testに対して、同一ownerの追記・短縮・置換を通すことで再利用特有の誤りを検出する"
  // @end-test-value
  /** 編集中の結合文字・改行・字形・URL 境界で、差分投影の注釈範囲と消費量が全文を取り直した結果と一致する。 */
  it("streaming末尾のUnicode contextを全文投影と同値に保つ", () => {
    const matcher = createGlossaryAnnotationMatcher(
      [
        entry("Runtime"),
        entry("é"),
        entry("ΟΣ"),
        entry("ΟΣΑ"),
        entry("ff"),
        entry("İ"),
      ],
      "r1",
    );
    const owner = matcher.createMessageProjection();
    const snapshots = [
      "  Runtime e",
      "  Runtime e\u0301",
      "  Runtime e\u0301 ΟΣ",
      "  Runtime e\u0301 ΟΣΑ",
      "Runtime ΟΣ'",
      "Runtime ΟΣ'Α",
      "Runtime \u0301\u0302e",
      "Runtime \u0301\u0302e\u0301",
      "Runtime \r",
      "Runtime \r\nﬀ",
      "Runtime \r\nﬀ  İ",
      "Runtime \r\nﬀ  İ\u0301",
      "Runtime \u0600 e",
      "Runtime \u0600 e\u0301",
      "Runtime 👩",
      "Runtime 👩‍💻",
      "Runtime e\u0301",
      "Runtime",
      "é Runtime",
      "Runtime https://host.test/",
      "Runtime https://host.test/Runtime",
    ];
    for (const text of snapshots) {
      const budget = owner.begin();
      const freshBudget = matcher.createMessageBudget();
      const actual = owner.matchText(text, budget);
      assert.deepEqual(actual, matcher.matchText(text, freshBudget), text);
      owner.finish();
      assert.deepEqual(budget, freshBudget, text);
      if (text === "Runtime e\u0301") {
        assert.deepEqual(
          actual.map(({ start, end }) => [start, end]),
          [
            [0, 7],
            [8, 10],
          ],
        );
      }
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "空候補と同一nodeは分割せず、空白境界付き追記は変更末尾だけを分割して注釈を更新する"
  // oracle = { type = "contract", ref = "docs/design/message-rich-text.md#repository-glossary-annotation" }
  // fault = "内容不変または追記済みprefixを毎回Segmenterへ渡し、長文streamingの同期負荷を増幅する"
  // observable = "Segmenterへ渡した入力長と公開された注釈range"
  // observation_boundary = "consumer"
  // scope = "glossary finite owner work reuse"
  // lifecycle = "permanent"
  // impact = "長文会話のrenderer入力・scrollを妨げるCPU処理の増幅を防ぐ"
  // distinction = "型と通常の一致testでは処理量を観測できないため、固定replayの分割入力量だけを低コストで監視する"
  // @end-test-value
  /** 空の用語集と変更のない本文を再分割せず、追記時の書記素分割も新しい末尾付近に収まることを、分割器の入力長で確認する。 */
  it("空候補と同一内容では分割せず追記の分割量を末尾へ限定する", () => {
    const segment = Intl.Segmenter.prototype.segment;
    const inputs: number[] = [];
    Intl.Segmenter.prototype.segment = function (value: string) {
      inputs.push(value.length);
      return segment.call(this, value);
    };
    try {
      const empty = createGlossaryAnnotationMatcher([], "empty");
      assert.deepEqual(
        empty.matchText("Runtime ".repeat(100), empty.createMessageBudget()),
        [],
      );
      assert.deepEqual(inputs, []);
      const matcher = createGlossaryAnnotationMatcher([entry("Runtime")], "r1");
      const owner = matcher.createMessageProjection();
      const first = "Runtime と ".repeat(100);
      for (const text of [first, first, `${first}Runtime`]) {
        const budget = owner.begin();
        assert.ok(owner.matchText(text, budget).length > 0);
        owner.finish();
      }
      assert.ok(inputs.length <= 2);
      assert.equal(inputs[0], first.length);
      assert.ok(
        inputs.reduce((total, length) => total + length, 0) <=
          first.length + 10,
        JSON.stringify(inputs),
      );
    } finally {
      Intl.Segmenter.prototype.segment = segment;
    }
  });

  /** 先に登録された短い用語より長く一致する用語を優先し、その別名も同じ正規用語と定義へ解決する。 */
  it("重なる候補はYAML順より最長一致を優先し、aliasをcanonical termへ解決する", () => {
    const matcher = createGlossaryAnnotationMatcher(
      [entry("Runtime"), entry("Session Runtime", "complete", ["実行環境"])],
      "revision-1",
    );
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

  /** 英数字・アンダースコアで続く識別子や長い日本語用語の内部は注釈せず、独立した用語を残す。 */
  it("identifier内部には一致させず、区切られた用語だけを注釈する", () => {
    const matcher = createGlossaryAnnotationMatcher(
      [entry("Runtime"), entry("API"), entry("実行環境")],
      "revision-1",
    );

    assert.deepEqual(
      matcher
        .matchText(
          "SessionRuntime Runtime Runtime2 _Runtime Runtime_ APIを 仮想実行環境と実行環境",
          matcher.createMessageBudget(),
        )
        .map((match) => match.matchedText),
      ["Runtime", "API", "実行環境"],
    );
  });

  /** 分解表現で書いた文字が NFKC で用語に一致しても、注釈は元の二つの UTF-16 コード単位を指す。 */
  it("NFKCで一致しても元UTF-16範囲を保持する", () => {
    const matcher = createGlossaryAnnotationMatcher([entry("é")], "revision-1");
    const text = "x e\u0301 y";

    assert.deepEqual(matcher.matchText(text, matcher.createMessageBudget()), [
      {
        start: 2,
        end: 4,
        matchedText: "e\u0301",
        canonicalTerm: "é",
        definition: "é definition",
      },
    ]);
  });

  /** ギリシャ語の語末で小文字化が文脈に依存しても、正規用語を引けて元の二文字を指すことを確認する。 */
  it("context-sensitive lowercaseでもcanonical lookupと同じ結果と元範囲を使う", () => {
    const matcher = createGlossaryAnnotationMatcher(
      [entry("ΟΣ")],
      "revision-1",
    );

    assert.deepEqual(matcher.matchText("ΟΣ", matcher.createMessageBudget()), [
      {
        start: 0,
        end: 2,
        matchedText: "ΟΣ",
        canonicalTerm: "ΟΣ",
        definition: "ΟΣ definition",
      },
    ]);
  });

  /** 合字を展開した一部分だけの一致は除外し、合字全体に一致するときは元の一文字を指す。 */
  it("正規化で展開されたgraphemeの途中だけに一致する候補は別範囲として装飾しない", () => {
    const partialMatcher = createGlossaryAnnotationMatcher(
      [entry("f")],
      "revision-1",
    );
    const completeMatcher = createGlossaryAnnotationMatcher(
      [entry("ff")],
      "revision-1",
    );

    assert.deepEqual(
      partialMatcher.matchText("ﬀ", partialMatcher.createMessageBudget()),
      [],
    );
    assert.deepEqual(
      completeMatcher.matchText("ﬀ", completeMatcher.createMessageBudget()),
      [
        {
          start: 0,
          end: 1,
          matchedText: "ﬀ",
          canonicalTerm: "ff",
          definition: "ff definition",
        },
      ],
    );
  });

  /** 通常の文章に現れる用語だけを注釈し、HTTP URL、ファイル URL、メールアドレスの内部にある同じ語は除外する。 */
  it("URL内部の一致は除外し、同じtext nodeの通常textは維持する", () => {
    const matcher = createGlossaryAnnotationMatcher(
      [entry("Runtime")],
      "revision-1",
    );

    assert.deepEqual(
      matcher
        .matchText(
          "https://example.test/Runtime と Runtime、file://repo/Runtime、Runtime@example.test",
          matcher.createMessageBudget(),
        )
        .map((match) => match.matchedText),
      ["Runtime"],
    );
  });

  /** 注釈数の上限を超える入力には上限までの結果を返し、それ以上残っていることを budget に記録する。 */
  it("message上限に達した後は追加注釈を止めるが本文budgetを明示する", () => {
    const matcher = createGlossaryAnnotationMatcher(
      [entry("用語")],
      "revision-1",
    );
    const budget = matcher.createMessageBudget();
    const text = Array.from(
      { length: GLOSSARY_ANNOTATION_LIMITS.maxAnnotationsPerMessage + 10 },
      () => "用語",
    ).join(" ");
    const matches = matcher.matchText(text, budget);

    assert.equal(
      matches.length,
      GLOSSARY_ANNOTATION_LIMITS.maxAnnotationsPerMessage,
    );
    assert.equal(budget.limitReached, true);
  });

  /** 登録件数自体は許容されても別名を含む候補が多すぎる場合は、注釈を無効化し一致を返さない。 */
  it("matcher候補上限を超えるvalidサイズの用語集は注釈だけを無効化する", () => {
    const entries = Array.from({ length: 500 }, (_, entryIndex) =>
      entry(
        `term-${entryIndex}`,
        "definition",
        Array.from(
          { length: 20 },
          (_, aliasIndex) => `alias-${entryIndex}-${aliasIndex}`,
        ),
      ),
    );
    const matcher = createGlossaryAnnotationMatcher(entries, "revision-1");

    assert.equal(matcher.disabledByLimit, true);
    assert.deepEqual(
      matcher.matchText("term-0", matcher.createMessageBudget()),
      [],
    );
  });

  /** 文字数上限を超える単一ノードは途中まで注釈せず、結果を空にして上限到達を通知する。 */
  it("message文字数上限を超えたtext nodeは注釈せず本文投影へ返せる", () => {
    const matcher = createGlossaryAnnotationMatcher(
      [entry("Runtime")],
      "revision-1",
    );
    const budget = matcher.createMessageBudget();
    const text = `${"x".repeat(GLOSSARY_ANNOTATION_LIMITS.maxMessageCodeUnits)} Runtime`;

    assert.deepEqual(matcher.matchText(text, budget), []);
    assert.equal(budget.limitReached, true);
  });
});
