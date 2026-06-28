import type { ProviderQuotaTelemetry } from "../src/app-state.js";
import {
  DEFAULT_PROVIDER_ID,
  getProviderCatalog,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../src/model-catalog.js";
import type { AppSettings } from "../src/provider-settings-state.js";
import type {
  ProviderBackgroundAdapter,
  ProviderCodingAdapter,
  ProviderTurnAdapter,
} from "./provider-runtime.js";
import {
  getProviderMemoryBindingCapability,
  type ProviderMemoryBindingTransport,
} from "./provider-memory-binding.js";

type ResolveProviderCatalogArgs = {
  providerId: string | null | undefined;
  revision?: number | null;
  getModelCatalog(revision?: number | null): ModelCatalogSnapshot | null;
  ensureSeeded(): ModelCatalogSnapshot;
};

type ResolveProviderAdapterArgs = {
  providerId: string | null | undefined;
  codexAdapter: ProviderTurnAdapter;
  copilotAdapter: ProviderTurnAdapter;
};

type FetchProviderQuotaTelemetryArgs = {
  providerId: string;
  getAppSettings(): AppSettings;
  getProviderCodingAdapter(providerId: string): ProviderCodingAdapter;
};

export type ProviderRuntimeCapabilities = {
  providerId: string;
  providerSupported: boolean;
  instructionSyncSupported: boolean;
  tokenUsageSupported: boolean;
  memoryBindingTransport: ProviderMemoryBindingTransport;
};

const MATE_SUPPORTED_PROVIDER_IDS = new Set(["codex", "copilot"]);

export function resolveProviderCatalogOrThrow(
  args: ResolveProviderCatalogArgs,
): { snapshot: ModelCatalogSnapshot; provider: ModelCatalogProvider } {
  const snapshot = args.getModelCatalog(args.revision) ?? args.ensureSeeded();
  const provider = getProviderCatalog(snapshot.providers, args.providerId ?? DEFAULT_PROVIDER_ID);
  if (!provider) {
    throw new Error("利用できる model catalog provider が見つからないよ。");
  }

  return { snapshot, provider };
}

function resolveProviderAdapter(args: ResolveProviderAdapterArgs): ProviderTurnAdapter {
  return args.providerId === "copilot" ? args.copilotAdapter : args.codexAdapter;
}

export function resolveProviderCodingAdapter(args: ResolveProviderAdapterArgs): ProviderCodingAdapter {
  return resolveProviderAdapter(args);
}

export function resolveProviderBackgroundAdapter(args: ResolveProviderAdapterArgs): ProviderBackgroundAdapter {
  return resolveProviderAdapter(args);
}

export async function fetchProviderQuotaTelemetry(
  args: FetchProviderQuotaTelemetryArgs,
): Promise<ProviderQuotaTelemetry | null> {
  return args.getProviderCodingAdapter(args.providerId).getProviderQuotaTelemetry({
    providerId: args.providerId,
    appSettings: args.getAppSettings(),
  });
}

export function getProviderRuntimeCapabilities(args: { providerId: string }): ProviderRuntimeCapabilities {
  const providerSupported = MATE_SUPPORTED_PROVIDER_IDS.has(args.providerId);
  const memoryBinding = getProviderMemoryBindingCapability(args.providerId);
  return {
    providerId: args.providerId,
    providerSupported,
    instructionSyncSupported: providerSupported,
    tokenUsageSupported: providerSupported,
    memoryBindingTransport: providerSupported ? memoryBinding.transport : "unsupported",
  };
}
