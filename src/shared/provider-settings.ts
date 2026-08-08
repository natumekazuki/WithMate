export type ProviderSettingsJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProviderSettingsJsonValue[]
  | Readonly<{ [key: string]: ProviderSettingsJsonValue }>;

export type ProviderSettingsEnvelope = Readonly<{
  providerId: string;
  definitionVersion: string;
  settings: Readonly<{ [key: string]: ProviderSettingsJsonValue }>;
}>;
