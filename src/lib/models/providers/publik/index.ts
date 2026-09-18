import { UIConfigField } from '@/lib/config/types';
import { getConfiguredModelProviderById } from '@/lib/config/serverRegistry';
import { Model, ModelList, ProviderMetadata } from '../../types';
import BaseModelProvider from '../../base/provider';
import BaseLLM from '../../base/llm';
import BaseEmbedding from '../../base/embedding';
import OpenAILLM from '../openai/openaiLLM';
import { publikBalance } from '@/lib/publik/balance';
import { mapPublikError } from '@/lib/publik/errors';
import { publikModels } from '@/lib/publik/provision';
import {
  PUBLIK_APP_SLUG,
  PUBLIK_BASE_URL_DEFAULT,
  PUBLIK_TIER_NAMES,
  PUBLIK_TIER_ORDER,
} from '@/lib/publik/types';

/* publik API — a distinct provider type rather than the `openai` type with
   a swapped URL: OpenAIProvider.getDefaultModels() returns an empty list
   off api.openai.com, the picker needs its own label ("publik API"),
   Settings renders the key read-only, and the price table must know the
   charge is 50% of list. The LLM class is OpenAILLM verbatim — the wire
   shape is unchanged. */

interface PublikConfig {
  apiKey: string;
  baseURL: string;
}

/* Same two fields as OpenAI, same env-var convention, so
   ConfigManager.initializeFromEnv() auto-creates this provider from
   PUBLIK_API_KEY alone — the credential convention's step 2 for free. */
const providerConfigFields: UIConfigField[] = [
  {
    type: 'password',
    name: 'publik API key',
    key: 'apiKey',
    description:
      'Issued to this computer by publik. Manage it at publikhq.com/dashboard/api.',
    required: true,
    placeholder: 'pk_live_…',
    env: 'PUBLIK_API_KEY',
    scope: 'server',
  },
  {
    type: 'string',
    name: 'Base URL',
    key: 'baseURL',
    description: 'The publik API endpoint',
    required: true,
    placeholder: PUBLIK_BASE_URL_DEFAULT,
    default: PUBLIK_BASE_URL_DEFAULT,
    env: 'PUBLIK_API_BASE_URL',
    scope: 'server',
  },
];

class PublikProvider extends BaseModelProvider<PublikConfig> {
  constructor(id: string, name: string, config: PublikConfig) {
    super(id, name, config);
  }

  /* A fixed alias list, on purpose: the gateway serves GET /models, but a
     live fetch would put upstream slugs in the picker, and the alias is the
     swap seam. Names come from the install response when it renamed them.
     Embeddings are not served in v1 — the wizard picks the bundled
     Transformers model for those anyway (SetupConfig.tsx). */
  async getDefaultModels(): Promise<ModelList> {
    const aliases = publikModels();
    const chat: Model[] = PUBLIK_TIER_ORDER.map((tier) => ({
      name: PUBLIK_TIER_NAMES[tier],
      key: aliases[tier],
    }));
    return { chat, embedding: [] };
  }

  async getModelList(): Promise<ModelList> {
    const defaults = await this.getDefaultModels();
    const stored = getConfiguredModelProviderById(this.id);
    return {
      chat: [...defaults.chat, ...(stored?.chatModels ?? [])],
      embedding: [...defaults.embedding, ...(stored?.embeddingModels ?? [])],
    };
  }

  async loadChatModel(key: string): Promise<BaseLLM<any>> {
    const list = await this.getModelList();
    if (!list.chat.some((m) => m.key === key)) {
      throw new Error(
        'Error Loading publik Chat Model. Invalid Model Selected',
      );
    }
    return new OpenAILLM({
      apiKey: this.config.apiKey,
      model: key,
      baseURL: this.config.baseURL,
      /* advisory only — the key already identifies the app */
      defaultHeaders: { 'X-Publik-App': PUBLIK_APP_SLUG },
      onResponse: (headers) => publikBalance.observe(headers),
      mapError: mapPublikError,
    });
  }

  async loadEmbeddingModel(_key: string): Promise<BaseEmbedding<any>> {
    throw new Error('publik API does not serve embeddings yet.');
  }

  static parseAndValidate(raw: any): PublikConfig {
    if (!raw || typeof raw !== 'object')
      throw new Error('Invalid config provided. Expected object');
    if (!raw.apiKey)
      throw new Error(
        'Invalid config provided. publik API key must be provided',
      );
    return {
      apiKey: String(raw.apiKey),
      baseURL: String(raw.baseURL || PUBLIK_BASE_URL_DEFAULT),
    };
  }

  static getProviderConfigFields(): UIConfigField[] {
    return providerConfigFields;
  }

  static getProviderMetadata(): ProviderMetadata {
    return { key: 'publik', name: 'publik API' };
  }
}

export default PublikProvider;
