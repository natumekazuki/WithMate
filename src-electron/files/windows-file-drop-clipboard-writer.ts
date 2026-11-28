import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Worker } from "node:worker_threads";

const POWERSHELL_TIMEOUT_MS = 8_000;
const OPERATION_MARKER_FORMAT = "WithMate File Copy Operation";
const WRITE_READY_MARKER = "WITHMATE_FILE_DROP_READY";

const WRITE_FILE_DROP_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$targetPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([string]$request.pathBase64))
$operationMarker = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([string]$request.markerBase64))
Add-Type -AssemblyName System.Windows.Forms
$data = [System.Windows.Forms.DataObject]::new()
$data.SetData([System.Windows.Forms.DataFormats]::FileDrop, $true, [string[]]@($targetPath))
$effect = [System.IO.MemoryStream]::new([byte[]](1, 0, 0, 0), $false)
$data.SetData("Preferred DropEffect", $false, $effect)
$markerBytes = [System.Text.Encoding]::UTF8.GetBytes($operationMarker)
$marker = [System.IO.MemoryStream]::new($markerBytes, $false)
$data.SetData("${OPERATION_MARKER_FORMAT}", $false, $marker)
[Console]::Out.Write("${WRITE_READY_MARKER}")
[Console]::Out.Flush()
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 100)
`;

const VERIFY_FILE_DROP_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$targetPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([string]$request.pathBase64))
$operationMarker = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([string]$request.markerBase64))
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
$matches = $false
if ($null -ne $data) {
  $files = @($data.GetData([System.Windows.Forms.DataFormats]::FileDrop, $true))
  $effectValue = $data.GetData("Preferred DropEffect", $false)
  $markerValue = $data.GetData("${OPERATION_MARKER_FORMAT}", $false)
  $effectBytes = if ($effectValue -is [System.IO.MemoryStream]) { $effectValue.ToArray() } elseif ($effectValue -is [byte[]]) { $effectValue } else { $null }
  $markerBytes = if ($markerValue -is [System.IO.MemoryStream]) { $markerValue.ToArray() } elseif ($markerValue -is [byte[]]) { $markerValue } else { $null }
  $actualMarker = if ($null -ne $markerBytes) { [System.Text.Encoding]::UTF8.GetString($markerBytes) } else { "" }
  $matches = (
    ($files.Count -eq 1) -and
    [string]::Equals($files[0], $targetPath, [System.StringComparison]::OrdinalIgnoreCase) -and
    ($null -ne $effectBytes) -and
    ($effectBytes.Length -eq 4) -and
    ($effectBytes[0] -eq 1) -and
    ($effectBytes[1] -eq 0) -and
    ($effectBytes[2] -eq 0) -and
    ($effectBytes[3] -eq 0) -and
    [string]::Equals($actualMarker, $operationMarker, [System.StringComparison]::Ordinal)
  )
}
[Console]::Out.Write((@{ match = $matches } | ConvertTo-Json -Compress))
`;

/** PowerShell ヘルパーの起動、終了、タイムアウトと、判定に用いる標準出力。 */
export type ClipboardHelperProcessResult = {
  started: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
};

/** 書き込みまたは読み戻しの指示と、両者で照合する対象パスおよび操作マーカー。 */
export type ClipboardHelperProcessRequest = {
  mode: "write" | "verify";
  payload: {
    path: string;
    marker: string;
  };
};

/** 書き込み確認済み、書き込み前の失敗、副作用の有無を確定できない状態を区別する。 */
export type NativeFileDropWriteResult =
  | { status: "copied" }
  | { status: "failed-before-write" }
  | { status: "effect-unknown" };

/** 実行環境と、書き込み・読み戻しに使うヘルパーを差し替えるための設定。 */
export type WindowsFileDropClipboardWriterDeps = {
  platform?: NodeJS.Platform;
  /** ヘルパーを実行する。読み戻しの入力は、渡された書き込み待ちが成功した後に送る。 */
  runHelper?(
    request: ClipboardHelperProcessRequest,
    waitForWrite?: Promise<boolean>,
  ): Promise<ClipboardHelperProcessResult>;
  /** 読み戻した内容が今回の操作で書かれたと確認するためのマーカーを作る。 */
  createOperationMarker?(): string;
  systemRoot?: string;
};

/** Windows のクリップボードに一件のファイルをコピー用として書き、別プロセスでその結果を確認する。 */
export class WindowsFileDropClipboardWriter {
  /** ヘルパーの差し替えがなければ、実行環境を基準に専用 Worker を使う。 */
  constructor(private readonly deps: WindowsFileDropClipboardWriterDeps = {}) {}

  /** 呼び出し元が解決したファイルのパスを書き込み、ファイル・コピー効果・マーカーが読み戻せた場合だけ成功を返す。 */
  async copyFile(targetPath: string): Promise<NativeFileDropWriteResult> {
    if ((this.deps.platform ?? process.platform) !== "win32") {
      return { status: "failed-before-write" };
    }

    let payload: ClipboardHelperProcessRequest["payload"];
    try {
      payload = {
        path: targetPath,
        marker: this.deps.createOperationMarker?.() ?? randomUUID(),
      };
    } catch {
      return { status: "failed-before-write" };
    }
    const executeHelper = this.deps.runHelper;
    if (!executeHelper) {
      const systemRoot = this.deps.systemRoot ?? process.env.SystemRoot;
      if (!resolveWindowsPowerShellExecutablePath(systemRoot)) {
        return { status: "failed-before-write" };
      }
      return copyFileInWorker(payload, systemRoot);
    }
    /** ヘルパー呼び出しの例外を起動未確認の結果にそろえ、書き込み側と読み戻し側をまとめて判定できるようにする。 */
    const runHelper = async (
      request: ClipboardHelperProcessRequest,
      waitForWrite?: Promise<boolean>,
    ) => {
      try {
        return await executeHelper(request, waitForWrite);
      } catch {
        return { started: false, exitCode: null, timedOut: false, stdout: "" };
      }
    };
    const writePending = runHelper({ mode: "write", payload });
    // 書き込み側の起動中に別プロセスの読み取り側を準備するが、入力は書き込み側の終了まで渡さない。
    // これにより、読み戻しとクリップボードへの書き込みが競合しない。
    const waitForWrite = writePending.then(
      (result) => result.started && result.stdout.includes(WRITE_READY_MARKER),
    );
    const verificationPending = runHelper(
      { mode: "verify", payload },
      waitForWrite,
    );
    const [writeStarted, verificationResult] = await Promise.all([
      waitForWrite,
      verificationPending,
    ]);
    if (!writeStarted) {
      return { status: "failed-before-write" };
    }
    if (
      verificationResult.started &&
      !verificationResult.timedOut &&
      verificationResult.exitCode === 0 &&
      parseVerificationMatch(verificationResult.stdout)
    ) {
      return { status: "copied" };
    }
    return { status: "effect-unknown" };
  }
}

/** 読み戻しヘルパーが JSON の真偽値で一致を返したときだけ、照合成功とみなす。 */
function parseVerificationMatch(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout.trim()) as { match?: unknown };
    return parsed.match === true;
  } catch {
    return false;
  }
}

/** PowerShell の EncodedCommand が受け取る UTF-16LE の Base64 表現に変換する。 */
function encodePowerShellScript(source: string): string {
  return Buffer.from(source, "utf16le").toString("base64");
}

/** 非 ASCII のパスやマーカーを保持できるよう、両方を UTF-8 の Base64 にして標準入力用 JSON にまとめる。 */
export function encodeClipboardHelperPayload(
  payload: ClipboardHelperProcessRequest["payload"],
): string {
  return JSON.stringify({
    pathBase64: Buffer.from(payload.path, "utf8").toString("base64"),
    markerBase64: Buffer.from(payload.marker, "utf8").toString("base64"),
  });
}

/** ドライブ付きの SystemRoot から PowerShell の絶対パスを組み立て、PATH 検索には頼らない。 */
export function resolveWindowsPowerShellExecutablePath(
  systemRoot: string | undefined,
): string | null {
  const trimmedRoot = systemRoot?.trim() ?? "";
  if (!/^[a-zA-Z]:[\\/]/u.test(trimmedRoot)) {
    return null;
  }
  return path.win32.join(
    path.win32.resolve(trimmedRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

/** PowerShell を非表示の STA プロセスで起動し、書き込み側の終了を待つ指定があれば入力の送信を保留する。 */
export function runPowerShellClipboardHelper(
  request: ClipboardHelperProcessRequest,
  systemRoot: string | undefined,
  waitForWrite?: Promise<boolean>,
  spawnProcess: typeof spawn = spawn,
): Promise<ClipboardHelperProcessResult> {
  const script =
    request.mode === "write" ? WRITE_FILE_DROP_SCRIPT : VERIFY_FILE_DROP_SCRIPT;
  const powerShellExecutablePath =
    resolveWindowsPowerShellExecutablePath(systemRoot);
  if (!powerShellExecutablePath) {
    return Promise.resolve({
      started: false,
      exitCode: null,
      timedOut: false,
      stdout: "",
    });
  }
  return new Promise((resolve) => {
    let started = false;
    let settled = false;
    let timedOut = false;
    let stdout = "";
    const child = spawnProcess(
      powerShellExecutablePath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Sta",
        "-EncodedCommand",
        encodePowerShellScript(script),
      ],
      {
        cwd: path.win32.dirname(powerShellExecutablePath),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    /** プロセスの異常と閉鎖のどちらで終わっても、タイマーを解放して結果を一度だけ返す。 */
    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ started, exitCode, timedOut, stdout });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, POWERSHELL_TIMEOUT_MS);
    child.once("spawn", () => {
      started = true;
    });
    child.once("error", () => finish(null));
    child.once("close", (exitCode) => finish(exitCode));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 64 * 1024) {
        stdout += chunk;
      }
    });
    child.stdin.on("error", () => {
      // ネイティブの書き込みが開始され得たかどうかは、プロセスの終了結果で判断する。
    });
    if (waitForWrite) {
      void waitForWrite.then((writeStarted) => {
        if (settled || timedOut) {
          return;
        }
        if (writeStarted) {
          child.stdin.end(encodeClipboardHelperPayload(request.payload));
        } else {
          child.kill();
        }
      });
    } else {
      child.stdin.end(encodeClipboardHelperPayload(request.payload));
    }
  });
}

/** 専用 Worker に一件のコピーを任せ、正常終了を待って結果を確定する。開始後の異常は結果不明とする。 */
function copyFileInWorker(
  payload: ClipboardHelperProcessRequest["payload"],
  systemRoot: string | undefined,
): Promise<NativeFileDropWriteResult> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      const sourceTypeScript = import.meta.url.endsWith(".ts");
      worker = new Worker(
        new URL(
          sourceTypeScript
            ? "./windows-file-drop-clipboard-worker.ts"
            : "./windows-file-drop-clipboard-worker.js",
          import.meta.url,
        ),
        {
          ...(sourceTypeScript ? { execArgv: ["--import", "tsx"] } : {}),
          workerData: { payload, systemRoot },
        },
      );
    } catch {
      resolve({ status: "failed-before-write" });
      return;
    }
    let result: NativeFileDropWriteResult = { status: "effect-unknown" };
    let failed = false;
    worker.on("message", (message: NativeFileDropWriteResult) => {
      if (
        message?.status === "copied" ||
        message?.status === "failed-before-write" ||
        message?.status === "effect-unknown"
      ) {
        result = { status: message.status };
      }
    });
    worker.once("error", () => {
      failed = true;
    });
    // 使い切りの Worker とそのヘルパーのハンドルがなくなってから処理を確定する。
    worker.once("exit", (code) => {
      resolve(failed || code !== 0 ? { status: "effect-unknown" } : result);
    });
  });
}
