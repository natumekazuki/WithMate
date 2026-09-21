import type { RuntimeSelectOption } from "./provider-runtime-options.js";

export const CODEX_SPEED_VALUES = ["standard", "fast"] as const;
export type CodexSpeed = (typeof CODEX_SPEED_VALUES)[number];

export const DEFAULT_CODEX_SPEED: CodexSpeed = "standard";

export const codexSpeedOptions = [
  { value: "standard", label: "Standard" },
  { value: "fast", label: "Fast" },
] as const satisfies readonly RuntimeSelectOption<CodexSpeed>[];

export type CodexServiceTier = "default" | "fast";

export function normalizeCodexSpeed(value: unknown): CodexSpeed {
  return value === "fast" ? "fast" : DEFAULT_CODEX_SPEED;
}

export function mapCodexSpeedToServiceTier(speed: CodexSpeed): CodexServiceTier {
  return speed === "fast" ? "fast" : "default";
}

export function getCodexSpeedOptions(
  providerId: string | null | undefined,
): RuntimeSelectOption<CodexSpeed>[] {
  return providerId === "codex" ? codexSpeedOptions.map((option) => ({ ...option })) : [];
}
