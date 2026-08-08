import { codexProviderDefinition } from "./codex/codex-provider-definition.js";
import { ProviderDefinitionRegistry } from "./provider-definition.js";

export const defaultProviderDefinitionRegistry = new ProviderDefinitionRegistry([codexProviderDefinition]);

export function providerSettingsUiDefinitions() {
  return defaultProviderDefinitionRegistry.settingsUiDefinitions();
}

export function providerInteractionUiDefinitions() {
  return defaultProviderDefinitionRegistry.interactionUiDefinitions();
}
