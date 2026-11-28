import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveSessionFile } from "../../src-electron/files/session-files.js";
import { collectPastedSessionAttachments } from "../../src/chat/composer-paste-handlers.js";

// @test-value v2
// kind = "contract"
// claim = "同名同内容は再利用を通知し、別内容は確認・取消・コピーで保存と参照を分ける"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md: Composerと保存" }
// fault = "無確認置換する、取消fileを挿入する、再利用を通知しない、コピー時に元画像を上書きする"
// observable = "確認対象名と回数、通知対象名、添付path/presentation、実保存内容とfile一覧"
// observation_boundary = "consumer"
// scope = "clipboard collector and actual session-file storage"
// lifecycle = "permanent"
// impact = "必要な添付参照の欠落と既存添付の無断変更を防ぐ"
// distinction = "storage単体では同一paste内の順序と確認・挿入の結合を検証できず、mock保存では同内容再利用を保証できない"
// @end-test-value
/** 実ストレージを使い、同名同内容の再利用通知と、内容衝突の置換・取消・コピーが添付参照と保存内容の両方に反映されることを確かめる。 */
test("paste collector integrates reuse, replace and per-file cancel with real storage", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "withmate-paste-integration-"),
  );
  try {
    let prevented = false;
    const confirmations: string[] = [];
    const reused: string[][] = [];
    /** 名前と内容を変えて、同名衝突を起こせるクリップボードファイルを作る。 */
    const file = (name: string, content: string) => ({
      name,
      /** テキストで指定したテストデータをクリップボードのバイト列として返す。 */ arrayBuffer:
        async () => new TextEncoder().encode(content).buffer,
    });
    const attachments = await collectPastedSessionAttachments({
      /** 貼り付けバッチを実ファイル扱いにして、名前で保存先を照合できるようにする。 */
      isFileBacked: () => true,
      sessionId: "session",
      clipboardData: {
        files: [
          file("note.txt", "first"),
          file("note.txt", "first"),
          file("note.txt", "replace"),
          file("note.txt", "canceled"),
          { ...file("image.png", "image"), type: "image/png" },
          { ...file("image.png", "other-image"), type: "image/png" },
        ],
        items: [],
      },
      /** 保存要求の時刻ラベルを固定する。 */
      currentTimestampLabel: () => "now",
      /** 添付として処理したときに既定の貼り付けを止めた事実を記録する。 */
      preventDefault: () => {
        prevented = true;
      },
      /** 収集処理のバイト列を実際の Session ファイル保存に渡す。 */
      savePastedSessionFile: (request) =>
        saveSessionFile(root, {
          ...request,
          data: new Uint8Array(request.data),
        }),
      /** 衝突名を記録し、遭遇順に置換・取消・コピーを選ぶ。 */
      confirmReplacement: async (conflict) => {
        confirmations.push(conflict.fileName);
        return confirmations.length === 1
          ? "replace"
          : confirmations.length === 2
            ? "cancel"
            : "copy";
      },
      /** 同じ内容が再利用されたファイル名を通知単位で記録する。 */
      onReuse: (fileNames) => reused.push(fileNames),
    });
    assert.equal(prevented, true);
    assert.deepEqual(confirmations, ["note.txt", "note.txt", "image.png"]);
    assert.deepEqual(reused, [["note.txt"]]);
    const directory = path.join(root, "session-files", "session");
    assert.deepEqual(attachments, [
      ...Array.from({ length: 3 }, () => ({
        path: path.join(directory, "note.txt"),
        presentation: "path",
      })),
      { path: path.join(directory, "image.png"), presentation: "image" },
      { path: path.join(directory, "image-2.png"), presentation: "image" },
    ]);
    assert.equal(
      await readFile(path.join(directory, "note.txt"), "utf8"),
      "replace",
    );
    assert.equal(
      await readFile(path.join(directory, "image.png"), "utf8"),
      "image",
    );
    assert.equal(
      await readFile(path.join(directory, "image-2.png"), "utf8"),
      "other-image",
    );
    assert.deepEqual((await readdir(directory)).sort(), [
      "image-2.png",
      "image.png",
      "note.txt",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "再確認が必要な保存結果は最新hashで再度確認し、全取消では参照を追加しない"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md: 確認中の変更とCancel" }
// fault = "再確認を自動承認する、古いhashで再送する、または取消後に保存・挿入する"
// observable = "確認されたhash列、保存要求のhash列、取消時の空添付配列"
// observation_boundary = "consumer"
// scope = "paste confirmation retry and cancellation"
// lifecycle = "permanent"
// @end-test-value
/** 置換確認中に保存済み内容のハッシュが変わる場合、最新ハッシュで再確認し、取消後に再送も添付も行わないことを確かめる。 */
test("paste collector repeats confirmation for a changed file and allows cancel", async () => {
  const confirmed: string[] = [];
  const requests: Array<string | undefined> = [];
  const attachments = await collectPastedSessionAttachments({
    /** 再確認の対象を名前付きの実ファイルとして扱う。 */
    isFileBacked: () => true,
    sessionId: "session",
    clipboardData: {
      files: [
        {
          name: "note.txt",
          /** 内容の比較処理には入らず、保存モックに一バイトを渡す。 */ arrayBuffer:
            async () => new ArrayBuffer(1),
        },
      ],
      items: [],
    },
    /** 再確認中に変化しない時刻ラベルを返す。 */
    currentTimestampLabel: () => "now",
    /** ブラウザー既定の貼り付け処理は模倣しない。 */
    preventDefault() {},
    /** 置換時に渡されたハッシュを記録し、初回と再送とで別の既存ハッシュを通知する。 */
    savePastedSessionFile: async (request) => {
      requests.push(request.replaceExistingHash);
      return {
        status: "conflict",
        fileName: request.fileName,
        existingHash: requests.length === 1 ? "old" : "new",
      };
    },
    /** 確認画面に渡るハッシュを捕捉し、初回だけ置換を承認する。 */
    confirmReplacement: async (conflict) => {
      confirmed.push(conflict.existingHash);
      return confirmed.length === 1 ? "replace" : "cancel";
    },
  });
  assert.deepEqual(confirmed, ["old", "new"]);
  assert.deepEqual(requests, [undefined, "old"]);
  assert.deepEqual(attachments, []);
});

// @test-value v2
// kind = "contract"
// claim = "実ファイルでない画像は時刻や順序によらず同内容を再利用し別内容を別保存する。候補の実内容不一致は拒否し、明示名の画像は同名確認を維持する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md: Composerと保存" }
// fault = "同画像のfileを増殖させる、異なる画像を同じpathへまとめる、変更された候補を再利用・置換・コピーする、または実ファイルの同名確認を迂回する"
// observable = "添付pathとpresentation、確認対象名、再利用通知、保存内容とfile件数、変更済み候補の拒否結果"
// observation_boundary = "consumer"
// scope = "clipboard image naming and actual session-file storage"
// lifecycle = "permanent"
// impact = "連続画像pasteを妨げず、過去メッセージと明示名fileの参照内容を保護する"
// distinction = "storage単体や型検査では由来別命名・時刻をまたぐ再利用・候補の不一致拒否の結合を確認できず、実描画確認より低コストで継続検証できる"
// @end-test-value
/** 実ファイル由来でない画像は時刻や順序をまたいで内容ごとに再利用され、明示名を持つ実ファイルの衝突や保存済み候補の改変は見逃さないことを確かめる。 */
test("clipboard images reuse content-addressed files while file-backed images keep conflict handling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-paste-image-"));
  try {
    /** 内容とファイル由来の有無を切り替えられる同名の画像データを作る。 */
    const image = (content: string, native = false) => ({
      name: "image.png",
      type: "image/png",
      native,
      /** 画像として保存する検証用の内容をバイト列にする。 */
      arrayBuffer: async () => new TextEncoder().encode(content).buffer,
    });
    const directory = path.join(root, "session-files", "session");
    await saveSessionFile(root, {
      sessionId: "session",
      fileName: "image.png",
      data: new TextEncoder().encode("original"),
    });
    const confirmations: string[] = [];
    const reused: string[][] = [];
    let timestamp = "2026-10-29T13:00:00.000Z";
    /** 複数の画像を一回の貼り付けとして、実ストレージへ接続した収集処理に渡す。 */
    const paste = (files: ReturnType<typeof image>[]) =>
      collectPastedSessionAttachments({
        sessionId: "session",
        clipboardData: { files, items: [] },
        /** 入力の同一参照から、画像が実ファイル由来かを判定する。 */
        isFileBacked: (file) =>
          files.find((candidate) => candidate === file)!.native,
        /** 内容再利用が別時刻でも失われないよう、現在の検証時刻を返す。 */
        currentTimestampLabel: () => timestamp,
        /** 画像の既定貼り付けは行わず、収集結果のみ検証する。 */
        preventDefault() {},
        /** 画像の保存・再利用・衝突判定を実ストレージで行う。 */
        savePastedSessionFile: (request) =>
          saveSessionFile(root, {
            ...request,
            data: new Uint8Array(request.data),
          }),
        /** 明示名の衝突を通知されたら対象名を保存し、既存画像の上書きを取り消す。 */
        confirmReplacement: async (conflict) => {
          confirmations.push(conflict.fileName);
          return "cancel";
        },
        /** 再利用された名前を、貼り付け一回分の通知として保持する。 */
        onReuse: (names) => reused.push(names),
      });
    const first = await paste([image("first")]);
    const second = await paste([image("second")]);
    const batch = await paste([
      image("third"),
      { ...image("fourth"), name: "clipboard.jpeg", type: "image/jpeg" },
    ]);
    const generated = [...first, ...second, ...batch];
    assert.equal(
      new Set(generated.map((attachment) => attachment.path)).size,
      4,
    );
    assert.deepEqual(
      await Promise.all(
        generated.map((attachment) => readFile(attachment.path, "utf8")),
      ),
      ["first", "second", "third", "fourth"],
    );
    assert.ok(
      generated.every((attachment) => attachment.presentation === "image"),
    );
    assert.equal(
      path.basename(first[0]!.path),
      `pasted-${createHash("sha256").update("first").digest("hex")}.png`,
    );
    assert.equal(path.extname(batch[1]!.path), ".jpg");
    timestamp = "2026-10-30T14:01:00.000Z";
    assert.deepEqual(
      await paste([image("second"), image("first"), image("second")]),
      [second[0], first[0], second[0]],
    );
    assert.deepEqual(reused, [
      [
        path.basename(second[0]!.path),
        path.basename(first[0]!.path),
        path.basename(second[0]!.path),
      ],
    ]);
    assert.deepEqual(confirmations, []);
    assert.deepEqual(await paste([image("different", true)]), []);
    assert.deepEqual(confirmations, ["image.png"]);
    assert.deepEqual(await paste([image("original", true)]), [
      { path: path.join(directory, "image.png"), presentation: "image" },
    ]);
    assert.deepEqual(reused[1], ["image.png"]);
    assert.equal(
      await readFile(path.join(directory, "image.png"), "utf8"),
      "original",
    );
    await writeFile(second[0]!.path, "modified");
    await assert.rejects(
      paste([image("second")]),
      /saved image has different contents/,
    );
    assert.equal(await readFile(second[0]!.path, "utf8"), "modified");
    assert.deepEqual(confirmations, ["image.png"]);
    assert.equal(reused.length, 2);
    assert.equal((await readdir(directory)).length, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
