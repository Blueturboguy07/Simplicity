import { ModelProviderUISection } from '@/lib/config/types';
import { ProviderConstructor } from '../base/provider';
import OpenAIProvider from './openai';
import OllamaProvider from './ollama';
import GeminiProvider from './gemini';
import TransformersProvider from './transformers';
import GroqProvider from './groq';
import LemonadeProvider from './lemonade';
import AnthropicProvider from './anthropic';
import ClaudeCodeProvider from './claudecode';
import XAIProvider from './xai';
import OpenAICompatibleProvider from './openaicompatible';

export const providers: Record<string, ProviderConstructor<any>> = {
  openai: OpenAIProvider,
  ollama: OllamaProvider,
  gemini: GeminiProvider,
  transformers: TransformersProvider,
  groq: GroqProvider,
  lemonade: LemonadeProvider,
  anthropic: AnthropicProvider,
  claudecode: ClaudeCodeProvider,
  xai: XAIProvider,
  openaicompatible: OpenAICompatibleProvider,
};

export const getModelProvidersUIConfigSection =
  (): ModelProviderUISection[] => {
    return Object.entries(providers).map(([k, p]) => {
      const configFields = p.getProviderConfigFields();
      const metadata = p.getProviderMetadata();

      return {
        fields: configFields,
        key: k,
        name: metadata.name,
      };
    });
  };
