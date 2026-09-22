import type { ProviderQuotaTelemetry } from "../../src-shared/session/runtime-state.js";
import {
  DEFAULT_PROVIDER_ID,
  getProviderCatalog,
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

const MATE_SUPPORTED_PROVIDER_IDS = new Set(["codex", "copilot"]);

export async function resolveProviderCatalogOrThrow(
  args: ResolveProviderCatalogArgs,
): Promise<{ snapshot: ModelCatalogSnapshot; provider: ModelCatalogProvider }> {
  const snapshot = (await args.getModelCatalog(args.revision)) ?? (await args.ensureSeeded());
  const provider = getProviderCatalog(snapshot.providers, args.providerId ?? DEFAULT_PROVIDER_ID);
  if (!provider) {
    throw new Error("No usable model catalog provider was found.");
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
    appSettings: await args.getAppSettings(),
  });
}

export function getProviderRuntimeCapabilities(args: { providerId: string }): ProviderRuntimeCapabilities {
  const providerSupported = MATE_SUPPORTED_PROVIDER_IDS.has(args.providerId);
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
