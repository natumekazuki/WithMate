export type ShortcutPlatform = "windows" | "linux" | "macos";

export type ShortcutAccelerator = Readonly<{
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}>;

export type ShortcutBindingKind = "letter" | "enter";

export type KeyboardShortcutPolicyEntry = Readonly<{
  id: string;
  scope: string;
  exclusiveScopeGroup?: string;
  accelerators: Readonly<Record<ShortcutPlatform, ShortcutAccelerator>>;
  customizable: boolean;
  bindingKind?: ShortcutBindingKind;
}>;

export type KeyboardShortcutOverride = Readonly<Partial<Record<ShortcutPlatform, ShortcutAccelerator>>>;

export type KeyboardShortcutSettings = Readonly<{
  overrides: Readonly<Record<string, KeyboardShortcutOverride>>;
}>;

export const DEFAULT_KEYBOARD_SHORTCUT_SETTINGS: KeyboardShortcutSettings = {
  overrides: {},
};

export type NormalizedShortcutAccelerator = Readonly<{
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}>;

export type ShortcutCaptureResult =
  | { kind: "accepted"; accelerator: ShortcutAccelerator }
  | {
      kind: "rejected";
      reason:
        | "empty-key"
        | "modifier-only"
        | "composing"
        | "repeat"
        | "dead-key"
        | "process-key"
        | "alt-graph";
    };

export type ShortcutCaptureEvent = Readonly<{
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  repeat: boolean;
  getModifierState?: (key: string) => boolean;
}>;

const SHORTCUT_PLATFORMS: readonly ShortcutPlatform[] = ["windows", "linux", "macos"];

export const DEFAULT_KEYBOARD_SHORTCUT_POLICY_ENTRIES: readonly KeyboardShortcutPolicyEntry[] = [
  {
    id: "session.message.find",
    scope: "message-list",
    exclusiveScopeGroup: "session-content",
    accelerators: {
      windows: { key: "f", ctrlKey: true },
      linux: { key: "f", ctrlKey: true },
      macos: { key: "f", metaKey: true },
    },
    customizable: false,
  },
  {
    id: "session.message.close-find",
    scope: "message-list",
    exclusiveScopeGroup: "session-content",
    accelerators: {
      windows: { key: "Escape" },
      linux: { key: "Escape" },
      macos: { key: "Escape" },
    },
    customizable: false,
  },
  {
    id: "session.message.toggle-collapse",
    scope: "message-list",
    exclusiveScopeGroup: "session-content",
    accelerators: {
      windows: { key: "m", ctrlKey: true, shiftKey: true },
      linux: { key: "m", ctrlKey: true, shiftKey: true },
      macos: { key: "m", metaKey: true, shiftKey: true },
    },
    customizable: true,
    bindingKind: "letter",
  },
  {
    id: "session.file-preview.find",
    scope: "file-preview",
    exclusiveScopeGroup: "session-content",
    accelerators: {
      windows: { key: "f", ctrlKey: true },
      linux: { key: "f", ctrlKey: true },
      macos: { key: "f", metaKey: true },
    },
    customizable: false,
  },
  {
    id: "session.file-preview.close",
    scope: "file-preview",
    exclusiveScopeGroup: "session-content",
    accelerators: {
      windows: { key: "Escape" },
      linux: { key: "Escape" },
      macos: { key: "Escape" },
    },
    customizable: false,
  },
  {
    id: "session.file-preview.select-all",
    scope: "file-preview",
    exclusiveScopeGroup: "session-content",
    accelerators: {
      windows: { key: "a", ctrlKey: true },
      linux: { key: "a", ctrlKey: true },
      macos: { key: "a", metaKey: true },
    },
    customizable: false,
  },
  {
    id: "session.composer.submit",
    scope: "composer",
    accelerators: {
      windows: { key: "Enter", ctrlKey: true },
      linux: { key: "Enter", ctrlKey: true },
      macos: { key: "Enter", metaKey: true },
    },
    customizable: true,
    bindingKind: "enter",
  },
];

const MODIFIER_ONLY_KEYS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Ctrl",
  "Command",
  "Cmd",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "Option",
  "OS",
  "ScrollLock",
  "Shift",
  "Super",
  "Win",
].map((key) => key.toLocaleLowerCase("en-US")));

export function createDefaultKeyboardShortcutSettings(): KeyboardShortcutSettings {
  return DEFAULT_KEYBOARD_SHORTCUT_SETTINGS;
}

export function normalizeShortcutKey(key: string): string {
  const rawKey = key === " " ? key : key.trim();
  const aliases: Record<string, string> = {
    Esc: "Escape",
    Spacebar: " ",
  };
  const normalized = aliases[rawKey] ?? rawKey;
  return normalized.length === 1 ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export function normalizeShortcutAccelerator(accelerator: ShortcutAccelerator): NormalizedShortcutAccelerator {
  return {
    key: normalizeShortcutKey(accelerator.key),
    ctrlKey: accelerator.ctrlKey === true,
    metaKey: accelerator.metaKey === true,
    shiftKey: accelerator.shiftKey === true,
    altKey: accelerator.altKey === true,
  };
}

export function shortcutAcceleratorSignature(accelerator: ShortcutAccelerator): string {
  const normalized = normalizeShortcutAccelerator(accelerator);
  return [
    normalized.key,
    normalized.ctrlKey,
    normalized.metaKey,
    normalized.shiftKey,
    normalized.altKey,
  ].join("/");
}

export function isAllowedShortcutAccelerator(
  accelerator: ShortcutAccelerator,
  platform: ShortcutPlatform,
  bindingKind: ShortcutBindingKind,
): boolean {
  const normalized = normalizeShortcutAccelerator(accelerator);
  if (
    !normalized.key ||
    isModifierOnlyKey(normalized.key) ||
    normalized.key === "Dead" ||
    normalized.key === "Process" ||
    isAltGraphAccelerator(normalized)
  ) {
    return false;
  }

  if (bindingKind === "letter") {
    if (!/^[a-z]$/.test(normalized.key)) {
      return false;
    }

    if (platform === "macos") {
      return (
        normalized.metaKey && normalized.shiftKey && !normalized.ctrlKey && !normalized.altKey
      ) || (
        normalized.metaKey && normalized.altKey && !normalized.ctrlKey && !normalized.shiftKey
      );
    }

    return (
      normalized.ctrlKey && normalized.shiftKey && !normalized.metaKey && !normalized.altKey
    ) || (
      normalized.altKey && normalized.shiftKey && !normalized.ctrlKey && !normalized.metaKey
    );
  }

  if (normalized.key !== "Enter") {
    return false;
  }

  if (platform === "macos") {
    return !normalized.ctrlKey && (normalized.metaKey || normalized.altKey);
  }

  return !normalized.metaKey && (normalized.ctrlKey || normalized.altKey);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAltGraphAccelerator(accelerator: ShortcutAccelerator): boolean {
  return accelerator.ctrlKey === true && accelerator.altKey === true;
}

function isModifierOnlyKey(key: string): boolean {
  return MODIFIER_ONLY_KEYS.has(key.toLocaleLowerCase("en-US"));
}

function parseShortcutAccelerator(
  value: unknown,
  platform?: ShortcutPlatform,
  bindingKind?: ShortcutBindingKind,
): ShortcutAccelerator | null {
  if (!isRecord(value) || typeof value.key !== "string") {
    return null;
  }

  const key = normalizeShortcutKey(value.key);
  if (!key || isModifierOnlyKey(key) || key === "Dead" || key === "Process") {
    return null;
  }

  const accelerator: ShortcutAccelerator = {
    key,
    ...(value.ctrlKey === true ? { ctrlKey: true } : {}),
    ...(value.metaKey === true ? { metaKey: true } : {}),
    ...(value.shiftKey === true ? { shiftKey: true } : {}),
    ...(value.altKey === true ? { altKey: true } : {}),
  };
  if (isAltGraphAccelerator(accelerator)) {
    return null;
  }
  if (platform && bindingKind && !isAllowedShortcutAccelerator(accelerator, platform, bindingKind)) {
    return null;
  }
  return accelerator;
}

export type ShortcutNormalizationOptions = Readonly<{
  removeCollisions?: boolean;
}>;

function canShortcutScopesBeActiveTogether(
  left: KeyboardShortcutPolicyEntry,
  right: KeyboardShortcutPolicyEntry,
): boolean {
  if (left.scope === right.scope) {
    return true;
  }

  return (
    left.exclusiveScopeGroup === undefined ||
    left.exclusiveScopeGroup !== right.exclusiveScopeGroup
  );
}

function removeShortcutOverride(
  overrides: Record<string, Partial<Record<ShortcutPlatform, ShortcutAccelerator>>>,
  commandId: string,
  platform: ShortcutPlatform,
): void {
  const commandOverrides = overrides[commandId];
  if (!commandOverrides) {
    return;
  }

  delete commandOverrides[platform];
  if (Object.keys(commandOverrides).length === 0) {
    delete overrides[commandId];
  }
}

function removeShortcutOverrideCollisions(
  settings: KeyboardShortcutSettings,
  policyEntries: readonly KeyboardShortcutPolicyEntry[],
): KeyboardShortcutSettings {
  const overrides: Record<string, Partial<Record<ShortcutPlatform, ShortcutAccelerator>>> = Object.fromEntries(
    Object.entries(settings.overrides).map(([commandId, commandOverrides]) => [commandId, { ...commandOverrides }]),
  );

  for (const platform of SHORTCUT_PLATFORMS) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let leftIndex = 0; leftIndex < policyEntries.length; leftIndex += 1) {
        const left = policyEntries[leftIndex];
        const leftAccelerator = overrides[left.id]?.[platform] ?? left.accelerators[platform];
        for (let rightIndex = leftIndex + 1; rightIndex < policyEntries.length; rightIndex += 1) {
          const right = policyEntries[rightIndex];
          if (!canShortcutScopesBeActiveTogether(left, right)) {
            continue;
          }

          const rightAccelerator = overrides[right.id]?.[platform] ?? right.accelerators[platform];
          if (shortcutAcceleratorSignature(leftAccelerator) !== shortcutAcceleratorSignature(rightAccelerator)) {
            continue;
          }

          const removableIds = [left, right]
            .filter((entry) => entry.customizable && overrides[entry.id]?.[platform])
            .map((entry) => entry.id);
          if (removableIds.length === 0) {
            continue;
          }

          for (const commandId of removableIds) {
            removeShortcutOverride(overrides, commandId, platform);
          }
          changed = true;
          break;
        }
        if (changed) {
          break;
        }
      }
    }
  }

  return { overrides };
}

export function normalizeKeyboardShortcutSettings(
  value: unknown,
  policyEntries: readonly KeyboardShortcutPolicyEntry[] = DEFAULT_KEYBOARD_SHORTCUT_POLICY_ENTRIES,
  options: ShortcutNormalizationOptions = {},
): KeyboardShortcutSettings {
  if (!isRecord(value) || !isRecord(value.overrides)) {
    return createDefaultKeyboardShortcutSettings();
  }

  const policyById = new Map(policyEntries.map((entry) => [entry.id, entry]));
  const overrides: Record<string, KeyboardShortcutOverride> = {};
  for (const [commandId, rawCommandOverrides] of Object.entries(value.overrides)) {
    const policyEntry = policyById.get(commandId);
    if (!commandId.trim() || !policyEntry?.customizable || !policyEntry.bindingKind || !isRecord(rawCommandOverrides)) {
      continue;
    }

    const commandOverrides: Partial<Record<ShortcutPlatform, ShortcutAccelerator>> = {};
    for (const platform of SHORTCUT_PLATFORMS) {
      const accelerator = parseShortcutAccelerator(
        rawCommandOverrides[platform],
        platform,
        policyEntry.bindingKind,
      );
      if (accelerator) {
        commandOverrides[platform] = accelerator;
      }
    }

    if (Object.keys(commandOverrides).length > 0) {
      overrides[commandId] = commandOverrides;
    }
  }

  const normalizedSettings = { overrides };
  return options.removeCollisions === false
    ? normalizedSettings
    : removeShortcutOverrideCollisions(normalizedSettings, policyEntries);
}

export function updateKeyboardShortcutBinding(
  settings: KeyboardShortcutSettings,
  commandId: string,
  platform: ShortcutPlatform,
  accelerator: ShortcutAccelerator | null,
  policyEntries: readonly KeyboardShortcutPolicyEntry[] = DEFAULT_KEYBOARD_SHORTCUT_POLICY_ENTRIES,
): KeyboardShortcutSettings {
  const policyEntry = policyEntries.find((entry) => entry.id === commandId);
  if (!policyEntry?.customizable || !policyEntry.bindingKind) {
    throw new Error("Keyboard shortcut command is not customizable.");
  }

  const normalizedSettings = normalizeKeyboardShortcutSettings(settings, policyEntries);
  const overrides: Record<string, KeyboardShortcutOverride> = Object.fromEntries(
    Object.entries(normalizedSettings.overrides).map(([id, commandOverrides]) => [id, { ...commandOverrides }]),
  );
  const commandOverrides = { ...(overrides[commandId] ?? {}) };

  if (accelerator === null) {
    delete commandOverrides[platform];
  } else {
    const normalizedAccelerator = parseShortcutAccelerator(accelerator, platform, policyEntry.bindingKind);
    if (!normalizedAccelerator) {
      throw new Error("Invalid keyboard shortcut accelerator.");
    }
    commandOverrides[platform] = normalizedAccelerator;
  }

  if (Object.keys(commandOverrides).length > 0) {
    overrides[commandId] = commandOverrides;
  } else {
    delete overrides[commandId];
  }

  return { overrides };
}

export function captureShortcutAccelerator(
  event: ShortcutCaptureEvent,
): ShortcutCaptureResult {
  if (event.isComposing) {
    return { kind: "rejected", reason: "composing" };
  }
  if (event.repeat) {
    return { kind: "rejected", reason: "repeat" };
  }
  if (event.key === "Dead") {
    return { kind: "rejected", reason: "dead-key" };
  }
  if (event.key === "Process") {
    return { kind: "rejected", reason: "process-key" };
  }
  if (event.getModifierState?.("AltGraph") === true || (event.ctrlKey && event.altKey)) {
    return { kind: "rejected", reason: "alt-graph" };
  }

  const key = normalizeShortcutKey(event.key);
  if (!key) {
    return { kind: "rejected", reason: "empty-key" };
  }
  if (isModifierOnlyKey(key)) {
    return { kind: "rejected", reason: "modifier-only" };
  }

  return {
    kind: "accepted",
    accelerator: {
      key,
      ...(event.ctrlKey ? { ctrlKey: true } : {}),
      ...(event.metaKey ? { metaKey: true } : {}),
      ...(event.shiftKey ? { shiftKey: true } : {}),
      ...(event.altKey ? { altKey: true } : {}),
    },
  };
}
