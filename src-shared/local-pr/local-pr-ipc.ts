import { z } from "zod";
import { mainSessionTargetSchema } from "../session/session-target.js";

/** Only the owning Session main frame can open its repository's Pull Requests window. */
export const openLocalPrWindowInput = mainSessionTargetSchema;

export const LOCAL_PR_OPEN_WINDOW = "withmate:local-pr:open-window";
export const LOCAL_PR_EXECUTE = "withmate:local-pr:execute";
export const LOCAL_PR_CHANGED = "withmate:local-pr:changed";
export const LOCAL_PR_PICK_ATTACHMENT = "withmate:local-pr:pick-attachment";
export const LOCAL_PR_SAVE_CLIPBOARD_IMAGE = "withmate:local-pr:save-clipboard-image";
export const LOCAL_PR_OPEN_ATTACHMENT = "withmate:local-pr:open-attachment";
export const localPrClipboardImageInput = z.strictObject({ mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/svg+xml"]), data: z.instanceof(ArrayBuffer) });
export const LOCAL_PR_INSPECT_IMAGE = "withmate:local-pr:inspect-image";
export const LOCAL_PR_READ_IMAGE_CHUNK = "withmate:local-pr:read-image-chunk";

export const localPrImageInput = z.strictObject({ target: z.string().trim().min(1).max(32768) });
export const localPrImageChunkInput = localPrImageInput.extend({
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  expectedRevision: z.string(),
});
