import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function resolveCurrentGitBranch(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspacePath, "symbolic-ref", "--quiet", "--short", "HEAD"],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
    );
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}
