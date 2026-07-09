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
  "composer.error.path_not_found": ["指定したパスが見つかりません: {path}"],
  "empty.latest_command.waiting": ["最初の command を待機中"],
  "empty.latest_command": ["直近 run の command 記録はありません"],
  "empty.changed_files": ["ファイル変更はありません"],
  "empty.context": ["context usage はまだありません"],
};

const MICROCOPY_SLOT_SET = new Set<string>(MICROCOPY_SLOTS);

function cloneCatalog(catalog: Record<MicrocopySlot, string[]>): Record<MicrocopySlot, string[]> {
  return Object.fromEntries(
    MICROCOPY_SLOTS.map((slot) => [slot, [...catalog[slot]]]),
  ) as Record<MicrocopySlot, string[]>;
}

export function createDefaultUserMicrocopyCatalog(): Record<MicrocopySlot, string[]> {
  return cloneCatalog(BUILT_IN_MICROCOPY_CATALOG);
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

    normalized[slot as MicrocopySlot] = normalizeMicrocopyVariants(
      variants,
      BUILT_IN_MICROCOPY_CATALOG[slot as MicrocopySlot],
    );
  }

  return normalized;
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
