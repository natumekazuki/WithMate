import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  OwnedProviderProcessAcquisitionError,
  spawnOwnedProviderProcess,
  type OwnedProviderProcess,
} from "../providers/owned-process.js";
import {
  createWindowsJobObject,
  type WindowsJobObject,
} from "../providers/windows-job-object.js";

/** 停止要求はウィンドウに依存せず、起動前にも起動中にも届き得る。 */
export type LocalPrCiStop = {
  signal: AbortSignal;
  reason: () => "canceled" | "interrupted" | undefined;
};
/** シェルの終了分類・終了コードと、管理下プロセスの停止を確認できたかの結果。 */
type ShellResult = {
  state: "succeeded" | "failed" | "canceled" | "interrupted";
  exitCode: number | null;
  error: string | null;
  stopped: boolean;
};

/** 管理下の単一のネイティブシェルで定義を実行し、完了と管理下のプロセスの終了を別々に確認する。 */
export async function runLocalPrCiShell(
  work: string,
  checkout: string,
  commands: string[],
  stop: LocalPrCiStop,
  log: (chunk: Buffer) => void,
): Promise<ShellResult> {
  const windows = process.platform === "win32";
  if (
    !windows &&
    process.platform !== "darwin" &&
    process.platform !== "linux"
  ) {
    return shellResult(
      "failed",
      null,
      "Local PR CI does not support this OS.",
      true,
    );
  }
  const completion = join(work, "complete");
  const script = windows ? "ci.cmd" : "ci.sh";
  // 同じシェルで cwd とエクスポート済み変数を維持し、各スカラー値は独立して解釈する。
  // CMD の CALL は2回目の処理で作業パスを展開するため、パスの値自体は再展開されない。
  if (windows)
    await Promise.all(
      commands.map((command, index) =>
        writeFile(join(work, `step-${index}.cmd`), `@${command}\r\n`, {
          flag: "wx",
          mode: 0o600,
        }),
      ),
    );
  const lines = windows
    ? [
        "@echo off",
        "@chcp 65001 >nul",
        "@setlocal DisableDelayedExpansion",
        ...commands.flatMap((_command, index) => [
          `@call "%%WITHMATE_CI_WORK%%\\step-${index}.cmd"`,
          '@if not "%errorlevel%"=="0" exit /b %errorlevel%',
        ]),
        '@type nul > "%WITHMATE_CI_COMPLETION%"',
        "@exit /b %errorlevel%",
      ]
    : [
        "set -e",
        ...commands.flatMap((command) => [
          `eval '${command.replaceAll("'", "'\\''")}'`,
          'status=$?; [ "$status" -eq 0 ] || exit "$status"',
        ]),
        ': > "$WITHMATE_CI_COMPLETION"',
      ];
  await writeFile(
    join(work, script),
    lines.join(windows ? "\r\n" : "\n") + (windows ? "\r\n" : "\n"),
    { flag: "wx", mode: 0o600 },
  );
  const earlyStop = stop.reason();
  if (earlyStop) return shellResult(earlyStop, null, null, true);

  // 呼び出し元の認証情報はジョブに渡さない。継承された Git の上書き設定で CI が元のチェックアウトを参照してはならない。
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(git_|withmate_|errorlevel$|electron_run_as_node$)/iu.test(name),
    ),
  );
  env.WITHMATE_CI_COMPLETION = completion;
  env.WITHMATE_CI_WORK = work;
  let job: WindowsJobObject | undefined;
  let owned: OwnedProviderProcess;
  try {
    owned = spawnOwnedProviderProcess(
      {
        executable: windows
          ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe")
          : "/bin/sh",
        arguments: windows
          ? ["/d", "/q", "/s", "/c", "..\\ci.cmd"]
          : ["../ci.sh"],
        cwd: checkout,
        env,
      },
      windows
        ? {
            /** Windows のプロセス所有に使うジョブを作り、終了確認にも同じハンドルを使う。 */
            createJobObject: () => (job = createWindowsJobObject()),
          }
        : {},
    );
  } catch (error) {
    // 部分的にしか取得できなかった場合は、コマンドを起動せず、ネイティブ側の所有者も失ったままにしない。
    if (error instanceof OwnedProviderProcessAcquisitionError) {
      error.owner.child?.on("error", () => undefined);
      try {
        error.owner.terminate();
      } finally {
        error.owner.release();
      }
    }
    return shellResult(
      "interrupted",
      null,
      "CI process ownership could not be established.",
      false,
    );
  }

  const { child } = owned;
  child.stdin.end();
  child.stdin.on("error", () => undefined);
  child.stdout.on("data", log);
  child.stderr.on("data", log);
  child.on("error", () => undefined);
  const closed = new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  /** 停止要求が届いたことを、シェルの完了待ちから抜けるための Promise に通知する。 */
  let wakeStop: () => void = () => undefined;
  const stopping = new Promise<void>((resolve) => {
    wakeStop = resolve;
  });
  stop.signal.addEventListener("abort", wakeStop, { once: true });
  if (stop.signal.aborted) wakeStop();
  let ready = false;
  const launch = owned.ready.then(
    () => {
      ready = true;
    },
    () => undefined,
  );

  try {
    // 子プロセスがシェルより長く残ると、パイプを閉じる前に終了イベントが届く。どちらの結果も採用する前に、管理下のプロセスがすべて終了するのを待つ。
    await Promise.race([
      exited,
      closed,
      stopping,
      launch.then(() => (ready ? closed : undefined)),
    ]);
    /** OS に応じ、同じ Job Object または POSIX プロセスグループに実行中のプロセスが残っているか調べる。 */
    const alive = () => job?.hasProcesses() ?? posixGroupExists(child.pid);
    if (alive()) owned.terminate();
    const deadline = Date.now() + 5000;
    while (alive() && Date.now() < deadline) await delay(25);
    if (alive())
      return shellResult(
        "interrupted",
        null,
        "CI process termination could not be confirmed.",
        false,
      );
    const exitCode = await Promise.race([
      closed,
      delay(Math.max(0, deadline - Date.now()), undefined, { ref: false }),
    ]);
    if (exitCode === undefined)
      return shellResult(
        "interrupted",
        null,
        "CI output did not close after termination.",
        false,
      );
    const reason = stop.reason();
    if (reason) return shellResult(reason, null, null, true);
    if (!ready)
      return shellResult(
        "failed",
        exitCode,
        "The CI shell could not be started.",
        true,
      );
    if (exitCode === null)
      return shellResult(
        "interrupted",
        null,
        "The CI shell exited without an exit code.",
        true,
      );
    if (exitCode !== 0)
      return shellResult(
        "failed",
        exitCode,
        `CI command exited with code ${exitCode}.`,
        true,
      );
    if (!(await lstat(completion).catch(() => null))?.isFile()) {
      return shellResult(
        "failed",
        exitCode,
        "The CI shell exited before completing the command list.",
        true,
      );
    }
    return shellResult("succeeded", exitCode, null, true);
  } catch {
    return shellResult(
      "interrupted",
      null,
      "CI process termination could not be confirmed.",
      false,
    );
  } finally {
    stop.signal.removeEventListener("abort", wakeStop);
    child.stdout.off("data", log);
    child.stderr.off("data", log);
    owned.release();
  }
}

/** 停止要求から成功を推定せず、シェルの最終結果を組み立てる。 */
function shellResult(
  state: ShellResult["state"],
  exitCode: number | null,
  error: string | null,
  stopped: boolean,
): ShellResult {
  return { state, exitCode, error, stopped };
}

/** 共通の POSIX 起動処理は、シェルに専用のプロセスグループを割り当てる。 */
function posixGroupExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
