import {
  getProviderAppSettings,
  type AppSettings,
  type ProviderAppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import {
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";

/** 選択されたパスの前後の空白と末尾の区切りを除き、区切り方向をそろえる。 */
function normalizeSelectablePath(filePath: string): string {
  return filePath.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
}

/** ドライブ付きパスでは大文字小文字の違いを無視する比較用のキーを作る。 */
function normalizePathComparisonKey(filePath: string): string {
  const normalized = normalizeSelectablePath(filePath);
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** 選択先をルートからの相対パスにする。ルート自体は空文字列、空の入力や範囲外は null。 */
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

/** カタログの Provider と、その ID に対応するアプリ設定を並べた表示行。 */
export type HomeProviderSettingRow = {
  provider: ModelCatalogProvider;
  settings: ProviderAppSettings;
};

/** カタログにある Provider の順に、現在の設定と対応付けた設定行を組み立てる。 */
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
