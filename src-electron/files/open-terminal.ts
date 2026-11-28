import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

/** シェル経由で連結せず、プロセス起動へ渡す端末の実行ファイルと引数。 */
export type TerminalLaunchCommand = {
  command: string;
  args: string[];
};

/** PowerShellの単引用符付きリテラル内で引用符を文字として扱える形にする。 */
function escapePowerShellLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** cmdの二重引用符付き引数に埋め込む引用符を二重化する。 */
function escapeCmdDoubleQuoted(value: string): string {
  return value.replace(/"/g, '""');
}

/** 指定ディレクトリで開くための端末候補をOS別に試行順で返す。未対応OSには候補を返さない。 */
export function buildTerminalLaunchCommands(
  workingDirectory: string,
  platform: NodeJS.Platform = process.platform,
): TerminalLaunchCommand[] {
  if (platform === "win32") {
    return [
      {
        command: "wt.exe",
        args: ["-d", workingDirectory],
      },
      {
        command: "pwsh.exe",
        args: [
          "-NoExit",
          "-Command",
          `Set-Location -LiteralPath '${escapePowerShellLiteral(workingDirectory)}'`,
        ],
      },
      {
        command: "powershell.exe",
        args: [
          "-NoExit",
          "-Command",
          `Set-Location -LiteralPath '${escapePowerShellLiteral(workingDirectory)}'`,
        ],
      },
      {
        command: "cmd.exe",
        args: ["/k", `cd /d "${escapeCmdDoubleQuoted(workingDirectory)}"`],
      },
    ];
  }

  if (platform === "darwin") {
    return [
      {
        command: "open",
        args: ["-a", "Terminal", workingDirectory],
      },
    ];
  }

  if (platform === "linux") {
    return [
      {
        command: "x-terminal-emulator",
        args: [`--working-directory=${workingDirectory}`],
      },
      {
        command: "gnome-terminal",
        args: [`--working-directory=${workingDirectory}`],
      },
      {
        command: "konsole",
        args: ["--workdir", workingDirectory],
      },
      {
        command: "xfce4-terminal",
        args: ["--working-directory", workingDirectory],
      },
    ];
  }

  return [];
}

/** 起動前に作業場所を確認し、存在しないパスやディレクトリでないパスを拒否する。 */
async function ensureDirectoryExists(workingDirectory: string): Promise<void> {
  const directoryStat = await stat(workingDirectory);
  if (!directoryStat.isDirectory()) {
    throw new Error(
      "The workspace path is not a directory, so the terminal could not be opened.",
    );
  }
}

/** 端末を独立したプロセスとして起動し、端末の終了を待たずに起動イベントで完了する。 */
function launchDetachedCommand(
  launchCommand: TerminalLaunchCommand,
  workingDirectory: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(launchCommand.command, launchCommand.args, {
      cwd: workingDirectory,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** 指定ディレクトリで端末を開く。候補が見つからない場合に限って次候補へ進み、起動できなければ例外を返す。 */
export async function launchTerminalAtPath(
  workingDirectory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const normalizedPath = workingDirectory.trim();
  if (!normalizedPath) {
    throw new Error(
      "The workspace path is empty, so the terminal could not be opened.",
    );
  }

  await ensureDirectoryExists(normalizedPath);

  const launchCommands = buildTerminalLaunchCommands(normalizedPath, platform);
  if (launchCommands.length === 0) {
    throw new Error("Opening a terminal is not supported on this OS.");
  }

  let lastError: unknown = null;
  for (const launchCommand of launchCommands) {
    try {
      await launchDetachedCommand(launchCommand, normalizedPath);
      return;
    } catch (error) {
      lastError = error;
      const errorCode =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null;
      if (errorCode !== "ENOENT") {
        break;
      }
    }
  }

  throw new Error(
    lastError instanceof Error
      ? `The terminal could not be opened: ${lastError.message}`
      : "The terminal could not be opened.",
  );
}
