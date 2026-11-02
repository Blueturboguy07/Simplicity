import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/config/serverRegistry', () => ({
  getConfiguredModelProviderById: () => ({ embeddingModels: [] }),
}));

const { default: TransformersProvider, defaultEmbeddingModels } = await import(
  './index'
);

describe('built-in Transformers embedding models', () => {
  it('the default (first) is all-MiniLM-L6-v2, the model setup picks', async () => {
    expect(defaultEmbeddingModels[0].key).toBe('Xenova/all-MiniLM-L6-v2');
    const list = await new TransformersProvider('t1', 'Built-in', {}).getModelList();
    expect(list.embedding[0].key).toBe('Xenova/all-MiniLM-L6-v2');
  });

  it('does not offer mxbai-embed-large-v1 (crashes the server under Electron at load)', async () => {
    const list = await new TransformersProvider('t1', 'Built-in', {}).getModelList();
    expect(list.embedding.map((m) => m.key)).not.toContain(
      'mixedbread-ai/mxbai-embed-large-v1',
    );
  });
});
