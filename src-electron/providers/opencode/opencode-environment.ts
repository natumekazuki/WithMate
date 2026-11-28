import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";

/** データベースを開く前の互換性確認で要求するネイティブ CLI のバージョン。 */
export const OPENCODE_VERSION = "2.2.5";

/** CLI の探索・検証に使う作業場所と環境。実行ファイルを明示する場合も作業場所と同様に絶対パスを指定する。 */
export type OpenCodeEnvironmentOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  signal?: AbortSignal;
};

/** バージョン確認済みの実行ファイルと、その CLI が報告したデータベースのパスおよび確認に用いた環境。 */
export type OpenCodeEnvironment = {
  executable: string;
  databasePath: string;
  env: NodeJS.ProcessEnv;
};
/** バージョンとデータベース位置の照会で共通に使う実行条件。 */
type CommandOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};
/** 実環境を起動せず解決手順を確認できるよう、OS 判定とコマンド実行を差し替える。 */
type EnvironmentDependencies = {
  platform?: NodeJS.Platform;
  runCommand?: (
    executable: string,
    args: readonly string[],
    options: CommandOptions,
  ) => Promise<string>;
};

/** 明示値または環境から CLI を特定し、互換バージョンと絶対データベースパスを確認する。待機中の中断も呼び出し元に伝える。 */
export async function resolveOpenCodeEnvironment(
  options: OpenCodeEnvironmentOptions,
  dependencies: EnvironmentDependencies = {},
): Promise<OpenCodeEnvironment> {
  if (
    !path.isAbsolute(options.cwd) ||
    (options.executable !== undefined && !path.isAbsolute(options.executable))
  ) {
    throw new TypeError(
      "OpenCode executable and workspace paths must be absolute.",
    );
  }
  options.signal?.throwIfAborted();
  const env = { ...(options.env ?? process.env) };
  const executable = await resolveExecutable(
    options.executable,
    env,
    dependencies.platform ?? process.platform,
  );
  const run = dependencies.runCommand ?? runCommand;
  const commandOptions = { cwd: options.cwd, env, signal: options.signal };
  // どちらのコマンドもデータベースを開かない。serve が移行を始める前に、互換性のない CLI バージョンを拒否する。
  const version = (await run(executable, ["--version"], commandOptions)).trim();
  if (version !== `opencode v${OPENCODE_VERSION}`)
    throw new Error(
      `OpenCode CLI ${OPENCODE_VERSION} is required. Use compatible WithMate and OpenCode versions; do not downgrade an existing OpenCode database.`,
    );
  const databasePath = (
    await run(executable, ["debug", "paths", "db"], commandOptions)
  ).trim();
  if (!path.isAbsolute(databasePath) || /[\r\n\0]/u.test(databasePath)) {
    throw new Error("OpenCode CLI did not report an absolute database path.");
  }
  options.signal?.throwIfAborted();
  return { executable, databasePath: path.resolve(databasePath), env };
}

/** 明示パスを優先し、なければ絶対パスの PATH 項目を順に探す。最初の候補が非対応でも別候補へ切り替えない。 */
async function resolveExecutable(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string> {
  if (explicit !== undefined) return nativeExecutable(explicit, platform);
  const searchPath =
    Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ??
    "";
  const pathExtensions =
    Object.entries(env).find(([key]) => key.toLowerCase() === "pathext")?.[1] ??
    ".COM;.EXE;.BAT;.CMD";
  const names =
    platform === "win32"
      ? [
          ...pathExtensions
            .split(";")
            .filter((extension) => /^\.[a-z0-9]+$/iu.test(extension))
            .map((extension) => `opencode${extension.toLowerCase()}`),
          "opencode",
        ]
      : ["opencode"];
  for (const directory of searchPath.split(platform === "win32" ? ";" : ":")) {
    // カレントディレクトリを暗黙に探したり、PATH の相対項目をワークスペース基準で解決したりしない。
    if (!path.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        await access(candidate);
      } catch {
        continue;
      }
      // PATH で最初に見つかったコマンドを採用する。未対応のシムを飛ばして探し続けない。
      return nativeExecutable(candidate, platform);
    }
  }
  throw new Error(
    `OpenCode CLI ${OPENCODE_VERSION} was not found on PATH. Install the official OpenCode CLI on this PC.`,
  );
}

/** 候補を実ファイルのパスへ解決する。Windows の npm シムは実行せず、公式ランチャーの形式と配布情報を確認して実行ファイルを求める。 */
async function nativeExecutable(
  candidate: string,
  platform: NodeJS.Platform,
): Promise<string> {
  if (platform !== "win32" || path.extname(candidate).toLowerCase() === ".exe")
    return realpath(candidate);
  if (path.extname(candidate).toLowerCase() !== ".cmd")
    throw new Error(
      "The OpenCode command is not a supported native executable or official npm shim.",
    );
  const shim = (await readFile(candidate, "utf8"))
    .replace(/\r\n/gu, "\n")
    .trim();
  // npm のネイティブバイナリ用シムに許すシェル処理は、この固定ランチャーだけ。任意のスクリプトは実行も再解釈もしない。
  const official =
    /^@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT \/b\n:start\nSETLOCAL\nCALL :find_dp0\n"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode\.exe"\s+%\*$/iu;
  if (!official.test(shim))
    throw new Error(
      "The OpenCode command is not a recognized official npm shim. Use the native OpenCode executable.",
    );
  const root = path.join(
    path.dirname(candidate),
    "node_modules",
    "@opencode",
    "cli",
  );
  const metadata: unknown = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("name" in metadata) ||
    metadata.name !== "@opencode/cli" ||
    !("bin" in metadata) ||
    !metadata.bin ||
    typeof metadata.bin !== "object" ||
    !("opencode" in metadata.bin) ||
    metadata.bin.opencode !== "./bin/opencode.exe"
  ) {
    throw new Error(
      "The OpenCode npm shim does not refer to the official CLI package.",
    );
  }
  return realpath(path.join(root, "bin", "opencode.exe"));
}

/** 診断コマンドの実行時間と出力量を制限し、失敗時は標準出力・標準エラーを公開せずに中断とその他の失敗を区別する。 */
function runCommand(
  executable: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        ...options,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          if (options.signal?.aborted) {
            reject(
              new DOMException(
                "OpenCode environment lookup aborted.",
                "AbortError",
              ),
            );
            return;
          }
          // stdout と stderr には環境由来の機密情報が含まれることがあるため、公開エラーには含めない。
          reject(
            new Error(
              "OpenCode CLI environment lookup failed. Check the PC installation and configuration.",
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}
