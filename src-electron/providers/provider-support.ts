import type { ProviderQuotaTelemetry } from "../../src-shared/session/runtime-state.js";
import {
  DEFAULT_PROVIDER_ID,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type {
  ProviderBackgroundAdapter,
  ProviderCodingAdapter,
  ProviderTurnAdapter,
} from "./provider-runtime.js";
import { getProviderAgentRuntimeBindingCapability } from "./provider-agent-runtime-binding.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

type ResolveProviderCatalogArgs = {
  providerId: string | null | undefined;
  revision?: number | null;
  getModelCatalog(revision?: number | null): Awaitable<ModelCatalogSnapshot | null>;
  ensureSeeded(): Awaitable<ModelCatalogSnapshot>;
};

type ResolveProviderAdapterArgs = {
  providerId: string | null | undefined;
  codexAdapter: ProviderTurnAdapter;
  copilotAdapter: ProviderTurnAdapter;
};

type FetchProviderQuotaTelemetryArgs = {
  providerId: string;
  getAppSettings(): Awaitable<AppSettings>;
  getProviderCodingAdapter(providerId: string): ProviderCodingAdapter;
};

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
} as const;

export function isProviderSupported(providerId: string): providerId is keyof typeof PROVIDER_ADAPTER_KEYS {
  return Object.hasOwn(PROVIDER_ADAPTER_KEYS, providerId);
}

export function requireSupportedProviderId(providerId: string | null | undefined): keyof typeof PROVIDER_ADAPTER_KEYS {
  const resolvedProviderId = providerId ?? DEFAULT_PROVIDER_ID;
  if (!isProviderSupported(resolvedProviderId)) {
    throw new Error(`Unsupported provider: ${resolvedProviderId}. Select a supported provider in Settings.`);
  }
  return resolvedProviderId;
}

export async function resolveProviderCatalogOrThrow(
  args: ResolveProviderCatalogArgs,
): Promise<{ snapshot: ModelCatalogSnapshot; provider: ModelCatalogProvider }> {
  const providerId = requireSupportedProviderId(args.providerId);
  const snapshot = (await args.getModelCatalog(args.revision)) ?? (await args.ensureSeeded());
  const provider = snapshot.providers.find((entry) => entry.id === providerId);
  if (!provider) {
    throw new Error(`Provider ${providerId} is not available in the model catalog.`);
  }

  return { snapshot, provider };
}

function resolveProviderAdapter(args: ResolveProviderAdapterArgs): ProviderTurnAdapter {
  const providerId = requireSupportedProviderId(args.providerId);
  return args[PROVIDER_ADAPTER_KEYS[providerId]];
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
    appSettings: await args.getAppSettings(),
  });
}

export function getProviderRuntimeCapabilities(args: { providerId: string }): ProviderRuntimeCapabilities {
  const providerSupported = isProviderSupported(args.providerId);
  const bindingCapability = getProviderAgentRuntimeBindingCapability(args.providerId);
  return {
    providerId: args.providerId,
    providerSupported,
    instructionSyncSupported: providerSupported,
    tokenUsageSupported: providerSupported,
    agentRuntimeBindingSupported: bindingCapability.transport !== "unsupported",
    agentRuntimeBindingTransport: bindingCapability.transport,
  };
}
