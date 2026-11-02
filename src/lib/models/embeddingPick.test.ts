import { describe, expect, it } from 'vitest';
import { pickEmbeddingModel } from './embeddingPick';
import { MinimalProvider } from './types';

const transformers: MinimalProvider = {
  id: 't1',
  type: 'transformers',
  name: 'Built-in',
  chatModels: [],
  embeddingModels: [
    { name: 'all-MiniLM-L6-v2', key: 'Xenova/all-MiniLM-L6-v2' },
    { name: 'nomic-embed-text-v1', key: 'Xenova/nomic-embed-text-v1' },
  ],
};

const ollama: MinimalProvider = {
  id: 'o1',
  type: 'ollama',
  name: 'Ollama',
  chatModels: [{ name: 'qwen2.5:7b', key: 'qwen2.5:7b' }],
  embeddingModels: [
    { name: 'qwen2.5:7b', key: 'qwen2.5:7b' },
    { name: 'nomic-embed-text', key: 'nomic-embed-text:latest' },
  ],
};

const publik: MinimalProvider = {
  id: 'p1',
  type: 'publik',
  name: 'publik',
  chatModels: [{ name: 'Balanced', key: 'publik-balanced' }],
  embeddingModels: [],
};

describe('pickEmbeddingModel', () => {
  it('empty localStorage (every restart before 1.12.4) -> the small model setup picked, not a key with "embed" in it', () => {
    expect(pickEmbeddingModel([publik, transformers], {})).toEqual({
      providerId: 't1',
      key: 'Xenova/all-MiniLM-L6-v2',
    });
  });

  it('a stored choice that still exists is kept', () => {
    expect(
      pickEmbeddingModel([publik, transformers], {
        providerId: 't1',
        key: 'Xenova/nomic-embed-text-v1',
      }),
    ).toEqual({ providerId: 't1', key: 'Xenova/nomic-embed-text-v1' });
  });

  it('a stored model that is gone (mxbai, removed in 1.12.4) falls back to the provider default', () => {
    expect(
      pickEmbeddingModel([transformers], {
        providerId: 't1',
        key: 'mixedbread-ai/mxbai-embed-large-v1',
      }),
    ).toEqual({ providerId: 't1', key: 'Xenova/all-MiniLM-L6-v2' });
  });

  it('a stored provider with no embedding models is skipped', () => {
    expect(
      pickEmbeddingModel([publik, transformers], { providerId: 'p1', key: 'x' }),
    ).toEqual({ providerId: 't1', key: 'Xenova/all-MiniLM-L6-v2' });
  });

  it('Ollama: its embedding model, never a chat model it also lists', () => {
    expect(pickEmbeddingModel([transformers, ollama], {})).toEqual({
      providerId: 'o1',
      key: 'nomic-embed-text:latest',
    });
  });

  it('no provider with embedding models -> null', () => {
    expect(pickEmbeddingModel([publik], {})).toBeNull();
  });
});
