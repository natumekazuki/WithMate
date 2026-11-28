import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  openLocalPathWithDefaultApp,
  openResolvedDirectoryInFileManager,
  revealLocalPathInFileManager,
  resolveForwardSlashUncPathCandidate,
  resolveMarkdownLinkCopyTarget,
  resolveOpenPathTarget,
  resolveProtocolRelativeExternalFallback,
  resolveProtocolRelativeExternalFallbackAfterLocalOpen,
} from "../../src-electron/files/open-path.js";

/** 汎用のパス操作が参照するファイル・ディレクトリの区別だけを再現する。 */
function localPathStat(kind: "file" | "directory") {
  return {
    /** 指定したファイル種別がディレクトリかを返す。 */
    isDirectory: () => kind === "directory",
    /** 指定したファイル種別が通常ファイルかを返す。 */
    isFile: () => kind === "file",
  };
}

// @test-value v2
// kind = "contract"
// claim = "Windows/Linuxの解決済みdirectoryは特殊文字を再解釈せずsender再確認後に同じpathでOSへ渡し、OS失敗を成功にしない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Link Handling" }
// fault = "canonical pathのfragmentやpercentを再parseする、認可前にopenする、またはshell errorを成功にする"
// observable = "stat・realpath・sender確認・openの引数と順序およびtyped結果"
// observation_boundary = "public-boundary"
// scope = "openResolvedDirectoryInFileManager"
// lifecycle = "permanent"
// distinction = "汎用path openと異なりcanonical directory専用のOS副作用境界を副作用なしのstubで確認する"
// @end-test-value
/** Windows と Linux では、解決済みのディレクトリ名に含まれる特殊文字を変更せず、送信元を確認した後に既定アプリに渡し、その失敗も返すことを確かめる。 */
it("directory linkはcanonical pathを再解釈せず認可後に開きOS失敗を返す", async () => {
  const targetPath =
    process.platform === "win32"
      ? "C:\\別 Worktree #1 %25"
      : "/tmp/別 Worktree #1 %25:12";
  for (const [platform, shellError] of [
    ["win32", ""],
    ["win32", "The file manager could not be started."],
    ["linux", ""],
    ["linux", "The file manager could not be started."],
  ] as const) {
    const calls: string[] = [];
    const result = await openResolvedDirectoryInFileManager(targetPath, {
      platform,
      /** 実ファイルシステムには触れず、検査対象パスを記録してディレクトリと判定する。 */
      async statTarget(value) {
        calls.push(`stat:${value}`);
        return localPathStat("directory");
      },
      /** 正規化済みのパスをそのまま返し、実パス照会の順序を記録する。 */
      async realpathTarget(value) {
        calls.push(`realpath:${value}`);
        return value;
      },
      /** ウィンドウの送信元が、OS 呼び出し前に検証された位置を記録する。 */
      async assertSender() {
        calls.push("sender");
      },
      /** 既定アプリに渡すパスを記録し、試験ごとに設定した成功またはエラーを返す。 */
      async openWithDefaultApp(value) {
        calls.push(`open:${value}`);
        return shellError;
      },
      /** Windows と Linux が macOS 専用コマンドの経路に入ったら失敗させる。 */
      async execFile() {
        assert.fail(
          "Windows/Linux must not invoke the macOS file manager command.",
        );
      },
    });
    assert.deepEqual(calls, [
      `stat:${targetPath}`,
      `realpath:${targetPath}`,
      "sender",
      `open:${targetPath}`,
    ]);
    assert.deepEqual(
      result,
      shellError
        ? {
            status: "failed",
            targetType: "local-path",
            target: targetPath,
            message: shellError,
          }
        : { status: "opened", targetType: "local-path", target: targetPath },
    );
  }
});

// @test-value v2
// kind = "security"
// claim = "macOSのdirectory linkはbundle/packageを含めFinderの選択表示だけを行い、command失敗で既定openへfallbackしない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Link Handling" }
// fault = "directoryを既定openへ渡してappを実行する、suffixだけで例外化する、shell文字列へpathを埋め込む、またはcommand失敗を成功にする"
// observable = "sender再確認後に/usr/bin/openの-Rとcanonical pathを別引数で渡し、command成功/失敗に対応するtyped結果を返す"
// observation_boundary = "public-boundary"
// scope = "openResolvedDirectoryInFileManager macOS boundary"
// lifecycle = "permanent"
// impact = "閲覧のみを許可するroot外directory linkからのアプリ実行を防ぎ、失敗を操作元へ返す"
// distinction = "実行可能なbundleもstatではdirectoryになるため型検査や汎用open testでは検出できない。OS command stubだけで実行を伴わず検査する"
// @end-test-value
/** macOS ではバンドルを含むディレクトリを Finder で選択表示するだけで、コマンドの失敗時も既定アプリ起動に切り替えないことを確かめる。 */
it("macOSのdirectory linkはFinderで選択表示しbundleを起動せずcommand失敗を返す", async () => {
  for (const [name, commandError] of [
    ["別 Worktree #1 %25:12", ""],
    ["Example.app", ""],
    ["Example.bundle", ""],
    ["NoSuffix '$(`command`)", ""],
    ["Example.app", "Finder could not be started."],
  ]) {
    const targetPath = `/tmp/${name}`;
    const calls: unknown[] = [];
    const result = await openResolvedDirectoryInFileManager(targetPath, {
      platform: "darwin",
      /** macOS で操作対象として検査したパスを記録して、ディレクトリであると返す。 */
      async statTarget(value) {
        calls.push(["stat", value]);
        return localPathStat("directory");
      },
      /** 解決済みのパスを変えず、実パス検証の呼び出しを記録する。 */
      async realpathTarget(value) {
        calls.push(["realpath", value]);
        return value;
      },
      /** Finder へ渡す前の送信元の再確認を記録する。 */
      async assertSender() {
        calls.push(["sender"]);
      },
      /** バンドルの起動につながりうる既定アプリ経路の呼び出しがあれば記録する。 */
      async openWithDefaultApp(value) {
        calls.push(["default-open", value]);
        return "";
      },
      /** 実コマンドを起動せず実行ファイルと引数を記録し、設定されていれば Finder の起動失敗を再現する。 */
      async execFile(file, args) {
        calls.push(["execFile", file, args]);
        if (commandError) throw new Error(commandError);
      },
    });
    assert.deepEqual(calls, [
      ["stat", targetPath],
      ["realpath", targetPath],
      ["sender"],
      ["execFile", "/usr/bin/open", ["-R", targetPath]],
    ]);
    assert.deepEqual(
      result,
      commandError
        ? {
            status: "failed",
            targetType: "local-path",
            target: targetPath,
            message: `The directory could not be shown in Finder: ${commandError}`,
          }
        : { status: "opened", targetType: "local-path", target: targetPath },
    );
  }
});

// @test-value v2
// kind = "security"
// claim = "directory専用openは不正path、消失、アクセス拒否、file/specialへの差替、canonical path変更、sender失効でOSを呼ばない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Link Handling" }
// fault = "directory検証失敗でOSへfallbackするか、stale senderからshell openを開始する"
// observable = "失敗結果、検査対象pathと全platformのOS操作回数0"
// observation_boundary = "public-boundary"
// scope = "openResolvedDirectoryInFileManager rejection boundary"
// lifecycle = "permanent"
// impact = "明示directory操作がfile実行や別target・別WindowによるOS操作へ変わることを防ぐ"
// distinction = "directory-only制約と非同期中の差替/失効は型検査やgeneric path testでは検証できず、短いstub testで保護する"
// @end-test-value
/** 各 OS で、不適切なパス、消失、権限エラー、対象の差し替え、送信元の失効を検出した場合に OS 操作へ進まないことを確かめる。 */
it("directory linkの不正・消失・差替・sender失効はOSで開かない", async () => {
  const canonicalPath =
    process.platform === "win32" ? "C:\\outside:12" : "/tmp/outside:12";
  for (const platform of ["win32", "linux", "darwin"] as const) {
    for (const scenario of [
      "relative",
      "control",
      "missing",
      "denied",
      "file",
      "special",
      "retargeted",
      "sender",
    ]) {
      const targetPath =
        scenario === "relative"
          ? "relative"
          : scenario === "control"
            ? `${canonicalPath}\0`
            : canonicalPath;
      const inspected: string[] = [];
      let openCalls = 0;
      const result = await openResolvedDirectoryInFileManager(targetPath, {
        platform,
        /** 検査したパスを記録し、ケースに応じて種別を切り替えるか、消失・権限拒否を再現する。 */
        async statTarget(value) {
          inspected.push(value);
          if (scenario === "missing" || scenario === "denied") {
            throw Object.assign(new Error(scenario), {
              code: scenario === "missing" ? "ENOENT" : "EACCES",
            });
          }
          return {
            /** ファイル・特殊な実体に差し替えられたケースだけはディレクトリと判定しない。 */
            isDirectory: () => scenario !== "file" && scenario !== "special",
            /** ファイルに差し替えられたケースでのみ通常ファイルと判定する。 */
            isFile: () => scenario === "file",
          };
        },
        /** 解決先が変わったケースでだけ、渡されたパスと異なる実パスを返す。 */
        async realpathTarget(value) {
          return scenario === "retargeted" ? `${value}-other` : value;
        },
        /** Preview の送信元認可が失効したケースでエラーを返す。 */
        async assertSender() {
          if (scenario === "sender")
            throw new Error("The Preview resource changed.");
        },
        /** 拒否ケースで既定アプリが誤って呼ばれた回数を数える。 */
        async openWithDefaultApp() {
          openCalls += 1;
          return "";
        },
        /** 拒否ケースで Finder コマンドが誤って呼ばれた回数を数える。 */
        async execFile() {
          openCalls += 1;
        },
      });
      assert.equal(
        result.status,
        scenario === "missing" ? "not-found" : "failed",
        scenario,
      );
      assert.ok(result.message, scenario);
      assert.equal(openCalls, 0, scenario);
      assert.deepEqual(
        inspected,
        scenario === "relative" || scenario === "control" ? [] : [targetPath],
        scenario,
      );
    }
  }
});

/** リンクを外部 URL とローカルパスに分類し、ローカルに限って基準ディレクトリやファイル URL の変換を適用する契約を検証する。 */
describe("resolveOpenPathTarget", () => {
  /** URL の query・fragment・percent encoding を変えずに外部操作へ渡す。 */
  it("http url は query と fragment を保った外部 URL として扱う", () => {
    const target =
      "https://example.com/docs?q=a%2Fb&name=%E8%A8%AD%E8%A8%88#part%202";
    assert.deepEqual(resolveOpenPathTarget(target), {
      type: "external-url",
      target,
    });
  });

  /** スキーム省略型の Web リンクに HTTPS を補い、外部 URL として分類することを確かめる。 */
  it("protocol-relative URL は https の外部 URL として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("//example.com/docs"), {
      type: "external-url",
      target: "https://example.com/docs",
    });
  });

  /** 階層を含む外部 URL でもクエリ・アンカー・エンコードを保ったまま HTTPS を補うことを確かめる。 */
  it("複数階層の protocol-relative URL も query と fragment を保った外部 URL として扱う", () => {
    assert.deepEqual(
      resolveOpenPathTarget("//example.com/docs/page?x=a%20b#top"),
      {
        type: "external-url",
        target: "https://example.com/docs/page?x=a%20b#top",
      },
    );
  });

  /** 拡張子つきのパスでも Web ホストを UNC の探索候補にせず、外部 URL に分類することを確かめる。 */
  it("拡張子付きの protocol-relative URL も UNC 候補にしない", () => {
    assert.deepEqual(resolveOpenPathTarget("//example.com/docs/page.html"), {
      type: "external-url",
      target: "https://example.com/docs/page.html",
    });
    assert.equal(
      resolveForwardSlashUncPathCandidate("//example.com/docs/page.html"),
      null,
    );
  });

  /** 先頭の空白を除いた Web ホストでも、UNC ではなく HTTPS の外部 URL として扱うことを確かめる。 */
  it("先頭空白付きの protocol-relative URL も UNC 候補にしない", () => {
    assert.deepEqual(resolveOpenPathTarget(" //example.com/docs/page.html"), {
      type: "external-url",
      target: "https://example.com/docs/page.html",
    });
    assert.equal(
      resolveForwardSlashUncPathCandidate(" //example.com/docs/page.html"),
      null,
    );
  });

  /** 複数のパス階層やクエリがあっても、ドットつきホストのリンクを UNC 候補として返さないことを確かめる。 */
  it("複数階層の protocol-relative URL は UNC 候補にしない", () => {
    assert.equal(
      resolveForwardSlashUncPathCandidate(
        "//example.com/docs/page?x=a%20b#top",
      ),
      null,
    );
  });

  /** 明示ポートつきの localhost を外部 HTTPS URL にし、同じ文字列を UNC 候補にしないことを確かめる。 */
  it("ポート付き protocol-relative URL は external URL として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("//localhost:5173/docs"), {
      type: "external-url",
      target: "https://localhost:5173/docs",
    });
    assert.equal(
      resolveForwardSlashUncPathCandidate("//localhost:5173/docs"),
      null,
    );
  });

  /** ポートなしの localhost でも外部 URL として認識し、UNC 判定から外すことを確かめる。 */
  it("localhost の protocol-relative URL は port なしでも external URL として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("//localhost/docs"), {
      type: "external-url",
      target: "https://localhost/docs",
    });
    assert.equal(resolveForwardSlashUncPathCandidate("//localhost/docs"), null);
  });

  /** 単一ラベルのホストでもパスが一階層なら外部 HTTPS URL とし、UNC 候補から外すことを確かめる。 */
  it("single-label host の protocol-relative URL は 1 segment path なら external URL として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("//intranet/app"), {
      type: "external-url",
      target: "https://intranet/app",
    });
    assert.equal(resolveForwardSlashUncPathCandidate("//intranet/app"), null);
  });

  /** 前方スラッシュ表記の共有パスを、入力表記を保ったローカル操作対象にすることを確かめる。 */
  it("forward-slash UNC path は local path として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("//server/share/file.txt"), {
      type: "local-path",
      targetPath: "//server/share/file.txt",
    });
  });

  /** 前方スラッシュの UNC 候補に対し、ローカルで見つからない場合の HTTPS 候補を得られることを確かめる。 */
  it("forward-slash UNC path は local open 失敗時の external fallback も持つ", () => {
    assert.equal(
      resolveProtocolRelativeExternalFallback("//server/share/file.txt"),
      "https://server/share/file.txt",
    );
  });

  /** 単一ラベルのホストでパスが複数階層なら UNC を優先し、外部 HTTPS 候補も別に解決できることを確かめる。 */
  it("single-label host の複数 segment protocol-relative URL は local open 失敗時の external fallback を持つ", () => {
    assert.deepEqual(resolveOpenPathTarget("//intranet/app/page"), {
      type: "local-path",
      targetPath: "//intranet/app/page",
    });
    assert.equal(
      resolveForwardSlashUncPathCandidate("//intranet/app/page"),
      "//intranet/app/page",
    );
    assert.equal(
      resolveProtocolRelativeExternalFallback("//intranet/app/page"),
      "https://intranet/app/page",
    );
  });

  /** 共有パス風の階層でも完全修飾ホストは外部 URL となり、UNC の検査へ渡さないことを確かめる。 */
  it("FQDN の protocol-relative URL は UNC 候補にしない", () => {
    assert.deepEqual(
      resolveOpenPathTarget("//fileserver.example.com/share/file.txt"),
      {
        type: "external-url",
        target: "https://fileserver.example.com/share/file.txt",
      },
    );
    assert.equal(
      resolveForwardSlashUncPathCandidate(
        "//fileserver.example.com/share/file.txt",
      ),
      null,
    );
  });

  /** IP アドレスのホストは外部 HTTPS を補い、UNC 候補として返さないことを確かめる。 */
  it("IP address の protocol-relative URL は UNC 候補にしない", () => {
    assert.deepEqual(resolveOpenPathTarget("//192.168.1.10/share/file.txt"), {
      type: "external-url",
      target: "https://192.168.1.10/share/file.txt",
    });
    assert.equal(
      resolveForwardSlashUncPathCandidate("//192.168.1.10/share/file.txt"),
      null,
    );
  });

  /** メール作成リンクをローカルパスへ変換せず、外部 URL として返すことを確かめる。 */
  it("mailto URL は外部 URL として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("mailto:alice@example.test"), {
      type: "external-url",
      target: "mailto:alice@example.test",
    });
  });

  /** メールのクエリに含まれるエンコード済みの値をデコードせず、外部リンクをそのまま返すことを確かめる。 */
  it("encoded mailto URL は decode せず外部 URL として扱う", () => {
    assert.deepEqual(
      resolveOpenPathTarget(
        "mailto:alice@example.test?subject=hello%20world%0D%0A",
      ),
      {
        type: "external-url",
        target: "mailto:alice@example.test?subject=hello%20world%0D%0A",
      },
    );
  });

  /** 相対パスから行アンカーを外し、指定した作業ディレクトリを起点とする Windows パスにすることを確かめる。 */
  it("workspace 相対 path は baseDirectory 基準で解決する", () => {
    assert.deepEqual(
      resolveOpenPathTarget("src/App.tsx#L10", {
        baseDirectory: "C:/workspace/project",
      }),
      {
        type: "local-path",
        targetPath: "C:\\workspace\\project\\src\\App.tsx",
      },
    );
  });

  /** アンカーを先に除き、デコードしたファイル名に現れるリテラルの記号を残すことを確かめる。 */
  it("encoded workspace 相対 path は fragment を外してから decode する", () => {
    assert.deepEqual(
      resolveOpenPathTarget("docs/a%23b%3Fv.txt#section", {
        baseDirectory: "C:/workspace/project",
      }),
      {
        type: "local-path",
        targetPath: "C:\\workspace\\project\\docs\\a#b?v.txt",
      },
    );
  });

  /** 相対パスを結合する際、エンコードされた空白と日本語を実ファイル名に戻すことを確かめる。 */
  it("encoded workspace 相対 path の空白と非 ASCII を decode する", () => {
    assert.deepEqual(
      resolveOpenPathTarget("docs/my%20file-%E4%BB%95%E6%A7%98.md", {
        baseDirectory: "C:/workspace/project",
      }),
      {
        type: "local-path",
        targetPath: "C:\\workspace\\project\\docs\\my file-仕様.md",
      },
    );
  });

  /** ドライブ付きの入力でエンコードされている区切りを Windows の逆斜線に戻し、ローカルの絶対パスとすることを確かめる。 */
  it("percent-encoded backslash 形式の Windows absolute path を local path に戻す", () => {
    assert.deepEqual(
      resolveOpenPathTarget("C:%5Cworkspace%5Csession-files%5Creport.txt"),
      {
        type: "local-path",
        targetPath: "C:\\workspace\\session-files\\report.txt",
      },
    );
  });

  /** ローカル絶対パスのファイル名は保持しつつ、行アンカーだけを開く対象から除くことを確かめる。 */
  it("absolute path の fragment は外して開く path にする", () => {
    assert.deepEqual(
      resolveOpenPathTarget("C:/workspace/project/src/App.tsx#L10"),
      {
        type: "local-path",
        targetPath: "C:/workspace/project/src/App.tsx",
      },
    );
  });

  /** 先頭の余分なスラッシュを取り、Windows のドライブを保つ一方、行・列の接尾辞はこの段階で落とさないことを確かめる。 */
  it("leading slash 付き Windows absolute path は drive path に正規化する", () => {
    assert.deepEqual(
      resolveOpenPathTarget("/C:/workspace/project/src/App.tsx"),
      {
        type: "local-path",
        targetPath: "C:/workspace/project/src/App.tsx",
      },
    );
    assert.deepEqual(
      resolveOpenPathTarget("/C:/workspace/project/src/App.tsx:12:4"),
      {
        type: "local-path",
        targetPath: "C:/workspace/project/src/App.tsx:12:4",
      },
    );
  });

  /** file URL をローカルの Windows パスに変換し、表示位置を指定するアンカーは含めないことを確かめる。 */
  it("file url の fragment も外して local path に変換する", () => {
    assert.deepEqual(
      resolveOpenPathTarget("file:///C:/workspace/project/docs/spec.md#intro"),
      {
        type: "local-path",
        targetPath: "C:\\workspace\\project\\docs\\spec.md",
      },
    );
  });

  /** file URL の query と fragment を外し、encoded path 自体は正確に decode する。 */
  it("file url の encoded local path は query と fragment を外してから decode する", () => {
    assert.deepEqual(
      resolveOpenPathTarget("file:///C:/workspace/docs/a%23b.txt?view=1#intro"),
      {
        type: "local-path",
        targetPath: "C:\\workspace\\docs\\a#b.txt",
      },
    );
  });

  /** ホストつき file URL を、ホスト名と共有名を含む Windows の UNC に変換することを確かめる。 */
  it("file UNC url は host を含む local UNC path に変換する", () => {
    assert.deepEqual(resolveOpenPathTarget("file://server/share/file.txt"), {
      type: "local-path",
      targetPath: "\\\\server\\share\\file.txt",
    });
  });
});

/** Markdown リンクのコピー結果を検証する。ローカルは使用可能なパスに変換し、外部 URL の表記は維持する。 */
describe("resolveMarkdownLinkCopyTarget", () => {
  /** 相対パスとエンコード済み Windows パスの両方で、フラグメントを除いて文字と区切りを復元することを確かめる。 */
  it("local linkをdecodeしてfragmentを除いたfilesystem pathにする", () => {
    assert.equal(
      resolveMarkdownLinkCopyTarget(
        "docs/my%20file-%E4%BB%95%E6%A7%98.md#intro",
      ),
      "docs/my file-仕様.md",
    );
    assert.equal(
      resolveMarkdownLinkCopyTarget(
        "C:%5Cworkspace%5Csession-files%5Creport%20%E4%BB%95%E6%A7%98.md#intro",
      ),
      "C:\\workspace\\session-files\\report 仕様.md",
    );
  });

  /** ドライブパスや共有パスの file URL・エンコード形式を、通常のファイルシステム表記でコピーできることを確かめる。 */
  it("file URLとUNCをfilesystem pathにする", () => {
    assert.equal(
      resolveMarkdownLinkCopyTarget("file:///C:/workspace/my%20file.md#intro"),
      "C:\\workspace\\my file.md",
    );
    assert.equal(
      resolveMarkdownLinkCopyTarget("file://server/share/my%20file.md#intro"),
      "\\\\server\\share\\my file.md",
    );
    assert.equal(
      resolveMarkdownLinkCopyTarget(
        "%5C%5Cserver%5Cshare%5C%E4%BB%95%E6%A7%98%20file.md#intro",
      ),
      "\\\\server\\share\\仕様 file.md",
    );
    assert.equal(
      resolveMarkdownLinkCopyTarget("file:/C:/workspace/my%20file.md#intro"),
      "C:\\workspace\\my file.md",
    );
    assert.equal(
      resolveMarkdownLinkCopyTarget("FILE:/C:/workspace/my%20file.md#intro"),
      "C:\\workspace\\my file.md",
    );
    assert.equal(
      resolveMarkdownLinkCopyTarget("file:////server/share/my%20file.md#intro"),
      "\\\\server\\share\\my file.md",
    );
  });

  /** デコードでローカルパスに制御文字が現れるケースは、コピー対象にしないことを確かめる。 */
  it("decode後のlocal pathに制御文字があれば拒否する", () => {
    for (const target of [
      "docs/report%00.txt",
      "docs/report%09.txt",
      "docs/report%0D%0Apowershell.txt",
      "docs/report%7F.txt",
      "file:/C:/workspace/report%0A.txt",
    ]) {
      assert.throws(
        () => resolveMarkdownLinkCopyTarget(target),
        /control characters/i,
      );
    }
  });

  /** 外部 URL はエンコード・クエリ・アンカーを元の表記で保ち、リテラルの制御文字を含む入力は拒否することを確かめる。 */
  it("外部URLはencodeとquery・fragmentを保つ", () => {
    assert.equal(
      resolveMarkdownLinkCopyTarget(
        "//example.test/docs/my%20file.md?raw=%2F#intro",
      ),
      "//example.test/docs/my%20file.md?raw=%2F#intro",
    );
    assert.equal(
      resolveMarkdownLinkCopyTarget(
        "https://example.test/docs/my%20file.md?raw=%2F#intro",
      ),
      "https://example.test/docs/my%20file.md?raw=%2F#intro",
    );
    assert.equal(
      resolveMarkdownLinkCopyTarget(
        "mailto:alice+docs@example.test?subject=%E4%BB%95%E6%A7%98",
      ),
      "mailto:alice+docs@example.test?subject=%E4%BB%95%E6%A7%98",
    );
    assert.equal(
      resolveMarkdownLinkCopyTarget(
        "https://example.test/report%0D%0Apowershell.exe",
      ),
      "https://example.test/report%0D%0Apowershell.exe",
    );
    assert.throws(
      () =>
        resolveMarkdownLinkCopyTarget(
          "https://example.test/report\r\npowershell.exe",
        ),
      /control characters/i,
    );
  });
});

/** 通常のローカル open で、数値接尾辞のフォールバックと存在・アクセス・OS 起動結果を区別することを検証する。 */
describe("openLocalPathWithDefaultApp", () => {
  /** 数字の接尾辞を含むファイルが実在するとき、行番号とみなして別ファイルを探索せず、そのパスを既定アプリに渡すことを確かめる。 */
  it("存在する数字suffix付き path は行番号と解釈せずそのまま開く", async () => {
    const inspected: string[] = [];
    const opened: string[] = [];
    const result = await openLocalPathWithDefaultApp("/workspace/report:12", {
      /** 数字接尾辞を含む元のパスにファイルがあるとして、照会されたパスを記録する。 */
      statTarget: async (targetPath) => {
        inspected.push(targetPath);
        return localPathStat("file");
      },
      /** 既定アプリを起動せず、渡されたパスを記録する。 */
      openWithDefaultApp: async (targetPath) => {
        opened.push(targetPath);
        return "";
      },
    });

    assert.equal(result.status, "opened");
    assert.deepEqual(inspected, ["/workspace/report:12"]);
    assert.deepEqual(opened, ["/workspace/report:12"]);
  });

  /** 行番号つきのパスが見つからなければ、接尾辞を除いた Windows ファイルを開くことを照会順と起動対象から確かめる。 */
  it("存在しない :line suffix は外した file を開く", async () => {
    const inspected: string[] = [];
    const opened: string[] = [];
    const result = await openLocalPathWithDefaultApp(
      "C:\\workspace\\notes.md:12",
      {
        /** 元の行番号つきパスを見つからないとし、接尾辞を除いた候補の照会を成功させる。 */
        statTarget: async (targetPath) => {
          inspected.push(targetPath);
          if (targetPath.endsWith(":12")) {
            throw Object.assign(new Error("ENOENT: missing"), {
              code: "ENOENT",
            });
          }
          return localPathStat("file");
        },
        /** 既定アプリの起動対象だけを捕捉し、成功を返す。 */
        openWithDefaultApp: async (targetPath) => {
          opened.push(targetPath);
          return "";
        },
      },
    );

    assert.equal(result.status, "opened");
    assert.deepEqual(inspected, [
      "C:\\workspace\\notes.md:12",
      "C:\\workspace\\notes.md",
    ]);
    assert.deepEqual(opened, ["C:\\workspace\\notes.md"]);
  });

  /** 行・列の両方がついたパスが実在しなければ、二つの数値を除いたファイルだけを開くことを確かめる。 */
  it("存在しない :line:column suffix は外した file を開く", async () => {
    const opened: string[] = [];
    const result = await openLocalPathWithDefaultApp(
      "C:\\workspace\\notes.md:12:4",
      {
        /** 行・列の接尾辞つきの候補だけを存在しないものとする。 */
        statTarget: async (targetPath) => {
          if (targetPath.endsWith(":12:4")) {
            throw Object.assign(new Error("ENOENT: missing"), {
              code: "ENOENT",
            });
          }
          return localPathStat("file");
        },
        /** 実際の起動はせず、行・列を除いたパスが渡るかを観測する。 */
        openWithDefaultApp: async (targetPath) => {
          opened.push(targetPath);
          return "";
        },
      },
    );

    assert.equal(result.status, "opened");
    assert.deepEqual(opened, ["C:\\workspace\\notes.md"]);
  });

  /** 元のパスも接尾辞を除いた候補も存在しないとき、既定アプリに渡さず元のパスを not-found で返すことを確かめる。 */
  it("数字suffix付き path と fallback path が存在しない場合は元の path を not-found として返す", async () => {
    let openCalls = 0;
    const result = await openLocalPathWithDefaultApp(
      "C:\\workspace\\missing.md:12",
      {
        /** 元とフォールバックのどの候補にも存在しない旨を返す。 */
        statTarget: async () => {
          throw Object.assign(new Error("ENOENT: missing"), { code: "ENOENT" });
        },
        /** 誤って既定アプリへ渡された場合は、その呼び出しを数える。 */
        openWithDefaultApp: async () => {
          openCalls += 1;
          return "";
        },
      },
    );

    assert.deepEqual(result, {
      status: "not-found",
      targetType: "local-path",
      target: "C:\\workspace\\missing.md:12",
      message: "The local path was not found.",
    });
    assert.equal(openCalls, 0);
  });

  /** 行番号のような接尾辞があっても、アクセス拒否なら候補を短縮せず失敗を返すことを確かめる。 */
  it("数字suffix付き path の permission error は fallback せず failed を返す", async () => {
    const inspected: string[] = [];
    const result = await openLocalPathWithDefaultApp(
      "C:\\workspace\\protected.md:12",
      {
        /** 最初の照会パスを捕捉し、不存在ではなくアクセス拒否を返す。 */
        statTarget: async (targetPath) => {
          inspected.push(targetPath);
          throw Object.assign(new Error("EACCES: access denied"), {
            code: "EACCES",
          });
        },
        /** このケースで実際の既定アプリは起動させない。 */
        openWithDefaultApp: async () => "",
      },
    );

    assert.equal(result.status, "failed");
    assert.deepEqual(inspected, ["C:\\workspace\\protected.md:12"]);
  });

  /** ファイルが存在しても関連付けがない場合は、成功にせず既定アプリのエラーを返すことを確かめる。 */
  it("既定アプリで file を開けない場合は自動で Explorer に切り替えず failed を返す", async () => {
    const revealed: string[] = [];
    const result = await openLocalPathWithDefaultApp(
      "C:\\workspace\\notes.md",
      {
        /** ファイルは存在することにして、アプリ関連付けの失敗を分離する。 */
        statTarget: async () => localPathStat("file"),
        /** 関連付けなしを示す既定アプリ側の失敗文字列を返す。 */
        openWithDefaultApp: async () =>
          "No application is associated with the specified file.",
      },
    );

    assert.equal(result.status, "failed");
    assert.deepEqual(revealed, []);
    assert.match(result.message, /No application is associated/i);
  });

  /** file URL のスキームが大文字でも、パスをデコードしてローカルファイルに解決することを確かめる。 */
  it("scheme が大文字の file URL も local path に変換する", () => {
    assert.deepEqual(
      resolveOpenPathTarget("FILE:///C:/workspace/docs/a%23b.txt#intro"),
      {
        type: "local-path",
        targetPath: "C:\\workspace\\docs\\a#b.txt",
      },
    );
  });

  /** 通常のローカル open がディレクトリを既定アプリで開けることを確かめる。 */
  it("directory も既定アプリで開く", async () => {
    const result = await openLocalPathWithDefaultApp("C:\\workspace", {
      /** 通常ファイルではなくディレクトリとして存在することを通知する。 */
      statTarget: async () => localPathStat("directory"),
      /** 既定アプリで開く処理の成功を模す。 */
      openWithDefaultApp: async () => "",
    });

    assert.equal(result.status, "opened");
  });

  /** 通常ファイルでもディレクトリでもない実体を、既定アプリへ渡さず失敗にすることを確かめる。 */
  it("file / directory 以外の filesystem object は既定アプリへ渡さない", async () => {
    let openCalls = 0;
    const result = await openLocalPathWithDefaultApp("C:\\workspace\\special", {
      /** 存在するが通常のファイル操作を適用できない種別を返す。 */
      statTarget: async () => ({
        /** 対象がディレクトリではないとする。 */
        isDirectory: () => false,
        /** 対象が通常ファイルでもないとする。 */
        isFile: () => false,
      }),
      /** 特殊な実体が誤って起動ポートに渡された回数を記録する。 */
      openWithDefaultApp: async () => {
        openCalls += 1;
        return "";
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(openCalls, 0);
  });

  /** 存在しないファイルには既定アプリを呼ばず、明示的に not-found を返すことを確かめる。 */
  it("存在しない path は既定アプリを呼ばず not-found を返す", async () => {
    let openCalls = 0;
    const result = await openLocalPathWithDefaultApp("C:\\missing.txt", {
      /** 対象のファイルが存在しない場合の stat エラーを返す。 */
      statTarget: async () => {
        throw Object.assign(new Error("ENOENT: missing"), { code: "ENOENT" });
      },
      /** パスの不存在にもかかわらず起動が要求された場合に回数を記録する。 */
      openWithDefaultApp: async () => {
        openCalls += 1;
        return "";
      },
    });

    assert.equal(result.status, "not-found");
    assert.equal(openCalls, 0);
  });

  /** パスの照会がアクセス拒否になった場合は、見つからない扱いにせず元の診断を返すことを確かめる。 */
  it("stat の permission error は not-found にせず failed と診断する", async () => {
    const result = await openLocalPathWithDefaultApp("C:\\protected.txt", {
      /** パスの存在とは別のエラーであるアクセス拒否を返す。 */
      statTarget: async () => {
        throw Object.assign(new Error("EACCES: access denied"), {
          code: "EACCES",
        });
      },
      /** 実際の既定アプリは起動せずに境界の応答を調べる。 */
      openWithDefaultApp: async () => "",
    });

    assert.equal(result.status, "failed");
    assert.match(result.message, /EACCES: access denied/);
  });

  /** ローカルの UNC 候補が権限エラーで失敗した場合、そのリンクを外部 HTTPS に切り替えないことを確かめる。 */
  it("permission error は protocol-relative URL の外部 fallback を起動しない", () => {
    assert.equal(
      resolveProtocolRelativeExternalFallbackAfterLocalOpen(
        "//intranet/app/page",
        {
          status: "failed",
          targetType: "local-path",
          target: "\\\\intranet\\app\\page",
          message: "EACCES: access denied",
        },
      ),
      null,
    );
  });

  /** ローカルの UNC 候補の結果が not-found なら、同じリンクの外部 HTTPS 候補を返すことを確かめる。 */
  it("存在しない UNC 候補だけを protocol-relative URL として再解釈できる", () => {
    assert.equal(
      resolveProtocolRelativeExternalFallbackAfterLocalOpen(
        "//intranet/app/page",
        {
          status: "not-found",
          targetType: "local-path",
          target: "\\\\intranet\\app\\page",
          message: "The local path was not found.",
        },
      ),
      "https://intranet/app/page",
    );
  });
});

/** ファイルマネージャーでの明示表示が、ファイルの選択とディレクトリを開く経路を区別することを検証する。 */
describe("revealLocalPathInFileManager", () => {
  /** 行番号つきのパスが存在しないとき、接尾辞を外した実ファイルを Explorer の選択対象にすることを確かめる。 */
  it("存在しない :line suffix は外した file を Explorer に表示する", async () => {
    const revealed: string[] = [];
    const result = await revealLocalPathInFileManager(
      "C:\\workspace\\notes.md:12",
      {
        /** 行番号つきのパスの照会だけを失敗させ、元のファイルの存在を返す。 */
        statTarget: async (targetPath) => {
          if (targetPath.endsWith(":12")) {
            throw Object.assign(new Error("ENOENT: missing"), {
              code: "ENOENT",
            });
          }
          return localPathStat("file");
        },
        /** 関係のない既定アプリ経路を実際には起動しない。 */
        openWithDefaultApp: async () => "",
        /** Explorer に表示する対象として要求されたパスを記録する。 */
        revealInFileManager: (targetPath) => revealed.push(targetPath),
      },
    );

    assert.equal(result.status, "revealed");
    assert.deepEqual(revealed, ["C:\\workspace\\notes.md"]);
  });

  /** ファイルの明示表示では、そのファイルがファイルマネージャーでの選択対象になることを確かめる。 */
  it("file は明示操作のときだけ file manager に表示する", async () => {
    const revealed: string[] = [];
    const result = await revealLocalPathInFileManager(
      "C:\\workspace\\notes.md",
      {
        /** 表示対象が存在する通常ファイルであることを返す。 */
        statTarget: async () => localPathStat("file"),
        /** ファイルの既定アプリに対する実操作は行わない。 */
        openWithDefaultApp: async () => "",
        /** ファイルマネージャーで選択するパスを捕捉する。 */
        revealInFileManager: (targetPath) => revealed.push(targetPath),
      },
    );

    assert.equal(result.status, "revealed");
    assert.deepEqual(revealed, ["C:\\workspace\\notes.md"]);
  });

  /** ディレクトリの明示表示では、選択専用の処理ではなく既定のファイルマネージャーでディレクトリを開くことを確かめる。 */
  it("directory の明示 reveal は既定の file manager で開く", async () => {
    const opened: string[] = [];
    const result = await revealLocalPathInFileManager("C:\\workspace", {
      /** 表示対象をディレクトリと判定する。 */
      statTarget: async () => localPathStat("directory"),
      /** 既定アプリで開くよう要求されたディレクトリを記録する。 */
      openWithDefaultApp: async (targetPath) => {
        opened.push(targetPath);
        return "";
      },
      /** ファイル選択用ポートは実行を伴わないスタブにする。 */
      revealInFileManager: () => undefined,
    });

    assert.equal(result.status, "opened");
    assert.deepEqual(opened, ["C:\\workspace"]);
  });

  /** 表示前の権限拒否は不存在と区別し、失敗理由も返すことを確かめる。 */
  it("reveal 前の permission error は not-found にせず failed と診断する", async () => {
    const result = await revealLocalPathInFileManager("C:\\protected.txt", {
      /** 表示対象の照会で操作権限がない状態を再現する。 */
      statTarget: async () => {
        throw Object.assign(new Error("EPERM: operation not permitted"), {
          code: "EPERM",
        });
      },
      /** 権限検証のケースでは既定アプリを実起動しない。 */
      openWithDefaultApp: async () => "",
      /** 権限検証のケースでは対象を実際に選択表示しない。 */
      revealInFileManager: () => undefined,
    });

    assert.equal(result.status, "failed");
    assert.match(result.message, /EPERM: operation not permitted/);
  });

  /** 経路の途中にディレクトリでない要素があることを示す ENOTDIR を、not-found に分類することを確かめる。 */
  it("reveal 前の ENOTDIR は not-found を返す", async () => {
    const result = await revealLocalPathInFileManager("C:\\missing\\file.txt", {
      /** パス内の要素をディレクトリとしてたどれない場合の stat 応答を再現する。 */
      statTarget: async () => {
        throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
      },
      /** 不存在の検証では既定アプリを実起動しない。 */
      openWithDefaultApp: async () => "",
      /** 不存在の検証ではファイル選択を実行しない。 */
      revealInFileManager: () => undefined,
    });

    assert.equal(result.status, "not-found");
  });
});
