import type { RepositoryJsonValue } from "./repository-write-model.js";

export type ApplicationRunProviderRequest = Readonly<{ [key: string]: RepositoryJsonValue }>;
