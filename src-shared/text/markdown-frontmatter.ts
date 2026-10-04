import { isMap, isScalar, parseDocument } from "yaml";

export type MarkdownFrontmatterTableRow = {
  key: string;
  value: string;
};

export type MarkdownFrontmatterDisplay =
  | {
    kind: "table";
    rows: MarkdownFrontmatterTableRow[];
  }
  | {
    kind: "source";
    source: string;
  };

export function formatMarkdownFrontmatterSource(value: string): string {
  const normalizedValue = value.replace(/\r\n?/g, "\n");
  return normalizedValue ? `---\n${normalizedValue}\n---` : "---\n---";
}

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

export function resolveMarkdownFrontmatterDisplay(value: string): MarkdownFrontmatterDisplay {
  const source = formatMarkdownFrontmatterSource(value);

  try {
    const document = parseDocument(value.replace(/\r\n?/g, "\n"));
    if (
      document.errors.length > 0
      || document.warnings.length > 0
      || !isMap(document.contents)
      || document.contents.items.length === 0
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

    return rows.length > 0 ? { kind: "table", rows } : { kind: "source", source };
  } catch {
    return { kind: "source", source };
  }
}

export function projectMarkdownFrontmatterText(value: string): string {
  const display = resolveMarkdownFrontmatterDisplay(value);
  return display.kind === "table"
    ? display.rows.map((row) => `${row.key}${row.value}`).join("")
    : display.source;
}
