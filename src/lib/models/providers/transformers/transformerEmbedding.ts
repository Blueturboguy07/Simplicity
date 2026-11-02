import fs from 'fs';
import path from 'path';
import { Chunk } from '@/lib/types';
import BaseEmbedding from '../../base/embedding';
import { FeatureExtractionPipeline } from '@huggingface/transformers';

type TransformerConfig = {
  model: string;
};

/* At most this many texts go to onnxruntime in one call. The packaged app
   runs this server under Electron (ELECTRON_RUN_AS_NODE), and there one large
   malloc from onnxruntime kills the whole server with SIGTRAP instead of
   failing. One call with ~100 chunks of ~450 tokens did that with
   all-MiniLM-L6-v2 (a long PDF); 50 did not, and 300 in batches of 16 did not
   (scratchpad/bugfix/simplicity-restart-fix/NOTES.md). Plain node does not
   crash, which is why the old CI smoke never saw it. */
export const EMBED_BATCH_SIZE = 16;

/* Where downloaded models are kept. The library default is a .cache folder
   inside its own package, which in the packaged app is inside the signed .app
   bundle: read-only when macOS runs the app from the DMG or translocated
   ("Upload failed: ENOENT ... mkdir .../Simplicity.app/..."), and writing
   there breaks the bundle's signature otherwise. DATA_DIR is the per-user
   app data folder the desktop shell gives the server. */
export const modelCacheDir = (): string | null =>
  process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'models') : null;

/* What the upload toast says when the model still does not load after the
   tries below. The real error (it has the model's path on disk) goes to the
   server log only. */
export const MODEL_LOAD_FAILED_MESSAGE =
  'Simplicity could not load its file model. Try the upload again.';

export class ModelLoadError extends Error {
  constructor(cause: unknown) {
    super(MODEL_LOAD_FAILED_MESSAGE, { cause });
    this.name = 'ModelLoadError';
  }
}

/* The first load on Windows can fail with "Load model from
   ...\models\Xenova\all-MiniLM-L6-v2\onnx\model.onnx failed:system error
   number 13" (CI run 41408225083, 1 of 11 fresh loads). transformers.js
   3.8.1 writes the downloaded model with a stream, calls close() without
   waiting for it, and hands the path to onnxruntime at once; onnxruntime
   opens the file with "deny others write", which Windows refuses while the
   write handle (or a virus scan of the new file) is still open. The file is
   complete and opens a moment later, so a busy file is tried again after
   these waits (7.75 s in all; on Windows each wait also runs on, up to the
   same time again, while the file is still open). */
export const modelLoadRetry = { delaysMs: [250, 500, 1000, 2000, 4000] };

export const isFileBusyError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'EACCES' || code === 'EBUSY' || code === 'EPERM') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /system error number 13\b|\bEACCES\b|\bEBUSY\b|\bEPERM\b|used by another process/i.test(
    message,
  );
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* Windows only: true when nothing else has the file open (an exclusive open
   works). That is stricter than the open onnxruntime does, so when it is
   true, onnxruntime's open works too. Elsewhere files do not lock. */
const fileIsFree = async (file: string): Promise<boolean> => {
  const exclusive = (fs.constants as Record<string, number>).UV_FS_O_EXLOCK;
  if (process.platform !== 'win32' || !exclusive) return true;
  try {
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | exclusive);
    await handle.close();
    return true;
  } catch (err) {
    return !isFileBusyError(err);
  }
};

const waitUntilFree = async (file: string, maxMs: number) => {
  const end = Date.now() + maxMs;
  while (Date.now() < end && !(await fileIsFree(file))) await sleep(50);
};

export const loadWithRetry = async <T>(load: () => Promise<T>): Promise<T> => {
  const delays = modelLoadRetry.delaysMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await load();
    } catch (err) {
      if (attempt >= delays.length || !isFileBusyError(err)) throw err;
      const wait = delays[attempt];
      console.warn(
        `Embedding model file busy (try ${attempt + 1} of ${delays.length + 1}), trying again in ${wait} ms: ${err instanceof Error ? err.message : err}`,
      );
      await sleep(wait);
      const busy = /Load model from (.+?) failed:/.exec(
        err instanceof Error ? err.message : String(err),
      );
      if (busy) await waitUntilFree(busy[1], wait);
    }
  }
};

/* One load per model for the whole server, shared by every request. Each
   upload and each web search makes a new TransformerEmbedding, so a
   per-instance promise let two requests on a fresh install download the
   same model into the same file at once, and the second one opened the
   half-written file. A failed load is dropped from this map, so the next
   upload loads again instead of getting the same rejection. */
const loads = new Map<string, Promise<FeatureExtractionPipeline>>();

export const loadEmbeddingPipeline = (
  model: string,
): Promise<FeatureExtractionPipeline> => {
  const key = `${modelCacheDir() ?? ''}|${model}`;
  const existing = loads.get(key);
  if (existing) return existing;

  const loading = loadWithRetry(async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    const cacheDir = modelCacheDir();
    if (cacheDir) env.cacheDir = cacheDir;
    const result = await pipeline('feature-extraction', model, {
      dtype: 'fp32',
    });
    return result as FeatureExtractionPipeline;
  }).catch((err) => {
    console.error(`Embedding model ${model} did not load:`, err);
    throw new ModelLoadError(err);
  });
  loads.set(key, loading);
  loading.catch(() => {
    if (loads.get(key) === loading) loads.delete(key);
  });
  return loading;
};

class TransformerEmbedding extends BaseEmbedding<TransformerConfig> {
  constructor(protected config: TransformerConfig) {
    super(config);
  }

  async embedText(texts: string[]): Promise<number[][]> {
    return this.embed(texts);
  }

  async embedChunks(chunks: Chunk[]): Promise<number[][]> {
    return this.embed(chunks.map((c) => c.content));
  }

  private async embed(texts: string[]) {
    const pipe = await loadEmbeddingPipeline(this.config.model);
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const output = await pipe(texts.slice(i, i + EMBED_BATCH_SIZE), {
        pooling: 'mean',
        normalize: true,
      });
      vectors.push(...(output.tolist() as number[][]));
    }
    return vectors;
  }
}

export default TransformerEmbedding;
