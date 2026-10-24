param(
  [Parameter(Mandatory = $true)][string]$LauncherPath,
  [Parameter(Mandatory = $true)][string]$RepositoryPath,
  [Parameter(Mandatory = $true)][string]$DataRoot,
  [string]$Mode,
  [switch]$ValidateOnly,
  [switch]$SeedDuringBuild,
  [Nullable[int]]$RemoteDebuggingPort = $null
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:APPDATA = $DataRoot
$global:visualCheckTestEvents = [System.Collections.Generic.List[string]]::new()
$global:visualCheckTestLaunch = $null

# Run the real launcher and filesystem operations, isolating build and OS process control.
function git.exe {
  "worktree $RepositoryPath"
  $global:LASTEXITCODE = 0
}

function npm.cmd {
  $global:visualCheckTestEvents.Add("npm $args")
  if ($SeedDuringBuild) {
    [System.IO.Directory]::CreateDirectory((Join-Path $DataRoot "WithMate-visual-check")) | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $DataRoot "WithMate-visual-check\arrived-during-build.txt"), "keep")
  }
  $global:LASTEXITCODE = 0
}

function Get-CimInstance {
  $global:visualCheckTestEvents.Add("process-scan")
  return @()
}

function Stop-Process {
  throw "The fixture must never stop an OS process."
}

function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, [switch]$PassThru)
  $global:visualCheckTestEvents.Add("launch")
  $global:visualCheckTestLaunch = @{
    filePath = $FilePath
    arguments = $ArgumentList
    workingDirectory = $WorkingDirectory
    userDataPath = $env:WITHMATE_USER_DATA_PATH
  }
  return [pscustomobject]@{ Id = 987654 }
}

function Get-Process {
  param($Id, $ErrorAction)
  if ($Id -ne 987654) {
    throw "Unexpected process lookup: $Id"
  }
  return [pscustomobject]@{ Id = 987654 }
}

function Start-Sleep {
  param($Seconds, $Milliseconds)
  if ($Milliseconds) {
    Microsoft.PowerShell.Utility\Start-Sleep -Milliseconds $Milliseconds
  }
}

$parameters = @{ WorktreePath = $RepositoryPath; ValidateOnly = $ValidateOnly }
if ($Mode) {
  $parameters.DataMode = $Mode
}
if ($null -ne $RemoteDebuggingPort) {
  $parameters.RemoteDebuggingPort = $RemoteDebuggingPort
}
try {
  $result = & $LauncherPath @parameters | Select-Object -Last 1
  $report = @{ result = $result; error = $null; events = @($global:visualCheckTestEvents); launch = $global:visualCheckTestLaunch }
} catch {
  $report = @{ result = $null; error = $_.Exception.Message; events = @($global:visualCheckTestEvents); launch = $global:visualCheckTestLaunch }
}
"RESULT_JSON:$($report | ConvertTo-Json -Depth 8 -Compress)"
