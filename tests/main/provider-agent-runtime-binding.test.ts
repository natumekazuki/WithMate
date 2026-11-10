import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { MemoryV6WorkerClient } from "../../src-electron/memory/memory-v6-worker-client.js";
import { resolveMemoryV6ProjectCandidate } from "../../src-electron/memory/memory-v6-project-resolver.js";
import { resolveMemoryV6Target } from "../../src-electron/memory/memory-v6-context-resolver.js";
import type { MemoryV6SessionBindingPrincipal } from "../../src-electron/memory/memory-v6-permission.js";
import { describe, it } from "node:test";

import {
  buildProviderAgentRuntimeAuthoritySnapshot,
  createProviderAgentRuntimeBindingRedactor,
  PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER,
} from "../../src-electron/providers/provider-agent-runtime-binding.js";
import { PROVIDER_TEXT_PREVIEW_LIMIT, boundProviderRawItem } from "../../src-electron/session/provider-payload-limits.js";

describe("buildProviderAgentRuntimeAuthoritySnapshot", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "同じGit Projectのcheckoutは既存DB IDへ解決され、新規Gitは初回保存用ID、非GitはProject権限なしになる"
  // oracle = { type = "adr", ref = "ADR-024" }
  // fault = "DBの既存IDよりcandidate IDを優先しMemory targetを見失うか非GitへProject権限を与える"
  // observable = "実storage Workerを使ったauthorityの許可IDとMemory targetの解決結果"
  // observation_boundary = "public-boundary"
  // scope = "provider-agent-runtime-authority-snapshot"
  // lifecycle = "permanent"
  // impact = "通常・背景実行が保存済みProject Memoryを参照できない"
  // distinction = "型検査や固定IDのmockでは既存DB IDとGit candidateの差を検出できず、分離DB一つで実resolverを確認する"
  // @end-test-value
  it("workspace projectをknown resolverのIDへcanonicalizeする", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-project-authority-"));
    let worker: MemoryV6WorkerClient | undefined;
    try {
      const roots = ["checkout", "worktree", "new-project"].map((name) => path.join(directory, name));
      for (const [index, root] of roots.entries()) {
        await mkdir(path.join(root, ".git"), { recursive: true });
        await writeFile(path.join(root, ".git/config"), `[remote "origin"]\nurl = https://example.com/${index < 2 ? "shared" : "new"}.git\n`);
      }
      const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
      const scope = resolveMemoryV6ProjectCandidate(roots[0]!)!.admission!;
      const existingId = "project-b59b1c03-f144-4901-89c0-a26d372ef237";
      assert.notEqual(scope.id, existingId);
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(`INSERT INTO project_scopes_v6 (id, project_type, project_key, display_name, workspace_path, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, '2026-11-09', '2026-11-09')`).run(existingId, scope.projectType, scope.projectKey, scope.displayName, roots[0]!);
      } finally { db.close(); }
      worker = new MemoryV6WorkerClient({ dbPath, workerUrl: new URL("../../src-electron/storage/storage-worker-entry.ts", import.meta.url) });
      const resolveCanonicalProjectId = async (workspace: string) => (await worker!.resolveKnownProjectByPath(workspace))?.id;
      for (const root of roots.slice(0, 2)) {
        const snapshot = await buildProviderAgentRuntimeAuthoritySnapshot({ characterId: " character-a ", workspacePath: root, resolveCanonicalProjectId });
        assert.deepEqual(snapshot, { userId: "local-user", characterId: "character-a", allowedProjectIds: [existingId] });
        const principal: MemoryV6SessionBindingPrincipal = { type: "session_binding", bindingIdHash: "fixture", sessionId: "session", providerId: "codex",
          characterId: snapshot!.characterId, allowedProjectIds: snapshot!.allowedProjectIds, workspacePath: root, permissions: ["memory.search"] };
        const result = await resolveMemoryV6Target({ owner: "project", scope: "project", project: { type: "id", id: existingId } }, principal, worker, { projectPathResolution: "known" });
        assert.equal(result.ok, true);
        if (result.ok) assert.deepEqual(result.target, { owner: { type: "project", id: existingId }, scope: { type: "project", id: existingId } });
      }
      const fresh = await buildProviderAgentRuntimeAuthoritySnapshot({ characterId: "character-a", workspacePath: roots[2], resolveCanonicalProjectId });
      assert.deepEqual(fresh!.allowedProjectIds, [resolveMemoryV6ProjectCandidate(roots[2]!)!.id]);
      const nonGit = path.join(directory, "plain"); await mkdir(nonGit);
      assert.deepEqual((await buildProviderAgentRuntimeAuthoritySnapshot({ characterId: "character-a", workspacePath: nonGit, resolveCanonicalProjectId }))!.allowedProjectIds, []);
    } finally { await worker?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  // @test-value v2
  // kind = "security"
  // claim = "unresolved workspaceはProject authorityを持たず、空characterはsnapshotを生成しない"
  // oracle = { type = "adr", ref = "ADR-024" }
  // fault = "解決不能なworkspaceまたは空のCharacter identityへauthorityを付与する"
  // observable = "snapshotの空Project許可集合と空Characterでのnull"
  // observation_boundary = "component-behavior"
  // scope = "provider-agent-runtime-authority-snapshot"
  // lifecycle = "permanent"
  // distinction = "既知workspaceのcanonical化とは異なり、fail-closedの境界を検証する"
  // @end-test-value
  it("unresolved workspaceは空、空characterはnullにする", async () => {
    assert.deepEqual(await buildProviderAgentRuntimeAuthoritySnapshot({
      characterId: "character-a",
      workspacePath: "C:/missing",
      resolveCanonicalProjectId: () => null,
    }), {
      userId: "local-user",
      characterId: "character-a",
      allowedProjectIds: [],
    });
    assert.equal(await buildProviderAgentRuntimeAuthoritySnapshot({
      characterId: "   ",
      workspacePath: "C:/workspace",
      resolveCanonicalProjectId: () => "project-a",
    }), null);
  });

});

// @test-value v2
// kind = "security"
// claim = "budget内raw projectionはkeyと本文のsecretを秘匿化し、preview境界をまたぐsecretの断片も残さない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#streaming-policy" }
// fault = "rawを先に切ってからsecret置換するため切断されたbinding prefixを診断traceに残す、またはkeyの秘匿化を落とす"
// observable = "boundProviderRawItemのJSON、truncation元長、秘匿化されたkeyと入力原文"
// observation_boundary = "component-behavior"
// scope = "bounded raw secret projection"
// lifecycle = "permanent"
// impact = "runtime capabilityの一部やsecret-bearing keyが診断traceへ漏れる"
// distinction = "既存redaction testはcomplete secretだけ、budget testはsecretなしであり境界横断を検出しない。固定prefixでSDK通信や時刻測定は不要"
// risk_tags = ["privacy"]
// @end-test-value
it("raw preview境界のsecretを断片なしで秘匿化し入力を変更しない", () => {
  const secret = "Z9sensitive[+].secret";
  const shorterSecret = "tiny[+]";
  const redactor = createProviderAgentRuntimeBindingRedactor(null, [secret, shorterSecret]);
  for (let overlap = 1; overlap < secret.length; overlap += 1) {
    const content = shorterSecret + "x".repeat(PROVIDER_TEXT_PREVIEW_LIMIT - overlap - shorterSecret.length)
      + secret + "y".repeat(PROVIDER_TEXT_PREVIEW_LIMIT * 4);
    const source = { type: "tool.execution_complete", data: { content, [secret]: shorterSecret } };
    const item = boundProviderRawItem(source, undefined, redactor.sanitizeText);
    const json = JSON.stringify(item);
    assert.ok(!json.includes("Z9sensitive") && !json.includes(secret) && !json.includes(shorterSecret));
    assert.ok(!json.includes(`x${secret.slice(0, overlap)}`), `secret prefix at overlap ${overlap}`);
    assert.ok(json.includes(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER));
    assert.deepEqual(item.data?.[PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER], PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER);
    const preview = item.data?.content as { truncated: boolean; originalLength: number };
    assert.equal(preview.truncated, true);
    assert.equal(preview.originalLength, content.length);
    assert.equal(source.data.content, content);
    assert.equal(source.data[secret], shorterSecret);
  }
});
