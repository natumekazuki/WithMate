import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { createWindowsJobObject } from "./windows-job-object.js";

const WINDOWS_SUPERVISOR_SOURCE = String.raw`
const { spawn } = require("node:child_process");
let launched = false;
process.once("disconnect", () => {
  if (!launched) process.exit(70);
});
process.once("message", (message) => {
  if (message === null || typeof message !== "object" || message.kind !== "launch") process.exit(70);
  launched = true;
  let child;
  try {
    child = spawn(message.executable, message.arguments, {
      cwd: message.cwd,
      env: message.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
  } catch {
    process.exit(71);
  }
  child.once("spawn", () => {
    process.send?.({ kind: "codex_spawned" }, () => process.disconnect());
  });
  child.once("error", () => process.exit(71));
  child.once("exit", (code) => process.exit(code ?? 1));
});
`;

export type CodexProcessLaunchOptions = Readonly<{
  executable: string;
  arguments: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}>;

export type OwnedCodexProcess = Readonly<{
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  terminate: () => void;
  release: () => void;
}>;

export function spawnOwnedCodexProcess(options: CodexProcessLaunchOptions): OwnedCodexProcess {
  return process.platform === "win32" ? spawnWindowsCodexProcess(options) : spawnPosixCodexProcess(options);
}

function spawnPosixCodexProcess(options: CodexProcessLaunchOptions): OwnedCodexProcess {
  const child = spawn(options.executable, [...options.arguments], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: "pipe",
    detached: true,
    windowsHide: true,
  });
  return {
    child,
    ready: waitForSpawn(child),
    terminate: () => terminatePosixProcessGroup(child.pid),
    release: () => undefined,
  };
}

function spawnWindowsCodexProcess(options: CodexProcessLaunchOptions): OwnedCodexProcess {
  const job = createWindowsJobObject();
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = spawn(process.execPath, ["--eval", WINDOWS_SUPERVISOR_SOURCE], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    if (child.pid === undefined) throw new Error("Windows process supervisor has no identity.");
    job.assignProcess(child.pid);
  } catch (error) {
    child?.once("error", () => undefined);
    child?.kill("SIGKILL");
    job.close();
    throw error;
  }

  return {
    child,
    ready: launchCodexFromSupervisor(child, options),
    terminate: () => job.terminate(),
    release: () => job.close(),
  };
}

function launchCodexFromSupervisor(
  supervisor: ChildProcessWithoutNullStreams,
  options: CodexProcessLaunchOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      supervisor.off("message", onMessage);
      supervisor.off("error", onError);
      supervisor.off("exit", onExit);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onMessage = (message: unknown) => {
      if (isCodexSpawnedMessage(message)) finish();
    };
    const onError = () => finish(new Error("Windows process supervisor failed."));
    const onExit = () => finish(new Error("Windows process supervisor exited before Codex started."));
    supervisor.on("message", onMessage);
    supervisor.once("error", onError);
    supervisor.once("exit", onExit);
    supervisor.send(
      {
        kind: "launch",
        executable: options.executable,
        arguments: [...options.arguments],
        cwd: options.cwd,
        env: options.env ?? process.env,
      },
      (error) => {
        if (error !== null && error !== undefined) {
          finish(new Error("Windows process supervisor could not receive launch configuration."));
        }
      },
    );
  });
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = () => {
      child.off("spawn", onSpawn);
      reject(new Error("Codex process could not be spawned."));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function terminatePosixProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function isCodexSpawnedMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 1 &&
    "kind" in value &&
    value.kind === "codex_spawned"
  );
}
