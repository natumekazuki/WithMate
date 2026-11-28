import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  createWindowsJobObject,
  WindowsJobObjectAcquisitionError,
  type WindowsJobObject,
} from "./windows-job-object.js";

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
    process.send?.({ kind: "provider_spawned" }, () => process.disconnect());
  });
  child.once("error", () => process.exit(71));
  child.once("exit", (code) => process.exit(code ?? 1));
});
`;

/** プロバイダー起動時の実行ファイル、シェルを介さず渡す引数、任意の作業場所と環境。 */
export type ProviderProcessLaunchOptions = Readonly<{
  executable: string;
  arguments: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}>;

/** OS 別のプロセス所有を試験できるよう、プラットフォーム判定・起動・Job Object 取得を差し替える。 */
export type OwnedProviderProcessDependencies = Readonly<{
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  createJobObject?: typeof createWindowsJobObject;
}>;

/** 子プロセスの入出力と起動確認、管理範囲の停止・所有権解放をひとまとめにする。 */
export type OwnedProviderProcess = Readonly<{
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  terminate: () => void;
  release: () => void;
}>;

/** 所有権の取得が途中で失敗した場合も保持する後片付け手段。まだ子が起動していなければ child はない。 */
export type OwnedProviderProcessCleanupOwner = Readonly<{
  child?: ChildProcessWithoutNullStreams;
  terminate: () => void;
  release: () => void;
}>;

/** 不完全な所有権取得を、管理できる範囲を片付けるためのハンドル付きで通知する。 */
export class OwnedProviderProcessAcquisitionError extends Error {
  readonly owner: OwnedProviderProcessCleanupOwner;

  /** 残っている所有者と、失敗理由を伝える原因を保持する。 */
  constructor(owner: OwnedProviderProcessCleanupOwner, options?: ErrorOptions) {
    super("Provider process ownership was only partially acquired.", options);
    this.name = "OwnedProviderProcessAcquisitionError";
    this.owner = owner;
  }
}

/** OS に応じてプロセスグループまたは Job Object で起動し、管理下のプロバイダーの起動と終了を制御できるようにする。 */
export function spawnOwnedProviderProcess(
  options: ProviderProcessLaunchOptions,
  dependencies: OwnedProviderProcessDependencies = {},
): OwnedProviderProcess {
  return (dependencies.platform ?? process.platform) === "win32"
    ? spawnWindowsProviderProcess(options, dependencies)
    : spawnPosixProviderProcess(options, dependencies);
}

/** POSIX では独立プロセスグループで直接起動し、子の入出力を親へ接続する。 */
function spawnPosixProviderProcess(
  options: ProviderProcessLaunchOptions,
  dependencies: OwnedProviderProcessDependencies,
): OwnedProviderProcess {
  const child = (dependencies.spawnProcess ?? spawn)(
    options.executable,
    [...options.arguments],
    {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: "pipe",
      detached: true,
      windowsHide: true,
    },
  );
  return {
    child,
    ready: waitForSpawn(child),
    /** 起動時に取得した PID に対応するプロセスグループを停止する。 */
    terminate: () => terminatePosixProcessGroup(child.pid),
    /** POSIX の場合は別途解放する OS の所有ハンドルを持たない。 */
    release: () => undefined,
  };
}

/** Windows では先に監督プロセスを Job Object に登録し、所有範囲が確立してから実際のプロバイダーを起動する。 */
function spawnWindowsProviderProcess(
  options: ProviderProcessLaunchOptions,
  dependencies: OwnedProviderProcessDependencies,
): OwnedProviderProcess {
  let job: WindowsJobObject;
  try {
    job = (dependencies.createJobObject ?? createWindowsJobObject)();
  } catch (error) {
    if (error instanceof WindowsJobObjectAcquisitionError) {
      throw new OwnedProviderProcessAcquisitionError(
        partialWindowsOwner(error.owner),
        { cause: error },
      );
    }
    throw error;
  }
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = (dependencies.spawnProcess ?? spawn)(
      process.execPath,
      ["--eval", WINDOWS_SUPERVISOR_SOURCE],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        windowsHide: true,
      },
    ) as ChildProcessWithoutNullStreams;
    if (child.pid === undefined)
      throw new Error("Windows process supervisor has no identity.");
    job.assignProcess(child.pid);
  } catch (error) {
    throw new OwnedProviderProcessAcquisitionError(
      partialWindowsOwner(job, child),
      { cause: error },
    );
  }

  return {
    child,
    ready: launchProviderFromSupervisor(child, options),
    /** プロバイダーとその子孫を含む、割り当て済みの Job Object を停止する。 */
    terminate: () => job.terminate(),
    /** Windows の Job Object ハンドルを閉じて所有状態を解放する。 */
    release: () => job.close(),
  };
}

/** 登録の途中で失敗しても Job Object と、取得済みなら監督プロセスを片付けられるようにする。 */
function partialWindowsOwner(
  job: WindowsJobObject,
  child?: ChildProcessWithoutNullStreams,
): OwnedProviderProcessCleanupOwner {
  return {
    ...(child === undefined ? {} : { child }),
    /** Job Object が停止できなくても監督プロセスの停止を試み、Job 側の失敗は呼び出し元へ伝える。 */
    terminate() {
      let terminationError: unknown;
      try {
        job.terminate();
      } catch (error) {
        terminationError = error;
      }
      if (child !== undefined) {
        child.kill("SIGKILL");
      }
      if (terminationError !== undefined) throw terminationError;
    },
    /** 部分的に取得した Job Object のハンドルも通常と同じ方法で閉じる。 */
    release: () => job.close(),
  };
}

/** 監督プロセスから起動完了の通知を待つ。通知前に停止した場合や設定を送れない場合は失敗とする。 */
function launchProviderFromSupervisor(
  supervisor: ChildProcessWithoutNullStreams,
  options: ProviderProcessLaunchOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    /** 起動確認を一度だけ確定し、不要になった監督プロセスのリスナーを外す。 */
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      supervisor.off("message", onMessage);
      supervisor.off("error", onError);
      supervisor.off("exit", onExit);
      if (error === undefined) resolve();
      else reject(error);
    };
    /** 監督プロセスから受け取った厳密な起動完了通知だけで待機を解く。 */
    const onMessage = (message: unknown) => {
      if (isProviderSpawnedMessage(message)) finish();
    };
    /** 起動確認前に監督プロセスでエラーが出たことを通知する。 */
    const onError = () =>
      finish(new Error("Windows process supervisor failed."));
    /** 根拠となる起動通知を得る前の監督プロセス終了を、起動失敗として扱う。 */
    const onExit = () =>
      finish(
        new Error("Windows process supervisor exited before Provider started."),
      );
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
          finish(
            new Error(
              "Windows process supervisor could not receive launch configuration.",
            ),
          );
        }
      },
    );
  });
}

/** 子から spawn または error が届くまで待ち、先に確定した側だけを返す。 */
function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    /** 起動を確認したら未使用のエラー待ちを外して成功させる。 */
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    /** 起動が失敗したら spawn 待ちを外し、内部の例外ではなく起動失敗を返す。 */
    const onError = () => {
      child.off("spawn", onSpawn);
      reject(new Error("Provider process could not be spawned."));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

/** 取得した PID のグループ全体に停止を送る。すでに存在しないグループは失敗にしない。 */
function terminatePosixProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
  }
}

/** 監督プロセスのメッセージが、追加フィールドを持たない起動完了通知と一致するか確認する。 */
function isProviderSpawnedMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 1 &&
    "kind" in value &&
    value.kind === "provider_spawned"
  );
}
