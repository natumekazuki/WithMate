import { formatMarkdownImageReference } from "../../../src-shared/files/composer-image-reference.js";
import {
  resolveWorkspaceDirectoryValidationMessage,
  type WorkspaceDirectoryValidationResult,
} from "../../../src-shared/window/workspace-directory-validation.js";

/** 入力済みパスは対象セッション向けに検証し、未指定ならフォルダーピッカーの選択結果を返す。 */
export async function selectAdditionalDirectoryPath(input: {
  sessionId: string;
  directoryPath?: string;
  initialPath: string | null;
  api: {
    /** 初期フォルダーを指定して選択を開き、キャンセルなら空値を返す。 */
    pickDirectory(initialPath: string | null): Promise<string | null>;
    /** 手入力されたパスを対象セッションの追加ディレクトリとして利用できるか検証する。 */
    validateSessionAdditionalDirectory(
      sessionId: string,
      targetPath: string,
    ): Promise<WorkspaceDirectoryValidationResult>;
  };
}): Promise<string | null> {
  if (input.directoryPath === undefined) {
    return input.api.pickDirectory(input.initialPath);
  }
  const directoryPath = input.directoryPath.trim();
  const result = await input.api.validateSessionAdditionalDirectory(
    input.sessionId,
    directoryPath,
  );
  if (!result.valid) {
    throw new Error(
      resolveWorkspaceDirectoryValidationMessage(result) ||
        "Enter an absolute path.",
    );
  }
  return directoryPath;
}

/** 追加ディレクトリの名前、親フォルダーの短縮表示、完全な表示用パス。 */
export type AdditionalDirectoryDisplay = {
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
};

/** 表示情報に、削除可否と操作対象を識別する元のパスを付けた一覧項目。 */
export type AdditionalDirectoryItem = AdditionalDirectoryDisplay & {
  canRemove: boolean;
  key: string;
  path: string;
};

/** 参照を挿入した本文と、挿入範囲の直後を指すキャレット位置。 */
export type PathReferenceInsertionState = {
  caret: number;
  draft: string;
};

/** 挿入するパスと、画像Markdownか通常のパス参照かの指定。 */
export type ComposerReferenceInput = {
  path: string;
  presentation: "image" | "path";
};

/** 参照を選ぶピッカーの対象種別。 */
export type ComposerPathPickerKind = "file" | "folder" | "image";

/** 参照対象の種別ごとに開ける、パス選択APIの組。 */
export type ComposerReferencePathPicker = {
  /** フォルダーを選び、キャンセルなら空値を返す。 */
  pickDirectory(initialPath?: string | null): Promise<string | null>;
  /** 通常ファイルを選び、キャンセルなら空値を返す。 */
  pickFile(initialPath?: string | null): Promise<string | null>;
  /** 画像ファイルを選び、キャンセルなら空値を返す。 */
  pickImageFile(initialPath?: string | null): Promise<string | null>;
};

/** パスを参照トークンにし、空白がある場合は二重引用符で囲む。 */
export function formatPathReference(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/** キャレットへ通常のパス参照を挿入し、前後の本文とは必要な空白で区切る。 */
export function buildPathReferenceInsertionState(
  draft: string,
  caret: number,
  referencePaths: readonly string[],
): PathReferenceInsertionState | null {
  if (referencePaths.length === 0) {
    return null;
  }

  const referenceTokens = referencePaths.map((referencePath) =>
    formatPathReference(referencePath),
  );
  const leadingSpacer =
    caret > 0 && !/\s/.test(draft[caret - 1] ?? "") ? " " : "";
  const trailingSpacer =
    draft.length > caret && !/\s/.test(draft[caret] ?? "") ? " " : "";
  const insertion = `${leadingSpacer}${referenceTokens.join(" ")}${trailingSpacer}`;
  return {
    draft: `${draft.slice(0, caret)}${insertion}${draft.slice(caret)}`,
    caret: caret + insertion.length,
  };
}

/** 画像Markdownと通常参照を同じ位置に入力順で挿入し、参照がなければ空値を返す。 */
export function buildComposerReferenceInsertionState(
  draft: string,
  caret: number,
  references: readonly ComposerReferenceInput[],
): PathReferenceInsertionState | null {
  if (references.length === 0) {
    return null;
  }

  const referenceTokens = references.map((reference) =>
    reference.presentation === "image"
      ? formatMarkdownImageReference(reference.path)
      : formatPathReference(reference.path),
  );
  const leadingSpacer =
    caret > 0 && !/\s/.test(draft[caret - 1] ?? "") ? " " : "";
  const trailingSpacer =
    draft.length > caret && !/\s/.test(draft[caret] ?? "") ? " " : "";
  const insertion = `${leadingSpacer}${referenceTokens.join(" ")}${trailingSpacer}`;
  return {
    draft: `${draft.slice(0, caret)}${insertion}${draft.slice(caret)}`,
    caret: caret + insertion.length,
  };
}

/** 参照や表示で使うパスの区切りをスラッシュにそろえる。 */
export function normalizePathForReference(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/** 末尾の区切りを除いた表示用パスを、末尾の名前と親パスに分ける。 */
export function splitPathForDisplay(filePath: string): {
  basename: string;
  parentPath: string;
} {
  const normalized = normalizePathForReference(filePath).replace(/\/+$/, "");
  if (!normalized) {
    return { basename: "", parentPath: "" };
  }

  const lastSlashIndex = normalized.lastIndexOf("/");
  if (lastSlashIndex < 0) {
    return {
      basename: normalized,
      parentPath: "",
    };
  }

  return {
    basename: normalized.slice(lastSlashIndex + 1),
    parentPath: normalized.slice(0, lastSlashIndex),
  };
}

/** 指定長を超えるパスの中間を省き、先頭と末尾の識別に必要な部分を残す。 */
export function compactPathForDisplay(
  filePath: string,
  maxLength = 40,
): string {
  if (filePath.length <= maxLength) {
    return filePath;
  }

  const headLength = Math.max(10, Math.floor((maxLength - 1) * 0.4));
  const tailLength = Math.max(14, maxLength - headLength - 1);
  return `${filePath.slice(0, headLength)}...${filePath.slice(-tailLength)}`;
}

/** 追加ディレクトリの名前と親の短縮表示を作り、ツールチップには正規化済みパスを残す。 */
export function buildAdditionalDirectoryDisplay(
  directoryPath: string,
): AdditionalDirectoryDisplay {
  const normalizedPath = normalizePathForReference(directoryPath).replace(
    /\/+$/,
    "",
  );
  const { basename, parentPath } = splitPathForDisplay(normalizedPath);
  return {
    primaryLabel: basename || normalizedPath,
    secondaryLabel: parentPath ? compactPathForDisplay(parentPath, 52) : "Root",
    title: normalizedPath,
  };
}

/** 選択順を保って一覧を作り、各項目に表示情報と操作用の元のパスを持たせる。 */
export function buildAdditionalDirectoryItems(
  directoryPaths: readonly string[],
  canRemove: boolean,
): AdditionalDirectoryItem[] {
  return directoryPaths.map((directoryPath) => {
    const directoryDisplay = buildAdditionalDirectoryDisplay(directoryPath);
    return {
      key: directoryPath,
      path: directoryPath,
      primaryLabel: directoryDisplay.primaryLabel,
      secondaryLabel: directoryDisplay.secondaryLabel,
      title: directoryDisplay.title,
      canRemove,
    };
  });
}

/** 区切りと英字の大小をそろえてワークスペース配下を判定し、外なら空値を返す。 */
export function toWorkspaceRelativeReference(
  workspacePath: string,
  selectedPath: string,
): string | null {
  const normalizedWorkspacePath = normalizePathForReference(
    workspacePath,
  ).replace(/\/+$/, "");
  const normalizedSelectedPath = normalizePathForReference(selectedPath);
  const workspacePrefix = `${normalizedWorkspacePath}/`;
  if (
    !normalizedSelectedPath
      .toLocaleLowerCase()
      .startsWith(workspacePrefix.toLocaleLowerCase())
  ) {
    return null;
  }

  return normalizedSelectedPath.slice(workspacePrefix.length);
}

/** 選択パスを順に処理し、ワークスペース配下は相対化、その他は区切りだけをそろえる。 */
export function resolveReferencePathsForInsertion(
  selectedPaths: readonly string[],
  workspacePath: string | null,
): string[] {
  return selectedPaths.map((selectedPath) =>
    workspacePath !== null
      ? (toWorkspaceRelativeReference(workspacePath, selectedPath) ??
        normalizePathForReference(selectedPath))
      : normalizePathForReference(selectedPath),
  );
}

/** 選択結果をワークスペース基準の参照へ変換してから、キャレットに挿入する。 */
export function buildSelectedPathReferenceInsertionState(input: {
  caret: number;
  draft: string;
  selectedPaths: readonly string[];
  workspacePath: string | null;
}): PathReferenceInsertionState | null {
  const referencePaths = resolveReferencePathsForInsertion(
    input.selectedPaths,
    input.workspacePath,
  );
  return buildPathReferenceInsertionState(
    input.draft,
    input.caret,
    referencePaths,
  );
}

/** パス末尾の区切りを除いて親を取り出し、区切りのない値はそのまま返す。 */
export function toDirectoryPath(selectedPath: string): string {
  const normalized = selectedPath.replace(/[\\/]+$/, "");
  const lastSlashIndex = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  if (lastSlashIndex < 0) {
    return normalized;
  }

  return normalized.slice(0, lastSlashIndex);
}

/** 次回選択の初期フォルダーとして、フォルダー選択なら選択先、ファイル選択ならその親を返す。 */
export function resolvePickedPathBaseDirectory(
  kind: ComposerPathPickerKind,
  selectedPath: string,
): string {
  return kind === "folder" ? selectedPath : toDirectoryPath(selectedPath);
}

/** 初期パスをそのまま渡して種別に対応するピッカーを開き、キャンセル時は空値を返す。 */
export async function pickComposerReferencePath(
  kind: ComposerPathPickerKind,
  initialPath: string | null,
  picker: ComposerReferencePathPicker,
): Promise<string | null> {
  switch (kind) {
    case "folder":
      return await picker.pickDirectory(initialPath);
    case "image":
      return await picker.pickImageFile(initialPath);
    case "file":
    default:
      return await picker.pickFile(initialPath);
  }
}
