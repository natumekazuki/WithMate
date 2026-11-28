import { z } from "zod";
import { mainSessionTargetSchema } from "../session/session-target.js";

/** Only the owning Session main frame can open its repository's Pull Requests window. */
export const openLocalPrWindowInput = mainSessionTargetSchema;

export const LOCAL_PR_OPEN_WINDOW = "withmate:local-pr:open-window";
export const LOCAL_PR_EXECUTE = "withmate:local-pr:execute";
export const LOCAL_PR_CHANGED = "withmate:local-pr:changed";
export const LOCAL_PR_PICK_ATTACHMENT = "withmate:local-pr:pick-attachment";
export const LOCAL_PR_SAVE_PASTED_FILE = "withmate:local-pr:save-pasted-file";
export const localPrAttachmentKind = z.enum(["file", "folder", "image", "session-copy", "session-file", "session-folder", "session-image"]);
export const localPrPastedFileInput = z.strictObject({ fileName: z.string().min(1), data: z.instanceof(ArrayBuffer), replaceExistingHash: z.string().optional(), saveAsCopy: z.boolean().optional() });
export const LOCAL_PR_INSPECT_IMAGE = "withmate:local-pr:inspect-image";
export const LOCAL_PR_READ_IMAGE_CHUNK = "withmate:local-pr:read-image-chunk";

export const localPrImageInput = z.strictObject({ target: z.string().trim().min(1).max(32768) });
export const localPrImageChunkInput = localPrImageInput.extend({
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  expectedRevision: z.string(),
});
