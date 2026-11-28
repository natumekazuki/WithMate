import type { ProviderQuotaTelemetry } from "../../src-shared/session/runtime-state.js";
import {
  DEFAULT_PROVIDER_ID,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type {
  ProviderCodingAdapter,
  ProviderTurnAdapter,
} from "./provider-runtime.js";
import { getProviderAgentRuntimeBindingCapability } from "./provider-agent-runtime-binding.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

/** プロバイダーと、実行時に使う最新のモデル一覧を取得するための入力。 */
type ResolveProviderCatalogArgs = {
  providerId: string | null | undefined;
  /** 利用できるモデル一覧を返す。取得できていない場合は null。 */
  getModelCatalog(): Awaitable<ModelCatalogSnapshot | null>;
};

/** 実行先のプロバイダー ID と、各候補に対応する Turn アダプター。 */
type ResolveProviderAdapterArgs = {
  providerId: string | null | undefined;
  codexAdapter: ProviderTurnAdapter;
  copilotAdapter: ProviderTurnAdapter;
  claudeAdapter: ProviderTurnAdapter;
  opencodeAdapter: ProviderTurnAdapter;
};

/** 指定プロバイダーの利用枠取得に必要な設定とアダプターを供給する。 */
type FetchProviderQuotaTelemetryArgs = {
  providerId: string;
  signal?: AbortSignal;
  /** 利用枠照会で参照する現在のアプリ設定を取得する。 */
  getAppSettings(): Awaitable<AppSettings>;
  /** 照会先のプロバイダーに対応するアダプターを解決する。 */
  getProviderCodingAdapter(providerId: string): ProviderCodingAdapter;
};

/** プロバイダーごとに公開する実行機能の対応状況と、バインディング情報の渡し方。 */
export type ProviderRuntimeCapabilities = {
  providerId: string;
  providerSupported: boolean;
  instructionSyncSupported: boolean;
  tokenUsageSupported: boolean;
  agentRuntimeBindingSupported: boolean;
  agentRuntimeBindingTransport: "env" | "unsupported";
};

const PROVIDER_ADAPTER_KEYS = {
  codex: "codexAdapter",
  copilot: "copilotAdapter",
  claude: "claudeAdapter",
  opencode: "opencodeAdapter",
} as const;

/** 実行アダプターに登録済みのプロバイダー ID かを判定する。 */
export function isProviderSupported(
  providerId: string,
): providerId is keyof typeof PROVIDER_ADAPTER_KEYS {
  return Object.hasOwn(PROVIDER_ADAPTER_KEYS, providerId);
}

/** null または undefined だけを既定値で補い、未対応の明示 ID は拒否する。 */
export function requireSupportedProviderId(
  providerId: string | null | undefined,
): keyof typeof PROVIDER_ADAPTER_KEYS {
  const resolvedProviderId = providerId ?? DEFAULT_PROVIDER_ID;
  if (!isProviderSupported(resolvedProviderId)) {
    throw new Error(
      `Unsupported provider: ${resolvedProviderId}. Select a supported provider in Settings.`,
    );
  }
  return resolvedProviderId;
}

/** 指定プロバイダーの実行用モデル一覧を解決する。取得不能または一覧に対象がなければ代替せず失敗する。 */
export async function resolveProviderCatalogOrThrow(
  args: ResolveProviderCatalogArgs,
): Promise<{ snapshot: ModelCatalogSnapshot; provider: ModelCatalogProvider }> {
  const providerId = requireSupportedProviderId(args.providerId);
  const snapshot = await args.getModelCatalog();
  if (!snapshot)
    throw new Error(`Provider ${providerId} model discovery is unavailable.`);
  const provider = snapshot.providers.find((entry) => entry.id === providerId);
  if (!provider) {
    throw new Error(
      `Provider ${providerId} is not available in the model catalog.`,
    );
  }

  return { snapshot, provider };
}

/** 対応済み ID をアダプターの登録キーに写し、実際に渡された Turn アダプターを返す。 */
function resolveProviderAdapter(
  args: ResolveProviderAdapterArgs,
): ProviderTurnAdapter {
  const providerId = requireSupportedProviderId(args.providerId);
  return args[PROVIDER_ADAPTER_KEYS[providerId]];
}

/** 対応する Turn アダプターを、モデル探索や利用枠照会を行う共通インターフェースで返す。 */
export function resolveProviderCodingAdapter(
  args: ResolveProviderAdapterArgs,
): ProviderCodingAdapter {
  return resolveProviderAdapter(args);
}

/** 現在の設定と任意の中断シグナルを指定先に渡し、利用枠を取得する。取得結果がなければ null のまま返す。 */
export async function fetchProviderQuotaTelemetry(
  args: FetchProviderQuotaTelemetryArgs,
): Promise<ProviderQuotaTelemetry | null> {
  return args
    .getProviderCodingAdapter(args.providerId)
    .getProviderQuotaTelemetry({
      providerId: args.providerId,
      appSettings: await args.getAppSettings(),
      ...(args.signal ? { signal: args.signal } : {}),
    });
}

/** 登録の有無から実行・指示同期・使用量への対応を判定し、バインディングの対応と転送方式は専用の機能表から取得する。 */
export function getProviderRuntimeCapabilities(args: {
  providerId: string;
}): ProviderRuntimeCapabilities {
  const providerSupported = isProviderSupported(args.providerId);
  const bindingCapability = getProviderAgentRuntimeBindingCapability(
    args.providerId,
  );
  return {
    providerId: args.providerId,
    providerSupported,
    instructionSyncSupported: providerSupported,
    tokenUsageSupported: providerSupported,
    agentRuntimeBindingSupported: bindingCapability.transport !== "unsupported",
    agentRuntimeBindingTransport: bindingCapability.transport,
  };
}
