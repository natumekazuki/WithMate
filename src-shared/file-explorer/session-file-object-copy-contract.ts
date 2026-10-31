import type {
  SessionFilePreviewResourceRequest,
  SessionFileResourceRequest,
} from "./file-explorer-contract.js";

export type SessionFileObjectCopyResult =
  | { status: "copied"; message: string }
  | { status: "not-copyable"; message: string }
  | { status: "failed"; message: string }
  | { status: "effect-unknown"; message: string };

export type SessionFileObjectCopyRequest = {
  resource: SessionFileResourceRequest;
};

export type SessionFileObjectCopyLinkRequest = {
  sessionId: string;
  target: string;
  baseResource?: SessionFilePreviewResourceRequest;
};

export type SessionFileObjectCopyPoint = {
  x: number;
  y: number;
};

export type SessionFileObjectCopyContextMenuRequest = SessionFileObjectCopyRequest & {
  point: SessionFileObjectCopyPoint;
};

export type SessionFileObjectCopyContextMenuResult =
  | SessionFileObjectCopyResult
  | { status: "dismissed" };

export function getSessionFileObjectCopyFeedbackTone(
  result: SessionFileObjectCopyResult,
): "success" | "error" {
  return result.status === "copied" ? "success" : "error";
}
