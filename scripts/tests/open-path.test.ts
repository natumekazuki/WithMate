import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveOpenPathTarget } from "../../src-electron/open-path.js";

describe("resolveOpenPathTarget", () => {
  it("http url はそのまま外部 URL として扱う", () => {
    assert.deepEqual(resolveOpenPathTarget("https://example.com/docs#intro"), {
      type: "external-url",
      target: "https://example.com/docs#intro",
    });
  });

  it("workspace 相対 path は baseDirectory 基準で解決する", () => {
    assert.deepEqual(resolveOpenPathTarget("src/App.tsx#L10", { baseDirectory: "C:/workspace/project" }), {
      type: "local-path",
      targetPath: "C:\\workspace\\project\\src\\App.tsx",
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
});
