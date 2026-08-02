import type { SessionFileEncoding } from "./file-explorer-contract.js";

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
