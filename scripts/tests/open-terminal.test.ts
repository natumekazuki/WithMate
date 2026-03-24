import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTerminalLaunchCommands } from "../../src-electron/open-terminal.js";

describe("buildTerminalLaunchCommands", () => {
  it("Windows では Windows Terminal を最優先にする", () => {
    const commands = buildTerminalLaunchCommands("C:\\repo\\withmate", "win32");

    assert.equal(commands[0]?.command, "wt.exe");
    assert.deepEqual(commands[0]?.args, ["-d", "C:\\repo\\withmate"]);
    assert.equal(commands[1]?.command, "pwsh.exe");
    assert.equal(commands[2]?.command, "powershell.exe");
    assert.equal(commands[3]?.command, "cmd.exe");
  });

  it("PowerShell fallback では LiteralPath を使って移動する", () => {
    const commands = buildTerminalLaunchCommands("C:\\work tree\\o'hara", "win32");

    assert.equal(
      commands[1]?.args[2],
      "Set-Location -LiteralPath 'C:\\work tree\\o''hara'",
    );
  });

  it("未対応 platform では空配列を返す", () => {
    const commands = buildTerminalLaunchCommands("/tmp/withmate", "aix");

    assert.deepEqual(commands, []);
  });
});
