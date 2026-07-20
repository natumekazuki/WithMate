import { spawn } from "node:child_process";

const HELPER_SOURCE = String.raw`
const fs = require("node:fs");

const expectedRoot = process.argv[1];
const expectedIdentity = {
  device: process.argv[2],
  inode: process.argv[3],
  birthtimeNanoseconds: process.argv[4],
};
const actualRoot = fs.realpathSync(".");
const actualStats = fs.statSync(".", { bigint: true });
const actualIdentity = {
  device: actualStats.dev.toString(),
  inode: actualStats.ino.toString(),
  birthtimeNanoseconds: actualStats.birthtimeNs.toString(),
};
const normalize = process.platform === "win32" ? (value) => value.toLowerCase() : (value) => value;
const sendAndExit = (message, code) => {
  if (process.send) process.send(message);
  setTimeout(() => process.exit(code), 10);
};
process.once("disconnect", () => process.exit(1));

if (
  normalize(actualRoot) !== normalize(expectedRoot) ||
  actualIdentity.device !== expectedIdentity.device ||
  actualIdentity.inode !== expectedIdentity.inode ||
  actualIdentity.birthtimeNanoseconds !== expectedIdentity.birthtimeNanoseconds
) {
  sendAndExit({ type: "unsafe_root" }, 2);
} else {
  if (process.send) process.send({ type: "ready" });
  process.once("message", (message) => {
    try {
      if (
        message === null ||
        typeof message !== "object" ||
        message.type !== "delete" ||
        typeof message.sessionId !== "string" ||
        !/^session_[0-9a-f]{96}$/.test(message.sessionId)
      ) {
        throw new Error("invalid request");
      }
      // 一時的なfilesystem errorだけをbounded retryし、固定済みroot外へ対象を広げない。
      fs.rmSync(message.sessionId, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
      sendAndExit({ type: "completed" }, 0);
    } catch (error) {
      const code =
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "UNKNOWN";
      sendAndExit({ type: "filesystem_failed", code }, 1);
    }
  });
}
`;

export type AnchoredSessionFilesRemoveHook = () => void | Promise<void>;
export type SessionFilesRootIdentity = Readonly<{
  device: string;
  inode: string;
  birthtimeNanoseconds: string;
}>;

export async function removeSessionFilesFromAnchoredRoot(
  sessionFilesRoot: string,
  expectedCanonicalRoot: string,
  expectedRootIdentity: SessionFilesRootIdentity,
  sessionId: string,
  beforeDelete?: AnchoredSessionFilesRemoveHook,
): Promise<void> {
  // cwdでrootの実体へ固定し、検証後のjunction差し替えで削除先が変わる経路を閉じる。
  const child = spawn(
    process.execPath,
    [
      "-e",
      HELPER_SOURCE,
      expectedCanonicalRoot,
      expectedRootIdentity.device,
      expectedRootIdentity.inode,
      expectedRootIdentity.birthtimeNanoseconds,
    ],
    {
      cwd: sessionFilesRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    },
  );

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let ready = false;
    let responseReceived = false;
    let responseError: Error | undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      child.removeAllListeners();
      if (child.connected) child.disconnect();
      if (error === undefined) resolve();
      else reject(error);
    };

    child.once("error", () => finish(new Error("Session Files cleanup helper failed to start.")));
    child.once("exit", (code) => {
      if (settled) return;
      if (responseReceived) finish(responseError);
      else
        finish(new Error(code === 2 ? "Session Files root changed before cleanup." : "Session Files cleanup failed."));
    });
    child.on("message", (message: unknown) => {
      if (message === null || typeof message !== "object" || !("type" in message)) {
        finish(new Error("Session Files cleanup helper returned an invalid response."));
        return;
      }
      const type = (message as Readonly<{ type?: unknown }>).type;
      if (type === "unsafe_root") {
        responseReceived = true;
        responseError = new Error("Session Files root changed before cleanup.");
        return;
      }
      if (type === "filesystem_failed") {
        responseReceived = true;
        const code = (message as Readonly<{ code?: unknown }>).code;
        responseError = new Error(
          typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
            ? `Session Files cleanup failed (${code}).`
            : "Session Files cleanup failed.",
        );
        return;
      }
      if (type === "completed") {
        responseReceived = true;
        return;
      }
      if (type !== "ready" || ready) {
        responseReceived = true;
        responseError = new Error("Session Files cleanup helper returned an invalid response.");
        child.kill();
        return;
      }
      ready = true;
      Promise.resolve()
        .then(() => beforeDelete?.())
        .then(() => {
          if (!settled) child.send({ type: "delete", sessionId });
        })
        .catch(() => {
          if (!settled) child.send({ type: "cancel" });
        });
    });
  });
}
