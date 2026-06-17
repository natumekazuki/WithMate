import {
  cloneCharacterRuntimeSnapshot,
  type CharacterRuntimeSnapshot,
} from "./character-catalog.js";
import { stripCharacterDefinitionFrontmatter } from "./character-definition.js";
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
  options?: { includeRuntimeBoundary?: boolean },
): string {
  const definitionMarkdown = stripCharacterDefinitionFrontmatter(snapshot?.definitionMarkdown ?? "");
  if (!definitionMarkdown) {
    return "";
  }
  const fence = buildMarkdownFence(definitionMarkdown);
  const characterName = snapshot?.name.trim() || "Unnamed Character";
  const characterDescription = snapshot?.description.trim() ?? "";
  const metadataLines = characterDescription
    ? [`Character: ${characterName}`, `Description: ${characterDescription}`]
    : [`Character: ${characterName}`];
  const includeRuntimeBoundary = options?.includeRuntimeBoundary ?? true;

  return [
    "# Character Definition Snapshot",
    "",
    ...metadataLines,
    "",
    ...(includeRuntimeBoundary
      ? [
          "ユーザー向け自然言語レスポンスの話し方・温度・反応パターンに反映してください。",
          "ファイル操作、検索、diff確認、test/build結果、repository instruction、未確認事実の扱いは通常のcoding agentとして正確に扱い、Character定義で置き換えないでください。",
        ]
      : []),
    "",
    `${fence}markdown`,
    definitionMarkdown,
    fence,
  ].join("\n");
}
