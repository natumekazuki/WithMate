import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINDOWS_RUNTIME_ACL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$targetPath = $env:WITHMATE_RUNTIME_ACL_TARGET
$targetKind = $env:WITHMATE_RUNTIME_ACL_KIND
if ([string]::IsNullOrWhiteSpace($targetPath) -or ($targetKind -ne "directory" -and $targetKind -ne "file")) {
  throw "Invalid runtime ACL target."
}

$attributes = [System.IO.File]::GetAttributes($targetPath)
$isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Runtime ACL target must not be a reparse point."
}
if (($targetKind -eq "directory") -ne $isDirectory) {
  throw "Runtime ACL target kind does not match."
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
$administrators = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
$expectedSids = @($currentUser, $system, $administrators)
$acl = if ($targetKind -eq "directory") {
  [System.Security.AccessControl.DirectorySecurity]::new()
} else {
  [System.Security.AccessControl.FileSecurity]::new()
}
$acl.SetOwner($currentUser)
$acl.SetAccessRuleProtection($true, $false)
$inheritanceFlags = if ($targetKind -eq "directory") {
  [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
foreach ($sid in $expectedSids) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritanceFlags,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
}
if ($targetKind -eq "directory") {
  $targetInfo = [System.IO.DirectoryInfo]::new($targetPath)
  $targetInfo.SetAccessControl($acl)
} else {
  $targetInfo = [System.IO.FileInfo]::new($targetPath)
  $targetInfo.SetAccessControl($acl)
}

$verifiedAttributes = [System.IO.File]::GetAttributes($targetPath)
$verifiedIsDirectory = ($verifiedAttributes -band [System.IO.FileAttributes]::Directory) -ne 0
if (($verifiedAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
    (($targetKind -eq "directory") -ne $verifiedIsDirectory)) {
  throw "Runtime ACL target changed during verification."
}
$verifiedAcl = $targetInfo.GetAccessControl(
  [System.Security.AccessControl.AccessControlSections]::Access -bor
    [System.Security.AccessControl.AccessControlSections]::Owner
)
$verifiedOwner = $verifiedAcl.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($verifiedOwner.Value -ne $currentUser.Value -or -not $verifiedAcl.AreAccessRulesProtected) {
  throw "Runtime ACL owner or inheritance is invalid."
}
$actualRules = @($verifiedAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($actualRules.Count -ne $expectedSids.Count) {
  throw "Runtime ACL contains unexpected rules."
}
$expectedSidValues = @()
foreach ($sid in $expectedSids) {
  $expectedSidValues += $sid.Value
}
foreach ($rule in $actualRules) {
  if ($rule.IsInherited -or
      $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      $expectedSidValues -notcontains $rule.IdentityReference.Value -or
      [int]$rule.FileSystemRights -ne [int][System.Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.InheritanceFlags -ne $inheritanceFlags -or
      $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) {
    throw "Runtime ACL verification failed."
  }
}
`;

const WINDOWS_RUNTIME_ACL_ENCODED_SCRIPT = Buffer.from(WINDOWS_RUNTIME_ACL_SCRIPT, "utf16le").toString("base64");

export type RuntimeAclTargetKind = "directory" | "file";

export async function secureWindowsRuntimePath(
  targetPath: string,
  targetKind: RuntimeAclTargetKind,
): Promise<void> {
  const systemRoot = process.env.SystemRoot?.trim();
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("SystemRoot must identify an absolute Windows directory.");
  }
  const powershellPath = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    await execFileAsync(powershellPath, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      WINDOWS_RUNTIME_ACL_ENCODED_SCRIPT,
    ], {
      env: {
        ...process.env,
        WITHMATE_RUNTIME_ACL_TARGET: targetPath,
        WITHMATE_RUNTIME_ACL_KIND: targetKind,
      },
      timeout: 15_000,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`Unable to secure runtime ${targetKind} Windows ACL.`, { cause: error });
  }
}
