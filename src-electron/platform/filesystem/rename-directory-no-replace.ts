import path from "node:path";
import koffi from "koffi";

/** 上書きしない移動と、OSごとに異なる戻り値・エラーの取得方法をまとめたネイティブ操作。 */
type NativeRename = {
  rename: (source: string, destination: string) => number;
  failed: (result: number) => boolean;
  errorCode: () => number;
  syscall: string;
};

let nativeRename: NativeRename | undefined;

/** 移動先に既存の項目があっても置き換えずに、ディレクトリを公開する。 */
export function renameDirectoryNoReplace(
  source: string,
  destination: string,
): void {
  if (source.includes("\0") || destination.includes("\0")) {
    throw new TypeError("Directory rename paths must not contain null bytes.");
  }
  if (!["win32", "linux", "darwin"].includes(process.platform)) {
    throw Object.assign(
      new Error(
        `Atomic no-replace rename is unavailable on ${process.platform}.`,
      ),
      {
        code: "ENOTSUP",
      },
    );
  }
  if (nativeRename === undefined) {
    try {
      nativeRename = loadNativeRename();
    } catch (cause) {
      throw Object.assign(
        new Error("Atomic no-replace rename could not be loaded.", { cause }),
        {
          code: "ENOTSUP",
        },
      );
    }
  }

  const result = nativeRename.rename(source, destination);
  if (!nativeRename.failed(result)) return;
  // 次のネイティブ呼び出しを行う前に、ネイティブ側のエラーを読み取る。
  const errno = nativeRename.errorCode();
  const code =
    process.platform === "win32"
      ? `WIN32_${errno}`
      : (Object.entries(koffi.os.errno).find(
          ([, value]) => value === errno,
        )?.[0] ?? `ERRNO_${errno}`);
  throw Object.assign(
    new Error(
      `${nativeRename.syscall} failed (${code}): ${source} -> ${destination}`,
    ),
    {
      code,
      errno,
      syscall: nativeRename.syscall,
      path: source,
      dest: destination,
    },
  );
}

/** OSが提供する排他的な移動操作を読み込む。通常の上書き可能な移動には切り替えない。 */
function loadNativeRename(): NativeRename {
  if (process.platform === "win32") {
    const kernel32 = koffi.load("kernel32.dll");
    const moveFileEx = kernel32.func("__stdcall", "MoveFileExW", "int", [
      "str16",
      "str16",
      "uint32_t",
    ]);
    const getLastError = kernel32.func(
      "__stdcall",
      "GetLastError",
      "uint32_t",
      [],
    );
    return {
      // REPLACE_EXISTING と COPY_ALLOWED は指定せず、上書きもコピー後の削除も許可しない。
      /** Windows向けのパス表記で、既存宛先の置換もコピーへの切り替えもせずに移動する。 */
      rename: (source, destination) =>
        moveFileEx(
          path.toNamespacedPath(source),
          path.toNamespacedPath(destination),
          0,
        ),
      /** BOOLを整数として受け取り、ゼロを移動失敗と判定する。 */
      failed: (result) => result === 0,
      errorCode: getLastError,
      syscall: "MoveFileExW",
    };
  }
  if (process.platform === "linux") {
    const libc = koffi.load("libc.so.6");
    const renameat2 = libc.func("renameat2", "int", [
      "int",
      "str",
      "int",
      "str",
      "uint32_t",
    ]);
    return {
      /** 相対パスは現在の作業ディレクトリを基準とし、既存の宛先を置換せずに移動する。 */
      rename: (source, destination) =>
        renameat2(-100, source, -100, destination, 1), // AT_FDCWD, RENAME_NOREPLACE
      /** 成功を示すゼロ以外の戻り値を失敗と判定する。 */
      failed: (result) => result !== 0,
      /** 移動の失敗直後にKoffiが保持するerrnoを取得する。 */
      errorCode: () => koffi.errno(),
      syscall: "renameat2",
    };
  }
  const libSystem = koffi.load("/usr/lib/libSystem.B.dylib");
  const renamex = libSystem.func("renamex_np", "int", [
    "str",
    "str",
    "uint32_t",
  ]);
  return {
    /** 排他的な移動を要求し、宛先に項目があれば置換せず失敗する。 */
    rename: (source, destination) => renamex(source, destination, 4), // RENAME_EXCL
    /** 成功を示すゼロ以外の戻り値を失敗と判定する。 */
    failed: (result) => result !== 0,
    /** 移動の失敗直後にKoffiが保持するerrnoを取得する。 */
    errorCode: () => koffi.errno(),
    syscall: "renamex_np",
  };
}
