import { createContext, useContext, useMemo, type ReactNode } from "react";

import {
  createDefaultKeyboardShortcutSettings,
  normalizeKeyboardShortcutSettings,
  type KeyboardShortcutSettings,
} from "../../src-shared/settings/keyboard-shortcut-state.js";

const DEFAULT_SETTINGS = createDefaultKeyboardShortcutSettings();
const ShortcutSettingsContext =
  createContext<KeyboardShortcutSettings>(DEFAULT_SETTINGS);

/** 保存設定を正規化してから、配下のショートカット処理へ同じ設定を供給する。 */
export function ShortcutSettingsProvider({
  settings,
  children,
}: {
  settings: KeyboardShortcutSettings;
  children: ReactNode;
}) {
  const normalizedSettings = useMemo(
    () => normalizeKeyboardShortcutSettings(settings),
    [settings],
  );
  return (
    <ShortcutSettingsContext.Provider value={normalizedSettings}>
      {children}
    </ShortcutSettingsContext.Provider>
  );
}

/** 最も近い設定の提供元を参照し、提供元がなければ既定の割り当てを取得する。 */
export function useShortcutSettings(): KeyboardShortcutSettings {
  return useContext(ShortcutSettingsContext);
}
