import assert from "node:assert/strict";
import test from "node:test";

import { calculateImageFitZoom } from "../../src/ui/image-viewport.js";
import {
  decodeSessionFileBytes,
  findPreviewTextMatches,
  PreviewByteAccumulator,
  projectFileRootDiffAvailability,
} from "../../src/file-explorer/file-preview-utils.js";
import { detectSessionFileEncoding } from "../../src-shared/file-explorer/file-content-detection.js";

/** 大きな画像だけが表示領域に合わせて縮小し、小さな画像と未計測の領域では等倍を維持することを確認する。 */
test("calculateImageFitZoom は画像を拡大せずviewport内に収める倍率を返す", () => {
  assert.equal(calculateImageFitZoom(800, 450, 1600, 900), 50);
  assert.equal(calculateImageFitZoom(800, 600, 400, 300), 100);
  assert.equal(calculateImageFitZoom(0, 600, 400, 300), 100);
});

/** 自動判定の UTF-8 と、既定値とは異なる手動指定の Shift_JIS・UTF-16BE がそれぞれ正しい文字列になることを確認する。 */
test("decodeSessionFileBytes は Auto と手動指定で UTF-8 / Shift_JIS / UTF-16 を decode する", () => {
  assert.equal(
    decodeSessionFileBytes(new TextEncoder().encode("hello"), "auto", "utf-8"),
    "hello",
  );
  assert.equal(
    decodeSessionFileBytes(
      Uint8Array.from([0x82, 0xa0, 0x82, 0xa2]),
      "shift_jis",
      "utf-8",
    ),
    "あい",
  );
  assert.equal(
    decodeSessionFileBytes(
      Uint8Array.from([0x00, 0x41, 0x00, 0x42]),
      "utf-16be",
      "utf-8",
    ),
    "AB",
  );
});

/** 同一行内の二つの一致をまとめず、別の行の一致も含めて行番号と文字位置を返すことを確認する。 */
test("findPreviewTextMatches は同じ行の複数一致を別々の検索結果として返す", () => {
  assert.deepEqual(
    findPreviewTextMatches(["alpha alpha", "beta alpha"], "alpha"),
    [
      { lineIndex: 0, startOffset: 0, endOffset: 5 },
      { lineIndex: 0, startOffset: 6, endOffset: 11 },
      { lineIndex: 1, startOffset: 5, endOffset: 10 },
    ],
  );
});

/** 自動判定が先頭 8192 バイトの ASCII だけで完結せず、直後の Shift_JIS を文字化けなく復号することを確認する。 */
test("decodeSessionFileBytes の Auto は ASCII inspection prefix より後ろの Shift_JIS まで検証する", () => {
  const bytes = new Uint8Array(8194).fill(0x61);
  bytes[8192] = 0x82;
  bytes[8193] = 0xa0;

  const decoded = decodeSessionFileBytes(bytes, "auto", "utf-8");

  assert.equal(decoded.length, 8193);
  assert.equal(decoded.slice(-1), "あ");
});

/** 両方の文字コードで無効な 0xff を Shift_JIS の根拠にせず、UTF-8 にフォールバックすることを確認する。 */
test("detectSessionFileEncoding は UTF-8 と Shift_JIS の両方に不正なbytesをShift_JIS扱いしない", () => {
  assert.equal(detectSessionFileEncoding(Uint8Array.of(0xff)), "utf-8");
});

/** 旧世代を破棄すると蓄積バイト数がゼロになり、後から続きが届いても追加を拒否することを確認する。 */
test("PreviewByteAccumulator は破棄時に未完了世代の保持bytesを直ちに手放す", () => {
  const accumulator = new PreviewByteAccumulator();
  accumulator.append(Uint8Array.of(1, 2, 3));
  assert.equal(accumulator.retainedByteLength, 3);

  accumulator.release();

  assert.equal(accumulator.retainedByteLength, 0);
  assert.throws(() => accumulator.append(Uint8Array.of(4)), /replaced/);
});

// @test-value v2
// kind = "contract"
// claim = "projectFileRootDiffAvailabilityはcleanまたはGit失敗ではdiff scopeを返さず、真のGit失敗messageだけを保持し、対象pathのtracked変更entryだけscopeを返す"
// oracle = { type = "contract", ref = "src/file-explorer/file-preview-utils.ts" }
// fault = "Git failureまたは空diffを変更ありとして表示する、または対象pathの変更scopeを欠落させる"
// observable = "statusとentries入力に対するscopes・message projection"
// observation_boundary = "public-boundary"
// scope = "file preview root diff availability"
// lifecycle = "permanent"
// @end-test-value
/** 差分なしと非 Git は通知せず、取得失敗の文言だけを残し、対象パスの追跡対象差分だけを表示候補にすることを確認する。 */
test("projectFileRootDiffAvailability は変更なしとGit失敗を区別する", () => {
  assert.deepEqual(
    projectFileRootDiffAvailability(
      { status: "ok", entries: [] },
      "src/app/SessionWindowApp.tsx",
    ),
    {
      scopes: [],
      message: "",
    },
  );
  assert.deepEqual(
    projectFileRootDiffAvailability(
      { status: "not-git", message: "Not a Git repository." },
      "src/app/SessionWindowApp.tsx",
    ),
    {
      scopes: [],
      message: "",
    },
  );
  assert.deepEqual(
    projectFileRootDiffAvailability(
      { status: "failed", message: "Git status failed." },
      "src/app/SessionWindowApp.tsx",
    ),
    {
      scopes: [],
      message: "Git status failed.",
    },
  );
  assert.deepEqual(
    projectFileRootDiffAvailability(
      {
        status: "ok",
        entries: [
          {
            relativePath: "src/app/SessionWindowApp.tsx",
            previousRelativePath: null,
            kinds: { "working-tree": "modified", staged: "untracked" },
            scopes: ["working-tree", "staged"],
          },
        ],
      },
      "src/app/SessionWindowApp.tsx",
    ),
    {
      scopes: ["working-tree"],
      message: "",
    },
  );
});
