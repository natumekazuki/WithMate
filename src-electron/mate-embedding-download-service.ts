import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { MateEmbeddingCacheService } from "./mate-embedding-cache.js";

type EmbeddingCacheManifestEntry = {
  relativePath: string;
  size: number;
};

type TransformersLike = {
  pipeline: (
    task: string,
    model: string,
    options?: {
      cache_dir?: string;
      local_files_only?: boolean;
      quantized?: boolean;
      revision?: string;
    },
  ) => Promise<FeatureExtractor>;
  env: {
    cacheDir?: string;
    allowRemoteModels?: boolean;
    allowLocalModels?: boolean;
  };
};

type FeatureExtractionOutput = {
  data?: ArrayLike<number>;
  dims?: number[];
};

type FeatureExtractor = {
  (input: string, options: { pooling: "mean"; normalize: true }): Promise<FeatureExtractionOutput> | FeatureExtractionOutput;
  dispose?: () => Promise<void> | void;
};

export type LoadEmbeddingModelResult = {
  modelRevision: string;
  cacheManifestSha256?: string;
  cacheSizeBytes?: number;
};

export type LoadEmbeddingModel = (input: {
  modelId: string;
  cacheDirectory: string;
  expectedDimension: number;
  modelRevision: string;
}) => Promise<LoadEmbeddingModelResult>;

export type MateEmbeddingDownloadServiceDeps = {
  cacheService: MateEmbeddingCacheService;
  loadModel?: LoadEmbeddingModel;
};

const DEFAULT_MODEL_REVISION = "main";
const DEFAULT_LOAD_TIMEOUT_MESSAGE = "embedding model のダウンロードがタイムアウトした可能性があります。";
const WARMUP_TEXT = "query: WithMate embedding cache warmup";

export async function loadEmbeddingModelWithTransformers(input: {
  modelId: string;
  cacheDirectory: string;
  expectedDimension: number;
  modelRevision: string;
}): Promise<LoadEmbeddingModelResult> {
  const transformers = (await import("@xenova/transformers")) as unknown as TransformersLike;
  const originalCacheDir = transformers.env.cacheDir;
  const originalAllowLocalModels = transformers.env.allowLocalModels;
  const originalAllowRemoteModels = transformers.env.allowRemoteModels;
  let extractor: FeatureExtractor | null = null;

  transformers.env.cacheDir = input.cacheDirectory;
  transformers.env.allowLocalModels = true;
  transformers.env.allowRemoteModels = true;
  try {
    extractor = await transformers.pipeline("feature-extraction", input.modelId, {
      cache_dir: input.cacheDirectory,
      quantized: true,
      revision: input.modelRevision,
    });
    const output = await extractor(WARMUP_TEXT, { pooling: "mean", normalize: true });
    assertEmbeddingDimension(output, input.expectedDimension);
    return {
      modelRevision: input.modelRevision,
    };
  } finally {
    await extractor?.dispose?.();
    transformers.env.cacheDir = originalCacheDir;
    transformers.env.allowLocalModels = originalAllowLocalModels;
    transformers.env.allowRemoteModels = originalAllowRemoteModels;
  }
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

async function collectManifestEntries(directory: string): Promise<EmbeddingCacheManifestEntry[]> {
  const results: EmbeddingCacheManifestEntry[] = [];

  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectManifestEntries(entryPath);
      for (const item of nested) {
        results.push({ ...item, relativePath: normalizeRelativePath(path.join(entry.name, item.relativePath)) });
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const fileStat = await stat(entryPath);
    results.push({
      relativePath: normalizeRelativePath(entry.name),
      size: fileStat.size,
    });
  }

  return results;
}

async function computeManifestSha256(cacheDirectory: string): Promise<string> {
  const hash = createHash("sha256");
  const rootEntries = (await collectManifestEntries(cacheDirectory)).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );

  for (const entry of rootEntries) {
    hash.update(`${entry.relativePath}:${entry.size}\n`, "utf8");
    for await (const chunk of createReadStream(path.join(cacheDirectory, ...entry.relativePath.split("/")))) {
      hash.update(chunk);
    }
    hash.update("\n", "utf8");
  }

  return hash.digest("hex");
}

async function computeCacheSizeBytes(cacheDirectory: string): Promise<number> {
  const entries = await collectManifestEntries(cacheDirectory);
  return entries.reduce((total, item) => total + item.size, 0);
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : DEFAULT_LOAD_TIMEOUT_MESSAGE;
  }

  return DEFAULT_LOAD_TIMEOUT_MESSAGE;
}

function readOutputDimension(output: FeatureExtractionOutput): number {
  const dims = Array.isArray(output.dims) ? output.dims : [];
  const lastDim = dims[dims.length - 1];
  if (Number.isInteger(lastDim) && lastDim > 0) {
    return lastDim;
  }

  const dataLength = output.data?.length;
  if (typeof dataLength === "number" && Number.isInteger(dataLength) && dataLength > 0) {
    return dataLength;
  }

  return 0;
}

function assertEmbeddingDimension(output: FeatureExtractionOutput, expectedDimension: number): void {
  const actualDimension = readOutputDimension(output);
  if (actualDimension !== expectedDimension) {
    throw new Error(`embedding dimension が一致しません。expected=${expectedDimension}, actual=${actualDimension}`);
  }
}

export class MateEmbeddingDownloadService {
  private readonly cacheService: MateEmbeddingCacheService;
  private readonly loadModel: LoadEmbeddingModel;

  constructor(deps: MateEmbeddingDownloadServiceDeps) {
    this.cacheService = deps.cacheService;
    this.loadModel = deps.loadModel ?? loadEmbeddingModelWithTransformers;
  }

  async ensureDownloadedModelReady(): Promise<void> {
    const settings = this.cacheService.getEmbeddingSettings();
    if (!settings) {
      throw new Error("Embedding settings が見つからないよ。");
    }

    if (settings.cacheState === "ready" && settings.lastStatus === "available") {
      return;
    }

    await this.downloadModel();
  }

  async downloadModel(): Promise<void> {
    const cacheDirPath = this.cacheService.getCacheDirectoryPath();
    const settings = this.cacheService.getEmbeddingSettings();

    if (!settings) {
      throw new Error("Embedding settings が見つからないよ。");
    }

    this.cacheService.markDownloadStarted();
    await mkdir(path.dirname(cacheDirPath), { recursive: true });
    const stagingDirectoryPath = await mkdtemp(path.join(path.dirname(cacheDirPath), ".withmate-embedding-staged-"));

    try {
      const result = await this.loadModel({
        modelId: settings.modelId,
        cacheDirectory: stagingDirectoryPath,
        expectedDimension: settings.dimension,
        modelRevision: settings.modelRevision || DEFAULT_MODEL_REVISION,
      });

      const cacheManifestSha256 =
        result.cacheManifestSha256 ?? await computeManifestSha256(stagingDirectoryPath);
      const cacheSizeBytes =
        result.cacheSizeBytes !== undefined ? result.cacheSizeBytes : await computeCacheSizeBytes(stagingDirectoryPath);

      await rm(cacheDirPath, { recursive: true, force: true });
      await rename(stagingDirectoryPath, cacheDirPath);

      this.cacheService.markDownloadReady({
        cacheManifestSha256,
        modelRevision: result.modelRevision,
        cacheSizeBytes,
      });
    } catch (error) {
      await rm(stagingDirectoryPath, { recursive: true, force: true });
      this.cacheService.markDownloadFailed(resolveErrorMessage(error));
      throw error;
    }
  }
}
