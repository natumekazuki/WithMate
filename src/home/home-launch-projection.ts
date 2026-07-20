import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../model-catalog.js";
import { getProviderAppSettings, type AppSettings } from "../provider-settings-state.js";
import { resolveSelectedLaunchProviderId } from "../launch/launch-provider-selection.js";
import {
  resolveLaunchCharacterId,
  type LaunchCharacterSelectionMode,
} from "./home-launch-state.js";

export type LaunchWorkspace = {
  label: string;
  path: string;
  branch: string;
};

export type HomeLaunchProjection = {
  enabledLaunchProviders: ModelCatalogProvider[];
  selectedLaunchProvider: ModelCatalogProvider | null;
  characterOptions: CharacterCatalogEntry[];
  selectedCharacter: CharacterCatalogEntry | null;
  randomCharacterSelected: boolean;
  charactersLoaded: boolean;
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
  launchCharacterId,
  launchCharacterSelectionMode = "specific",
  characterEntries = [],
  charactersLoaded = true,
  appSettings,
  modelCatalog,
}: {
  launchProviderId: string;
  launchMode?: "session" | "companion";
  launchTitle: string;
  launchWorkspace: LaunchWorkspace | null;
  launchCharacterId?: string;
  launchCharacterSelectionMode?: LaunchCharacterSelectionMode;
  characterEntries?: readonly CharacterCatalogEntry[];
  charactersLoaded?: boolean;
  appSettings: AppSettings;
  modelCatalog: ModelCatalogSnapshot | null;
}): HomeLaunchProjection {
  const enabledLaunchProviders = (modelCatalog?.providers ?? []).filter(
    (provider) => getProviderAppSettings(appSettings, provider.id).enabled,
  );
  const selectedLaunchProviderId = resolveSelectedLaunchProviderId(enabledLaunchProviders, launchProviderId);
  const selectedLaunchProvider =
    enabledLaunchProviders.find((provider) => provider.id === selectedLaunchProviderId) ?? null;
  const activeCharacterEntries = characterEntries.filter((character) => character.state === "active");
  const selectedCharacterId = resolveLaunchCharacterId(activeCharacterEntries, launchCharacterId);
  const selectedCharacter = launchCharacterSelectionMode === "random"
    ? null
    : activeCharacterEntries.find((character) => character.id === selectedCharacterId) ?? null;

  return {
    enabledLaunchProviders,
    selectedLaunchProvider,
    characterOptions: [...activeCharacterEntries],
    selectedCharacter,
    randomCharacterSelected: launchCharacterSelectionMode === "random",
    charactersLoaded,
    launchWorkspacePathLabel: launchWorkspace ? launchWorkspace.path : "workspace",
    canStartSession: charactersLoaded && !!launchTitle.trim() && !!launchWorkspace && !!selectedLaunchProvider,
  };
}
