import { useEffect, useRef } from "react";

export type ShortcutPlatform = "windows" | "linux" | "macos";
export type ShortcutCommandKind = "standard" | "withmate";
export type ShortcutAssignment = "existing" | "new";

export const SHORTCUT_COMMAND_IDS = {
  messageFind: "session.message.find",
  messageCloseFind: "session.message.close-find",
  filePreviewFind: "session.file-preview.find",
  filePreviewClose: "session.file-preview.close",
  filePreviewSelectAll: "session.file-preview.select-all",
  composerSubmit: "session.composer.submit",
} as const;

export type ShortcutCommandId = typeof SHORTCUT_COMMAND_IDS[keyof typeof SHORTCUT_COMMAND_IDS];

export type ShortcutAccelerator = Readonly<{
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}>;

export type ShortcutEntry = Readonly<{
  id: string;
  label: string;
  kind: ShortcutCommandKind;
  scope: string;
  accelerators: Readonly<{
    windows: ShortcutAccelerator;
    linux: ShortcutAccelerator;
    macos: ShortcutAccelerator;
  }>;
  allowInEditingTarget: boolean;
  editingTargetScope?: string;
  allowRepeat: boolean;
  showInHelp: boolean;
  assignment: ShortcutAssignment;
}>;

export type ShortcutHandlerContext = Readonly<{
  command: ShortcutEntry;
  event: KeyboardEvent;
  platform: ShortcutPlatform;
}>;

export type ShortcutHandler = (context: ShortcutHandlerContext) => boolean | void;

const SHORTCUT_SCOPE_LABELS: Record<string, string> = {
  "message-list": "Messages",
  "file-preview": "File preview",
  composer: "Composer",
  settings: "Settings",
};

// Message list and file preview are alternate central content surfaces. Their
// identical standard accelerators are valid only because isContentActive makes
// these scopes mutually exclusive at runtime.
const EXCLUSIVE_SCOPE_GROUPS: Record<string, string | undefined> = {
  "message-list": "session-content",
  "file-preview": "session-content",
};

export const SHORTCUT_ENTRIES: readonly ShortcutEntry[] = [
  {
    id: SHORTCUT_COMMAND_IDS.messageFind,
    label: "Find messages",
    kind: "standard",
    scope: "message-list",
    accelerators: {
      windows: { key: "f", ctrlKey: true },
      linux: { key: "f", ctrlKey: true },
      macos: { key: "f", metaKey: true },
    },
    allowInEditingTarget: true,
    allowRepeat: false,
    showInHelp: true,
    assignment: "existing",
  },
  {
    id: SHORTCUT_COMMAND_IDS.messageCloseFind,
    label: "Close message search",
    kind: "standard",
    scope: "message-list",
    accelerators: {
      windows: { key: "Escape" },
      linux: { key: "Escape" },
      macos: { key: "Escape" },
    },
    allowInEditingTarget: true,
    allowRepeat: false,
    showInHelp: true,
    assignment: "existing",
  },
  {
    id: SHORTCUT_COMMAND_IDS.filePreviewFind,
    label: "Find in file preview",
    kind: "standard",
    scope: "file-preview",
    accelerators: {
      windows: { key: "f", ctrlKey: true },
      linux: { key: "f", ctrlKey: true },
      macos: { key: "f", metaKey: true },
    },
    allowInEditingTarget: true,
    allowRepeat: false,
    showInHelp: true,
    assignment: "existing",
  },
  {
    id: SHORTCUT_COMMAND_IDS.filePreviewClose,
    label: "Close file preview or search",
    kind: "standard",
    scope: "file-preview",
    accelerators: {
      windows: { key: "Escape" },
      linux: { key: "Escape" },
      macos: { key: "Escape" },
    },
    allowInEditingTarget: true,
    allowRepeat: false,
    showInHelp: true,
    assignment: "existing",
  },
  {
    id: SHORTCUT_COMMAND_IDS.filePreviewSelectAll,
    label: "Select all preview text",
    kind: "standard",
    scope: "file-preview",
    accelerators: {
      windows: { key: "a", ctrlKey: true },
      linux: { key: "a", ctrlKey: true },
      macos: { key: "a", metaKey: true },
    },
    allowInEditingTarget: false,
    allowRepeat: false,
    showInHelp: true,
    assignment: "existing",
  },
  {
    id: SHORTCUT_COMMAND_IDS.composerSubmit,
    label: "Send message",
    kind: "withmate",
    scope: "composer",
    accelerators: {
      windows: { key: "Enter", ctrlKey: true },
      linux: { key: "Enter", ctrlKey: true },
      macos: { key: "Enter", metaKey: true },
    },
    allowInEditingTarget: true,
    editingTargetScope: "composer",
    allowRepeat: false,
    showInHelp: true,
    // This is an existing WithMate assignment retained for compatibility. New
    // WithMate assignments are validated against Ctrl/Cmd+Shift+A-Z below.
    assignment: "existing",
  },
];

export type ShortcutHelpItem = Readonly<{
  id: string;
  label: string;
  acceleratorLabel: string;
}>;

export type ShortcutHelpGroup = Readonly<{
  scope: string;
  scopeLabel: string;
  items: readonly ShortcutHelpItem[];
}>;

export class ShortcutRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShortcutRegistryError";
  }
}

function normalizeKey(key: string): string {
  const aliases: Record<string, string> = {
    Esc: "Escape",
    Spacebar: " ",
  };
  const normalized = aliases[key] ?? key;
  return normalized.length === 1 ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function normalizeAccelerator(accelerator: ShortcutAccelerator): Required<ShortcutAccelerator> {
  return {
    key: normalizeKey(accelerator.key),
    ctrlKey: accelerator.ctrlKey === true,
    metaKey: accelerator.metaKey === true,
    shiftKey: accelerator.shiftKey === true,
    altKey: accelerator.altKey === true,
  };
}

function acceleratorSignature(accelerator: ShortcutAccelerator): string {
  const normalized = normalizeAccelerator(accelerator);
  return [
    normalized.key,
    normalized.ctrlKey,
    normalized.metaKey,
    normalized.shiftKey,
    normalized.altKey,
  ].join("/");
}

function canScopesBeActiveTogether(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const leftGroup = EXCLUSIVE_SCOPE_GROUPS[left];
  const rightGroup = EXCLUSIVE_SCOPE_GROUPS[right];
  return leftGroup === undefined || leftGroup !== rightGroup;
}

function isAllowedNewWithMateAccelerator(
  accelerator: ShortcutAccelerator,
  platform: ShortcutPlatform,
): boolean {
  const normalized = normalizeAccelerator(accelerator);
  const isLetter = /^[a-z]$/.test(normalized.key);
  if (!isLetter || !normalized.shiftKey || normalized.altKey) {
    return false;
  }

  if (platform === "macos") {
    return normalized.metaKey && !normalized.ctrlKey;
  }

  return normalized.ctrlKey && !normalized.metaKey;
}

export function validateShortcutEntries(entries: readonly ShortcutEntry[]): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.id.trim()) {
      throw new ShortcutRegistryError("Shortcut command ID must not be empty.");
    }
    if (ids.has(entry.id)) {
      throw new ShortcutRegistryError(`Duplicate shortcut command ID: ${entry.id}`);
    }
    ids.add(entry.id);

    if (!entry.label.trim()) {
      throw new ShortcutRegistryError(`Shortcut label must not be empty: ${entry.id}`);
    }
    if (entry.kind === "withmate" && entry.assignment === "new") {
      for (const platform of ["windows", "linux"] as const) {
        if (!isAllowedNewWithMateAccelerator(entry.accelerators[platform], platform)) {
          throw new ShortcutRegistryError(
            `WithMate shortcut is outside Ctrl+Shift+A-Z: ${entry.id}`,
          );
        }
      }
      if (!isAllowedNewWithMateAccelerator(entry.accelerators.macos, "macos")) {
        throw new ShortcutRegistryError(
          `WithMate shortcut is outside Cmd+Shift+A-Z: ${entry.id}`,
        );
      }
    }
  }

  for (let index = 0; index < entries.length; index += 1) {
    const left = entries[index];
    if (!left) {
      continue;
    }
    for (let otherIndex = index + 1; otherIndex < entries.length; otherIndex += 1) {
      const right = entries[otherIndex];
      if (!right || !canScopesBeActiveTogether(left.scope, right.scope)) {
        continue;
      }
      for (const platform of ["windows", "linux", "macos"] as const) {
        if (acceleratorSignature(left.accelerators[platform]) !== acceleratorSignature(right.accelerators[platform])) {
          continue;
        }
        throw new ShortcutRegistryError(
          `Shortcut accelerator collision in active scopes: ${left.id} / ${right.id} (${platform})`,
        );
      }
    }
  }
}

validateShortcutEntries(SHORTCUT_ENTRIES);

const SHORTCUT_ENTRIES_BY_ID = new Map(SHORTCUT_ENTRIES.map((entry) => [entry.id, entry]));

export function getShortcutEntry(commandId: string): ShortcutEntry {
  const entry = SHORTCUT_ENTRIES_BY_ID.get(commandId);
  if (!entry) {
    throw new ShortcutRegistryError(`Unknown shortcut command ID: ${commandId}`);
  }
  return entry;
}

export function detectShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator !== "undefined") {
    const platform = navigator.platform.toLocaleLowerCase("en-US");
    if (platform.includes("mac") || platform.includes("iphone") || platform.includes("ipad")) {
      return "macos";
    }
    if (platform.includes("linux")) {
      return "linux";
    }
  }
  return "windows";
}

export function getShortcutAccelerator(
  commandId: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): ShortcutAccelerator {
  return getShortcutEntry(commandId).accelerators[platform];
}

function formatKey(key: string): string {
  switch (normalizeKey(key)) {
    case "Escape":
      return "Esc";
    case " ":
      return "Space";
    default:
      return key.length === 1 ? key.toLocaleUpperCase("en-US") : key;
  }
}

export function formatShortcutAccelerator(
  accelerator: ShortcutAccelerator,
  platform: ShortcutPlatform,
): string {
  const normalized = normalizeAccelerator(accelerator);
  if (platform === "macos") {
    const modifiers = [
      normalized.ctrlKey ? "⌃" : "",
      normalized.metaKey ? "⌘" : "",
      normalized.altKey ? "⌥" : "",
      normalized.shiftKey ? "⇧" : "",
    ].join("");
    return `${modifiers}${formatKey(normalized.key)}`;
  }

  const modifiers = [
    normalized.ctrlKey ? "Ctrl" : "",
    normalized.metaKey ? "Win" : "",
    normalized.altKey ? "Alt" : "",
    normalized.shiftKey ? "Shift" : "",
  ].filter(Boolean);
  return [...modifiers, formatKey(normalized.key)].join("+");
}

export function getShortcutLabel(
  commandId: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  return formatShortcutAccelerator(getShortcutAccelerator(commandId, platform), platform);
}

export function getShortcutTooltip(
  commandId: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  const entry = getShortcutEntry(commandId);
  return `${entry.label} (${getShortcutLabel(commandId, platform)})`;
}

export function appendShortcutLabel(
  label: string | undefined,
  commandId: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  const baseLabel = label?.trim() || getShortcutEntry(commandId).label;
  return `${baseLabel} (${getShortcutLabel(commandId, platform)})`;
}

export function getShortcutHelpProjection(
  platform: ShortcutPlatform = detectShortcutPlatform(),
): readonly ShortcutHelpGroup[] {
  const groups = new Map<string, ShortcutHelpItem[]>();
  for (const entry of SHORTCUT_ENTRIES) {
    if (!entry.showInHelp) {
      continue;
    }
    const group = groups.get(entry.scope) ?? [];
    group.push({
      id: entry.id,
      label: entry.label,
      acceleratorLabel: formatShortcutAccelerator(entry.accelerators[platform], platform),
    });
    groups.set(entry.scope, group);
  }

  return Array.from(groups, ([scope, items]) => ({
    scope,
    scopeLabel: SHORTCUT_SCOPE_LABELS[scope] ?? scope,
    items,
  }));
}

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
    || target.closest("[contenteditable]:not([contenteditable='false'])") !== null;
}

function isWithinEditingTargetScope(target: EventTarget | null, scope: string): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.closest("[data-shortcut-scope]")?.getAttribute("data-shortcut-scope") === scope;
}

function isAltGraphEvent(event: KeyboardEvent): boolean {
  return event.getModifierState?.("AltGraph") === true || (event.ctrlKey && event.altKey);
}

function isBlockedKeyboardEvent(event: KeyboardEvent): boolean {
  return event.defaultPrevented
    || event.isComposing
    || event.key === "Dead"
    || event.key === "Process"
    || isAltGraphEvent(event);
}

function matchesAccelerator(event: KeyboardEvent, accelerator: ShortcutAccelerator): boolean {
  const expected = normalizeAccelerator(accelerator);
  return normalizeKey(event.key) === expected.key
    && event.ctrlKey === expected.ctrlKey
    && event.metaKey === expected.metaKey
    && event.shiftKey === expected.shiftKey
    && event.altKey === expected.altKey;
}

type ShortcutDispatcherOptions = Readonly<{
  eventTarget: Window;
  platform?: ShortcutPlatform;
  entries?: readonly ShortcutEntry[];
}>;

export class ShortcutDispatcher {
  private readonly eventTarget: Window;
  private readonly platform: ShortcutPlatform;
  private readonly entries: readonly ShortcutEntry[];
  private readonly handlers = new Map<string, ShortcutHandler>();
  private readonly activeScopes = new Set<string>();
  private readonly scopeRegistrations = new Map<string, Set<symbol>>();
  private listening = false;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.dispatch(event);
  };

  constructor(options: ShortcutDispatcherOptions) {
    this.eventTarget = options.eventTarget;
    this.platform = options.platform ?? detectShortcutPlatform();
    this.entries = options.entries ?? SHORTCUT_ENTRIES;
    validateShortcutEntries(this.entries);
  }

  registerHandler(commandId: string, handler: ShortcutHandler): () => void {
    const entry = this.entries.find((candidate) => candidate.id === commandId);
    if (!entry) {
      throw new ShortcutRegistryError(`Unknown shortcut command ID: ${commandId}`);
    }
    if (this.handlers.has(commandId)) {
      throw new ShortcutRegistryError(`Duplicate shortcut handler registration: ${commandId}`);
    }

    this.handlers.set(commandId, handler);
    this.start();
    return () => {
      if (this.handlers.get(commandId) !== handler) {
        return;
      }
      this.handlers.delete(commandId);
      if (this.handlers.size === 0) {
        this.stop();
      }
    };
  }

  registerScope(scope: string): () => void {
    const nextScopes = new Set(this.activeScopes);
    nextScopes.add(scope);
    this.assertNoActiveScopeCollision(nextScopes);

    const token = Symbol(scope);
    const registrations = this.scopeRegistrations.get(scope) ?? new Set<symbol>();
    registrations.add(token);
    this.scopeRegistrations.set(scope, registrations);
    this.activeScopes.add(scope);

    return () => {
      const currentRegistrations = this.scopeRegistrations.get(scope);
      if (!currentRegistrations?.delete(token)) {
        return;
      }
      if (currentRegistrations.size === 0) {
        this.scopeRegistrations.delete(scope);
        this.activeScopes.delete(scope);
      }
    };
  }

  isScopeActive(scope: string): boolean {
    return this.activeScopes.has(scope);
  }

  dispatch(event: KeyboardEvent): boolean {
    if (isBlockedKeyboardEvent(event)) {
      return false;
    }

    const candidates = this.entries.filter((entry) => {
      if (!this.activeScopes.has(entry.scope) || !this.handlers.has(entry.id)) {
        return false;
      }
      if (event.repeat && !entry.allowRepeat) {
        return false;
      }
      if (entry.editingTargetScope && !isWithinEditingTargetScope(event.target, entry.editingTargetScope)) {
        return false;
      }
      if (!entry.allowInEditingTarget && isEditingTarget(event.target)) {
        return false;
      }
      return matchesAccelerator(event, entry.accelerators[this.platform]);
    });
    if (candidates.length === 0) {
      return false;
    }
    if (candidates.length > 1) {
      throw new ShortcutRegistryError(
        `Multiple active shortcut commands match ${event.key}: ${candidates.map((entry) => entry.id).join(", ")}`,
      );
    }

    const command = candidates[0];
    if (!command) {
      return false;
    }
    const handler = this.handlers.get(command.id);
    if (!handler) {
      return false;
    }
    const handled = handler({ command, event, platform: this.platform });
    if (handled === false) {
      return false;
    }
    event.preventDefault();
    return true;
  }

  dispose(): void {
    this.stop();
    this.handlers.clear();
    this.activeScopes.clear();
    this.scopeRegistrations.clear();
  }

  private assertNoActiveScopeCollision(scopes: ReadonlySet<string>): void {
    const activeEntries = this.entries.filter((entry) => scopes.has(entry.scope));
    for (let index = 0; index < activeEntries.length; index += 1) {
      const left = activeEntries[index];
      if (!left) {
        continue;
      }
      for (let otherIndex = index + 1; otherIndex < activeEntries.length; otherIndex += 1) {
        const right = activeEntries[otherIndex];
        if (!right || left.scope === right.scope) {
          continue;
        }
        if (acceleratorSignature(left.accelerators[this.platform]) !== acceleratorSignature(right.accelerators[this.platform])) {
          continue;
        }
        throw new ShortcutRegistryError(
          `Mutually exclusive shortcut scopes are active together: ${left.scope} / ${right.scope}`,
        );
      }
    }
  }

  private start(): void {
    if (this.listening) {
      return;
    }
    this.eventTarget.addEventListener("keydown", this.onKeyDown);
    this.listening = true;
  }

  private stop(): void {
    if (!this.listening) {
      return;
    }
    this.eventTarget.removeEventListener("keydown", this.onKeyDown);
    this.listening = false;
  }
}

const dispatchersByWindow = new WeakMap<Window, ShortcutDispatcher>();

export function getShortcutDispatcher(targetWindow?: Window): ShortcutDispatcher | null {
  const currentWindow = targetWindow ?? (typeof window === "undefined" ? null : window);
  if (!currentWindow) {
    return null;
  }

  const existing = dispatchersByWindow.get(currentWindow);
  if (existing) {
    return existing;
  }

  const dispatcher = new ShortcutDispatcher({ eventTarget: currentWindow });
  dispatchersByWindow.set(currentWindow, dispatcher);
  return dispatcher;
}

export function useShortcutScope(scope: string, active = true): void {
  const dispatcher = getShortcutDispatcher();
  useEffect(() => {
    if (!dispatcher || !active) {
      return undefined;
    }
    return dispatcher.registerScope(scope);
  }, [active, dispatcher, scope]);
}

export function useShortcutCommandHandler(
  commandId: string,
  handler: ShortcutHandler,
  active = true,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const dispatcher = getShortcutDispatcher();
  useEffect(() => {
    if (!dispatcher || !active) {
      return undefined;
    }
    return dispatcher.registerHandler(commandId, (context) => handlerRef.current(context));
  }, [active, commandId, dispatcher]);
}
