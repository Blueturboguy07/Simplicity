import { UIConfigField } from '@/lib/config/types';
import { Model, ModelList, ProviderMetadata } from '../../types';
import OpenAIEmbedding from '../openai/openaiEmbedding';
import BaseEmbedding from '../../base/embedding';
import BaseModelProvider from '../../base/provider';
import BaseLLM from '../../base/llm';
import OpenAILLM from '../openai/openaiLLM';

/* A generic OpenAI-compatible provider: any server that speaks the OpenAI
   wire protocol (OpenRouter, Together, Groq, LM Studio, vLLM, LocalAI,
   KoboldCpp, etc.) can be connected by pointing at its base URL. Unlike the
   first-party OpenAI provider it ships with no hardcoded model list — the
   models are discovered from GET {baseURL}/models, and anything that endpoint
   doesn't list can be added manually in the connection's model list. */

interface OpenAICompatibleConfig {
  baseURL: string;
  apiKey?: string;
}

const trimTrailingSlash = (url: string) => url.replace(/\/+$/, '');

const providerConfigFields: UIConfigField[] = [
  {
    type: 'string',
    name: 'Base URL',
    key: 'baseURL',
    description:
      'The base URL of any OpenAI-compatible API (OpenRouter, Together, LM Studio, vLLM, LocalAI, …)',
    required: true,
    placeholder: 'https://api.openrouter.ai/v1',
    default: '',
    scope: 'server',
  },
  {
    type: 'password',
    name: 'API Key',
    key: 'apiKey',
    description:
      'Optional — leave empty for local servers that do not require one',
    required: false,
    placeholder: 'API Key (optional)',
    env: 'OPENAI_COMPATIBLE_API_KEY',
    scope: 'server',
  },
];

class OpenAICompatibleProvider extends BaseModelProvider<OpenAICompatibleConfig> {
  constructor(id: string, name: string, config: OpenAICompatibleConfig) {
    super(id, name, config);
  }

  async getDefaultModels(): Promise<ModelList> {
    const baseURL = trimTrailingSlash(this.config.baseURL);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    const res = await fetch(`${baseURL}/models`, {
      method: 'GET',
      headers,
    });

    if (!res.ok) {
      throw new Error(
        `Failed to fetch models from ${baseURL}/models (HTTP ${res.status}). Make sure the base URL is correct and the API key is valid.`,
      );
    }

    const data = await res.json();

    if (!data || !Array.isArray(data.data)) {
      throw new Error(
        `Model list from ${baseURL}/models did not return a "data" array.`,
      );
    }

    const chatModels: Model[] = data.data
      .filter((m: any) => m && typeof m.id === 'string')
      .map((m: any) => ({ key: m.id, name: m.name || m.id }));

    return {
      embedding: [],
      chat: chatModels,
    };
  }

  async getModelList(): Promise<ModelList> {
    let defaultModels: ModelList = { embedding: [], chat: [] };

    try {
      defaultModels = await this.getDefaultModels();
    } catch (err: any) {
      /* A model fetch failure surfaces the real reason instead of a blank
         list — the caller (registry) turns this into the `error` sentinel
         model, which the UI shows verbatim (see ModelProvider). */
      throw new Error(
        `Could not reach "${this.config.baseURL}": ${err?.message ?? err}`,
      );
    }

    const configProvider = (
      await import('@/lib/config/serverRegistry')
    ).getConfiguredModelProviderById(this.id)!;

    return {
      embedding: [
        ...defaultModels.embedding,
        ...configProvider.embeddingModels,
      ],
      chat: [...defaultModels.chat, ...configProvider.chatModels],
    };
  }

  async loadChatModel(key: string): Promise<BaseLLM<any>> {
    const modelList = await this.getModelList();

    const exists = modelList.chat.find((m) => m.key === key);

    if (!exists) {
      throw new Error(
        'Error Loading OpenAI Compatible Chat Model. Invalid Model Selected',
      );
    }

    return new OpenAILLM({
      /* The OpenAI SDK refuses an empty key; local servers that don't ask for
         one ignore the sentinel value. */
      apiKey: this.config.apiKey || 'not-required',
      model: key,
      baseURL: this.config.baseURL,
    });
  }

  async loadEmbeddingModel(key: string): Promise<BaseEmbedding<any>> {
    const modelList = await this.getModelList();
    const exists = modelList.embedding.find((m) => m.key === key);

    if (!exists) {
      throw new Error(
        'Error Loading OpenAI Compatible Embedding Model. Invalid Model Selected.',
      );
    }

    return new OpenAIEmbedding({
      apiKey: this.config.apiKey || 'not-required',
      model: key,
      baseURL: this.config.baseURL,
    });
  }

  static parseAndValidate(raw: any): OpenAICompatibleConfig {
    if (!raw || typeof raw !== 'object')
      throw new Error('Invalid config provided. Expected object');
    if (!raw.baseURL || typeof raw.baseURL !== 'string')
      throw new Error(
        'Invalid config provided. A base URL must be provided for OpenAI Compatible providers',
      );

    return {
      baseURL: trimTrailingSlash(String(raw.baseURL).trim()),
      apiKey: raw.apiKey ? String(raw.apiKey).trim() : undefined,
    };
  }

  static getProviderConfigFields(): UIConfigField[] {
    return providerConfigFields;
  }

  static getProviderMetadata(): ProviderMetadata {
    return {
      key: 'openaicompatible',
      name: 'OpenAI Compatible',
    };
  }
}

export default OpenAICompatibleProvider;
