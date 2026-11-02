import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/* POST /api/uploads with the REAL TransformerEmbedding and a fake
   @huggingface/transformers pipeline that fails the way the first model load
   failed on a Windows runner (CI run 41408225083, v0.1.5):
     500 {"message":"Upload failed: Load model from D:\\a\\_temp\\simplicity-data-node\\models\\Xenova\\all-MiniLM-L6-v2\\onnx\\model.onnx failed:system error number 13"}
   and the pdf and long txt right after it failed the same way. */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simplicity-firstload-'));
process.env.DATA_DIR = dataDir;
const uploadsDir = path.join(dataDir, 'data', 'uploads');

const busy = () =>
  new Error(
    `Load model from ${path.join(dataDir, 'models', 'Xenova', 'all-MiniLM-L6-v2', 'onnx', 'model.onnx')} failed:system error number 13`,
  );

const realPipeline = async (_task: string, _model: string, _opts?: object) =>
  async (texts: string[]) => ({ tolist: () => texts.map(() => [0.1, 0.2, 0.3]) });
const pipeline = vi.fn(realPipeline);
const env: { cacheDir?: string; remoteHost: string; remotePathTemplate: string } = {
  remoteHost: 'https://huggingface.co/',
  remotePathTemplate: '{model}/resolve/{revision}/',
};

vi.mock('@huggingface/transformers', () => ({ pipeline, env }));

/* The registry hands out a new TransformerEmbedding per request, as the
   Transformers provider does in the app. */
vi.mock('@/lib/models/registry', async () => {
  const { default: TransformerEmbedding } = await import(
    '@/lib/models/providers/transformers/transformerEmbedding'
  );
  return {
    default: class {
      async loadEmbeddingModel(_provider: string, key: string) {
        return new TransformerEmbedding({ model: key });
      }
    },
  };
});

const { POST } = await import('./route');
const { modelLoadRetry } = await import(
  '@/lib/models/providers/transformers/transformerEmbedding'
);

const txt = () =>
  new File(['secret PELICAN-7421\n'], 'notes.txt', { type: 'text/plain' });

const post = (model: string) => {
  const form = new FormData();
  form.append('files', txt());
  form.append('embedding_model_provider_id', 'p1');
  form.append('embedding_model_key', model);
  return POST(new Request('http://127.0.0.1/api/uploads', { method: 'POST', body: form }));
};

const storedFiles = () =>
  fs.existsSync(uploadsDir)
    ? fs.readdirSync(uploadsDir).filter((f) => f !== 'uploaded_files.json')
    : [];

const defaultDelays = [...modelLoadRetry.delaysMs];

beforeEach(() => {
  pipeline.mockReset();
  pipeline.mockImplementation(realPipeline);
  /* Same number of tries as the app, without the real waits. */
  modelLoadRetry.delaysMs = defaultDelays.map(() => 1);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  /* No network in unit tests: the model file download gets a 404. */
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
});

afterEach(() => {
  modelLoadRetry.delaysMs = [...defaultDelays];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('first model load on Windows ("system error number 13")', () => {
  it('fails once, then works: the upload returns 200', async () => {
    pipeline.mockRejectedValueOnce(busy());
    const res = await post('Xenova/all-MiniLM-L6-v2');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files[0]).toMatchObject({ fileName: 'notes.txt', fileExtension: 'txt' });
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it('fails twice, then works: the upload returns 200', async () => {
    pipeline.mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy());
    const res = await post('test/two-busy');

    expect(res.status).toBe(200);
    expect((await res.json()).files).toHaveLength(1);
    expect(pipeline).toHaveBeenCalledTimes(3);
  });

  it('fails on every try: a plain 500 without the path, no orphan file; the next upload works', async () => {
    const model = 'test/always-busy-then-free';
    const before = storedFiles().length;
    pipeline.mockImplementation(async () => {
      throw busy();
    });

    const failed = await post(model);
    expect(failed.status).toBe(500);
    const text = await failed.text();
    expect(JSON.parse(text)).toEqual({
      message: 'Simplicity could not load its file model. Try the upload again.',
    });
    expect(text).not.toMatch(/model\.onnx|Load model|system error|simplicity-firstload/);
    expect(pipeline).toHaveBeenCalledTimes(defaultDelays.length + 1);
    expect(storedFiles().length).toBe(before);

    /* The lock is gone now. The next upload loads the model again instead of
       getting the old rejection back. */
    pipeline.mockReset();
    pipeline.mockImplementation(realPipeline);
    const next = await post(model);
    expect(next.status).toBe(200);
    expect((await next.json()).files).toHaveLength(1);
    expect(pipeline).toHaveBeenCalledTimes(1);

    /* And the load is kept: one more upload does not load again. */
    const third = await post(model);
    expect(third.status).toBe(200);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });
});
