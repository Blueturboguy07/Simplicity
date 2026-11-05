import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/* Item 5 of the round-2 review, against the REAL config module on a scratch
 * DATA_DIR (fake keys only):
 *   - POST /api/config must refuse dotted keys that walk onto
 *     Object.prototype (__proto__, constructor, prototype);
 *   - GET /api/config must not return a BYO key in clear text;
 *   - saving a provider from Settings with the key field left empty (or
 *     still masked) must keep the stored key.
 * Only the model registry is replaced, so no provider makes a network call.
 * Imports only modules that also exist on 52eea5b, so this file runs (and
 * fails) there too. */

vi.mock('@/lib/models/registry', async () => {
  const { default: configManager } = await import('@/lib/config');
  class FakeRegistry {
    async getActiveProviders() {
      return [];
    }
    async updateProvider(id: string, name: string, config: any) {
      const updated = await configManager.updateModelProvider(id, name, config);
      return { ...updated, chatModels: [], embeddingModels: [] };
    }
    async addProvider(type: string, name: string, config: any) {
      const p = configManager.addModelProvider(type, name, config);
      return { ...p, chatModels: [], embeddingModels: [] };
    }
    async removeProvider(id: string) {
      configManager.removeModelProvider(id);
    }
  }
  return { default: FakeRegistry };
});

const BYO_KEY = 'sk-FAKE-route-test-0000000000000wxyz';
const PUBLIK_KEY = 'pk_test_abcdefghijkl_00000000000000000000000000000000';

let dataDir = '';
const savedEnv: Record<string, string | undefined> = {};
let configRoute: typeof import('./route');
let providerRoute: typeof import('../providers/[id]/route');
let configManager: (typeof import('@/lib/config'))['default'];

const APP = 'http://127.0.0.1:8790';
const jsonReq = (url: string, method: string, body: unknown) =>
  new NextRequest(new URL(url, APP), {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const readFile = () =>
  JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'config.json'), 'utf8'));

beforeAll(async () => {
  /* no real key from the shell may reach the scratch config */
  for (const k of Object.keys(process.env)) {
    if (/API_KEY$|_TOKEN$|^DATA_DIR$/.test(k)) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simplicity-config-route-'));
  fs.mkdirSync(path.join(dataDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'data', 'config.json'),
    JSON.stringify({
      version: 1,
      setupComplete: true,
      preferences: {},
      personalization: {},
      modelProviders: [
        { id: 'pub-1', name: 'publik API', type: 'publik', chatModels: [], embeddingModels: [], hash: 'h1', config: { apiKey: PUBLIK_KEY, baseURL: 'http://127.0.0.1:1/v1' } },
        { id: 'byo-1', name: 'OpenAI', type: 'openai', chatModels: [], embeddingModels: [], hash: 'h2', config: { apiKey: BYO_KEY, baseURL: 'http://127.0.0.1:1/v1' } },
      ],
      search: { searxngURL: '' },
    }),
  );
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  configManager = (await import('@/lib/config')).default;
  configRoute = await import('./route');
  providerRoute = await import('../providers/[id]/route');
});

afterAll(() => {
  delete (Object.prototype as any).polluted;
  delete (Object.prototype as any).lastError;
  delete process.env.DATA_DIR;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/config — prototype segments', () => {
  it.each([
    '__proto__.polluted',
    'preferences.__proto__.polluted',
    'constructor.prototype.polluted',
    'modelProviders.constructor.polluted',
    'prototype',
  ])('refuses %s with 400 and pollutes nothing', async (key) => {
    const res = await configRoute.POST(
      jsonReq('/api/config', 'POST', { key, value: 'yes' }),
    );
    expect(res.status).toBe(400);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('the proven exploit (__proto__.lastError shows up in publik status) is gone', async () => {
    await configRoute.POST(
      jsonReq('/api/config', 'POST', { key: '__proto__.lastError', value: 'POLLUTED' }),
    );
    expect(({} as any).lastError).toBeUndefined();
  });

  it('ConfigManager.updateConfig refuses the segments too', () => {
    expect(() => configManager.updateConfig('__proto__.polluted', 'yes')).toThrow();
    expect(({} as any).polluted).toBeUndefined();
  });

  it('a normal dotted key still saves', async () => {
    const res = await configRoute.POST(
      jsonReq('/api/config', 'POST', { key: 'preferences.theme', value: 'dark' }),
    );
    expect(res.status).toBe(200);
    expect(readFile().preferences.theme).toBe('dark');
  });
});

describe('GET /api/config — no key in clear text', () => {
  it('masks the BYO key, keeps only its last four characters', async () => {
    const res = await configRoute.GET(new NextRequest(new URL('/api/config', APP)));
    const text = await res.clone().text();
    expect(text).not.toContain(BYO_KEY);
    const body = await res.json();
    const byo = body.values.modelProviders.find((p: any) => p.id === 'byo-1');
    expect(byo.config.apiKey).toBe('••••••••wxyz');
    expect(byo.config.baseURL).toBe('http://127.0.0.1:1/v1');
  });

  it('keeps the publik key masked to its public id, as before', async () => {
    const res = await configRoute.GET(new NextRequest(new URL('/api/config', APP)));
    const text = await res.text();
    expect(text).not.toContain(PUBLIK_KEY);
    expect(text).toContain('pk_test_abcdefghijkl_••••••••');
  });
});

describe('PATCH /api/providers/[id] — an unchanged key is kept', () => {
  const patch = (config: Record<string, any>) =>
    providerRoute.PATCH(
      jsonReq('/api/providers/byo-1', 'PATCH', { name: 'OpenAI', config }),
      { params: Promise.resolve({ id: 'byo-1' }) },
    );
  const storedKey = () =>
    readFile().modelProviders.find((p: any) => p.id === 'byo-1').config.apiKey;

  it('empty key field keeps the stored key; the response is masked', async () => {
    const res = await patch({ apiKey: '', baseURL: 'http://127.0.0.1:2/v1' });
    expect(res.status).toBe(200);
    expect(storedKey()).toBe(BYO_KEY);
    expect(readFile().modelProviders.find((p: any) => p.id === 'byo-1').config.baseURL).toBe('http://127.0.0.1:2/v1');
    expect(await res.text()).not.toContain(BYO_KEY);
  });

  it('the masked value sent back keeps the stored key', async () => {
    await patch({ apiKey: '••••••••wxyz', baseURL: 'http://127.0.0.1:2/v1' });
    expect(storedKey()).toBe(BYO_KEY);
  });

  it('a new key replaces the stored one', async () => {
    await patch({ apiKey: 'sk-FAKE-new-key-111111111111abcd', baseURL: 'http://127.0.0.1:2/v1' });
    expect(storedKey()).toBe('sk-FAKE-new-key-111111111111abcd');
  });
});
