import path from "node:path";

import type { MateTalkTurnInput } from "../src/mate/mate-state.js";

function normalizeDirectoryPath(directoryPath: string): string {
  return path.resolve(directoryPath.trim());
}

function toAttachmentAccessDirectory(attachment: NonNullable<MateTalkTurnInput["attachments"]>[number]): string | null {
  const attachmentPath = attachment.path.trim();
  if (!attachmentPath || !path.isAbsolute(attachmentPath)) {
    return null;
  }

  return attachment.kind === "folder"
    ? normalizeDirectoryPath(attachmentPath)
    : normalizeDirectoryPath(path.dirname(attachmentPath));
}

export function buildMateTalkProviderAdditionalDirectories(input: {
  attachments?: MateTalkTurnInput["attachments"];
  additionalDirectories?: MateTalkTurnInput["additionalDirectories"];
}): string[] {
  const directories: string[] = [];
  const seen = new Set<string>();

  const addDirectory = (directoryPath: string | null | undefined) => {
    if (!directoryPath) {
      return;
    }

    const normalizedPath = normalizeDirectoryPath(directoryPath);
    const key = process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    directories.push(normalizedPath);
  };

  for (const directory of input.additionalDirectories ?? []) {
    const trimmedDirectory = directory.trim();
    if (trimmedDirectory) {
      addDirectory(trimmedDirectory);
    }
  }

  for (const attachment of input.attachments ?? []) {
    addDirectory(toAttachmentAccessDirectory(attachment));
  }

  return directories;
}
