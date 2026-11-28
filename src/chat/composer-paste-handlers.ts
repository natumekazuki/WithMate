import type { WithMateWindowPickerApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { PastedSessionFileConflict } from "../../src-shared/window/withmate-window-types.js";
import { isSupportedComposerImagePath } from "../../src-shared/files/composer-image-reference.js";
import type { ComposerReferenceInput } from "./composer/session-composer-paths.js";

const SUPPORTED_IMAGE_MIME_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/bmp", "bmp"],
  ["image/svg+xml", "svg"],
]);

/** クリップボード上の名前・MIME種別と、保存時に読み出すファイルデータ。 */
export type PastedClipboardFile = {
  /** 保存APIに渡すファイルの内容を読み出す。 */
  arrayBuffer(): Promise<ArrayBuffer>;
  name: string;
  type?: string;
};

/** 保存済みファイルを入力欄へ挿入するときのパスと表示形式。 */
export type PastedSessionAttachment = ComposerReferenceInput;

/** 同名ファイルとの競合を置換、別名保存、または取り消しで解決する選択。 */
export type PastedFileConflictDecision = "replace" | "copy" | "cancel";

/** ファイル一覧が空の場合に調べるクリップボード項目。 */
export type PastedClipboardFileItem = {
  kind: string;
  /** 取り出せるファイルがなければ空値を返す。 */
  getAsFile(): PastedClipboardFile | null;
};

/** 貼り付け元が公開するファイル一覧と、一覧が空の場合の補助項目一覧。 */
export type PastedSessionFileClipboardData = {
  files: ArrayLike<PastedClipboardFile> | Iterable<PastedClipboardFile>;
  items: ArrayLike<PastedClipboardFileItem> | Iterable<PastedClipboardFileItem>;
};

/** 添付として扱うデータと、通常の貼り付けを取り消す操作を渡すイベント。 */
export type PastedSessionAttachmentEvent = {
  clipboardData: PastedSessionFileClipboardData;
  /** ファイル添付を処理するとき、ブラウザーによる既定の貼り付けを止める。 */
  preventDefault(): void;
};

/** クリップボードのファイル一覧を優先し、空の場合だけファイル項目から取り出す。 */
export function collectPastedClipboardFiles(
  clipboardData: PastedSessionFileClipboardData,
): PastedClipboardFile[] {
  const files = Array.from(clipboardData.files);
  if (files.length > 0) {
    return files;
  }

  return Array.from(clipboardData.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is PastedClipboardFile => file !== null);
}

/** クリップボードの添付をセッション内へ保存し、挿入用の情報からパスだけを返す。 */
export async function collectPastedSessionAttachmentPaths(input: {
  clipboardData: PastedSessionFileClipboardData;
  currentTimestampLabel: () => string;
  preventDefault: () => void;
  savePastedSessionFile: WithMateWindowPickerApi["savePastedSessionFile"];
  isFileBacked: (file: PastedClipboardFile) => boolean;
  sessionId: string;
  confirmReplacement?: (
    conflict: PastedSessionFileConflict,
  ) => Promise<PastedFileConflictDecision>;
  onReuse?: (fileNames: string[]) => void;
}): Promise<string[]> {
  return (await collectPastedSessionAttachments(input)).map(
    (attachment) => attachment.path,
  );
}

/** ファイル実体のない対応画像には内容由来の保存名を付け、その他は元の名前か時刻を使う。 */
async function resolvePastedFileName(input: {
  currentTimestampLabel: () => string;
  file: PastedClipboardFile;
  data: ArrayBuffer;
  useContentName: boolean;
}): Promise<string> {
  const trimmedName = input.file.name.trim();
  const mimeExtension = SUPPORTED_IMAGE_MIME_EXTENSIONS.get(
    input.file.type?.toLocaleLowerCase() ?? "",
  );
  if (input.useContentName && mimeExtension) {
    const digest = await crypto.subtle.digest("SHA-256", input.data);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `pasted-${hash}.${mimeExtension}`;
  }
  if (trimmedName) {
    if (mimeExtension && !isSupportedComposerImagePath(trimmedName)) {
      return `${trimmedName}.${mimeExtension}`;
    }
    return trimmedName;
  }

  const fallbackExtension = mimeExtension ?? "bin";
  return `pasted-${input.currentTimestampLabel().replace(/[:/\\\s]+/g, "-")}.${fallbackExtension}`;
}

/** MIME種別または保存名が対応画像を示す場合だけ、入力欄の画像表示を選ぶ。 */
function resolvePastedAttachmentPresentation(
  file: PastedClipboardFile,
  fileName: string,
): PastedSessionAttachment["presentation"] {
  const mimeType = file.type?.toLocaleLowerCase() ?? "";
  return SUPPORTED_IMAGE_MIME_EXTENSIONS.has(mimeType) ||
    isSupportedComposerImagePath(fileName)
    ? "image"
    : "path";
}

/**
 * ファイルの貼り付けを引き取り、セッション内に保存または再利用できた添付を入力順で返す。
 * 同名競合は確認結果に沿って解決し、内容由来の名前で衝突した場合は上書きせずエラーにする。
 */
export async function collectPastedSessionAttachments(input: {
  clipboardData: PastedSessionFileClipboardData;
  currentTimestampLabel: () => string;
  preventDefault: () => void;
  savePastedSessionFile: WithMateWindowPickerApi["savePastedSessionFile"];
  isFileBacked: (file: PastedClipboardFile) => boolean;
  sessionId: string;
  confirmReplacement?: (
    conflict: PastedSessionFileConflict,
  ) => Promise<PastedFileConflictDecision>;
  onReuse?: (fileNames: string[]) => void;
}): Promise<PastedSessionAttachment[]> {
  const pastedFiles = collectPastedClipboardFiles(input.clipboardData);
  if (pastedFiles.length === 0) {
    return [];
  }

  input.preventDefault();
  const savedAttachments: PastedSessionAttachment[] = [];
  const reused: string[] = [];
  for (const file of pastedFiles) {
    const useContentName =
      SUPPORTED_IMAGE_MIME_EXTENSIONS.has(
        file.type?.toLocaleLowerCase() ?? "",
      ) && !input.isFileBacked(file);
    const buffer = await file.arrayBuffer();
    const fileName = await resolvePastedFileName({
      file,
      data: buffer,
      useContentName,
      currentTimestampLabel: input.currentTimestampLabel,
    });
    const request = {
      sessionId: input.sessionId,
      fileName,
      data: buffer,
    };
    let result = await input.savePastedSessionFile(request);
    if (
      useContentName &&
      typeof result !== "string" &&
      result.status === "conflict"
    ) {
      throw new Error(
        `Cannot reuse "${fileName}": the saved image has different contents.`,
      );
    }
    while (typeof result !== "string" && result.status === "conflict") {
      if (!input.confirmReplacement)
        throw new Error(
          `Replacing "${result.fileName}" requires confirmation.`,
        );
      const decision = await input.confirmReplacement(result);
      if (decision === "cancel") break;
      result = await input.savePastedSessionFile(
        decision === "copy"
          ? { ...request, saveAsCopy: true }
          : { ...request, replaceExistingHash: result.existingHash },
      );
    }
    if (typeof result !== "string" && result.status === "conflict") continue;
    if (typeof result !== "string") reused.push(fileName);
    savedAttachments.push({
      path: typeof result === "string" ? result : result.path,
      presentation: resolvePastedAttachmentPresentation(file, fileName),
    });
  }

  if (reused.length) input.onReuse?.(reused);
  return savedAttachments;
}

/** 貼り付け可能なセッションで添付を保存・挿入し、失敗は通知して未挿入として返すハンドラーを作る。 */
export function createPastedSessionAttachmentHandler(input: {
  alertError: (message: string) => void;
  canPaste: () => boolean;
  currentTimestampLabel: () => string;
  fallbackErrorMessage: string;
  getSavePastedSessionFile: () =>
    WithMateWindowPickerApi["savePastedSessionFile"] | null | undefined;
  isFileBacked: (file: PastedClipboardFile) => boolean;
  getSessionId: () => string | null | undefined;
  insertAttachments: (attachments: PastedSessionAttachment[]) => void;
  confirmReplacement?: (
    conflict: PastedSessionFileConflict,
  ) => Promise<PastedFileConflictDecision>;
  onReuse?: (fileNames: string[]) => void;
}): (event: PastedSessionAttachmentEvent) => Promise<boolean> {
  return async (event) => {
    if (!input.canPaste()) {
      return false;
    }

    const savePastedSessionFile = input.getSavePastedSessionFile();
    const sessionId = input.getSessionId();
    if (!savePastedSessionFile || !sessionId) {
      return false;
    }

    try {
      const savedAttachments = await collectPastedSessionAttachments({
        clipboardData: event.clipboardData,
        currentTimestampLabel: input.currentTimestampLabel,
        /** ファイルが見つかった場合の既定操作の取り消しを、受信したイベントに委ねる。 */
        preventDefault: () => event.preventDefault(),
        savePastedSessionFile,
        isFileBacked: input.isFileBacked,
        sessionId,
        confirmReplacement: input.confirmReplacement,
        onReuse: input.onReuse,
      });
      if (savedAttachments.length === 0) {
        return false;
      }

      input.insertAttachments(savedAttachments);
      return true;
    } catch (error) {
      input.alertError(
        error instanceof Error ? error.message : input.fallbackErrorMessage,
      );
      return false;
    }
  };
}
