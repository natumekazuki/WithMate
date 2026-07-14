const [major, minor] = process.versions.node.split(".").map(Number);

if (major !== 24 || minor < 16) {
  console.error(`Node.js >=24.16 <25 is required; received ${process.version}.`);
  process.exitCode = 1;
} else {
  console.log(`runtime version: ${process.version}`);
}
