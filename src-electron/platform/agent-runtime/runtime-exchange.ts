import { createHmac } from "node:crypto";

/** 接続先の応答を今回の要求に結び付けるため、要求ごとに生成したノンスを渡すヘッダー。 */
export const WITHMATE_AGENT_RUNTIME_NONCE_HEADER =
  "x-withmate-agent-runtime-nonce";
/** 接続先として期待するアプリケーションのインスタンス ID を指定するヘッダー。 */
export const WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_HEADER =
  "x-withmate-agent-runtime-application-instance";
/** 接続先として期待するランタイムの世代 ID を指定するヘッダー。 */
export const WITHMATE_AGENT_RUNTIME_GENERATION_HEADER =
  "x-withmate-agent-runtime-generation";
/** 要求本文を送る前にクライアントが照合する、接続先からの HMAC 応答のヘッダー。 */
export const WITHMATE_AGENT_RUNTIME_CHALLENGE_HEADER =
  "x-withmate-agent-runtime-challenge";
/** CLI と MCP が拡張操作の要求を送る共通 API パス。 */
export const WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH =
  "/v1/agent-runtime-extension-exchange";
/** 通常の小容量枠とは別に受け付ける要求本文の最大バイト数。 */
export const WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES = 34 * 1024 * 1024;
/** 拡張操作要求の本文に含めるエンベロープのスキーマ識別子。 */
export const WITHMATE_AGENT_RUNTIME_EXCHANGE_SCHEMA_VERSION =
  "withmate-agent-runtime-exchange-v1";

/** 拡張操作の本文を送る前の照合用に、ランタイム世代とノンスに結び付く HMAC を生成する。 */
export function createAgentRuntimeChallenge(
  apiSecret: string,
  runtimeGenerationId: string,
  nonce: string,
): string {
  return createHmac("sha256", apiSecret)
    .update(`${runtimeGenerationId}\n${nonce}`, "utf8")
    .digest("base64url");
}

/** 状態確認の応答用に、アプリケーションのインスタンスとランタイム世代の組をノンスに結び付ける HMAC を生成する。 */
export function createAgentRuntimeOwnerChallenge(
  apiSecret: string,
  applicationInstanceId: string,
  runtimeGenerationId: string,
  nonce: string,
): string {
  return createHmac("sha256", apiSecret)
    .update(
      `${applicationInstanceId}\n${runtimeGenerationId}\n${nonce}`,
      "utf8",
    )
    .digest("base64url");
}
