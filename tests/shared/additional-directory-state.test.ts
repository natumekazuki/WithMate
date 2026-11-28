import assert from "node:assert/strict";
import test from "node:test";

import {
  addAllowedAdditionalDirectory,
  removeAllowedAdditionalDirectory,
  resolveAdditionalDirectoryPickerBase,
  runAdditionalDirectoryRemovalOperation,
  runPickedAdditionalDirectoryOperation,
} from "../../src-shared/settings/additional-directory-state.js";

/** 現在の選択、Workspace、代替候補の順に空でないパスを探し、候補がなければ null を返す。 */
test("resolveAdditionalDirectoryPickerBase は最初の non-empty path を返す", () => {
  assert.equal(
    resolveAdditionalDirectoryPickerBase("C:/picked", "C:/workspace"),
    "C:/picked",
  );
  assert.equal(
    resolveAdditionalDirectoryPickerBase("", "C:/workspace", "C:/fallback"),
    "C:/workspace",
  );
  assert.equal(resolveAdditionalDirectoryPickerBase(null, undefined, ""), null);
});

/** 選択が許されたとき、基準パスを選択処理に渡した後、選ばれたディレクトリを適用し、そのパスを返す。 */
test("runPickedAdditionalDirectoryOperation は選択 directory を callback に渡す", async () => {
  const events: string[] = [];
  const result = await runPickedAdditionalDirectoryOperation({
    /** このケースは選択操作が許可された状態で実行する。 */
    canPickDirectory: () => true,
    /** 選択ダイアログに渡るべき基準を Workspace に固定する。 */
    getPickerBaseDirectory: () => "C:/workspace",
    /** 実ダイアログの代わりに渡された基準を記録し、配下の assets を選んだものとして返す。 */
    pickDirectory: async (baseDirectory) => {
      events.push(`pick:${baseDirectory}`);
      return "C:/workspace/assets";
    },
    /** 選択後の適用に渡るパスを、ダイアログ呼び出しより後に記録する。 */
    applyPickedDirectory: async (selectedPath) => {
      events.push(`apply:${selectedPath}`);
    },
  });

  assert.equal(result, "C:/workspace/assets");
  assert.deepEqual(events, ["pick:C:/workspace", "apply:C:/workspace/assets"]);
});

/** 選択を禁止した場合はダイアログ自体を開かず、キャンセル時はダイアログだけを呼び、どちらも適用せず null を返す。 */
test("runPickedAdditionalDirectoryOperation は実行不可または picker cancel なら apply しない", async () => {
  const blockedEvents: string[] = [];
  const blockedResult = await runPickedAdditionalDirectoryOperation({
    /** 選択操作を開始できない状態を再現する。 */
    canPickDirectory: () => false,
    /** 誤って選択処理に進んだ場合も基準を解決できるよう、Workspace を用意しておく。 */
    getPickerBaseDirectory: () => "C:/workspace",
    /** 禁止中に呼ばれたら記録し、適用まで進む可能性のあるパスを返す。 */
    pickDirectory: async () => {
      blockedEvents.push("pick");
      return "C:/workspace/assets";
    },
    /** 禁止中に選択結果の適用まで進んだ場合を検出する。 */
    applyPickedDirectory: () => {
      blockedEvents.push("apply");
    },
  });
  assert.equal(blockedResult, null);
  assert.deepEqual(blockedEvents, []);

  const cancelEvents: string[] = [];
  const cancelResult = await runPickedAdditionalDirectoryOperation({
    /** ダイアログまで進めるが、その中でキャンセルするケースを再現する。 */
    canPickDirectory: () => true,
    /** キャンセル時にも通常の Workspace を選択の起点に使う。 */
    getPickerBaseDirectory: () => "C:/workspace",
    /** ダイアログの呼び出しを記録した上で、パスの選択なしを返す。 */
    pickDirectory: async () => {
      cancelEvents.push("pick");
      return null;
    },
    /** キャンセルを選択結果として誤って適用した場合に記録する。 */
    applyPickedDirectory: () => {
      cancelEvents.push("apply");
    },
  });
  assert.equal(cancelResult, null);
  assert.deepEqual(cancelEvents, ["pick"]);
});

/** 削除が許されると指定パスで処理を呼んで true を返すが、拒否された場合は処理を呼ばず false を返す。 */
test("runAdditionalDirectoryRemovalOperation は guard 通過時だけ remove callback を呼ぶ", async () => {
  const events: string[] = [];
  const removed = await runAdditionalDirectoryRemovalOperation({
    directoryPath: "C:/workspace/a",
    /** 対象ディレクトリを削除できる状態を返す。 */
    canRemoveDirectory: () => true,
    /** 削除を要求されたパスを記録し、実際のパス変更なしで成功を返す。 */
    removeDirectory: async (directoryPath) => {
      events.push(`remove:${directoryPath}`);
      return true;
    },
  });

  assert.equal(removed, true);
  assert.deepEqual(events, ["remove:C:/workspace/a"]);

  const blockedEvents: string[] = [];
  const blocked = await runAdditionalDirectoryRemovalOperation({
    directoryPath: "C:/workspace/a",
    /** 削除操作を実行できない状況を再現する。 */
    canRemoveDirectory: () => false,
    /** ガードをすり抜けて削除が呼ばれた場合に記録する。 */
    removeDirectory: () => {
      blockedEvents.push("remove");
      return true;
    },
  });

  assert.equal(blocked, false);
  assert.deepEqual(blockedEvents, []);
});

/** 削除先がすでになくコールバックが false を返した場合は、操作全体を成功扱いにしない。 */
test("runAdditionalDirectoryRemovalOperation は remove callback の no-op 結果を返す", async () => {
  const removed = await runAdditionalDirectoryRemovalOperation({
    directoryPath: "C:/missing",
    /** 削除する登録がなく何も変更されなかった場合の戻り値を返す。 */
    removeDirectory: () => false,
  });

  assert.equal(removed, false);
});

/** 新規パスを末尾に足し、Windows の区切り・大小文字違いは同一とみなすが、POSIX の大小文字違いは別に扱う。 */
test("addAllowedAdditionalDirectory は directory を正規化して末尾へ追加し重複を避ける", () => {
  assert.deepEqual(
    addAllowedAdditionalDirectory(["C:/workspace/a"], "C:/workspace/b"),
    ["C:/workspace/a", "C:/workspace/b"],
  );
  assert.deepEqual(
    addAllowedAdditionalDirectory(["C:/workspace/a"], "C:/workspace/a"),
    ["C:/workspace/a"],
  );
  assert.deepEqual(
    addAllowedAdditionalDirectory(["C:/workspace/a"], "C:\\workspace\\a"),
    ["C:/workspace/a"],
  );
  assert.deepEqual(
    addAllowedAdditionalDirectory(["C:/workspace/a"], "D:\\assets"),
    ["C:/workspace/a", "D:/assets"],
  );
  assert.deepEqual(
    addAllowedAdditionalDirectory(["C:/Workspace/A/"], "c:\\workspace\\a"),
    ["C:/Workspace/A"],
  );
  assert.deepEqual(addAllowedAdditionalDirectory(["C:/"], "C:\\"), ["C:/"]);
  assert.deepEqual(
    addAllowedAdditionalDirectory(["//Server/Share"], "//server/share"),
    ["//Server/Share"],
  );
  assert.deepEqual(addAllowedAdditionalDirectory(["/tmp/Test"], "/tmp/test"), [
    "/tmp/Test",
    "/tmp/test",
  ]);
});

/** 未初期化の一覧でも null と undefined のどちらからも最初のディレクトリを登録できる。 */
test("addAllowedAdditionalDirectory は nullish input を空配列として扱う", () => {
  assert.deepEqual(addAllowedAdditionalDirectory(null, "C:/workspace/a"), [
    "C:/workspace/a",
  ]);
  assert.deepEqual(addAllowedAdditionalDirectory(undefined, "C:/workspace/a"), [
    "C:/workspace/a",
  ]);
});

/** 正規化したパスで一致する登録だけをすべて除き、存在しないパスや POSIX の大小文字違いでは他の登録を失わない。 */
test("removeAllowedAdditionalDirectory は directory を正規化して一致する directory だけを除く", () => {
  assert.deepEqual(
    removeAllowedAdditionalDirectory(
      ["C:/workspace/a", "C:/workspace/b", "C:/workspace/a"],
      "C:/workspace/a",
    ),
    ["C:/workspace/b"],
  );
  assert.deepEqual(
    removeAllowedAdditionalDirectory(
      ["C:/workspace/a"],
      "C:/workspace/missing",
    ),
    ["C:/workspace/a"],
  );
  assert.deepEqual(
    removeAllowedAdditionalDirectory(
      ["C:\\workspace\\a", "D:/assets"],
      "C:/workspace/a",
    ),
    ["D:/assets"],
  );
  assert.deepEqual(
    removeAllowedAdditionalDirectory(
      ["C:/Workspace/A/", "D:/assets"],
      "c:\\workspace\\a",
    ),
    ["D:/assets"],
  );
  assert.deepEqual(
    removeAllowedAdditionalDirectory(["/tmp/Test", "/tmp/test"], "/tmp/test"),
    ["/tmp/Test"],
  );
  assert.deepEqual(
    removeAllowedAdditionalDirectory(["C:/", "D:/assets"], "C:\\"),
    ["D:/assets"],
  );
  assert.deepEqual(
    removeAllowedAdditionalDirectory(
      ["//Server/Share", "/tmp/test"],
      "//SERVER/share",
    ),
    ["/tmp/test"],
  );
});
