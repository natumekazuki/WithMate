import { createHighlighterCore, type ThemedToken } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";

/** プレビューで構造化テキストを整形・着色する対象の最大バイト数。 */
export const STRUCTURED_TEXT_PREVIEW_MAX_BYTES = 256 * 1024;

/** プレビューで整形と構文着色を扱うファイル形式。 */
export type StructuredTextFormat = "json" | "jsonc" | "yaml";

/** プレビューへ渡す文字列断片と、設定がある場合の色・書体情報。 */
export type PreviewSyntaxToken = {
  content: string;
  color?: string;
  fontStyle?: number;
};

/** 整形済みテキストと、整形後・原文それぞれの行別トークンを保持する。 */
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

/** 対応文法とテーマを遅延ロードして共有する。初期化が失敗した場合は次の要求で再試行する。 */
function getStructuredTextHighlighter(): ReturnType<
  typeof createHighlighterCore
> {
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

/** 最後のパス区切りより後ろにある拡張子を小文字で返す。 */
function extensionOf(fileName: string): string {
  const normalized = fileName.toLocaleLowerCase("en-US");
  const separatorIndex = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  const dotIndex = normalized.lastIndexOf(".");
  return dotIndex > separatorIndex ? normalized.slice(dotIndex) : "";
}

/** ファイル名の拡張子で形式を判定し、非対応ならnullを返す。内容は検査しない。 */
export function resolveStructuredTextFormat(
  fileName: string,
): StructuredTextFormat | null {
  return FORMAT_BY_EXTENSION[extensionOf(fileName)] ?? null;
}

/** バイト数が0以上かつ上限以下かを判定する。実際の構文の妥当性は判定しない。 */
export function canProjectStructuredText(byteLength: number): boolean {
  return byteLength >= 0 && byteLength <= STRUCTURED_TEXT_PREVIEW_MAX_BYTES;
}

/** 行の区切りを保ったまま、ハイライターの結果を描画に必要な情報へ絞る。 */
function toPreviewTokens(lines: ThemedToken[][]): PreviewSyntaxToken[][] {
  return lines.map((line) =>
    line.map((token) => ({
      content: token.content,
      ...(token.color ? { color: token.color } : {}),
      ...(token.fontStyle === undefined ? {} : { fontStyle: token.fontStyle }),
    })),
  );
}

/** 指定文法でテキストの色と書体を決め、プレビュー用の行別トークンを返す。 */
async function highlightStructuredText(
  text: string,
  format: StructuredTextFormat,
): Promise<PreviewSyntaxToken[][]> {
  const highlighter = await getStructuredTextHighlighter();
  return toPreviewTokens(
    highlighter.codeToTokensBase(text, {
      lang: format,
      theme: "github-dark-default",
    }),
  );
}

/** 形式に応じたパーサーで整形する。厳密なJSONは整形前にも構文を検査し、不正な入力は失敗として伝える。 */
async function formatStructuredText(
  text: string,
  format: StructuredTextFormat,
): Promise<string> {
  if (format === "json") {
    JSON.parse(text);
  }
  const { format: formatWithPrettier } = await import("prettier/standalone");
  const plugins =
    format === "yaml"
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

/** 原文を置き換えずに整形結果と両表示の着色情報を作る。整形前後が同じ場合は着色結果を共有する。 */
export async function projectStructuredText(
  text: string,
  format: StructuredTextFormat,
): Promise<StructuredTextProjection> {
  const formattedText = await formatStructuredText(text, format);
  const formattedTokensPromise = highlightStructuredText(formattedText, format);
  const rawTokensPromise =
    formattedText === text
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

/** 整形を実行せず、原文表示だけに使う行別の着色情報を作る。 */
export async function highlightRawStructuredText(
  text: string,
  format: StructuredTextFormat,
): Promise<PreviewSyntaxToken[][]> {
  return highlightStructuredText(text, format);
}
