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

class TransformerEmbedding extends BaseEmbedding<TransformerConfig> {
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

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
    if (!this.pipelinePromise) {
      const loading = (async () => {
        const { pipeline, env } = await import('@huggingface/transformers');
        const cacheDir = modelCacheDir();
        if (cacheDir) env.cacheDir = cacheDir;
        const result = await pipeline('feature-extraction', this.config.model, {
          dtype: 'fp32',
        });
        return result as FeatureExtractionPipeline;
      })();
      this.pipelinePromise = loading;
      /* A failed load (no network, disk full) must not stick: the next call
         tries again instead of reusing the rejected promise. */
      loading.catch(() => {
        if (this.pipelinePromise === loading) this.pipelinePromise = null;
      });
    }

    const pipe = await this.pipelinePromise;
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
