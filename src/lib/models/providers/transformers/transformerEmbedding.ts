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

/* Why the models are not kept by transformers' own file cache (v0.1.6).
   The first upload of a fresh Windows install failed with "Load model from
   ...\models\Xenova\all-MiniLM-L6-v2\onnx\model.onnx failed:system error
   number 13" (CI run 41408225083), and every model load after it in the same
   app session failed the same way:
   1. transformers.js 3.8.1 writes a download with a stream, calls close()
      without waiting for it, and gives onnxruntime the file PATH. onnxruntime
      opens the file "deny others write", and Windows refuses that open while
      the write handle is still open.
   2. transformers.js keeps the first onnxruntime session promise of the
      process and waits on it before each later session, so after one failed
      first session every later load fails at once, until the app restarts.
   So this cache keeps the models: a download goes to a .part file, which is
   closed and then renamed into place; a cached model is read by Node (which
   shares the file with other programs). transformers.js then gives
   onnxruntime the model as bytes, and onnxruntime never opens the file. The
   folders are the same as transformers' own cache
   (<DATA_DIR>/models/<model>/<file>), so models that older versions
   downloaded are used as they are.
   Evidence: GitHub Actions runs 41424215347 and 41425843431. */
const cachedFile = (dir: string, key: string): string | null => {
  /* transformers asks a custom cache for the remote URL:
     https://huggingface.co/<model>/resolve/main/<file> */
  const m = /^https?:\/\/[^/]+\/(.+?)\/resolve\/main\/(.+)$/.exec(key);
  if (!m) return null;
  const base = path.resolve(dir);
  const file = path.resolve(base, ...m[1].split('/'), ...m[2].split('/'));
  return file.startsWith(base + path.sep) ? file : null;
};

const readBytes = async (file: string): Promise<ArrayBuffer> => {
  const b = await fs.promises.readFile(file);
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength
    ? (b.buffer as ArrayBuffer)
    : (b.buffer.slice(
        b.byteOffset,
        b.byteOffset + b.byteLength,
      ) as ArrayBuffer);
};

export const modelFileCache = (dir: string) => ({
  async match(key: string) {
    const file = cachedFile(dir, key);
    if (!file) return undefined;
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) return undefined;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(stat.size) }),
      arrayBuffer: () => readBytes(file),
    };
  },
  async put(key: string, response: Response) {
    const file = cachedFile(dir, key);
    if (!file) return;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const part = `${file}.${process.pid}-${Date.now()}.part`;
    try {
      /* writeFile resolves after the file is closed. */
      await fs.promises.writeFile(
        part,
        new Uint8Array(await response.arrayBuffer()),
      );
      await fs.promises.rename(part, file);
    } catch (err) {
      await fs.promises.rm(part, { force: true }).catch(() => {});
      /* Another load put the same file there first: keep that one. */
      if (!fs.existsSync(file)) throw err;
    }
  },
});

/* A model file that another program has locked (a virus scanner, a backup
   tool) is read again after these waits: 7.75 s in all. Node reads the file
   before onnxruntime makes a session, so a failed read does not leave a
   failed session behind (point 2 above). */
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
    const cacheDir = modelCacheDir() ?? env.cacheDir;
    if (cacheDir) {
      env.cacheDir = cacheDir;
      /* Off: transformers' own file cache, which hands onnxruntime a path. */
      env.useFSCache = false;
      env.useCustomCache = true;
      env.customCache = modelFileCache(cacheDir);
    }
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
