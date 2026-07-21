import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const scenario = process.argv[2];
const supportedScenarios = new Set([
  "framing",
  "normal",
  "early-exit",
  "malformed-handshake",
  "partial-handshake",
  "oversized-handshake",
  "invalid-utf8-handshake",
  "stderr",
  "reverse",
  "events",
  "crash-on-request",
  "clean-exit-on-request",
  "exit-after-initialized",
  "delayed-response",
  "ignore-input",
  "ignore-all-input",
  "event-then-malformed",
  "exit-after-final-event",
  "exit-with-descendant",
  "exit-with-orphaned-grandchild",
  "close-with-descendant",
  "ignore-input-with-descendant",
]);

if (!supportedScenarios.has(scenario)) {
  process.stderr.write("Unsupported fixture scenario.\n");
  process.exitCode = 64;
} else if (scenario === "framing") {
  const chunks = ['{"id":1,"result":{"text":"', '分割"}}\r\n{"method":"future/event","params":{"ok":true}}', "\n"];
  for (const chunk of chunks) {
    process.stdout.write(chunk);
    await new Promise((resolve) => setImmediate(resolve));
  }
} else if (scenario === "early-exit") {
  process.exitCode = 23;
} else {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const reverseRequests = [];
  let keepAlive;

  if (scenario === "ignore-all-input") {
    input.pause();
    process.stdin.pause();
    keepAlive = setInterval(() => undefined, 1000);
  }

  input.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.exitCode = 65;
      input.close();
      return;
    }

    if (message.method === "initialize") {
      if (scenario === "malformed-handshake") {
        process.stdout.write("{bad\n");
        return;
      }
      if (scenario === "partial-handshake") {
        process.stdout.write('{"id":1,"result":');
        setTimeout(() => process.exit(0), 10);
        return;
      }
      if (scenario === "oversized-handshake") {
        process.stdout.write(`${"x".repeat(256)}\n`);
        return;
      }
      if (scenario === "invalid-utf8-handshake") {
        process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
        return;
      }
      if (scenario === "stderr") {
        process.stderr.write("token=secret-value C:\\Users\\person\\private.txt account@example.com\n");
        process.stderr.write("x".repeat(4096));
      }
      send({
        id: message.id,
        result: {
          codexHome: process.cwd(),
          platformFamily: process.platform === "win32" ? "windows" : "unix",
          platformOs: process.platform,
          userAgent: "codex-fixture/1.0",
        },
      });
      return;
    }

    if (message.method === "initialized") {
      if (scenario === "exit-after-initialized") {
        setTimeout(() => process.exit(0), 20);
      } else if (scenario === "close-with-descendant") {
        const descendant = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
          detached: process.platform === "win32",
          stdio: "ignore",
          windowsHide: true,
        });
        descendant.unref();
        send({ method: "fixture/descendant", params: { pid: descendant.pid } });
      } else if (scenario === "ignore-input" || scenario === "ignore-input-with-descendant") {
        if (scenario === "ignore-input-with-descendant") {
          const descendant = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
            detached: process.platform === "win32",
            stdio: "ignore",
            windowsHide: true,
          });
          descendant.unref();
          send({ method: "fixture/descendant", params: { pid: descendant.pid } });
        }
        input.pause();
        process.stdin.pause();
        keepAlive = setInterval(() => undefined, 1000);
      }
      return;
    }

    if (message.id === "server-1" && ("result" in message || "error" in message)) return;
    if (message.id === undefined || typeof message.method !== "string") return;

    switch (scenario) {
      case "normal":
      case "stderr":
        send({ id: message.id, result: message.params ?? null });
        break;
      case "exit-after-initialized":
        break;
      case "reverse":
        reverseRequests.push(message);
        if (reverseRequests.length === 2) {
          send({ id: reverseRequests[1].id, result: reverseRequests[1].params });
          send({ id: reverseRequests[0].id, result: reverseRequests[0].params });
        }
        break;
      case "events":
        send({ method: "future/notification", params: { source: "fixture" } });
        send({ id: "server-1", method: "future/request", params: { prompt: "fixture" } });
        send({ id: message.id, result: { done: true } });
        break;
      case "crash-on-request":
        process.exit(17);
        break;
      case "clean-exit-on-request":
        process.exit(0);
        break;
      case "delayed-response":
        setTimeout(() => send({ id: message.id, result: { late: true } }), 50);
        break;
      case "event-then-malformed":
        send({ method: "turn/completed", params: { turn: { status: "completed" } } });
        process.stdout.write("{bad\n");
        break;
      case "exit-after-final-event": {
        const line = `${JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } })}\n`;
        const descendant = spawn(
          process.execPath,
          ["-e", `setTimeout(() => process.stdout.write(${JSON.stringify(line)}), 75)`],
          {
            detached: true,
            stdio: ["ignore", "inherit", "ignore"],
            windowsHide: true,
          },
        );
        descendant.unref();
        process.exit(0);
        break;
      }
      case "exit-with-descendant": {
        const descendant = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
          detached: process.platform === "win32",
          stdio: "ignore",
          windowsHide: true,
        });
        descendant.unref();
        send({ method: "fixture/descendant", params: { pid: descendant.pid } });
        process.exit(0);
        break;
      }
      case "exit-with-orphaned-grandchild": {
        const launcher = spawn(
          process.execPath,
          [
            "-e",
            "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true }); process.send?.(child.pid); child.unref();",
          ],
          {
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            windowsHide: true,
          },
        );
        launcher.once("message", (pid) => {
          send({ method: "fixture/descendant", params: { pid } });
          launcher.once("exit", () => process.exit(0));
        });
        break;
      }
    }
  });

  input.on("close", () => {
    if (
      keepAlive !== undefined &&
      scenario !== "exit-after-initialized" &&
      scenario !== "ignore-input" &&
      scenario !== "ignore-all-input" &&
      scenario !== "ignore-input-with-descendant"
    ) {
      clearInterval(keepAlive);
    }
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
