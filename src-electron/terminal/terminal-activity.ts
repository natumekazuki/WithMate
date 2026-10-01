import { randomUUID } from "node:crypto";
import type { TerminalActivity } from "./terminal-worker-protocol.js";

/** Keep renderer input from racing a shell's read-line notifications. */
export class TerminalActivityTracker {
  private activity: TerminalActivity = "unknown";
  private awaitingReadLineReturn = false;

  getActivity(): TerminalActivity { return this.activity; }

  onInput(data: string): void {
    // xterm sends these notifications when focus moves, including to the close button.
    // They are terminal focus events, not shell keyboard input.
    if (!data || data === "\x1b[I" || data === "\x1b[O") return;
    this.activity = "unknown";
    this.awaitingReadLineReturn = true;
  }

  onActivity(activity: TerminalActivity): void {
    if (activity === "busy") this.awaitingReadLineReturn = false;
    if (activity !== "idle" || !this.awaitingReadLineReturn) this.activity = activity;
  }
}

/** Only the launched shell's read-line hook may report an idle terminal. */
export function createPowerShellActivityIntegration() {
  const marker = `633;P;WithMateActivity=${randomUUID()};`;
  const script = `
if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') {
  Import-Module PSReadLine -ErrorAction Stop
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace WithMateTerminal {
  public static class ConsoleProcesses {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint GetConsoleProcessList([Out] uint[] ids, uint count);
  }
}
'@ -ErrorAction Stop
  $global:__WithMateReadLine = $function:PSConsoleHostReadLine
  if ($null -ne $global:__WithMateReadLine) {
    Register-EngineEvent -SourceIdentifier PowerShell.OnIdle -SupportEvent -Action {
      if ($global:__WithMateReadLineIdleEligible) {
        $activity = 'unknown'
        try {
          $buffer = $null
          $cursor = 0
          [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$buffer, [ref]$cursor)
          if ($buffer.Length -eq 0 -and -not [Console]::KeyAvailable) { $activity = 'idle' }
        } catch { $activity = 'unknown' }
        [Console]::Write("$([char]27)]${marker}$activity$([char]7)")
      }
    } | Out-Null
    function global:PSConsoleHostReadLine {
      $global:__WithMateReadLineIdleEligible = $false
      try {
        $ids = New-Object System.UInt32[] 1
        $count = [WithMateTerminal.ConsoleProcesses]::GetConsoleProcessList($ids, 1)
        $jobs = @(Microsoft.PowerShell.Core\\Get-Job -ErrorAction Stop | Where-Object { $_.State -notin @('Completed', 'Failed', 'Stopped') })
        $children = @(CimCmdlets\\Get-CimInstance Win32_Process -Filter "ParentProcessId = $PID" -Property ProcessId -ErrorAction Stop)
        $global:__WithMateReadLineIdleEligible = $NestedPromptLevel -eq 0 -and $count -eq 1 -and $ids[0] -eq $PID -and $jobs.Count -eq 0 -and $children.Count -eq 0
      } catch { $global:__WithMateReadLineIdleEligible = $false }
      # ReadLine may still have queued keys from a paste when it starts.
      [Console]::Write("$([char]27)]${marker}unknown$([char]7)")
      try { $global:__WithMateReadLine.Invoke() }
      finally {
        $global:__WithMateReadLineIdleEligible = $false
        [Console]::Write("$([char]27)]${marker}busy$([char]7)")
      }
    }
  }
}
`;
  return {
    args: ["-NoExit", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    marker: `\x1b]${marker}`,
  };
}

/** Strip only our bounded control records; leave all other terminal output intact. */
export class TerminalActivityParser {
  private pending = "";

  constructor(private readonly marker: string, private readonly onActivity: (activity: TerminalActivity) => void) {}

  push(data: string): string {
    const records = (["idle", "busy", "unknown"] as const).map((activity) => ({
      activity, text: `${this.marker}${activity}\x07`,
    }));
    let output = "";
    for (const character of data) {
      this.pending += character;
      while (this.pending && !records.some(({ text }) => text.startsWith(this.pending))) {
        output += this.pending[0];
        this.pending = this.pending.slice(1);
      }
      const record = records.find(({ text }) => text === this.pending);
      if (record) {
        this.pending = "";
        this.onActivity(record.activity);
      }
    }
    return output;
  }

  flush(): string {
    const remaining = this.pending;
    this.pending = "";
    return remaining;
  }
}
