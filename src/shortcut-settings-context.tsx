import { createContext, useContext, useMemo, type ReactNode } from "react";

import {
  createDefaultKeyboardShortcutSettings,
  normalizeKeyboardShortcutSettings,
  type KeyboardShortcutSettings,
} from "./keyboard-shortcut-state.js";

const DEFAULT_SETTINGS = createDefaultKeyboardShortcutSettings();
const ShortcutSettingsContext = createContext<KeyboardShortcutSettings>(DEFAULT_SETTINGS);

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

export function useShortcutSettings(): KeyboardShortcutSettings {
  return useContext(ShortcutSettingsContext);
}
