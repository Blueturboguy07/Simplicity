import { describe, expect, it, vi, afterEach } from 'vitest';
import OpenAICompatibleProvider from './index';

/* Covers the pieces of the OpenAI-compatible provider that don't need a
   configured provider record on disk: config validation/normalization and
   the GET {baseURL}/models discovery mapping. */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAICompatibleProvider.parseAndValidate', () => {
  it('accepts a base URL with an optional API key', () => {
    const cfg = OpenAICompatibleProvider.parseAndValidate({
      baseURL: 'https://api.openrouter.ai/v1',
      apiKey: 'sk-test',
    });
    expect(cfg).toEqual({
      baseURL: 'https://api.openrouter.ai/v1',
      apiKey: 'sk-test',
    });
  });

  it('accepts a base URL without an API key (local servers)', () => {
    const cfg = OpenAICompatibleProvider.parseAndValidate({
      baseURL: 'http://localhost:1234/v1',
    });
    expect(cfg.apiKey).toBeUndefined();
  });

  it('normalizes a trailing slash on the base URL', () => {
    const cfg = OpenAICompatibleProvider.parseAndValidate({
      baseURL: 'https://api.together.xyz/v1/',
    });
    expect(cfg.baseURL).toBe('https://api.together.xyz/v1');
  });

  it('rejects a missing base URL', () => {
    expect(() =>
      OpenAICompatibleProvider.parseAndValidate({ apiKey: 'sk-test' }),
    ).toThrow(/base URL/);
  });

  it('rejects non-object input', () => {
    expect(() => OpenAICompatibleProvider.parseAndValidate(null)).toThrow(
      /Expected object/,
    );
  });
});

describe('OpenAICompatibleProvider.getDefaultModels', () => {
  it('maps the /models endpoint data array to chat models', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'llama-3.3-70b' }, { id: 'gpt-4o', name: 'GPT-4o' }],
        }),
      }),
    );

    const provider = new OpenAICompatibleProvider(
      'test-id',
      'OpenAI Compatible',
      { baseURL: 'http://localhost:8080/v1' },
    );

    const models = await provider.getDefaultModels();

    expect(fetch).toHaveBeenCalledWith('http://localhost:8080/v1/models', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(models.chat).toEqual([
      { key: 'llama-3.3-70b', name: 'llama-3.3-70b' },
      { key: 'gpt-4o', name: 'GPT-4o' },
    ]);
    expect(models.embedding).toEqual([]);
  });

  it('sends the bearer token when an API key is configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'm1' }] }),
      }),
    );

    const provider = new OpenAICompatibleProvider(
      'test-id',
      'OpenAI Compatible',
      { baseURL: 'https://api.example.com/v1', apiKey: 'sk-test' },
    );

    await provider.getDefaultModels();

    expect(fetch).toHaveBeenCalledWith('https://api.example.com/v1/models', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-test',
      },
    });
  });

  it('throws a readable error when the endpoint rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
      }),
    );

    const provider = new OpenAICompatibleProvider(
      'test-id',
      'OpenAI Compatible',
      { baseURL: 'https://api.example.com/v1' },
    );

    await expect(provider.getDefaultModels()).rejects.toThrow(/HTTP 401/);
  });
});
