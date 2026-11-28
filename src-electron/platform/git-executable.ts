import { realpath, stat } from "node:fs/promises";
import path from "node:path";

let gitExecutablePath: Promise<string> | undefined;

/** リポジトリの作業ディレクトリではなく、アプリケーションの PATH から解決する。 */
export function getDefaultGitExecutablePath(): Promise<string> {
  return (gitExecutablePath ??= resolveGitExecutablePath());
}

/** PATHの絶対ディレクトリを順に調べ、最初にファイルとして確認できたGit候補の実パスを返す。見つからなければ失敗する。 */
async function resolveGitExecutablePath(): Promise<string> {
  const pathValue =
    Object.entries(process.env).find(
      ([name]) => name.toUpperCase() === "PATH",
    )?.[1] ?? "";
  const executableName = process.platform === "win32" ? "git.exe" : "git";
  for (const directoryPath of pathValue.split(path.delimiter)) {
    const directory = directoryPath.trim().replace(/^"|"$/gu, "");
    if (!path.isAbsolute(directory)) continue;
    try {
      const candidate = await realpath(path.join(directory, executableName));
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // アプリケーションの PATH の探索を続ける。
    }
  }
  throw new Error(
    "Git executable could not be resolved from an absolute PATH entry.",
  );
}
