import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDirectoryOpenFallbackCommand,
  resolveForwardSlashUncPathCandidate,
  resolveOpenPathTarget,
  resolveProtocolRelativeExternalFallback,
} from "../../src-electron/open-path.js";

describe("resolveOpenPathTarget", () => {
  it("http url はそのまま外部 URL として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("https://example.com/docs#intro"), {
      type: "external-url",
      target: "https://example.com/docs#intro",
    });
  });

  it("protocol-relative URL は https の外部 URL として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("//example.com/docs"), {
      type: "external-url",
      target: "https://example.com/docs",
    });
  });

  it("複数階層の protocol-relative URL も query と fragment を保った外部 URL として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("//example.com/docs/page?x=a%20b#top"), {
      type: "external-url",
      target: "https://example.com/docs/page?x=a%20b#top",
    });
  });

  it("拡張子付きの protocol-relative URL も UNC 候補にしない", () => {
    assert.deepEqual(resolveOpenPathTarget("//example.com/docs/page.html"), {
      type: "external-url",
      target: "https://example.com/docs/page.html",
    });
    assert.equal(resolveForwardSlashUncPathCandidate("//example.com/docs/page.html"), null);
  });

  it("先頭空白付きの protocol-relative URL も UNC 候補にしない", () => {
    assert.deepEqual(resolveOpenPathTarget(" //example.com/docs/page.html"), {
      type: "external-url",
      target: "https://example.com/docs/page.html",
    });
    assert.equal(resolveForwardSlashUncPathCandidate(" //example.com/docs/page.html"), null);
  });

  it("複数階層の protocol-relative URL は UNC 候補にしない", () => {
    assert.equal(resolveForwardSlashUncPathCandidate("//example.com/docs/page?x=a%20b#top"), null);
  });

  it("ポート付き protocol-relative URL は external URL として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("//localhost:5173/docs"), {
      type: "external-url",
      target: "https://localhost:5173/docs",
    });
    assert.equal(resolveForwardSlashUncPathCandidate("//localhost:5173/docs"), null);
  });

  it("localhost の protocol-relative URL は port なしでも external URL として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("//localhost/docs"), {
      type: "external-url",
      target: "https://localhost/docs",
    });
    assert.equal(resolveForwardSlashUncPathCandidate("//localhost/docs"), null);
  });

  it("single-label host の protocol-relative URL は 1 segment path なら external URL として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("//intranet/app"), {
      type: "external-url",
      target: "https://intranet/app",
    });
    assert.equal(resolveForwardSlashUncPathCandidate("//intranet/app"), null);
  });

  it("forward-slash UNC path は local path として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("//server/share/file.txt"), {
      type: "local-path",
      targetPath: "//server/share/file.txt",
    });
  });

  it("forward-slash UNC path は local open 失敗時の external fallback も持つ", () => {
    assert.equal(resolveProtocolRelativeExternalFallback("//server/share/file.txt"), "https://server/share/file.txt");
  });

  it("single-label host の複数 segment protocol-relative URL は local open 失敗時の external fallback を持つ", () => {
    assert.deepEqual(resolveOpenPathTarget("//intranet/app/page"), {
      type: "local-path",
      targetPath: "//intranet/app/page",
    });
    assert.equal(resolveForwardSlashUncPathCandidate("//intranet/app/page"), "//intranet/app/page");
    assert.equal(resolveProtocolRelativeExternalFallback("//intranet/app/page"), "https://intranet/app/page");
  });

  it("FQDN の protocol-relative URL は UNC 候補にしない", () => {
    assert.deepEqual(resolveOpenPathTarget("//fileserver.example.com/share/file.txt"), {
      type: "external-url",
      target: "https://fileserver.example.com/share/file.txt",
    });
    assert.equal(resolveForwardSlashUncPathCandidate("//fileserver.example.com/share/file.txt"), null);
  });

  it("IP address の protocol-relative URL は UNC 候補にしない", () => {
    assert.deepEqual(resolveOpenPathTarget("//192.168.1.10/share/file.txt"), {
      type: "external-url",
      target: "https://192.168.1.10/share/file.txt",
    });
    assert.equal(resolveForwardSlashUncPathCandidate("//192.168.1.10/share/file.txt"), null);
  });

  it("mailto URL は外部 URL として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("mailto:alice@example.test"), {
      type: "external-url",
      target: "mailto:alice@example.test",
    });
  });

  it("encoded mailto URL は decode せず外部 URL として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("mailto:alice@example.test?subject=hello%20world%0D%0A"), {
      type: "external-url",
      target: "mailto:alice@example.test?subject=hello%20world%0D%0A",
    });
  });

  it("workspace 相対 path は baseDirectory 基準で解決する", () => {
    assert.deepEqual(resolveOpenPathTarget("src/App.tsx#L10", { baseDirectory: "C:/workspace/project" }), {
      type: "local-path",
      targetPath: "C:\\workspace\\project\\src\\App.tsx",
    });
  });

  it("encoded workspace 相対 path は fragment を外してから decode する", () => {
    assert.deepEqual(resolveOpenPathTarget("docs/a%23b%3Fv.txt#section", { baseDirectory: "C:/workspace/project" }), {
      type: "local-path",
      targetPath: "C:\\workspace\\project\\docs\\a#b?v.txt",
    });
  });

  it("encoded workspace 相対 path の空白と非 ASCII を decode する", () => {
    assert.deepEqual(resolveOpenPathTarget("docs/my%20file-%E4%BB%95%E6%A7%98.md", { baseDirectory: "C:/workspace/project" }), {
      type: "local-path",
      targetPath: "C:\\workspace\\project\\docs\\my file-仕様.md",
    });
  });

  it("absolute path の fragment は外して開く path にする", () => {
    assert.deepEqual(resolveOpenPathTarget("C:/workspace/project/src/App.tsx#L10"), {
      type: "local-path",
      targetPath: "C:/workspace/project/src/App.tsx",
    });
  });

  it("file url の fragment も外して local path に変換する", () => {
    assert.deepEqual(resolveOpenPathTarget("file:///C:/workspace/project/docs/spec.md#intro"), {
      type: "local-path",
      targetPath: "C:\\workspace\\project\\docs\\spec.md",
    });
  });

  it("file url の encoded local path は fragment を外してから decode する", () => {
    assert.deepEqual(resolveOpenPathTarget("file:///C:/workspace/docs/a%23b.txt#intro"), {
      type: "local-path",
      targetPath: "C:\\workspace\\docs\\a#b.txt",
    });
  });

  it("file UNC url は host を含む local UNC path に変換する", () => {
    assert.deepEqual(resolveOpenPathTarget("file://server/share/file.txt"), {
      type: "local-path",
      targetPath: "\\\\server\\share\\file.txt",
    });
  });

  it("Windows の directory open fallback は explorer.exe を使う", () => {
    assert.deepEqual(buildDirectoryOpenFallbackCommand("C:\\workspace\\project", "win32"), {
      command: "explorer.exe",
      args: ["C:\\workspace\\project"],
    });
  });

  it("Windows 以外では directory open fallback を持たない", () => {
    assert.equal(buildDirectoryOpenFallbackCommand("/workspace/project", "linux"), null);
  });
});
