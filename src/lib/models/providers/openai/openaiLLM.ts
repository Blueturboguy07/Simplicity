import OpenAI from 'openai';
import BaseLLM from '../../base/llm';
import { zodTextFormat, zodResponseFormat } from 'openai/helpers/zod';
import {
  GenerateObjectInput,
  GenerateOptions,
  GenerateTextInput,
  GenerateTextOutput,
  StreamTextOutput,
  ToolCall,
} from '../../types';
import { parse } from 'partial-json';
import z from 'zod';
import {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from 'openai/resources/index.mjs';
import { Message } from '@/lib/types';
import { repairJson } from '@toolsycc/json-repair';

type OpenAIConfig = {
  apiKey: string;
  model: string;
  baseURL?: string;
  options?: GenerateOptions;
  /* All three optional and unset for the `openai` type; only the publik
     provider supplies them. `onResponse` sees every response's headers
     (the gateway's x-publik-* balance line); `mapError` gets a chance to
     turn an SDK APIError into a typed one (402 → PublikCreditError) before
     it propagates. The wire shape is unchanged either way. */
  defaultHeaders?: Record<string, string>;
  onResponse?: (headers: Headers) => void;
  mapError?: (err: unknown) => unknown;
};

class OpenAILLM extends BaseLLM<OpenAIConfig> {
  openAIClient: OpenAI;

  constructor(protected config: OpenAIConfig) {
    super(config);

    this.openAIClient = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL || 'https://api.openai.com/v1',
      ...(this.config.defaultHeaders
        ? { defaultHeaders: this.config.defaultHeaders }
        : {}),
    });
  }

  /* `.withResponse()` returns the same `data` the code used before plus the
     raw Response, so the hooks cost nothing when unset. */
  private async call<T>(promise: {
    withResponse(): Promise<{ data: T; response: Response }>;
  }): Promise<T> {
    try {
      const { data, response } = await promise.withResponse();
      this.config.onResponse?.(response.headers);
      return data;
    } catch (err) {
      throw this.config.mapError ? this.config.mapError(err) : err;
    }
  }

  convertToOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.id,
          content: msg.content,
        } as ChatCompletionToolMessageParam;
      } else if (msg.role === 'assistant') {
        return {
          role: 'assistant',
          content: msg.content,
          ...(msg.tool_calls &&
            msg.tool_calls.length > 0 && {
              tool_calls: msg.tool_calls?.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              })),
            }),
        } as ChatCompletionAssistantMessageParam;
      }

      return msg;
    });
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const openaiTools: ChatCompletionTool[] = [];

    input.tools?.forEach((tool) => {
      openaiTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.schema),
        },
      });
    });

    const response = await this.call(
      this.openAIClient.chat.completions.create({
        model: this.config.model,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        messages: this.convertToOpenAIMessages(input.messages),
        temperature:
          input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
        top_p: input.options?.topP ?? this.config.options?.topP,
        max_completion_tokens:
          input.options?.maxTokens ?? this.config.options?.maxTokens,
        stop:
          input.options?.stopSequences ?? this.config.options?.stopSequences,
        frequency_penalty:
          input.options?.frequencyPenalty ??
          this.config.options?.frequencyPenalty,
        presence_penalty:
          input.options?.presencePenalty ??
          this.config.options?.presencePenalty,
        ...(input.options?.reasoningEffort
          ? { reasoning_effort: input.options.reasoningEffort }
          : {}),
      }),
    );

    if (response.usage) {
      this.recordUsage({
        inputTokens: response.usage.prompt_tokens ?? 0,
        outputTokens: response.usage.completion_tokens ?? 0,
        cachedInputTokens:
          response.usage.prompt_tokens_details?.cached_tokens ?? 0,
      });
    }

    if (response.choices && response.choices.length > 0) {
      return {
        content: response.choices[0].message.content!,
        toolCalls:
          response.choices[0].message.tool_calls
            ?.map((tc) => {
              if (tc.type === 'function') {
                return {
                  name: tc.function.name,
                  id: tc.id,
                  arguments: JSON.parse(tc.function.arguments),
                };
              }
            })
            .filter((tc) => tc !== undefined) || [],
        additionalInfo: {
          finishReason: response.choices[0].finish_reason,
        },
      };
    }

    throw new Error('No response from OpenAI');
  }

  async *streamText(
    input: GenerateTextInput,
  ): AsyncGenerator<StreamTextOutput> {
    const openaiTools: ChatCompletionTool[] = [];

    input.tools?.forEach((tool) => {
      openaiTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.schema),
        },
      });
    });

    const stream = await this.call(
      this.openAIClient.chat.completions.create({
        model: this.config.model,
        messages: this.convertToOpenAIMessages(input.messages),
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        temperature:
          input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
        top_p: input.options?.topP ?? this.config.options?.topP,
        max_completion_tokens:
          input.options?.maxTokens ?? this.config.options?.maxTokens,
        stop:
          input.options?.stopSequences ?? this.config.options?.stopSequences,
        frequency_penalty:
          input.options?.frequencyPenalty ??
          this.config.options?.frequencyPenalty,
        presence_penalty:
          input.options?.presencePenalty ??
          this.config.options?.presencePenalty,
        ...(input.options?.reasoningEffort
          ? { reasoning_effort: input.options.reasoningEffort }
          : {}),
        stream: true,
        /* Without this the final SSE chunk carries no usage at all and the
         writer's cost silently reports as zero. */
        stream_options: { include_usage: true },
      }),
    );

    let recievedToolCalls: { name: string; id: string; arguments: string }[] =
      [];

    for await (const chunk of stream) {
      if (chunk.choices && chunk.choices.length > 0) {
        const toolCalls = chunk.choices[0].delta.tool_calls;
        yield {
          contentChunk: chunk.choices[0].delta.content || '',
          toolCallChunk:
            toolCalls?.map((tc) => {
              if (!recievedToolCalls[tc.index]) {
                const call = {
                  name: tc.function?.name!,
                  id: tc.id!,
                  arguments: tc.function?.arguments || '',
                };
                recievedToolCalls.push(call);
                return { ...call, arguments: parse(call.arguments || '{}') };
              } else {
                const existingCall = recievedToolCalls[tc.index];
                existingCall.arguments += tc.function?.arguments || '';
                return {
                  ...existingCall,
                  arguments: parse(existingCall.arguments),
                };
              }
            }) || [],
          done: chunk.choices[0].finish_reason !== null,
          additionalInfo: {
            finishReason: chunk.choices[0].finish_reason,
          },
        };
      }

      /* The usage chunk is a separate, final chunk whose `choices` array is
         empty — it yields no content of its own, so this is a sibling branch
         rather than an `else`, not a replacement for the one above. */
      if (chunk.usage) {
        this.recordUsage({
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cachedInputTokens:
            chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        });
      }
    }
  }

  async generateObject<T>(input: GenerateObjectInput): Promise<T> {
    const response = await this.call(
      this.openAIClient.chat.completions.parse({
        messages: this.convertToOpenAIMessages(input.messages),
        model: this.config.model,
        temperature:
          input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
        top_p: input.options?.topP ?? this.config.options?.topP,
        max_completion_tokens:
          input.options?.maxTokens ?? this.config.options?.maxTokens,
        stop:
          input.options?.stopSequences ?? this.config.options?.stopSequences,
        frequency_penalty:
          input.options?.frequencyPenalty ??
          this.config.options?.frequencyPenalty,
        presence_penalty:
          input.options?.presencePenalty ??
          this.config.options?.presencePenalty,
        response_format: zodResponseFormat(input.schema, 'object'),
      }),
    );

    if (response.usage) {
      this.recordUsage({
        inputTokens: response.usage.prompt_tokens ?? 0,
        outputTokens: response.usage.completion_tokens ?? 0,
        cachedInputTokens:
          response.usage.prompt_tokens_details?.cached_tokens ?? 0,
      });
    }

    if (response.choices && response.choices.length > 0) {
      try {
        return input.schema.parse(
          JSON.parse(
            repairJson(response.choices[0].message.content!, {
              extractJson: true,
            }) as string,
          ),
        ) as T;
      } catch (err) {
        throw new Error(`Error parsing response from OpenAI: ${err}`);
      }
    }

    throw new Error('No response from OpenAI');
  }

  /* TODO: usage isn't recorded here. streamObject backs the Responses API
     path (suggestion/media flows), not any call in the priced turn
     (classifier/query-planner/writer all use generateObject/streamText
     above), so it's left unwired for v1 — see SPEC 1 §3.2. If it's ever
     used for a priced call, read `response.usage.input_tokens` /
     `output_tokens` off the `response.completed` chunk. */
  async *streamObject<T>(input: GenerateObjectInput): AsyncGenerator<T> {
    let recievedObj: string = '';

    const stream = this.openAIClient.responses.stream({
      model: this.config.model,
      input: input.messages,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      text: {
        format: zodTextFormat(input.schema, 'object'),
      },
    });

    /* ResponseStream has no withResponse(); errors still get mapped. */
    const mapped = (err: unknown) =>
      this.config.mapError ? this.config.mapError(err) : err;

    try {
      for await (const chunk of stream) {
        if (chunk.type === 'response.output_text.delta' && chunk.delta) {
          recievedObj += chunk.delta;

          try {
            yield parse(recievedObj) as T;
          } catch (err) {
            console.log('Error parsing partial object from OpenAI:', err);
            yield {} as T;
          }
        } else if (chunk.type === 'response.output_text.done' && chunk.text) {
          try {
            yield parse(chunk.text) as T;
          } catch (err) {
            throw new Error(`Error parsing response from OpenAI: ${err}`);
          }
        }
      }
    } catch (err) {
      throw mapped(err);
    }
  }
}

export default OpenAILLM;
