import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';

/* The real onnxruntime is not loaded here: a fake pipeline records what the
   embedding class asks of the library. */
const calls: string[][] = [];
const env: {
  cacheDir?: string;
  useFSCache?: boolean;
  useCustomCache?: boolean;
  customCache?: { match: unknown; put: unknown };
} = {};
const realPipeline =
  async (_task: string, _model: string, _opts?: object) =>
  async (texts: string[]) => {
    calls.push(texts);
    return { tolist: () => texts.map((t) => [t.length]) };
  };
const pipeline = vi.fn(realPipeline);

vi.mock('@huggingface/transformers', () => ({ pipeline, env }));

const {
  default: TransformerEmbedding,
  EMBED_BATCH_SIZE,
  modelCacheDir,
  modelLoadRetry,
  isFileBusyError,
  ModelLoadError,
  MODEL_LOAD_FAILED_MESSAGE,
} = await import('./transformerEmbedding');

/* The exact error onnxruntime gave on the Windows runner (CI run
   41408225083, first model load of a fresh install). */
const busy = () =>
  new Error(
    'Load model from D:\\a\\_temp\\simplicity-data-node\\models\\Xenova\\all-MiniLM-L6-v2\\onnx\\model.onnx failed:system error number 13',
  );

const defaultDelays = [...modelLoadRetry.delaysMs];
let modelSeq = 0;
/* Loads are shared per model for the whole server, so each test uses its
   own model name. */
const freshModel = () => `test/model-${++modelSeq}`;

beforeEach(() => {
  calls.length = 0;
  pipeline.mockReset();
  pipeline.mockImplementation(realPipeline);
  for (const k of [
    'cacheDir',
    'useFSCache',
    'useCustomCache',
    'customCache',
  ] as const)
    delete env[k];
  modelLoadRetry.delaysMs = [1, 1, 1, 1, 1];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  modelLoadRetry.delaysMs = [...defaultDelays];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TransformerEmbedding', () => {
  it('keeps models in DATA_DIR/models, never inside the app bundle', async () => {
    process.env.DATA_DIR = '/Users/x/Library/Application Support/Simplicity';
    await new TransformerEmbedding({
      model: 'Xenova/all-MiniLM-L6-v2',
    }).embedText(['a']);
    expect(env.cacheDir).toBe(
      path.join('/Users/x/Library/Application Support/Simplicity', 'models'),
    );
  });

  it("gives onnxruntime the model as bytes: transformers' file cache off, the Simplicity cache on", async () => {
    process.env.DATA_DIR = '/Users/x/Library/Application Support/Simplicity';
    await new TransformerEmbedding({ model: freshModel() }).embedText(['a']);
    expect(env.useFSCache).toBe(false);
    expect(env.useCustomCache).toBe(true);
    expect(typeof env.customCache?.match).toBe('function');
    expect(typeof env.customCache?.put).toBe('function');
  });

  it('leaves the library default alone when there is no DATA_DIR (dev, docker)', () => {
    const saved = process.env.DATA_DIR;
    delete process.env.DATA_DIR;
    expect(modelCacheDir()).toBeNull();
    process.env.DATA_DIR = saved;
  });

  it('sends at most EMBED_BATCH_SIZE texts to onnxruntime per call and keeps the order', async () => {
    const texts = Array.from({ length: 300 }, (_, i) => 'x'.repeat(i + 1));
    const out = await new TransformerEmbedding({
      model: freshModel(),
    }).embedText(texts);

    expect(Math.max(...calls.map((c) => c.length))).toBe(EMBED_BATCH_SIZE);
    expect(calls).toHaveLength(Math.ceil(300 / EMBED_BATCH_SIZE));
    expect(out).toHaveLength(300);
    expect(out.map((v) => v[0])).toEqual(texts.map((t) => t.length));
  });

  it('loads a model once for the whole server, not once per request', async () => {
    const model = freshModel();
    await new TransformerEmbedding({ model }).embedText(['a']);
    await new TransformerEmbedding({ model }).embedText(['b']);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it('two requests at once on a fresh install share one load (one download, one file)', async () => {
    const model = freshModel();
    const [a, b] = await Promise.all([
      new TransformerEmbedding({ model }).embedText(['a']),
      new TransformerEmbedding({ model }).embedText(['bb']),
    ]);
    expect(a).toEqual([[1]]);
    expect(b).toEqual([[2]]);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it('first load on Windows: "system error number 13" once, then the load works', async () => {
    pipeline.mockRejectedValueOnce(busy());
    const out = await new TransformerEmbedding({
      model: freshModel(),
    }).embedText(['abc']);
    expect(out).toEqual([[3]]);
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it('first load on Windows: EACCES twice, then the load works', async () => {
    pipeline.mockRejectedValueOnce(busy()).mockRejectedValueOnce(
      Object.assign(new Error("EACCES: permission denied, open 'model.onnx'"), {
        code: 'EACCES',
      }),
    );
    const out = await new TransformerEmbedding({
      model: freshModel(),
    }).embedText(['abcd']);
    expect(out).toEqual([[4]]);
    expect(pipeline).toHaveBeenCalledTimes(3);
  });

  it('busy on every try: a plain error without the path; the next call loads again and works', async () => {
    const model = freshModel();
    pipeline.mockImplementation(async () => {
      throw busy();
    });
    const failed = new TransformerEmbedding({ model }).embedText(['a']);
    await expect(failed).rejects.toBeInstanceOf(ModelLoadError);
    const err = await failed.catch((e) => e);
    expect(err.message).toBe(MODEL_LOAD_FAILED_MESSAGE);
    expect(err.message).toBe(
      'Simplicity could not load its file model. Try the upload again.',
    );
    expect(err.message).not.toMatch(/model\.onnx|simplicity-data|\\|\//);
    expect((err.cause as Error).message).toContain('system error number 13');
    /* first try + one per wait */
    expect(pipeline).toHaveBeenCalledTimes(modelLoadRetry.delaysMs.length + 1);

    pipeline.mockReset();
    pipeline.mockImplementation(realPipeline);
    await expect(
      new TransformerEmbedding({ model }).embedText(['ab']),
    ).resolves.toEqual([[2]]);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it('a failed load that is not a busy file is not retried in the same call, and not cached', async () => {
    const model = freshModel();
    pipeline.mockRejectedValueOnce(
      new Error('getaddrinfo ENOTFOUND huggingface.co'),
    );
    const e = new TransformerEmbedding({ model });
    const err = await e.embedText(['a']).catch((x) => x);
    expect(err).toBeInstanceOf(ModelLoadError);
    expect((err.cause as Error).message).toContain('ENOTFOUND');
    expect(pipeline).toHaveBeenCalledTimes(1);
    await expect(e.embedText(['a'])).resolves.toHaveLength(1);
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it('waits 0.25, 0.5, 1, 2, 4 s between tries by default', async () => {
    expect(defaultDelays).toEqual([250, 500, 1000, 2000, 4000]);
    modelLoadRetry.delaysMs = [...defaultDelays];
    vi.useFakeTimers();
    pipeline
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy());
    const done = new TransformerEmbedding({ model: freshModel() }).embedText([
      'a',
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(pipeline).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pipeline).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(pipeline).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pipeline).toHaveBeenCalledTimes(4);
    await expect(done).resolves.toEqual([[1]]);
  });
});

describe('isFileBusyError', () => {
  it.each([
    [busy(), true],
    [Object.assign(new Error('x'), { code: 'EACCES' }), true],
    [Object.assign(new Error('x'), { code: 'EBUSY' }), true],
    [Object.assign(new Error('x'), { code: 'EPERM' }), true],
    [new Error('EBUSY: resource busy or locked, open model.onnx'), true],
    [
      new Error(
        'The process cannot access the file because it is being used by another process.',
      ),
      true,
    ],
    [new Error('getaddrinfo ENOTFOUND huggingface.co'), false],
    [new Error('Load model from x failed:Protobuf parsing failed.'), false],
    [new Error('Load model from x failed:system error number 130'), false],
  ])('%s -> %s', (err, expected) => {
    expect(isFileBusyError(err)).toBe(expected);
  });
});
