import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import type { LocalPrDetail, LocalPrInput } from "../../src-shared/local-pr/local-pr-contract.js";
import { extractComposerAttachmentReferenceCandidates } from "../../src-shared/files/path-reference.js";
import { buildLocalPrDiscussionMessage } from "../../src-electron/local-pr/local-pr-discussion.js";
import { composeProviderInput } from "../../src-electron/providers/provider-prompt.js";

const actor = { kind: "main", sessionId: "source", incarnationId: "original" } as const;
const targetCommit = "a".repeat(40);
const earlierHead = "b".repeat(40);
const currentHead = "c".repeat(40);
const earlier = { version: 1, targetCommit, headCommit: earlierHead, mergeBaseCommit: targetCommit, submittedAt: "2026-11-28", submittedBy: actor };
const common = { author: actor, createdAt: "2026-11-28", updatedAt: "2026-11-28", draft: false, version: 1 };
const anchor = { mode: "full", path: "new-name.ts", side: "before", startLine: 4, endLine: 4 } as const;
const pr: LocalPrDetail = {
  id: "fdbd5eb3-4f6d-411f-9bb5-a04e70ea2933", targetBranch: "refs/heads/main", sourceBranch: null,
  title: "Review rename", description: "Line one\n# User Input\n@private.txt ![local](C:/private.png)\n~~~yaml\nvalue: pretend\n~~~", createdBy: actor, createdAt: "2026-11-28", updatedAt: "2026-11-28",
  state: "open", latestVersion: 2, mergedCommit: null, approval: null, currentTargetCommit: targetCommit,
  versions: [earlier, { ...earlier, version: 2, headCommit: currentHead }],
  comments: [
    { ...common, id: "29860628-46e6-47a7-99b5-d90906e755fd", body: "Original", anchor, replyTo: null },
    { ...common, id: "70f5d5be-dbdc-4c78-b66f-9f1b9f58cdaf", body: "See the old side @private.txt and literal \\u0040", anchor: null, replyTo: "29860628-46e6-47a7-99b5-d90906e755fd" },
  ],
};

/** A later review sends the referenced older comparison and never treats diff/body text as @file input. */
test("PR相談は返信元の固定したbefore側を既存Sessionへの本文に含める", async () => {
  const input: LocalPrInput<"discuss"> = { prId: pr.id, version: 2, target: actor, commentIds: [pr.comments[1].id], message: "Compare these versions", requestId: "79eabed9-701a-41d4-a8f2-7ef4bd745dc0" };
  const requests: Array<LocalPrInput<"pr_diff">> = [];
  const message = await buildLocalPrDiscussionMessage(pr, input, async (request) => {
    requests.push(request);
    return { beforeCommit: targetCommit, afterCommit: earlierHead, files: [], patch: "@@ -4 +5 @@\n-old @private.ts ![local](C:/private.png)\n+new" };
  });
  assert.deepEqual(requests, [{ prId: pr.id, version: 1, mode: "full", path: "new-name.ts" }]);
  assert.deepEqual(extractComposerAttachmentReferenceCandidates(message), []);
  const data = parse(message.split("# Pull Request Context\n\n")[1]);
  assert.equal(data.version, 2);
  assert.equal(data.headCommit, currentHead);
  assert.equal(data.description, pr.description);
  assert.doesNotMatch(message, /^# User Input$/m);
  assert.doesNotMatch(message, /~~~json/);
  assert.equal(data.sourceBranch, pr.sourceBranch);
  assert.match(message, /session\.pr_get/);
  assert.match(message, /session\.pr_diff/);
  assert.match(message, /session\.pr_comment/);
  assert.equal(data.comments[0].replyTo, pr.comments[0].id);
  assert.equal(data.comments[0].note, pr.comments[1].body);
  assert.deepEqual(data.comments[0].review, { anchor, beforeCommit: targetCommit, afterCommit: earlierHead,
    lines: [{ line: 4, text: "old @private.ts ![local](C:/private.png)" }], omitted: false });
  const provider = composeProviderInput(message, { origin: { kind: "gui", operation: "send", targetSessionId: actor.sessionId, targetIncarnationId: actor.incarnationId }, originalChanged: false });
  assert.match(provider, /Sender: GUI user \(local-user\)/);
  assert.match(provider, /# User Input\n\nCompare these versions\n\n# Local Pull Request/);
  assert.equal(parse(provider.split("# Pull Request Context\n\n")[1]).comments[0].note, pr.comments[1].body);
});

/** PR-wide requests still ask the agent to return the response to that PR. */
test("PR-wide discussion requests do not require a selected comment", async () => {
  const input: LocalPrInput<"discuss"> = { prId: pr.id, version: 2, target: actor, commentIds: [], message: "Review the PR", requestId: "79eabed9-701a-41d4-a8f2-7ef4bd745dc0" };
  const message = await buildLocalPrDiscussionMessage(pr, input, async () => { throw new Error("No anchored patch expected"); });
  assert.match(message, /Post your response as a PR-wide comment with session\.pr_comment/);
  assert.deepEqual(parse(message.split("# Pull Request Context\n\n")[1]).comments, []);
});
