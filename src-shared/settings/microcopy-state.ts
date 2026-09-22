export const MICROCOPY_SLOTS = [
  "chat.pending.response_waiting",
  "dock.status.approval",
  "dock.status.working",
  "dock.status.responding",
  "dock.status.preparing",
  "retry.interrupted.title",
  "retry.failed.title",
  "retry.canceled.title",
  "composer.error.path_not_found",
  "empty.latest_command.waiting",
  "empty.latest_command",
  "empty.changed_files",
  "empty.context",
] as const;

export type MicrocopySlot = typeof MICROCOPY_SLOTS[number];

export type MicrocopyCatalog = Partial<Record<MicrocopySlot, string[] | string>>;

export type MicrocopyResolveInput = {
  slot: MicrocopySlot;
  userCatalog?: MicrocopyCatalog | null;
  seedParts?: Array<string | number | null | undefined>;
  replacements?: Record<string, string | null | undefined>;
};

export const BUILT_IN_MICROCOPY_CATALOG: Record<MicrocopySlot, string[]> = {
  "chat.pending.response_waiting": [
    "Preparing a response",
    "Waiting for output",
  ],
  "dock.status.approval": ["Waiting for approval"],
  "dock.status.working": ["Working"],
  "dock.status.responding": ["Generating a response"],
  "dock.status.preparing": ["Preparing a response"],
  "retry.interrupted.title": ["The previous request was interrupted"],
  "retry.failed.title": ["The previous request could not be completed"],
  "retry.canceled.title": ["This request was stopped"],
  "composer.error.path_not_found": ["Path not found: {path}"],
  "empty.latest_command.waiting": ["Waiting for the first command"],
  "empty.latest_command": ["No recent command recorded"],
  "empty.changed_files": ["No file changes"],
  "empty.context": ["No context usage yet"],
};

const MICROCOPY_SLOT_SET = new Set<string>(MICROCOPY_SLOTS);
const LEGACY_PATH_NOT_FOUND_DEFAULT = ["指定したパスが見つかりません: {path}"];
const LEGACY_BUILT_IN_MICROCOPY_CATALOG: Partial<Record<MicrocopySlot, readonly string[]>> = {
  "chat.pending.response_waiting": [
    "応答を準備しています",
    "出力を待機しています",
  ],
  "dock.status.approval": ["承認を待機中"],
  "dock.status.working": ["処理を実行中"],
  "dock.status.responding": ["応答を生成中"],
  "dock.status.preparing": ["応答を準備中"],
  "retry.interrupted.title": ["前回の依頼は中断されたままです"],
  "retry.failed.title": ["前回の依頼は完了できませんでした"],
  "retry.canceled.title": ["この依頼は途中で停止しました"],
  "composer.error.path_not_found": LEGACY_PATH_NOT_FOUND_DEFAULT,
  "empty.latest_command.waiting": ["最初の command を待機中"],
  "empty.latest_command": ["直近 run の command 記録はありません"],
  "empty.changed_files": ["ファイル変更はありません"],
  "empty.context": ["context usage はまだありません"],
};

function isExactVariantList(value: string[], expected: readonly string[]): boolean {
  return value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}

function cloneCatalog(catalog: Record<MicrocopySlot, string[]>): Record<MicrocopySlot, string[]> {
  return Object.fromEntries(
    MICROCOPY_SLOTS.map((slot) => [slot, [...catalog[slot]]]),
  ) as Record<MicrocopySlot, string[]>;
}

export function createDefaultUserMicrocopyCatalog(): Record<MicrocopySlot, string[]> {
  return cloneCatalog(BUILT_IN_MICROCOPY_CATALOG);
}

export function migratePersistedUserMicrocopyCatalog(value: unknown): {
  value: unknown;
  changed: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value, changed: false };
  }

  const migrated = { ...(value as Record<string, unknown>) };
  let changed = false;
  for (const slot of MICROCOPY_SLOTS) {
    const legacyVariants = LEGACY_BUILT_IN_MICROCOPY_CATALOG[slot];
    const persistedVariants = migrated[slot];
    if (
      !legacyVariants
      || !Array.isArray(persistedVariants)
      || !persistedVariants.every((entry): entry is string => typeof entry === "string")
      || !isExactVariantList(persistedVariants, legacyVariants)
    ) {
      continue;
    }

    migrated[slot] = [...BUILT_IN_MICROCOPY_CATALOG[slot]];
    changed = true;
  }

  return { value: migrated, changed };
}

function normalizeMicrocopyVariants(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const normalized = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return normalized.length > 0 ? normalized : [...fallback];
  }

  if (typeof value === "string") {
    const normalized = value
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return normalized.length > 0 ? normalized : [...fallback];
  }

  return [...fallback];
}

export function normalizeUserMicrocopyCatalog(value: unknown): Record<MicrocopySlot, string[]> {
  const normalized = createDefaultUserMicrocopyCatalog();
  if (!value || typeof value !== "object") {
    return normalized;
  }

  for (const [slot, variants] of Object.entries(value as Record<string, unknown>)) {
    if (!MICROCOPY_SLOT_SET.has(slot)) {
      continue;
    }

    const typedSlot = slot as MicrocopySlot;
    const normalizedVariants = normalizeMicrocopyVariants(
      variants,
      BUILT_IN_MICROCOPY_CATALOG[typedSlot],
    );
    normalized[typedSlot] = normalizedVariants;
  }

  return normalized;
}

export function hasCustomMicrocopyVariants(
  userCatalog: MicrocopyCatalog | null | undefined,
  slot: MicrocopySlot,
): boolean {
  const variants = normalizeUserMicrocopyCatalog(userCatalog)[slot];
  const builtInVariants = BUILT_IN_MICROCOPY_CATALOG[slot];
  return variants.length !== builtInVariants.length
    || variants.some((variant, index) => variant !== builtInVariants[index]);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function resolveMicrocopy({
  slot,
  userCatalog,
  seedParts = [],
  replacements = {},
}: MicrocopyResolveInput): string {
  const normalizedUserCatalog = normalizeUserMicrocopyCatalog(userCatalog);
  const variants = normalizedUserCatalog[slot] ?? BUILT_IN_MICROCOPY_CATALOG[slot];
  const seed = [slot, ...seedParts.map((part) => part ?? "")].join("\u001f");
  const selected = variants[stableHash(seed) % variants.length] ?? BUILT_IN_MICROCOPY_CATALOG[slot][0];

  return Object.entries(replacements).reduce((current, [key, value]) => {
    return current.replaceAll(`{${key}}`, value?.trim() ?? "");
  }, selected);
}
