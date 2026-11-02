import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';

/* The real onnxruntime is not loaded here: a fake pipeline records what the
   embedding class asks of the library. */
const calls: string[][] = [];
const env: { cacheDir?: string } = {};
const pipeline = vi.fn(async () => async (texts: string[]) => {
  calls.push(texts);
  return { tolist: () => texts.map((t) => [t.length]) };
});

vi.mock('@huggingface/transformers', () => ({ pipeline, env }));

const { default: TransformerEmbedding, EMBED_BATCH_SIZE, modelCacheDir } =
  await import('./transformerEmbedding');

beforeEach(() => {
  calls.length = 0;
  pipeline.mockClear();
  delete env.cacheDir;
});

describe('TransformerEmbedding', () => {
  it('keeps models in DATA_DIR/models, never inside the app bundle', async () => {
    process.env.DATA_DIR = '/Users/x/Library/Application Support/Simplicity';
    await new TransformerEmbedding({ model: 'Xenova/all-MiniLM-L6-v2' }).embedText(['a']);
    expect(env.cacheDir).toBe(
      path.join('/Users/x/Library/Application Support/Simplicity', 'models'),
    );
  });

  it('leaves the library default alone when there is no DATA_DIR (dev, docker)', () => {
    const saved = process.env.DATA_DIR;
    delete process.env.DATA_DIR;
    expect(modelCacheDir()).toBeNull();
    process.env.DATA_DIR = saved;
  });

  it('sends at most EMBED_BATCH_SIZE texts to onnxruntime per call and keeps the order', async () => {
    const texts = Array.from({ length: 300 }, (_, i) => 'x'.repeat(i + 1));
    const out = await new TransformerEmbedding({ model: 'm' }).embedText(texts);

    expect(Math.max(...calls.map((c) => c.length))).toBe(EMBED_BATCH_SIZE);
    expect(calls).toHaveLength(Math.ceil(300 / EMBED_BATCH_SIZE));
    expect(out).toHaveLength(300);
    expect(out.map((v) => v[0])).toEqual(texts.map((t) => t.length));
  });

  it('loads the model once per instance', async () => {
    const e = new TransformerEmbedding({ model: 'm' });
    await e.embedText(['a']);
    await e.embedText(['b']);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it('a failed load is retried on the next call, not cached', async () => {
    pipeline.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND huggingface.co'));
    const e = new TransformerEmbedding({ model: 'm' });
    await expect(e.embedText(['a'])).rejects.toThrow('ENOTFOUND');
    await expect(e.embedText(['a'])).resolves.toHaveLength(1);
    expect(pipeline).toHaveBeenCalledTimes(2);
  });
});
