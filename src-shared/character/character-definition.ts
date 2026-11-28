/** 実行用Character定義のfrontmatterで要求するスキーマ名。 */
export const CHARACTER_DEFINITION_SCHEMA = "withmate-character-v5";

/** 改行をLFに揃えた定義全体のコードポイント数の上限。 */
export const CHARACTER_DEFINITION_MAX_CHARACTERS = 8_000;

/** 実行用定義とは別に保存する補助メモのUTF-8バイト数の上限。 */
export const CHARACTER_NOTES_MAX_BYTES = 256 * 1024;

/** 読み取り済みのスキーマ名と公開情報。説明がなければ空文字列にする。 */
export type CharacterDefinitionFrontmatter = {
  schema: typeof CHARACTER_DEFINITION_SCHEMA;
  name: string;
  description: string;
};

/** 正規化した公開情報、前後の空白を除いた本文と保存時の原文。 */
export type ParsedCharacterDefinition = {
  frontmatter: CharacterDefinitionFrontmatter;
  body: string;
  markdown: string;
};

/** 定義・メモの形式、長さ、必須要素、参照先に関する診断の識別子。 */
export type CharacterDefinitionValidationIssueCode =
  | "missing_frontmatter"
  | "invalid_frontmatter"
  | "invalid_schema"
  | "missing_name"
  | "empty_body"
  | "size_limit_exceeded"
  | "null_byte"
  | "unsafe_path_reference";

/** 検証で見つかった理由と、参照先の指摘であれば該当するパス。 */
export type CharacterDefinitionValidationIssue = {
  code: CharacterDefinitionValidationIssueCode;
  message: string;
  path?: string;
};

/** 解析できた定義、または必要事項を満たさない場合の診断一覧。 */
export type CharacterDefinitionParseResult =
  | {
      ok: true;
      value: ParsedCharacterDefinition;
    }
  | {
      ok: false;
      issues: CharacterDefinitionValidationIssue[];
    };

/** 先頭のメタデータを行単位で読んだ結果。スキーマの適否は後の処理で調べる。 */
type FrontmatterParseResult =
  | {
      ok: true;
      values: Record<string, string>;
      body: string;
    }
  | {
      ok: false;
      issues: CharacterDefinitionValidationIssue[];
    };

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const PATH_REFERENCE_PATTERN =
  /(?:!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[[^\]]+]\(([^)\s]+)(?:\s+"[^"]*")?\)|^\s*[-*]?\s*[a-zA-Z][\w-]*_path:\s*`?([^`\s]+)`?\s*$)/gm;

/** 補助メモの保存サイズをUTF-8のバイト数で数える。 */
function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** 改行表現を統一し、サロゲートペアを二重計上せずに定義の文字数を数える。 */
export function countCharacterDefinitionCharacters(markdown: string): number {
  return Array.from(markdown.replace(/\r\n?|\n/g, "\n")).length;
}

/** 引用符とバックスラッシュの既知のエスケープだけを展開し、未知の並びを残す。 */
function unescapeDoubleQuotedFrontmatterValue(value: string): string {
  let result = "";

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index] ?? "";
    const next = value[index + 1];
    if (current === "\\" && (next === "\\" || next === '"')) {
      result += next;
      index += 1;
      continue;
    }
    result += current;
  }

  return result;
}

/** 単一行の値を読み、両端が揃った引用符を外して空白を整える。 */
function parseFrontmatterValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeDoubleQuotedFrontmatterValue(trimmed.slice(1, -1)).trim();
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** 先頭の囲みから単純なキーと値を読み、未対応の行があればまとめて診断する。 */
function parseFrontmatter(markdown: string): FrontmatterParseResult {
  const frontmatterMatch = FRONTMATTER_PATTERN.exec(markdown);
  if (!frontmatterMatch) {
    return {
      ok: false,
      issues: [
        {
          code: "missing_frontmatter",
          message: "`character.md` must start with YAML frontmatter.",
        },
      ],
    };
  }

  const frontmatter = frontmatterMatch[1] ?? "";
  const values: Record<string, string> = {};
  const issues: CharacterDefinitionValidationIssue[] = [];

  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const match = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line);
    if (!match) {
      issues.push({
        code: "invalid_frontmatter",
        message: `Unsupported frontmatter line: ${line}`,
      });
      continue;
    }

    const key = match[1] ?? "";
    const rawValue = match[2] ?? "";
    values[key] = parseFrontmatterValue(rawValue);
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    values,
    body: markdown.slice(frontmatterMatch[0].length),
  };
}

/** ローカルの相対ファイルとして解決しないWeb、ページ内、メール参照を識別する。 */
function isExternalReference(pathReference: string): boolean {
  return (
    /^https?:\/\//i.test(pathReference) ||
    pathReference.startsWith("#") ||
    pathReference.startsWith("mailto:")
  );
}

/** 許可済みの外部参照を先に除いた後、残ったスキーム付き参照を検出する。 */
function hasUnsupportedScheme(pathReference: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathReference);
}

/** 対応する外部参照を許し、ローカル参照は定義に添えられる相対形式に限る。 */
export function isSafeCharacterRelativePath(pathReference: string): boolean {
  const trimmed = pathReference.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) {
    return false;
  }
  if (isExternalReference(trimmed)) {
    return true;
  }
  if (hasUnsupportedScheme(trimmed)) {
    return false;
  }
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    trimmed.includes("\\") ||
    trimmed.includes("..")
  ) {
    return false;
  }
  return true;
}

/** 本文の画像・リンク・パス欄から、検証対象になる参照を出現順に抽出する。 */
export function collectCharacterDefinitionPathReferences(
  markdownBody: string,
): string[] {
  const references: string[] = [];
  for (const match of markdownBody.matchAll(PATH_REFERENCE_PATTERN)) {
    const reference = match[1] ?? match[2] ?? match[3];
    if (reference) {
      references.push(reference);
    }
  }
  return references;
}

/** 先頭にメタデータがあれば外し、本文の前後の空白を除く。 */
export function stripCharacterDefinitionFrontmatter(markdown: string): string {
  const frontmatterMatch = FRONTMATTER_PATTERN.exec(markdown);
  return (
    frontmatterMatch ? markdown.slice(frontmatterMatch[0].length) : markdown
  ).trim();
}

/** 補助メモには定義のスキーマを求めず、NULと保存サイズを検査する。 */
export function validateCharacterNotesMarkdown(
  markdown: string,
): CharacterDefinitionValidationIssue[] {
  const issues: CharacterDefinitionValidationIssue[] = [];
  if (markdown.includes("\0")) {
    issues.push({
      code: "null_byte",
      message: "`character-notes.md` must not contain null bytes.",
    });
  }
  if (getUtf8ByteLength(markdown) > CHARACTER_NOTES_MAX_BYTES) {
    issues.push({
      code: "size_limit_exceeded",
      message: `\`character-notes.md\` must be ${CHARACTER_NOTES_MAX_BYTES} bytes or less.`,
    });
  }
  return issues;
}

/** 容量・メタデータ・本文・ファイル参照を検査して、保存前に解消すべき理由を返す。 */
export function validateCharacterDefinitionMarkdown(
  markdown: string,
): CharacterDefinitionValidationIssue[] {
  const issues: CharacterDefinitionValidationIssue[] = [];

  if (markdown.includes("\0")) {
    issues.push({
      code: "null_byte",
      message: "`character.md` must not contain null bytes.",
    });
  }

  if (
    countCharacterDefinitionCharacters(markdown) >
    CHARACTER_DEFINITION_MAX_CHARACTERS
  ) {
    issues.push({
      code: "size_limit_exceeded",
      message: `\`character.md\` must be ${CHARACTER_DEFINITION_MAX_CHARACTERS.toLocaleString("en-US")} characters or less after LF line-ending normalization.`,
    });
  }

  const frontmatterResult = parseFrontmatter(markdown);
  if (!frontmatterResult.ok) {
    return [...issues, ...frontmatterResult.issues];
  }

  const schema = frontmatterResult.values.schema ?? "";
  if (schema !== CHARACTER_DEFINITION_SCHEMA) {
    issues.push({
      code: "invalid_schema",
      message: `Frontmatter schema must be ${CHARACTER_DEFINITION_SCHEMA}.`,
    });
  }

  const name = frontmatterResult.values.name?.trim() ?? "";
  if (name.length === 0) {
    issues.push({
      code: "missing_name",
      message: "Frontmatter name is required.",
    });
  }

  if (frontmatterResult.body.trim().length === 0) {
    issues.push({
      code: "empty_body",
      message: "`character.md` body is required.",
    });
  }

  for (const pathReference of collectCharacterDefinitionPathReferences(
    frontmatterResult.body,
  )) {
    if (!isSafeCharacterRelativePath(pathReference)) {
      issues.push({
        code: "unsafe_path_reference",
        message: `Unsafe character definition path reference: ${pathReference}`,
        path: pathReference,
      });
    }
  }

  return issues;
}

/** 検証に通った定義から公開情報と本文を分離し、元のMarkdownも保持する。 */
export function parseCharacterDefinitionMarkdown(
  markdown: string,
): CharacterDefinitionParseResult {
  const issues = validateCharacterDefinitionMarkdown(markdown);
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const frontmatterResult = parseFrontmatter(markdown);
  if (!frontmatterResult.ok) {
    return { ok: false, issues: frontmatterResult.issues };
  }

  return {
    ok: true,
    value: {
      frontmatter: {
        schema: CHARACTER_DEFINITION_SCHEMA,
        name: frontmatterResult.values.name?.trim() ?? "",
        description: frontmatterResult.values.description?.trim() ?? "",
      },
      body: frontmatterResult.body.trim(),
      markdown,
    },
  };
}
