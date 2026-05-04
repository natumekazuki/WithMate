import { getProviderAppSettings, type AppSettings } from "./provider-settings-state.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "./model-catalog.js";

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
  launchTitle,
  launchWorkspace,
  appSettings,
  modelCatalog,
}: {
  launchProviderId: string;
  launchTitle: string;
  launchWorkspace: LaunchWorkspace | null;
  appSettings: AppSettings;
  modelCatalog: ModelCatalogSnapshot | null;
}): HomeLaunchProjection {
  const enabledLaunchProviders = (modelCatalog?.providers ?? []).filter(
    (provider) => getProviderAppSettings(appSettings, provider.id).enabled,
  );
  const selectedLaunchProvider =
    enabledLaunchProviders.find((provider) => provider.id === launchProviderId) ?? enabledLaunchProviders[0] ?? null;

  return {
    enabledLaunchProviders,
    selectedLaunchProvider,
    launchWorkspacePathLabel: launchWorkspace ? launchWorkspace.path : "workspace",
    canStartSession: !!launchTitle.trim() && !!launchWorkspace && !!selectedLaunchProvider,
  };
}
