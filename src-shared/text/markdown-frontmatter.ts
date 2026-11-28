import { isMap, isScalar, parseDocument } from "yaml";

/** frontmatterの表に並べる、表示用に文字列化したキーと値。 */
export type MarkdownFrontmatterTableRow = {
  key: string;
  value: string;
};

/** 単純なマッピングを表で出すか、表にできない内容を区切り付きの原文で出すかの結果。 */
export type MarkdownFrontmatterDisplay =
  | {
      kind: "table";
      rows: MarkdownFrontmatterTableRow[];
    }
  | {
      kind: "source";
      source: string;
    };

/** 改行をLFに統一し、frontmatterの前後にYAML区切りを戻して返す。 */
export function formatMarkdownFrontmatterSource(value: string): string {
  const normalizedValue = value.replace(/\r\n?/g, "\n");
  return normalizedValue ? `---\n${normalizedValue}\n---` : "---\n---";
}

/** 一行のYAMLスカラーを表示文字列へ変換する。非スカラーや複数行文字列はnullにする。 */
function scalarText(node: unknown): string | null {
  if (!isScalar(node)) {
    return null;
  }

  if (typeof node.value === "string" && /\r|\n/.test(node.value)) {
    return null;
  }

  if (node.value === null && node.source === "") {
    return "";
  }

  return node.toString();
}

/** すべての項目を一行のキー・値として扱える場合だけ表にし、それ以外は原文に戻す。 */
export function resolveMarkdownFrontmatterDisplay(
  value: string,
): MarkdownFrontmatterDisplay {
  const source = formatMarkdownFrontmatterSource(value);

  try {
    const document = parseDocument(value.replace(/\r\n?/g, "\n"));
    if (
      document.errors.length > 0 ||
      document.warnings.length > 0 ||
      !isMap(document.contents) ||
      document.contents.items.length === 0
    ) {
      return { kind: "source", source };
    }

    const rows: MarkdownFrontmatterTableRow[] = [];
    for (const pair of document.contents.items) {
      const key = scalarText(pair.key);
      const rowValue = scalarText(pair.value);
      if (key === null || key.length === 0 || rowValue === null) {
        return { kind: "source", source };
      }
      rows.push({ key, value: rowValue });
    }

    return rows.length > 0
      ? { kind: "table", rows }
      : { kind: "source", source };
  } catch {
    return { kind: "source", source };
  }
}

/** 表示と同じ判定で文字列化し、表ならキーと値を表示順につないで返す。 */
export function projectMarkdownFrontmatterText(value: string): string {
  const display = resolveMarkdownFrontmatterDisplay(value);
  return display.kind === "table"
    ? display.rows.map((row) => `${row.key}${row.value}`).join("")
    : display.source;
}
