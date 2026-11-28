import { createHash } from "node:crypto";
import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import { WITHMATE_MANAGED_MCP_TOKEN_ENV } from "./managed-http-mcp.js";
import {
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV,
  WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV,
  WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV,
} from "../../src-shared/agent-runtime/agent-runtime-binding-contract.js";

export {
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_HEADER,
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV,
  WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV,
  WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV,
} from "../../src-shared/agent-runtime/agent-runtime-binding-contract.js";

/** プロバイダーが実行時バインディングを受け取れるかと、その転送方式を示す。 */
export type ProviderAgentRuntimeBindingCapability = {
  providerId: string;
  transport: "env" | "unsupported";
};

/** 表示向けのコピーで参照などの機密値を置き換えたことを示すマーカー。 */
export const PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER =
  "[WITHMATE_BINDING_REFERENCE_REDACTED]";

/** 文字列やデータの表示用コピーから、発行参照や実行時の機密値を除く処理。 */
export type ProviderAgentRuntimeBindingRedactor = {
  sanitizeText: (value: string, previewLimit?: number) => string;
  sanitize: <T>(value: T) => T;
};

/**
 * 表示に反映するためのコピーだけを秘匿化する。ライフサイクル管理・制御の処理が終わるまでは、
 * プロバイダーの生イベントを変更しない。
 */
export function createProviderAgentRuntimeBindingRedactor(
  projection: ProviderAgentRuntimeBindingProjection | null | undefined,
  additionalSecrets: readonly string[] = [],
): ProviderAgentRuntimeBindingRedactor {
  const secrets = [
    ...(projection?.transport === "env"
      ? [projection.bindingReference, projection.turnCapability ?? ""]
      : []),
    projection?.managedMcp?.token ?? "",
    ...additionalSecrets,
  ].filter((value) => value.length > 0);
  const maxSecretLength = Math.max(
    0,
    ...secrets.map((secret) => secret.length),
  );
  const secretPattern =
    secrets.length > 0
      ? new RegExp(
          [...secrets]
            .sort((left, right) => right.length - left.length)
            .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|"),
          "g",
        )
      : null;
  /** 文字列中の機密値を置換する。プレビュー時は元の上限をまたぐ機密値も断片のまま残さない。 */
  const sanitizeText = (value: string, previewLimit?: number): string => {
    if (previewLimit === undefined) {
      return secrets.reduce(
        (current, secret) =>
          current
            .split(secret)
            .join(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER),
        value,
      );
    }
    const limit = Math.max(0, previewLimit);
    if (!secretPattern || limit === 0) return value.slice(0, limit);
    // 切り詰めると機密値の先頭部分が残るおそれがあるため、
    // 機密値全体を照合するのに必要な範囲だけ、プレビューの境界より先を確認する。
    const bounded = value.slice(0, limit + maxSecretLength - 1);
    const parts: string[] = [];
    let cursor = 0;
    for (const match of bounded.matchAll(secretPattern)) {
      if (match.index >= limit) break;
      parts.push(
        bounded.slice(cursor, match.index),
        PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER,
      );
      cursor = match.index + match[0].length;
    }
    parts.push(bounded.slice(cursor, Math.max(cursor, limit)));
    return parts.join("");
  };
  /** 機密値があるときだけ入れ子のデータを複製して秘匿化する。 */
  const sanitize = <T>(value: T): T => {
    if (secrets.length === 0) {
      return value;
    }
    /** 文字列値とオブジェクトのキーを処理し、配列は要素ごとにたどる。 */
    const visit = (candidate: unknown): unknown => {
      if (typeof candidate === "string") {
        return sanitizeText(candidate);
      }
      if (Array.isArray(candidate)) {
        return candidate.map((entry) => visit(entry));
      }
      if (candidate && typeof candidate === "object") {
        const output: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(candidate)) {
          output[sanitizeText(key)] = visit(entry);
        }
        return output;
      }
      return candidate;
    };
    return visit(value) as T;
  };
  return { sanitizeText, sanitize };
}

/** 対応プロバイダーは環境変数でバインディングを受け取り、その他は未対応とする。 */
export function getProviderAgentRuntimeBindingCapability(
  providerId: string,
): ProviderAgentRuntimeBindingCapability {
  return {
    providerId,
    transport:
      providerId === "codex" ||
      providerId === "copilot" ||
      providerId === "claude" ||
      providerId === "opencode"
        ? "env"
        : "unsupported",
  };
}

/** 環境変数経由の参照・Turn 認可を出力する。ランタイムの所有情報はインスタンスと世代が揃う場合にだけ渡す。 */
export function buildProviderAgentRuntimeBindingEnv(
  projection: ProviderAgentRuntimeBindingProjection | null | undefined,
  consumerProviderId = projection?.providerId,
): Record<string, string> {
  const runtimeOwner = projection?.runtimeOwner;
  const runtimeApplicationInstanceId =
    runtimeOwner?.applicationInstanceId?.trim();
  const runtimeGenerationId = runtimeOwner?.runtimeGenerationId?.trim();
  return projection?.transport === "env"
    ? {
        [WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV]:
          projection.bindingReference,
        [WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]: "1",
        ...(consumerProviderId === "codex" && projection.managedMcp
          ? { [WITHMATE_MANAGED_MCP_TOKEN_ENV]: projection.managedMcp.token }
          : {}),
        ...(projection.turnCapability
          ? {
              [WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV]:
                projection.turnCapability,
            }
          : {}),
        ...(runtimeApplicationInstanceId && runtimeGenerationId
          ? {
              [WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV]:
                runtimeApplicationInstanceId,
              [WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV]: runtimeGenerationId,
            }
          : {}),
      }
    : {};
}

/** 所属や実行世代が変わればキャッシュを分ける。Turn の秘密値は生の値をキーに含めない。 */
export function buildProviderAgentRuntimeBindingCacheKey(
  projection: ProviderAgentRuntimeBindingProjection | null | undefined,
): string {
  if (!projection || projection.transport === "unsupported") {
    return "";
  }
  const runtimeOwner = projection.runtimeOwner;
  return JSON.stringify([
    projection.bindingId,
    projection.providerId,
    projection.executionGeneration,
    projection.expiresAt,
    projection.turnCapability
      ? createHash("sha256")
          .update(projection.turnCapability, "utf8")
          .digest("base64url")
      : null,
    runtimeOwner?.applicationInstanceId ?? null,
    runtimeOwner?.runtimeGenerationId ?? null,
  ]);
}

/** 継承環境から古い実行認可や管理 MCP の値を大小文字を区別せず取り除き、新しい実行用の値で上書きする。 */
export function mergeDefinedProviderEnv(
  baseEnv: NodeJS.ProcessEnv,
  overlay: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  const bindingReferenceKey =
    WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV.toLowerCase();
  const bindingRequiredKey =
    WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV.toLowerCase();
  const turnCapabilityKey =
    WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV.toLowerCase();
  const runtimeApplicationInstanceIdKey =
    WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV.toLowerCase();
  const runtimeGenerationIdKey =
    WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV.toLowerCase();
  for (const [key, value] of Object.entries(baseEnv)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey !== bindingReferenceKey &&
      normalizedKey !== bindingRequiredKey &&
      normalizedKey !== turnCapabilityKey &&
      normalizedKey !== runtimeApplicationInstanceIdKey &&
      normalizedKey !== runtimeGenerationIdKey &&
      normalizedKey !== WITHMATE_MANAGED_MCP_TOKEN_ENV.toLowerCase() &&
      value !== undefined
    ) {
      merged[key] = value;
    }
  }
  return { ...merged, ...overlay };
}
