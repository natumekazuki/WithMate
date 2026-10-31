import type { IpcMainEvent, IpcMainInvokeEvent, Session } from "electron";

const previewSessions = new WeakSet<Session>();

export function registerHtmlPreviewSession(session: Session): void {
  previewSessions.add(session);
}

/** A retired partition stays untrusted, so late guest IPC cannot become an app request. */
export function assertNotHtmlPreviewSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (previewSessions.has(event.sender.session)) throw new Error("HTML content cannot use WithMate IPC.");
}
