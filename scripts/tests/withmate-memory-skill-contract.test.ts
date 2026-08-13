import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const skillRoot = path.resolve("resources", "skills", "withmate-memory");

async function readSkillArtifact(relativePath: string): Promise<string> {
  return readFile(path.join(skillRoot, relativePath), "utf8");
}

describe("withmate-memory distributed Skill contract", () => {
  it("injected context優先、cue-driven recall、3つのreflection lensを要求する", async () => {
    const skill = await readSkillArtifact("SKILL.md");

    assert.match(skill, /valid injected Character context as the first Character-context input/);
    assert.match(skill, /Do not call `character_context\.get` ceremonially on every turn/);
    assert.match(skill, /Cue-driven recall/);
    assert.match(skill, /Project lens/);
    assert.match(skill, /Character lens/);
    assert.match(skill, /Character affect lens/);
    assert.match(skill, /If no valid affect context is available.*Do not invent a stored state/s);
  });

  it("Character affectをユーザー感情から分離し、bug targetとcandidate rejectionを保持する", async () => {
    const skill = await readSkillArtifact("SKILL.md");

    assert.match(skill, /Character affect is the Character's own response/);
    assert.match(skill, /not a diagnosis, measurement, or score of the user's emotions/);
    assert.match(skill, /Use `targetType=bug` for frustration with a bug/);
    assert.match(skill, /entries in `rejected` were not/);
    assert.match(skill, /rejected candidate must not be copied into another store/);
    assert.match(skill, /lifecycle owns the mandatory post-turn appraisal/);
    assert.match(skill, /Do not submit the same turn again through MCP/);
  });

  it("semantic duplicate、別episode、同一event retryの規則を分離する", async () => {
    const skill = await readSkillArtifact("SKILL.md");

    assert.match(skill, /Semantic Memory/);
    assert.match(skill, /separate event at a different time may be appended/);
    assert.match(skill, /same turn, event, timeout retry, response-loss retry, or client resend uses the unchanged request and the same idempotency key/);
    assert.match(skill, /different event or changed request uses a new key/);
    assert.match(skill, /Do not send a raw conversation transcript/);
    assert.match(skill, /include it as that affect candidate's `memoryEpisode`/);
    assert.match(skill, /linked shape requires `title`, `preview`, `body`, and `salience` from 0 to 1/);
    assert.match(skill, /Do not also call `character_memory\.append_episode` for the event/);
    assert.match(skill, /standalone episode that is not linked to an affect event/);
    assert.match(skill, /These fields are not part of a linked `memoryEpisode`/);
    assert.match(skill, /Use the general `memory\.\*` MCP tools for these candidates/);
    assert.match(skill, /explicit `project`, `user-global`, `character`, or `character\+project` target/);
    assert.match(skill, /Run `memory\.search` against that exact target as duplicate preflight/);
    assert.match(skill, /use `memory\.append` with the same explicit target/);
    assert.match(skill, /Do not convert a rejected affect candidate or episode mutation into semantic Memory/);
  });

  it("MCP availabilityだけをCLI fallbackとし、domain rejectionの迂回を禁止する", async () => {
    const skill = await readSkillArtifact("SKILL.md");

    assert.match(skill, /Use the `withmate-character-context` MCP server/);
    assert.match(skill, /--fallback-from mcp/);
    assert.match(skill, /domain validation rejection/);
    assert.match(skill, /insufficient authority/);
    assert.match(skill, /version conflict/);
    assert.match(skill, /must not be bypassed with CLI/);
    assert.match(skill, /same running WithMate application service and persistence owner/);
    assert.match(skill, /`MEMORY_IDEMPOTENCY_CONFLICT`/);
    assert.match(skill, /successful general Memory retry may include `replayed: true`/);
  });

  it("effect certainty、read-back、shadow mode、tool可視性を区別する", async () => {
    const skill = await readSkillArtifact("SKILL.md");

    for (const effect of ["none", "committed", "partial", "unknown"]) {
      assert.match(skill, new RegExp(`effect: ${effect}`));
    }
    assert.match(skill, /Shadow mode is not an instruction to claim a write succeeded/);
    assert.match(skill, /Read back after mutation/);
    assert.match(skill, /Do not announce routine context reads, Memory searches, or affect appraisal/);
    assert.match(skill, /structured error may still report `effect: committed` or `effect: partial`/);
    assert.match(skill, /do not describe the overall operation as successful/);
  });

  it("Character referenceが公開version、tool、CLI、authority、error、metricsを固定する", async () => {
    const reference = await readSkillArtifact(path.join("reference", "character-context.md"));

    assert.match(reference, /`withmate-character-context`/);
    assert.match(reference, /MCP server version \| `1\.0\.0`/);
    assert.match(reference, /Verified MCP protocol compatibility \| `2025-06-18`/);
    assert.match(reference, /Character context schema \| `withmate-character-context-v1`/);
    assert.match(reference, /Affect candidate schema \| `withmate-affect-v1`/);
    for (const tool of [
      "character_context.get",
      "character_affect.appraise",
      "character_memory.search",
      "character_memory.append_episode",
      "character_memory.correct",
      "character_memory.forget",
    ]) {
      assert.equal(reference.includes(`\`${tool}\``), true, `${tool} must be documented`);
    }
    for (const tool of [
      "memory.search",
      "memory.get_entry",
      "memory.list_targets",
      "memory.list_entries",
      "memory.list_tags",
      "memory.append",
      "memory.forget",
      "memory.move_entry",
      "memory.get_file",
      "memory.export_files",
      "memory.file_usage",
    ]) {
      assert.equal(reference.includes(`\`${tool}\``), true, `${tool} must be documented`);
    }
    for (const command of [
      "context-get",
      "affect-appraise",
      "affect-inspect",
      "affect-correct",
      "affect-reset",
      "character-memory-search",
      "character-memory-append-episode",
      "character-memory-correct",
      "character-memory-forget",
      "character-metrics",
      "mcp-server",
    ]) {
      assert.equal(reference.includes(`\`${command}\``), true, `${command} must be documented`);
    }
    assert.match(reference, /CLI exit code is transport\/adapter status, not a replacement for the JSON domain result/);
    assert.match(reference, /`character_context\.get` returns `characterId`, `sessionId`/);
    assert.match(reference, /`character_affect\.appraise` returns `saved\[\]`, `rejected\[\]`/);
    assert.match(reference, /candidate's `memoryEpisode`/);
    assert.match(reference, /required `salience` from 0 to 1/);
    assert.match(reference, /Linked `memoryEpisode` does not use `observedFact` or `characterObservation`/);
    assert.match(reference, /lifecycle owns mandatory post-turn appraisal/);
    assert.match(reference, /structured error can still identify committed or partially committed state/);
    assert.match(reference, /Use `memory\.search`, `memory\.get_entry`, and `memory\.append` with an explicit `character` or `character\+project` target/);
    assert.match(reference, /Character Memory mutations return `operation`/);
    assert.match(reference, /conversation text, Memory bodies, affect evidence text, inferred user emotion/);
    assert.match(reference, /`bundleVersion`/);
  });

  it("Project Memory CLI手順を独立したreferenceとして維持する", async () => {
    const skill = await readSkillArtifact("SKILL.md");
    const cli = await readSkillArtifact(path.join("reference", "cli.md"));

    assert.match(skill, /Project Memory workflow/);
    assert.match(cli, /### search/);
    assert.match(cli, /### append/);
    assert.match(cli, /### forget/);
    assert.match(cli, /### move-entry/);
    assert.match(cli, /## Exit Codes/);
    assert.match(cli, /Character Context MCP and CLI Reference/);
    assert.match(cli, /Semantic Memory target shapes/);
    assert.match(cli, /A Character preference that belongs only to one project uses the combined target/);
    assert.match(cli, /"owner": "character"[\s\S]*"project": \{ "type": "path"[\s\S]*"scope": "project"/);
    assert.match(cli, /Do not silently drop either owner from a combined Character\+Project candidate/);
    assert.match(cli, /Normal agent operations use the general `memory\.\*` tools/);
    assert.match(cli, /A structured MCP domain error is not an availability failure/);
  });
});
