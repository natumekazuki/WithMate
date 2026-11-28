/** Codex に直接渡せる承認ポリシーの値。 */
export const CODEX_APPROVAL_MODE_VALUES = [
  "never",
  "on-request",
  "untrusted",
] as const;
/** 他 Provider 向けの承認モードを含まない、Codex へ渡す承認ポリシー。 */
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_MODE_VALUES)[number];

/** 共有設定に保存できる承認モード。Provider ごとの選択可否は別に判定する。 */
export const APPROVAL_MODE_VALUES = [
  ...CODEX_APPROVAL_MODE_VALUES,
  "accept-edits",
  "dont-ask",
  "plan",
  "safety-focused",
] as const;

/** 設定に保存する承認モード。Provider に送る前に対応するポリシーへ変換する。 */
export type ApprovalMode = (typeof APPROVAL_MODE_VALUES)[number];

/** 既知の承認モードを復元できない場合に使う既定値。 */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "untrusted";

/** 共有の承認モード ID と表示ラベルの対応。 */
export const approvalModeOptions = [
  { id: "never", label: "Auto Run" },
  { id: "on-request", label: "Provider Controlled" },
  { id: "untrusted", label: "Safety Focused" },
  { id: "accept-edits", label: "Accept Edits" },
  { id: "dont-ask", label: "Preapproved Only" },
  { id: "plan", label: "Plan" },
  { id: "safety-focused", label: "Safety Focused" },
] as const satisfies Array<{ id: ApprovalMode; label: string }>;

const LEGACY_APPROVAL_MODE_MAP = {
  "allow-all": "never",
  safety: "untrusted",
  "provider-controlled": "on-request",
} as const satisfies Record<string, ApprovalMode>;

/** 前後の空白を除き、現行値または旧 ID を解決する。認識できない値は null を返す。 */
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

  return (
    LEGACY_APPROVAL_MODE_MAP[
      normalized as keyof typeof LEGACY_APPROVAL_MODE_MAP
    ] ?? null
  );
}

/** 保存値や旧 ID を現行値へ揃え、無効な入力では呼び出し元の既定値を使う。 */
export function normalizeApprovalMode(
  value: unknown,
  fallback: ApprovalMode = DEFAULT_APPROVAL_MODE,
): ApprovalMode {
  return resolveApprovalMode(value) ?? fallback;
}

/** 既知の ID や旧 ID のラベルを返し、未知の値は表示から失わせない。 */
export function approvalModeLabel(value: string): string {
  const normalized = resolveApprovalMode(value);
  if (!normalized) {
    return value;
  }

  const option = approvalModeOptions.find(
    (candidate) => candidate.id === normalized,
  );
  if (option) {
    return option.label;
  }

  return value;
}

/** 承認モードを Codex 用に変換し、自動審査向けの safety-focused は on-request に対応付ける。Codex 非対応の既知値は拒否する。 */
export function mapApprovalModeToCodexPolicy(
  approvalMode: string,
): CodexApprovalPolicy {
  const normalized = normalizeApprovalMode(approvalMode, DEFAULT_APPROVAL_MODE);
  if (normalized === "safety-focused") return "on-request";
  if (!CODEX_APPROVAL_MODE_VALUES.includes(normalized as CodexApprovalPolicy)) {
    throw new Error("The selected approval mode is not supported by Codex.");
  }
  return normalized as CodexApprovalPolicy;
}
