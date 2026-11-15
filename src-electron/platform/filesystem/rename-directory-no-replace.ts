import path from "node:path";
import koffi from "koffi";

type NativeRename = {
  rename: (source: string, destination: string) => number;
  failed: (result: number) => boolean;
  errorCode: () => number;
  syscall: string;
};

let nativeRename: NativeRename | undefined;

/** Publishes a directory without replacing any existing destination entry. */
export function renameDirectoryNoReplace(source: string, destination: string): void {
  if (source.includes("\0") || destination.includes("\0")) {
    throw new TypeError("Directory rename paths must not contain null bytes.");
  }
  if (!["win32", "linux", "darwin"].includes(process.platform)) {
    throw Object.assign(new Error(`Atomic no-replace rename is unavailable on ${process.platform}.`), {
      code: "ENOTSUP",
    });
  }
  if (nativeRename === undefined) {
    try {
      nativeRename = loadNativeRename();
    } catch (cause) {
      throw Object.assign(new Error("Atomic no-replace rename could not be loaded.", { cause }), {
        code: "ENOTSUP",
      });
    }
  }

  const result = nativeRename.rename(source, destination);
  if (!nativeRename.failed(result)) return;
  // Read the native error before making any other native call.
  const errno = nativeRename.errorCode();
  const code = process.platform === "win32"
    ? `WIN32_${errno}`
    : Object.entries(koffi.os.errno).find(([, value]) => value === errno)?.[0] ?? `ERRNO_${errno}`;
  throw Object.assign(new Error(`${nativeRename.syscall} failed (${code}): ${source} -> ${destination}`), {
    code,
    errno,
    syscall: nativeRename.syscall,
    path: source,
    dest: destination,
  });
}

function loadNativeRename(): NativeRename {
  if (process.platform === "win32") {
    const kernel32 = koffi.load("kernel32.dll");
    const moveFileEx = kernel32.func("__stdcall", "MoveFileExW", "int", ["str16", "str16", "uint32_t"]);
    const getLastError = kernel32.func("__stdcall", "GetLastError", "uint32_t", []);
    return {
      // No REPLACE_EXISTING or COPY_ALLOWED: neither overwrite nor copy/delete is permitted.
      rename: (source, destination) => moveFileEx(path.toNamespacedPath(source), path.toNamespacedPath(destination), 0),
      failed: (result) => result === 0,
      errorCode: getLastError,
      syscall: "MoveFileExW",
    };
  }
  if (process.platform === "linux") {
    const libc = koffi.load("libc.so.6");
    const renameat2 = libc.func("renameat2", "int", ["int", "str", "int", "str", "uint32_t"]);
    return {
      rename: (source, destination) => renameat2(-100, source, -100, destination, 1), // AT_FDCWD, RENAME_NOREPLACE
      failed: (result) => result !== 0,
      errorCode: () => koffi.errno(),
      syscall: "renameat2",
    };
  }
  const libSystem = koffi.load("/usr/lib/libSystem.B.dylib");
  const renamex = libSystem.func("renamex_np", "int", ["str", "str", "uint32_t"]);
  return {
    rename: (source, destination) => renamex(source, destination, 4), // RENAME_EXCL
    failed: (result) => result !== 0,
    errorCode: () => koffi.errno(),
    syscall: "renamex_np",
  };
}
