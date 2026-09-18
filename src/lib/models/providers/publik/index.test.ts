import { beforeEach, describe, expect, it, vi } from 'vitest';

/* PublikProvider: metadata/env names, the alias-only model list (with the
   install response's renames honoured), and the OpenAILLM it hands back
   (base URL from the stored config, the advisory app header, both hooks
   wired). */

const { store } = vi.hoisted(() => ({ store: { config: {} as any } }));

vi.mock('@/lib/config', () => ({
  default: {
    getConfig: (key: string, dflt?: any) => {
      let obj: any = store.config;
      for (const part of key.split('.')) {
        if (obj == null) return dflt;
        obj = obj[part];
      }
      return obj === undefined ? dflt : obj;
    },
    updateConfig: vi.fn(),
    addModelProvider: vi.fn(),
    removeModelProvider: vi.fn(),
  },
}));

import PublikProvider from './index';
import OpenAILLM from '../openai/openaiLLM';
import { providers } from '../index';
import { mapPublikError } from '@/lib/publik/errors';

const ID = 'prov-1';

beforeEach(() => {
  store.config = {
    modelProviders: [
      {
        id: ID,
        name: 'publik API',
        type: 'publik',
        chatModels: [],
        embeddingModels: [],
        config: { apiKey: 'pk_live_k', baseURL: 'https://publikhq.com/api/v1' },
        hash: 'h',
      },
    ],
    publik: { installId: 'i', state: 'active' },
  };
});

describe('PublikProvider — statics', () => {
  it('is registered under the key "publik" and named "publik API"', () => {
    expect(providers.publik).toBe(PublikProvider);
    expect(PublikProvider.getProviderMetadata()).toEqual({
      key: 'publik',
      name: 'publik API',
    });
  });

  it('declares the PUBLIK_API_KEY / PUBLIK_API_BASE_URL env convention', () => {
    const fields = PublikProvider.getProviderConfigFields();
    expect(fields.map((f) => f.env)).toEqual([
      'PUBLIK_API_KEY',
      'PUBLIK_API_BASE_URL',
    ]);
    expect(fields.find((f) => f.key === 'baseURL')?.type).toBe('string');
    expect((fields.find((f) => f.key === 'baseURL') as any).default).toBe(
      'https://publikhq.com/api/v1',
    );
  });

  it('parseAndValidate requires a key and defaults the base URL', () => {
    expect(() => PublikProvider.parseAndValidate({})).toThrow(/key/);
    expect(PublikProvider.parseAndValidate({ apiKey: 'pk' })).toEqual({
      apiKey: 'pk',
      baseURL: 'https://publikhq.com/api/v1',
    });
    expect(
      PublikProvider.parseAndValidate({
        apiKey: 'pk',
        baseURL: 'https://api.publikhq.com/v1',
      }).baseURL,
    ).toBe('https://api.publikhq.com/v1');
  });
});

describe('PublikProvider — models', () => {
  it('lists exactly the three tier aliases, balanced first', async () => {
    const p = new PublikProvider(ID, 'publik API', {
      apiKey: 'pk_live_k',
      baseURL: 'https://publikhq.com/api/v1',
    });
    const list = await p.getModelList();
    expect(list.chat.map((m) => m.key)).toEqual([
      'publik-balanced',
      'publik-fast',
      'publik-smart',
    ]);
    expect(list.chat.map((m) => m.name)).toEqual(['Balanced', 'Fast', 'Smart']);
    expect(list.embedding).toEqual([]);
  });

  it('honours alias names the install response supplied', async () => {
    store.config.publik.models = { balanced: 'publik-balanced-v2' };
    const p = new PublikProvider(ID, 'publik API', {
      apiKey: 'pk_live_k',
      baseURL: 'https://publikhq.com/api/v1',
    });
    const list = await p.getModelList();
    expect(list.chat.map((m) => m.key)).toEqual([
      'publik-balanced-v2',
      'publik-fast',
      'publik-smart',
    ]);
  });

  it('rejects an upstream slug and serves no embeddings', async () => {
    const p = new PublikProvider(ID, 'publik API', {
      apiKey: 'pk_live_k',
      baseURL: 'https://publikhq.com/api/v1',
    });
    await expect(p.loadChatModel('gpt-4o')).rejects.toThrow(/Invalid Model/);
    await expect(
      p.loadEmbeddingModel('text-embedding-3-small'),
    ).rejects.toThrow(/does not serve embeddings/);
  });

  it('loadChatModel returns an OpenAILLM pointed at the stored base URL with both hooks', async () => {
    const p = new PublikProvider(ID, 'publik API', {
      apiKey: 'pk_live_k',
      baseURL: 'https://api.publikhq.com/v1',
    });
    const llm = (await p.loadChatModel('publik-balanced')) as OpenAILLM;
    expect(llm).toBeInstanceOf(OpenAILLM);
    const cfg = (llm as any).config;
    expect(cfg.baseURL).toBe('https://api.publikhq.com/v1');
    expect(cfg.model).toBe('publik-balanced');
    expect(cfg.defaultHeaders).toEqual({ 'X-Publik-App': 'simplicity' });
    expect(cfg.mapError).toBe(mapPublikError);
    expect(typeof cfg.onResponse).toBe('function');
    expect(llm.openAIClient.baseURL).toBe('https://api.publikhq.com/v1');
  });
});
