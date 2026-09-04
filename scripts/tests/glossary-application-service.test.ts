import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";

import {
  GlossaryApplicationService,
  parseGlossaryDocument,
  serializeGlossaryDocument,
  type ResolvedGlossaryCheckout,
} from "../../src-electron/glossary-application-service.js";
import {
  GLOSSARY_LIMITS,
  normalizeGlossaryLookup,
  type GlossaryEntry,
  type GlossaryProjectionState,
} from "../../src/glossary-contract.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function createRepository(): Promise<{ root: string; target: ResolvedGlossaryCheckout }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-glossary-"));
  temporaryDirectories.push(root);
  await execFileAsync("git", ["init", "--quiet", root], { windowsHide: true });
  const service = new GlossaryApplicationService();
  const target = await service.resolvePrimaryCheckout(root);
  return { root: target.rootPath, target };
}

async function writeGlossary(root: string, entries: readonly GlossaryEntry[]): Promise<string> {
  await mkdir(path.join(root, ".withmate"), { recursive: true });
  const raw = serializeGlossaryDocument(entries);
  await writeFile(path.join(root, ".withmate", "glossary.yaml"), raw, "utf8");
  return raw;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })));
});

describe("GLOSSARY-SOURCE-OF-TRUTH parser and projection", () => {
  // @test-value v1
  // kind = "contract"
  // claim = "valid Glossary projectionは表示文字列とYAML順を保持し、raw file contentのhashをrevisionとして返す"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "parserが表示値や順序を正規化して書換え、raw content変更をrevisionで検出できない"
  // scope = "canonical-glossary-read"
  // lifecycle = "permanent"
  // @end-test-value
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

  // @test-value v1
  // kind = "invariant"
  // claim = "statでsize上限超過が確定したGlossary fileは内容をreadせずboundedなinvalid projectionを返す"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "過大file全体をmemoryへ読み込み、read resource上限を破るか巨大なerror payloadを返す"
  // scope = "canonical-glossary-read-limit"
  // lifecycle = "permanent"
  // @end-test-value
  it("2MB超過がstatで確定したfileは内容を読み進めずbounded invalid projectionにする", async () => {
    const { root, target } = await createRepository();
    await mkdir(path.join(root, ".withmate"), { recursive: true });
    await writeFile(
      path.join(root, ".withmate", "glossary.yaml"),
      Buffer.alloc(GLOSSARY_LIMITS.maxFileBytes + 1, 0x61),
    );
    let contentReadCount = 0;
    const service = new GlossaryApplicationService({
      readFileHandle: async () => {
        contentReadCount += 1;
        throw new Error("oversized files must not be read");
      },
    });

    const snapshot = await service.read(target);

    assert.equal(snapshot.status, "invalid");
    assert.equal(contentReadCount, 0);
    assert.match(snapshot.revision ?? "", /^[a-f0-9]{64}$/);
    if (snapshot.status === "invalid") {
      assert.equal(snapshot.issues[0]?.code, "LIMIT_EXCEEDED");
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "Glossary fileがread中に増大した場合はopened sizeを上限としてsnapshot採用を拒否する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "grow後の追加bytesを無制限に読むか、途中時点の不整合snapshotをvalidとして返す"
  // scope = "canonical-glossary-read-consistency"
  // lifecycle = "permanent"
  // @end-test-value
  it("read中にfileがgrowしてもopened sizeだけをread上限にし、snapshotを採用しない", async () => {
    const { root, target } = await createRepository();
    const raw = await writeGlossary(root, [{ term: "Runtime", aliases: [], definition: "before" }]);
    const glossaryPath = path.join(root, ".withmate", "glossary.yaml");
    let observedReadLimit = -1;
    const service = new GlossaryApplicationService({
      readFileHandle: async (_handle, maxBytes) => {
        observedReadLimit = maxBytes;
        await writeFile(glossaryPath, Buffer.alloc(GLOSSARY_LIMITS.maxFileBytes + 1024, 0x62));
        return { raw, oversized: false };
      },
    });

    await assert.rejects(() => service.read(target), /changed during read/);
    assert.equal(observedReadLimit, Buffer.byteLength(raw, "utf8"));
  });

  // @test-value v1
  // kind = "contract"
  // claim = "Glossary validationはinvalid YAML、unsupported schema version、unknown fieldを別のissue codeで返す"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "異なる修復方法を要するschema failureを同じgeneric errorへ畳み、consumerが原因を特定できない"
  // scope = "canonical-glossary-validation"
  // lifecycle = "permanent"
  // @end-test-value
  it("invalid YAML、unsupported schema、unknown fieldを区別する", () => {
    assert.equal(parseGlossaryDocument("schemaVersion: [\n").status, "invalid");
    assert.equal(parseGlossaryDocument("schemaVersion: 2\nentries: []\n").status, "unsupported");
    const unknown = parseGlossaryDocument("schemaVersion: 1\nentries: []\ncache: []\n");
    assert.equal(unknown.status, "invalid");
    if (unknown.status === "invalid") {
      assert.equal(unknown.issues[0].code, "UNKNOWN_FIELD");
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "termとaliasはNFKC、case folding、空白正規化後に一意でなければGlossary file全体を拒否する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "見た目や検索上同一のtermとaliasを複数ownerへ割り当て、lookup結果が曖昧になる"
  // scope = "canonical-glossary-identity"
  // lifecycle = "permanent"
  // @end-test-value
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
  // @test-value v1
  // kind = "contract"
  // claim = "missing Glossaryのreadはfilesystemを変更せず、明示create mutationだけが.withmateとcanonical fileを作る"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "read operationがdirectoryを作るか、明示mutationなしでrepository stateを変更する"
  // scope = "canonical-glossary-create-boundary"
  // lifecycle = "permanent"
  // @end-test-value
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

  // @test-value v1
  // kind = "invariant"
  // claim = "同一checkoutへの並行createはcanonical mutation queueで直列化し、双方のentryを失わず保存する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "並行writeが同じbase revisionを上書きし、一方のcreated entryをlost updateで失う"
  // scope = "canonical-glossary-mutation-serialization"
  // lifecycle = "permanent"
  // @end-test-value
  it("同一checkoutへの並行createを直列化し、両方のentryを保持する", async () => {
    const { target } = await createRepository();
    let beforeRenameCount = 0;
    let markSecondRenameReached: (() => void) | null = null;
    const secondRenameReached = new Promise<void>((resolve) => {
      markSecondRenameReached = resolve;
    });
    const service = new GlossaryApplicationService({
      beforeRename: async () => {
        beforeRenameCount += 1;
        if (beforeRenameCount === 1) {
          await Promise.race([
            secondRenameReached,
            new Promise<void>((resolve) => setTimeout(resolve, 50)),
          ]);
        } else {
          markSecondRenameReached?.();
        }
      },
    });

    const [first, second] = await Promise.all([
      service.create(target, {
        mode: "explicit",
        entry: { term: "First", definition: "first definition" },
      }),
      service.create(target, {
        mode: "explicit",
        entry: { term: "Second", definition: "second definition" },
      }),
    ]);
    const snapshot = await service.read(target);

    assert.equal(first.ok && first.outcome, "applied");
    assert.equal(second.ok && second.outcome, "applied");
    assert.equal(snapshot.status, "valid");
    if (snapshot.status !== "valid") return;
    assert.deepEqual(snapshot.entries.map((entry) => entry.term), ["First", "Second"]);
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "Glossary mutationが失敗してもcheckout queue ownerを解放し、後続mutationを実行可能にする"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "failureしたpromiseがqueueを永久占有し、同一checkoutの後続operationが停止する"
  // scope = "canonical-glossary-mutation-lifecycle"
  // lifecycle = "permanent"
  // @end-test-value
  it("mutation failure後にcheckout queueを解放して後続操作を進める", async () => {
    const { target } = await createRepository();
    let renameCount = 0;
    const service = new GlossaryApplicationService({
      renamePath: async (oldPath, newPath) => {
        renameCount += 1;
        if (renameCount === 1) {
          throw new Error("injected rename failure");
        }
        await rename(oldPath, newPath);
      },
    });
    const failed = await service.create(target, {
      mode: "explicit",
      entry: { term: "Failed", definition: "not applied" },
    });
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const applied = await Promise.race([
      service.create(target, {
        mode: "explicit",
        entry: { term: "Applied", definition: "applied after failure" },
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("checkout mutation queue was not released")), 1_000);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });

    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.effect, "none");
    assert.equal(applied.ok && applied.outcome, "applied");
    const snapshot = await service.read(target);
    assert.equal(snapshot.status, "valid");
    if (snapshot.status !== "valid") return;
    assert.deepEqual(snapshot.entries.map((entry) => entry.term), ["Applied"]);
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "create retryは完全同一entryならconverged resultとし、同termで異なる内容ならconflictとして拒否する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "同一retryで重複entryを作るか、異なる定義を成功扱いして既存内容を暗黙上書きする"
  // scope = "canonical-glossary-create-idempotency"
  // lifecycle = "permanent"
  // @end-test-value
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

  // @test-value v1
  // kind = "invariant"
  // claim = "create-batch retryは全entry一致時だけconvergedとし、部分一致時は不足entryを追加せずbatch全体を拒否する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "部分retryが残りだけをcommitしてrequest全体のatomicityとeffect certaintyを曖昧にする"
  // scope = "canonical-glossary-batch-idempotency"
  // lifecycle = "permanent"
  // @end-test-value
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

  // @test-value v1
  // kind = "invariant"
  // claim = "Glossary updateはexpected revision後のexternal editをconflictにし、完全なpostcondition一致時だけconvergedとする"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "stale updateがexternal editを上書きするか、部分一致を適用済みとして誤報する"
  // scope = "canonical-glossary-update-concurrency"
  // lifecycle = "permanent"
  // @end-test-value
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

  // @test-value v1
  // kind = "regression"
  // claim = "termを維持するGlossary updateは対象entry自身を旧term残存conflictとして誤判定せず更新する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "更新対象自身のunchanged termを別entry衝突と判定し、validなdefinition変更を拒否する"
  // scope = "canonical-glossary-update-identity"
  // lifecycle = "permanent"
  // @end-test-value
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

  // @test-value v1
  // kind = "invariant"
  // claim = "Glossary delete retryは対象termとそのaliasがcanonical fileからすべて消えた場合だけconvergedとする"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "aliasが残る部分deleteを完了扱いするか、完全削除済みretryを不必要にfailureへする"
  // scope = "canonical-glossary-delete-idempotency"
  // lifecycle = "permanent"
  // @end-test-value
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

  // @test-value v1
  // kind = "security"
  // claim = "canonical Glossary fileがinvalidな場合はmutationで内容を上書きせずvalidation errorを返す"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "parse不能なuser dataをmutationが置換し、復旧可能な原文を不可逆に失う"
  // scope = "canonical-glossary-invalid-write"
  // lifecycle = "permanent"
  // @end-test-value
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

  // @test-value v1
  // kind = "invariant"
  // claim = "atomic renameがerrorを返した場合はpostcondition read-backによりeffectをapplied、none、unknownへ分類する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "commit後errorをeffect noneと誤報してretryによる二重mutationを招くか、未確認を成功扱いする"
  // scope = "canonical-glossary-effect-certainty"
  // lifecycle = "permanent"
  // @end-test-value
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

  // @test-value v1
  // kind = "invariant"
  // claim = "Glossary mutationはside effect直前にfile revisionとruntime guardを再検証し、変更があればwrite前に拒否する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "validation後からrename前のexternal editまたはauthority失効を上書きする"
  // scope = "canonical-glossary-precommit-guard"
  // lifecycle = "permanent"
  // @end-test-value
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

  // @test-value v1
  // kind = "security"
  // claim = "current Glossary fileの再読込中にruntime guardが失効した場合もatomic rename直前に再検証して拒否する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "再読込開始時だけauthorityを確認し、その後失効したbindingからwriteをcommitする"
  // scope = "canonical-glossary-runtime-guard"
  // lifecycle = "permanent"
  // @end-test-value
  it("current file再読込中に失効したruntime guardはrename直前に拒否する", async () => {
    const { root, target } = await createRepository();
    const changedTarget = { ...target, rootRealPath: `${target.rootRealPath}-changed` };
    let guardCalls = 0;
    let renameCalls = 0;
    const service = new GlossaryApplicationService({
      renamePath: async () => {
        renameCalls += 1;
      },
    });

    const denied = await service.create(
      target,
      { mode: "explicit", entry: { term: "Denied", definition: "binding expired during read" } },
      async () => {
        guardCalls += 1;
        return guardCalls >= 4 ? changedTarget : target;
      },
    );

    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.code, "GLOSSARY_TARGET_CHANGED");
    assert.equal(renameCalls, 0);
    await assert.rejects(() => readFile(path.join(root, ".withmate", "glossary.yaml"), "utf8"));
  });

  // @test-value v1
  // kind = "security"
  // claim = "Glossary mutationは.withmate path上のsymlinkまたはjunctionを拒否しrepository外へwriteしない"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "reparse point経由でprimary checkout外の任意fileを上書きする"
  // scope = "canonical-glossary-path-security"
  // lifecycle = "permanent"
  // @end-test-value
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
  // @test-value v1
  // kind = "contract"
  // claim = "Glossary searchはterm exact、alias exact、prefix、substring、definitionの優先順とYAML順tie-breakで結果を返す"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "同じqueryの検索順位が契約順から外れ、利用者がcanonical termを先に発見できない"
  // scope = "canonical-glossary-search-ranking"
  // lifecycle = "permanent"
  // @end-test-value
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

  // @test-value v1
  // kind = "security"
  // claim = "proactive createはlimit Settingsが欠落、不正、0、またはbatch件数未満ならdefaultへfallbackせず拒否する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "明示limitを推測値へ置換して許可量を超える自動mutationを実行する"
  // scope = "canonical-glossary-proactive-limit"
  // lifecycle = "permanent"
  // @end-test-value
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

describe("Glossary external update projection", () => {
  // @test-value v1
  // kind = "invariant"
  // claim = "Glossary watcherはeventごとにcurrent fileを再読込しvalid、invalid、missing、recoveryの各stateを通知する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "初回snapshotを使い続けてexternal editや削除、復旧をsubscriberへ反映しない"
  // scope = "canonical-glossary-watch-state"
  // lifecycle = "permanent"
  // @end-test-value
  it("watch eventごとにcurrent fileを再読込し、valid・invalid・missing・recoveryを投影する", async () => {
    const { root, target } = await createRepository();
    type FakeWatcher = {
      path: string;
      closed: boolean;
      change: (filename: string | null) => void;
      error: (error: Error) => void;
    };
    const watchers: FakeWatcher[] = [];
    const service = new GlossaryApplicationService({
      watchDebounceMs: 0,
      watchRetryMs: 0,
      watchPath: (targetPath, listener) => {
        const errorListeners: Array<(error: Error) => void> = [];
        const watcher: FakeWatcher = {
          path: targetPath,
          closed: false,
          change: (filename) => listener("rename", filename),
          error: (error) => errorListeners.forEach((errorListener) => errorListener(error)),
        };
        watchers.push(watcher);
        return {
          close: () => {
            watcher.closed = true;
          },
          on: (_event, errorListener) => {
            errorListeners.push(errorListener as (error: Error) => void);
            return undefined as never;
          },
        };
      },
    });
    const states: string[] = [];
    const dispose = service.subscribe(target, (state) => states.push(state.status));
    const waitForStateCount = async (count: number) => {
      for (let attempt = 0; attempt < 100 && states.length < count; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(states.length, count);
    };
    await writeGlossary(root, [{ term: "First", aliases: [], definition: "valid" }]);
    watchers.find((watcher) => watcher.path === root)?.change(".withmate");
    await waitForStateCount(1);

    await writeFile(path.join(root, ".withmate", "glossary.yaml"), "schemaVersion: [\n", "utf8");
    [...watchers].reverse().find((watcher) => !watcher.closed && watcher.path.endsWith(".withmate"))?.change("glossary.yaml");
    await waitForStateCount(2);

    await rm(path.join(root, ".withmate", "glossary.yaml"));
    [...watchers].reverse().find((watcher) => !watcher.closed && watcher.path.endsWith(".withmate"))?.change("glossary.yaml");
    await waitForStateCount(3);

    await writeGlossary(root, [{ term: "Recovered", aliases: [], definition: "valid again" }]);
    [...watchers].reverse().find((watcher) => !watcher.closed && watcher.path.endsWith(".withmate"))?.change("glossary.yaml");
    await waitForStateCount(4);

    assert.deepEqual(states, ["valid", "invalid", "missing", "valid"]);
    dispose();
    assert.equal(watchers.every((watcher) => watcher.closed), true);
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "active Glossary watcherがfailureした場合はlast valid snapshotを再送せずwatch-error stateを通知する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "監視不能をvalidなstale stateとして隠し、consumerが更新停止を検知できない"
  // scope = "canonical-glossary-watch-failure"
  // lifecycle = "permanent"
  // @end-test-value
  it("watcher failureはstale snapshotではなくwatch-errorを返す", async () => {
    const { root, target } = await createRepository();
    const errors: Array<(error: Error) => void> = [];
    const service = new GlossaryApplicationService({
      watchPath: () => ({
        close() {},
        on: (_event, listener) => {
          errors.push(listener as (error: Error) => void);
          return undefined as never;
        },
      }),
    });
    const states: string[] = [];
    const dispose = service.subscribe(target, (state) => states.push(state.status));
    await writeGlossary(root, [{ term: "Stale", aliases: [], definition: "must not remain" }]);
    errors[0]?.(new Error("watch failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(states, ["watch-error"]);
    dispose();
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "初回directory watcher開始失敗はwatch-errorを通知し、外部filesystem eventなしでも再試行して回復する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "watch開始失敗後に永久停止し、利用者がfileを変更してもprojectionが復旧しない"
  // scope = "canonical-glossary-watch-recovery"
  // lifecycle = "permanent"
  // @end-test-value
  it("初回directory watcher失敗を通知し外部eventなしで自動回復する", async () => {
    const { root, target } = await createRepository();
    await writeGlossary(root, [{ term: "Recovered", aliases: [], definition: "current value" }]);
    let directoryAttempts = 0;
    const watchers: Array<{ path: string; closed: boolean }> = [];
    const service = new GlossaryApplicationService({
      watchRetryMs: 10,
      watchPath: (targetPath) => {
        if (targetPath === path.join(root, ".withmate")) {
          directoryAttempts += 1;
          if (directoryAttempts === 1) {
            throw new Error("initial directory watch failed");
          }
        }
        const watcher = { path: targetPath, closed: false };
        watchers.push(watcher);
        return {
          close: () => {
            watcher.closed = true;
          },
          on: () => undefined as never,
        };
      },
    });
    const states: GlossaryProjectionState[] = [];
    const dispose = service.subscribe(target, (state) => states.push(state));
    const waitUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(predicate(), true);
    };

    await waitUntil(() => states.some((state) => state.status === "watch-error"));
    await waitUntil(() => states.some((state) => state.status === "valid"));

    assert.ok(directoryAttempts >= 2);
    const recovered = states.findLast((state) => state.status === "valid");
    assert.ok(recovered && recovered.status === "valid");
    assert.deepEqual(recovered.entries.map((entry) => entry.term), ["Recovered"]);
    dispose();
    assert.equal(watchers.every((watcher) => watcher.closed), true);
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "repository root watcher failure後もsubscriptionを再構築し、missing Glossary作成を検知してvalidへ復旧する"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md" }
  // failure_mode = "root watcher失効後に再購読せず、後から作成されたcanonical fileを検知できない"
  // scope = "canonical-glossary-root-watch-recovery"
  // lifecycle = "permanent"
  // @end-test-value
  it("root watcher failure後も購読を張り直してmissingから復旧する", async () => {
    const { root, target } = await createRepository();
    type FakeWatcher = {
      path: string;
      closed: boolean;
      change: (filename: string | null) => void;
      error: (error: Error) => void;
    };
    const watchers: FakeWatcher[] = [];
    const service = new GlossaryApplicationService({
      watchDebounceMs: 0,
      watchRetryMs: 0,
      watchPath: (targetPath, listener) => {
        const errorListeners: Array<(error: Error) => void> = [];
        const watcher: FakeWatcher = {
          path: targetPath,
          closed: false,
          change: (filename) => listener("rename", filename),
          error: (error) => errorListeners.forEach((errorListener) => errorListener(error)),
        };
        watchers.push(watcher);
        return {
          close: () => {
            watcher.closed = true;
          },
          on: (_event, errorListener) => {
            errorListeners.push(errorListener as (error: Error) => void);
            return undefined as never;
          },
        };
      },
    });
    const states: string[] = [];
    const dispose = service.subscribe(target, (state) => states.push(state.status));
    const waitUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(predicate(), true);
    };

    const initialRootWatcher = watchers.find((watcher) => watcher.path === root);
    assert.ok(initialRootWatcher);
    initialRootWatcher.error(new Error("root watch failed"));
    await waitUntil(() => watchers.filter((watcher) => watcher.path === root).length >= 2);

    await writeGlossary(root, [{ term: "Recovered", aliases: [], definition: "valid again" }]);
    const recoveredRootWatcher = [...watchers]
      .reverse()
      .find((watcher) => watcher.path === root && !watcher.closed);
    assert.ok(recoveredRootWatcher);
    recoveredRootWatcher.change(".withmate");
    await waitUntil(() => states.at(-1) === "valid");

    assert.equal(states[0], "watch-error");
    dispose();
    assert.equal(watchers.every((watcher) => watcher.closed), true);
  });
});
