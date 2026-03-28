import { type ModelReasoningEffort } from "./model-catalog.js";
import { type ApprovalMode } from "./approval-mode.js";
export {
  buildNewSession,
  cloneSessions,
  getDiffTokenFromLocation,
  getSessionIdFromLocation,
  normalizeSession,
} from "./session-state.js";
export type {
  CreateSessionInput,
  DiffPreviewPayload,
  Message,
  MessageArtifact,
  Session,
  StreamEntry,
} from "./session-state.js";
export {
  makeDiffRows,
} from "./runtime-state.js";
export type {
  AuditLogEntry,
  AuditLogOperation,
  AuditLogPhase,
  AuditLogUsage,
  AuditLogicalPrompt,
  AuditTransportField,
  AuditTransportPayload,
  ChangedFile,
  ComposerAttachment,
  ComposerAttachmentInput,
  ComposerAttachmentKind,
  ComposerAttachmentSource,
  ComposerPreview,
  DiffRow,
  DiscoveredCustomAgent,
  DiscoveredCustomAgentSource,
  DiscoveredSkill,
  DiscoveredSkillSource,
  LiveApprovalDecision,
  LiveApprovalDecisionMode,
  LiveApprovalRequest,
  LiveRunStep,
  LiveRunStepStatus,
  LiveSessionRunState,
  ProviderQuotaSnapshot,
  ProviderQuotaTelemetry,
  RunCheck,
  RunSessionTurnRequest,
  SessionContextTelemetry,
} from "./runtime-state.js";
export {
  buildCharacterEditorUrl,
  cloneCharacterProfiles,
  cloneCharacterSessionCopy,
  DEFAULT_CHARACTER_SESSION_COPY,
  DEFAULT_CHARACTER_THEME_COLORS,
  getCharacterIdFromLocation,
  getCharacterById as getCharacterProfile,
  isCharacterCreateMode,
  normalizeCharacterSessionCopy,
  normalizeCharacterThemeColors,
} from "./character-state.js";
export type {
  CharacterCatalogItem,
  CharacterProfile,
  CharacterSessionCopy,
  CharacterThemeColors,
  CharacterVisual,
  CreateCharacterInput,
} from "./character-state.js";
export {
  createDefaultAppSettings,
  DEFAULT_CHARACTER_REFLECTION_PROVIDER_SETTINGS,
  DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD,
  DEFAULT_MEMORY_EXTRACTION_PROVIDER_SETTINGS,
  DEFAULT_PROVIDER_APP_SETTINGS,
  getCharacterReflectionProviderSettings,
  getMemoryExtractionProviderSettings,
  getProviderAppSettings,
  getResolvedProviderSettingsBundle,
  normalizeAppSettings,
} from "./provider-settings-state.js";
export type {
  AppSettings,
  CharacterReflectionProviderSettings,
  MemoryExtractionProviderSettings,
  ProviderAppSettings,
  ResolvedProviderSettingsBundle,
} from "./provider-settings-state.js";
export {
  cloneCharacterMemoryEntries,
  cloneCharacterScopes,
  cloneProjectMemoryEntries,
  cloneProjectScopes,
  createDefaultSessionMemory,
  mergeSessionMemory,
  normalizeCharacterMemoryDelta,
  normalizeCharacterMemoryDeltaEntry,
  normalizeCharacterMemoryEntry,
  normalizeCharacterReflectionMonologue,
  normalizeCharacterReflectionOutput,
  normalizeCharacterScope,
  normalizeProjectMemoryEntry,
  normalizeProjectScope,
  normalizeSessionMemory,
  normalizeSessionMemoryDelta,
} from "./memory-state.js";
export type {
  CharacterMemoryCategory,
  CharacterMemoryDelta,
  CharacterMemoryDeltaEntry,
  CharacterMemoryEntry,
  CharacterReflectionMonologue,
  CharacterReflectionMonologueMood,
  CharacterReflectionOutput,
  CharacterScope,
  ProjectMemoryCategory,
  ProjectMemoryEntry,
  ProjectScope,
  ProjectScopeType,
  SessionBackgroundActivityKind,
  SessionBackgroundActivityState,
  SessionBackgroundActivityStatus,
  SessionMemory,
  SessionMemoryDelta,
} from "./memory-state.js";

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatTimestampLabel(value: Date | string | number): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return typeof value === "string" && value.trim() ? value : "";
  }

  const year = timestamp.getFullYear();
  const month = padDatePart(timestamp.getMonth() + 1);
  const day = padDatePart(timestamp.getDate());
  const hours = padDatePart(timestamp.getHours());
  const minutes = padDatePart(timestamp.getMinutes());
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

export function currentTimestampLabel(): string {
  return formatTimestampLabel(new Date());
}

export function currentIsoTimestamp(): string {
  return new Date().toISOString();
}
