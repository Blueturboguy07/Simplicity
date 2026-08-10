import z from 'zod';
import BaseLLM from '../../base/llm';
import {
  GenerateObjectInput,
  GenerateOptions,
  GenerateTextInput,
  GenerateTextOutput,
  StreamTextOutput,
} from '../../types';
import { Ollama, Tool as OllamaTool, Message as OllamaMessage } from 'ollama';
import { parse } from 'partial-json';
import crypto from 'crypto';
import { Message } from '@/lib/types';
import { repairJson } from '@toolsycc/json-repair';

type OllamaConfig = {
  baseURL: string;
  model: string;
  options?: GenerateOptions;
};

const reasoningModels = [
  'gpt-oss',
  'deepseek-r1',
  'qwen3',
  'deepseek-v3.1',
  'magistral',
  'nemotron-3',
  'nemotron-cascade-2',
  'glm-4.7-flash',
];

class OllamaLLM extends BaseLLM<OllamaConfig> {
  ollamaClient: Ollama;

  constructor(protected config: OllamaConfig) {
    super(config);

    this.ollamaClient = new Ollama({
      host: this.config.baseURL || 'http://localhost:11434',
    });
  }

  convertToOllamaMessages(messages: Message[]): OllamaMessage[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_name: msg.name,
          content: msg.content,
        } as OllamaMessage;
      } else if (msg.role === 'assistant') {
        return {
          role: 'assistant',
          content: msg.content,
          tool_calls:
            msg.tool_calls?.map((tc, i) => ({
              function: {
                index: i,
                name: tc.name,
                arguments: tc.arguments,
              },
            })) || [],
        };
      }

      return msg;
    });
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const ollamaTools: OllamaTool[] = [];

    input.tools?.forEach((tool) => {
      ollamaTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.schema).properties,
        },
      });
    });

    const res = await this.ollamaClient.chat({
      model: this.config.model,
      messages: this.convertToOllamaMessages(input.messages),
      tools: ollamaTools.length > 0 ? ollamaTools : undefined,
      ...(reasoningModels.find((m) => this.config.model.includes(m))
        ? { think: false }
        : {}),
      options: {
        top_p: input.options?.topP ?? this.config.options?.topP,
        temperature:
          input.options?.temperature ?? this.config.options?.temperature ?? 0.7,
        num_predict: input.options?.maxTokens ?? this.config.options?.maxTokens,
        num_ctx: 32000,
        frequency_penalty:
          input.options?.frequencyPenalty ??
          this.config.options?.frequencyPenalty,
        presence_penalty:
          input.options?.presencePenalty ??
          this.config.options?.presencePenalty,
        stop:
          input.options?.stopSequences ?? this.config.options?.stopSequences,
      },
    });

    return {
      content: res.message.content,
      toolCalls:
        res.message.tool_calls?.map((tc) => ({
          id: crypto.randomUUID(),
          name: tc.function.name,
          arguments: tc.function.arguments,
        })) || [],
      additionalInfo: {
        reasoning: res.message.thinking,
        /* 'length' means Ollama stopped because it hit num_predict/num_ctx,
           not because the model was done — the writer pipeline checks this
           field (shared with the OpenAI provider's finish_reason, same
           values) to tell a genuinely finished answer from one that was cut
           off mid-thought. */
        finishReason: res.done_reason,
      },
    };
  }

  async *streamText(
    input: GenerateTextInput,
  ): AsyncGenerator<StreamTextOutput> {
    const ollamaTools: OllamaTool[] = [];

    input.tools?.forEach((tool) => {
      ollamaTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.schema) as any,
        },
      });
    });

    const stream = await this.ollamaClient.chat({
      model: this.config.model,
      messages: this.convertToOllamaMessages(input.messages),
      stream: true,
      ...(reasoningModels.find((m) => this.config.model.includes(m))
        ? { think: false }
        : {}),
      tools: ollamaTools.length > 0 ? ollamaTools : undefined,
      options: {
        top_p: input.options?.topP ?? this.config.options?.topP,
        temperature:
          input.options?.temperature ?? this.config.options?.temperature ?? 0.7,
        num_ctx: 32000,
        num_predict: input.options?.maxTokens ?? this.config.options?.maxTokens,
        frequency_penalty:
          input.options?.frequencyPenalty ??
          this.config.options?.frequencyPenalty,
        presence_penalty:
          input.options?.presencePenalty ??
          this.config.options?.presencePenalty,
        stop:
          input.options?.stopSequences ?? this.config.options?.stopSequences,
      },
    });

    for await (const chunk of stream) {
      yield {
        contentChunk: chunk.message.content,
        toolCallChunk:
          chunk.message.tool_calls?.map((tc, i) => ({
            id: crypto
              .createHash('sha256')
              .update(
                `${i}-${tc.function.name}`,
              ) /* Ollama currently doesn't return a tool call ID so we're creating one based on the index and tool call name */
              .digest('hex'),
            name: tc.function.name,
            arguments: tc.function.arguments,
          })) || [],
        done: chunk.done,
        additionalInfo: {
          reasoning: chunk.message.thinking,
          /* Only meaningful on the final chunk (chunk.done === true); 'length'
             is Ollama's signal that generation was truncated by num_predict
             or num_ctx rather than finishing on its own. Same field name and
             values as the OpenAI provider's finish_reason so callers don't
             need per-provider branches. */
          finishReason: chunk.done ? chunk.done_reason : undefined,
        },
      };
    }
  }

  async generateObject<T>(input: GenerateObjectInput): Promise<T> {
    const response = await this.ollamaClient.chat({
      model: this.config.model,
      messages: this.convertToOllamaMessages(input.messages),
      format: z.toJSONSchema(input.schema),
      ...(reasoningModels.find((m) => this.config.model.includes(m))
        ? { think: false }
        : {}),
      options: {
        top_p: input.options?.topP ?? this.config.options?.topP,
        temperature:
          input.options?.temperature ?? this.config.options?.temperature ?? 0.7,
        num_predict: input.options?.maxTokens ?? this.config.options?.maxTokens,
        frequency_penalty:
          input.options?.frequencyPenalty ??
          this.config.options?.frequencyPenalty,
        presence_penalty:
          input.options?.presencePenalty ??
          this.config.options?.presencePenalty,
        stop:
          input.options?.stopSequences ?? this.config.options?.stopSequences,
      },
    });

    try {
      return input.schema.parse(
        JSON.parse(
          repairJson(response.message.content, {
            extractJson: true,
          }) as string,
        ),
      ) as T;
    } catch (err) {
      throw new Error(`Error parsing response from Ollama: ${err}`);
    }
  }

  async *streamObject<T>(input: GenerateObjectInput): AsyncGenerator<T> {
    let recievedObj: string = '';

    const stream = await this.ollamaClient.chat({
      model: this.config.model,
      messages: this.convertToOllamaMessages(input.messages),
      format: z.toJSONSchema(input.schema),
      stream: true,
      ...(reasoningModels.find((m) => this.config.model.includes(m))
        ? { think: false }
        : {}),
      options: {
        top_p: input.options?.topP ?? this.config.options?.topP,
        temperature:
          input.options?.temperature ?? this.config.options?.temperature ?? 0.7,
        num_predict: input.options?.maxTokens ?? this.config.options?.maxTokens,
        frequency_penalty:
          input.options?.frequencyPenalty ??
          this.config.options?.frequencyPenalty,
        presence_penalty:
          input.options?.presencePenalty ??
          this.config.options?.presencePenalty,
        stop:
          input.options?.stopSequences ?? this.config.options?.stopSequences,
      },
    });

    for await (const chunk of stream) {
      recievedObj += chunk.message.content;

      try {
        yield parse(recievedObj) as T;
      } catch (err) {
        console.log('Error parsing partial object from Ollama:', err);
        yield {} as T;
      }
    }
  }
}

export default OllamaLLM;
