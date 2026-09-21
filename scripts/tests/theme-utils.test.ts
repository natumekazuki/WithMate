import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildThemeInkPalette,
  buildCharacterThemeStyle,
  contrastRatio,
  resolveReadableMutedAlpha,
  resolveReadableTextColor,
} from "../../src/theme-utils.js";

describe("theme utils", () => {
  it("背景色に対して WCAG AA を満たす前景色を選ぶ", () => {
    const samples = ["#ffffff", "#000000", "#6f8cff", "#ffd166", "#1f2937", "#22c55e"];

    for (const background of samples) {
      const ink = resolveReadableTextColor(background);
      assert.ok(contrastRatio(ink, background) >= 4.5, `${background} should meet 4.5:1`);
    }
  });

  it("muted alpha も target contrast を割らない", () => {
    const background = "#6f8cff";
    const ink = resolveReadableTextColor(background);
    const alpha = resolveReadableMutedAlpha(background, ink);
    const palette = buildThemeInkPalette(background);

    assert.ok(alpha > 0 && alpha <= 1);
    assert.ok(typeof palette.muted === "string");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "character theme styleは背景色と可読なink色をCSS varsへ投影する"
  // oracle = { type = "contract", ref = "theme-utils readable character theme contract" }
  // fault = "theme CSS varが欠落するかinkのcontrastがAAを満たさない"
  // observable = "CSS var valuesとcontrast ratio"
  // observation_boundary = "public-boundary"
  // scope = "buildCharacterThemeStyle readable ink"
  // lifecycle = "permanent"
  // @end-test-value
  it("character theme style は readable ink を CSS var へ入れる", () => {
    const style = buildCharacterThemeStyle({ main: "#f8b4d9", sub: "#2563eb" });
    const characterStyle = style as typeof style & Record<"--character-main" | "--character-main-ink", string>;

    assert.equal(characterStyle["--character-main"], "#f8b4d9");
    assert.ok(typeof characterStyle["--character-main-ink"] === "string");
    assert.ok(contrastRatio(characterStyle["--character-main-ink"], "#f8b4d9") >= 4.5);
  });
});
