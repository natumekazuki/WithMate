import type { CSSProperties } from "react";

import {
  DEFAULT_CHARACTER_THEME_COLORS,
  normalizeCharacterThemeColors,
  type CharacterThemeColors,
} from "./app-state.js";

function hexToRgb(color: string): { r: number; g: number; b: number } {
  const normalized = /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_CHARACTER_THEME_COLORS.main;
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function toRgba(color: string, alpha: number): string {
  const rgb = hexToRgb(color);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function relativeLuminance(color: string): number {
  const rgb = hexToRgb(color);
  const channels = [rgb.r, rgb.g, rgb.b].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function buildCharacterThemeStyle(theme: CharacterThemeColors | null | undefined): CSSProperties {
  const resolvedTheme = normalizeCharacterThemeColors(theme ?? DEFAULT_CHARACTER_THEME_COLORS);
  const mainInk = relativeLuminance(resolvedTheme.main) > 0.36 ? "#0f172a" : "#f8fafc";
  return {
    "--character-main": resolvedTheme.main,
    "--character-main-soft": toRgba(resolvedTheme.main, 0.14),
    "--character-sub": resolvedTheme.sub,
    "--character-sub-soft": toRgba(resolvedTheme.sub, 0.14),
    "--character-main-ink": mainInk,
  } as CSSProperties;
}
