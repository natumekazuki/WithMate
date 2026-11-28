import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type {
  OpenPathOptions,
  OpenPathResult,
} from "../../src-shared/window/withmate-window-types.js";

const execFileAsync = promisify(execFile);

/** 入力文字列の解釈結果。OSに渡すファイルシステム上のパスと外部アプリに渡すURLを区別する。 */
export type ResolvedOpenPathTarget =
  | {
      type: "external-url";
      target: string;
    }
  | {
      type: "local-path";
      targetPath: string;
    };

/** ローカルパスを開く前に必要な対象の種別。 */
export type LocalPathStat = {
  /** 対象がディレクトリなら真を返す。 */
  isDirectory(): boolean;
  /** 対象が通常ファイルなら真を返す。 */
  isFile(): boolean;
};

/** パスの種別調査と既定のアプリ起動をOSに委ねるための依存先。 */
export type OpenLocalPathDeps = {
  /** 指定パスの種別を取得し、調査できなければ例外を伝える。 */
  statTarget(targetPath: string): Promise<LocalPathStat>;
  /** OSの既定アプリへパスを渡し、失敗時は診断文字列を返す。 */
  openWithDefaultApp(targetPath: string): Promise<string>;
};

/** 通常の起動に加え、ファイルの格納場所を表示するための依存先。 */
export type RevealLocalPathDeps = OpenLocalPathDeps & {
  /** ファイルの格納場所をファイルマネージャーで表示する。 */
  revealInFileManager(targetPath: string): void;
};

/** Mainで解決したディレクトリを表示する直前に、パスと要求元を再検証するための依存先。 */
export type OpenResolvedDirectoryDeps = OpenLocalPathDeps & {
  /** ファイルシステムでリンクを解決した正規パスを取得する。 */
  realpathTarget(targetPath: string): Promise<string>;
  /** 要求元のウィンドウがまだ操作を許可されているか確認する。 */
  assertSender(): Promise<void>;
  platform?: NodeJS.Platform;
  /** macOSでFinderを開くコマンドを実行する。未指定時はNodeの実行処理を使う。 */
  execFile?(file: string, args: string[]): Promise<unknown>;
};

/** ローカルリンクとして解釈するときに、デコード前にフラグメントとクエリを取り除く。 */
function stripLocalPathFragment(target: string): string {
  const hashIndex = target.indexOf("#");
  const withoutFragment = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const queryIndex = withoutFragment.indexOf("?");
  return queryIndex >= 0
    ? withoutFragment.slice(0, queryIndex)
    : withoutFragment;
}

/** 実行中のOSに依存せず、ドライブ付き絶対パスまたはバックスラッシュ形式のUNCを識別する。 */
function isWindowsAbsolutePath(targetPath: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(targetPath) || /^\\\\[^\\]+\\[^\\]+/.test(targetPath)
  );
}

/** ドライブ付き絶対パスに付いた余分な先頭スラッシュだけを除く。 */
function normalizeLeadingSlashWindowsAbsolutePath(targetPath: string): string {
  return /^\/[a-zA-Z]:[\\/]/.test(targetPath)
    ? targetPath.slice(1)
    : targetPath;
}

/** OS固有のURL変換を使わずWindows形式へ変換するfile URLを見分ける。 */
function isWindowsFileUrl(url: URL): boolean {
  const hostname = url.hostname;
  if (hostname && hostname !== "localhost") {
    return true;
  }
  return (
    /^\/[a-zA-Z]:\//.test(url.pathname) ||
    /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(url.pathname)
  );
}

/** 小文字化したスキームが外部アプリで開く対象かを判定する。 */
function isSupportedExternalUrlScheme(scheme: string): boolean {
  return (
    scheme === "http" ||
    scheme === "https" ||
    scheme === "mailto" ||
    scheme === "tel"
  );
}

/** スキームなしの入力を、ホスト表記とパスの階層数からUNC候補より先に外部URLとして扱うか判定する。 */
function isProtocolRelativeExternalUrl(target: string): boolean {
  const match = /^\/\/([^/?#]+)(\/[^?#]*)?/.exec(target);
  const authority = match?.[1] ?? "";
  if (
    authority.includes(".") ||
    authority.includes(":") ||
    authority.toLowerCase() === "localhost"
  ) {
    return true;
  }

  const pathSegments = (match?.[2] ?? "").split("/").filter(Boolean);
  return pathSegments.length === 1;
}

/** URL由来のエンコードを戻す。リテラルのパーセント記号などで変換できない場合は入力を保つ。 */
function decodeLocalPathTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/** 先頭が二重スラッシュで、ホスト名と共有名を含むUNC候補かを判定する。 */
function isForwardSlashUncPath(target: string): boolean {
  return /^\/\/[^/?#]+\/[^/?#]+(?:\/|$)/.test(target);
}

/**
 * UNCとして照会できる正規化済みの候補だけを返す。
 * すでにプロトコル相対 URL の形をしている入力では、UNC のネットワーク照会を行わない。
 */
export function resolveForwardSlashUncPathCandidate(
  target: string,
): string | null {
  const trimmed = target.trim();
  if (isProtocolRelativeExternalUrl(trimmed)) {
    return null;
  }

  const normalizedTarget = stripLocalPathFragment(trimmed).trim();
  if (!normalizedTarget) {
    return null;
  }
  const decodedTarget = decodeLocalPathTarget(normalizedTarget);
  if (!isForwardSlashUncPath(decodedTarget)) {
    return null;
  }
  return decodedTarget;
}

/** 二重スラッシュとホストで始まる入力から、元のクエリとフラグメントを保ったHTTPS候補を作る。 */
export function resolveProtocolRelativeExternalFallback(
  target: string,
): string | null {
  const trimmed = target.trim();
  return /^\/\/[^/?#]+/.test(trimmed) ? `https:${trimmed}` : null;
}

/** ファイルシステムを参照せずに外部URLとローカルパスを区別し、相対パスの基準があれば適用する。 */
export function resolveOpenPathTarget(
  target: string,
  options: OpenPathOptions = {},
): ResolvedOpenPathTarget {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new Error("The target to open cannot be empty.");
  }

  const normalizedTarget = stripLocalPathFragment(trimmed).trim();
  const decodedTarget = normalizedTarget
    ? decodeLocalPathTarget(normalizedTarget)
    : "";
  if (
    isForwardSlashUncPath(decodedTarget) &&
    !isProtocolRelativeExternalUrl(trimmed)
  ) {
    return {
      type: "local-path",
      targetPath: decodedTarget,
    };
  }

  if (isProtocolRelativeExternalUrl(trimmed)) {
    return {
      type: "external-url",
      target: `https:${trimmed}`,
    };
  }

  const externalUrlSchemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (
    externalUrlSchemeMatch &&
    isSupportedExternalUrlScheme(externalUrlSchemeMatch[1].toLowerCase())
  ) {
    return {
      type: "external-url",
      target: trimmed,
    };
  }

  if (/^file:/i.test(trimmed)) {
    const fileUrl = new URL(trimmed);
    fileUrl.hash = "";
    fileUrl.search = "";
    if (isWindowsFileUrl(fileUrl)) {
      const pathname = decodeURIComponent(fileUrl.pathname).replace(
        /\//g,
        "\\",
      );
      const hostname = fileUrl.hostname;
      const targetPath =
        hostname && hostname !== "localhost"
          ? `\\\\${hostname}${pathname}`
          : /^[\\][a-zA-Z]:\\/.test(pathname)
            ? pathname.slice(1)
            : pathname;
      return {
        type: "local-path",
        targetPath,
      };
    }
    return {
      type: "local-path",
      targetPath: fileURLToPath(fileUrl),
    };
  }

  if (!normalizedTarget) {
    throw new Error("The target path to open cannot be empty.");
  }

  const localTarget = normalizeLeadingSlashWindowsAbsolutePath(decodedTarget);

  if (path.isAbsolute(localTarget) || isWindowsAbsolutePath(localTarget)) {
    return {
      type: "local-path",
      targetPath: localTarget,
    };
  }

  const baseDirectory = options.baseDirectory?.trim();
  if (baseDirectory) {
    if (isWindowsAbsolutePath(baseDirectory)) {
      return {
        type: "local-path",
        targetPath: path.win32.resolve(baseDirectory, localTarget),
      };
    }
    return {
      type: "local-path",
      targetPath: path.resolve(baseDirectory, localTarget),
    };
  }

  return {
    type: "local-path",
    targetPath: localTarget,
  };
}

/** コピー時はローカルリンクをファイルシステムのパスへ正規化し、外部URLは元の表記を保つ。制御文字は拒否する。 */
export function resolveMarkdownLinkCopyTarget(target: string): string {
  const resolvedTarget = resolveOpenPathTarget(target);
  const copyTarget =
    resolvedTarget.type === "local-path" ? resolvedTarget.targetPath : target;
  if (/[\u0000-\u001f\u007f]/.test(copyTarget)) {
    throw new Error("Markdown link copy target contains control characters.");
  }
  return copyTarget;
}

/** パスが存在しない場合や途中の要素がディレクトリでない場合を、権限などによる他の失敗と区別する。 */
function isMissingLocalPathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  return code === "ENOENT" || code === "ENOTDIR";
}

/** ローカル候補が見つからなかったときだけ、同じ入力を外部URLとして開く候補を返す。 */
export function resolveProtocolRelativeExternalFallbackAfterLocalOpen(
  target: string,
  localResult: OpenPathResult,
): string | null {
  return localResult.status === "not-found"
    ? resolveProtocolRelativeExternalFallback(target)
    : null;
}

/** 例外のメッセージを優先し、メッセージが得られない値も診断用の文字列にする。 */
function describeLocalPathError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error || "Unknown filesystem error");
}

/** 対象が見つからない結果と、対象の調査自体に失敗した結果を分けて返す。 */
function projectLocalPathStatError(
  targetPath: string,
  error: unknown,
): OpenPathResult {
  if (isMissingLocalPathError(error)) {
    return {
      status: "not-found",
      targetType: "local-path",
      target: targetPath,
      message: "The local path was not found.",
    };
  }

  return {
    status: "failed",
    targetType: "local-path",
    target: targetPath,
    message: `The local path could not be inspected: ${describeLocalPathError(error)}`,
  };
}

/** 通常ファイルとディレクトリ以外はOSに開かせず、対象種別のエラーを返す。 */
function projectUnsupportedLocalPathType(targetPath: string): OpenPathResult {
  return {
    status: "failed",
    targetType: "local-path",
    target: targetPath,
    message: "The local path is not a file or directory.",
  };
}

/** 種別を取得できた実際のパス、またはその後の操作を打ち切る調査結果。 */
type InspectedLocalPath =
  | {
      targetPath: string;
      targetStat: LocalPathStat;
    }
  | {
      result: OpenPathResult;
    };

/** 末尾の正の行番号または行・列番号を外した代替パスを求める。 */
function resolveTextLocationFallbackPath(targetPath: string): string | null {
  const match =
    /^(.*):[1-9]\d*:[1-9]\d*$/.exec(targetPath) ??
    /^(.*):[1-9]\d*$/.exec(targetPath);
  const fallbackPath = match?.[1] ?? "";
  return fallbackPath ? fallbackPath : null;
}

/** まず入力どおりのパスを調べ、見つからない場合だけ末尾の行・列番号を外して再試行する。 */
async function inspectLocalPath(
  targetPath: string,
  statTarget: OpenLocalPathDeps["statTarget"],
): Promise<InspectedLocalPath> {
  try {
    return {
      targetPath,
      targetStat: await statTarget(targetPath),
    };
  } catch (error) {
    if (!isMissingLocalPathError(error)) {
      return { result: projectLocalPathStatError(targetPath, error) };
    }

    const fallbackPath = resolveTextLocationFallbackPath(targetPath);
    if (!fallbackPath) {
      return { result: projectLocalPathStatError(targetPath, error) };
    }

    try {
      return {
        targetPath: fallbackPath,
        targetStat: await statTarget(fallbackPath),
      };
    } catch (fallbackError) {
      return {
        result: isMissingLocalPathError(fallbackError)
          ? projectLocalPathStatError(targetPath, error)
          : projectLocalPathStatError(fallbackPath, fallbackError),
      };
    }
  }
}

/** 検査済みのパスを既定アプリに渡し、OSが返したエラー文字列と例外のどちらも失敗結果に変換する。 */
async function openExistingLocalPathWithDefaultApp(
  targetPath: string,
  openWithDefaultApp: OpenLocalPathDeps["openWithDefaultApp"],
): Promise<OpenPathResult> {
  try {
    const errorMessage = await openWithDefaultApp(targetPath);
    return errorMessage
      ? {
          status: "failed",
          targetType: "local-path",
          target: targetPath,
          message: errorMessage,
        }
      : { status: "opened", targetType: "local-path", target: targetPath };
  } catch (error) {
    return {
      status: "failed",
      targetType: "local-path",
      target: targetPath,
      message: `The default application could not open this path: ${describeLocalPathError(error)}`,
    };
  }
}

/** 確認できたファイルまたはディレクトリを既定アプリで開き、失敗時にファイルマネージャーへ切り替えない。 */
export async function openLocalPathWithDefaultApp(
  targetPath: string,
  deps: OpenLocalPathDeps,
): Promise<OpenPathResult> {
  const inspected = await inspectLocalPath(targetPath, deps.statTarget);
  if ("result" in inspected) {
    return inspected.result;
  }

  if (!inspected.targetStat.isFile() && !inspected.targetStat.isDirectory()) {
    return projectUnsupportedLocalPathType(inspected.targetPath);
  }

  return openExistingLocalPathWithDefaultApp(
    inspected.targetPath,
    deps.openWithDefaultApp,
  );
}

/**
 * Main が解決したディレクトリへのリンクだけを受け付ける。正規パスを URL として再解釈しない。
 * パスと要求元を再検証してから表示する。
 * macOSではアプリのバンドルを起動せずFinderで示し、他のOSでは既定アプリに渡す。
 */
export async function openResolvedDirectoryInFileManager(
  targetPath: string,
  deps: OpenResolvedDirectoryDeps,
): Promise<OpenPathResult> {
  try {
    if (
      !path.isAbsolute(targetPath) ||
      /[\u0000-\u001f\u007f]/u.test(targetPath)
    ) {
      throw new Error("The directory path is invalid.");
    }
    const targetStat = await deps.statTarget(targetPath);
    if (!targetStat.isDirectory()) {
      throw new Error(
        "The link target is no longer a directory. Open the link again.",
      );
    }
    if ((await deps.realpathTarget(targetPath)) !== targetPath) {
      throw new Error("The directory path changed. Open the link again.");
    }
  } catch (error) {
    return projectLocalPathStatError(targetPath, error);
  }
  try {
    await deps.assertSender();
  } catch (error) {
    return {
      status: "failed",
      targetType: "local-path",
      target: targetPath,
      message: `The directory could not be opened: ${describeLocalPathError(error)}`,
    };
  }
  if ((deps.platform ?? process.platform) === "darwin") {
    try {
      // バンドルもディレクトリなので、既定のアプリに渡さず Finder で表示する。
      await (deps.execFile ?? execFileAsync)("/usr/bin/open", [
        "-R",
        targetPath,
      ]);
      return { status: "opened", targetType: "local-path", target: targetPath };
    } catch (error) {
      return {
        status: "failed",
        targetType: "local-path",
        target: targetPath,
        message: `The directory could not be shown in Finder: ${describeLocalPathError(error)}`,
      };
    }
  }
  return openExistingLocalPathWithDefaultApp(
    targetPath,
    deps.openWithDefaultApp,
  );
}

/** ファイルなら格納場所を表示し、ディレクトリなら既定アプリで開く。調査または表示の失敗は結果で返す。 */
export async function revealLocalPathInFileManager(
  targetPath: string,
  deps: RevealLocalPathDeps,
): Promise<OpenPathResult> {
  const inspected = await inspectLocalPath(targetPath, deps.statTarget);
  if ("result" in inspected) {
    return inspected.result;
  }

  if (inspected.targetStat.isFile()) {
    try {
      deps.revealInFileManager(inspected.targetPath);
      return {
        status: "revealed",
        targetType: "local-path",
        target: inspected.targetPath,
        message: "The file was revealed in the file manager.",
      };
    } catch (error) {
      return {
        status: "failed",
        targetType: "local-path",
        target: inspected.targetPath,
        message: `The file could not be revealed: ${describeLocalPathError(error)}`,
      };
    }
  }

  if (inspected.targetStat.isDirectory()) {
    return openExistingLocalPathWithDefaultApp(
      inspected.targetPath,
      deps.openWithDefaultApp,
    );
  }

  return projectUnsupportedLocalPathType(inspected.targetPath);
}
