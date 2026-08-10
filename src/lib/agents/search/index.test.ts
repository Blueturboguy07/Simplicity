import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Server-side guard test for incognito (privacy positioning): when
 * config.incognito is set, searchAsync must never touch the chats/messages
 * tables — no read, insert, update or delete. Follows the exact `@/lib/db`
 * mocking pattern already established in council/council.test.ts, so this
 * doesn't need to mock the whole db module from scratch. */

/* writingMode: true (below) already keeps Researcher from ever running, but
 * SearchAgent still imports it unconditionally at module scope, which pulls
 * in the real `@/lib/searxng` -> config/serverRegistry -> ConfigManager
 * singleton. That singleton writes data/config.json on construction, and
 * racing against another test file's worker doing the same non-atomic
 * write is exactly what researcher.test.ts's identical mock avoids. */
const searchMock = vi.fn();
const scraperMock = vi.fn();

vi.mock('@/lib/searxng', () => ({
  searchSearxng: (...args: any[]) => searchMock(...args),
}));

vi.mock('@/lib/scraper', () => ({
  default: {
    scrape: (...args: any[]) => scraperMock(...args),
  },
}));

const dbCalls = {
  findFirst: vi.fn(async (..._args: any[]) => undefined),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

vi.mock('@/lib/db', () => {
  const where = () => ({ execute: vi.fn().mockResolvedValue(undefined) });

  return {
    default: {
      query: {
        messages: {
          findFirst: (...args: any[]) => dbCalls.findFirst(...args),
        },
      },
      insert: (...args: any[]) => {
        dbCalls.insert(...args);
        return { values: vi.fn(async () => {}) };
      },
      update: (...args: any[]) => {
        dbCalls.update(...args);
        return { set: vi.fn(() => ({ where })) };
      },
      delete: (...args: any[]) => {
        dbCalls.delete(...args);
        return { where };
      },
    },
  };
});

import SearchAgent from './index';
import SessionManager from '@/lib/session';
import BaseLLM from '@/lib/models/base/llm';
import BaseEmbedding from '@/lib/models/base/embedding';
import { SearchAgentConfig } from './types';
import { TextBlock } from '@/lib/types';

class FakeEmbedding extends BaseEmbedding<any> {
  async embedText(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0]);
  }
  async embedChunks(chunks: any[]): Promise<number[][]> {
    return chunks.map(() => [1, 0]);
  }
}

/* Doubles as the writer and the utility model backing classify() — the
   classification response has skipSearch: true so Researcher never runs
   (writingMode: true below already guarantees that too), keeping this test
   focused purely on the db guard rather than the retrieval pipeline. */
class FakeLLM extends BaseLLM<any> {
  constructor(
    private chunks: string[],
    private finishReason?: string,
  ) {
    super({});
  }
  async generateText(): Promise<any> {
    return { content: '', toolCalls: [] };
  }
  async *streamText(): AsyncGenerator<any> {
    for (const chunk of this.chunks) {
      yield { contentChunk: chunk, toolCallChunk: [] };
    }
    yield {
      contentChunk: '',
      toolCallChunk: [],
      done: true,
      additionalInfo: this.finishReason
        ? { finishReason: this.finishReason }
        : undefined,
    };
  }
  async generateObject<T>(): Promise<any> {
    return {
      classification: {
        skipSearch: true,
        personalSearch: false,
        academicSearch: false,
        discussionSearch: false,
        showWeatherWidget: false,
        showStockWidget: false,
        showCalculationWidget: false,
      },
      standaloneFollowUp: 'test query',
    };
  }
  async *streamObject<T>(): AsyncGenerator<any> {
    yield {};
  }
}

const makeConfig = (
  over: Partial<SearchAgentConfig> = {},
): SearchAgentConfig => ({
  sources: ['web'],
  fileIds: [],
  llm: new FakeLLM(['Answer text.']),
  embedding: new FakeEmbedding({}) as any,
  mode: 'speed',
  systemInstructions: '',
  writingMode: true,
  ...over,
});

let counter = 0;
const nextIds = () => {
  counter += 1;
  return { chatId: `chat-${counter}`, messageId: `msg-${counter}` };
};

beforeEach(() => {
  dbCalls.findFirst.mockClear();
  dbCalls.insert.mockClear();
  dbCalls.update.mockClear();
  dbCalls.delete.mockClear();
});

describe('SearchAgent incognito guard', () => {
  it('writes the messages row when incognito is not set (baseline)', async () => {
    const config = makeConfig();
    const session = SessionManager.createSession();
    const { chatId, messageId } = nextIds();

    await new SearchAgent().searchAsync(session, {
      chatHistory: [],
      followUp: 'test query',
      chatId,
      messageId,
      config,
    });

    expect(dbCalls.findFirst).toHaveBeenCalled();
    expect(dbCalls.insert).toHaveBeenCalled();
    /* The final status update at the end of the turn. */
    expect(dbCalls.update).toHaveBeenCalled();

    const textBlock = session
      .getAllBlocks()
      .find((b) => b.type === 'text') as TextBlock;
    expect(textBlock?.data).toBe('Answer text.');
  });

  it('never touches the chats/messages tables when incognito is true', async () => {
    const config = makeConfig({ incognito: true });
    const session = SessionManager.createSession();
    const { chatId, messageId } = nextIds();

    await new SearchAgent().searchAsync(session, {
      chatHistory: [],
      followUp: 'test query',
      chatId,
      messageId,
      config,
    });

    expect(dbCalls.findFirst).not.toHaveBeenCalled();
    expect(dbCalls.insert).not.toHaveBeenCalled();
    expect(dbCalls.update).not.toHaveBeenCalled();
    expect(dbCalls.delete).not.toHaveBeenCalled();

    /* The stream itself is unaffected — blocks still flow through
       SessionManager even though nothing was persisted. */
    const textBlock = session
      .getAllBlocks()
      .find((b) => b.type === 'text') as TextBlock;
    expect(textBlock?.data).toBe('Answer text.');
  });
});

describe('SearchAgent truncation notice', () => {
  it('appends a visible cut-off notice when the model stops on finishReason "length"', async () => {
    const config = makeConfig({
      llm: new FakeLLM(['Partial answer, still going'], 'length'),
    });
    const session = SessionManager.createSession();
    const { chatId, messageId } = nextIds();

    await new SearchAgent().searchAsync(session, {
      chatHistory: [],
      followUp: 'test query',
      chatId,
      messageId,
      config,
    });

    const textBlock = session
      .getAllBlocks()
      .find((b) => b.type === 'text') as TextBlock;
    expect(textBlock?.data).toContain('Partial answer, still going');
    expect(textBlock?.data).toContain('Response cut off');
    expect(textBlock?.data).toContain('larger context window');
  });

  it('adds no notice when the model finishes normally (finishReason "stop")', async () => {
    const config = makeConfig({
      llm: new FakeLLM(['Complete answer.'], 'stop'),
    });
    const session = SessionManager.createSession();
    const { chatId, messageId } = nextIds();

    await new SearchAgent().searchAsync(session, {
      chatHistory: [],
      followUp: 'test query',
      chatId,
      messageId,
      config,
    });

    const textBlock = session
      .getAllBlocks()
      .find((b) => b.type === 'text') as TextBlock;
    expect(textBlock?.data).toBe('Complete answer.');
  });

  it('adds no notice when the provider never reports a finishReason at all (baseline FakeLLM)', async () => {
    const config = makeConfig({ llm: new FakeLLM(['Answer text.']) });
    const session = SessionManager.createSession();
    const { chatId, messageId } = nextIds();

    await new SearchAgent().searchAsync(session, {
      chatHistory: [],
      followUp: 'test query',
      chatId,
      messageId,
      config,
    });

    const textBlock = session
      .getAllBlocks()
      .find((b) => b.type === 'text') as TextBlock;
    expect(textBlock?.data).toBe('Answer text.');
  });
});
