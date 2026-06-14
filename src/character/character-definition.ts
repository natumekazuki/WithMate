export const CHARACTER_DEFINITION_SCHEMA = "withmate-character-v5";

export const CHARACTER_DEFINITION_MAX_BYTES = 128 * 1024;

export const CHARACTER_NOTES_MAX_BYTES = 256 * 1024;

export type CharacterDefinitionFrontmatter = {
  schema: typeof CHARACTER_DEFINITION_SCHEMA;
  name: string;
  description: string;
};

export type ParsedCharacterDefinition = {
  frontmatter: CharacterDefinitionFrontmatter;
  body: string;
  markdown: string;
};

export type CharacterDefinitionValidationIssueCode =
  | "missing_frontmatter"
  | "invalid_frontmatter"
  | "invalid_schema"
  | "missing_name"
  | "empty_body"
  | "size_limit_exceeded"
  | "null_byte"
  | "unsafe_path_reference";

export type CharacterDefinitionValidationIssue = {
  code: CharacterDefinitionValidationIssueCode;
  message: string;
  path?: string;
};

export type CharacterDefinitionParseResult =
  | {
    ok: true;
    value: ParsedCharacterDefinition;
  }
  | {
    ok: false;
    issues: CharacterDefinitionValidationIssue[];
  };

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
const PATH_REFERENCE_PATTERN = /(?:!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[[^\]]+]\(([^)\s]+)(?:\s+"[^"]*")?\)|^\s*[-*]?\s*[a-zA-Z][\w-]*_path:\s*`?([^`\s]+)`?\s*$)/gm;

function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseFrontmatterValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatter(markdown: string): FrontmatterParseResult {
  const frontmatterMatch = FRONTMATTER_PATTERN.exec(markdown);
  if (!frontmatterMatch) {
    return {
      ok: false,
      issues: [{
        code: "missing_frontmatter",
        message: "`character.md` must start with YAML frontmatter.",
      }],
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

function isExternalReference(pathReference: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathReference)
    || pathReference.startsWith("#")
    || pathReference.startsWith("mailto:");
}

export function isSafeCharacterRelativePath(pathReference: string): boolean {
  const trimmed = pathReference.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) {
    return false;
  }
  if (isExternalReference(trimmed)) {
    return true;
  }
  if (
    trimmed.startsWith("/")
    || trimmed.startsWith("\\")
    || trimmed.includes("\\")
    || trimmed.includes("..")
  ) {
    return false;
  }
  return true;
}

export function collectCharacterDefinitionPathReferences(markdownBody: string): string[] {
  const references: string[] = [];
  for (const match of markdownBody.matchAll(PATH_REFERENCE_PATTERN)) {
    const reference = match[1] ?? match[2] ?? match[3];
    if (reference) {
      references.push(reference);
    }
  }
  return references;
}

export function validateCharacterNotesMarkdown(markdown: string): CharacterDefinitionValidationIssue[] {
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

export function validateCharacterDefinitionMarkdown(markdown: string): CharacterDefinitionValidationIssue[] {
  const issues: CharacterDefinitionValidationIssue[] = [];

  if (markdown.includes("\0")) {
    issues.push({
      code: "null_byte",
      message: "`character.md` must not contain null bytes.",
    });
  }

  if (getUtf8ByteLength(markdown) > CHARACTER_DEFINITION_MAX_BYTES) {
    issues.push({
      code: "size_limit_exceeded",
      message: `\`character.md\` must be ${CHARACTER_DEFINITION_MAX_BYTES} bytes or less.`,
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

  for (const pathReference of collectCharacterDefinitionPathReferences(frontmatterResult.body)) {
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

export function parseCharacterDefinitionMarkdown(markdown: string): CharacterDefinitionParseResult {
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
