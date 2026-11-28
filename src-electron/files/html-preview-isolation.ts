import type { IpcMainEvent, IpcMainInvokeEvent, Session } from "electron";

const previewSessions = new WeakSet<Session>();

export function registerHtmlPreviewSession(session: Session): void {
  previewSessions.add(session);
}

/** 使用を終えたパーティションも信頼しない。遅れて届いたゲストの IPC がアプリへの要求として扱われることはない。 */
export function assertNotHtmlPreviewSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (previewSessions.has(event.sender.session)) throw new Error("HTML content cannot use WithMate IPC.");
}
