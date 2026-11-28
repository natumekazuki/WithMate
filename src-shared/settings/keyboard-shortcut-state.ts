/** 同じ操作に OS ごとのキー割り当てを保持するためのプラットフォーム ID。 */
export type ShortcutPlatform = "windows" | "linux" | "macos";

/** キー名と、同時に押す修飾キーの指定。省略された修飾キーは押さない。 */
export type ShortcutAccelerator = Readonly<{
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}>;

/** カスタマイズ可能なキーを英字または Enter に制限する分類。 */
export type ShortcutBindingKind = "letter" | "enter";

/** 操作ごとの既定キー、動作範囲と排他グループ、および変更可否を定める。 */
export type KeyboardShortcutPolicyEntry = Readonly<{
  id: string;
  scope: string;
  exclusiveScopeGroup?: string;
  accelerators: Readonly<Record<ShortcutPlatform, ShortcutAccelerator | null>>;
  customizable: boolean;
  bindingKind?: ShortcutBindingKind;
}>;

/** 一つの操作について、既定から変更した OS の割り当てだけを保持する。 */
export type KeyboardShortcutOverride = Readonly<
  Partial<Record<ShortcutPlatform, ShortcutAccelerator>>
>;

/** 操作 ID ごとのカスタム割り当てを保存する設定。既定キー自体は含まない。 */
export type KeyboardShortcutSettings = Readonly<{
  overrides: Readonly<Record<string, KeyboardShortcutOverride>>;
}>;

/** すべての操作で既定の割り当てに従う、上書きのない設定。 */
export const DEFAULT_KEYBOARD_SHORTCUT_SETTINGS: KeyboardShortcutSettings = {
  overrides: {},
};

/** 比較に使うキー名へ揃え、すべての修飾キーの状態を真偽値で明示した割り当て。 */
export type NormalizedShortcutAccelerator = Readonly<{
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}>;

/** 設定用のキー入力を受理した場合の候補、または候補にできない理由。 */
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

/** 入力の判定に必要なキー名・修飾キー・入力状態を、DOM の型に依存せず受け取る。 */
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

const SHORTCUT_PLATFORMS: readonly ShortcutPlatform[] = [
  "windows",
  "linux",
  "macos",
];

/** 共通の操作 ID に、既定キー、動作範囲、カスタマイズ可能な組み合わせを対応付ける。 */
export const DEFAULT_KEYBOARD_SHORTCUT_POLICY_ENTRIES: readonly KeyboardShortcutPolicyEntry[] =
  [
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
      id: "session.message.toggle-view-mode",
      scope: "message-list",
      exclusiveScopeGroup: "session-content",
      accelerators: {
        windows: { key: "k", ctrlKey: true, shiftKey: true },
        linux: { key: "k", ctrlKey: true, shiftKey: true },
        macos: { key: "k", metaKey: true, shiftKey: true },
      },
      customizable: true,
      bindingKind: "letter",
    },
    {
      id: "session.conversation.toggle-target",
      scope: "session",
      accelerators: {
        windows: { key: "j", ctrlKey: true, shiftKey: true },
        linux: { key: "j", ctrlKey: true, shiftKey: true },
        macos: { key: "j", metaKey: true, shiftKey: true },
      },
      customizable: true,
      bindingKind: "letter",
    },
    {
      id: "session.main.scroll-to-bottom",
      scope: "session",
      accelerators: {
        windows: null,
        linux: null,
        macos: null,
      },
      customizable: true,
      bindingKind: "letter",
    },
    {
      id: "session.auxiliary.scroll-to-bottom",
      scope: "session",
      accelerators: {
        windows: null,
        linux: null,
        macos: null,
      },
      customizable: true,
      bindingKind: "letter",
    },
    {
      id: "session.action-dock.toggle-mode",
      scope: "session",
      accelerators: {
        windows: { key: "t", ctrlKey: true, shiftKey: true },
        linux: { key: "t", ctrlKey: true, shiftKey: true },
        macos: { key: "t", metaKey: true, shiftKey: true },
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
    {
      id: "session.composer.send-input",
      scope: "composer",
      accelerators: {
        windows: { key: "Enter", ctrlKey: true, shiftKey: true },
        linux: { key: "Enter", ctrlKey: true, shiftKey: true },
        macos: { key: "Enter", metaKey: true, shiftKey: true },
      },
      customizable: true,
      bindingKind: "enter",
    },
  ];

const MODIFIER_ONLY_KEYS = new Set(
  [
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
  ].map((key) => key.toLocaleLowerCase("en-US")),
);

/** 保存データがない場合に使う、上書きのない読み取り専用の設定を返す。 */
export function createDefaultKeyboardShortcutSettings(): KeyboardShortcutSettings {
  return DEFAULT_KEYBOARD_SHORTCUT_SETTINGS;
}

/** スペースキーを空白除去から除外し、旧キー名を標準表記に置き換え、一文字のキーを小文字に揃える。 */
export function normalizeShortcutKey(key: string): string {
  const rawKey = key === " " ? key : key.trim();
  const aliases: Record<string, string> = {
    Esc: "Escape",
    Spacebar: " ",
  };
  const normalized = aliases[rawKey] ?? rawKey;
  return normalized.length === 1
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

/** キー名を統一し、明示的に true でない修飾キーを false に揃える。 */
export function normalizeShortcutAccelerator(
  accelerator: ShortcutAccelerator,
): NormalizedShortcutAccelerator {
  return {
    key: normalizeShortcutKey(accelerator.key),
    ctrlKey: accelerator.ctrlKey === true,
    metaKey: accelerator.metaKey === true,
    shiftKey: accelerator.shiftKey === true,
    altKey: accelerator.altKey === true,
  };
}

/** キー名や省略された修飾キーの表記差を吸収して、割り当ての衝突判定に使う識別子を作る。 */
export function shortcutAcceleratorSignature(
  accelerator: ShortcutAccelerator,
): string {
  const normalized = normalizeShortcutAccelerator(accelerator);
  return [
    normalized.key,
    normalized.ctrlKey,
    normalized.metaKey,
    normalized.shiftKey,
    normalized.altKey,
  ].join("/");
}

/** カスタマイズの候補が、英字または Enter に対する OS ごとの修飾キー制約を満たすか判定する。 */
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
        (normalized.metaKey &&
          normalized.shiftKey &&
          !normalized.ctrlKey &&
          !normalized.altKey) ||
        (normalized.metaKey &&
          normalized.altKey &&
          !normalized.ctrlKey &&
          !normalized.shiftKey)
      );
    }

    return (
      (normalized.ctrlKey &&
        normalized.shiftKey &&
        !normalized.metaKey &&
        !normalized.altKey) ||
      (normalized.altKey &&
        normalized.shiftKey &&
        !normalized.ctrlKey &&
        !normalized.metaKey)
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

/** 設定オブジェクトを読む前に null、配列、非オブジェクトを除外する。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 保存値では AltGraph と区別できない Ctrl と Alt の同時指定を検出する。 */
function isAltGraphAccelerator(accelerator: ShortcutAccelerator): boolean {
  return accelerator.ctrlKey === true && accelerator.altKey === true;
}

/** 修飾キーやロックキーだけの入力を、大文字小文字を区別せず検出する。 */
function isModifierOnlyKey(key: string): boolean {
  return MODIFIER_ONLY_KEYS.has(key.toLocaleLowerCase("en-US"));
}

/** 保存された候補の形を検証し、OS と分類が指定されていればカスタマイズ規則にも照合する。 */
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
  if (
    platform &&
    bindingKind &&
    !isAllowedShortcutAccelerator(accelerator, platform, bindingKind)
  ) {
    return null;
  }
  return accelerator;
}

/** 正規化時に既定との衝突を解消するか指定する。false でも値の妥当性は検証する。 */
export type ShortcutNormalizationOptions = Readonly<{
  removeCollisions?: boolean;
}>;

/** 異なる動作範囲が同じ排他グループに属する場合だけ、同時に有効にならないと判定する。 */
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

/** 指定した OS の上書きを作業用の設定から除き、最後の割り当てなら操作 ID も消す。 */
function removeShortcutOverride(
  overrides: Record<
    string,
    Partial<Record<ShortcutPlatform, ShortcutAccelerator>>
  >,
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

/** 同時に有効な割り当てが OS ごとに重複した場合、上書きだけを外し、既定値に戻った後の衝突も再確認する。 */
function removeShortcutOverrideCollisions(
  settings: KeyboardShortcutSettings,
  policyEntries: readonly KeyboardShortcutPolicyEntry[],
): KeyboardShortcutSettings {
  const overrides: Record<
    string,
    Partial<Record<ShortcutPlatform, ShortcutAccelerator>>
  > = Object.fromEntries(
    Object.entries(settings.overrides).map(([commandId, commandOverrides]) => [
      commandId,
      { ...commandOverrides },
    ]),
  );

  for (const platform of SHORTCUT_PLATFORMS) {
    let changed = true;
    while (changed) {
      changed = false;
      for (
        let leftIndex = 0;
        leftIndex < policyEntries.length;
        leftIndex += 1
      ) {
        const left = policyEntries[leftIndex];
        const leftAccelerator =
          overrides[left.id]?.[platform] ?? left.accelerators[platform];
        if (!leftAccelerator) {
          continue;
        }
        for (
          let rightIndex = leftIndex + 1;
          rightIndex < policyEntries.length;
          rightIndex += 1
        ) {
          const right = policyEntries[rightIndex];
          if (!canShortcutScopesBeActiveTogether(left, right)) {
            continue;
          }

          const rightAccelerator =
            overrides[right.id]?.[platform] ?? right.accelerators[platform];
          if (
            !rightAccelerator ||
            shortcutAcceleratorSignature(leftAccelerator) !==
              shortcutAcceleratorSignature(rightAccelerator)
          ) {
            continue;
          }

          const removableIds = [left, right]
            .filter(
              (entry) => entry.customizable && overrides[entry.id]?.[platform],
            )
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

/** 既知かつ変更可能な操作の有効な上書きだけを復元し、既定で同時に有効な割り当ての衝突を解消する。 */
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
  for (const [commandId, rawCommandOverrides] of Object.entries(
    value.overrides,
  )) {
    const policyEntry = policyById.get(commandId);
    if (
      !commandId.trim() ||
      !policyEntry?.customizable ||
      !policyEntry.bindingKind ||
      !isRecord(rawCommandOverrides)
    ) {
      continue;
    }

    const commandOverrides: Partial<
      Record<ShortcutPlatform, ShortcutAccelerator>
    > = {};
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

/** 対象の操作と OS の新しい割り当てを検証して反映し、null なら既定に戻す。新しい割り当てとの衝突はここでは解消しない。 */
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

  const normalizedSettings = normalizeKeyboardShortcutSettings(
    settings,
    policyEntries,
  );
  const overrides: Record<string, KeyboardShortcutOverride> =
    Object.fromEntries(
      Object.entries(normalizedSettings.overrides).map(
        ([id, commandOverrides]) => [id, { ...commandOverrides }],
      ),
    );
  const commandOverrides = { ...(overrides[commandId] ?? {}) };

  if (accelerator === null) {
    delete commandOverrides[platform];
  } else {
    const normalizedAccelerator = parseShortcutAccelerator(
      accelerator,
      platform,
      policyEntry.bindingKind,
    );
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

/** IME の変換中やリピート、AltGraph などを理由付きで除外し、OS 別制約の検証前のキー候補を返す。 */
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
  if (
    event.getModifierState?.("AltGraph") === true ||
    (event.ctrlKey && event.altKey)
  ) {
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
