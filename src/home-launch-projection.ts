import type { CharacterProfile } from "./app-state.js";
import { getProviderAppSettings, type AppSettings } from "./provider-settings-state.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "./model-catalog.js";

export type LaunchWorkspace = {
  label: string;
  path: string;
  branch: string;
};

export type HomeLaunchProjection = {
  filteredLaunchCharacters: CharacterProfile[];
  selectedCharacter: CharacterProfile | null;
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

export function filterCharacters(
  characters: readonly CharacterProfile[],
  searchText: string,
): CharacterProfile[] {
  const normalizedSearch = searchText.trim().toLocaleLowerCase();
  if (!normalizedSearch) {
    return [...characters];
  }

  return characters.filter((character) => {
    const haystacks = [character.name, character.description].map((value) => value.toLocaleLowerCase());
    return haystacks.some((value) => value.includes(normalizedSearch));
  });
}

export function buildHomeLaunchProjection({
  characters,
  launchCharacterSearchText,
  launchCharacterId,
  launchProviderId,
  launchTitle,
  launchWorkspace,
  appSettings,
  modelCatalog,
}: {
  characters: readonly CharacterProfile[];
  launchCharacterSearchText: string;
  launchCharacterId: string;
  launchProviderId: string;
  launchTitle: string;
  launchWorkspace: LaunchWorkspace | null;
  appSettings: AppSettings;
  modelCatalog: ModelCatalogSnapshot | null;
}): HomeLaunchProjection {
  const filteredLaunchCharacters = filterCharacters(characters, launchCharacterSearchText);
  const selectedCharacter = characters.find((character) => character.id === launchCharacterId) ?? characters[0] ?? null;
  const enabledLaunchProviders = (modelCatalog?.providers ?? []).filter(
    (provider) => getProviderAppSettings(appSettings, provider.id).enabled,
  );
  const selectedLaunchProvider =
    enabledLaunchProviders.find((provider) => provider.id === launchProviderId) ?? enabledLaunchProviders[0] ?? null;

  return {
    filteredLaunchCharacters,
    selectedCharacter,
    enabledLaunchProviders,
    selectedLaunchProvider,
    launchWorkspacePathLabel: launchWorkspace ? launchWorkspace.path : "workspace",
    canStartSession: !!launchTitle.trim() && !!launchWorkspace && !!selectedCharacter && !!selectedLaunchProvider,
  };
}
