import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTerminalLaunchCommands } from "../../src-electron/files/open-terminal.js";

/** 外部端末の起動候補を、対応 OS と作業ディレクトリの扱いに応じて確認する。 */
describe("buildTerminalLaunchCommands", () => {
  /** Windows Terminal を作業ディレクトリ付きで最優先し、PowerShell 7・Windows PowerShell・cmd の順で代替できる。 */
  it("Windows では Windows Terminal を最優先にする", () => {
    const commands = buildTerminalLaunchCommands("C:\\repo\\withmate", "win32");

    assert.equal(commands[0]?.command, "wt.exe");
    assert.deepEqual(commands[0]?.args, ["-d", "C:\\repo\\withmate"]);
    assert.equal(commands[1]?.command, "pwsh.exe");
    assert.equal(commands[2]?.command, "powershell.exe");
    assert.equal(commands[3]?.command, "cmd.exe");
  });

  /** 空白と引用符を含む作業ディレクトリを、PowerShell のワイルドカードと混同しない一つの LiteralPath にする。 */
  it("PowerShell fallback では LiteralPath を使って移動する", () => {
    const commands = buildTerminalLaunchCommands(
      "C:\\work tree\\o'hara",
      "win32",
    );

    assert.equal(
      commands[1]?.args[2],
      "Set-Location -LiteralPath 'C:\\work tree\\o''hara'",
    );
  });

  /** 非対応 OS では代替コマンドを推測せず、起動候補を返さない。 */
  it("未対応 platform では空配列を返す", () => {
    const commands = buildTerminalLaunchCommands("/tmp/withmate", "aix");

    assert.deepEqual(commands, []);
  });
});
