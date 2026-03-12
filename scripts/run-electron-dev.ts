import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const electronBinary = path.resolve(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);

const child = spawn(electronBinary, ["dist-electron/src-electron/main.js"], {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL ?? "http://localhost:4173",
  },
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
