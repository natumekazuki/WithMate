import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";

import {
  GlossaryApplicationService,
  normalizeGlossaryLookup,
  parseGlossaryDocument,
  serializeGlossaryDocument,
  type ResolvedGlossaryCheckout,
} from "../../src-electron/glossary-application-service.js";
import type { GlossaryEntry } from "../../src/glossary-contract.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function createRepository(): Promise<{ root: string; target: ResolvedGlossaryCheckout }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-glossary-"));
  temporaryDirectories.push(root);
  await execFileAsync("git", ["init", "--quiet", root], { windowsHide: true });
  const service = new GlossaryApplicationService();
  return { root, target: await service.resolvePrimaryCheckout(root) };
}

async function writeGlossary(root: string, entries: readonly GlossaryEntry[]): Promise<string> {
  await mkdir(path.join(root, ".withmate"), { recursive: true });
  const raw = serializeGlossaryDocument(entries);
  await writeFile(path.join(root, ".withmate", "glossary.yaml"), raw, "utf8");
  return raw;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("GLOSSARY-SOURCE-OF-TRUTH parser and projection", () => {
  it("valid schemaの表示値とYAML順を保持し、raw content hashをrevisionにする", () => {
    const raw = [
      "schemaVersion: 1",
      "entries:",
      "  - term: Session Runtime",
      "    aliases:",
      "      - Runtime",
      "    definition: |-",
      "      **not markdown**",
      "      <script>alert(1)</script>",
      "  - term: Agent Binding",
      "    definition: Authority boundary",
      "",
    ].join("\n");

    const snapshot = parseGlossaryDocument(raw);
    assert.equal(snapshot.status, "valid");
    if (snapshot.status !== "valid") return;
    assert.deepEqual(snapshot.entries.map((entry) => entry.term), ["Session Runtime", "Agent Binding"]);
    assert.equal(snapshot.entries[0].definition, "**not markdown**\n<script>alert(1)</script>");
    assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
  });

  it("invalid YAML、unsupported schema、unknown fieldを区別する", () => {
    assert.equal(parseGlossaryDocument("schemaVersion: [\n").status, "invalid");
    assert.equal(parseGlossaryDocument("schemaVersion: 2\nentries: []\n").status, "unsupported");
    const unknown = parseGlossaryDocument("schemaVersion: 1\nentries: []\ncache: []\n");
    assert.equal(unknown.status, "invalid");
    if (unknown.status === "invalid") {
      assert.equal(unknown.issues[0].code, "UNKNOWN_FIELD");
    }
  });

  it("NFKC・case・連続空白後にtermとaliasが曖昧になるfileを拒否する", () => {
    assert.equal(normalizeGlossaryLookup("  ＳＥＳＳＩＯＮ　 Runtime  "), "session runtime");
    const snapshot = parseGlossaryDocument([
      "schemaVersion: 1",
      "entries:",
      "  - term: Session Runtime",
      "    aliases: [Runtime]",
      "    definition: first",
      "  - term: Other",
      "    aliases: [ＲＵＮＴＩＭＥ]",
      "    definition: second",
      "",
    ].join("\n"));
    assert.equal(snapshot.status, "invalid");
    if (snapshot.status === "invalid") {
      assert.ok(snapshot.issues.some((issue) => issue.code === "AMBIGUOUS_LOOKUP"));
    }
  });
});

describe("GLOSSARY-ATOMIC-MUTATION file service", () => {
  it("missing readは.withmateを作らず、explicit createだけがfileを作る", async () => {
    const { root, target } = await createRepository();
    const service = new GlossaryApplicationService();

    assert.deepEqual(await service.read(target), {
      status: "missing",
      relativePath: ".withmate/glossary.yaml",
      revision: null,
    });
    await assert.rejects(() => readFile(path.join(root, ".withmate", "glossary.yaml"), "utf8"));

    const created = await service.create(target, {
      mode: "explicit",
      entry: { term: "Session Runtime", aliases: ["Runtime"], definition: "plain text" },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.outcome, "applied");
    assert.equal(created.effect, "applied");
    const raw = await readFile(path.join(root, ".withmate", "glossary.yaml"), "utf8");
    assert.doesNotMatch(raw, /revision|normalized|preview/);
  });

  it("同じcreate retryはconvergedし、同じtermの別内容はconflictにする", async () => {
    const { target } = await createRepository();
    const service = new GlossaryApplicationService();
    const request = {
      mode: "explicit" as const,
      entry: { term: "Runtime", aliases: ["RT"], definition: "first" },
    };
    const first = await service.create(target, request);
    const retry = await service.create(target, request);
    const conflict = await service.create(target, {
      mode: "explicit",
      entry: { term: "ＲＵＮＴＩＭＥ", definition: "different" },
    });
    assert.equal(first.ok && first.outcome, "applied");
    assert.equal(retry.ok && retry.outcome, "converged");
    assert.equal(retry.ok && retry.effect, "none");
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.code, "GLOSSARY_CONFLICT");
    const aliasConflict = await service.create(target, {
      mode: "explicit",
      entry: { term: "Other", aliases: ["RT"], definition: "alias collision" },
    });
    assert.equal(aliasConflict.ok, false);
    if (!aliasConflict.ok) assert.equal(aliasConflict.code, "GLOSSARY_CONFLICT");
  });

  it("create-batch retryは全件一致だけconvergedし、部分一致では不足分を追加しない", async () => {
    const { root, target } = await createRepository();
    const service = new GlossaryApplicationService();
    const entries = [
      { term: "First", definition: "one" },
      { term: "Second", definition: "two" },
    ];
    const first = await service.createBatch(target, { mode: "explicit", entries });
    const retry = await service.createBatch(target, { mode: "explicit", entries });
    assert.equal(first.ok && first.outcome, "applied");
    assert.equal(retry.ok && retry.outcome, "converged");

    const snapshot = await service.read(target);
    assert.equal(snapshot.status, "valid");
    if (snapshot.status !== "valid") return;
    await writeGlossary(root, [snapshot.entries[0]]);
    const partial = await service.createBatch(target, { mode: "explicit", entries });
    assert.equal(partial.ok, false);
    if (!partial.ok) assert.equal(partial.code, "GLOSSARY_CONFLICT");
    const after = await service.read(target);
    assert.equal(after.status === "valid" && after.entries.length, 1);
  });

  it("external revision後のupdateはconflictし、適用済みの完全entryだけconvergedする", async () => {
    const { root, target } = await createRepository();
    const service = new GlossaryApplicationService();
    await writeGlossary(root, [{ term: "Old", aliases: [], definition: "before" }]);
    const before = await service.read(target);
    assert.equal(before.status, "valid");
    if (before.status !== "valid") return;

    await writeGlossary(root, [{ term: "Old", aliases: [], definition: "external" }]);
    const conflict = await service.update(target, {
      expectedRevision: before.revision,
      targetTerm: "Old",
      entry: { term: "New", definition: "after" },
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.code, "GLOSSARY_CONFLICT");

    await writeGlossary(root, [{ term: "New", aliases: [], definition: "after" }]);
    const converged = await service.update(target, {
      expectedRevision: before.revision,
      targetTerm: "Old",
      entry: { term: "New", definition: "after" },
    });
    assert.equal(converged.ok && converged.outcome, "converged");
    assert.equal(converged.ok && converged.effect, "none");
  });

  it("termを変えないupdateは同じentryを旧term残存と誤判定しない", async () => {
    const { root, target } = await createRepository();
    const service = new GlossaryApplicationService();
    const raw = await writeGlossary(root, [{ term: "Same", aliases: [], definition: "after" }]);
    const result = await service.update(target, {
      expectedRevision: "0".repeat(64),
      targetTerm: "Same",
      entry: { term: "Same", definition: "after" },
    });
    assert.equal(result.ok && result.outcome, "converged");
    assert.equal(await readFile(path.join(root, ".withmate", "glossary.yaml"), "utf8"), raw);
  });

  it("delete retryはtermとaliasが消えた時だけconvergedする", async () => {
    const { root, target } = await createRepository();
    const service = new GlossaryApplicationService();
    await writeGlossary(root, [{ term: "Delete Me", aliases: ["DM"], definition: "remove" }]);
    const before = await service.read(target);
    assert.equal(before.status, "valid");
    if (before.status !== "valid") return;

    await writeGlossary(root, []);
    const converged = await service.delete(target, {
      expectedRevision: before.revision,
      targetTerm: "Delete Me",
    });
    assert.equal(converged.ok && converged.outcome, "converged");

    await writeGlossary(root, [{ term: "Other", aliases: ["Delete Me"], definition: "collision" }]);
    const conflict = await service.delete(target, {
      expectedRevision: before.revision,
      targetTerm: "Delete Me",
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.code, "GLOSSARY_CONFLICT");
  });

  it("invalid fileをmutationで上書きしない", async () => {
    const { root, target } = await createRepository();
    const service = new GlossaryApplicationService();
    await mkdir(path.join(root, ".withmate"));
    const invalidRaw = "schemaVersion: [\n";
    await writeFile(path.join(root, ".withmate", "glossary.yaml"), invalidRaw, "utf8");
    const result = await service.create(target, {
      mode: "explicit",
      entry: { term: "Safe", definition: "must not overwrite" },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "GLOSSARY_INVALID_FILE");
    assert.equal(await readFile(path.join(root, ".withmate", "glossary.yaml"), "utf8"), invalidRaw);
  });

  it("rename errorはpostcondition read-backでapplied、none、unknownを分類する", async () => {
    const appliedRepo = await createRepository();
    const appliedService = new GlossaryApplicationService({
      renamePath: async (source, destination) => {
        const { rename } = await import("node:fs/promises");
        await rename(source, destination);
        throw Object.assign(new Error("response lost"), { code: "EIO" });
      },
    });
    const applied = await appliedService.create(appliedRepo.target, {
      mode: "explicit",
      entry: { term: "Applied", definition: "read back" },
    });
    assert.equal(applied.ok && applied.effect, "applied");

    const noneRepo = await createRepository();
    const noneService = new GlossaryApplicationService({
      renamePath: async () => {
        throw Object.assign(new Error("rename failed"), { code: "EPERM" });
      },
    });
    const none = await noneService.create(noneRepo.target, {
      mode: "explicit",
      entry: { term: "None", definition: "unchanged" },
    });
    assert.equal(none.ok, false);
    if (!none.ok) assert.equal(none.effect, "none");

    const unknownRepo = await createRepository();
    const unknownService = new GlossaryApplicationService({
      renamePath: async (_source, destination) => {
        await writeFile(destination, serializeGlossaryDocument([{ term: "Other", aliases: [], definition: "race" }]), "utf8");
        throw Object.assign(new Error("rename ambiguous"), { code: "EIO" });
      },
    });
    const unknown = await unknownService.create(unknownRepo.target, {
      mode: "explicit",
      entry: { term: "Unknown", definition: "ambiguous" },
    });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) {
      assert.equal(unknown.code, "GLOSSARY_EFFECT_UNKNOWN");
      assert.equal(unknown.effect, "unknown");
      assert.equal(unknown.retryable, false);
    }
  });

  it("side effect直前のexternal editとruntime guard変更を拒否する", async () => {
    const externalRepo = await createRepository();
    const externalService = new GlossaryApplicationService({
      beforeRename: async () => {
        await writeGlossary(externalRepo.root, [{ term: "External", aliases: [], definition: "wins" }]);
      },
    });
    const conflict = await externalService.create(externalRepo.target, {
      mode: "explicit",
      entry: { term: "Requested", definition: "must not overwrite" },
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.code, "GLOSSARY_CONFLICT");
    const after = await externalService.read(externalRepo.target);
    assert.equal(after.status === "valid" && after.entries[0].term, "External");

    const guardRepo = await createRepository();
    const guardService = new GlossaryApplicationService();
    const changedTarget = { ...guardRepo.target, rootRealPath: `${guardRepo.target.rootRealPath}-changed` };
    const denied = await guardService.create(
      guardRepo.target,
      { mode: "explicit", entry: { term: "Denied", definition: "binding changed" } },
      async () => changedTarget,
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.code, "GLOSSARY_TARGET_CHANGED");
  });

  it(".withmate symlinkまたはjunction越しのwriteを拒否する", async () => {
    const { root, target } = await createRepository();
    const outside = await mkdtemp(path.join(os.tmpdir(), "withmate-glossary-outside-"));
    temporaryDirectories.push(outside);
    await symlink(outside, path.join(root, ".withmate"), process.platform === "win32" ? "junction" : "dir");
    const service = new GlossaryApplicationService();
    const result = await service.create(target, {
      mode: "explicit",
      entry: { term: "Escape", definition: "must stay inside" },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "GLOSSARY_TARGET_INVALID");
    await assert.rejects(() => readFile(path.join(outside, "glossary.yaml"), "utf8"));
  });
});

describe("Glossary lookup and search projection", () => {
  it("term、alias、prefix、substring、definitionの順でrankingしYAML順をtie-breakにする", async () => {
    const { root, target } = await createRepository();
    await writeGlossary(root, [
      { term: "Definition only", aliases: [], definition: "runtime appears here" },
      { term: "Runtime suffix", aliases: [], definition: "third" },
      { term: "Session Runtime", aliases: [], definition: "substring" },
      { term: "Other", aliases: ["Runtime Alias"], definition: "alias prefix" },
      { term: "Runtime", aliases: [], definition: "term exact" },
    ]);
    const service = new GlossaryApplicationService();
    const result = await service.search(target, { query: "runtime", pageSize: 20 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.entries.map((entry) => entry.term), [
      "Runtime",
      "Runtime suffix",
      "Other",
      "Session Runtime",
      "Definition only",
    ]);
    const alias = await service.get(target, "ＲＵＮＴＩＭＥ　ＡＬＩＡＳ");
    assert.equal(alias.ok && alias.entry.term, "Other");
  });

  it("proactive createは欠落・不正・0・batch超過のSettings値でfallbackせず拒否する", async () => {
    const { target } = await createRepository();
    const service = new GlossaryApplicationService();
    for (const proactiveCreateLimit of [undefined, null, -1, 0, 101, 1.5]) {
      const result = await service.create(target, {
        mode: "proactive",
        proactiveCreateLimit,
        entry: { term: "Blocked", definition: "no fallback" },
      });
      assert.equal(result.ok, false, `limit ${String(proactiveCreateLimit)} must be rejected`);
    }
    const batch = await service.createBatch(target, {
      mode: "proactive",
      proactiveCreateLimit: 1,
      entries: [
        { term: "One", definition: "one" },
        { term: "Two", definition: "two" },
      ],
    });
    assert.equal(batch.ok, false);
    if (!batch.ok) assert.equal(batch.code, "GLOSSARY_LIMIT_EXCEEDED");
  });
});
