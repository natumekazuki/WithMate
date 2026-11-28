import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node-pty";
import {
  createPowerShellActivityIntegration,
  TerminalActivityParser,
  TerminalActivityTracker,
} from "../../src-electron/terminal/terminal-activity.js";
import {
  TerminalService,
  type TerminalOwner,
} from "../../src-electron/terminal/terminal-service.js";

const integration = createPowerShellActivityIntegration();
const shell = process.argv[2];
const expectedMajor = Number(process.argv[3]);
assert.ok(
  shell && (expectedMajor === 7 || expectedMajor === 5),
  "Pass the shell path and expected major version",
);
const workspace = process.cwd();
// テストをユーザープロファイルに依存させず、テスト用コマンドを履歴に残さない。
const script =
  "Import-Module PSReadLine; Set-PSReadLineOption -HistorySaveStyle SaveNothing;\n" +
  Buffer.from(integration.args[2], "base64").toString("utf16le");
const pty = spawn(
  shell,
  [
    "-NoProfile",
    "-NoExit",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ],
  { cwd: workspace, cols: 120, rows: 24, env: process.env },
);
const tracker = new TerminalActivityTracker();
const activities: string[] = [];
let output = "";
let exited = false;
let exitCode: number | undefined;
let kills = 0;
let confirmations = 0;
const owner: TerminalOwner = {
  id: 1,
  /** 端末を操作する所有 Window は、fixture の間は有効とする。 */
  isDestroyed: () => false,
  /** Window のイベント購読は使わず、端末処理だけを直接駆動する。 */
  on() {},
  webContents: {
    /** 端末サービスが配送先として確認する WebContents を有効とする。 */
    isDestroyed: () => false,
    /** レンダラーのない fixture では WebContents への通知を破棄する。 */
    send() {},
    /** レンダラー側のライフサイクルは再現せず、実 PTY の通知だけを使う。 */
    on() {},
  },
};
const terminalId = "87263983-5b1d-4b5d-8f08-2b04899dbb8d";
const parser = new TerminalActivityParser(integration.marker, (activity) => {
  activities.push(activity);
  tracker.onActivity(activity);
});
const service = new TerminalService({
  /** 実 Window を作らず、端末の所有 Session と現在の作業ディレクトリを固定する。 */
  resolveOwner: () => ({
    window: owner,
    sessionId: "test",
    workspacePath: workspace,
  }),
  /** 終了確認が出た回数を記録し、利用者が閉じるのを取り消した結果を返す。 */
  confirmClose: async () => {
    confirmations++;
    return false;
  },
  /** UI へは配送せず、端末サービスの結果・活動マーカー・終了要求を直接観測する。 */
  sendEvent() {},
  /** 起動元テストが選んだ PowerShell を返し、別のシェルへフォールバックさせない。 */
  resolveShell: async () => ({ file: shell, shellName: "PowerShell" }),
  /** 既に起動した実 PTY を端末サービスへ接続し、活動判定と終了要求の観測を可能にする。 */
  spawn: async () => ({
    /** PSReadLine マーカーと入力を処理した時点での端末活動を返す。 */
    getActivity: () => tracker.getActivity(),
    /** PTY 出力から活動マーカーを分離し、残った表示用データを端末リスナーへ渡す。 */
    onData: (listener) => pty.onData((data) => listener(parser.push(data))),
    /** PTY が実際に終了したときの通知を、サービスのリスナーへ直接届ける。 */
    onExit: (listener) => pty.onExit(listener),
    /** この PTY の検証では、実行時エラー用の追加リスナーを登録しない。 */
    onError: () => ({
      /** 登録しなかったエラーリスナーの解除は、外部状態を変更しない。 */
      dispose() {},
    }),
    /** 入力を活動判定にも知らせ、同じ文字列を実 PTY に書き込む。 */
    write(data) {
      tracker.onInput(data);
      pty.write(data);
    },
    /** 変更された行数と列数を、実 PTY が使用する端末サイズへ渡す。 */
    resize: (cols, rows) => pty.resize(cols, rows),
    /** 表示出力の一時停止要求を実 PTY へ渡す。 */
    pause: () => pty.pause(),
    /** 実 PTY の停止中の表示出力を再開する。 */
    resume: () => pty.resume(),
    /** サービスからの終了要求だけを数え、fixture が状態を確認するまで実 PTY を終了させない。 */
    kill() {
      kills++;
    },
  }),
});
pty.onExit((event) => {
  exited = true;
  exitCode = event.exitCode;
});
pty.onData((data) => {
  output += data;
  if (data.includes("\x1b[6n")) pty.write("\x1b[1;1R");
});
/** 指定条件をポーリングし、終了または期限切れで条件に届かなければ活動状態と末尾出力を報告する。 */
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (!predicate() && !exited && Date.now() < deadline) await sleep(20);
  assert.ok(
    predicate(),
    `${label}: ${tracker.getActivity()}, ${JSON.stringify(output.slice(-2000))}`,
  );
}
/** 入力を PTY に直接渡さず、通常の端末サービス経由で所有者と端末 ID を照合する。 */
function write(data: string) {
  service.write(owner, terminalId, data);
}
/** コマンドを送信し、busy を一度観測してから idle に戻るまで待つ。 */
async function complete(command: string) {
  activities.length = 0;
  write(command + "\r");
  await until(
    () => activities.includes("busy") && tracker.getActivity() === "idle",
    "command completion",
  );
}
try {
  await service.create(owner, { terminalId, cols: 120, rows: 24 });
  await until(() => tracker.getActivity() === "idle", "initial empty prompt");
  assert.equal(service.countRequiringCloseConfirmation(owner), 0);
  output = "";
  await complete(
    "[Console]::WriteLine(('WITHMATE_' + 'VERSION=') + $PSVersionTable.PSVersion.Major); [Console]::WriteLine(('WITHMATE_' + 'CWD=') + $PWD.Path)",
  );
  assert.ok(output.includes(`WITHMATE_VERSION=${expectedMajor}`), output);
  assert.ok(output.includes(`WITHMATE_CWD=${workspace}`), output);
  service.resize(owner, terminalId, 100, 30);
  output = "";
  await complete(
    "[Console]::WriteLine(('WITHMATE_' + 'SIZE=') + $Host.UI.RawUI.WindowSize.Width + 'x' + $Host.UI.RawUI.WindowSize.Height)",
  );
  assert.ok(output.includes("WITHMATE_SIZE=100x30"), output);
  for (const chunks of [
    ["\rWrite-Output unfinished"],
    ["\r\rWrite-Output unfinished"],
    ["\r", "Write-Output unfinished"],
  ]) {
    activities.length = 0;
    output = "";
    for (const chunk of chunks) write(chunk);
    await until(
      () => activities.includes("busy") && output.includes("unfinished"),
      "pasted trailing edit",
    );
    // 末尾の行が未送信の間に、PSReadLine のアイドル間隔を数回分観測する。
    await sleep(1000);
    assert.equal(tracker.getActivity(), "unknown", JSON.stringify(chunks));
    assert.equal(service.countRequiringCloseConfirmation(owner), 1);
    const before = confirmations;
    assert.equal(await service.close(owner, terminalId), false);
    assert.equal(confirmations, before + 1);
    assert.equal(kills, 0);
    await complete("");
    assert.equal(service.countRequiringCloseConfirmation(owner), 0);
  }
  activities.length = 0;
  write("Start-Sleep -Seconds 2\r");
  await until(() => tracker.getActivity() === "busy", "running command");
  assert.equal(service.countRequiringCloseConfirmation(owner), 1);
  await until(() => tracker.getActivity() === "idle", "completed command");
  assert.equal(await service.close(owner, terminalId), true);
  assert.equal(confirmations, 3);
  assert.equal(kills, 1);
  pty.write("exit\r");
  await until(() => exited, "PTY shutdown");
  assert.equal(exitCode, 0);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (!exited) pty.kill();
  // ConPTY がネイティブヘルパーのハンドルを保持するため、その生存期間をこの子プロセス内に隔離する。
  await sleep(500);
  process.exit(process.exitCode ?? 0);
}
