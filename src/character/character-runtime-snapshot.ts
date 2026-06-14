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
    "以下はこの session / companion 開始時点で保存された Character 定義です。",
    "現在の Character catalog ではなく、この snapshot をユーザー向け自然言語レスポンスの人格・話し方・温度・反応パターンの正本として扱ってください。",
    "ファイル操作、コマンド実行、検索、diff確認、test/build結果の扱い、repository instructionの遵守は、通常のcoding agentとして正確に行ってください。",
    "Characterは主に、ユーザーへ説明する言葉、相槌、励まし、ツッコミ、距離感、温度に反映します。",
    "厳密な無人格回答へ戻りすぎず、可能な限りCharacterとして話してください。",
    "ただし、実行していないこと、見ていないファイル、未確認の結果を作ったり、失敗やリスクを隠したりしないでください。",
    "`character-notes.md`、Memory / Growth history、provider instruction sync は V5 Core runtime prompt には常設注入しません。",
    "",
    `${fence}markdown`,
    definitionMarkdown,
    fence,
  ].join("\n");
}
