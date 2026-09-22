import type {
  SessionFileEncoding,
  SessionFileResourceKind,
} from "./file-explorer-contract.js";

export function detectSessionFileResourceKind(
  fileName: string,
  bytes: Uint8Array,
): { kind: SessionFileResourceKind; mimeType: string } {
  const normalizedName = fileName.toLocaleLowerCase("en-US");
  const dotIndex = normalizedName.lastIndexOf(".");
  const extension = dotIndex >= 0 ? normalizedName.slice(dotIndex) : "";
  const isMarkdown = extension === ".md" || extension === ".markdown";
  const imageTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".avif": "image/avif",
  };
  const headerText = new TextDecoder("utf-8").decode(bytes.subarray(0, Math.min(bytes.length, 1024))).trimStart();
  const detectedImageMime =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      ? "image/png"
      : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        ? "image/jpeg"
        : headerText.startsWith("GIF87a") || headerText.startsWith("GIF89a")
          ? "image/gif"
          : headerText.startsWith("RIFF") && headerText.slice(8, 12) === "WEBP"
            ? "image/webp"
            : bytes[0] === 0x42 && bytes[1] === 0x4d
              ? "image/bmp"
              : null;
  if (extension === ".svg" || /^<\?xml[\s\S]*?<svg\b/i.test(headerText) || /^<svg\b/i.test(headerText)) {
    return { kind: "svg", mimeType: "image/svg+xml" };
  }
  if (detectedImageMime || imageTypes[extension]) {
    return { kind: "image", mimeType: detectedImageMime ?? imageTypes[extension] };
  }
  if (isUtf16SessionFile(bytes)) {
    return isMarkdown
      ? { kind: "markdown", mimeType: "text/markdown" }
      : { kind: "text", mimeType: "text/plain" };
  }
  if (isLikelyBinarySessionFile(bytes)) {
    return { kind: "binary", mimeType: "application/octet-stream" };
  }
  if (isMarkdown) {
    return { kind: "markdown", mimeType: "text/markdown" };
  }
  return { kind: "text", mimeType: "text/plain" };
}

export function isUtf16SessionFile(bytes: Uint8Array): boolean {
  return (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  );
}

function canDecode(bytes: Uint8Array, encoding: SessionFileEncoding): boolean {
  try {
    new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function detectSessionFileEncoding(bytes: Uint8Array): SessionFileEncoding {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf-16le";
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf-16be";
  }
  if (canDecode(bytes, "utf-8")) {
    return "utf-8";
  }
  if (canDecode(bytes, "shift_jis")) {
    return "shift_jis";
  }
  return "utf-8";
}

export function isLikelyBinarySessionFile(bytes: Uint8Array): boolean {
  if (isUtf16SessionFile(bytes)) {
    return false;
  }
  let suspiciousControlBytes = 0;
  for (const byte of bytes) {
    if (byte === 0 || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      suspiciousControlBytes += 1;
    }
  }
  return bytes.includes(0) || (bytes.length > 0 && suspiciousControlBytes / bytes.length > 0.1);
}
