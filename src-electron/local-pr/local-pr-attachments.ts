import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const imageExtensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg",
};

/** クリップボードにしかない画像のバイト列を、どの Session の存続期間にも依存せず保存する。 */
export async function saveLocalPrClipboardImage(userData: string, input: { mimeType: string; data: ArrayBuffer }): Promise<string> {
  const extension = imageExtensions[input.mimeType];
  if (!extension) throw new Error("The clipboard image type is not supported.");
  const directory = path.join(userData, "local-pr-attachments");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${randomUUID()}.${extension}`);
  await writeFile(target, new Uint8Array(input.data), { flag: "wx" });
  return target;
}
