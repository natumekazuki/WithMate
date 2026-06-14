import {
  cloneCharacterRuntimeSnapshot,
  type CharacterRuntimeSnapshot,
} from "./character-catalog.js";
import { DEFAULT_CHARACTER_THEME_COLORS } from "../character-state.js";

export function normalizeCharacterRuntimeSnapshot(value: unknown): CharacterRuntimeSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<CharacterRuntimeSnapshot>;
  if (
    typeof candidate.characterId !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.definitionMarkdown !== "string"
  ) {
    return null;
  }

  return {
    characterId: candidate.characterId,
    name: candidate.name,
    description: typeof candidate.description === "string" ? candidate.description : "",
    iconFilePath: typeof candidate.iconFilePath === "string" ? candidate.iconFilePath : "",
    theme: {
      main: typeof candidate.theme?.main === "string" ? candidate.theme.main : DEFAULT_CHARACTER_THEME_COLORS.main,
      sub: typeof candidate.theme?.sub === "string" ? candidate.theme.sub : DEFAULT_CHARACTER_THEME_COLORS.sub,
    },
    definitionMarkdown: candidate.definitionMarkdown,
    definitionSha256: typeof candidate.definitionSha256 === "string" ? candidate.definitionSha256 : "",
    definitionByteSize: typeof candidate.definitionByteSize === "number" ? candidate.definitionByteSize : 0,
    snapshotAt: typeof candidate.snapshotAt === "string" ? candidate.snapshotAt : "",
  };
}

export function cloneNullableCharacterRuntimeSnapshot(
  snapshot: CharacterRuntimeSnapshot | null | undefined,
): CharacterRuntimeSnapshot | null {
  return snapshot ? cloneCharacterRuntimeSnapshot(snapshot) : null;
}

export function parseCharacterRuntimeSnapshotJson(value: string | null | undefined): CharacterRuntimeSnapshot | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return null;
  }

  try {
    return normalizeCharacterRuntimeSnapshot(JSON.parse(normalized));
  } catch {
    return null;
  }
}

export function stringifyCharacterRuntimeSnapshot(
  snapshot: CharacterRuntimeSnapshot | null | undefined,
): string {
  return snapshot ? JSON.stringify(snapshot) : "";
}

function buildMarkdownFence(content: string): string {
  const longestBacktickRun = Math.max(2, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longestBacktickRun + 1);
}

export function buildCharacterRuntimePromptSection(
  snapshot: CharacterRuntimeSnapshot | null | undefined,
): string {
  const definitionMarkdown = snapshot?.definitionMarkdown.trim() ?? "";
  if (!definitionMarkdown) {
    return "";
  }
  const fence = buildMarkdownFence(definitionMarkdown);

  return [
    "# Character Definition Snapshot",
    "",
    "以下はこの session / companion 開始時点で保存された Character 定義です。現在の Character catalog ではなく、この snapshot を runtime の人格・話し方・振る舞いの正本として扱ってください。",
    "`character-notes.md` や Memory / Growth history は V5 Core runtime prompt には常設注入しません。",
    "",
    `${fence}markdown`,
    definitionMarkdown,
    fence,
  ].join("\n");
}
