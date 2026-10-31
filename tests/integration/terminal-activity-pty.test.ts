import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { it } from "node:test";
import { resolveTerminalShell } from "../../src-electron/terminal/terminal-service.js";

async function checkShell(file: string, major: number) {
  const result = await promisify(execFile)(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("../fixtures/terminal-activity-pty.ts", import.meta.url)), file, String(major),
  ], { timeout: 55_000, windowsHide: true });
  assert.equal(result.stderr, "");
}

// @test-value v2
// kind = "contract"
// claim = "実Windows PowerShell 5系はworkspaceで起動・I/O・resize・自然終了でき、実行中と貼付け末尾の未確定入力を保護し、確定後はidleへ戻る"
// oracle = { type = "contract", ref = "Issue #779 受け入れ条件; docs/design/desktop-ui.md Terminal" }
// fault = "5系でcwd・PTY操作を失うか、activity連携が実行中や編集中の端末をidleとして閉じる"
// observable = "子fixtureのversion・cwd・端末寸法出力とexit codeのassertion、activity・Window確認対象数・close結果・確認回数・kill回数"
// observation_boundary = "consumer"
// scope = "Windows PowerShell 5 PTY operations and activity-based terminal close"
// lifecycle = "permanent"
// impact = "貼付け末尾の未確定入力をTerminalまたはSession Window終了で失う"
// distinction = "stubではshellの実際のcwd・resize・誤idle通知を検出できない。実PTYを一つ起動しproducerから終了判断まで確認する"
// @end-test-value
it("checks Windows PowerShell 5 PTY operations and activity-based close decisions", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const shell = await resolveTerminalShell("win32", { SystemRoot: process.env.SystemRoot });
  await checkShell(shell.file, 5);
});

// @test-value v2
// kind = "contract"
// claim = "導入済みPowerShell 7を選択し、workspaceで起動・I/O・resize・自然終了でき、実行中と貼付け末尾の未確定入力を保護し、確定後はidleへ戻る"
// oracle = { type = "contract", ref = "Issue #779 受け入れ条件; docs/design/desktop-ui.md Terminal" }
// fault = "7を選んでも起動引数・activity連携が7で成立しないか、PTY操作が成立しない"
// observable = "子fixtureのversion・cwd・端末寸法出力とexit codeのassertion、activity・Window確認対象数・close結果・確認回数・kill回数"
// observation_boundary = "consumer"
// scope = "PowerShell 7 PTY operations and activity-based terminal close"
// lifecycle = "permanent"
// impact = "優先選択された7で端末操作できない、または終了時に未確定入力を失う"
// distinction = "5系の実PTYとstubでは7のruntime差を検出できない。7導入済みWindowsでのみ実processを一つ起動し、未導入はskipとして明示する"
// @end-test-value
it("checks preferred PowerShell 7 PTY operations and activity-based close decisions", { skip: process.platform !== "win32", timeout: 60_000 }, async (context) => {
  const shell = await resolveTerminalShell("win32");
  if (path.win32.basename(shell.file).toLowerCase() !== "pwsh.exe") {
    context.skip("PowerShell 7 is not installed in the supported search locations.");
    return;
  }
  await checkShell(shell.file, 7);
});
