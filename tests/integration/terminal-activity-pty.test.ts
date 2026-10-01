import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

// @test-value v2
// kind = "contract"
// claim = "実PowerShellで複数行・分割貼付け後の未確定入力が残れば個別closeとWindow集計が確認を要求し、取消後に入力を確定すると警告不要へ復帰する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
// fault = "先行行のread-line完了と次の開始を入力消費済みと誤判定し、後続の編集中入力を無確認で終了する"
// observable = "実PTYのshell通知を受けたactivity、Window確認対象数、close戻り値、確認回数とkill回数"
// observation_boundary = "consumer"
// scope = "Windows PowerShell pending pasted input and terminal close"
// lifecycle = "permanent"
// impact = "貼付け末尾の未確定入力をTerminalまたはSession Window終了で失う"
// distinction = "stubによる通知列ではshell側の誤idle通知を検出できない。Windowsの実PTYを一つ起動する約10秒の検査でproducerから終了判断まで確認する"
// @end-test-value
it("protects pending pasted input through real PowerShell activity and close decisions", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const result = await promisify(execFile)(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("../fixtures/terminal-activity-pty.ts", import.meta.url)),
  ], { timeout: 55_000, windowsHide: true });
  assert.equal(result.stderr, "");
});
