import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import koffi from "koffi";

import {
  OwnedProviderProcessAcquisitionError,
  spawnOwnedProviderProcess,
  type OwnedProviderProcess,
} from "../providers/owned-process.js";
import type { WindowsJobObject } from "../providers/windows-job-object.js";

/** A stop request is independent of any Window and can arrive before or during launch. */
export type LocalPrCiStop = { signal: AbortSignal; reason: () => "canceled" | "interrupted" | undefined };
type ShellResult = { state: "succeeded" | "failed" | "canceled" | "interrupted"; exitCode: number | null; error: string | null; stopped: boolean };

/** Run the definition in one owned native shell; confirm completion and owned-process drain separately. */
export async function runLocalPrCiShell(
  work: string, checkout: string, commands: string[], stop: LocalPrCiStop, log: (chunk: Buffer) => void,
): Promise<ShellResult> {
  const windows = process.platform === "win32";
  if (!windows && process.platform !== "darwin" && process.platform !== "linux") {
    return shellResult("failed", null, "Local PR CI does not support this OS.", true);
  }
  const completion = join(work, "complete");
  const script = windows ? "ci.cmd" : "ci.sh";
  // Parse each scalar independently while retaining cwd and exported variables in the same shell.
  // CMD's CALL expands the work path on its second pass, so path values themselves are not re-expanded.
  if (windows) await Promise.all(commands.map((command, index) =>
    writeFile(join(work, `step-${index}.cmd`), `@${command}\r\n`, { flag: "wx", mode: 0o600 }),
  ));
  const lines = windows
    ? ["@echo off", "@chcp 65001 >nul", "@setlocal DisableDelayedExpansion",
        ...commands.flatMap((_command, index) => [`@call "%%WITHMATE_CI_WORK%%\\step-${index}.cmd"`, '@if not "%errorlevel%"=="0" exit /b %errorlevel%']),
        '@type nul > "%WITHMATE_CI_COMPLETION%"', "@exit /b %errorlevel%"]
    : ["set -e", ...commands.flatMap((command) => [`eval '${command.replaceAll("'", "'\\''")}'`, 'status=$?; [ "$status" -eq 0 ] || exit "$status"']), ': > "$WITHMATE_CI_COMPLETION"'];
  await writeFile(join(work, script), lines.join(windows ? "\r\n" : "\n") + (windows ? "\r\n" : "\n"), { flag: "wx", mode: 0o600 });
  const earlyStop = stop.reason();
  if (earlyStop) return shellResult(earlyStop, null, null, true);

  // Caller credentials are not passed to jobs; inherited Git overrides must not redirect CI to the source checkout.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(git_|withmate_|errorlevel$|electron_run_as_node$)/iu.test(name)));
  env.WITHMATE_CI_COMPLETION = completion;
  env.WITHMATE_CI_WORK = work;
  let job: CiWindowsJob | undefined;
  let owned: OwnedProviderProcess;
  try {
    owned = spawnOwnedProviderProcess({
      executable: windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe") : "/bin/sh",
      arguments: windows ? ["/d", "/q", "/s", "/c", "..\\ci.cmd"] : ["../ci.sh"],
      cwd: checkout, env,
    }, windows ? { createJobObject: () => (job = createCiWindowsJob()) } : {});
  } catch (error) {
    // Partial acquisition must never launch commands or silently lose a native owner.
    if (error instanceof OwnedProviderProcessAcquisitionError) {
      error.owner.child?.on("error", () => undefined);
      try { error.owner.terminate(); } finally { error.owner.release(); }
    }
    return shellResult("interrupted", null, "CI process ownership could not be established.", false);
  }

  const { child } = owned;
  child.stdin.end();
  child.stdin.on("error", () => undefined);
  child.stdout.on("data", log);
  child.stderr.on("data", log);
  child.on("error", () => undefined);
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let wakeStop: () => void = () => undefined;
  const stopping = new Promise<void>((resolve) => { wakeStop = resolve; });
  stop.signal.addEventListener("abort", wakeStop, { once: true });
  if (stop.signal.aborted) wakeStop();
  let ready = false;
  const launch = owned.ready.then(() => { ready = true; }, () => undefined);

  try {
    // Exit can precede pipe close when a child outlives the shell. Drain ownership before trusting either result.
    await Promise.race([exited, closed, stopping, launch.then(() => ready ? closed : undefined)]);
    const alive = () => job?.hasProcesses() ?? posixGroupExists(child.pid);
    if (alive()) owned.terminate();
    const deadline = Date.now() + 5000;
    while (alive() && Date.now() < deadline) await delay(25);
    if (alive()) return shellResult("interrupted", null, "CI process termination could not be confirmed.", false);
    const exitCode = await Promise.race([closed, delay(Math.max(0, deadline - Date.now()), undefined, { ref: false })]);
    if (exitCode === undefined) return shellResult("interrupted", null, "CI output did not close after termination.", false);
    const reason = stop.reason();
    if (reason) return shellResult(reason, null, null, true);
    if (!ready) return shellResult("failed", exitCode, "The CI shell could not be started.", true);
    if (exitCode === null) return shellResult("interrupted", null, "The CI shell exited without an exit code.", true);
    if (exitCode !== 0) return shellResult("failed", exitCode, `CI command exited with code ${exitCode}.`, true);
    if (!(await lstat(completion).catch(() => null))?.isFile()) {
      return shellResult("failed", exitCode, "The CI shell exited before completing the command list.", true);
    }
    return shellResult("succeeded", exitCode, null, true);
  } catch {
    return shellResult("interrupted", null, "CI process termination could not be confirmed.", false);
  } finally {
    stop.signal.removeEventListener("abort", wakeStop);
    child.stdout.off("data", log);
    child.stderr.off("data", log);
    owned.release();
  }
}

/** Build the terminal shell result without inferring success from a stop request. */
function shellResult(state: ShellResult["state"], exitCode: number | null, error: string | null, stopped: boolean): ShellResult {
  return { state, exitCode, error, stopped };
}

/** The shared POSIX launcher gives the shell a dedicated process group. */
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

type CiWindowsJob = WindowsJobObject & { hasProcesses(): boolean };
let cachedJobApi: ReturnType<typeof loadWindowsJobApi> | undefined;

/** Supply the existing Windows supervisor with a job that also exposes a process-count barrier. */
function createCiWindowsJob(): CiWindowsJob {
  const api = cachedJobApi ??= loadWindowsJobApi();
  const job = api.create(null, null);
  if (!job) throw new Error("Could not create a CI Job Object.");
  // A zeroed extended-limit structure has only KILL_ON_JOB_CLOSE set. LimitFlags follows two int64 fields.
  const limits = Buffer.alloc(api.limitsSize);
  limits.writeUInt32LE(0x2000, 16);
  if (!api.set(job, 9, limits, limits.length)) {
    api.close(job);
    throw new Error("Could not configure a CI Job Object.");
  }
  return {
    assignProcess(pid) {
      const handle = api.open(0x0101, 0, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
      if (!handle) throw new Error("Could not open the CI supervisor.");
      try {
        if (!api.assign(job, handle)) throw new Error("Could not assign the CI supervisor to its job.");
      } finally {
        if (!api.close(handle)) throw new Error("Could not close the CI supervisor handle.");
      }
    },
    hasProcesses() {
      // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION includes ActiveProcesses at byte 40 on both architectures.
      const accounting = Buffer.alloc(48);
      if (!api.query(job, 1, accounting, accounting.length, null)) throw new Error("Could not query CI job accounting.");
      return accounting.readUInt32LE(40) > 0;
    },
    terminate() {
      if (!api.terminate(job, 1)) throw new Error("Could not terminate the CI job.");
    },
    close() {
      if (!api.close(job)) throw new Error("Could not close the CI job.");
    },
  };
}

/** Bind only the Windows job operations used to own and confirm this CI tree. */
function loadWindowsJobApi() {
  const kernel = koffi.load("kernel32.dll");
  const handle = koffi.pointer(koffi.opaque());
  return {
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION: native pointer fields differ between Win32 and Win64.
    limitsSize: process.arch === "ia32" ? 112 : 144,
    create: kernel.func("CreateJobObjectW", handle, ["void *", "str16"]),
    set: kernel.func("SetInformationJobObject", "int", [handle, "int", "void *", "uint32_t"]),
    open: kernel.func("OpenProcess", handle, ["uint32_t", "int", "uint32_t"]),
    assign: kernel.func("AssignProcessToJobObject", "int", [handle, handle]),
    query: kernel.func("QueryInformationJobObject", "int", [handle, "int", "void *", "uint32_t", "void *"]),
    terminate: kernel.func("TerminateJobObject", "int", [handle, "uint32_t"]),
    close: kernel.func("CloseHandle", "int", [handle]),
  };
}
