import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

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
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$targetPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([string]$request.pathBase64))
$operationMarker = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([string]$request.markerBase64))
Add-Type -AssemblyName System.Windows.Forms
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
$matches = $false
if ($null -ne $data) {
  $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
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

export type ClipboardHelperProcessResult = {
  started: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
};

export type ClipboardHelperProcessRequest = {
  mode: "write" | "verify";
  payload: {
    path: string;
    marker: string;
  };
};

export type NativeFileDropWriteResult =
  | { status: "copied" }
  | { status: "failed-before-write" }
  | { status: "effect-unknown" };

export type WindowsFileDropClipboardWriterDeps = {
  platform?: NodeJS.Platform;
  runHelper?(request: ClipboardHelperProcessRequest): Promise<ClipboardHelperProcessResult>;
  createOperationMarker?(): string;
  systemRoot?: string;
};

export class WindowsFileDropClipboardWriter {
  constructor(private readonly deps: WindowsFileDropClipboardWriterDeps = {}) {}

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
    const runHelper = this.deps.runHelper
      ?? ((request) => runPowerShellClipboardHelper(request, this.deps.systemRoot ?? process.env.SystemRoot));
    let writeResult: ClipboardHelperProcessResult;
    try {
      writeResult = await runHelper({ mode: "write", payload });
    } catch {
      return { status: "failed-before-write" };
    }
    if (!writeResult.started || !writeResult.stdout.includes(WRITE_READY_MARKER)) {
      return { status: "failed-before-write" };
    }

    let verificationResult: ClipboardHelperProcessResult;
    try {
      verificationResult = await runHelper({ mode: "verify", payload });
    } catch {
      return { status: "effect-unknown" };
    }
    if (
      verificationResult.started
      && !verificationResult.timedOut
      && verificationResult.exitCode === 0
      && parseVerificationMatch(verificationResult.stdout)
    ) {
      return { status: "copied" };
    }
    return { status: "effect-unknown" };
  }
}

function parseVerificationMatch(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout.trim()) as { match?: unknown };
    return parsed.match === true;
  } catch {
    return false;
  }
}

function encodePowerShellScript(source: string): string {
  return Buffer.from(source, "utf16le").toString("base64");
}

export function encodeClipboardHelperPayload(payload: ClipboardHelperProcessRequest["payload"]): string {
  return JSON.stringify({
    pathBase64: Buffer.from(payload.path, "utf8").toString("base64"),
    markerBase64: Buffer.from(payload.marker, "utf8").toString("base64"),
  });
}

export function resolveWindowsPowerShellExecutablePath(systemRoot: string | undefined): string | null {
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

function runPowerShellClipboardHelper(
  request: ClipboardHelperProcessRequest,
  systemRoot: string | undefined,
): Promise<ClipboardHelperProcessResult> {
  const script = request.mode === "write" ? WRITE_FILE_DROP_SCRIPT : VERIFY_FILE_DROP_SCRIPT;
  const powerShellExecutablePath = resolveWindowsPowerShellExecutablePath(systemRoot);
  if (!powerShellExecutablePath) {
    return Promise.resolve({ started: false, exitCode: null, timedOut: false, stdout: "" });
  }
  return new Promise((resolve) => {
    let started = false;
    let settled = false;
    let timedOut = false;
    let stdout = "";
    const child = spawn(
      powerShellExecutablePath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-EncodedCommand", encodePowerShellScript(script)],
      {
        cwd: path.win32.dirname(powerShellExecutablePath),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      },
    );
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
      // Process settlement determines whether the native write could have started.
    });
    child.stdin.end(encodeClipboardHelperPayload(request.payload));
  });
}
