import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import OpenAILLM from './openaiLLM';
import { mapPublikError, PublikCreditError } from '@/lib/publik/errors';

/* The two optional hooks on OpenAILLM, exercised against a fake client so
   no network is touched: `onResponse` sees the response headers of a
   non-stream call, `mapError` turns a 402 APIError into PublikCreditError,
   and with neither set the `openai` type behaves exactly as before. */

const fakeCompletion = {
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  choices: [
    { message: { content: 'hi', tool_calls: [] }, finish_reason: 'stop' },
  ],
};

const apiPromise = (data: any, headers: Record<string, string> = {}) => ({
  withResponse: async () => ({
    data,
    response: new Response(null, { headers }),
  }),
});

const rejecting = (err: unknown) => ({
  withResponse: async () => {
    throw err;
  },
});

const input = { messages: [{ role: 'user' as const, content: 'hi' }] } as any;

describe('OpenAILLM hooks', () => {
  it('invokes onResponse with the response headers on a non-stream call', async () => {
    const onResponse = vi.fn();
    const llm = new OpenAILLM({
      apiKey: 'k',
      model: 'publik-balanced',
      baseURL: 'https://publikhq.com/api/v1',
      onResponse,
    });
    (llm.openAIClient.chat.completions as any).create = () =>
      apiPromise(fakeCompletion, { 'x-publik-balance': '181240' });

    const out = await llm.generateText(input);
    expect(out.content).toBe('hi');
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0][0].get('x-publik-balance')).toBe('181240');
  });

  it('maps a 402 APIError through mapError into PublikCreditError with the top-up link', async () => {
    const llm = new OpenAILLM({
      apiKey: 'k',
      model: 'publik-balanced',
      baseURL: 'https://publikhq.com/api/v1',
      mapError: mapPublikError,
    });
    const err = new OpenAI.APIError(
      402,
      {
        type: 'insufficient_credit',
        message: 'Not enough publik credit for this request.',
        top_up_url: 'https://publikhq.com/claim/HK7F-2QWD',
      },
      undefined,
      new Headers(),
    );
    (llm.openAIClient.chat.completions as any).create = () => rejecting(err);

    await expect(llm.generateText(input)).rejects.toBeInstanceOf(
      PublikCreditError,
    );
    await expect(llm.generateText(input)).rejects.toMatchObject({
      topUpUrl: 'https://publikhq.com/claim/HK7F-2QWD',
    });
  });

  it('passes a 429 / 500 through unchanged', async () => {
    const llm = new OpenAILLM({
      apiKey: 'k',
      model: 'publik-balanced',
      mapError: mapPublikError,
    });
    const err = new OpenAI.APIError(
      429,
      { type: 'rate_limit_exceeded' },
      undefined,
      new Headers(),
    );
    (llm.openAIClient.chat.completions as any).create = () => rejecting(err);
    await expect(llm.generateText(input)).rejects.toBe(err);
  });

  it('without hooks, the openai type behaves as before (data through, error untouched)', async () => {
    const llm = new OpenAILLM({ apiKey: 'k', model: 'gpt-5.1' });
    (llm.openAIClient.chat.completions as any).create = () =>
      apiPromise(fakeCompletion);
    expect((await llm.generateText(input)).content).toBe('hi');

    const boom = new Error('boom');
    (llm.openAIClient.chat.completions as any).create = () => rejecting(boom);
    await expect(llm.generateText(input)).rejects.toBe(boom);
    expect(llm.openAIClient.baseURL).toBe('https://api.openai.com/v1');
  });
});
