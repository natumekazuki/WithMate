import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const localImportPattern = /@import\s+"([^"]+)"\s*;/g;

/** 相対 CSS import を参照元の位置から再帰的に展開し、他の import と周辺の CSS をそのまま残す。 */
async function expandStylesheet(path: string): Promise<string> {
  const source = await readFile(path, "utf8");
  let expanded = "";
  let lastIndex = 0;

  for (const match of source.matchAll(localImportPattern)) {
    const start = match.index ?? 0;
    const importPath = match[1];
    expanded += source.slice(lastIndex, start);
    if (importPath.startsWith(".")) {
      expanded += await expandStylesheet(resolve(dirname(path), importPath));
    } else {
      expanded += match[0];
    }
    lastIndex = start + match[0].length;
  }

  return expanded + source.slice(lastIndex);
}

/** リポジトリ直下を起点に、アプリの CSS エントリーを展開した検証用テキストを返す。 */
export function readStylesheet(): Promise<string> {
  const entryPath = resolve(process.cwd(), "src/styles.css");
  return expandStylesheet(entryPath);
}
