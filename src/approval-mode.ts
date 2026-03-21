export const APPROVAL_MODE_VALUES = ["allow-all", "safety", "provider-controlled"] as const;

export type ApprovalMode = (typeof APPROVAL_MODE_VALUES)[number];

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "safety";

export const approvalModeOptions = [
  { id: "allow-all", label: "自動実行" },
  { id: "safety", label: "安全寄り" },
  { id: "provider-controlled", label: "プロバイダー判断" },
] as const satisfies Array<{ id: ApprovalMode; label: string }>;

const LEGACY_APPROVAL_MODE_MAP = {
  never: "allow-all",
  untrusted: "safety",
  "on-request": "provider-controlled",
  "on-failure": "provider-controlled",
} as const satisfies Record<string, ApprovalMode>;

type CodexApprovalPolicy = "never" | "on-request" | "untrusted";

function resolveApprovalMode(value: unknown): ApprovalMode | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (APPROVAL_MODE_VALUES.includes(normalized as ApprovalMode)) {
    return normalized as ApprovalMode;
  }

  return LEGACY_APPROVAL_MODE_MAP[normalized as keyof typeof LEGACY_APPROVAL_MODE_MAP] ?? null;
}

export function normalizeApprovalMode(value: unknown, fallback: ApprovalMode = DEFAULT_APPROVAL_MODE): ApprovalMode {
  return resolveApprovalMode(value) ?? fallback;
}

export function approvalModeLabel(value: string): string {
  const normalized = resolveApprovalMode(value);
  if (!normalized) {
    return value;
  }

  const option = approvalModeOptions.find((candidate) => candidate.id === normalized);
  if (option) {
    return option.label;
  }

  return value;
}

export function mapApprovalModeToCodexPolicy(approvalMode: string): CodexApprovalPolicy {
  switch (normalizeApprovalMode(approvalMode, DEFAULT_APPROVAL_MODE)) {
    case "allow-all":
      return "never";
    case "safety":
      return "untrusted";
    case "provider-controlled":
    default:
      return "on-request";
  }
}
