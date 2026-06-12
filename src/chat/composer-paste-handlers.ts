import type { WithMateWindowPickerApi } from "../withmate-window-api.js";

export type PastedClipboardFile = Pick<File, "arrayBuffer" | "name">;

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
  sessionId: string;
}): Promise<string[]> {
  const pastedFiles = collectPastedClipboardFiles(input.clipboardData);
  if (pastedFiles.length === 0) {
    return [];
  }

  input.preventDefault();
  const savedPaths: string[] = [];
  for (const file of pastedFiles) {
    const buffer = await file.arrayBuffer();
    const fileName = file.name.trim() || `pasted-${input.currentTimestampLabel().replace(/[:/\\\s]+/g, "-")}.png`;
    const savedPath = await input.savePastedSessionFile({
      sessionId: input.sessionId,
      fileName,
      data: buffer,
    });
    savedPaths.push(savedPath);
  }

  return savedPaths;
}

export function createPastedSessionAttachmentHandler(input: {
  alertError: (message: string) => void;
  canPaste: () => boolean;
  currentTimestampLabel: () => string;
  fallbackErrorMessage: string;
  getSavePastedSessionFile: () => WithMateWindowPickerApi["savePastedSessionFile"] | null | undefined;
  getSessionId: () => string | null | undefined;
  insertReferencePaths: (referencePaths: string[]) => void;
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
      const savedPaths = await collectPastedSessionAttachmentPaths({
        clipboardData: event.clipboardData,
        currentTimestampLabel: input.currentTimestampLabel,
        preventDefault: () => event.preventDefault(),
        savePastedSessionFile,
        sessionId,
      });
      if (savedPaths.length === 0) {
        return false;
      }

      input.insertReferencePaths(savedPaths);
      return true;
    } catch (error) {
      input.alertError(error instanceof Error ? error.message : input.fallbackErrorMessage);
      return false;
    }
  };
}
