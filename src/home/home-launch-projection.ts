import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../model-catalog.js";
import { getProviderAppSettings, type AppSettings } from "../provider-settings-state.js";
import { resolveSelectedLaunchProviderId } from "../launch/launch-provider-selection.js";

export type LaunchWorkspace = {
  label: string;
  path: string;
  branch: string;
};

export type HomeLaunchProjection = {
  enabledLaunchProviders: ModelCatalogProvider[];
  selectedLaunchProvider: ModelCatalogProvider | null;
  launchWorkspacePathLabel: string;
  canStartSession: boolean;
};

export function inferWorkspaceFromPath(selectedPath: string): LaunchWorkspace {
  const normalized = selectedPath.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  const label = segments.at(-1) ?? normalized;

  return {
    label,
    path: selectedPath,
    branch: "",
  };
}

export function buildHomeLaunchProjection({
  launchProviderId,
  launchMode,
  launchTitle,
  launchWorkspace,
  appSettings,
  modelCatalog,
}: {
  launchProviderId: string;
  launchMode?: "session" | "companion";
  launchTitle: string;
  launchWorkspace: LaunchWorkspace | null;
  appSettings: AppSettings;
  modelCatalog: ModelCatalogSnapshot | null;
}): HomeLaunchProjection {
  const enabledLaunchProviders = (modelCatalog?.providers ?? []).filter(
    (provider) => getProviderAppSettings(appSettings, provider.id).enabled,
  );
  const selectedLaunchProviderId = resolveSelectedLaunchProviderId(enabledLaunchProviders, launchProviderId);
  const selectedLaunchProvider =
    enabledLaunchProviders.find((provider) => provider.id === selectedLaunchProviderId) ?? null;

  return {
    enabledLaunchProviders,
    selectedLaunchProvider,
    launchWorkspacePathLabel: launchWorkspace ? launchWorkspace.path : "workspace",
    canStartSession: !!launchTitle.trim() && !!launchWorkspace && !!selectedLaunchProvider,
  };
}
