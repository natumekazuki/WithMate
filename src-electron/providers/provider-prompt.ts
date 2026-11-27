import {
  resolveRunWorkspacePath,
  type ProviderPromptComposition,
  type RunSessionTurnInput,
} from "./provider-runtime.js";
import { normalizeAllowedAdditionalDirectories } from "../files/additional-directories.js";
import { buildCharacterRuntimePromptSection } from "../../src-shared/character/character-runtime-snapshot.js";
import { LOCAL_USER_ID } from "../../src-shared/character/character-participant.js";
import { projectSessionInputSender } from "../../src-shared/session/session-turn-queue.js";
import { LOCAL_PR_AGENT_WORKFLOW, LOCAL_PR_CI_EXECUTION_NOTICE } from "../../src-shared/local-pr/local-pr-agent-operations.js";

function buildCharacterOutputBoundarySection(enabled: boolean): string {
  if (!enabled) {
    return "";
  }

  return [
    "# Output Boundary", "",
    "会話・他Sessionへのmessage・Session Graph・非公開メモには自身のCharacter表現を使う。コード・文書・提出用草案などの成果物は、明示指定がなければrepository・提出先の文体と形式を優先し、Character表現を混ぜない。",
  ].join("\n");
}

function buildFolderContextSection(
  input: RunSessionTurnInput,
  workspacePath: string,
  additionalDirectories: readonly string[],
): string {
  const sessionFolderPath = input.sessionFolderPath?.trim()
    || (input.session.workspaceLabel.trim() === "SessionFolder" ? workspacePath : "");

  return [
    "# Workspace",
    "",
    workspacePath.trim() || "利用不可",
    "",
    "# SessionFolder",
    "",
    sessionFolderPath || "利用不可",
    "",
    "# Crew Folder",
    "",
    input.crewFolderPath?.trim() || "利用不可",
    "",
    "共有資料はCrew Folder、Session固有の添付・一時物はSessionFolderへ。",
    "",
    "# Additional Directories",
    "",
    additionalDirectories.length > 0 ? additionalDirectories.map((directoryPath) => `- ${directoryPath}`).join("\n") : "なし",
  ].join("\n");
}

export function composeProviderInput(userMessage: string, provenance?: RunSessionTurnInput["inputProvenance"], preserveWhitespace = false,
  metadata?: Pick<RunSessionTurnInput, "replyTo" | "messageIdentity" | "mainConversationFrame">): string {
  if (!userMessage.trim()) return "";
  const sections: string[] = [];
  const fields = (values: Record<string, string | number | undefined>) => Object.entries(values)
    .filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  if (metadata?.messageIdentity) sections.push("# Message Identity\n\n" + fields(metadata.messageIdentity));
  if (metadata?.mainConversationFrame !== undefined) {
    sections.push("# Conversation Thread\n\nthread: " + JSON.stringify(metadata.mainConversationFrame));
  }
  if (provenance) {
    const origin = provenance.origin;
    const sender = projectSessionInputSender(origin);
    const value = (item: string | boolean | null | undefined) => JSON.stringify(item ?? null);
    const lines = ["# Input Provenance", "",
      "Sender: " + (origin?.kind === "gui" ? "GUI user (" + LOCAL_USER_ID + ")" : origin?.kind === "session" ? "Session" : "unknown")];
    if (origin?.kind === "session") {
      if (sender.character) lines.push("Character: " + value(sender.character.name) + " / ID: " + value(sender.character.id));
      lines.push("Session: " + value(origin.actorSessionId), "Incarnation: " + value(origin.actorIncarnationId),
        "Kind: " + value(origin.actorKind), "Source Turn: " + value(origin.actorTurnId));
      if ("actorMainSessionId" in origin && origin.actorMainSessionId) lines.push("Owner Main Session: " + value(origin.actorMainSessionId));
    }
    lines.push("Operation: " + value(origin?.operation), "Changed since acceptance: " + value(provenance.originalChanged));
    if (provenance.retrySource) {
      const source = provenance.retrySource;
      const sourceSender = projectSessionInputSender(source.origin);
      lines.push("Retry requested by: GUI user (" + LOCAL_USER_ID + ")",
        "Original sender: " + (source.origin.kind === "session" ? "Session" : "GUI user (" + LOCAL_USER_ID + ")"));
      if (source.origin.kind === "session") {
        if (sourceSender.character) lines.push("Original character: " + value(sourceSender.character.name) + " / ID: " + value(sourceSender.character.id));
        lines.push("Original session: " + value(source.origin.actorSessionId), "Original incarnation: " + value(source.origin.actorIncarnationId),
          "Original source Turn: " + value(source.origin.actorTurnId));
      }
      lines.push("Original receipt: " + value(source.receiptId), "Failed Turn: " + value(source.turnId),
        "Original input changed before dispatch: " + value(source.changedSinceAcceptance));
      if (provenance.originalChanged === true) lines.push("Starting input edited by: GUI user (" + LOCAL_USER_ID + ")");
    }
    if (provenance.coordinationOperation) lines.push("Coordination operation: " + value(provenance.coordinationOperation));
    if (provenance.coordination) lines.push("Coordination:", JSON.stringify(provenance.coordination, null, 2));
    sections.push(lines.join("\n"));
  }
  if (metadata?.replyTo) {
    const { target, ...reference } = metadata.replyTo;
    const { kind, ...identity } = target;
    sections.push("# Reply To\n\n" + fields({ ...identity, ...reference }));
  }
  const heading = provenance?.retrySource && provenance.originalChanged === false ? provenance.retrySource.origin.kind === "session" ? "Retried Session Input" : "Retried User Input"
    : provenance?.origin?.kind === "session" ? "Session Input" : provenance && !provenance.origin ? "Queued Input" : "User Input";
  sections.push("# " + heading + "\n\n" + (preserveWhitespace ? userMessage : userMessage.trim()));
  return sections.join("\n\n");
}

export function composeProviderPrompt(input: RunSessionTurnInput): ProviderPromptComposition {
  const workspacePath = resolveRunWorkspacePath(input);
  const additionalDirectories = normalizeAllowedAdditionalDirectories(
    workspacePath,
    input.session.allowedAdditionalDirectories,
  );
  const folderContextBody = buildFolderContextSection(input, workspacePath, additionalDirectories);
  const isCharacterAuthoringSession = input.session.sessionKind === "character-authoring";
  const characterDefinitionBody = buildCharacterRuntimePromptSection(input.session.characterRuntimeSnapshot);
  const hasCharacterSnapshot = characterDefinitionBody.trim().length > 0;
  const characterPromptBody = input.appSettings.characterDefinitionEnabled ? characterDefinitionBody : "";
  const outputBoundaryBody = buildCharacterOutputBoundarySection(
    !isCharacterAuthoringSession && hasCharacterSnapshot,
  );
  const systemPromptBody = [
    characterPromptBody,
    outputBoundaryBody,
    folderContextBody,
    !isCharacterAuthoringSession ? [
      "# WithMate Local PR", "", LOCAL_PR_AGENT_WORKFLOW,
      "Use session.pr_* tools or withmate-session pr-* commands. Missing tools or approval do not authorize a direct merge.",
      LOCAL_PR_CI_EXECUTION_NOTICE,
    ].join("\n") : "",
    !isCharacterAuthoringSession ? "# Session Role\n\n" + (input.runtimeOwner?.kind === "auxiliary" ? "auxiliary" : input.session.sessionRole ?? "standalone") : "",
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
  const referencedImages = input.attachments.filter((attachment) => attachment.kind === "image");
  const inputSections: string[] = [];
  const userMessageText = input.userMessage.trim();
  if (!isCharacterAuthoringSession && input.appSettings.currentDateEnabled && input.currentDateTime) {
    inputSections.push("# Current Date\n\n" + input.currentDateTime);
  }

  if (userMessageText) {
    inputSections.push(composeProviderInput(userMessageText, input.inputProvenance, false, input));
  }
  const inputPromptBody = inputSections.join("\n\n");
  const inputPromptText = inputPromptBody;
  const composedPromptText = [systemPromptBody, inputPromptText]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

  return {
    systemBodyText: systemPromptBody,
    inputBodyText: inputPromptBody,
    logicalPrompt: {
      systemText: systemPromptBody,
      inputText: inputPromptText,
      composedText: composedPromptText,
    },
    imagePaths: referencedImages.map((attachment) => attachment.absolutePath),
    additionalDirectories,
  };
}

export function isCanceledProviderMessage(message: string): boolean {
  return /abort|aborted|cancel|canceled|cancelled/i.test(message);
}
