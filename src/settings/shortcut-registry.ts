import { useEffect, useRef } from "react";

import {
  DEFAULT_KEYBOARD_SHORTCUT_POLICY_ENTRIES,
  DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
  isAllowedShortcutAccelerator,
  normalizeKeyboardShortcutSettings,
  normalizeShortcutAccelerator as normalizeAccelerator,
  normalizeShortcutKey as normalizeKey,
  shortcutAcceleratorSignature as acceleratorSignature,
  updateKeyboardShortcutBinding,
  type KeyboardShortcutPolicyEntry,
  type KeyboardShortcutSettings,
  type ShortcutAccelerator,
  type ShortcutBindingKind,
  type ShortcutPlatform,
} from "../../src-shared/settings/keyboard-shortcut-state.js";

/** 検索などの標準操作と、WithMate 固有の操作の区別。 */
export type ShortcutCommandKind = "standard" | "withmate";
/** 互換性のため残す既存割り当てと、新規のポリシー適用対象を区別する。 */
export type ShortcutAssignment = "existing" | "new";
export type {
  KeyboardShortcutSettings,
  ShortcutAccelerator,
  ShortcutPlatform,
} from "../../src-shared/settings/keyboard-shortcut-state.js";
export {
  captureShortcutAccelerator,
  DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
  normalizeKeyboardShortcutSettings,
} from "../../src-shared/settings/keyboard-shortcut-state.js";

/** セッション画面の登録、使用状況の判定、ヘルプで共有するコマンド ID。 */
export const SHORTCUT_COMMAND_IDS = {
  messageFind: "session.message.find",
  messageCloseFind: "session.message.close-find",
  messageToggleCollapse: "session.message.toggle-collapse",
  messageToggleViewMode: "session.message.toggle-view-mode",
  conversationToggleTarget: "session.conversation.toggle-target",
  mainScrollToBottom: "session.main.scroll-to-bottom",
  auxiliaryScrollToBottom: "session.auxiliary.scroll-to-bottom",
  actionDockToggleMode: "session.action-dock.toggle-mode",
  filePreviewFind: "session.file-preview.find",
  filePreviewClose: "session.file-preview.close",
  filePreviewSelectAll: "session.file-preview.select-all",
  composerSubmit: "session.composer.submit",
  composerSendInput: "session.composer.send-input",
} as const;

/** レジストリに標準搭載されるショートカットコマンドの ID。 */
export type ShortcutCommandId =
  (typeof SHORTCUT_COMMAND_IDS)[keyof typeof SHORTCUT_COMMAND_IDS];

/** コマンドの既定キー、編集フォーカスとリピートの適用条件、ヘルプへの表示可否。 */
export type ShortcutEntry = Readonly<{
  id: string;
  label: string;
  kind: ShortcutCommandKind;
  scope: string;
  accelerators: KeyboardShortcutPolicyEntry["accelerators"];
  allowInEditingTarget: boolean;
  editingTargetScope?: string;
  allowRepeat: boolean;
  showInHelp: boolean;
  customizable: boolean;
  bindingKind?: ShortcutBindingKind;
  assignment: ShortcutAssignment;
}>;

/** 実際に一致したコマンドと入力イベント、照合に使ったプラットフォーム。 */
export type ShortcutHandlerContext = Readonly<{
  command: ShortcutEntry;
  event: KeyboardEvent;
  platform: ShortcutPlatform;
}>;

/** 一致したコマンドを処理する。false の場合はブラウザーの既定動作を抑止しない。 */
export type ShortcutHandler = (
  context: ShortcutHandlerContext,
) => boolean | void;

const SHORTCUT_SCOPE_LABELS: Record<string, string> = {
  "message-list": "Messages",
  "file-preview": "File Preview",
  composer: "Composer",
  session: "Session",
  settings: "Settings",
};

// メッセージ一覧とファイルプレビューは、中央の内容領域で切り替えて使う。
// isContentActive が実行時に両者のスコープを排他的にするため、
// 同じ標準ショートカットを割り当てられる。
const EXCLUSIVE_SCOPE_GROUPS: Record<string, string | undefined> = {
  "message-list": "session-content",
  "file-preview": "session-content",
};

const DEFAULT_POLICY_ENTRIES_BY_ID = new Map(
  DEFAULT_KEYBOARD_SHORTCUT_POLICY_ENTRIES.map((entry) => [entry.id, entry]),
);

/** 共有ポリシーから画面用エントリの基礎を得る。定義漏れは初期化エラーにする。 */
function getDefaultShortcutEntryFields(
  commandId: string,
): Pick<
  ShortcutEntry,
  "id" | "scope" | "accelerators" | "customizable" | "bindingKind"
> {
  const entry = DEFAULT_POLICY_ENTRIES_BY_ID.get(commandId);
  if (!entry) {
    throw new Error(
      `Missing default keyboard shortcut policy entry: ${commandId}`,
    );
  }
  return {
    id: entry.id,
    scope: entry.scope,
    accelerators: entry.accelerators,
    customizable: entry.customizable,
    ...(entry.bindingKind ? { bindingKind: entry.bindingKind } : {}),
  };
}

/** 画面用エントリから割り当て検証に必要な項目を抜き出し、排他グループを補う。 */
function getKeyboardShortcutPolicyEntries(
  entries: readonly ShortcutEntry[],
): readonly KeyboardShortcutPolicyEntry[] {
  return entries.map((entry) => ({
    id: entry.id,
    scope: entry.scope,
    exclusiveScopeGroup: EXCLUSIVE_SCOPE_GROUPS[entry.scope],
    accelerators: entry.accelerators,
    customizable: entry.customizable,
    ...(entry.bindingKind ? { bindingKind: entry.bindingKind } : {}),
  }));
}

/** 共有の既定キーへ、レンダラーの表示名とフォーカス・リピート時の配送条件を加えた一覧。 */
export const SHORTCUT_ENTRIES: readonly ShortcutEntry[] = [
  {
    ...getDefaultShortcutEntryFields(SHORTCUT_COMMAND_IDS.messageFind),
    label: "Find Messages",
    kind: "standard",
    allowInEditingTarget: true,
    allowRepeat: false,
    showInHelp: true,
    customizable: false,
    assignment: "existing",
  },
  {
    ...getDefaultShortcutEntryFields(SHORTCUT_COMMAND_IDS.messageCloseFind),
    label: "Close Message Search",
    kind: "standard",
    allowInEditingTarget: true,
    allowRepeat: false,
    showInHelp: true,
    customizable: false,
    assignment: "existing",
  },
  {
    ...getDefaultShortcutEntryFields(
      SHORTCUT_COMMAND_IDS.messageToggleCollapse,
    ),
    label: "Toggle Message Collapse",
    kind: "withmate",
    allowInEditingTarget: true,
    allowRepeat: false,
    showInHelp: true,
    customizable: true,
    assignment: "new",
  },
  {
    ...getDefaultShortcutEntryFields(
      SHORTCUT_COMMAND_IDS.messageToggleViewMode,
    ),
    label: "Toggle Preview Source",
    kind: "withmate",
    allowInEditingTarget: false,
    allowRepeat: false,
    showInHelp: true,
    customizable: true,
    assignment: "new",
  },
  {
    ...getDefaultShortcutEntryFields(
      SHORTCUT_COMMAND_IDS.conversationToggleTarget,
    ),
    label: "Toggle Main Auxiliary",
    kind: "withmate",
    allowInEditingTarget: false,
    allowRepeat: false,
    showInHelp: true,
    customizable: true,
    assignment: "new",
  },
  {
    ...getDefaultShortcutEntryFields(SHORTCUT_COMMAND_IDS.mainScrollToBottom),
    label: "Scroll Main To Bottom",
    kind: "withmate",
    allowInEditingTarget: true,
    allowRepeat: false,
    showInHelp: true,
    assignment: "new",
  },
  {
    ...getDefaultShortcutEntryFields(
      SHORTCUT_COMMAND_IDS.auxiliaryScrollToBottom,
    ),
    label: "Scroll Auxiliary To Bottom",
    kind: "withmate",
    allowInEditingTarget: true,
    allowRepeat: false,
    showInHelp: true,
    assignment: "new",
  },
  {
    ...getDefaultShortcutEntryFields(SHORTCUT_COMMAND_IDS.actionDockToggleMode),
    label: "Toggle Prompt Terminal",
    kind: "withmate",
    allowInEditingTarget: true,
    allowRepeat: false,
    showInHelp: true,
    customizable: true,
    assignment: "new",
  },
  {
    ...getDefaultShortcutEntryFields(SHORTCUT_COMMAND_IDS.filePreviewFind),
    label: "Find In File Preview",
    kind: "standard",
    allowInEditingTarget: true,
    allowRepeat: false,
    showInHelp: true,
    customizable: false,
    assignment: "existing",
  },
  {
    ...getDefaultShortcutEntryFields(SHORTCUT_COMMAND_IDS.filePreviewClose),
    label: "Close File Preview Or Search",
    kind: "standard",
    allowInEditingTarget: true,
    allowRepeat: false,
    showInHelp: true,
    customizable: false,
    assignment: "existing",
  },
  {
    ...getDefaultShortcutEntryFields(SHORTCUT_COMMAND_IDS.filePreviewSelectAll),
    label: "Select All Preview Text",
    kind: "standard",
    allowInEditingTarget: false,
    allowRepeat: false,
    showInHelp: true,
    customizable: false,
    assignment: "existing",
  },
  {
    ...getDefaultShortcutEntryFields(SHORTCUT_COMMAND_IDS.composerSubmit),
    label: "Send Message",
    kind: "withmate",
    allowInEditingTarget: true,
    editingTargetScope: "composer",
    allowRepeat: false,
    showInHelp: true,
    // 互換性のために、WithMate の既存の割り当てを維持する。
    assignment: "existing",
  },
  {
    ...getDefaultShortcutEntryFields(SHORTCUT_COMMAND_IDS.composerSendInput),
    label: "Send Input To Current Turn",
    kind: "withmate",
    allowInEditingTarget: true,
    editingTargetScope: "composer",
    allowRepeat: false,
    showInHelp: true,
    assignment: "new",
  },
];

/** ヘルプの一行に表示するコマンド名と、現在の割り当てを整形したキー表記。 */
export type ShortcutHelpItem = Readonly<{
  id: string;
  label: string;
  acceleratorLabel: string;
}>;

/** 同じスコープの操作を、表示用の見出しの下にまとめたヘルプ項目。 */
export type ShortcutHelpGroup = Readonly<{
  scope: string;
  scopeLabel: string;
  items: readonly ShortcutHelpItem[];
}>;

/** 重複したコマンドやキー競合など、ショートカット定義・登録に関する違反。 */
export class ShortcutRegistryError extends Error {
  /** 違反理由を保持し、一般の処理エラーと識別できる名前を付ける。 */
  constructor(message: string) {
    super(message);
    this.name = "ShortcutRegistryError";
  }
}

/** 同じスコープ、または同じ排他グループに属さないスコープの同時有効化を許容する。 */
function canScopesBeActiveTogether(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const leftGroup = EXCLUSIVE_SCOPE_GROUPS[left];
  const rightGroup = EXCLUSIVE_SCOPE_GROUPS[right];
  return leftGroup === undefined || leftGroup !== rightGroup;
}

/** ID・表示名・割り当て規約を検証し、同時に有効化できるスコープ間では同じキーを拒む。 */
export function validateShortcutEntries(
  entries: readonly ShortcutEntry[],
): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.id.trim()) {
      throw new ShortcutRegistryError("Shortcut command ID must not be empty.");
    }
    if (ids.has(entry.id)) {
      throw new ShortcutRegistryError(
        `Duplicate shortcut command ID: ${entry.id}`,
      );
    }
    ids.add(entry.id);

    if (!entry.label.trim()) {
      throw new ShortcutRegistryError(
        `Shortcut label must not be empty: ${entry.id}`,
      );
    }
    const requiresPolicy =
      entry.customizable ||
      (entry.kind === "withmate" && entry.assignment === "new");
    if (requiresPolicy) {
      if (!entry.bindingKind) {
        throw new ShortcutRegistryError(
          `Customizable shortcut is missing a binding policy: ${entry.id}`,
        );
      }
      for (const platform of ["windows", "linux", "macos"] as const) {
        const accelerator = entry.accelerators[platform];
        if (
          accelerator &&
          !isAllowedShortcutAccelerator(
            accelerator,
            platform,
            entry.bindingKind,
          )
        ) {
          throw new ShortcutRegistryError(
            `Shortcut accelerator is outside its platform policy: ${entry.id} (${platform})`,
          );
        }
      }
    }
  }

  for (let index = 0; index < entries.length; index += 1) {
    const left = entries[index];
    if (!left) {
      continue;
    }
    for (
      let otherIndex = index + 1;
      otherIndex < entries.length;
      otherIndex += 1
    ) {
      const right = entries[otherIndex];
      if (!right || !canScopesBeActiveTogether(left.scope, right.scope)) {
        continue;
      }
      for (const platform of ["windows", "linux", "macos"] as const) {
        const leftAccelerator = left.accelerators[platform];
        const rightAccelerator = right.accelerators[platform];
        if (
          !leftAccelerator ||
          !rightAccelerator ||
          acceleratorSignature(leftAccelerator) !==
            acceleratorSignature(rightAccelerator)
        ) {
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

const SHORTCUT_ENTRIES_BY_ID = new Map(
  SHORTCUT_ENTRIES.map((entry) => [entry.id, entry]),
);

/** 編集可能なコマンドに限って対象プラットフォームの上書きを優先し、なければ既定に戻る。 */
function resolveShortcutAcceleratorForEntry(
  entry: ShortcutEntry,
  platform: ShortcutPlatform,
  settings: KeyboardShortcutSettings,
): ShortcutAccelerator | null {
  return entry.customizable
    ? (settings.overrides[entry.id]?.[platform] ?? entry.accelerators[platform])
    : entry.accelerators[platform];
}

/** 保存値を正規化した実効割り当てに競合がないか調べる。競合は取り除かずエラーにする。 */
export function validateShortcutSettings(
  entries: readonly ShortcutEntry[],
  settings: KeyboardShortcutSettings,
): void {
  const policyEntries = getKeyboardShortcutPolicyEntries(entries);
  const normalized = normalizeKeyboardShortcutSettings(
    settings,
    policyEntries,
    { removeCollisions: false },
  );
  for (let index = 0; index < entries.length; index += 1) {
    const left = entries[index];
    if (!left) {
      continue;
    }
    for (
      let otherIndex = index + 1;
      otherIndex < entries.length;
      otherIndex += 1
    ) {
      const right = entries[otherIndex];
      if (!right || !canScopesBeActiveTogether(left.scope, right.scope)) {
        continue;
      }
      for (const platform of ["windows", "linux", "macos"] as const) {
        const leftAccelerator = resolveShortcutAcceleratorForEntry(
          left,
          platform,
          normalized,
        );
        const rightAccelerator = resolveShortcutAcceleratorForEntry(
          right,
          platform,
          normalized,
        );
        if (
          !leftAccelerator ||
          !rightAccelerator ||
          acceleratorSignature(leftAccelerator) !==
            acceleratorSignature(rightAccelerator)
        ) {
          continue;
        }
        throw new ShortcutRegistryError(
          `Shortcut accelerator collision in active scopes: ${left.id} / ${right.id} (${platform})`,
        );
      }
    }
  }
}

/** 対象 OS の割り当てを上書きし、null なら既定値へ戻す。固定コマンドや競合は拒否する。 */
export function updateShortcutBinding(
  settings: KeyboardShortcutSettings,
  commandId: string,
  platform: ShortcutPlatform,
  accelerator: ShortcutAccelerator | null,
): KeyboardShortcutSettings {
  const entry = getShortcutEntry(commandId);
  if (!entry.customizable) {
    throw new ShortcutRegistryError(
      `Shortcut is fixed and cannot be customized: ${commandId}`,
    );
  }
  const policyEntries = getKeyboardShortcutPolicyEntries(SHORTCUT_ENTRIES);
  const nextSettings = updateKeyboardShortcutBinding(
    settings,
    commandId,
    platform,
    accelerator,
    policyEntries,
  );
  validateShortcutSettings(SHORTCUT_ENTRIES, nextSettings);
  return nextSettings;
}

/** 標準レジストリからコマンドを引く。未知の ID は登録エラーとして扱う。 */
export function getShortcutEntry(commandId: string): ShortcutEntry {
  const entry = SHORTCUT_ENTRIES_BY_ID.get(commandId);
  if (!entry) {
    throw new ShortcutRegistryError(
      `Unknown shortcut command ID: ${commandId}`,
    );
  }
  return entry;
}

/** ブラウザーのプラットフォーム表記からキー割り当てを選ぶ。判定できなければ Windows 扱いにする。 */
export function detectShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator !== "undefined") {
    const platform = navigator.platform.toLocaleLowerCase("en-US");
    if (
      platform.includes("mac") ||
      platform.includes("iphone") ||
      platform.includes("ipad")
    ) {
      return "macos";
    }
    if (platform.includes("linux")) {
      return "linux";
    }
  }
  return "windows";
}

/** 保存設定を正規化してコマンドの実効キーを解決する。未割り当てなら null を返す。 */
export function getShortcutAccelerator(
  commandId: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  settings: KeyboardShortcutSettings = DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
): ShortcutAccelerator | null {
  const normalized = normalizeKeyboardShortcutSettings(
    settings,
    getKeyboardShortcutPolicyEntries(SHORTCUT_ENTRIES),
  );
  return resolveShortcutAcceleratorForEntry(
    getShortcutEntry(commandId),
    platform,
    normalized,
  );
}

/** Escape と空白の表示名を読みやすくし、1 文字のキーは大文字で表示する。 */
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

/** 実効キーを OS の慣例に合わせて表示し、割り当てがなければ未割り当てと示す。 */
export function formatShortcutAccelerator(
  accelerator: ShortcutAccelerator | null,
  platform: ShortcutPlatform,
): string {
  if (!accelerator) {
    return "Not Assigned";
  }
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

/** 指定コマンドの実効割り当てを現在の設定から引き、キー表示だけを返す。 */
export function getShortcutLabel(
  commandId: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  settings: KeyboardShortcutSettings = DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
): string {
  return formatShortcutAccelerator(
    getShortcutAccelerator(commandId, platform, settings),
    platform,
  );
}

/** レジストリのコマンド名に実効キーを添えたツールチップ文字列を返す。 */
export function getShortcutTooltip(
  commandId: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  settings: KeyboardShortcutSettings = DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
): string {
  const entry = getShortcutEntry(commandId);
  return `${entry.label} (${getShortcutLabel(commandId, platform, settings)})`;
}

/** 画面固有の表示名に実効キーを添える。空の表示名はレジストリのコマンド名で補う。 */
export function appendShortcutLabel(
  label: string | undefined,
  commandId: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  settings: KeyboardShortcutSettings = DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
): string {
  const baseLabel = label?.trim() || getShortcutEntry(commandId).label;
  return `${baseLabel} (${getShortcutLabel(commandId, platform, settings)})`;
}

/** ヘルプ対象の操作をスコープ別にまとめ、各行には選択中の OS と設定に対応する実効キーを表示する。 */
export function getShortcutHelpProjection(
  platform: ShortcutPlatform = detectShortcutPlatform(),
  settings: KeyboardShortcutSettings = DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
): readonly ShortcutHelpGroup[] {
  const normalized = normalizeKeyboardShortcutSettings(
    settings,
    getKeyboardShortcutPolicyEntries(SHORTCUT_ENTRIES),
  );
  const groups = new Map<string, ShortcutHelpItem[]>();
  for (const entry of SHORTCUT_ENTRIES) {
    if (!entry.showInHelp) {
      continue;
    }
    const group = groups.get(entry.scope) ?? [];
    group.push({
      id: entry.id,
      label: entry.label,
      acceleratorLabel: formatShortcutAccelerator(
        resolveShortcutAcceleratorForEntry(entry, platform, normalized),
        platform,
      ),
    });
    groups.set(entry.scope, group);
  }

  return Array.from(groups, ([scope, items]) => ({
    scope,
    scopeLabel: SHORTCUT_SCOPE_LABELS[scope] ?? scope,
    items,
  }));
}

/** フォーム入力または編集可能な DOM 要素の内側から発生した入力かを判定する。 */
function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.matches(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    ) ||
    target.closest("[contenteditable]:not([contenteditable='false'])") !== null
  );
}

/** イベント対象から最も近いショートカットスコープが指定値と一致するかを調べる。 */
function isWithinEditingTargetScope(
  target: EventTarget | null,
  scope: string,
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target
      .closest("[data-shortcut-scope]")
      ?.getAttribute("data-shortcut-scope") === scope
  );
}

/** AltGraph の状態または Ctrl+Alt として届いた入力を、ショートカットから除外するために検出する。 */
function isAltGraphEvent(event: KeyboardEvent): boolean {
  return (
    event.getModifierState?.("AltGraph") === true ||
    (event.ctrlKey && event.altKey)
  );
}

/** 処理済みのキーや IME・デッドキー・AltGraph を検出し、コマンド選択前に除外する。 */
function getBlockedKeyboardEventReason(event: KeyboardEvent): string | null {
  if (event.defaultPrevented) {
    return "default-prevented";
  }
  if (event.isComposing) {
    return "ime-composing";
  }
  if (event.key === "Dead") {
    return "dead-key";
  }
  if (event.key === "Process") {
    return "process-key";
  }
  if (isAltGraphEvent(event)) {
    return "alt-graph";
  }
  return null;
}

/** 正規化したキーと全修飾キーが一致する場合だけ割り当てに該当する。 */
function matchesAccelerator(
  event: KeyboardEvent,
  accelerator: ShortcutAccelerator | null,
): boolean {
  if (!accelerator) {
    return false;
  }
  const expected = normalizeAccelerator(accelerator);
  return (
    normalizeKey(event.key) === expected.key &&
    event.ctrlKey === expected.ctrlKey &&
    event.metaKey === expected.metaKey &&
    event.shiftKey === expected.shiftKey &&
    event.altKey === expected.altKey
  );
}

/** 配送に必要なキーイベントの監視開始・解除だけを持つ対象。 */
type ShortcutEventTarget = Pick<
  Window,
  "addEventListener" | "removeEventListener"
>;

/** 配送先ウィンドウのイベント口と、必要に応じて差し替える OS・定義・設定値。 */
type ShortcutDispatcherOptions = Readonly<{
  eventTarget: ShortcutEventTarget;
  platform?: ShortcutPlatform;
  entries?: readonly ShortcutEntry[];
  settings?: KeyboardShortcutSettings;
}>;

/** 有効なスコープと実効キーを照合し、ウィンドウのキー入力を登録済みの操作に配送する。 */
export class ShortcutDispatcher {
  private readonly eventTarget: ShortcutEventTarget;
  private readonly platform: ShortcutPlatform;
  private readonly entries: readonly ShortcutEntry[];
  private settings: KeyboardShortcutSettings =
    DEFAULT_KEYBOARD_SHORTCUT_SETTINGS;
  private readonly handlers = new Map<string, ShortcutHandler>();
  private readonly activeScopes = new Set<string>();
  private readonly scopeRegistrations = new Map<string, Set<symbol>>();
  private listening = false;

  /** 監視開始と解除で同じ参照を使い、キー入力をレジストリの配送へ渡す。 */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.dispatch(event);
  };

  /** エントリ定義を検証し、渡された設定は正規化して初期の実効割り当てにする。 */
  constructor(options: ShortcutDispatcherOptions) {
    this.eventTarget = options.eventTarget;
    this.platform = options.platform ?? detectShortcutPlatform();
    this.entries = options.entries ?? SHORTCUT_ENTRIES;
    validateShortcutEntries(this.entries);
    if (options.settings) {
      this.setSettings(options.settings);
    }
  }

  /** 現在のレジストリに対して保存値を正規化し、次の照合から新しい割り当てを使う。 */
  setSettings(settings: KeyboardShortcutSettings): void {
    this.settings = normalizeKeyboardShortcutSettings(
      settings,
      getKeyboardShortcutPolicyEntries(this.entries),
    );
  }

  /** 既知のコマンドにつき一つの処理を登録し、解除関数を返す。最後の解除でキー監視を止める。 */
  registerHandler(commandId: string, handler: ShortcutHandler): () => void {
    const entry = this.entries.find((candidate) => candidate.id === commandId);
    if (!entry) {
      throw new ShortcutRegistryError(
        `Unknown shortcut command ID: ${commandId}`,
      );
    }
    if (this.handlers.has(commandId)) {
      throw new ShortcutRegistryError(
        `Duplicate shortcut handler registration: ${commandId}`,
      );
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

  /** 同時有効化の競合がなければスコープを有効にし、最後の登録が解除されたときだけ無効化する。 */
  registerScope(scope: string): () => void {
    const nextScopes = new Set(this.activeScopes);
    nextScopes.add(scope);
    this.assertNoActiveScopeCollision(nextScopes);

    const token = Symbol(scope);
    const registrations =
      this.scopeRegistrations.get(scope) ?? new Set<symbol>();
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

  /** 少なくとも一つ有効な登録が残るスコープかを判定する。 */
  isScopeActive(scope: string): boolean {
    return this.activeScopes.has(scope);
  }

  /** イベントと指定コマンドの実効キーを照合する。スコープや処理の登録有無までは判定しない。 */
  matchesCommandShortcut(commandId: string, event: KeyboardEvent): boolean {
    const entry = this.entries.find((candidate) => candidate.id === commandId);
    return (
      !!entry &&
      !getBlockedKeyboardEventReason(event) &&
      (!event.repeat || entry.allowRepeat) &&
      matchesAccelerator(
        event,
        resolveShortcutAcceleratorForEntry(entry, this.platform, this.settings),
      )
    );
  }

  /** 編集先や有効スコープに適合する一つの操作を呼び、処理された場合だけ既定動作を抑止する。 */
  dispatch(event: KeyboardEvent): boolean {
    const blockedReason = getBlockedKeyboardEventReason(event);
    if (blockedReason) {
      return false;
    }

    const candidates = this.entries.filter((entry) => {
      if (
        isWithinEditingTargetScope(event.target, "terminal") &&
        entry.id !== SHORTCUT_COMMAND_IDS.actionDockToggleMode
      ) {
        return false;
      }
      if (!this.activeScopes.has(entry.scope) || !this.handlers.has(entry.id)) {
        return false;
      }
      if (event.repeat && !entry.allowRepeat) {
        return false;
      }
      if (
        entry.editingTargetScope &&
        !isWithinEditingTargetScope(event.target, entry.editingTargetScope)
      ) {
        return false;
      }
      if (!entry.allowInEditingTarget && isEditingTarget(event.target)) {
        return false;
      }
      return matchesAccelerator(
        event,
        resolveShortcutAcceleratorForEntry(entry, this.platform, this.settings),
      );
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

    let handled: boolean | void;
    handled = handler({ command, event, platform: this.platform });
    if (handled === false) {
      return false;
    }
    event.preventDefault();
    return true;
  }

  /** キー監視を解除し、登録済みのハンドラーと有効スコープをすべて消去する。 */
  dispose(): void {
    this.stop();
    this.handlers.clear();
    this.activeScopes.clear();
    this.scopeRegistrations.clear();
  }

  /** 有効化後の異なるスコープに同じ実効キーがあれば、登録前に競合として拒む。 */
  private assertNoActiveScopeCollision(scopes: ReadonlySet<string>): void {
    const activeEntries = this.entries.filter((entry) =>
      scopes.has(entry.scope),
    );
    for (let index = 0; index < activeEntries.length; index += 1) {
      const left = activeEntries[index];
      if (!left) {
        continue;
      }
      for (
        let otherIndex = index + 1;
        otherIndex < activeEntries.length;
        otherIndex += 1
      ) {
        const right = activeEntries[otherIndex];
        if (!right || left.scope === right.scope) {
          continue;
        }
        const leftAccelerator = resolveShortcutAcceleratorForEntry(
          left,
          this.platform,
          this.settings,
        );
        const rightAccelerator = resolveShortcutAcceleratorForEntry(
          right,
          this.platform,
          this.settings,
        );
        if (
          !leftAccelerator ||
          !rightAccelerator ||
          acceleratorSignature(leftAccelerator) !==
            acceleratorSignature(rightAccelerator)
        ) {
          continue;
        }
        throw new ShortcutRegistryError(
          `Mutually exclusive shortcut scopes are active together: ${left.scope} / ${right.scope}`,
        );
      }
    }
  }

  /** 未監視の場合にだけキーの監視を開始し、コマンド追加でリスナーを重ねない。 */
  private start(): void {
    if (this.listening) {
      return;
    }
    this.eventTarget.addEventListener("keydown", this.onKeyDown);
    this.listening = true;
  }

  /** 監視中の場合にだけ、この配送器が登録したリスナーを取り外す。 */
  private stop(): void {
    if (!this.listening) {
      return;
    }
    this.eventTarget.removeEventListener("keydown", this.onKeyDown);
    this.listening = false;
  }
}

const dispatchersByWindow = new WeakMap<Window, ShortcutDispatcher>();

/** 対象ウィンドウごとに一つの配送器を共有し、ウィンドウのない環境では null を返す。 */
export function getShortcutDispatcher(
  targetWindow?: Window,
): ShortcutDispatcher | null {
  const currentWindow =
    targetWindow ?? (typeof window === "undefined" ? null : window);
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

/** 設定変更時に現在のウィンドウの実効割り当てを更新する。 */
export function useShortcutDispatcherSettings(
  settings: KeyboardShortcutSettings,
): void {
  const dispatcher = getShortcutDispatcher();
  useEffect(() => {
    if (!dispatcher) {
      return undefined;
    }
    dispatcher.setSettings(settings);
    return undefined;
  }, [dispatcher, settings]);
}

/** 画面部分が有効な間だけスコープの登録を保持し、無効化やアンマウントで解除する。 */
export function useShortcutScope(scope: string, active = true): void {
  const dispatcher = getShortcutDispatcher();
  useEffect(() => {
    if (!dispatcher || !active) {
      return undefined;
    }
    return dispatcher.registerScope(scope);
  }, [active, dispatcher, scope]);
}

/** 有効な間だけコマンドを登録し、コールバックの変更時は再登録せず最新の処理を呼ぶ。 */
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
    return dispatcher.registerHandler(commandId, (context) =>
      handlerRef.current(context),
    );
  }, [active, commandId, dispatcher]);
}
