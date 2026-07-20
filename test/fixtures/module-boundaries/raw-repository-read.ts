import type { RepositoryReadClient } from "../../../src/main/repository-read-client.js";

declare const reads: RepositoryReadClient;

void reads["sessionGet"]({ sessionId: "session-1" });
