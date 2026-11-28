import { fileURLToPath } from "node:url";
import { TerminalActivityTracker } from "./terminal-activity.js";
import type {
  TerminalActivity,
  TerminalWorkerCommand,
  TerminalWorkerEvent,
} from "./terminal-worker-protocol.js";

/** 個別の端末イベント購読を解除するために返す操作。 */
type Disposable = {
  /** 対応する一つのリスナーを登録から外す。 */
  dispose(): void;
};

/** Main が操作する端末ハンドル。子プロセスの具体的な IPC は公開しない。 */
export type TerminalPty = {
  /** キー入力とシェル通知を反映した現在の活動状態を返す。 */
  getActivity(): TerminalActivity;
  /** 端末から渡された通常出力を受け取る購読を設定する。 */
  onData(listener: (data: string) => void): Disposable;
  /** シェルの終了コードと存在する場合のシグナルを受け取る。 */
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): Disposable;
  /** 起動後に端末ホストが通知したエラーを受け取る。 */
  onError(listener: (error: Error) => void): Disposable;
  /** シェルに入力を送信し、入力待ち状態の判定にも反映する。 */
  write(data: string): void;
  /** 端末の表示領域を新しい行数と列数に変更する。 */
  resize(cols: number, rows: number): void;
  /** renderer の出力処理が追いつくまで、PTY 側の読み取りを止める。 */
  pause(): void;
  /** 出力の滞留が減った端末の読み取りを再開する。 */
  resume(): void;
  /** 子プロセスの端末の停止を要求する。応答しない場合はホストも停止する。 */
  kill(): void;
};

/** 端末専用の Electron 子プロセスを起動し、PTY が開始された通知を待ってハンドルを返す。 */
export async function createUtilityTerminalPty(
  file: string,
  cwd: string,
  cols: number,
  rows: number,
  signal: AbortSignal,
): Promise<TerminalPty> {
  if (signal.aborted)
    return Promise.reject(new Error("Terminal creation was cancelled."));
  const { utilityProcess } = await import("electron");
  if (signal.aborted)
    return Promise.reject(new Error("Terminal creation was cancelled."));
  const host = utilityProcess.fork(
    fileURLToPath(new URL("./terminal-worker.js", import.meta.url)),
    [],
    {
      serviceName: "WithMate Terminal",
      stdio: "ignore",
    },
  );
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();
  const errorListeners = new Set<(error: Error) => void>();
  let stopped = false;
  let terminalExited = false;
  let settled = false;
  const activity = new TerminalActivityTracker();
  let forceStopTimer: ReturnType<typeof setTimeout> | null = null;

  /** ホストが起動していて停止処理中でない場合にだけコマンドを送る。 */
  const post = (command: TerminalWorkerCommand) => {
    if (!stopped && host.pid !== undefined) host.postMessage(command);
  };
  const pty: TerminalPty = {
    /** 子プロセスからの生の通知ではなく、入力も反映したトラッカーの状態を返す。 */
    getActivity: () => activity.getActivity(),
    /** 子プロセスから届く端末の通常出力を購読する。 */
    onData(listener) {
      dataListeners.add(listener);
      return {
        /** 登録した出力リスナーだけを取り除く。 */
        dispose: () => {
          dataListeners.delete(listener);
        },
      };
    },
    /** ネイティブのシェルが終了した場合の結果を購読する。 */
    onExit(listener) {
      exitListeners.add(listener);
      return {
        /** 登録した終了リスナーだけを取り除く。 */
        dispose: () => {
          exitListeners.delete(listener);
        },
      };
    },
    /** 起動後に通知された端末ホストのエラーを購読する。 */
    onError(listener) {
      errorListeners.add(listener);
      return {
        /** 登録したエラーリスナーだけを取り除く。 */
        dispose: () => {
          errorListeners.delete(listener);
        },
      };
    },
    /** 入力待ち状態を更新してから、端末ホストへキー入力を渡す。 */
    write(data) {
      activity.onInput(data);
      post({ type: "write", data });
    },
    /** 変更後の行・列を端末ホストへ伝える。 */
    resize(nextCols, nextRows) {
      post({ type: "resize", cols: nextCols, rows: nextRows });
    },
    /** 出力の滞留に合わせ、端末ホストに読み取りの一時停止を求める。 */
    pause() {
      post({ type: "pause" });
    },
    /** 滞留が解消した端末の読み取りを、ホスト経由で再開する。 */
    resume() {
      post({ type: "resume" });
    },
    /** 停止は一度だけ要求し、猶予後も残るホストには強制終了を試みる。 */
    kill() {
      if (stopped) return;
      stopped = true;
      if (host.pid !== undefined) {
        try {
          host.postMessage({ type: "stop" } satisfies TerminalWorkerCommand);
        } catch {
          host.kill();
        }
      }
      forceStopTimer = setTimeout(() => {
        if (host.pid !== undefined) host.kill();
      }, 2_000);
      forceStopTimer.unref?.();
    },
  };

  return new Promise<TerminalPty>((resolve, reject) => {
    /** 起動が確定する前にだけ、起動待ちを失敗にしてホストを停止する。 */
    const cancel = () => {
      if (settled) return;
      settled = true;
      stopped = true;
      host.kill();
      reject(new Error("Terminal creation was cancelled."));
    };
    signal.addEventListener("abort", cancel, { once: true });
    host.on("spawn", () => {
      if (stopped) {
        host.kill();
        return;
      }
      host.postMessage({
        type: "start",
        file,
        cwd,
        cols,
        rows,
      } satisfies TerminalWorkerCommand);
    });
    host.on("message", (message: TerminalWorkerEvent) => {
      if (!message || typeof message !== "object" || stopped) return;
      if (message.type === "started") {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", cancel);
          resolve(pty);
        }
      } else if (message.type === "activity") {
        activity.onActivity(message.activity);
      } else if (message.type === "data" && typeof message.data === "string") {
        for (const listener of dataListeners) listener(message.data);
      } else if (message.type === "terminal-exit") {
        terminalExited = true;
        for (const listener of exitListeners)
          listener({ exitCode: message.exitCode, signal: message.signal });
      } else if (message.type === "failed") {
        const error = new Error(message.message);
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", cancel);
          reject(error);
        } else for (const listener of errorListeners) listener(error);
      }
    });
    host.on("error", () => {
      // Electron は exit も発行する。失敗を知らせるイベントは exit に一本化する。
    });
    host.on("exit", (code) => {
      if (forceStopTimer) clearTimeout(forceStopTimer);
      if (stopped || terminalExited) return;
      const error = new Error(
        `Terminal host exited unexpectedly (code ${code}).`,
      );
      if (!settled) {
        settled = true;
        signal.removeEventListener("abort", cancel);
        reject(error);
      } else for (const listener of errorListeners) listener(error);
    });
  });
}
