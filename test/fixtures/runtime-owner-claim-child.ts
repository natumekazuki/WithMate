import { acquireRuntimeOwnerClaim } from "../../src/main/runtime-host/runtime-owner-claim.js";
import { resolveRuntimeOwnerIdentity } from "../../src/main/runtime-host/runtime-owner-identity.js";

const applicationDataRoot = process.argv[2];
if (applicationDataRoot === undefined || typeof process.send !== "function") {
  process.exitCode = 2;
} else {
  const identity = await resolveRuntimeOwnerIdentity({ applicationDataRoot });
  const claim = await acquireRuntimeOwnerClaim(identity);
  process.send({
    status: claim.status,
    ...(claim.status === "acquired" ? { generationId: claim.generationId } : {}),
  });
  if (claim.status === "acquired") {
    process.once("message", async (message) => {
      if (message !== "release") return;
      await claim.release();
      process.disconnect();
    });
  } else {
    process.disconnect();
  }
}
