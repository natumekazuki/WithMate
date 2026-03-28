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

type ResolveProviderCatalogArgs = {
  providerId: string | null | undefined;
  revision?: number | null;
  getModelCatalog(revision?: number | null): ModelCatalogSnapshot | null;
  ensureSeeded(): ModelCatalogSnapshot;
};

type ResolveProviderTurnAdapterArgs = {
  providerId: string | null | undefined;
  codexAdapter: ProviderTurnAdapter;
  copilotAdapter: ProviderTurnAdapter;
};

type FetchProviderQuotaTelemetryArgs = {
  providerId: string;
  getAppSettings(): AppSettings;
  getProviderCodingAdapter(providerId: string): ProviderCodingAdapter;
};

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

export function resolveProviderTurnAdapter(args: ResolveProviderTurnAdapterArgs): ProviderTurnAdapter {
  return args.providerId === "copilot" ? args.copilotAdapter : args.codexAdapter;
}

export function resolveProviderCodingAdapter(args: ResolveProviderTurnAdapterArgs): ProviderCodingAdapter {
  return resolveProviderTurnAdapter(args);
}

export function resolveProviderBackgroundAdapter(args: ResolveProviderTurnAdapterArgs): ProviderBackgroundAdapter {
  return resolveProviderTurnAdapter(args);
}

export async function fetchProviderQuotaTelemetry(
  args: FetchProviderQuotaTelemetryArgs,
): Promise<ProviderQuotaTelemetry | null> {
  return args.getProviderCodingAdapter(args.providerId).getProviderQuotaTelemetry({
    providerId: args.providerId,
    appSettings: args.getAppSettings(),
  });
}
