export const APPROVAL_MODE_VALUES = ["never", "on-request", "on-failure", "untrusted"] as const;

export type ApprovalMode = (typeof APPROVAL_MODE_VALUES)[number];

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "untrusted";

export const approvalModeOptions = [
  { id: "never", label: "never" },
  { id: "on-request", label: "on-request" },
  { id: "on-failure", label: "on-failure" },
  { id: "untrusted", label: "untrusted" },
] as const satisfies Array<{ id: ApprovalMode; label: string }>;

const LEGACY_APPROVAL_MODE_MAP = {
  "allow-all": "never",
  safety: "untrusted",
  "provider-controlled": "on-request",
} as const satisfies Record<string, ApprovalMode>;

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

export function mapApprovalModeToCodexPolicy(approvalMode: string): ApprovalMode {
  return normalizeApprovalMode(approvalMode, DEFAULT_APPROVAL_MODE);
}
