import type {
  SessionFileObjectCopyLinkRequest,
  SessionFileObjectCopyResult,
} from "./file-explorer/session-file-object-copy-contract.js";

export type MarkdownLinkContextMenuPoint = {
  x: number;
  y: number;
};

export type MarkdownLinkContextMenuRequest = {
  target: string;
  point: MarkdownLinkContextMenuPoint;
  fileContext?: Omit<SessionFileObjectCopyLinkRequest, "target">;
};

export type MarkdownLinkContextMenuResult =
  | { status: "link-copied" }
  | { status: "file-copy"; result: SessionFileObjectCopyResult }
  | { status: "dismissed" }
  | { status: "failed"; message: string };
