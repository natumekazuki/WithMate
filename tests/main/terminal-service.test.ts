import assert from "node:assert/strict";
import { constants } from "node:fs";
import { release } from "node:os";
import { describe, it } from "node:test";
import type { IpcMain, IpcMainEvent } from "electron";
import { registerTerminalHandlers } from "../../src-electron/ipc/terminal.js";
import { WITHMATE_RESIZE_TERMINAL_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import {
  resolveTerminalShell,
  TerminalService,
  type TerminalOwner,
} from "../../src-electron/terminal/terminal-service.js";
import type { TerminalPty } from "../../src-electron/terminal/utility-terminal-pty.js";

/** Electron Windowを起動せず、端末の所有者識別とイベントの登録・配送を再現する。 */
class StubWindow implements TerminalOwner {
  id = 1;
  destroyed = false;
  events: unknown[] = [];
  listeners = new Map<
    string,
    Array<
      (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => void
    >
  >();
  webContents = {
    /** Windowと同じ破棄フラグをwebContentsにも反映する。 */
    isDestroyed: () => this.destroyed,
    /** 端末イベントをレンダラーへ送らず照合用の配列へ追加する。 */
    send: (_channel: string, event: unknown) => this.events.push(event),
    /** 同じイベントへ複数のリスナーを登録できるようにする。 */
    on: (
      name: string,
      listener: (details: {
        isMainFrame?: boolean;
        isSameDocument?: boolean;
      }) => void,
    ) => {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    },
  };
  /** 所有者そのものの破棄状態を同期的に返す。 */
  isDestroyed(): boolean {
    return this.destroyed;
  }
  /** Windowのclosed購読を他のイベントと同じリスナー集合に記録する。 */
  on(name: "closed", listener: () => void): void {
    this.webContents.on(name, listener);
  }
  /** 指定イベントを発火し、登録済みの解放処理を動かす。 */
  emit(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener({});
  }
}

const TERMINAL_ID = "87263983-5b1d-4b5d-8f08-2b04899dbb8d";

/** 端末起動前のWindowsシェル選択について、探索順・有効な探索ルート・失敗伝播を検証する。 */
describe("resolveTerminalShell", () => {
  const first = "C:\\custom shell\\pwsh.exe";
  const second = "D:\\tools\\pwsh.exe";
  const standard = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const legacy =
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const env = {
    Path: ';relative;"C:\\custom shell";D:\\tools',
    ProgramFiles: "C:\\Program Files",
    SystemRoot: "C:\\Windows",
  };

  // @test-value v2
  // kind = "contract"
  // claim = "WindowsはPATH順の7、標準配置7、5系の順に選び、空・相対PATHは探索せず、全候補不在なら拒否する"
  // oracle = { type = "contract", ref = "Issue #779 受け入れ条件; docs/design/desktop-ui.md Terminal" }
  // fault = "PATH順や7優先を逆転する、標準配置を見落とす、cwdや現在ドライブに依存する候補を選ぶ、候補不在でも成功する"
  // observable = "候補の存在条件を変えたresolveTerminalShellのfile、shellName、windowsPtyと不在時の拒否"
  // observation_boundary = "component-behavior"
  // scope = "Windows embedded terminal shell selection"
  // lifecycle = "permanent"
  // impact = "導入済み7を使えない、意図しないcwdの実行ファイルを起動する、起動失敗を隠す"
  // distinction = "実機一台では共存・標準配置のみ・5系のみ・不在を同時に維持できず、少数のI/O stubで決定論的に確認する"
  // @end-test-value
  /** 7系はPATHから標準配置の順に探し、どちらにもなければ5系を選び、全候補不在はエラーにする。 */
  it("selects PATH PowerShell 7, standard PowerShell 7, then Windows PowerShell", async () => {
    const candidates = [first, second, standard, legacy];
    const searchEnv = { ...env, Path: `\\tools;/tools;C:tools;${env.Path}` };
    for (let index = 0; index <= candidates.length; index++) {
      const available = candidates.slice(index);
      const resolving = resolveTerminalShell(
        "win32",
        searchEnv,
        async (file, mode) => {
          assert.equal(mode, constants.X_OK);
          assert.ok(
            candidates.includes(String(file)),
            `Unexpected search target: ${String(file)}`,
          );
          if (!available.includes(String(file)))
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      );
      if (available.length === 0) {
        await assert.rejects(
          resolving,
          /Neither PowerShell 7 .* nor Windows PowerShell .* was found/,
        );
      } else {
        assert.deepEqual(await resolving, {
          file: available[0],
          shellName: "PowerShell",
          windowsPty: { buildNumber: Number(release().split(".")[2]) },
        });
      }
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "7の探索はSystemRootに依存せず、drive付き・UNCの完全修飾pathを使い、未設定・相対・root-relativeの標準rootを探索せず、存在しない親directoryは次候補へ進む"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "5系のroot不足で7も起動不能にする、完全修飾UNCを拒否する、cwdや現在ドライブに依存するrootから選ぶ、ENOTDIRで探索を停止する"
  // observable = "最小環境・相対root・ENOTDIR条件で返るfileまたは候補不在の拒否"
  // observation_boundary = "component-behavior"
  // scope = "Windows shell search environment"
  // lifecycle = "permanent"
  // @end-test-value
  /** 相対やroot-relativeの標準ルートを無視し、完全修飾パスだけを使い、存在しない親ディレクトリーでは探索を続ける。 */
  it("searches only fully qualified roots and continues past missing directories", async () => {
    for (const directory of ["D:\\tools", "\\\\server\\share\\tools"]) {
      assert.equal(
        (
          await resolveTerminalShell(
            "win32",
            { PATH: directory },
            async () => {},
          )
        ).file,
        `${directory}\\pwsh.exe`,
      );
    }
    for (const root of ["", "relative", "\\tools", "/tools", "C:tools"]) {
      await assert.rejects(
        resolveTerminalShell(
          "win32",
          { ProgramFiles: root, SystemRoot: root },
          async () => {
            assert.fail(
              `Non-fully-qualified root must not be searched: ${root}`,
            );
          },
        ),
        /Neither PowerShell/,
      );
    }
    assert.equal(
      (
        await resolveTerminalShell("win32", env, async (file) => {
          if (String(file) !== standard)
            throw Object.assign(new Error("not a directory"), {
              code: "ENOTDIR",
            });
        })
      ).file,
      standard,
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "探索中のアクセス拒否は未導入扱いにせず呼び出し元へ同じ失敗を返す"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "存在確認の例外をすべて無視して別の7または5系を選択する"
  // observable = "resolveTerminalShellの拒否理由と失敗後の候補探索がないこと"
  // observation_boundary = "component-behavior"
  // scope = "Windows shell discovery errors"
  // lifecycle = "permanent"
  // @end-test-value
  /** アクセス拒否は未導入に置き換えず、その候補で停止して同じエラーを返す。 */
  it("propagates access errors instead of downgrading the shell", async () => {
    const denied = Object.assign(new Error("access denied"), {
      code: "EACCES",
    });
    const searched: string[] = [];
    await assert.rejects(
      resolveTerminalShell("win32", env, async (file) => {
        searched.push(String(file));
        if (String(file) === first) throw denied;
      }),
      (error) => error === denied,
    );
    assert.deepEqual(searched, [first]);
  });
});

/** 別々の所有Windowと観測可能なPTYを用意し、確認判断・操作・配送の検証を外部プロセスなしで行う。 */
function setup(confirmClose?: () => Promise<boolean>) {
  const window = new StubWindow();
  const other = new StubWindow();
  other.id = 2;
  const pty = {
    activity: "unknown" as "unknown" | "idle" | "busy",
    /** ケースが設定したPTYの稼働判定をそのまま端末サービスに返す。 */
    getActivity() {
      return this.activity;
    },
    writes: [] as string[],
    resizes: [] as Array<[number, number]>,
    kills: 0,
    pauses: 0,
    resumes: 0,
    /** データリスナー登録前の受け皿として出力を捨てる。 */
    data: (_value: string) => {},
    /** 終了リスナー登録前に届ける先がないため何も記録しない。 */
    exit: (_value: { exitCode: number; signal?: number }) => {},
    /** エラー購読がまだ設定されていない場合の空実装。 */
    error: (_value: Error) => {},
    /** テストから出力を注入できるよう、サービスのデータリスナーを保持する。 */
    onData(listener: (value: string) => void) {
      this.data = listener;
      return {
        /** 実購読を作らないため、データ購読解除は外部リソースを操作しない。 */
        dispose() {},
      };
    },
    /** テストから自然終了を発火できるよう、終了リスナーを保持する。 */
    onExit(listener: (value: { exitCode: number; signal?: number }) => void) {
      this.exit = listener;
      return {
        /** 終了購読解除のインターフェースだけを満たす。 */
        dispose() {},
      };
    },
    /** ホスト障害を模擬できるよう、サービスのエラーリスナーを保持する。 */
    onError(listener: (error: Error) => void) {
      this.error = listener;
      return {
        /** メモリ上のエラー購読に対して実イベント源の解除を行わない。 */
        dispose() {},
      };
    },
    /** PTYへ渡された入力文字列と入力順を記録する。 */
    write(value: string) {
      this.writes.push(value);
    },
    /** ネイティブPTYへ渡す列数・行数を検証用に保存する。 */
    resize(cols: number, rows: number) {
      this.resizes.push([cols, rows]);
    },
    /** 実プロセスは終了せず、killの要求回数を加算する。 */
    kill() {
      this.kills++;
    },
    /** 出力抑制が発生した回数を加算する。 */
    pause() {
      this.pauses++;
    },
    /** 抑制から復帰した回数を加算する。 */
    resume() {
      this.resumes++;
    },
  };
  let confirm = false;
  const spawns: Array<[number, number]> = [];
  const service = new TerminalService({
    /** 送信元の識別子またはIPCのwebContentsを別々の所有Windowへ解決する。 */
    resolveOwner(sender) {
      if (
        sender === "owner" ||
        (sender as { sender?: unknown })?.sender === window.webContents
      )
        return {
          window,
          sessionId: "session-a",
          workspacePath: "C:/saved path ",
        };
      if (sender === "other")
        return {
          window: other,
          sessionId: "session-b",
          workspacePath: "C:/other",
        };
      return null;
    },
    confirmClose: confirmClose ?? (async () => confirm),
    /** 端末イベントを所有Windowの記録へ届ける。 */
    sendEvent: (owner, event) => owner.webContents.send("terminal", event),
    /** 保存済みcwdの末尾空白が維持されることを確認し、spawn寸法を記録する。 */
    spawn: async (_file, cwd, cols, rows) => {
      assert.equal(cwd, "C:/saved path ");
      spawns.push([cols, rows]);
      return pty as unknown as TerminalPty;
    },
    /** シェル探索とは独立に固定のWindows PowerShellを返す。 */
    resolveShell: async () => ({
      file: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      shellName: "PowerShell",
    }),
  });
  return {
    window,
    other,
    pty,
    service,
    spawns,
    /** 差し替えがない場合の確認を承認へ切り替える。 */
    approveClose: () => {
      confirm = true;
    },
  };
}

/** 端末の起動・操作・終了について、所有者、確認待機、障害、出力流量制御の契約を検証する。 */
describe("TerminalService", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "検出済みPowerShell 7のspawn失敗はcreateの拒否となり、5系へ再試行せず、Failed端末を確認なしで閉じられる"
  // oracle = { type = "contract", ref = "Issue #779 変更内容・受け入れ条件" }
  // fault = "起動失敗を未導入とみなして別shellへ再試行するか、生存端末として残す"
  // observable = "create拒否の理由、選択されたspawn fileと回数、live数、close結果"
  // observation_boundary = "component-behavior"
  // scope = "terminal shell selection to spawn failure"
  // lifecycle = "permanent"
  // impact = "本来の起動エラーが隠れ、利用者が期待しないshellで作業する"
  // distinction = "既存のシェル不在testは選択後のspawn拒否と再試行を観測しない。実process不要の低コストな境界test"
  // @end-test-value
  /** 検出したPowerShell 7の起動に失敗したら5系へ再試行せず、失敗端末の閉じ処理に確認も要求しない。 */
  it("reports a selected PowerShell 7 startup failure without retrying", async () => {
    const { window } = setup();
    const files: string[] = [];
    const failure = new Error("PowerShell 7 could not start");
    const service = new TerminalService({
      /** 起動要求に一つの固定Windowと保存済み作業パスを対応させる。 */
      resolveOwner: () => ({
        window,
        sessionId: "a",
        workspacePath: "C:/workspace",
      }),
      /** 失敗端末で確認が呼ばれる回帰を直ちにテスト失敗とする。 */
      confirmClose: async () => {
        assert.fail("Failed terminals do not require confirmation");
      },
      /** 起動失敗のイベントが出る場合も所有Windowのスタブへ送る。 */
      sendEvent: (owner, event) => owner.webContents.send("terminal", event),
      /** 実探索ロジックに使えるPATHの7系候補を用意する。 */
      resolveShell: () =>
        resolveTerminalShell(
          "win32",
          {
            PATH: "C:\\tools",
            SystemRoot: "C:\\Windows",
          },
          async () => {},
        ),
      /** 選ばれたシェルのパスを記録してから、起動エラーを返す。 */
      spawn: async (file) => {
        files.push(file);
        throw failure;
      },
    });
    await assert.rejects(
      service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 }),
      (error) => error === failure,
    );
    assert.deepEqual(files, ["C:\\tools\\pwsh.exe"]);
    assert.equal(service.countLive(window), 0);
    assert.equal(await service.close("owner", TERMINAL_ID), true);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Window終了の確認対象はそのownerの起動中・実行中・判別不能の端末だけで、入力待ちと終了済みは含めない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "生存端末を一律集計して入力待ちでも警告するか、他Windowの端末を集計するか、起動中の端末を見落とす"
  // observable = "spawn前後・activity変化・自然終了前後のowner別確認対象数と生存数"
  // observation_boundary = "component-behavior"
  // scope = "Terminal Session Window close confirmation policy"
  // lifecycle = "permanent"
  // impact = "Session Window終了で不要な確認が続く、または作業が確認なしで終了する"
  // distinction = "個別closeのtestは複数owner向けWindow集計を通らず、型検査でもactivity別集計を保証できない"
  // @end-test-value
  /** 起動中・実行中・不明の端末だけを所有Windowの確認対象として数え、入力待ちと自然終了は除外する。 */
  it("counts only the owning Window's terminals requiring confirmation", async () => {
    const { service, pty, window, other } = setup();
    const creating = service.create("owner", {
      terminalId: TERMINAL_ID,
      cols: 80,
      rows: 24,
    });
    assert.equal(service.countRequiringCloseConfirmation(window), 1);
    assert.equal(service.countRequiringCloseConfirmation(other), 0);
    await creating;
    for (const activity of ["idle", "busy", "unknown"] as const) {
      pty.activity = activity;
      assert.equal(service.countLive(window), 1);
      assert.equal(
        service.countRequiringCloseConfirmation(window),
        activity === "idle" ? 0 : 1,
      );
      assert.equal(service.countRequiringCloseConfirmation(other), 0);
    }
    pty.exit({ exitCode: 0 });
    assert.equal(service.countRequiringCloseConfirmation(window), 0);
    assert.equal(service.countLive(window), 0);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "入力待ちと確認できたPTYだけ確認を省略し、実行中・判別不能では取消によって保持する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "シェル生存だけで全端末へ警告するか、判別不能を安全とみなして終了する"
  // observable = "close戻り値、確認回数、PTY kill件数、live数"
  // observation_boundary = "component-behavior"
  // scope = "Terminal close activity policy"
  // lifecycle = "permanent"
  // impact = "不要な警告の常態化または利用者の実行中作業の消失"
  // distinction = "型検査は状態別の確認判断を保証せず、3状態の小さな実行で分岐を直接検証する"
  // @end-test-value
  /** idleと判定できるPTYだけ確認を省き、稼働中・不明の場合には確認の取消で端末を残す。 */
  it("only skips confirmation for a known idle shell", async () => {
    for (const activity of ["idle", "busy", "unknown"] as const) {
      let confirmations = 0;
      const { service, pty, window } = setup(async () => {
        confirmations++;
        return false;
      });
      await service.create("owner", {
        terminalId: TERMINAL_ID,
        cols: 80,
        rows: 24,
      });
      pty.activity = activity;
      const idle = activity === "idle";
      assert.equal(await service.close("owner", TERMINAL_ID), idle);
      assert.equal(confirmations, idle ? 0 : 1);
      assert.equal(pty.kills, idle ? 1 : 0);
      assert.equal(service.countLive(window), idle ? 0 : 1);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "同じ端末の非同期確認を共有し、確認待ちでもPTYイベントを配送して取消後も入力できる"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "確認中にイベントを保留するか、重複closeで別の確認を開くか、取消でPTYを停止する"
  // observable = "確認回数、未解決close中のdata event、取消戻り値、PTY入力とkill件数"
  // observation_boundary = "component-behavior"
  // scope = "Terminal asynchronous close cancellation"
  // lifecycle = "permanent"
  // impact = "終了確認中に端末出力が止まるか、取消しても作業を失う"
  // distinction = "実ダイアログの応答性は実機で別途確認し、この低コストtestはserviceの保留と取消を決定論的に検証する"
  // @end-test-value
  /** 同じ端末の複数のcloseは確認を共有し、確認待ちの出力と取消後の入力を止めない。 */
  it("shares a pending confirmation while continuing terminal events and preserves cancellation", async () => {
    let answer!: (close: boolean) => void;
    let confirmations = 0;
    const { service, pty, window } = setup(() => {
      confirmations++;
      return new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    });
    await service.create("owner", {
      terminalId: TERMINAL_ID,
      cols: 80,
      rows: 24,
    });
    const first = service.close("owner", TERMINAL_ID);
    const second = service.close("owner", TERMINAL_ID);
    pty.data("while confirming");
    assert.deepEqual(window.events, [
      { type: "data", terminalId: TERMINAL_ID, data: "while confirming" },
    ]);
    assert.equal(confirmations, 1);
    assert.equal(pty.kills, 0);
    answer(false);
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    service.write("owner", TERMINAL_ID, "still usable");
    assert.deepEqual(pty.writes, ["still usable"]);
    assert.equal(service.countLive(window), 1);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "確認中に解放された端末の遅延承認は同じIDで再作成された端末を終了しない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "確認完了時に古いentryではなくIDだけで現端末をkillする"
  // observable = "解放と遅延承認前後のkill件数、再作成後のlive数と入力"
  // observation_boundary = "component-behavior"
  // scope = "Terminal close identity race"
  // lifecycle = "permanent"
  // impact = "別の新しい端末の作業を誤って終了する"
  // distinction = "通常の取消testと型検査はawaitを跨ぐ端末identityを保証しない"
  // @end-test-value
  /** 確認中に解放した端末の遅延承認で、同じIDの作り直した端末を終了しない。 */
  it("does not release a replacement terminal after an old confirmation resolves", async () => {
    let answer!: (close: boolean) => void;
    const { service, pty, window } = setup(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    await service.create("owner", {
      terminalId: TERMINAL_ID,
      cols: 80,
      rows: 24,
    });
    const closing = service.close("owner", TERMINAL_ID);
    service.release("owner", TERMINAL_ID);
    assert.equal(pty.kills, 1);
    await service.create("owner", {
      terminalId: TERMINAL_ID,
      cols: 80,
      rows: 24,
    });
    answer(true);
    assert.equal(await closing, true);
    assert.equal(pty.kills, 1);
    assert.equal(service.countLive(window), 1);
    service.write("owner", TERMINAL_ID, "replacement");
    assert.deepEqual(pty.writes, ["replacement"]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "非同期確認中の自然終了は終了結果を配送し、承認時に終了済みPTYを再killしない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "await前のPTYを保持して自然終了後にもkillするかexit eventを配送しない"
  // observable = "確認中のexit event、close戻り値とPTY kill件数"
  // observation_boundary = "component-behavior"
  // scope = "Terminal close natural exit race"
  // lifecycle = "permanent"
  // @end-test-value
  /** 確認の待機中にも自然終了イベントを送り、その後の承認では終了済みPTYを再killしない。 */
  it("handles natural exit while a confirmation is pending", async () => {
    let answer!: (close: boolean) => void;
    const { service, pty, window } = setup(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    await service.create("owner", {
      terminalId: TERMINAL_ID,
      cols: 80,
      rows: 24,
    });
    const closing = service.close("owner", TERMINAL_ID);
    pty.exit({ exitCode: 0 });
    assert.deepEqual(window.events, [
      { type: "exit", terminalId: TERMINAL_ID, exitCode: 0 },
    ]);
    answer(true);
    assert.equal(await closing, true);
    assert.equal(pty.kills, 0);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "通常fitの大きな寸法はcreateとresizeでPTYへ渡り、native整数範囲外の寸法は生存PTYを保持して拒否する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "500列・300行で正常なfitを拒否するか、不正寸法をPTYへ渡す"
  // observable = "spawn寸法、PTY resize列、拒否後のlive数と入力"
  // observation_boundary = "component-behavior"
  // scope = "terminal-service geometry"
  // lifecycle = "permanent"
  // @end-test-value
  /** 大きい正常寸法はspawn・resizeへ渡し、範囲外の数値は操作だけ拒否して既存PTYを残す。 */
  it("accepts large fitted dimensions and rejects invalid native coordinates without ending the PTY", async () => {
    const { service, pty, window, spawns } = setup();
    await service.create("owner", {
      terminalId: TERMINAL_ID,
      cols: 625,
      rows: 400,
    });
    assert.deepEqual(spawns, [[625, 400]]);
    service.resize("owner", TERMINAL_ID, 1_000, 350);
    service.resize("owner", TERMINAL_ID, 32_767, 1);
    for (const [cols, rows] of [
      [0, 24],
      [80, -1],
      [80.5, 24],
      [80, NaN],
      [Infinity, 24],
      [32_768, 24],
      [80, 32_768],
    ]) {
      assert.throws(
        () => service.resize("owner", TERMINAL_ID, cols, rows),
        /Terminal size is invalid/,
      );
    }
    assert.deepEqual(pty.resizes, [
      [1_000, 350],
      [32_767, 1],
    ]);
    assert.equal(service.countLive(window), 1);
    service.write("owner", TERMINAL_ID, "still running");
    assert.deepEqual(pty.writes, ["still running"]);
    const rejected = setup();
    await assert.rejects(
      rejected.service.create("owner", {
        terminalId: TERMINAL_ID,
        cols: 32_768,
        rows: 24,
      }),
      /Terminal size is invalid/,
    );
    assert.deepEqual(rejected.spawns, []);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "IPCの操作拒否はoperation-errorで通知し生存PTYを維持し、PTY障害はerror通知とlive除外を行う"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Terminal" }
  // fault = "resize検証の拒否をPTY障害としてrendererへ通知する"
  // observable = "登録済みIPC handlerが送るevent種別、後続resizeと入力、host障害後のlive数"
  // observation_boundary = "public-boundary"
  // scope = "terminal IPC operation failure"
  // lifecycle = "permanent"
  // @end-test-value
  /** 不正なIPC操作はoperation-errorに留めて後続入力を許し、PTYホスト障害はerrorとして端末を生存数から除く。 */
  it("distinguishes rejected IPC operations from fatal PTY errors", async () => {
    const { service, pty, window } = setup();
    const listeners = new Map<
      string,
      (event: IpcMainEvent, id: string, cols: number, rows: number) => void
    >();
    registerTerminalHandlers(
      {
        /** このケースで使わない要求応答型の登録は保持しない。 */
        handle() {},
        /** 端末操作に使う一方向IPCのリスナーをチャンネル別に記録する。 */
        on(channel, listener) {
          listeners.set(channel, listener);
          return this as IpcMain;
        },
      } as Pick<IpcMain, "handle" | "on"> as IpcMain,
      service,
    );
    await service.create("owner", {
      terminalId: TERMINAL_ID,
      cols: 80,
      rows: 24,
    });
    const resize = listeners.get(WITHMATE_RESIZE_TERMINAL_CHANNEL)!;
    const event = { sender: window.webContents } as unknown as IpcMainEvent;
    resize(event, TERMINAL_ID, 0, 24);
    assert.deepEqual(window.events, [
      {
        type: "operation-error",
        terminalId: TERMINAL_ID,
        message: "Terminal size is invalid.",
      },
    ]);
    assert.equal(service.countLive(window), 1);
    resize(event, TERMINAL_ID, 625, 350);
    service.write("owner", TERMINAL_ID, "recovered");
    assert.deepEqual(pty.resizes, [[625, 350]]);
    assert.deepEqual(pty.writes, ["recovered"]);
    pty.error(new Error("host failed"));
    assert.deepEqual(window.events.at(-1), {
      type: "error",
      terminalId: TERMINAL_ID,
      message: "host failed",
    });
    assert.equal(service.countLive(window), 0);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "端末を作成したSession Window以外から入力・resize・終了を実行できない"
  // oracle = { type = "contract", ref = "Issue #740 権限・エラーの境界" }
  // fault = "terminal IDだけを照合し、IPC senderのWindow所有を照合しない"
  // observable = "他Windowからの操作の拒否と元のPTYの入力・resize・kill件数"
  // observation_boundary = "component-behavior"
  // scope = "terminal-service"
  // lifecycle = "permanent"
  // impact = "別Windowのrendererがユーザーのシェルへ入力・終了できる"
  // distinction = "型検査はIPC senderの実行時所有関係を保証しない"
  // @end-test-value
  /** 他のSession Windowからは入力、resize、close、releaseを実行できず、所有者のPTYに副作用がない。 */
  it("binds every operation to the sender's Session Window", async () => {
    const { service, pty } = setup();
    await service.create("owner", {
      terminalId: TERMINAL_ID,
      cols: 80,
      rows: 24,
    });
    assert.throws(() => service.write("other", TERMINAL_ID, "bad"));
    assert.throws(() => service.resize("other", TERMINAL_ID, 100, 30));
    await assert.rejects(service.close("other", TERMINAL_ID));
    assert.throws(() => service.release("other", TERMINAL_ID));
    assert.deepEqual(pty.writes, []);
    assert.deepEqual(pty.resizes, []);
    assert.equal(pty.kills, 0);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "生存中PTYのClose取消は保持し、renderer破棄は確認なしでPTYを終了する"
  // oracle = { type = "contract", ref = "Issue #740 生存期間と終了" }
  // fault = "確認取消時にPTYをkillするかrenderer破棄後にPTYを残す"
  // observable = "Close戻り値とPTY kill件数、残る端末数"
  // observation_boundary = "component-behavior"
  // scope = "terminal-service"
  // lifecycle = "permanent"
  // impact = "利用者作業の意図しない停止または孤立したシェルの存続"
  // distinction = "型検査と通常のWindow close testはPTY所有物の解放を観測しない"
  // @end-test-value
  /** 生存中PTYのcloseを取り消せば保持されるが、レンダラーの破棄では確認を介さず解放される。 */
  it("keeps a cancelled close and releases the PTY when its renderer is destroyed", async () => {
    const { service, pty, window } = setup();
    await service.create("owner", {
      terminalId: TERMINAL_ID,
      cols: 80,
      rows: 24,
    });
    assert.equal(await service.close("owner", TERMINAL_ID), false);
    assert.equal(service.countLive(window), 1);
    assert.equal(pty.kills, 0);
    window.destroyed = true;
    window.emit("destroyed");
    assert.equal(service.countLive(window), 0);
    assert.equal(pty.kills, 1);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "現行watermark設定では未処理出力100000文字未満で停止せず、到達時に一度だけ停止し、ackで20000文字以下になるまで再開しない"
  // oracle = { type = "contract", ref = "Issue #740 再描画・出力・リサイズ（流量制御要求）; src-electron/terminal/terminal-service.ts OUTPUT_HIGH_WATER / OUTPUT_LOW_WATER（現行watermark設定）" }
  // fault = "任意出力でpauseするか任意ackでresumeするか、上下限の等号を誤るか、停止・再開を重複する"
  // observable = "未処理量99999・100000・100001でのpause件数と20001・20000・19999でのresume件数、全data event"
  // observation_boundary = "component-behavior"
  // scope = "terminal-service"
  // lifecycle = "permanent"
  // impact = "大量出力でmainのメモリ・応答性が悪化するか端末が詰まる"
  // distinction = "buildと型検査は実際の出力流量制御を確認しない"
  // @end-test-value
  /** 出力が上限へ達したとき1回だけ停止し、確認済み出力により下限まで減ったときだけ再開する。 */
  it("pauses and resumes only at the output watermarks", async () => {
    const { service, pty, window } = setup();
    await service.create("owner", {
      terminalId: TERMINAL_ID,
      cols: 80,
      rows: 24,
    });
    const initialOutput = "x".repeat(99_999);
    pty.data(initialOutput);
    assert.equal(pty.pauses, 0);
    pty.data("y");
    assert.equal(pty.pauses, 1);
    pty.data("z");
    assert.equal(pty.pauses, 1);
    assert.equal(pty.resumes, 0);
    assert.deepEqual(window.events, [
      { type: "data", terminalId: TERMINAL_ID, data: initialOutput },
      { type: "data", terminalId: TERMINAL_ID, data: "y" },
      { type: "data", terminalId: TERMINAL_ID, data: "z" },
    ]);
    service.acknowledge("owner", TERMINAL_ID, 80_000);
    assert.equal(pty.resumes, 0);
    service.acknowledge("owner", TERMINAL_ID, 1);
    assert.equal(pty.resumes, 1);
    service.acknowledge("owner", TERMINAL_ID, 1);
    assert.equal(pty.resumes, 1);
    const nextOutput = "w".repeat(80_002);
    pty.data(nextOutput);
    assert.equal(pty.pauses, 2);
    assert.equal(pty.resumes, 1);
    assert.deepEqual(window.events.at(-1), {
      type: "data",
      terminalId: TERMINAL_ID,
      data: nextOutput,
    });
    service.acknowledge("owner", TERMINAL_ID, 80_002);
    assert.equal(pty.resumes, 2);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "起動中タブを解放した後でspawnが完了してもPTYを直ちに終了する"
  // oracle = { type = "contract", ref = "Issue #740 生存期間と終了" }
  // fault = "非同期spawnの完了後に解放済みのTerminalを実行中として残す"
  // observable = "遅延spawnしたPTYのkill件数とWindowの生存端末数"
  // observation_boundary = "component-behavior"
  // scope = "terminal-service"
  // lifecycle = "permanent"
  // impact = "タブを閉じた後に孤立したシェルが残る"
  // distinction = "通常のclose testではcreate完了前の競合を再現しない"
  // @end-test-value
  /** 起動待ちのタブを解放した後に届いたPTYをすぐ終了し、作成要求を取消として扱う。 */
  it("kills a PTY spawned after its starting tab is released", async () => {
    const { window, pty } = setup();
    let finishSpawn!: (value: TerminalPty) => void;
    const service = new TerminalService({
      /** ownerの送信元だけを遅延起動の対象Windowへ対応させる。 */
      resolveOwner: (sender) =>
        sender === "owner"
          ? { window, sessionId: "a", workspacePath: "C:/saved path " }
          : null,
      /** 確認判断を妨げないよう常に承認を返す。 */
      confirmClose: async () => true,
      /** 遅延起動中の通知先をWindowの記録に固定する。 */
      sendEvent: (owner, event) => owner.webContents.send("terminal", event),
      /** PTYの起動待ちに到達させるため、解決済みシェルを返す。 */
      resolveShell: async () => ({
        file: "C:/Windows/powershell.exe",
        shellName: "PowerShell",
      }),
      /** タブを解放するまでPTYの生成応答を保留する。 */
      spawn: () =>
        new Promise<TerminalPty>((resolve) => {
          finishSpawn = resolve;
        }),
    });
    const creating = service.create("owner", {
      terminalId: TERMINAL_ID,
      cols: 80,
      rows: 24,
    });
    await Promise.resolve();
    service.release("owner", TERMINAL_ID);
    finishSpawn(pty as unknown as TerminalPty);
    await assert.rejects(creating, /cancelled/);
    assert.equal(pty.kills, 1);
    assert.equal(service.countLive(window), 0);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "シェル解決失敗後のFailedタブは追加確認なしで閉じられる"
  // oracle = { type = "contract", ref = "Issue #740 タブバーはTerminal領域の内部" }
  // fault = "create失敗で内部owner記録を消し、Failedタブのcloseが拒否される"
  // observable = "シェル解決によるcreate失敗と後続closeの戻り値"
  // observation_boundary = "component-behavior"
  // scope = "terminal-service"
  // lifecycle = "permanent"
  // impact = "操作不能なFailedタブがWindow内に残る"
  // distinction = "型検査は失敗後の端末状態遷移を保証しない"
  // @end-test-value
  /** シェルが見つからず作成に失敗したタブは、追加確認なしに閉じられる。 */
  it("lets a failed tab close without confirmation", async () => {
    const { window } = setup();
    const service = new TerminalService({
      /** 作成と後続closeで同じ固定Windowの所有者を解決する。 */
      resolveOwner: (sender) =>
        sender === "owner"
          ? { window, sessionId: "a", workspacePath: "C:/saved path " }
          : null,
      /** シェル解決に失敗した後に確認を求める動作を検出する。 */
      confirmClose: () => {
        throw new Error("must not confirm");
      },
      /** 端末サービスのイベントを固定Windowのスタブへ届ける。 */
      sendEvent: (owner, event) => owner.webContents.send("terminal", event),
      /** シェルが見つからずPTY起動に進めない場合を再現する。 */
      resolveShell: async () => {
        throw new Error("shell missing");
      },
      /** シェル解決失敗後にもspawnした場合にエラーにする。 */
      spawn: async () => {
        throw new Error("must not spawn");
      },
    });
    await assert.rejects(
      service.create("owner", { terminalId: TERMINAL_ID, cols: 80, rows: 24 }),
      /shell missing/,
    );
    assert.equal(await service.close("owner", TERMINAL_ID), true);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "PTYの異常通知を該当terminal ID付きerror eventへ変換し、生存端末数から除外する"
  // oracle = { type = "contract", ref = "Issue #740 タブバーはTerminal領域の内部" }
  // fault = "端末hostの異常をExitedとして扱うかFailed通知なしで放置する"
  // observable = "owner Windowへ送られたerror eventと端末のlive数"
  // observation_boundary = "component-behavior"
  // scope = "terminal-service"
  // lifecycle = "permanent"
  // impact = "起動済み端末が操作不能でも利用者に失敗理由が表示されない"
  // distinction = "型検査や通常の自然終了testはhost異常経路を確認しない"
  // @end-test-value
  /** PTY障害を端末ID付きerrorとして所有Windowへ通知し、失敗端末を生存数から除く。 */
  it("reports an isolated host failure as Failed", async () => {
    const { service, pty, window } = setup();
    await service.create("owner", {
      terminalId: TERMINAL_ID,
      cols: 80,
      rows: 24,
    });
    pty.error(new Error("Terminal host exited unexpectedly (code 1)."));
    assert.deepEqual(window.events, [
      {
        type: "error",
        terminalId: TERMINAL_ID,
        message: "Terminal host exited unexpectedly (code 1).",
      },
    ]);
    assert.equal(service.countLive(window), 0);
    assert.equal(await service.close("owner", TERMINAL_ID), true);
  });
});
