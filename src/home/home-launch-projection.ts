import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../model-catalog.js";
import { getProviderAppSettings, type AppSettings } from "../provider-settings-state.js";
import { resolveSelectedLaunchProviderId } from "../launch/launch-provider-selection.js";
import {
  resolveLaunchCharacterId,
  type LaunchCharacterSelectionMode,
} from "./home-launch-state.js";
import {
  isSessionFolderLaunchWorkspace,
  type LaunchWorkspaceSelection,
} from "./home-launch-workspace.js";

export { inferWorkspaceFromPath } from "./home-launch-workspace.js";
export type { LaunchWorkspace, LaunchWorkspaceSelection } from "./home-launch-workspace.js";

export type HomeLaunchProjection = {
  enabledLaunchProviders: ModelCatalogProvider[];
  selectedLaunchProvider: ModelCatalogProvider | null;
  characterOptions: CharacterCatalogEntry[];
  selectedCharacter: CharacterCatalogEntry | null;
  randomCharacterSelected: boolean;
  charactersLoaded: boolean;
  launchWorkspacePathLabel: string;
  sessionFolderSelected: boolean;
  workspaceSelected: boolean;
  canStartSession: boolean;
};

export function buildHomeLaunchProjection({
  launchProviderId,
  launchMode,
  launchTitle,
  launchWorkspace,
  launchCharacterId,
  launchCharacterSelectionMode = "random",
  characterEntries = [],
  charactersLoaded = true,
  appSettings,
  modelCatalog,
}: {
  launchProviderId: string;
  launchMode?: "session" | "companion";
  launchTitle: string;
  launchWorkspace: LaunchWorkspaceSelection | null;
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
  const validCharacterSelection = launchCharacterSelectionMode === "random" || selectedCharacter !== null;
  const sessionFolderSelected = isSessionFolderLaunchWorkspace(launchWorkspace);

  return {
    enabledLaunchProviders,
    selectedLaunchProvider,
    characterOptions: [...activeCharacterEntries],
    selectedCharacter,
    randomCharacterSelected: launchCharacterSelectionMode === "random",
    charactersLoaded,
    launchWorkspacePathLabel: sessionFolderSelected
      ? "SessionFolder"
      : launchWorkspace?.path ?? "workspace",
    sessionFolderSelected,
    workspaceSelected: !!launchWorkspace,
    canStartSession:
      charactersLoaded &&
      !!launchTitle.trim() &&
      !!launchWorkspace &&
      !!selectedLaunchProvider &&
      validCharacterSelection &&
      (launchMode !== "companion" || !sessionFolderSelected),
  };
}
