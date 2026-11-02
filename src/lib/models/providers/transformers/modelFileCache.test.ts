import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { modelFileCache } from './transformerEmbedding';

/* The model cache that keeps onnxruntime from opening model files (v0.1.6).
   On Windows, onnxruntime opens a model file "deny others write", and the
   first load of a fresh install failed with "system error number 13" while
   transformers.js still had the downloaded file open for writing (CI run
   41408225083). With this cache, transformers.js gives onnxruntime bytes. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simplicity-modelcache-'));
let dir = '';
let seq = 0;

const url = (model: string, file: string) =>
  `https://huggingface.co/${model}/resolve/main/${file}`;

const partsIn = (folder: string): string[] =>
  fs.existsSync(folder)
    ? fs
        .readdirSync(folder, { recursive: true })
        .map(String)
        .filter((f) => f.endsWith('.part'))
    : [];

beforeEach(() => {
  dir = path.join(root, `cache-${++seq}`);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('modelFileCache', () => {
  it('has nothing for a model that is not downloaded', async () => {
    expect(
      await modelFileCache(dir).match(url('Xenova/m', 'onnx/model.onnx')),
    ).toBeUndefined();
  });

  it('keeps a download in <dir>/<model>/<file> (the layout of older versions) and reads it back', async () => {
    const cache = modelFileCache(dir);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await cache.put(
      url('Xenova/all-MiniLM-L6-v2', 'onnx/model.onnx'),
      new Response(bytes),
    );

    const file = path.join(
      dir,
      'Xenova',
      'all-MiniLM-L6-v2',
      'onnx',
      'model.onnx',
    );
    expect([...fs.readFileSync(file)]).toEqual([1, 2, 3, 4, 5]);
    expect(partsIn(dir)).toEqual([]);

    const hit = await cache.match(
      url('Xenova/all-MiniLM-L6-v2', 'onnx/model.onnx'),
    );
    expect(hit?.ok).toBe(true);
    expect(hit?.status).toBe(200);
    expect(hit?.headers.get('content-length')).toBe('5');
    expect([...new Uint8Array(await hit!.arrayBuffer())]).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('uses a model that an older version downloaded', async () => {
    const file = path.join(dir, 'Xenova', 'all-MiniLM-L6-v2', 'tokenizer.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"old":true}');

    const hit = await modelFileCache(dir).match(
      url('Xenova/all-MiniLM-L6-v2', 'tokenizer.json'),
    );
    expect(Buffer.from(await hit!.arrayBuffer()).toString()).toBe(
      '{"old":true}',
    );
  });

  it('two loads that put the same file at once leave one whole file and no .part file', async () => {
    const cache = modelFileCache(dir);
    const big = new Uint8Array(3 * 1024 * 1024).fill(7);
    await Promise.all([
      cache.put(url('Xenova/m', 'onnx/model.onnx'), new Response(big)),
      cache.put(url('Xenova/m', 'onnx/model.onnx'), new Response(big)),
    ]);
    const file = path.join(dir, 'Xenova', 'm', 'onnx', 'model.onnx');
    expect(fs.statSync(file).size).toBe(big.length);
    expect(partsIn(dir)).toEqual([]);
  });

  it('a download that breaks off leaves no file and no .part file', async () => {
    const cache = modelFileCache(dir);
    const broken = {
      arrayBuffer: () => Promise.reject(new Error('socket hang up')),
    } as unknown as Response;
    await expect(
      cache.put(url('Xenova/m', 'onnx/model.onnx'), broken),
    ).rejects.toThrow('socket hang up');
    expect(
      fs.existsSync(path.join(dir, 'Xenova', 'm', 'onnx', 'model.onnx')),
    ).toBe(false);
    expect(partsIn(dir)).toEqual([]);
  });

  it('ignores keys that are not a model file URL or that point outside the folder', async () => {
    const cache = modelFileCache(dir);
    for (const key of [
      '/models/Xenova/m/onnx/model.onnx',
      'https://huggingface.co/Xenova/m/resolve/v2/onnx/model.onnx',
      'https://huggingface.co/../etc/resolve/main/passwd',
      'https://huggingface.co/Xenova/m/resolve/main/../../../outside.txt',
    ]) {
      expect(await cache.match(key)).toBeUndefined();
      await cache.put(key, new Response('x'));
    }
    expect(fs.existsSync(path.join(root, 'outside.txt'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'etc'))).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

/* The real transformers.js 3.8.1 download code (src/utils/hub.js, the same
   code as the dist build the app runs) with the settings the app uses. */
describe('transformers.js with this cache', () => {
  const pkg = path.join(
    process.cwd(),
    'node_modules',
    '@huggingface',
    'transformers',
  );
  const saved: Record<string, unknown> = {};
  let env: Record<string, unknown>;

  beforeEach(async () => {
    ({ env } = await import(
      /* @vite-ignore */ pathToFileURL(path.join(pkg, 'src', 'env.js')).href
    ));
    for (const k of ['useFSCache', 'useCustomCache', 'customCache', 'cacheDir'])
      saved[k] = env[k];
  });

  afterEach(() => {
    Object.assign(env, saved);
    vi.unstubAllGlobals();
  });

  it('gives the model as bytes (never a path), downloads it once and keeps it on disk', async () => {
    const { getModelFile } = await import(
      /* @vite-ignore */ pathToFileURL(path.join(pkg, 'src', 'utils', 'hub.js'))
        .href
    );
    const model = new Uint8Array(1000).map((_, i) => i % 251);
    const fetch = vi.fn(
      async (_url: string, _init?: object) =>
        new Response(model, {
          status: 200,
          headers: { 'content-length': String(model.length) },
        }),
    );
    vi.stubGlobal('fetch', fetch);

    /* What loadEmbeddingPipeline sets. */
    env.cacheDir = dir;
    env.useFSCache = false;
    env.useCustomCache = true;
    env.customCache = modelFileCache(dir);
    /* What transformers' models.js passes for the model file: "return_path =
       IS_NODE_ENV && env.useFSCache" (dist/transformers.node.mjs line 7803). */
    const returnPath = env.useFSCache as boolean;

    const first = await getModelFile(
      'Xenova/race-model',
      'onnx/model.onnx',
      true,
      {},
      returnPath,
    );
    expect(first).toBeInstanceOf(Uint8Array);
    expect([...first]).toEqual([...model]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(
      url('Xenova/race-model', 'onnx/model.onnx'),
    );

    const file = path.join(dir, 'Xenova', 'race-model', 'onnx', 'model.onnx');
    expect([...fs.readFileSync(file)]).toEqual([...model]);
    expect(partsIn(dir)).toEqual([]);

    const second = await getModelFile(
      'Xenova/race-model',
      'onnx/model.onnx',
      true,
      {},
      returnPath,
    );
    expect(second).toBeInstanceOf(Uint8Array);
    expect([...second]).toEqual([...model]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("v0.1.5 settings (transformers' own file cache): onnxruntime got a PATH to open", async () => {
    const { getModelFile } = await import(
      /* @vite-ignore */ pathToFileURL(path.join(pkg, 'src', 'utils', 'hub.js'))
        .href
    );
    const model = new Uint8Array(100).fill(3);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(model, { status: 200 })),
    );
    env.cacheDir = dir;
    env.useFSCache = true;
    env.useCustomCache = false;

    const got = await getModelFile(
      'Xenova/old-model',
      'onnx/model.onnx',
      true,
      {},
      env.useFSCache,
    );
    expect(got).toBe(
      path.join(dir, 'Xenova', 'old-model', 'onnx', 'model.onnx'),
    );
  });

  it('the dist build the app runs still decides "path or bytes" from env.useFSCache', () => {
    const dist = fs.readFileSync(
      path.join(pkg, 'dist', 'transformers.node.mjs'),
      'utf8',
    );
    expect(dist).toMatch(
      /const return_path = \S+\.apis\.IS_NODE_ENV && \S+\.env\.useFSCache;/,
    );
  });
});
