import { Codex } from "@openai/codex-sdk";

function resolvePrompt(): string {
  const cliPrompt = process.argv.slice(2).join(" ").trim();
  if (cliPrompt) {
    return cliPrompt;
  }

  return (
    process.env.CODEX_SMOKE_PROMPT?.trim() ||
    "Respond in Japanese with a short confirmation that the Codex SDK connection works."
  );
}

async function main(): Promise<void> {
  const prompt = resolvePrompt();
  const workingDirectory = process.cwd();
  const model = process.env.CODEX_MODEL || undefined;

  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory,
    approvalPolicy: "never",
    sandboxMode: "read-only",
    model,
  });

  console.log("Running Codex SDK smoke test...");
  console.log(`workingDirectory: ${workingDirectory}`);
  console.log("authMode: stored-cli-auth");
  if (model) {
    console.log(`model: ${model}`);
  }

  const turn = await thread.run(prompt);

  console.log(`threadId: ${thread.id ?? "unavailable"}`);
  console.log("response:");
  console.log(turn.finalResponse);

  if (turn.usage) {
    console.log(
      `usage: input=${turn.usage.input_tokens}, cached=${turn.usage.cached_input_tokens}, output=${turn.usage.output_tokens}`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  console.error("Codex SDK smoke test failed.");
  console.error(message);
  console.error("");
  console.error("確認ポイント:");
  console.error("- `codex` CLI で事前に ChatGPT ログインを完了させる");
  console.error("- カレントディレクトリが Git リポジトリであることを確認する");

  process.exitCode = 1;
});
