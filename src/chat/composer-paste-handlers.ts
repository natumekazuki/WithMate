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

export type PastedClipboardFile = {
  arrayBuffer(): Promise<ArrayBuffer>;
  name: string;
  type?: string;
};

export type PastedSessionAttachment = ComposerReferenceInput;

export type PastedFileConflictDecision = "replace" | "copy" | "cancel";

export type PastedClipboardFileItem = {
  kind: string;
  getAsFile(): PastedClipboardFile | null;
};

export type PastedSessionFileClipboardData = {
  files: ArrayLike<PastedClipboardFile> | Iterable<PastedClipboardFile>;
  items: ArrayLike<PastedClipboardFileItem> | Iterable<PastedClipboardFileItem>;
};

export type PastedSessionAttachmentEvent = {
  clipboardData: PastedSessionFileClipboardData;
  preventDefault(): void;
};

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

export async function collectPastedSessionAttachmentPaths(input: {
  clipboardData: PastedSessionFileClipboardData;
  currentTimestampLabel: () => string;
  preventDefault: () => void;
  savePastedSessionFile: WithMateWindowPickerApi["savePastedSessionFile"];
  isFileBacked: (file: PastedClipboardFile) => boolean;
  sessionId: string;
  confirmReplacement?: (conflict: PastedSessionFileConflict) => Promise<PastedFileConflictDecision>;
  onReuse?: (fileNames: string[]) => void;
}): Promise<string[]> {
  return (await collectPastedSessionAttachments(input)).map((attachment) => attachment.path);
}

function resolvePastedFileName(input: {
  currentTimestampLabel: () => string;
  file: PastedClipboardFile;
  useGeneratedName: boolean;
}): string {
  const trimmedName = input.file.name.trim();
  const mimeExtension = SUPPORTED_IMAGE_MIME_EXTENSIONS.get(input.file.type?.toLocaleLowerCase() ?? "");
  if (trimmedName && !input.useGeneratedName) {
    if (mimeExtension && !isSupportedComposerImagePath(trimmedName)) {
      return `${trimmedName}.${mimeExtension}`;
    }
    return trimmedName;
  }

  const fallbackExtension = mimeExtension ?? "bin";
  return `pasted-${input.currentTimestampLabel().replace(/[:/\\\s]+/g, "-")}.${fallbackExtension}`;
}

function resolvePastedAttachmentPresentation(
  file: PastedClipboardFile,
  fileName: string,
): PastedSessionAttachment["presentation"] {
  const mimeType = file.type?.toLocaleLowerCase() ?? "";
  return SUPPORTED_IMAGE_MIME_EXTENSIONS.has(mimeType) || isSupportedComposerImagePath(fileName)
    ? "image"
    : "path";
}

export async function collectPastedSessionAttachments(input: {
  clipboardData: PastedSessionFileClipboardData;
  currentTimestampLabel: () => string;
  preventDefault: () => void;
  savePastedSessionFile: WithMateWindowPickerApi["savePastedSessionFile"];
  isFileBacked: (file: PastedClipboardFile) => boolean;
  sessionId: string;
  confirmReplacement?: (conflict: PastedSessionFileConflict) => Promise<PastedFileConflictDecision>;
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
    const useGeneratedName = SUPPORTED_IMAGE_MIME_EXTENSIONS.has(file.type?.toLocaleLowerCase() ?? "")
      && !input.isFileBacked(file);
    const buffer = await file.arrayBuffer();
    const fileName = resolvePastedFileName({ file, useGeneratedName, currentTimestampLabel: input.currentTimestampLabel });
    const request = {
      sessionId: input.sessionId,
      fileName,
      data: buffer,
    };
    let result = await input.savePastedSessionFile(request);
    if (useGeneratedName && typeof result !== "string" && result.status === "conflict") {
      result = await input.savePastedSessionFile({ ...request, saveAsCopy: true });
    }
    while (typeof result !== "string" && result.status === "conflict") {
      if (!input.confirmReplacement) throw new Error(`Replacing "${result.fileName}" requires confirmation.`);
      const decision = await input.confirmReplacement(result);
      if (decision === "cancel") break;
      result = await input.savePastedSessionFile(decision === "copy"
        ? { ...request, saveAsCopy: true }
        : { ...request, replaceExistingHash: result.existingHash });
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

export function createPastedSessionAttachmentHandler(input: {
  alertError: (message: string) => void;
  canPaste: () => boolean;
  currentTimestampLabel: () => string;
  fallbackErrorMessage: string;
  getSavePastedSessionFile: () => WithMateWindowPickerApi["savePastedSessionFile"] | null | undefined;
  isFileBacked: (file: PastedClipboardFile) => boolean;
  getSessionId: () => string | null | undefined;
  insertAttachments: (attachments: PastedSessionAttachment[]) => void;
  confirmReplacement?: (conflict: PastedSessionFileConflict) => Promise<PastedFileConflictDecision>;
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
      input.alertError(error instanceof Error ? error.message : input.fallbackErrorMessage);
      return false;
    }
  };
}
