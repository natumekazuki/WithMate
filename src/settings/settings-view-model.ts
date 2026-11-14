import {
  getProviderAppSettings,
  type AppSettings,
  type ProviderAppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import {
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";

function normalizeSelectablePath(filePath: string): string {
  return filePath.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
}

function normalizePathComparisonKey(filePath: string): string {
  const normalized = normalizeSelectablePath(filePath);
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function resolveProviderRelativePathFromSelection(
  rootDirectory: string,
  selectedPath: string,
): string | null {
  const normalizedRoot = normalizeSelectablePath(rootDirectory);
  const normalizedSelectedPath = normalizeSelectablePath(selectedPath);
  if (!normalizedRoot || !normalizedSelectedPath) {
    return null;
  }

  const rootKey = normalizePathComparisonKey(normalizedRoot);
  const selectedKey = normalizePathComparisonKey(normalizedSelectedPath);
  if (selectedKey === rootKey) {
    return "";
  }

  const prefix = `${rootKey}/`;
  if (!selectedKey.startsWith(prefix)) {
    return null;
  }

  return normalizedSelectedPath.slice(normalizedRoot.length + 1);
}

export type HomeProviderSettingRow = {
  provider: ModelCatalogProvider;
  settings: ProviderAppSettings;
};

export function buildHomeProviderSettingRows(
  modelCatalog: ModelCatalogSnapshot | null,
  appSettings: AppSettings,
): HomeProviderSettingRow[] {
  return (modelCatalog?.providers ?? []).map((provider) => {
    const settings = getProviderAppSettings(appSettings, provider.id);

    return {
      provider,
      settings,
    };
  });
}
