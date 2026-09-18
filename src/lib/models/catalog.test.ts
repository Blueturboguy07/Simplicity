import { describe, expect, it } from 'vitest';
import { availableRows, pickDefaultModel, BEST_ORDER } from './catalog';
import { MinimalProvider } from './types';

/* Pins the default-model policy for the packaged build: publik is what
   "Best" resolves to when it is the only connection, a key the user
   entered themselves always wins over it, and the three publik rows appear
   only when a publik connection lists them. */

const provider = (
  id: string,
  type: string,
  chatKeys: string[],
): MinimalProvider => ({
  id,
  type,
  name: id,
  chatModels: chatKeys.map((key) => ({ key, name: key })),
  embeddingModels: [],
});

const publik = () =>
  provider('p-publik', 'publik', [
    'publik-balanced',
    'publik-fast',
    'publik-smart',
  ]);

describe('catalog — publik API', () => {
  it('only publik connected → the default is publik-balanced', () => {
    expect(pickDefaultModel([publik()])).toEqual({
      providerId: 'p-publik',
      key: 'publik-balanced',
    });
  });

  it('a user-entered key wins over publik (BEST_ORDER places publik after every hosted BYO row)', () => {
    expect(
      pickDefaultModel([publik(), provider('p-openai', 'openai', ['gpt-5.1'])]),
    ).toEqual({
      providerId: 'p-openai',
      key: 'gpt-5.1',
    });
    expect(
      pickDefaultModel([
        publik(),
        provider('p-anthropic', 'anthropic', ['claude-sonnet-5']),
      ]),
    ).toEqual({ providerId: 'p-anthropic', key: 'claude-sonnet-5' });

    const idx = (type: string) =>
      BEST_ORDER.findIndex((c) => c.providerType === type);
    for (const hosted of [
      'claudecode',
      'groq',
      'openai',
      'anthropic',
      'gemini',
      'xai',
    ]) {
      expect(idx(hosted)).toBeLessThan(idx('publik'));
    }
    expect(idx('publik')).toBeLessThan(idx('ollama'));
  });

  it('publik ranks above a local Ollama model', () => {
    expect(
      pickDefaultModel([
        provider('p-ollama', 'ollama', ['qwen2.5:7b']),
        publik(),
      ]),
    ).toEqual({
      providerId: 'p-publik',
      key: 'publik-balanced',
    });
  });

  it('the three publik rows show only when a publik connection lists them', () => {
    const withPublik = availableRows([publik()]).map((r) => r.row.id);
    expect(withPublik).toEqual([
      'publik-balanced',
      'publik-fast',
      'publik-smart',
    ]);
    expect(availableRows([publik()]).every((r) => r.free === false)).toBe(true);

    const without = availableRows([
      provider('p-openai', 'openai', ['gpt-5.1']),
    ]).map((r) => r.row.id);
    expect(without).not.toContain('publik-balanced');
  });

  it('a renamed alias from the install response still resolves its row when listed under the default key only', () => {
    /* The catalog row is keyed on the default alias; a renamed tier simply
       does not surface a row (the chat selector still lists the provider's
       own model list). Pinned so a rename is a visible, not silent, change. */
    const renamed = provider('p-publik', 'publik', ['publik-balanced-v2']);
    expect(availableRows([renamed])).toEqual([]);
    expect(pickDefaultModel([renamed])).toEqual({
      providerId: 'p-publik',
      key: 'publik-balanced-v2',
    });
  });
});
