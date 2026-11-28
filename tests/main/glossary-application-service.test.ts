import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";

import {
  GlossaryApplicationService,
  parseGlossaryDocument,
  serializeGlossaryDocument,
  type ResolvedGlossaryCheckout,
} from "../../src-electron/glossary/glossary-application-service.js";
import {
  GLOSSARY_LIMITS,
  normalizeGlossaryLookup,
  type GlossaryEntry,
  type GlossaryProjectionState,
} from "../../src-shared/glossary/glossary-contract.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

/** 一時 Git リポジトリを初期化し、サービスで解決した実際のチェックアウトを返す。 */
async function createRepository(): Promise<{
  root: string;
  target: ResolvedGlossaryCheckout;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-glossary-"));
  temporaryDirectories.push(root);
  await execFileAsync("git", ["init", "--quiet", root], { windowsHide: true });
  const service = new GlossaryApplicationService();
  const target = await service.resolvePrimaryCheckout(root);
  return { root: target.rootPath, target };
}

/** 入力した用語を正本の YAML 形式で書き出し、比較用に元の文字列を返す。 */
async function writeGlossary(
  root: string,
  entries: readonly GlossaryEntry[],
): Promise<string> {
  await mkdir(path.join(root, ".withmate"), { recursive: true });
  const raw = serializeGlossaryDocument(entries);
  await writeFile(path.join(root, ".withmate", "glossary.yaml"), raw, "utf8");
  return raw;
}

/** 各検査の一時リポジトリと外部参照用ディレクトリを、短い再試行付きで回収する。 */
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    ),
  );
});

/** YAML の解釈、サイズ上限、検索キーの正規化を公開結果から検査する。 */
describe("GLOSSARY-SOURCE-OF-TRUTH parser and projection", () => {
  /** 表示用の本文と YAML の項目順を残し、正本のリビジョンをハッシュ形式で返す。 */
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
    assert.deepEqual(
      snapshot.entries.map((entry) => entry.term),
      ["Session Runtime", "Agent Binding"],
    );
    assert.equal(
      snapshot.entries[0].definition,
      "**not markdown**\n<script>alert(1)</script>",
    );
    assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
  });

  /** ファイルの属性だけで超過が分かれば、本文を取得せず上限超過を返す。 */
  it("2MB超過がstatで確定したfileは内容を読み進めずbounded invalid projectionにする", async () => {
    const { root, target } = await createRepository();
    await mkdir(path.join(root, ".withmate"), { recursive: true });
    await writeFile(
      path.join(root, ".withmate", "glossary.yaml"),
      Buffer.alloc(GLOSSARY_LIMITS.maxFileBytes + 1, 0x61),
    );
    let contentReadCount = 0;
    const service = new GlossaryApplicationService({
      /** 巨大ファイルの拒否が読み取り処理より先か、呼び出し回数で確かめる。 */
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

  /** 読み取り開始時のバイト数を上限に使い、途中で増えたファイルの結果を採用しない。 */
  it("read中にfileがgrowしてもopened sizeだけをread上限にし、snapshotを採用しない", async () => {
    const { root, target } = await createRepository();
    const raw = await writeGlossary(root, [
      { term: "Runtime", aliases: [], definition: "before" },
    ]);
    const glossaryPath = path.join(root, ".withmate", "glossary.yaml");
    let observedReadLimit = -1;
    const service = new GlossaryApplicationService({
      /** 渡された読み取り上限を記録し、結果を返す前に再検証対象のファイルを拡大する。 */
      readFileHandle: async (_handle, maxBytes) => {
        observedReadLimit = maxBytes;
        await writeFile(
          glossaryPath,
          Buffer.alloc(GLOSSARY_LIMITS.maxFileBytes + 1024, 0x62),
        );
        return { raw, oversized: false };
      },
    });

    await assert.rejects(() => service.read(target), /changed during read/);
    assert.equal(observedReadLimit, Buffer.byteLength(raw, "utf8"));
  });

  /** 構文不正、未対応版、未知の設定項目を異なる結果で報告する。 */
  it("invalid YAML、unsupported schema、unknown fieldを区別する", () => {
    assert.equal(parseGlossaryDocument("schemaVersion: [\n").status, "invalid");
    assert.equal(
      parseGlossaryDocument("schemaVersion: 2\nentries: []\n").status,
      "unsupported",
    );
    const unknown = parseGlossaryDocument(
      "schemaVersion: 1\nentries: []\ncache: []\n",
    );
    assert.equal(unknown.status, "invalid");
    if (unknown.status === "invalid") {
      assert.equal(unknown.issues[0].code, "UNKNOWN_FIELD");
    }
  });

  /** 異なる表記の別名が検索正規化後に同一となるファイルを拒否する。 */
  it("NFKC・case・連続空白後にtermとaliasが曖昧になるfileを拒否する", () => {
    assert.equal(
      normalizeGlossaryLookup("  ＳＥＳＳＩＯＮ　 Runtime  "),
      "session runtime",
    );
    const snapshot = parseGlossaryDocument(
      [
        "schemaVersion: 1",
        "entries:",
        "  - term: Session Runtime",
        "    aliases: [Runtime]",
        "    definition: first",
        "  - term: Other",
        "    aliases: [ＲＵＮＴＩＭＥ]",
        "    definition: second",
        "",
      ].join("\n"),
    );
    assert.equal(snapshot.status, "invalid");
    if (snapshot.status === "invalid") {
      assert.ok(
        snapshot.issues.some((issue) => issue.code === "AMBIGUOUS_LOOKUP"),
      );
    }
  });
});

/** 用語集の明示作成、更新、削除の競合と、書き込み境界の判定を実ファイルで検査する。 */
describe("GLOSSARY-ATOMIC-MUTATION file service", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "projection用の非Git state追加後もGlossary operationのtarget invalid codeを維持する"
  // oracle = { type = "contract", ref = "src-electron/glossary/glossary-application-service.ts: safeOperation" }
  // fault = "非Git checkoutの再検証をGLOSSARY_IO_ERRORへ変換し、既存MCP operation error契約を変える"
  // observable = "list operation error codeとmessage"
  // observation_boundary = "public-boundary"
  // scope = "glossary-non-git-operation-error-compatibility"
  // lifecycle = "permanent"
  // distinction = "projection stateのnot-applicableとoperation-level target invalid errorを同じ非Git条件で分離する"
  // @end-test-value
  /** 非 Git になったチェックアウトへの操作では、表示用状態でなく従来の対象エラーを返す。 */
  it("非Git再検証はoperation-levelで従来のtarget invalid errorを返す", async () => {
    const { root, target } = await createRepository();
    await rm(path.join(root, ".git"), { recursive: true, force: true });
    const service = new GlossaryApplicationService({
      /** Git による再検証がチェックアウトの消失を検出したときの応答を再現する。 */
      runGit: async () => {
        throw Object.assign(
          new Error(
            "fatal: not a git repository (or any of the parent directories): .git",
          ),
          {
            code: 128,
            stderr:
              "fatal: not a git repository (or any of the parent directories): .git",
          },
        );
      },
    });

    const result = await service.list(target);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "GLOSSARY_TARGET_INVALID");
      assert.equal(
        result.message,
        "Primary workspace is not a supported Git checkout.",
      );
    }
  });

  /** 正本がない状態の読み取りでは作成せず、明示的に登録したときだけ用語集を保存する。 */
  it("missing readは.withmateを作らず、explicit createだけがfileを作る", async () => {
    const { root, target } = await createRepository();
    const service = new GlossaryApplicationService();

    assert.deepEqual(await service.read(target), {
      status: "missing",
      relativePath: ".withmate/glossary.yaml",
      revision: null,
    });
    await assert.rejects(() =>
      readFile(path.join(root, ".withmate", "glossary.yaml"), "utf8"),
    );

    const created = await service.create(target, {
      mode: "explicit",
      entry: {
        term: "Session Runtime",
        aliases: ["Runtime"],
        definition: "plain text",
      },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.outcome, "applied");
    assert.equal(created.effect, "applied");
    const raw = await readFile(
      path.join(root, ".withmate", "glossary.yaml"),
      "utf8",
    );
    assert.doesNotMatch(raw, /revision|normalized|preview/);
  });

  /** 同じ正本への並行登録を直列化し、後の操作が先の項目を上書きしないようにする。 */
  it("同一checkoutへの並行createを直列化し、両方のentryを保持する", async () => {
    const { target } = await createRepository();
    let beforeRenameCount = 0;
    let markSecondRenameReached: (() => void) | null = null;
    const secondRenameReached = new Promise<void>((resolve) => {
      markSecondRenameReached = resolve;
    });
    const service = new GlossaryApplicationService({
      /** 先行するリネーム直前で短く待機し、後続操作が並行して進めるか観測する。 */
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
    assert.deepEqual(
      snapshot.entries.map((entry) => entry.term),
      ["First", "Second"],
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "同じcheckoutで先行mutationのrenameが失敗しても待機中のcreateが完了し、成功したentryだけが保存される"
  // oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md#glossary-atomic-mutation" }
  // fault = "先行mutationの失敗時にqueueを解放せず後続createが完了しない、または失敗したentryを保存する"
  // observable = "並行createの失敗effect・成功outcomeとreadで取得したentry集合"
  // observation_boundary = "public-boundary"
  // scope = "glossary-checkout-mutation-failure-release"
  // lifecycle = "permanent"
  // distinction = "成功する並行mutationの直列化testと異なり、実file renameの失敗後も待機中の操作が進むことを確認する"
  // @end-test-value
  /** 先頭のリネーム失敗でチェックアウトの待ち行列を止めず、後続だけを保存する。 */
  it(
    "mutation failure後にcheckout queueを解放して後続操作を進める",
    { timeout: 30_000 },
    async () => {
      const { target } = await createRepository();
      let renameCount = 0;
      const service = new GlossaryApplicationService({
        /** 初回だけ保存を失敗させ、二回目からは実ファイルのリネームに委譲する。 */
        renamePath: async (oldPath, newPath) => {
          renameCount += 1;
          if (renameCount === 1) {
            throw new Error("injected rename failure");
          }
          await rename(oldPath, newPath);
        },
      });
      const [failed, applied] = await Promise.all([
        service.create(target, {
          mode: "explicit",
          entry: { term: "Failed", definition: "not applied" },
        }),
        service.create(target, {
          mode: "explicit",
          entry: { term: "Applied", definition: "applied after failure" },
        }),
      ]);

      assert.equal(failed.ok, false);
      if (!failed.ok) assert.equal(failed.effect, "none");
      assert.equal(applied.ok && applied.outcome, "applied");
      const snapshot = await service.read(target);
      assert.equal(snapshot.status, "valid");
      if (snapshot.status !== "valid") return;
      assert.deepEqual(
        snapshot.entries.map((entry) => entry.term),
        ["Applied"],
      );
    },
  );

  /** 完全に同じ登録の再試行を無変更とし、正規化後の用語や別名の衝突を拒否する。 */
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
    if (!aliasConflict.ok)
      assert.equal(aliasConflict.code, "GLOSSARY_CONFLICT");
  });

  /** 一括登録を再試行したとき、一部だけ存在しても不足項目を勝手に追加しない。 */
  it("create-batch retryは全件一致だけconvergedし、部分一致では不足分を追加しない", async () => {
    const { root, target } = await createRepository();
    const service = new GlossaryApplicationService();
    const entries = [
      { term: "First", definition: "one" },
      { term: "Second", definition: "two" },
    ];
    const first = await service.createBatch(target, {
      mode: "explicit",
      entries,
    });
    const retry = await service.createBatch(target, {
      mode: "explicit",
      entries,
    });
    assert.equal(first.ok && first.outcome, "applied");
    assert.equal(retry.ok && retry.outcome, "converged");

    const snapshot = await service.read(target);
    assert.equal(snapshot.status, "valid");
    if (snapshot.status !== "valid") return;
    await writeGlossary(root, [snapshot.entries[0]]);
    const partial = await service.createBatch(target, {
      mode: "explicit",
      entries,
    });
    assert.equal(partial.ok, false);
    if (!partial.ok) assert.equal(partial.code, "GLOSSARY_CONFLICT");
    const after = await service.read(target);
    assert.equal(after.status === "valid" && after.entries.length, 1);
  });

  /** 外部変更後は更新を競合とし、要求した項目全体が既に適用済みなら無変更と判定する。 */
  it("external revision後のupdateはconflictし、適用済みの完全entryだけconvergedする", async () => {
    const { root, target } = await createRepository();
    const service = new GlossaryApplicationService();
    await writeGlossary(root, [
      { term: "Old", aliases: [], definition: "before" },
    ]);
    const before = await service.read(target);
    assert.equal(before.status, "valid");
    if (before.status !== "valid") return;

    await writeGlossary(root, [
      { term: "Old", aliases: [], definition: "external" },
    ]);
    const conflict = await service.update(target, {
      expectedRevision: before.revision,
      targetTerm: "Old",
      entry: { term: "New", definition: "after" },
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.code, "GLOSSARY_CONFLICT");

    await writeGlossary(root, [
      { term: "New", aliases: [], definition: "after" },
    ]);
    const converged = await service.update(target, {
      expectedRevision: before.revision,
      targetTerm: "Old",
      entry: { term: "New", definition: "after" },
    });
    assert.equal(converged.ok && converged.outcome, "converged");
    assert.equal(converged.ok && converged.effect, "none");
  });

  /** 用語名を保持する更新が既に反映済みなら、旧名が残った競合として扱わない。 */
  it("termを変えないupdateは同じentryを旧term残存と誤判定しない", async () => {
    const { root, target } = await createRepository();
    const service = new GlossaryApplicationService();
    const raw = await writeGlossary(root, [
      { term: "Same", aliases: [], definition: "after" },
    ]);
    const result = await service.update(target, {
      expectedRevision: "0".repeat(64),
      targetTerm: "Same",
      entry: { term: "Same", definition: "after" },
    });
    assert.equal(result.ok && result.outcome, "converged");
    assert.equal(
      await readFile(path.join(root, ".withmate", "glossary.yaml"), "utf8"),
      raw,
    );
  });

  /** 削除予定の用語が見つからなければ再試行を収束とし、同じ検索キーが残るなら拒否する。 */
  it("delete retryはtermとaliasが消えた時だけconvergedする", async () => {
    const { root, target } = await createRepository();
    const service = new GlossaryApplicationService();
    await writeGlossary(root, [
      { term: "Delete Me", aliases: ["DM"], definition: "remove" },
    ]);
    const before = await service.read(target);
    assert.equal(before.status, "valid");
    if (before.status !== "valid") return;

    await writeGlossary(root, []);
    const converged = await service.delete(target, {
      expectedRevision: before.revision,
      targetTerm: "Delete Me",
    });
    assert.equal(converged.ok && converged.outcome, "converged");

    await writeGlossary(root, [
      { term: "Other", aliases: ["Delete Me"], definition: "collision" },
    ]);
    const conflict = await service.delete(target, {
      expectedRevision: before.revision,
      targetTerm: "Delete Me",
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.code, "GLOSSARY_CONFLICT");
  });

  /** 壊れた YAML に操作エラーを返し、修復前の元データをそのまま残す。 */
  it("invalid fileをmutationで上書きしない", async () => {
    const { root, target } = await createRepository();
    const service = new GlossaryApplicationService();
    await mkdir(path.join(root, ".withmate"));
    const invalidRaw = "schemaVersion: [\n";
    await writeFile(
      path.join(root, ".withmate", "glossary.yaml"),
      invalidRaw,
      "utf8",
    );
    const result = await service.create(target, {
      mode: "explicit",
      entry: { term: "Safe", definition: "must not overwrite" },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "GLOSSARY_INVALID_FILE");
    assert.equal(
      await readFile(path.join(root, ".withmate", "glossary.yaml"), "utf8"),
      invalidRaw,
    );
  });

  /** リネーム例外後の再読込で、適用済み、未適用、結果不明を分ける。 */
  it("rename errorはpostcondition read-backでapplied、none、unknownを分類する", async () => {
    const appliedRepo = await createRepository();
    const appliedService = new GlossaryApplicationService({
      /** リネームを完了した後でだけ失敗を返し、応答を失った適用済み状態を作る。 */
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
      /** 正本を触らず、権限エラーでリネームに失敗する。 */
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
      /** 意図しない別内容を残してから失敗を返し、副作用の判定ができない状態を作る。 */
      renamePath: async (_source, destination) => {
        await writeFile(
          destination,
          serializeGlossaryDocument([
            { term: "Other", aliases: [], definition: "race" },
          ]),
          "utf8",
        );
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

  /** 保存直前に変わった正本や実行時の対象を検知し、古い前提で書き込まない。 */
  it("side effect直前のexternal editとruntime guard変更を拒否する", async () => {
    const externalRepo = await createRepository();
    const externalService = new GlossaryApplicationService({
      /** リネームの直前に外部編集で別の正本を置く。 */
      beforeRename: async () => {
        await writeGlossary(externalRepo.root, [
          { term: "External", aliases: [], definition: "wins" },
        ]);
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
    const changedTarget = {
      ...guardRepo.target,
      rootRealPath: `${guardRepo.target.rootRealPath}-changed`,
    };
    const denied = await guardService.create(
      guardRepo.target,
      {
        mode: "explicit",
        entry: { term: "Denied", definition: "binding changed" },
      },
      async () => changedTarget,
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.code, "GLOSSARY_TARGET_CHANGED");
  });

  /** 正本の再読み込み中に対象の同一性が失われた場合も書き込みを開始しない。 */
  it("current file再読込中に失効したruntime guardはrename直前に拒否する", async () => {
    const { root, target } = await createRepository();
    const changedTarget = {
      ...target,
      rootRealPath: `${target.rootRealPath}-changed`,
    };
    let guardCalls = 0;
    let renameCalls = 0;
    const service = new GlossaryApplicationService({
      /** 拒否された要求がリネーム処理まで達していないかを数える。 */
      renamePath: async () => {
        renameCalls += 1;
      },
    });

    const denied = await service.create(
      target,
      {
        mode: "explicit",
        entry: { term: "Denied", definition: "binding expired during read" },
      },
      async () => {
        guardCalls += 1;
        return guardCalls >= 4 ? changedTarget : target;
      },
    );

    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.code, "GLOSSARY_TARGET_CHANGED");
    assert.equal(renameCalls, 0);
    await assert.rejects(() =>
      readFile(path.join(root, ".withmate", "glossary.yaml"), "utf8"),
    );
  });

  /** 正本用ディレクトリが外部へのリンクなら、作成を拒否してリンク先を変更しない。 */
  it(".withmate symlinkまたはjunction越しのwriteを拒否する", async () => {
    const { root, target } = await createRepository();
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "withmate-glossary-outside-"),
    );
    temporaryDirectories.push(outside);
    await symlink(
      outside,
      path.join(root, ".withmate"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const service = new GlossaryApplicationService();
    const result = await service.create(target, {
      mode: "explicit",
      entry: { term: "Escape", definition: "must stay inside" },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "GLOSSARY_TARGET_INVALID");
    await assert.rejects(() =>
      readFile(path.join(outside, "glossary.yaml"), "utf8"),
    );
  });
});

/** 検索順位と完全一致の取得、および能動登録の上限を検査する。 */
describe("Glossary lookup and search projection", () => {
  /** 完全一致、用語と別名の前方一致、部分一致、定義の順に検索結果を照合する。 */
  it("term、alias、prefix、substring、definitionの順でrankingしYAML順をtie-breakにする", async () => {
    const { root, target } = await createRepository();
    await writeGlossary(root, [
      {
        term: "Definition only",
        aliases: [],
        definition: "runtime appears here",
      },
      { term: "Runtime suffix", aliases: [], definition: "third" },
      { term: "Session Runtime", aliases: [], definition: "substring" },
      { term: "Other", aliases: ["Runtime Alias"], definition: "alias prefix" },
      { term: "Runtime", aliases: [], definition: "term exact" },
    ]);
    const service = new GlossaryApplicationService();
    const result = await service.search(target, {
      query: "runtime",
      pageSize: 20,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.entries.map((entry) => entry.term),
      [
        "Runtime",
        "Runtime suffix",
        "Other",
        "Session Runtime",
        "Definition only",
      ],
    );
    const alias = await service.get(target, "ＲＵＮＴＩＭＥ　ＡＬＩＡＳ");
    assert.equal(alias.ok && alias.entry.term, "Other");
  });

  /** 能動登録の上限が不正または不足していれば、既定値に置き換えず一括操作も拒否する。 */
  it("proactive createは欠落・不正・0・batch超過のSettings値でfallbackせず拒否する", async () => {
    const { target } = await createRepository();
    const service = new GlossaryApplicationService();
    for (const proactiveCreateLimit of [undefined, null, -1, 0, 101, 1.5]) {
      const result = await service.create(target, {
        mode: "proactive",
        proactiveCreateLimit,
        entry: { term: "Blocked", definition: "no fallback" },
      });
      assert.equal(
        result.ok,
        false,
        `limit ${String(proactiveCreateLimit)} must be rejected`,
      );
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

/** 外部変更、監視エラー、再購読を現行の公開状態の遷移として検査する。 */
describe("Glossary external update projection", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "Glossary watcherは各eventでcurrent fileのcontentとrevisionを再読込しvalid・invalid・missing・recoveryを投影する"
  // oracle = { type = "contract", ref = "src-electron/glossary/glossary-application-service.ts: watch projection" }
  // fault = "stale snapshotを保持して変更を隠す、またはrecovery後もmissing/error表示を残す"
  // observable = "projected glossary status、latest content、revisionとwatcher lifecycle"
  // observation_boundary = "public-boundary"
  // scope = "glossary-watch-projection"
  // lifecycle = "permanent"
  // distinction = "単一read成功では検出できないwatch eventの状態遷移を検証する"
  // @end-test-value
  /** 監視通知ごとに正本を再読込し、不正・欠損・復旧を最新の内容で公開する。 */
  it("watch eventごとにcurrent fileを再読込し、valid・invalid・missing・recoveryを投影する", async () => {
    const { root, target } = await createRepository();
    /** パス、終了状態、変更通知とエラー通知を直接制御する監視の代替型。 */
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
      /** 生成された監視先を記録し、変更とエラーをテストから通知できるようにする。 */
      watchPath: (targetPath, listener) => {
        const errorListeners: Array<(error: Error) => void> = [];
        const watcher: FakeWatcher = {
          path: targetPath,
          closed: false,
          /** 実際の監視 API と同じ形式の名前変更通知を渡す。 */
          change: (filename) => listener("rename", filename),
          /** 保持したリスナーに手動の監視エラーを伝える。 */
          error: (error) =>
            errorListeners.forEach((errorListener) => errorListener(error)),
        };
        watchers.push(watcher);
        return {
          /** 購読解除で監視が終了したかどうかを記録する。 */
          close: () => {
            watcher.closed = true;
          },
          /** 監視サービスが登録したエラーリスナーを保持する。 */
          on: (_event: string, errorListener: (error: Error) => void) => {
            errorListeners.push(errorListener as (error: Error) => void);
            return undefined as never;
          },
        };
      },
    });
    const states: GlossaryProjectionState[] = [];
    const dispose = service.subscribe(target, (state) => states.push(state));
    /** 非同期の状態通知を指定件数まで待ち、それ以上または未達も失敗とする。 */
    const waitForStateCount = async (count: number) => {
      for (
        let attempt = 0;
        attempt < 100 && states.length < count;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(states.length, count);
    };
    await writeGlossary(root, [
      { term: "First", aliases: [], definition: "valid" },
    ]);
    watchers.find((watcher) => watcher.path === root)?.change(".withmate");
    await waitForStateCount(1);

    await writeFile(
      path.join(root, ".withmate", "glossary.yaml"),
      "schemaVersion: [\n",
      "utf8",
    );
    [...watchers]
      .reverse()
      .find((watcher) => !watcher.closed && watcher.path.endsWith(".withmate"))
      ?.change("glossary.yaml");
    await waitForStateCount(2);

    await rm(path.join(root, ".withmate", "glossary.yaml"));
    [...watchers]
      .reverse()
      .find((watcher) => !watcher.closed && watcher.path.endsWith(".withmate"))
      ?.change("glossary.yaml");
    await waitForStateCount(3);

    await writeGlossary(root, [
      { term: "Recovered", aliases: [], definition: "valid again" },
    ]);
    [...watchers]
      .reverse()
      .find((watcher) => !watcher.closed && watcher.path.endsWith(".withmate"))
      ?.change("glossary.yaml");
    await waitForStateCount(4);

    assert.deepEqual(
      states.map((state) => state.status),
      ["valid", "invalid", "missing", "valid"],
    );
    const firstValid = states[0];
    const recovered = states[3];
    assert.equal(firstValid?.status, "valid");
    assert.equal(recovered?.status, "valid");
    if (firstValid?.status === "valid" && recovered?.status === "valid") {
      assert.deepEqual(
        firstValid.entries.map((entry) => entry.term),
        ["First"],
      );
      assert.deepEqual(
        recovered.entries.map((entry) => entry.term),
        ["Recovered"],
      );
      assert.notEqual(firstValid.revision, recovered.revision);
    }
    dispose();
    assert.equal(
      watchers.every((watcher) => watcher.closed),
      true,
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Glossary watcher failureはstale snapshotではなくwatch-errorとして投影する"
  // oracle = { type = "contract", ref = "src-electron/glossary/glossary-application-service.ts: watch error" }
  // fault = "失敗後に古いGlossaryを現行値として表示し、利用者へ不整合を隠す"
  // observable = "error stateとcurrent snapshot"
  // observation_boundary = "public-boundary"
  // scope = "glossary-watch-failure"
  // lifecycle = "permanent"
  // distinction = "正常watch更新では検出できないread failureの公開状態を検証する"
  // @end-test-value
  /** 監視に失敗したら、以前の項目を現行値として残さず監視エラーを公開する。 */
  it("watcher failureはstale snapshotではなくwatch-errorを返す", async () => {
    const { root, target } = await createRepository();
    const errors: Array<(error: Error) => void> = [];
    const changes: Array<(event: string, filename: string | null) => void> = [];
    const service = new GlossaryApplicationService({
      /** 正常な変更から監視エラーへ切り替えるため、二種類のリスナーを捕捉する。 */
      watchPath: (_targetPath, listener) => {
        changes.push(listener);
        return {
          /** 外部リソースのない代替監視を閉じるための空の処理。 */
          close() {},
          /** 失敗を後から発生させるため、購読側のエラーハンドラーを記録する。 */
          on: (_event: string, listener: (error: Error) => void) => {
            errors.push(listener as (error: Error) => void);
            return undefined as never;
          },
        };
      },
    });
    await writeGlossary(root, [
      { term: "Stale", aliases: [], definition: "must not remain" },
    ]);
    const states: GlossaryProjectionState[] = [];
    const dispose = service.subscribe(target, (state) => states.push(state));
    changes[0]?.("rename", ".withmate");
    for (let attempt = 0; attempt < 100 && states.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(states[0]?.status, "valid");
    errors[0]?.(new Error("watch failed"));
    for (let attempt = 0; attempt < 100 && states.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(
      states.map((state) => state.status),
      ["valid", "watch-error"],
    );
    const watchError = states[1];
    assert.ok(watchError);
    assert.equal(watchError.revision, null);
    assert.equal("entries" in watchError, false);
    dispose();
  });

  /** 正本用ディレクトリの初回監視に失敗しても、外部イベントなしで再試行し復旧する。 */
  it("初回directory watcher失敗を通知し外部eventなしで自動回復する", async () => {
    const { root, target } = await createRepository();
    await writeGlossary(root, [
      { term: "Recovered", aliases: [], definition: "current value" },
    ]);
    let directoryAttempts = 0;
    const watchers: Array<{ path: string; closed: boolean }> = [];
    const service = new GlossaryApplicationService({
      watchRetryMs: 10,
      /** 正本用ディレクトリだけは初回に失敗させ、再試行で監視を成立させる。 */
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
          /** 回復後の購読解除で監視が閉じたことを知らせる。 */
          close: () => {
            watcher.closed = true;
          },
          /** この検査は作成時の失敗だけを注入するため、イベント登録は不要とする。 */
          on: () => undefined as never,
        };
      },
    });
    const states: GlossaryProjectionState[] = [];
    const dispose = service.subscribe(target, (state) => states.push(state));
    /** 監視状態が期待した条件に変わるまで短い間隔で待つ。 */
    const waitUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(predicate(), true);
    };

    await waitUntil(() =>
      states.some((state) => state.status === "watch-error"),
    );
    await waitUntil(() => states.some((state) => state.status === "valid"));

    assert.ok(directoryAttempts >= 2);
    const recovered = states.findLast((state) => state.status === "valid");
    assert.ok(recovered && recovered.status === "valid");
    assert.deepEqual(
      recovered.entries.map((entry) => entry.term),
      ["Recovered"],
    );
    dispose();
    assert.equal(
      watchers.every((watcher) => watcher.closed),
      true,
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "root watcher failure後も購読を張り直しwatch-errorからvalidへ復旧する"
  // oracle = { type = "contract", ref = "src-electron/glossary/glossary-application-service.ts: root watcher" }
  // fault = "watcherを再購読せず、root復旧後もwatch-error状態をvalidへ更新できない"
  // observable = "watcher count、watch-errorからvalidへの状態遷移、recovery content"
  // observation_boundary = "public-boundary"
  // scope = "glossary-root-watcher-recovery"
  // lifecycle = "permanent"
  // distinction = "単発watch failureでは検出できない再購読とvalid復旧の連続動作を検証する"
  // @end-test-value
  /** ルート監視の失敗後も再購読し、次の変更通知で復旧した正本を公開する。 */
  it("root watcher failure後も購読を張り直してwatch-errorからvalidへ復旧する", async () => {
    const { root, target } = await createRepository();
    /** 旧監視と再購読をパスや破棄状態から区別し、疑似通知も送れるようにする。 */
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
      /** ルートの再購読回数と、生成された監視の解放を観測できるようにする。 */
      watchPath: (targetPath, listener) => {
        const errorListeners: Array<(error: Error) => void> = [];
        const watcher: FakeWatcher = {
          path: targetPath,
          closed: false,
          /** 復旧したルート監視へディレクトリの変更を知らせる。 */
          change: (filename) => listener("rename", filename),
          /** 既存監視の障害をエラーリスナーへ送る。 */
          error: (error) =>
            errorListeners.forEach((errorListener) => errorListener(error)),
        };
        watchers.push(watcher);
        return {
          /** 失敗した監視や最後の購読が閉じたかを記録する。 */
          close: () => {
            watcher.closed = true;
          },
          /** 初回・再購読それぞれの監視にエラーハンドラーをひも付ける。 */
          on: (_event: string, errorListener: (error: Error) => void) => {
            errorListeners.push(errorListener as (error: Error) => void);
            return undefined as never;
          },
        };
      },
    });
    const states: GlossaryProjectionState[] = [];
    const dispose = service.subscribe(target, (state) => states.push(state));
    /** 新しいルート監視の確立や、最新状態が有効に戻るのを有界に待つ。 */
    const waitUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(predicate(), true);
    };

    const initialRootWatcher = watchers.find(
      (watcher) => watcher.path === root,
    );
    assert.ok(initialRootWatcher);
    initialRootWatcher.error(new Error("root watch failed"));
    await waitUntil(
      () => watchers.filter((watcher) => watcher.path === root).length >= 2,
    );

    await writeGlossary(root, [
      { term: "Recovered", aliases: [], definition: "valid again" },
    ]);
    const recoveredRootWatcher = [...watchers]
      .reverse()
      .find((watcher) => watcher.path === root && !watcher.closed);
    assert.ok(recoveredRootWatcher);
    recoveredRootWatcher.change(".withmate");
    await waitUntil(() => states.at(-1)?.status === "valid");

    assert.equal(states[0]?.status, "watch-error");
    const recovered = states.at(-1);
    assert.equal(recovered?.status, "valid");
    if (recovered?.status === "valid") {
      assert.deepEqual(
        recovered.entries.map((entry) => entry.term),
        ["Recovered"],
      );
    }
    dispose();
    assert.equal(
      watchers.every((watcher) => watcher.closed),
      true,
    );
  });
});
