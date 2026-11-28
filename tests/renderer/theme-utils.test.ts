import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildThemeInkPalette,
  buildCharacterThemeStyle,
  contrastRatio,
  resolveReadableMutedAlpha,
  resolveReadableTextColor,
} from "../../src/ui/theme-utils.js";

/** 背景に合う前景色の選択とキャラクター配色のCSS変数への反映を検証する。 */
describe("theme utils", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "白・黒・代表的な有彩色の背景に対して選択された前景色はAAの4.5対1を満たす"
  // oracle = { type = "contract", ref = "src/ui/theme-utils.ts: resolveReadableTextColor and contrastRatio" }
  // fault = "明るい背景にも白い前景色を返すなど、指定背景に対して不十分なcontrastを選ぶ"
  // observable = "6背景色と選択したinkのcontrastRatioが各々4.5以上"
  // observation_boundary = "public-boundary"
  // scope = "resolveReadableTextColorの代表背景入力に対する可読色選択"
  // lifecycle = "permanent"
  // @end-test-value
  /** 明暗と色相が異なる代表背景に対し、選んだ前景色が4.5対1以上のコントラストを持つことを確認する。 */
  it("背景色に対して WCAG AA を満たす前景色を選ぶ", () => {
    const samples = [
      "#ffffff",
      "#000000",
      "#6f8cff",
      "#ffd166",
      "#1f2937",
      "#22c55e",
    ];

    for (const background of samples) {
      const ink = resolveReadableTextColor(background);
      assert.ok(
        contrastRatio(ink, background) >= 4.5,
        `${background} should meet 4.5:1`,
      );
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "muted foregroundのalphaは正の不透明度範囲にあり、paletteはmuted色を文字列として公開する"
  // oracle = { type = "contract", ref = "src/ui/theme-utils.ts: resolveReadableMutedAlpha and buildThemeInkPalette" }
  // fault = "muted alphaが0以下か1超になる、またはpaletteのmuted色が欠落する"
  // observable = "alphaの0より大きく1以下という範囲とpalette.mutedのstring型"
  // observation_boundary = "public-boundary"
  // scope = "背景#6f8cffでのmuted alpha範囲とpalette出力shape。実描画contrastの検証ではない"
  // lifecycle = "permanent"
  // @end-test-value
  /** 補助色の透明度が正の有効範囲に収まり、パレットから文字列で取得できることを確認する。 */
  it("muted alphaとpaletteは有効な出力形式を返す", () => {
    const background = "#6f8cff";
    const ink = resolveReadableTextColor(background);
    const alpha = resolveReadableMutedAlpha(background, ink);
    const palette = buildThemeInkPalette(background);

    assert.ok(alpha > 0 && alpha <= 1);
    assert.ok(typeof palette.muted === "string");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "character theme styleはmain/subの色とsoft背景、可読なmain inkをCSS varsへ投影する"
  // oracle = { type = "contract", ref = "theme-utils readable character theme contract" }
  // fault = "themeのmain/subまたはsoft CSS varが欠落するかmain inkのcontrastがAAを満たさない"
  // observable = "main/sub/soft CSS var valuesとmain inkのcontrast ratio"
  // observation_boundary = "public-boundary"
  // scope = "buildCharacterThemeStyle readable ink"
  // lifecycle = "permanent"
  // @end-test-value
  /** 配色と淡い背景色がCSS変数に反映され、メイン背景に対する文字色がAA基準を満たすことを確認する。 */
  it("character theme style は readable ink を CSS var へ入れる", () => {
    const style = buildCharacterThemeStyle({ main: "#f8b4d9", sub: "#2563eb" });
    const characterStyle = style as Record<string, string>;

    assert.deepEqual(
      {
        main: characterStyle["--character-main"],
        sub: characterStyle["--character-sub"],
        mainSoft: characterStyle["--character-main-soft"],
        subSoft: characterStyle["--character-sub-soft"],
      },
      {
        main: "#f8b4d9",
        sub: "#2563eb",
        mainSoft: "rgba(248, 180, 217, 0.14)",
        subSoft: "rgba(37, 99, 235, 0.14)",
      },
    );
    assert.ok(typeof characterStyle["--character-main-ink"] === "string");
    assert.ok(
      contrastRatio(characterStyle["--character-main-ink"], "#f8b4d9") >= 4.5,
    );
  });
});
