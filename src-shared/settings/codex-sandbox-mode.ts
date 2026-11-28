/** 共有設定から選べる Codex のサンドボックスモード。ネットワーク付きの派生値も含む。 */
export const CODEX_SANDBOX_MODE_VALUES = [
  "read-only",
  "workspace-write",
  "workspace-write-network",
  "danger-full-access",
] as const;

/** ネットワーク利用の選択を含めて保存するサンドボックスモード。 */
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODE_VALUES)[number];

/** ネットワーク設定とは別に Codex のスレッドへ渡すサンドボックスの基底モード。 */
export type CodexSandboxBaseMode =
  "read-only" | "workspace-write" | "danger-full-access";

/** 有効な指定がないときはワークスペース内の書き込みを許可する。 */
export const DEFAULT_CODEX_SANDBOX_MODE: CodexSandboxMode = "workspace-write";

/** サンドボックスの保存 ID と設定画面で使うラベルの対応。 */
export const codexSandboxModeOptions = [
  { id: "read-only", label: "Read Only" },
  { id: "workspace-write", label: "Workspace Write" },
  { id: "workspace-write-network", label: "Workspace Write With Network" },
  { id: "danger-full-access", label: "Danger Full Access" },
] as const satisfies Array<{ id: CodexSandboxMode; label: string }>;

/** 文字列の前後の空白を除いて設定 ID を照合し、認識できない入力は既定値に戻す。 */
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

/** 入力を既定値込みで正規化してから対応する表示ラベルを引く。 */
export function codexSandboxModeLabel(value: string): string {
  const normalized = normalizeCodexSandboxMode(value);
  return (
    codexSandboxModeOptions.find((option) => option.id === normalized)?.label ??
    value
  );
}

/** ネットワーク付きワークスペース書き込みを基底モードと有効フラグに分け、ほかのモードではフラグを立てない。 */
export function resolveCodexSandboxThreadOptions(mode: CodexSandboxMode): {
  sandboxMode: CodexSandboxBaseMode;
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
