import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

export type TerminalLaunchCommand = {
  command: string;
  args: string[];
};

function escapePowerShellLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeCmdDoubleQuoted(value: string): string {
  return value.replace(/"/g, "\"\"");
}

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
        args: ["-NoExit", "-Command", `Set-Location -LiteralPath '${escapePowerShellLiteral(workingDirectory)}'`],
      },
      {
        command: "powershell.exe",
        args: ["-NoExit", "-Command", `Set-Location -LiteralPath '${escapePowerShellLiteral(workingDirectory)}'`],
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

async function ensureDirectoryExists(workingDirectory: string): Promise<void> {
  const directoryStat = await stat(workingDirectory);
  if (!directoryStat.isDirectory()) {
    throw new Error("workspacePath がディレクトリではないため terminal を起動できないよ。");
  }
}

function launchDetachedCommand(launchCommand: TerminalLaunchCommand, workingDirectory: string): Promise<void> {
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

export async function launchTerminalAtPath(
  workingDirectory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const normalizedPath = workingDirectory.trim();
  if (!normalizedPath) {
    throw new Error("workspacePath が空のため terminal を起動できないよ。");
  }

  await ensureDirectoryExists(normalizedPath);

  const launchCommands = buildTerminalLaunchCommands(normalizedPath, platform);
  if (launchCommands.length === 0) {
    throw new Error("この OS では terminal 起動をまだサポートしていないよ。");
  }

  let lastError: unknown = null;
  for (const launchCommand of launchCommands) {
    try {
      await launchDetachedCommand(launchCommand, normalizedPath);
      return;
    } catch (error) {
      lastError = error;
      const errorCode = typeof error === "object" && error !== null && "code" in error ? error.code : null;
      if (errorCode !== "ENOENT") {
        break;
      }
    }
  }

  throw new Error(
    lastError instanceof Error
      ? `terminal の起動に失敗したよ: ${lastError.message}`
      : "terminal の起動に失敗したよ。",
  );
}
