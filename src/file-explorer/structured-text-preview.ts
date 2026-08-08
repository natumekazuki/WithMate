import { createHighlighterCore, type ThemedToken } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";

export const STRUCTURED_TEXT_PREVIEW_MAX_BYTES = 256 * 1024;

export type StructuredTextFormat = "json" | "jsonc" | "yaml";

export type PreviewSyntaxToken = {
  content: string;
  color?: string;
  fontStyle?: number;
};

export type StructuredTextProjection = {
  formattedText: string;
  formattedTokens: PreviewSyntaxToken[][];
  rawTokens: PreviewSyntaxToken[][];
};

const FORMAT_BY_EXTENSION: Readonly<Record<string, StructuredTextFormat>> = {
  ".json": "json",
  ".jsonc": "jsonc",
  ".yaml": "yaml",
  ".yml": "yaml",
};

let highlighterPromise: ReturnType<typeof createHighlighterCore> | null = null;

function getStructuredTextHighlighter(): ReturnType<typeof createHighlighterCore> {
  if (!highlighterPromise) {
    const createdHighlighter = createHighlighterCore({
      themes: [import("@shikijs/themes/github-dark-default")],
      langs: [
        import("@shikijs/langs/json"),
        import("@shikijs/langs/jsonc"),
        import("@shikijs/langs/yaml"),
      ],
      engine: createJavaScriptRegexEngine(),
    });
    highlighterPromise = createdHighlighter;
    void createdHighlighter.catch(() => {
      if (highlighterPromise === createdHighlighter) {
        highlighterPromise = null;
      }
    });
  }
  return highlighterPromise;
}

function extensionOf(fileName: string): string {
  const normalized = fileName.toLocaleLowerCase("en-US");
  const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const dotIndex = normalized.lastIndexOf(".");
  return dotIndex > separatorIndex ? normalized.slice(dotIndex) : "";
}

export function resolveStructuredTextFormat(fileName: string): StructuredTextFormat | null {
  return FORMAT_BY_EXTENSION[extensionOf(fileName)] ?? null;
}

export function canProjectStructuredText(byteLength: number): boolean {
  return byteLength >= 0 && byteLength <= STRUCTURED_TEXT_PREVIEW_MAX_BYTES;
}

function toPreviewTokens(lines: ThemedToken[][]): PreviewSyntaxToken[][] {
  return lines.map((line) => line.map((token) => ({
    content: token.content,
    ...(token.color ? { color: token.color } : {}),
    ...(token.fontStyle === undefined ? {} : { fontStyle: token.fontStyle }),
  })));
}

async function highlightStructuredText(
  text: string,
  format: StructuredTextFormat,
): Promise<PreviewSyntaxToken[][]> {
  const highlighter = await getStructuredTextHighlighter();
  return toPreviewTokens(highlighter.codeToTokensBase(text, {
    lang: format,
    theme: "github-dark-default",
  }));
}

async function formatStructuredText(text: string, format: StructuredTextFormat): Promise<string> {
  if (format === "json") {
    JSON.parse(text);
  }
  const { format: formatWithPrettier } = await import("prettier/standalone");
  const plugins = format === "yaml"
    ? [await import("prettier/plugins/yaml")]
    : await Promise.all([
      import("prettier/plugins/babel"),
      import("prettier/plugins/estree"),
    ]);
  return formatWithPrettier(text, {
    parser: format === "json" ? "json-stringify" : format,
    plugins,
  });
}

export async function projectStructuredText(
  text: string,
  format: StructuredTextFormat,
): Promise<StructuredTextProjection> {
  const formattedText = await formatStructuredText(text, format);
  const formattedTokensPromise = highlightStructuredText(formattedText, format);
  const rawTokensPromise = formattedText === text
    ? formattedTokensPromise
    : highlightStructuredText(text, format);
  const [formattedTokens, rawTokens] = await Promise.all([
    formattedTokensPromise,
    rawTokensPromise,
  ]);
  return {
    formattedText,
    formattedTokens,
    rawTokens: formattedText === text ? formattedTokens : rawTokens,
  };
}

export async function highlightRawStructuredText(
  text: string,
  format: StructuredTextFormat,
): Promise<PreviewSyntaxToken[][]> {
  return highlightStructuredText(text, format);
}
