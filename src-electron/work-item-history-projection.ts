import type { WorkItemEvent } from "../src/work-item.js";

export function collectRecentWorkItemHistory(
  newestFirstEvents: Iterable<WorkItemEvent>,
  maxResponseBytes: number,
): WorkItemEvent[] {
  const newestFirst: WorkItemEvent[] = [];
  let responseBytes = 2;
  for (const event of newestFirstEvents) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    const candidateBytes = responseBytes + (newestFirst.length === 0 ? 0 : 1) + eventBytes;
    if (candidateBytes > maxResponseBytes) {
      if (newestFirst.length === 0) {
        throw new Error("A Root WorkItem history event exceeds the IPC response limit.");
      }
      break;
    }
    newestFirst.push(event);
    responseBytes = candidateBytes;
  }
  return newestFirst.reverse();
}
