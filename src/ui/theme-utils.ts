import type { CSSProperties } from "react";

import {
  DEFAULT_CHARACTER_THEME_COLORS,
  normalizeCharacterThemeColors,
  type CharacterThemeColors,
} from "../../src-shared/character/character-state.js";

const DEFAULT_HEX_FALLBACK = DEFAULT_CHARACTER_THEME_COLORS.main;
const DEFAULT_DARK_INK = "#0f172a";
const DEFAULT_LIGHT_INK = "#f8fafc";
const DEFAULT_TEXT_CONTRAST_TARGET = 4.5;

/** 8ビットの赤・緑・青の成分を持つ色。アルファ値は別に扱う。 */
type RgbColor = { r: number; g: number; b: number };

/** 6桁の16進色だけを小文字に正規化し、適合しないときは指定の代替色を使う。 */
function normalizeHexColor(
  color: string,
  fallback = DEFAULT_HEX_FALLBACK,
): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : fallback;
}

/** 16進色を各チャンネルに分解する。入力が不正な場合の代替色は呼び出し側で指定できる。 */
export function hexToRgb(
  color: string,
  fallback = DEFAULT_HEX_FALLBACK,
): RgbColor {
  const normalized = normalizeHexColor(color, fallback);
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

/** 色のチャンネルに、呼び出し側が指定したアルファ値を付けた CSS の色を返す。 */
export function toRgba(
  color: string,
  alpha: number,
  fallback = DEFAULT_HEX_FALLBACK,
): string {
  const rgb = hexToRgb(color, fallback);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/** sRGB のチャンネルを線形化し、人の視覚に応じた重みで相対輝度を求める。 */
export function relativeLuminance(
  color: string,
  fallback = DEFAULT_HEX_FALLBACK,
): number {
  const rgb = hexToRgb(color, fallback);
  const channels = [rgb.r, rgb.g, rgb.b].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** 前景・背景の順によらず、明るい色と暗い色の相対輝度からコントラスト比を求める。 */
export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

/** 半透明の前景を背景の上に重ね、各チャンネルを整数に丸めた合成色を返す。 */
function compositeForegroundOnBackground(
  foreground: string,
  background: string,
  alpha: number,
): RgbColor {
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  return {
    r: Math.round(fg.r * alpha + bg.r * (1 - alpha)),
    g: Math.round(fg.g * alpha + bg.g * (1 - alpha)),
    b: Math.round(fg.b * alpha + bg.b * (1 - alpha)),
  };
}

/** チャンネルを整数の0〜255に収め、2桁ずつ連結した CSS の16進色にする。 */
function rgbToHex(color: RgbColor): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** 元の前景色ではなく、指定の透明度で背景と合成した結果のコントラストを測る。 */
function contrastRatioForAlpha(
  foreground: string,
  background: string,
  alpha: number,
): number {
  const composited = rgbToHex(
    compositeForegroundOnBackground(foreground, background, alpha),
  );
  return contrastRatio(composited, background);
}

/** 明暗の候補を背景と比較し、目標を満たす候補を優先する。双方同条件なら高い比を選ぶ。 */
export function resolveReadableTextColor(
  background: string,
  options?: {
    minContrast?: number;
    darkCandidate?: string;
    lightCandidate?: string;
  },
): string {
  const minContrast = options?.minContrast ?? DEFAULT_TEXT_CONTRAST_TARGET;
  const darkCandidate = normalizeHexColor(
    options?.darkCandidate ?? DEFAULT_DARK_INK,
    DEFAULT_DARK_INK,
  );
  const lightCandidate = normalizeHexColor(
    options?.lightCandidate ?? DEFAULT_LIGHT_INK,
    DEFAULT_LIGHT_INK,
  );
  const darkRatio = contrastRatio(darkCandidate, background);
  const lightRatio = contrastRatio(lightCandidate, background);

  if (darkRatio >= minContrast && lightRatio >= minContrast) {
    return darkRatio >= lightRatio ? darkCandidate : lightCandidate;
  }

  if (darkRatio >= minContrast) {
    return darkCandidate;
  }

  if (lightRatio >= minContrast) {
    return lightCandidate;
  }

  return darkRatio >= lightRatio ? darkCandidate : lightCandidate;
}

/** 目標のコントラストを保てる不透明度を二分探索で求め、余裕を加える。元の色でも不足するなら不透明のままにする。 */
export function resolveReadableMutedAlpha(
  background: string,
  foreground: string,
  minContrast = DEFAULT_TEXT_CONTRAST_TARGET,
): number {
  if (contrastRatio(foreground, background) < minContrast) {
    return 1;
  }

  let low = 0;
  let high = 1;
  for (let index = 0; index < 24; index += 1) {
    const mid = (low + high) / 2;
    if (contrastRatioForAlpha(foreground, background, mid) >= minContrast) {
      high = mid;
    } else {
      low = mid;
    }
  }

  const safeAlpha = Math.min(1, high + 0.08);
  return Number(safeAlpha.toFixed(3));
}

/** 背景に合わせた通常の前景色と、同じ色を半透明にした控えめな表示用の組を作る。 */
export function buildThemeInkPalette(
  background: string,
  options?: {
    minContrast?: number;
  },
): {
  ink: string;
  muted: string;
} {
  const minContrast = options?.minContrast ?? DEFAULT_TEXT_CONTRAST_TARGET;
  const ink = resolveReadableTextColor(background, { minContrast });
  const mutedAlpha = resolveReadableMutedAlpha(background, ink, minContrast);
  return {
    ink,
    muted: toRgba(ink, mutedAlpha, ink),
  };
}

/** 保存色を正規化し、主色・副色とその淡色、主色上の前景色を CSS 変数として渡す。 */
export function buildCharacterThemeStyle(
  theme: CharacterThemeColors | null | undefined,
): CSSProperties {
  const resolvedTheme = normalizeCharacterThemeColors(
    theme ?? DEFAULT_CHARACTER_THEME_COLORS,
  );
  const inkPalette = buildThemeInkPalette(resolvedTheme.main);
  return {
    "--character-main": resolvedTheme.main,
    "--character-main-soft": toRgba(resolvedTheme.main, 0.14),
    "--character-sub": resolvedTheme.sub,
    "--character-sub-soft": toRgba(resolvedTheme.sub, 0.14),
    "--character-main-ink": inkPalette.ink,
  } as CSSProperties;
}
