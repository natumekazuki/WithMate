export type CharacterVisual = {
  name: string;
  iconPath: string;
};

export type CharacterThemeColors = {
  main: string;
  sub: string;
};

export type CharacterSessionCopy = {
  pendingApproval: string[];
  pendingWorking: string[];
  pendingResponding: string[];
  pendingPreparing: string[];
  retryInterruptedTitle: string[];
  retryFailedTitle: string[];
  retryCanceledTitle: string[];
  latestCommandWaiting: string[];
  latestCommandEmpty: string[];
  changedFilesEmpty: string[];
  contextEmpty: string[];
};

export type CharacterCatalogItem = CharacterVisual & {
  id: string;
};

export type CharacterProfile = CharacterCatalogItem & {
  description: string;
  roleMarkdown: string;
  updatedAt: string;
  themeColors: CharacterThemeColors;
  sessionCopy: CharacterSessionCopy;
};

export type CreateCharacterInput = {
  name: string;
  iconPath: string;
  description: string;
  roleMarkdown: string;
  themeColors: CharacterThemeColors;
  sessionCopy: CharacterSessionCopy;
};

export const DEFAULT_CHARACTER_THEME_COLORS: CharacterThemeColors = {
  main: "#6f8cff",
  sub: "#6fb8c7",
};

export const DEFAULT_CHARACTER_SESSION_COPY: CharacterSessionCopy = {
  pendingApproval: ["承認を待機中"],
  pendingWorking: ["処理を実行中"],
  pendingResponding: ["応答を生成中"],
  pendingPreparing: ["応答を準備中"],
  retryInterruptedTitle: ["前回の依頼は中断されたままです"],
  retryFailedTitle: ["前回の依頼は完了できませんでした"],
  retryCanceledTitle: ["この依頼は途中で停止しました"],
  latestCommandWaiting: ["最初の command を待機中"],
  latestCommandEmpty: ["直近 run の command 記録はありません"],
  changedFilesEmpty: ["ファイル変更はありません"],
  contextEmpty: ["context usage はまだありません"],
};

export function cloneCharacterSessionCopy(copy: CharacterSessionCopy): CharacterSessionCopy {
  return {
    pendingApproval: [...copy.pendingApproval],
    pendingWorking: [...copy.pendingWorking],
    pendingResponding: [...copy.pendingResponding],
    pendingPreparing: [...copy.pendingPreparing],
    retryInterruptedTitle: [...copy.retryInterruptedTitle],
    retryFailedTitle: [...copy.retryFailedTitle],
    retryCanceledTitle: [...copy.retryCanceledTitle],
    latestCommandWaiting: [...copy.latestCommandWaiting],
    latestCommandEmpty: [...copy.latestCommandEmpty],
    changedFilesEmpty: [...copy.changedFilesEmpty],
    contextEmpty: [...copy.contextEmpty],
  };
}

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return fallback;
  }

  return normalized.toLowerCase();
}

export function normalizeCharacterThemeColors(value: unknown): CharacterThemeColors {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_CHARACTER_THEME_COLORS };
  }

  const candidate = value as Partial<CharacterThemeColors>;
  return {
    main: normalizeHexColor(candidate.main, DEFAULT_CHARACTER_THEME_COLORS.main),
    sub: normalizeHexColor(candidate.sub, DEFAULT_CHARACTER_THEME_COLORS.sub),
  };
}

function normalizeCharacterSessionCopyValue(value: unknown, fallback: string[]): string[] {
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

export function normalizeCharacterSessionCopy(value: unknown): CharacterSessionCopy {
  if (!value || typeof value !== "object") {
    return cloneCharacterSessionCopy(DEFAULT_CHARACTER_SESSION_COPY);
  }

  const candidate = value as Partial<CharacterSessionCopy>;
  return {
    pendingApproval: normalizeCharacterSessionCopyValue(candidate.pendingApproval, DEFAULT_CHARACTER_SESSION_COPY.pendingApproval),
    pendingWorking: normalizeCharacterSessionCopyValue(candidate.pendingWorking, DEFAULT_CHARACTER_SESSION_COPY.pendingWorking),
    pendingResponding: normalizeCharacterSessionCopyValue(candidate.pendingResponding, DEFAULT_CHARACTER_SESSION_COPY.pendingResponding),
    pendingPreparing: normalizeCharacterSessionCopyValue(candidate.pendingPreparing, DEFAULT_CHARACTER_SESSION_COPY.pendingPreparing),
    retryInterruptedTitle: normalizeCharacterSessionCopyValue(candidate.retryInterruptedTitle, DEFAULT_CHARACTER_SESSION_COPY.retryInterruptedTitle),
    retryFailedTitle: normalizeCharacterSessionCopyValue(candidate.retryFailedTitle, DEFAULT_CHARACTER_SESSION_COPY.retryFailedTitle),
    retryCanceledTitle: normalizeCharacterSessionCopyValue(candidate.retryCanceledTitle, DEFAULT_CHARACTER_SESSION_COPY.retryCanceledTitle),
    latestCommandWaiting: normalizeCharacterSessionCopyValue(candidate.latestCommandWaiting, DEFAULT_CHARACTER_SESSION_COPY.latestCommandWaiting),
    latestCommandEmpty: normalizeCharacterSessionCopyValue(candidate.latestCommandEmpty, DEFAULT_CHARACTER_SESSION_COPY.latestCommandEmpty),
    changedFilesEmpty: normalizeCharacterSessionCopyValue(candidate.changedFilesEmpty, DEFAULT_CHARACTER_SESSION_COPY.changedFilesEmpty),
    contextEmpty: normalizeCharacterSessionCopyValue(candidate.contextEmpty, DEFAULT_CHARACTER_SESSION_COPY.contextEmpty),
  };
}

export function cloneCharacterProfiles(characters: CharacterProfile[]): CharacterProfile[] {
  return characters.map((character) => ({ ...character, themeColors: { ...character.themeColors } }));
}

export function getCharacterById(characters: CharacterProfile[], characterId: string): CharacterProfile | null {
  return cloneCharacterProfiles(characters).find((character) => character.id === characterId) ?? null;
}

function getLocationSearch(): string {
  const browserWindow = (globalThis as typeof globalThis & { window?: { location?: { search?: string } } }).window;
  if (!browserWindow?.location?.search) {
    return "";
  }

  return browserWindow.location.search;
}

export function buildCharacterEditorUrl(characterId: string): string {
  return `?characterId=${encodeURIComponent(characterId)}`;
}

export function getCharacterIdFromLocation(): string | null {
  return new URLSearchParams(getLocationSearch()).get("characterId");
}

export function isCharacterCreateMode(): boolean {
  return new URLSearchParams(getLocationSearch()).get("mode") === "create";
}
