import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";

/** プロバイダーに管理 MCP のトークンを渡す環境変数名。 */
export const WITHMATE_MANAGED_MCP_TOKEN_ENV = "WITHMATE_MANAGED_MCP_TOKEN";
/** 管理 HTTP MCP のホストがトークンを受け取るヘッダー名。 */
export const WITHMATE_MANAGED_MCP_TOKEN_HEADER = "x-withmate-mcp-token";
/** 管理する用語集の MCP サーバー名。HTTP 専用の設定名を組み立てる際の基点になる。 */
export const WITHMATE_MANAGED_GLOSSARY_MCP_NAME = "withmate-glossary";
/** 管理する Session の MCP サーバー名。接続先が割り当てられている場合だけ公開する。 */
export const WITHMATE_MANAGED_SESSION_MCP_NAME = "withmate-session";

/** バインディングに接続情報がある場合に用語集と、利用可能なら Session の接続先を列挙する。 */
function managedServerUrls(
  binding: ProviderAgentRuntimeBindingProjection,
): [string, string][] {
  const connection = binding.managedMcp;
  if (!connection) return [];
  return [
    [WITHMATE_MANAGED_GLOSSARY_MCP_NAME, connection.glossaryUrl],
    ...(connection.sessionUrl
      ? [
          [WITHMATE_MANAGED_SESSION_MCP_NAME, connection.sessionUrl] as [
            string,
            string,
          ],
        ]
      : []),
  ];
}

/** Codex 起動用の HTTP MCP 設定引数を作る。トークン値を引数に入れず、環境変数を参照させる。 */
export function buildCodexManagedHttpMcpArguments(
  binding: ProviderAgentRuntimeBindingProjection | null | undefined,
): string[] {
  if (!binding?.managedMcp) return [];
  // Codex は設定テーブルを再帰的にマージする。HTTP 専用のキーを使い、旧 stdio フィールドが混入しないようにする。
  return [
    ...managedServerUrls(binding).flatMap(([name, url]) => [
      "-c",
      `mcp_servers.${name}-http={url=${JSON.stringify(url)},env_http_headers={${WITHMATE_MANAGED_MCP_TOKEN_HEADER}=${JSON.stringify(WITHMATE_MANAGED_MCP_TOKEN_ENV)}}}`,
    ]),
  ];
}

/** Codex の有効設定にある旧名の管理サーバーだけを無効化し、他のサーバー設定は返さない。 */
export function buildCodexManagedMcpDisableConfig(
  effectiveConfig: Record<string, unknown>,
): Record<string, { enabled: false }> {
  const configured = effectiveConfig.mcp_servers;
  if (
    !configured ||
    typeof configured !== "object" ||
    Array.isArray(configured)
  )
    return {};
  return Object.fromEntries(
    [WITHMATE_MANAGED_GLOSSARY_MCP_NAME, WITHMATE_MANAGED_SESSION_MCP_NAME]
      .filter((name) => Object.hasOwn(configured, name))
      .map((name) => [name, { enabled: false as const }]),
  );
}

/** Codex に渡す HTTP 専用設定を作り、認証ヘッダーをトークンの環境変数名へ対応付ける。 */
export function buildCodexManagedHttpMcpConfig(
  binding: ProviderAgentRuntimeBindingProjection,
): Record<string, { url: string; env_http_headers: Record<string, string> }> {
  const connection = binding.managedMcp;
  if (!connection) return {};
  return Object.fromEntries(
    managedServerUrls(binding).map(([name, url]) => [
      `${name}-http`,
      {
        url,
        env_http_headers: {
          [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: WITHMATE_MANAGED_MCP_TOKEN_ENV,
        },
      },
    ]),
  );
}

/** SDK が初期化時に使う HTTP 接続先と認証ヘッダーを組み立てる。管理接続がなければ undefined。 */
export function buildManagedHttpMcpServers(
  binding: ProviderAgentRuntimeBindingProjection | null | undefined,
):
  | Record<
      string,
      { type: "http"; url: string; headers: Record<string, string> }
    >
  | undefined {
  if (!binding?.managedMcp) return undefined;
  const connection = binding.managedMcp;
  return Object.fromEntries(
    managedServerUrls(binding).map(([name, url]) => [
      name,
      {
        type: "http" as const,
        url,
        headers: { [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: connection.token },
      },
    ]),
  );
}
