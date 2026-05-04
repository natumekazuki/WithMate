import { MateEmbeddingCacheService } from "./mate-embedding-cache.js";

export type EmbedTextWithLocalModel = (input: {
  text: string;
  modelId: string;
  cacheDirectory: string;
  expectedDimension: number;
  modelRevision: string;
}) => Promise<number[]>;

type EmbedTextWithLocalModelInput = Parameters<EmbedTextWithLocalModel>[0];

type EmbeddingPipeline = {
  (input: string, options: { pooling: string; normalize: boolean }): Promise<unknown>;
  dispose?: () => unknown;
};

type TransformersNamespace = {
  pipeline: (
    task: string,
    modelId: string,
    options: {
      cache_dir: string;
      local_files_only: boolean;
      quantized: boolean;
      revision: string;
    },
  ) => Promise<EmbeddingPipeline>;
  env: {
    cacheDir?: string;
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
  };
};

function asVector(value: unknown): number[] {
  if (Array.isArray(value)) {
    if (value.length > 0 && Array.isArray(value[0])) {
      return value[0] as number[];
    }
    return value as number[];
  }

  if (value && typeof value === "object" && "data" in value) {
    const inner = (value as { data: unknown }).data;
    if (Array.isArray(inner) || ArrayBuffer.isView(inner)) {
      return Array.from(inner as unknown as ArrayLike<number>);
    }
  }

  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<number>);
  }

  throw new Error("embedding の出力形式が想定外だよ。");
}

function validateVector(vector: number[], expectedDimension: number): void {
  if (vector.length !== expectedDimension) {
    throw new Error(`embedding の次元が期待と一致しないよ: ${vector.length} != ${expectedDimension}`);
  }
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error("embedding が非数値を含むよ。");
  }
}

function cloneEnvState(env: TransformersNamespace["env"]): TransformersNamespace["env"] {
  return {
    cacheDir: env.cacheDir,
    allowLocalModels: env.allowLocalModels,
    allowRemoteModels: env.allowRemoteModels,
  };
}

export async function embedTextWithTransformersLocalModel(input: EmbedTextWithLocalModelInput): Promise<number[]> {
  const { text, modelId, cacheDirectory, expectedDimension, modelRevision } = input;
  const { pipeline, env } = (await import("@xenova/transformers")) as unknown as TransformersNamespace;

  const previousEnv = cloneEnvState(env);
  env.cacheDir = cacheDirectory;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;

  let extractor: EmbeddingPipeline | null = null;
  try {
    const revision = modelRevision.trim() || "main";
    extractor = await pipeline(
      "feature-extraction",
      modelId,
      {
        cache_dir: cacheDirectory,
        local_files_only: true,
        quantized: true,
        revision,
      },
    );
    const rawOutput = await extractor(text, { pooling: "mean", normalize: true });
    const vector = asVector(rawOutput);
    validateVector(vector, expectedDimension);
    return vector;
  } finally {
    if (extractor && typeof extractor.dispose === "function") {
      await Promise.resolve(extractor.dispose());
    }

    env.cacheDir = previousEnv.cacheDir;
    env.allowLocalModels = previousEnv.allowLocalModels;
    env.allowRemoteModels = previousEnv.allowRemoteModels;
  }
}

export class MateEmbeddingVectorizer {
  private readonly cacheService: MateEmbeddingCacheService;
  private readonly embedText: EmbedTextWithLocalModel;

  constructor(cacheService: MateEmbeddingCacheService, embedText: EmbedTextWithLocalModel = embedTextWithTransformersLocalModel) {
    this.cacheService = cacheService;
    this.embedText = embedText;
  }

  async vectorizeText(text: string): Promise<number[]> {
    const trimmedText = text.trim();
    if (!trimmedText) {
      throw new Error("text が空だよ。");
    }

    const settings = this.cacheService.getEmbeddingSettings();
    if (!settings) {
      throw new Error("embedding settings が見つからないよ。");
    }

    if (!settings.enabled || settings.cacheState !== "ready" || settings.lastStatus !== "available") {
      throw new Error("embedding cache が有効化されていないまたは利用可能ではないよ。");
    }

    const modelRevision = settings.modelRevision.trim() || "main";
    const cacheDirectory = this.cacheService.getCacheDirectoryPath();

    const vector = await this.embedText({
      text: trimmedText,
      modelId: settings.modelId,
      cacheDirectory,
      expectedDimension: settings.dimension,
      modelRevision,
    });

    validateVector(vector, settings.dimension);
    return vector;
  }
}
