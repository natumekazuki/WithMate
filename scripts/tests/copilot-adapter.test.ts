import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildCopilotClientEnv,
  isRecoverableCopilotConnectionErrorMessage,
  resolveCopilotCliPath,
  resolveNativeCopilotPackageName,
  shouldRetryCopilotTurn,
} from "../../src-electron/copilot-adapter.js";
import { ProviderTurnError, type RunSessionTurnResult } from "../../src-electron/provider-runtime.js";

function createPartialResult(overrides?: Partial<RunSessionTurnResult>): RunSessionTurnResult {
  return {
    threadId: "",
    assistantText: "",
    systemPromptText: "",
    inputPromptText: "",
    composedPromptText: "",
    operations: [],
    rawItemsJson: "[]",
    usage: null,
    ...overrides,
  };
}

describe("CopilotAdapter env", () => {
  it("Copilot child CLI では process warning を抑止する", () => {
    const env = buildCopilotClientEnv({
      PATH: "test-path",
      ELECTRON_RUN_AS_NODE: "1",
    });

    assert.equal(env.NODE_NO_WARNINGS, "1");
    assert.equal(env.PATH, "test-path");
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  });

  it("platform / arch から native Copilot package 名を決める", () => {
    assert.equal(resolveNativeCopilotPackageName("win32", "x64"), "@github/copilot-win32-x64");
    assert.equal(resolveNativeCopilotPackageName("darwin", "arm64"), "@github/copilot-darwin-arm64");
    assert.equal(resolveNativeCopilotPackageName("linux", "x64"), "@github/copilot-linux-x64");
    assert.equal(resolveNativeCopilotPackageName("win32", "ia32"), null);
  });

  it("Electron では native Copilot CLI binary を優先して使う", () => {
    const resolved = resolveCopilotCliPath(
      (specifier) => {
        assert.equal(specifier, "@github/copilot-win32-x64");
        return path.join("C:\\sdk", "copilot.exe");
      },
      (candidate) => candidate === path.join("C:\\sdk", "copilot.exe"),
      "win32",
      "x64",
    );

    assert.equal(resolved, path.join("C:\\sdk", "copilot.exe"));
  });

  it("native binary が見つからない時は local node_modules command を返す", () => {
    const resolved = resolveCopilotCliPath(
      () => {
        throw new Error("not found");
      },
      (candidate) => candidate === path.resolve(process.cwd(), "node_modules", ".bin", "copilot.cmd"),
      "win32",
      "x64",
    );

    assert.equal(resolved, path.resolve(process.cwd(), "node_modules", ".bin", "copilot.cmd"));
  });

  it("local command も無い時だけ bare command fallback を返す", () => {
    const resolved = resolveCopilotCliPath(
      () => {
        throw new Error("not found");
      },
      () => false,
      "win32",
      "x64",
    );

    assert.equal(resolved, "copilot.cmd");
  });

  it("stale connection 系の message だけ recovery 対象にする", () => {
    assert.equal(isRecoverableCopilotConnectionErrorMessage("Connection is closed."), true);
    assert.equal(isRecoverableCopilotConnectionErrorMessage("CLI server exited unexpectedly with code 0"), true);
    assert.equal(isRecoverableCopilotConnectionErrorMessage("selected model が model catalog に存在しないよ。"), false);
  });

  it("進行途中の partial result が無い stale connection だけ retry する", () => {
    const emptyPartial = new ProviderTurnError("Connection is closed.", createPartialResult(), false);
    const withAssistantText = new ProviderTurnError("Connection is closed.", createPartialResult({ assistantText: "4" }), false);

    assert.equal(shouldRetryCopilotTurn(emptyPartial), true);
    assert.equal(shouldRetryCopilotTurn(withAssistantText), false);
  });
});
