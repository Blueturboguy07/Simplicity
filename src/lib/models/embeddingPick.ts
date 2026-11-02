import { MinimalProvider } from './types';

export type EmbeddingPick = { providerId: string; key: string };

/* Which embedding model the chat and uploads use. Embeddings are never a
   user-facing choice: they rank search results and file chunks.

   Order:
   1. The stored choice, if it still resolves to a real embedding model.
   2. Ollama's purpose-built embedding model. Ollama lists its chat models as
      embedding models too, so "has 'embed' in the key" is what tells them
      apart there.
   3. The first embedding model of the first provider that has one. For the
      built-in Transformers provider this is all-MiniLM-L6-v2, the same model
      the setup wizard picks (SetupConfig.tsx).

   The 'embed' test is for Ollama only. It used to run for every provider,
   and for Transformers it picked mixedbread-ai/mxbai-embed-large-v1 (1.34 GB)
   whenever localStorage was empty, which was after every app restart. Loading
   that model crashed the packaged server under Electron, so every upload and
   web search after a restart failed. */
export const pickEmbeddingModel = (
  providers: MinimalProvider[],
  stored: { providerId?: string | null; key?: string | null } = {},
): EmbeddingPick | null => {
  const hasEmbedding = (p: MinimalProvider) => p.embeddingModels.length > 0;
  const isOllamaEmbed = (key: string) => key.includes('embed');

  const provider =
    providers.find((p) => p.id === stored.providerId && hasEmbedding(p)) ??
    providers.find(
      (p) => p.type === 'ollama' && p.embeddingModels.some((m) => isOllamaEmbed(m.key)),
    ) ??
    providers.find(hasEmbedding);

  if (!provider) return null;

  const model =
    provider.embeddingModels.find((m) => m.key === stored.key) ??
    (provider.type === 'ollama'
      ? provider.embeddingModels.find((m) => isOllamaEmbed(m.key))
      : undefined) ??
    provider.embeddingModels[0];

  return { providerId: provider.id, key: model.key };
};
