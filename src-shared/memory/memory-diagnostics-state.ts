/** 現在のランタイムが稼働中か、接続先の識別と発見情報が公開済みかを表す。 */
export type MemoryV6RuntimeDiagnostics = {
  status: "running" | "stopped" | "failed";
  applicationInstanceId: string | null;
  runtimeGenerationId: string | null;
  buildChannel: "installed" | "development" | "visual-check" | "unknown" | null;
  discoveryPublished: boolean;
};

/** CLI起動用の仲介コマンドについて、対応環境・配置状態・PATHの検出結果を表す。 */
export type MemoryV6CliShimDiagnostics = {
  platform:
    | "aix"
    | "android"
    | "darwin"
    | "freebsd"
    | "haiku"
    | "linux"
    | "openbsd"
    | "sunos"
    | "win32"
    | "cygwin"
    | "netbsd";
  commandName: "withmate-memory";
  supported: boolean;
  status:
    | "managed-by-installer"
    | "installed"
    | "installed-path-missing"
    | "not-installed"
    | "stale"
    | "blocked-existing"
    | "unsupported"
    | "failed";
  pathContainsShimDirectory: boolean;
};

/** 最近の診断イベントの種類と発生日時。登録上限の事象では発見時のコードも持つ。 */
export type MemoryV6DiagnosticEvent = {
  kind: string;
  occurredAt: string;
  discoveryCode?: "WITHMATE_RUNTIME_REGISTRY_CAPACITY";
};

/** 取得時点のランタイムとCLI配置の状態、その時点までの最近のエラー。 */
export type MemoryV6Diagnostics = {
  generatedAt: string;
  runtime: MemoryV6RuntimeDiagnostics;
  cliShim: MemoryV6CliShimDiagnostics;
  lastErrors: MemoryV6DiagnosticEvent[];
};

/** 診断表示の契約に含まれる最上位のフィールドだけを返す。 */
export function projectMemoryV6Diagnostics(
  input: MemoryV6Diagnostics,
): MemoryV6Diagnostics {
  return {
    generatedAt: input.generatedAt,
    runtime: input.runtime,
    cliShim: input.cliShim,
    lastErrors: input.lastErrors,
  };
}
