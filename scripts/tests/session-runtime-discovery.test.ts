import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SESSION_RUNTIME_CREDENTIAL_SCHEMA_VERSION,
  parseSessionRuntimeCredentialEnvelope,
} from "../../src/session-runtime-discovery.js";

const identity = {
  applicationInstanceId: "11111111-1111-4111-8111-111111111111",
  runtimeKind: "session",
  runtimeGenerationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

function credentialEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: "withmate-runtime-credential-v1",
    ...identity,
    adapterKind: "cli",
    credential: {
      schemaVersion: SESSION_RUNTIME_CREDENTIAL_SCHEMA_VERSION,
      baseUrl: "http://127.0.0.1:12345",
      apiSecret: "api-secret",
      adapterSecret: "cli-secret",
    },
    ...overrides,
  });
}

// @test-value v1
// kind = "security"
// claim = "Session credential envelopeはregistry identity tupleとadapterが完全一致する場合だけ受理される"
// oracle = { type = "adr", ref = "ADR-023 Identity and registry ownership / Selection and binding" }
// failure_mode = "別application、別generation、別adapterのcredentialを選択済みentryへ混入してsecret-bearing接続を構築する"
// scope = "session-runtime-credential-envelope-parser"
// lifecycle = "permanent"
// @end-test-value
test("Session credential envelopeはregistry identity tupleとの不一致を拒否する", () => {
  assert.ok(parseSessionRuntimeCredentialEnvelope(credentialEnvelope(), identity, "cli"));
  assert.equal(parseSessionRuntimeCredentialEnvelope(credentialEnvelope({
    applicationInstanceId: "22222222-2222-4222-8222-222222222222",
  }), identity, "cli"), null);
  assert.equal(parseSessionRuntimeCredentialEnvelope(credentialEnvelope({
    runtimeGenerationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  }), identity, "cli"), null);
  assert.equal(parseSessionRuntimeCredentialEnvelope(credentialEnvelope(), identity, "mcp"), null);
});

// @test-value v1
// kind = "security"
// claim = "Session credential envelopeはunknown fieldを含む外部入力を拒否する"
// oracle = { type = "adr", ref = "ADR-023 Diagnostics and security" }
// failure_mode = "未定義fieldを内部credentialへ通し、schema境界を迂回する"
// scope = "session-runtime-credential-envelope-parser"
// lifecycle = "permanent"
// distinction = "identity mismatchではなくouter envelopeのstrict shapeを観測する"
// @end-test-value
test("Session credential envelopeはunknown fieldを拒否する", () => {
  assert.equal(parseSessionRuntimeCredentialEnvelope(
    credentialEnvelope({ unexpected: "value" }),
    identity,
    "cli",
  ), null);
});
