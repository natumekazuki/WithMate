[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$WorktreePath = (Get-Location).Path,

  [string]$ElectronPath,

  [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$VisualCheckProcessMarker = "--withmate-visual-check"

if (-not ("WithMate.VisualCheck.NativeCommandLine" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace WithMate.VisualCheck {
  public static class NativeCommandLine {
    [DllImport("shell32.dll", SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(
      [MarshalAs(UnmanagedType.LPWStr)] string commandLine,
      out int argumentCount
    );

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static string[] Split(string commandLine) {
      IntPtr arguments = CommandLineToArgvW(commandLine, out int argumentCount);
      if (arguments == IntPtr.Zero) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }

      try {
        string[] result = new string[argumentCount];
        for (int index = 0; index < argumentCount; index++) {
          IntPtr argument = Marshal.ReadIntPtr(arguments, index * IntPtr.Size);
          result[index] = Marshal.PtrToStringUni(argument);
        }
        return result;
      } finally {
        LocalFree(arguments);
      }
    }
  }
}
'@
}

function Resolve-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-NotReparsePoint {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label must not be a junction or symbolic link: $Path"
  }
}

function Get-RequiredElectronVersion {
  param([Parameter(Mandatory = $true)][string]$RepositoryPath)

  $lockPath = Join-Path $RepositoryPath "package-lock.json"
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
    throw "package-lock.json was not found in $RepositoryPath"
  }

  $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json -AsHashtable
  $version = $lock["packages"]["node_modules/electron"]["version"]
  if ([string]::IsNullOrWhiteSpace($version)) {
    throw "Electron version was not found in package-lock.json"
  }

  return $version
}

function Get-WithMateWorktreePaths {
  param([Parameter(Mandatory = $true)][string]$RepositoryPath)

  $worktreeLines = & git.exe -C $RepositoryPath worktree list --porcelain
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to list Git worktrees"
  }

  return @($worktreeLines | Where-Object {
    $_.StartsWith("worktree ", [System.StringComparison]::Ordinal)
  } | ForEach-Object {
    Resolve-FullPath $_.Substring("worktree ".Length)
  })
}

function Get-ElectronExecutable {
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryPath,
    [Parameter(Mandatory = $true)][string]$RequiredVersion,
    [string]$ExplicitPath
  )

  $candidatePaths = [System.Collections.Generic.List[string]]::new()
  if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
    $candidatePaths.Add((Resolve-FullPath $ExplicitPath))
  }
  $candidatePaths.Add((Join-Path $RepositoryPath "node_modules\electron\dist\electron.exe"))

  foreach ($candidateRoot in Get-WithMateWorktreePaths -RepositoryPath $RepositoryPath) {
    $candidatePaths.Add((Join-Path $candidateRoot "node_modules\electron\dist\electron.exe"))
  }

  foreach ($candidatePath in $candidatePaths | Select-Object -Unique) {
    if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
      continue
    }

    $packagePath = Join-Path (Split-Path -Parent (Split-Path -Parent $candidatePath)) "package.json"
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
      continue
    }

    $candidateVersion = (Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version
    if ($candidateVersion -eq $RequiredVersion) {
      return (Resolve-FullPath $candidatePath)
    }
  }

  throw "Electron $RequiredVersion was not found in this or another WithMate worktree. Run npm install in one worktree or pass -ElectronPath."
}

function Backup-SqliteDatabase {
  param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$DestinationPath
  )

  $backupScript = @'
const { DatabaseSync, backup } = require("node:sqlite");
(async () => {
  const database = new DatabaseSync(process.argv[1], { readOnly: true, timeout: 10000 });
  try {
    await backup(database, process.argv[2], { rate: 256, sleep: 0 });
  } finally {
    database.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
'@

  & node.exe --no-warnings -e $backupScript $SourcePath $DestinationPath
  if ($LASTEXITCODE -ne 0) {
    throw "SQLite backup failed: $SourcePath"
  }
}

function Initialize-VisualCheckUserData {
  param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$DestinationPath
  )

  if (Test-Path -LiteralPath $DestinationPath) {
    return
  }
  if (-not (Test-Path -LiteralPath $SourcePath -PathType Container)) {
    throw "Source userData was not found: $SourcePath"
  }

  $stagingPath = "$DestinationPath.copying-$PID"
  if (Test-Path -LiteralPath $stagingPath) {
    throw "Staging path already exists: $stagingPath"
  }

  New-Item -ItemType Directory -Path $stagingPath | Out-Null
  Write-Host "Copying userData to a staging directory..."

  $excludedFiles = @(
    "withmate*.db",
    "withmate*.db-wal",
    "withmate*.db-shm",
    "withmate.sqlite3",
    "withmate.sqlite3-wal",
    "withmate.sqlite3-shm",
    "lockfile",
    "DevToolsActivePort",
    "SingletonCookie",
    "SingletonLock",
    "SingletonSocket"
  )
  & robocopy.exe $SourcePath $stagingPath /E /XJ /COPY:DAT /DCOPY:DAT /R:2 /W:1 /MT:8 /NFL /NDL /NP /XF $excludedFiles
  $copyExitCode = $LASTEXITCODE
  if ($copyExitCode -ge 8) {
    throw "Robocopy failed with exit code $copyExitCode. Partial data remains at $stagingPath"
  }

  $databaseFiles = Get-ChildItem -LiteralPath $SourcePath -File | Where-Object {
    $_.Name -match '^withmate(?:-v\d+)?\.(?:db|sqlite3)$'
  }
  foreach ($databaseFile in $databaseFiles) {
    Write-Host "Creating consistent SQLite snapshot: $($databaseFile.Name)"
    Backup-SqliteDatabase `
      -SourcePath $databaseFile.FullName `
      -DestinationPath (Join-Path $stagingPath $databaseFile.Name)
  }

  Move-Item -LiteralPath $stagingPath -Destination $DestinationPath
  Write-Host "Created visual-check userData: $DestinationPath"
}

function Get-CommandLineArguments {
  param([string]$CommandLine)

  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return @()
  }

  return @([WithMate.VisualCheck.NativeCommandLine]::Split($CommandLine))
}

function Test-VisualCheckProcess {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string[]]$KnownMainPaths,
    [Parameter(Mandatory = $true)][string]$ProcessMarker
  )

  if ($Process.Name -ne "electron.exe") {
    return $false
  }

  $arguments = @(Get-CommandLineArguments -CommandLine $Process.CommandLine)
  if (-not ($arguments -ccontains $ProcessMarker)) {
    return $false
  }

  return [bool]($KnownMainPaths | Where-Object {
    $knownMainPath = $_
    $arguments | Where-Object {
      $_.Equals($knownMainPath, [System.StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1
  } | Select-Object -First 1)
}

function Get-ProcessTreeIds {
  param([Parameter(Mandatory = $true)][int]$RootProcessId)

  $allProcesses = @(Get-CimInstance Win32_Process)
  $pending = [System.Collections.Generic.Queue[int]]::new()
  $orderedIds = [System.Collections.Generic.List[int]]::new()
  $pending.Enqueue($RootProcessId)
  while ($pending.Count -gt 0) {
    $currentId = $pending.Dequeue()
    $orderedIds.Add($currentId)
    foreach ($child in $allProcesses | Where-Object { $_.ParentProcessId -eq $currentId }) {
      $pending.Enqueue([int]$child.ProcessId)
    }
  }

  $result = $orderedIds.ToArray()
  [array]::Reverse($result)
  return $result
}

function Stop-ProcessTree {
  param([Parameter(Mandatory = $true)][int]$RootProcessId)

  foreach ($processId in Get-ProcessTreeIds -RootProcessId $RootProcessId) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
  while ((Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue) -and
    [DateTimeOffset]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  if (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue) {
    throw "Visual-check process did not stop: PID $RootProcessId"
  }
}

function Stop-ExistingVisualCheckProcess {
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryPath,
    [Parameter(Mandatory = $true)][string]$UserDataPath,
    [Parameter(Mandatory = $true)][string]$ProcessMarker
  )

  $statePath = Join-Path $UserDataPath "visual-check-process.json"
  $knownMainPaths = @(Get-WithMateWorktreePaths -RepositoryPath $RepositoryPath | ForEach-Object {
    Resolve-FullPath (Join-Path $_ "dist-electron\src-electron\main.js")
  })
  $markedCandidates = @(Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object {
    Test-VisualCheckProcess `
      -Process $_ `
      -KnownMainPaths $knownMainPaths `
      -ProcessMarker $ProcessMarker
  })
  if ($markedCandidates.Count -gt 1) {
    $candidateIds = ($markedCandidates.ProcessId | Sort-Object) -join ", "
    throw "Multiple visual-check WithMate processes are running ($candidateIds). Close all but one manually."
  }
  $selectedProcess = $markedCandidates | Select-Object -First 1

  if ($selectedProcess) {
    Write-Host "Stopping previous visual-check WithMate: PID $($selectedProcess.ProcessId)"
    Stop-ProcessTree -RootProcessId ([int]$selectedProcess.ProcessId)
  }
  if (Test-Path -LiteralPath $statePath) {
    Remove-Item -LiteralPath $statePath -Force
  }

  $lockPath = Join-Path $UserDataPath "lockfile"
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
  while ((Test-Path -LiteralPath $lockPath) -and [DateTimeOffset]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  if (Test-Path -LiteralPath $lockPath) {
    throw "The visual-check userData remains locked, and no safely identifiable process can be stopped."
  }
}

$resolvedWorktreePath = Resolve-FullPath $WorktreePath
$resolvedUserDataPath = Resolve-FullPath (Join-Path $env:APPDATA "WithMate-visual-check")
$resolvedSourceUserDataPath = Resolve-FullPath (Join-Path $env:APPDATA "WithMate")

if (-not (Test-Path -LiteralPath (Join-Path $resolvedWorktreePath "package.json") -PathType Leaf)) {
  throw "WorktreePath is not a WithMate repository: $resolvedWorktreePath"
}
Assert-NotReparsePoint -Path $resolvedSourceUserDataPath -Label "Source userData"
Assert-NotReparsePoint -Path $resolvedUserDataPath -Label "Visual-check userData"

Initialize-VisualCheckUserData `
  -SourcePath $resolvedSourceUserDataPath `
  -DestinationPath $resolvedUserDataPath

$requiredElectronVersion = Get-RequiredElectronVersion -RepositoryPath $resolvedWorktreePath
$resolvedElectronPath = Get-ElectronExecutable `
  -RepositoryPath $resolvedWorktreePath `
  -RequiredVersion $requiredElectronVersion `
  -ExplicitPath $ElectronPath

Write-Host "Building $resolvedWorktreePath"
Push-Location $resolvedWorktreePath
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    throw "WithMate build failed"
  }
} finally {
  Pop-Location
}

$mainPath = Join-Path $resolvedWorktreePath "dist-electron\src-electron\main.js"
if (-not (Test-Path -LiteralPath $mainPath -PathType Leaf)) {
  throw "Electron main build was not found: $mainPath"
}

if ($ValidateOnly) {
  [pscustomobject]@{
    WorktreePath = $resolvedWorktreePath
    UserDataPath = $resolvedUserDataPath
    ElectronPath = $resolvedElectronPath
    ElectronVersion = $requiredElectronVersion
    MainPath = $mainPath
    Ready = $true
  }
  return
}

Stop-ExistingVisualCheckProcess `
  -RepositoryPath $resolvedWorktreePath `
  -UserDataPath $resolvedUserDataPath `
  -ProcessMarker $VisualCheckProcessMarker

$env:WITHMATE_USER_DATA_PATH = $resolvedUserDataPath
Remove-Item Env:VITE_DEV_SERVER_URL -ErrorAction SilentlyContinue
$process = Start-Process `
  -FilePath $resolvedElectronPath `
  -ArgumentList @($mainPath, $VisualCheckProcessMarker) `
  -WorkingDirectory $resolvedWorktreePath `
  -PassThru

Start-Sleep -Seconds 3
if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
  throw "WithMate exited during startup (PID $($process.Id))"
}

$processStatePath = Join-Path $resolvedUserDataPath "visual-check-process.json"
@{
  schemaVersion = 1
  processId = $process.Id
  mainPath = $mainPath
  electronPath = $resolvedElectronPath
  marker = $VisualCheckProcessMarker
  launchedAt = [DateTimeOffset]::UtcNow.ToString("O")
} | ConvertTo-Json | Set-Content -LiteralPath $processStatePath -Encoding utf8

[pscustomobject]@{
  ProcessId = $process.Id
  WorktreePath = $resolvedWorktreePath
  UserDataPath = $resolvedUserDataPath
  ElectronPath = $resolvedElectronPath
  ElectronVersion = $requiredElectronVersion
}
