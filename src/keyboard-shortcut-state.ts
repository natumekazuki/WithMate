export type ShortcutPlatform = "windows" | "linux" | "macos";

export type ShortcutAccelerator = Readonly<{
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
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

const MODIFIER_ONLY_KEYS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "OS",
  "ScrollLock",
  "Shift",
  "Super",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAltGraphAccelerator(accelerator: ShortcutAccelerator): boolean {
  return accelerator.ctrlKey === true && accelerator.altKey === true;
}

function isModifierOnlyKey(key: string): boolean {
  return MODIFIER_ONLY_KEYS.has(key.toLocaleLowerCase("en-US"));
}

function parseShortcutAccelerator(value: unknown): ShortcutAccelerator | null {
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
  return isAltGraphAccelerator(accelerator) ? null : accelerator;
}

export function normalizeKeyboardShortcutSettings(value: unknown): KeyboardShortcutSettings {
  if (!isRecord(value) || !isRecord(value.overrides)) {
    return createDefaultKeyboardShortcutSettings();
  }

  const overrides: Record<string, KeyboardShortcutOverride> = {};
  for (const [commandId, rawCommandOverrides] of Object.entries(value.overrides)) {
    if (!commandId.trim() || !isRecord(rawCommandOverrides)) {
      continue;
    }

    const commandOverrides: Partial<Record<ShortcutPlatform, ShortcutAccelerator>> = {};
    for (const platform of SHORTCUT_PLATFORMS) {
      const accelerator = parseShortcutAccelerator(rawCommandOverrides[platform]);
      if (accelerator) {
        commandOverrides[platform] = accelerator;
      }
    }

    if (Object.keys(commandOverrides).length > 0) {
      overrides[commandId] = commandOverrides;
    }
  }

  return { overrides };
}

export function updateKeyboardShortcutBinding(
  settings: KeyboardShortcutSettings,
  commandId: string,
  platform: ShortcutPlatform,
  accelerator: ShortcutAccelerator | null,
): KeyboardShortcutSettings {
  const normalizedSettings = normalizeKeyboardShortcutSettings(settings);
  const overrides: Record<string, KeyboardShortcutOverride> = Object.fromEntries(
    Object.entries(normalizedSettings.overrides).map(([id, commandOverrides]) => [id, { ...commandOverrides }]),
  );
  const commandOverrides = { ...(overrides[commandId] ?? {}) };

  if (accelerator === null) {
    delete commandOverrides[platform];
  } else {
    const normalizedAccelerator = parseShortcutAccelerator(accelerator);
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
