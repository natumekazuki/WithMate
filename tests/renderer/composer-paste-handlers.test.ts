import assert from "node:assert/strict";
import test from "node:test";

import {
  collectPastedClipboardFiles,
  collectPastedSessionAttachments as collectAttachments,
  collectPastedSessionAttachmentPaths as collectPaths,
  createPastedSessionAttachmentHandler as createHandler,
  type PastedClipboardFile,
  type PastedClipboardFileItem,
} from "../../src/chat/composer-paste-handlers.js";

/** ファイル実体があるものとして添付の収集経路を呼び、ファイル名と表示種別を検査する。 */
const collectPastedSessionAttachments = (
  input: Omit<Parameters<typeof collectAttachments>[0], "isFileBacked">,
) =>
  collectAttachments({
    ...input,
    /** テスト用の ClipboardFile を保存可能な実体として扱う。 */
    isFileBacked: () => true,
  });
/** テスト用ファイルを保存できる状態で、収集結果のパスだけを取得する。 */
const collectPastedSessionAttachmentPaths = (
  input: Omit<Parameters<typeof collectPaths>[0], "isFileBacked">,
) =>
  collectPaths({
    ...input,
    /** 実体確認の結果を固定し、保存とパスの検査に絞る。 */
    isFileBacked: () => true,
  });
/** テスト用ファイルに対して、実体確認だけを固定した貼り付けハンドラーを構築する。 */
const createPastedSessionAttachmentHandler = (
  input: Omit<Parameters<typeof createHandler>[0], "isFileBacked">,
) =>
  createHandler({
    ...input,
    /** OS 上の実体を用意せず、保存対象として受け付けさせる。 */
    isFileBacked: () => true,
  });

/** 名前と内容を任意に設定できるクリップボードファイルを作る。 */
function createPastedFile(name: string, content: string): PastedClipboardFile {
  return {
    name,
    /** 保存側で元の内容を比較できるよう、文字列を UTF-8 のバイト列として返す。 */
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  };
}

/** 内容とファイル名に MIME 型を加え、拡張子だけでは判断できないファイルを再現する。 */
function createTypedPastedFile(
  name: string,
  content: string,
  type: string,
): PastedClipboardFile {
  return {
    ...createPastedFile(name, content),
    type,
  };
}

/** files と items の両方に異なるファイルがある場合、files の内容だけを採用する。 */
test("collectPastedClipboardFiles は clipboard files を items より優先する", () => {
  const file = createPastedFile("from-files.png", "files");
  const itemFile = createPastedFile("from-items.png", "items");
  const item: PastedClipboardFileItem = {
    kind: "file",
    /** files の値と区別できる item 側のファイルを返す。 */
    getAsFile: () => itemFile,
  };

  assert.deepEqual(
    collectPastedClipboardFiles({ files: [file], items: [item] }),
    [file],
  );
});

/** files が空の場合は items にフォールバックするが、文字列とファイルを返せない item は除く。 */
test("collectPastedClipboardFiles は files が空なら file item から取り出す", () => {
  const itemFile = createPastedFile("from-items.png", "items");
  const fileItem: PastedClipboardFileItem = {
    kind: "file",
    /** items から採用される有効なファイルを返す。 */
    getAsFile: () => itemFile,
  };
  const textItem: PastedClipboardFileItem = {
    kind: "string",
    /** 文字列 item の種別チェックをすり抜けた場合だけ現れる別ファイルを返す。 */
    getAsFile: () => createPastedFile("ignored.txt", "ignored"),
  };
  const nullFileItem: PastedClipboardFileItem = {
    kind: "file",
    /** ファイル種別でも実体を取得できない item を再現する。 */
    getAsFile: () => null,
  };

  assert.deepEqual(
    collectPastedClipboardFiles({
      files: [],
      items: [textItem, nullFileItem, fileItem],
    }),
    [itemFile],
  );
});

/** 貼り付けを抑止してファイル名を整え、空名は時刻から補い、各ファイルの内容と保存パスの対応を保つ。 */
test("collectPastedSessionAttachmentPaths は pasted files を保存して path を返す", async () => {
  const saved: Array<{
    sessionId: string;
    fileName: string;
    dataText: string;
  }> = [];
  let prevented = false;

  const savedPaths = await collectPastedSessionAttachmentPaths({
    clipboardData: {
      files: [
        createPastedFile(" pasted.png ", "named"),
        createPastedFile("", "fallback"),
      ],
      items: [],
    },
    /** 空のファイル名に使う時刻を固定し、区切り文字を置換した結果を比較できるようにする。 */
    currentTimestampLabel: () => "2026-06-05T12:34:56.000Z",
    /** 通常の貼り付けが抑止されたことを記録する。 */
    preventDefault: () => {
      prevented = true;
    },
    /** Session、保存名、受け取ったバイト列を記録し、その名前に対応する保存先を返す。 */
    savePastedSessionFile: async ({ sessionId, fileName, data }) => {
      saved.push({
        sessionId,
        fileName,
        dataText: new TextDecoder().decode(data),
      });
      return `session-files/${fileName}`;
    },
    sessionId: "session-1",
  });

  assert.equal(prevented, true);
  assert.deepEqual(saved, [
    { sessionId: "session-1", fileName: "pasted.png", dataText: "named" },
    {
      sessionId: "session-1",
      fileName: "pasted-2026-06-05T12-34-56.000Z.bin",
      dataText: "fallback",
    },
  ]);
  assert.deepEqual(savedPaths, [
    "session-files/pasted.png",
    "session-files/pasted-2026-06-05T12-34-56.000Z.bin",
  ]);
});

/** 空名のファイルに対し、対応画像の MIME にだけ画像拡張子と表示種別を付け、未対応と不明の型は汎用パスにする。 */
test("collectPastedSessionAttachments は空名を MIME が対応画像の場合だけ画像として扱う", async () => {
  let timestampIndex = 0;
  const attachments = await collectPastedSessionAttachments({
    clipboardData: {
      files: [
        createTypedPastedFile("", "png", "image/png"),
        createTypedPastedFile(" ", "avif", "image/avif"),
        createPastedFile("", "unknown"),
      ],
      items: [],
    },
    /** 空名ごとのファイル名を個別に比較できるよう、呼出順で異なる時刻ラベルを返す。 */
    currentTimestampLabel: () => `stamp-${(timestampIndex += 1)}`,
    /** このケースでは通常貼り付けの抑止を受けても追加の操作を行わない。 */
    preventDefault: () => {},
    /** 補われた保存名を比較できるように固定ディレクトリに結び付ける。 */
    savePastedSessionFile: async ({ fileName }) =>
      `C:/session-files/${fileName}`,
    sessionId: "session-empty-name",
  });

  assert.deepEqual(attachments, [
    { path: "C:/session-files/pasted-stamp-1.png", presentation: "image" },
    { path: "C:/session-files/pasted-stamp-2.bin", presentation: "path" },
    { path: "C:/session-files/pasted-stamp-3.bin", presentation: "path" },
  ]);
});

/** files がないときも file item の名前と内容を Session 内に保存し、そのパスで置き換える。 */
test("collectPastedSessionAttachmentPaths は files が空なら item file を保存する", async () => {
  const itemFile = createPastedFile("from-items.png", "items");
  const fileItem: PastedClipboardFileItem = {
    kind: "file",
    /** files が空でも保存可能な item 側ファイルを返す。 */
    getAsFile: () => itemFile,
  };
  const saved: Array<{
    sessionId: string;
    fileName: string;
    dataText: string;
  }> = [];
  let prevented = false;

  const savedPaths = await collectPastedSessionAttachmentPaths({
    clipboardData: {
      files: [],
      items: [fileItem],
    },
    /** 既に名前があるファイル用の環境では、固定の未使用ラベルを返す。 */
    currentTimestampLabel: () => "unused",
    /** item からファイルを処理した際に通常貼り付けを止めたかを記録する。 */
    preventDefault: () => {
      prevented = true;
    },
    /** item 由来の内容と宛先を記録し、そのファイル名で保存したパスを返す。 */
    savePastedSessionFile: async ({ sessionId, fileName, data }) => {
      saved.push({
        sessionId,
        fileName,
        dataText: new TextDecoder().decode(data),
      });
      return `session-files/${fileName}`;
    },
    sessionId: "session-2",
  });

  assert.equal(prevented, true);
  assert.deepEqual(saved, [
    { sessionId: "session-2", fileName: "from-items.png", dataText: "items" },
  ]);
  assert.deepEqual(savedPaths, ["session-files/from-items.png"]);
});

/** ファイルが一つもなければ通常貼り付けを妨げず、保存要求や戻り値のパスも作らない。 */
test("collectPastedSessionAttachmentPaths は file がなければ preventDefault も保存も行わない", async () => {
  let prevented = false;
  let saved = false;

  const savedPaths = await collectPastedSessionAttachmentPaths({
    clipboardData: { files: [], items: [] },
    /** 時刻を必要としない空入力のケース用に固定値を返す。 */
    currentTimestampLabel: () => "unused",
    /** ファイルがないにもかかわらず通常貼り付けを抑止した場合に検出する。 */
    preventDefault: () => {
      prevented = true;
    },
    /** 保存対象のない状態で誤って保存が呼ばれた場合に検出する。 */
    savePastedSessionFile: async () => {
      saved = true;
      return "unused";
    },
    sessionId: "session-1",
  });

  assert.equal(prevented, false);
  assert.equal(saved, false);
  assert.deepEqual(savedPaths, []);
});

/** item ファイルを現在の Session に保存し、貼り付けの既定処理を止めて、保存パスを画像添付として挿入する。 */
test("createPastedSessionAttachmentHandler は item file paste を保存して挿入する", async () => {
  const itemFile = createPastedFile("from-items.png", "items");
  const fileItem: PastedClipboardFileItem = {
    kind: "file",
    /** 貼り付けイベントの items から取得する画像を返す。 */
    getAsFile: () => itemFile,
  };
  const saved: Array<{
    sessionId: string;
    fileName: string;
    dataText: string;
  }> = [];
  const insertedAttachments: Array<
    Array<{ path: string; presentation: "image" | "path" }>
  > = [];
  let prevented = false;

  const handlePaste = createPastedSessionAttachmentHandler({
    /** item ファイルを正常に処理できるケースで、エラー通知が出たら失敗させる。 */
    alertError: () => {
      throw new Error("unexpected alert");
    },
    /** 対象 Session で添付の貼り付けを許可する。 */
    canPaste: () => true,
    /** 名前付き画像のため時刻は使用せず、固定値を返す。 */
    currentTimestampLabel: () => "unused",
    fallbackErrorMessage: "fallback",
    /** 保存時に渡された名前、内容、Session を記録し、挿入に使えるパスを返す。 */
    getSavePastedSessionFile:
      () =>
      async ({ sessionId, fileName, data }) => {
        saved.push({
          sessionId,
          fileName,
          dataText: new TextDecoder().decode(data),
        });
        return `session-files/${fileName}`;
      },
    /** item を保存する Session ID を固定する。 */
    getSessionId: () => "session-3",
    /** 保存後に挿入されたパスと表示種別を、呼出単位で記録する。 */
    insertAttachments: (attachments) => {
      insertedAttachments.push(attachments);
    },
  });

  const handled = await handlePaste({
    clipboardData: {
      files: [],
      items: [fileItem],
    },
    /** ファイル貼り付けが通常の入力を置き換えたことを記録する。 */
    preventDefault: () => {
      prevented = true;
    },
  });

  assert.equal(handled, true);
  assert.equal(prevented, true);
  assert.deepEqual(saved, [
    { sessionId: "session-3", fileName: "from-items.png", dataText: "items" },
  ]);
  assert.deepEqual(insertedAttachments, [
    [
      {
        path: "session-files/from-items.png",
        presentation: "image",
      },
    ],
  ]);
});

/** 対応画像には拡張子を補って画像表示を指定し、未対応画像と通常ファイルはパス表示として一緒に挿入する。 */
test("createPastedSessionAttachmentHandler は対応画像と通常ファイルを表示形式つきで挿入する", async () => {
  const inserted: Array<
    Array<{ path: string; presentation: "image" | "path" }>
  > = [];
  const handlePaste = createPastedSessionAttachmentHandler({
    /** 混在する三つの添付の処理で、余計なエラー通知を許さない。 */
    alertError: () => {
      throw new Error("unexpected alert");
    },
    /** 異なる表示種別のファイルを同じ Session に貼り付け可能にする。 */
    canPaste: () => true,
    /** 各ファイルの名前があるため、命名用に固定値だけを用意する。 */
    currentTimestampLabel: () => "unused",
    fallbackErrorMessage: "fallback",
    /** 判定された保存名を挿入側で確認できるパスにする。 */
    getSavePastedSessionFile:
      () =>
      async ({ fileName }) =>
        `C:/session-files/${fileName}`,
    /** 複数種別を保存する対象 Session を固定する。 */
    getSessionId: () => "session-mixed",
    /** 貼り付け処理が一括で渡した結果を記録し、順序と表示種別を確認する。 */
    insertAttachments: (attachments) => inserted.push(attachments),
  });

  const handled = await handlePaste({
    clipboardData: {
      files: [
        createTypedPastedFile("capture", "image", "image/png"),
        createTypedPastedFile(
          "archive.avif",
          "unsupported image",
          "image/avif",
        ),
        createPastedFile("notes.txt", "text"),
      ],
      items: [],
    },
    /** 表示種別の検査では、既定処理の抑止に追加動作は設定しない。 */
    preventDefault: () => {},
  });

  assert.equal(handled, true);
  assert.deepEqual(inserted, [
    [
      { path: "C:/session-files/capture.png", presentation: "image" },
      { path: "C:/session-files/archive.avif", presentation: "path" },
      { path: "C:/session-files/notes.txt", presentation: "path" },
    ],
  ]);
});

/** 添付を貼り付けられない状態では、ファイルがあっても既定処理の抑止や保存・挿入を行わない。 */
test("createPastedSessionAttachmentHandler は paste 不可なら保存も挿入も行わない", async () => {
  const file = createPastedFile("ignored.png", "ignored");
  let prevented = false;
  let saved = false;
  let inserted = false;

  const handlePaste = createPastedSessionAttachmentHandler({
    /** 単なる権限上の拒否を保存失敗と誤認して通知したら失敗させる。 */
    alertError: () => {
      throw new Error("unexpected alert");
    },
    /** 明示的にこの Session の添付貼り付けを拒否する。 */
    canPaste: () => false,
    /** 保存に進まない入力のため、使われない時刻値を返す。 */
    currentTimestampLabel: () => "unused",
    fallbackErrorMessage: "fallback",
    /** 許可されないケースで実際に保存が呼ばれたら分かるようにする。 */
    getSavePastedSessionFile: () => async () => {
      saved = true;
      return "unused";
    },
    /** 保存先の有無ではなく許可条件だけで拒まれるよう、有効な ID を返す。 */
    getSessionId: () => "session-4",
    /** 保存を許可していないのに添付を挿入しようとした場合に記録する。 */
    insertAttachments: () => {
      inserted = true;
    },
  });

  const handled = await handlePaste({
    clipboardData: { files: [file], items: [] },
    /** 貼り付け拒否時にも既定の入力を止める回帰を検出する。 */
    preventDefault: () => {
      prevented = true;
    },
  });

  assert.equal(handled, false);
  assert.equal(prevented, false);
  assert.equal(saved, false);
  assert.equal(inserted, false);
});

/** 保存 API または Session ID が null や undefined なら処理を引き取らず、保存・挿入・既定処理の抑止をしない。 */
test("createPastedSessionAttachmentHandler は API や session id がなければ保存も挿入も行わない", async () => {
  const file = createPastedFile("ignored.png", "ignored");
  let prevented = false;
  let saved = false;
  let inserted = false;

  /** 不足する前提だけを切り替え、貼り付け許可と挿入の検査は共通の条件で実行する。 */
  const createHandlePaste = (input: {
    getSavePastedSessionFile: Parameters<
      typeof createPastedSessionAttachmentHandler
    >[0]["getSavePastedSessionFile"];
    getSessionId: () => string | null | undefined;
  }) =>
    createPastedSessionAttachmentHandler({
      /** 保存先や保存 API がないだけの状態は、通知を出す失敗ではない。 */
      alertError: () => {
        throw new Error("unexpected alert");
      },
      /** 貼り付け可否を許可に固定し、保存前提の欠損を切り分ける。 */
      canPaste: () => true,
      /** 保存前提の検査では、命名用時刻に固定値を返す。 */
      currentTimestampLabel: () => "unused",
      fallbackErrorMessage: "fallback",
      getSavePastedSessionFile: input.getSavePastedSessionFile,
      getSessionId: input.getSessionId,
      /** 保存前提がそろわないのに、挿入を行った場合を記録する。 */
      insertAttachments: () => {
        inserted = true;
      },
    });

  const missingApiHandled = await createHandlePaste({
    /** 保存 API を null として欠損させる。 */
    getSavePastedSessionFile: () => null,
    /** API の欠損だけが原因になるよう、Session ID は有効にする。 */
    getSessionId: () => "session-5",
  })({
    clipboardData: { files: [file], items: [] },
    /** null の保存 API で既定の貼り付けを止めた場合に記録する。 */
    preventDefault: () => {
      prevented = true;
    },
  });
  const missingSessionHandled = await createHandlePaste({
    /** Session ID が null でも保存を呼ぶ不具合があれば記録する。 */
    getSavePastedSessionFile: () => async () => {
      saved = true;
      return "unused";
    },
    /** API は用意したうえで、Session ID を null として欠損させる。 */
    getSessionId: () => null,
  })({
    clipboardData: { files: [file], items: [] },
    /** null の Session ID で既定処理を誤って止めた場合に記録する。 */
    preventDefault: () => {
      prevented = true;
    },
  });
  const missingApiUndefinedHandled = await createHandlePaste({
    /** 保存 API が未定義な場合も、null と同じ検査にかける。 */
    getSavePastedSessionFile: () => undefined,
    /** 未定義 API だけを拒否理由にするため、別の有効な Session ID を返す。 */
    getSessionId: () => "session-6",
  })({
    clipboardData: { files: [file], items: [] },
    /** 保存 API が未定義でも通常貼り付けの挙動を妨げないか観測する。 */
    preventDefault: () => {
      prevented = true;
    },
  });
  const missingSessionUndefinedHandled = await createHandlePaste({
    /** 欠損 ID を未定義にした場合にも保存が呼ばれないか観測できるようにする。 */
    getSavePastedSessionFile: () => async () => {
      saved = true;
      return "unused";
    },
    /** 保存 API が利用できても Session ID は未定義とする。 */
    getSessionId: () => undefined,
  })({
    clipboardData: { files: [file], items: [] },
    /** Session ID が未定義のときにイベントを取り込んだ場合を記録する。 */
    preventDefault: () => {
      prevented = true;
    },
  });

  assert.equal(missingApiHandled, false);
  assert.equal(missingSessionHandled, false);
  assert.equal(missingApiUndefinedHandled, false);
  assert.equal(missingSessionUndefinedHandled, false);
  assert.equal(prevented, false);
  assert.equal(saved, false);
  assert.equal(inserted, false);
});

/** ファイルの保存が失敗したら例外の説明を通知し、既に通常貼り付けを止めていても添付の挿入は行わない。 */
test("createPastedSessionAttachmentHandler は保存失敗時に通知して挿入しない", async () => {
  const file = createPastedFile("failed.png", "failed");
  const alerts: string[] = [];
  let prevented = false;
  let inserted = false;

  const handlePaste = createPastedSessionAttachmentHandler({
    /** 保存失敗時にハンドラーが伝えた説明を比較できるよう記録する。 */
    alertError: (message) => {
      alerts.push(message);
    },
    /** 保存処理まで到達させるため、貼り付けを許可する。 */
    canPaste: () => true,
    /** 名前付きファイルの保存失敗に、固定の未使用時刻を用意する。 */
    currentTimestampLabel: () => "unused",
    fallbackErrorMessage: "fallback paste failure",
    /** 貼り付けを引き取った後に、メッセージのある Error を発生させる。 */
    getSavePastedSessionFile: () => async () => {
      throw new Error("save failed");
    },
    /** 保存開始後に失敗を発生させるため、有効な Session ID を用意する。 */
    getSessionId: () => "session-5",
    /** 保存失敗後にファイルが挿入された場合を検出する。 */
    insertAttachments: () => {
      inserted = true;
    },
  });

  const handled = await handlePaste({
    clipboardData: { files: [file], items: [] },
    /** 保存が失敗するより前に、貼り付けの既定処理を抑止したか記録する。 */
    preventDefault: () => {
      prevented = true;
    },
  });

  assert.equal(handled, false);
  assert.equal(prevented, true);
  assert.deepEqual(alerts, ["save failed"]);
  assert.equal(inserted, false);
});

/** 保存 API が Error 以外の値で失敗した場合、内部の値ではなく指定されている代替通知を使い、添付は挿入しない。 */
test("createPastedSessionAttachmentHandler は保存失敗が Error でない場合 fallback message を通知する", async () => {
  const file = createPastedFile("failed.png", "failed");
  const alerts: string[] = [];

  const handlePaste = createPastedSessionAttachmentHandler({
    /** Error ではない保存失敗に対して通知された文言を記録する。 */
    alertError: (message) => {
      alerts.push(message);
    },
    /** 失敗を確認する対象を保存 API に絞るため、貼り付け自体は許可する。 */
    canPaste: () => true,
    /** ファイル名を補う必要がないケース用に固定時刻を返す。 */
    currentTimestampLabel: () => "unused",
    fallbackErrorMessage: "fallback paste failure",
    /** Error でない値を保存失敗として投げ、代替文言に落ちる分岐に入れる。 */
    getSavePastedSessionFile: () => async () => {
      throw "non-error failure";
    },
    /** 保存 API が呼ばれるよう、有効な対象 Session を返す。 */
    getSessionId: () => "session-6",
    /** 代替通知の経路で挿入に進んだ場合、即座に失敗させる。 */
    insertAttachments: () => {
      throw new Error("unexpected insertion");
    },
  });

  const handled = await handlePaste({
    clipboardData: { files: [file], items: [] },
    /** 代替通知の検査では、既定処理を止めた結果に副作用は持たせない。 */
    preventDefault: () => {},
  });

  assert.equal(handled, false);
  assert.deepEqual(alerts, ["fallback paste failure"]);
});
