import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultAppSettings,
  getProviderAppSettings,
  normalizeAppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
/** 保存設定の欠落と旧キーを含む入力に対するプロバイダー設定の正規化を検証する。 */
describe("app settings provider helpers", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "空のapp settingsを正規化するとCodexは有効、Copilotは無効として取得できる"
  // oracle = { type = "contract", ref = "src-shared/settings/provider-settings-state.ts: createDefaultAppSettingsとgetProviderAppSettingsのprovider有効既定値" }
  // fault = "未設定のCodexを無効にするか、未設定のCopilotを有効にする"
  // observable = "normalizeAppSettings({})からgetProviderAppSettingsで取得したcodexとcopilotのenabled値"
  // observation_boundary = "public-boundary"
  // scope = "未設定app settingsのprovider有効既定値"
  // lifecycle = "permanent"
  // distinction = "boolean型ではJSON入力が未設定の場合に選ばれるprovider別既定値を検出できない"
  // @end-test-value
  /** 未設定なら Codex が有効、Copilot が無効になることを確かめる。 */
  it("settings 未設定でも codex は既定で enabled になる", () => {
    const settings = normalizeAppSettings({});

    assert.equal(getProviderAppSettings(settings, "codex").enabled, true);
    assert.equal(getProviderAppSettings(settings, "copilot").enabled, false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "provider設定の正規化はOpenCode keyを利用せず、他providerのkeyと各providerのfile設定を保持する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
  // fault = "OpenCode keyを返すか、他providerのkeyまたはOpenCodeの設定を消す"
  // observable = "normalizeAppSettingsとgetProviderAppSettingsのprovider設定"
  // observation_boundary = "public-boundary"
  // scope = "provider-settings-normalization"
  // lifecycle = "permanent"
  // impact = "廃止したcredentialの再利用や他providerの認証設定消失を防ぐ"
  // distinction = "型ではJSON入力に残るcredentialの対象限定除去を保証できない"
  // @end-test-value
  /** 廃止した OpenCode の認証キーだけを除き、他のキーと OpenCode の設定パスを保持する。 */
  it("provider ごとの設定を保持しOpenCode keyだけを正規化する", () => {
    const settings = normalizeAppSettings({
      ...createDefaultAppSettings(),
      codingProviderSettings: {
        codex: {
          enabled: false,
          apiKey: "codex-key",
        },
        copilot: {
          enabled: true,
          apiKey: "copilot-key",
        },
        opencode: {
          enabled: true,
          apiKey: "retired-key",
          skillRootPath: "C:/opencode",
          skillRelativePath: "skills",
          instructionRelativePath: "AGENTS.md",
        },
      },
    });

    assert.deepEqual(getProviderAppSettings(settings, "codex"), {
      enabled: false,
      apiKey: "codex-key",
      skillRootPath: "",
      skillRelativePath: "",
      instructionRelativePath: "",
    });
    assert.deepEqual(getProviderAppSettings(settings, "copilot"), {
      enabled: true,
      apiKey: "copilot-key",
      skillRootPath: "",
      skillRelativePath: "",
      instructionRelativePath: "",
    });
    assert.deepEqual(getProviderAppSettings(settings, "opencode"), {
      enabled: true,
      apiKey: "",
      skillRootPath: "C:/opencode",
      skillRelativePath: "skills",
      instructionRelativePath: "AGENTS.md",
    });
    assert.equal(settings.codingProviderSettings.opencode.apiKey, "");
  });

  /** 現行キーと旧キーが競合したら、現行の設定を採用する。 */
  it("canonical な codingProviderSettings だけを正本として扱う", () => {
    const settings = normalizeAppSettings({
      codingProviderSettings: {
        codex: {
          enabled: false,
          apiKey: "canonical-key",
        },
      },
      providerSettings: {
        codex: {
          enabled: true,
          apiKey: "legacy-key",
        },
      },
    });

    assert.deepEqual(settings.codingProviderSettings, {
      codex: {
        enabled: false,
        apiKey: "canonical-key",
        skillRootPath: "",
        skillRelativePath: "",
        instructionRelativePath: "",
      },
    });
    assert.deepEqual(getProviderAppSettings(settings, "codex"), {
      enabled: false,
      apiKey: "canonical-key",
      skillRootPath: "",
      skillRelativePath: "",
      instructionRelativePath: "",
    });
  });
});
