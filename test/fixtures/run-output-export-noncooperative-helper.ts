import { createReadStream } from "node:fs";

const ownerProcessId = process.ppid;
const control = createReadStream("", { fd: 3 });

process.stdin.resume();
control.resume();

setInterval(() => {
  try {
    process.kill(ownerProcessId, 0);
  } catch {
    process.exit(0);
  }
}, 50);
