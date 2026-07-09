export const CODEX_SANDBOX_MODE_VALUES = [
  "read-only",
  "workspace-write",
  "workspace-write-network",
  "danger-full-access",
] as const;

export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODE_VALUES)[number];

export type CodexSdkSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export const DEFAULT_CODEX_SANDBOX_MODE: CodexSandboxMode = "workspace-write";

export const codexSandboxModeOptions = [
  { id: "read-only", label: "read-only" },
  { id: "workspace-write", label: "workspace-write" },
  { id: "workspace-write-network", label: "workspace-write + network" },
  { id: "danger-full-access", label: "danger-full-access" },
] as const satisfies Array<{ id: CodexSandboxMode; label: string }>;

export function normalizeCodexSandboxMode(
  value: unknown,
  fallback: CodexSandboxMode = DEFAULT_CODEX_SANDBOX_MODE,
): CodexSandboxMode {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  if (CODEX_SANDBOX_MODE_VALUES.includes(normalized as CodexSandboxMode)) {
    return normalized as CodexSandboxMode;
  }

  return fallback;
}

export function codexSandboxModeLabel(value: string): string {
  const normalized = normalizeCodexSandboxMode(value);
  return codexSandboxModeOptions.find((option) => option.id === normalized)?.label ?? value;
}

export function resolveCodexSandboxThreadOptions(mode: CodexSandboxMode): {
  sandboxMode: CodexSdkSandboxMode;
  networkAccessEnabled: boolean;
} {
  if (mode === "workspace-write-network") {
    return {
      sandboxMode: "workspace-write",
      networkAccessEnabled: true,
    };
  }

  return {
    sandboxMode: mode,
    networkAccessEnabled: false,
  };
}
