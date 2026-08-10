import { ResearcherOutput, SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { TextBlock } from '@/lib/types';
import { CONTEXT_TOKEN_BUDGET, budgetChunks } from './contextBudget';
import { getTokenCount } from '@/lib/utils/splitText';

class SearchAgent {
  async searchAsync(session: SessionManager, input: SearchAgentInput) {
    const incognito = input.config.incognito ?? false;

    /* Incognito thread: no row for this message should ever exist, so skip
       the read/insert/update/delete entirely rather than writing then
       deleting. */
    if (!incognito) {
      const exists = await db.query.messages.findFirst({
        where: and(
          eq(messages.chatId, input.chatId),
          eq(messages.messageId, input.messageId),
        ),
      });

      if (!exists) {
        await db.insert(messages).values({
          chatId: input.chatId,
          messageId: input.messageId,
          backendId: session.id,
          query: input.followUp,
          createdAt: new Date().toISOString(),
          status: 'answering',
          responseBlocks: [],
        });
      } else {
        await db
          .delete(messages)
          .where(
            and(eq(messages.chatId, input.chatId), gt(messages.id, exists.id)),
          )
          .execute();
        await db
          .update(messages)
          .set({
            status: 'answering',
            backendId: session.id,
            responseBlocks: [],
          })
          .where(
            and(
              eq(messages.chatId, input.chatId),
              eq(messages.messageId, input.messageId),
            ),
          )
          .execute();
      }
    }

    const classification = await classify({
      chatHistory: input.chatHistory,
      enabledSources: input.config.sources,
      query: input.followUp,
      llm: input.config.utilityLLM ?? input.config.llm,
    });

    const widgetPromise = WidgetExecutor.executeAll({
      classification,
      chatHistory: input.chatHistory,
      followUp: input.followUp,
      llm: input.config.llm,
    }).then((widgetOutputs) => {
      widgetOutputs.forEach((o) => {
        session.emitBlock({
          id: crypto.randomUUID(),
          type: 'widget',
          data: {
            widgetType: o.type,
            params: o.data,
          },
        });
      });
      return widgetOutputs;
    });

    let searchPromise: Promise<ResearcherOutput> | null = null;

    /* Search-first: retrieval runs unless the USER's Writing toggle is on, or
       the classifier flags the turn as a non-search intent (writing task,
       greeting, widget-satisfied). The classifier can narrow WHY we skip, but
       execution itself is deterministic code — no model tool-calls involved. */
    const skipSearch =
      input.config.writingMode || classification.classification.skipSearch;

    if (!skipSearch) {
      const researcher = new Researcher();
      searchPromise = researcher.research(session, {
        chatHistory: input.chatHistory,
        followUp: input.followUp,
        classification: classification,
        config: input.config,
      });
    }

    const [widgetOutputs, searchResults] = await Promise.all([
      widgetPromise,
      searchPromise,
    ]);

    session.emit('data', {
      type: 'researchComplete',
    });

    let finalContext =
      '<Query to be answered without searching; Search not made>';

    if (searchResults) {
      /* Bounded, or Deep Research's 60 extracted pages overflow the model
         context (and the Claude CLI's argv) and the writer dies. */
      finalContext = budgetChunks(
        searchResults.searchFindings,
        CONTEXT_TOKEN_BUDGET[
          input.config.searchMode === 'deepResearch' ? 'deepResearch' : 'search'
        ],
      )
        .map(
          (f, index) =>
            `<result index=${index + 1} title=${f.metadata.title}>${f.content}</result>`,
        )
        .join('\n');
    }

    const widgetContext = widgetOutputs
      .map((o) => {
        return `<result>${o.llmContext}</result>`;
      })
      .join('\n-------------\n');

    const finalContextWithWidgets = `<search_results note="These are the search results and assistant can cite these">\n${finalContext}\n</search_results>\n<widgets_result noteForAssistant="Its output is already showed to the user, assistant can use this information to answer the query but do not CITE this as a souce">\n${widgetContext}\n</widgets_result>`;

    const writerPrompt = getWriterPrompt(
      finalContextWithWidgets,
      input.config.systemInstructions,
      input.config.mode,
      input.config.searchMode,
    );

    const answerStream = input.config.llm.streamText({
      messages: [
        {
          role: 'system',
          content: writerPrompt,
        },
        ...input.chatHistory,
        {
          role: 'user',
          content: input.followUp,
        },
      ],
      options: input.config.reasoningEffort
        ? { reasoningEffort: input.config.reasoningEffort }
        : undefined,
    });

    let responseBlockId = '';
    /* Only ever set on the terminal chunk. 'length' means the model was cut
       off by num_predict/num_ctx (Ollama) or max_completion_tokens (OpenAI),
       not that it actually finished — see OllamaLLM.streamText and
       openaiLLM.ts for where this gets populated. */
    let finishReason: string | undefined;

    for await (const chunk of answerStream) {
      if (input.config.signal?.aborted) break;

      if (chunk.additionalInfo?.finishReason) {
        finishReason = chunk.additionalInfo.finishReason;
      }

      if (!responseBlockId) {
        const block: TextBlock = {
          id: crypto.randomUUID(),
          type: 'text',
          data: chunk.contentChunk,
        };

        session.emitBlock(block);

        responseBlockId = block.id;
      } else {
        const block = session.getBlock(responseBlockId) as TextBlock | null;

        if (!block) {
          continue;
        }

        block.data += chunk.contentChunk;

        session.updateBlock(block.id, [
          {
            op: 'replace',
            path: '/data',
            value: block.data,
          },
        ]);
      }
    }

    /* An empty answer is a failure, not a completion. Without this the turn
       ends "successfully" with a blank Answer tab and the user has no idea
       the writer died — throwing routes it to the error handler, which
       reports it and marks the row status:'error'. */
    const answerBlock = session.getBlock(responseBlockId) as TextBlock | null;
    if (
      !input.config.signal?.aborted &&
      (!answerBlock || answerBlock.data.trim().length === 0)
    ) {
      throw new Error(
        'The model returned an empty answer. Try again, or switch models — if this was Deep research, the gathered context may have exceeded what this model accepts.',
      );
    }

    /* A non-empty answer that stopped because it ran out of room (context
       window or output-token cap, most often hit by small local models)
       still ends this turn "successfully" — there's no error to catch. Left
       alone, that reads as the model simply going silent mid-sentence with
       no explanation, which is exactly what got reported: "what do I do when
       the ai does not respond or gets truncated". Appending a visible notice
       to the same block the user is already reading means it survives page
       reloads and history the same way the answer itself does, unlike a
       toast. */
    if (!input.config.signal?.aborted && finishReason === 'length' && answerBlock) {
      answerBlock.data +=
        '\n\n---\n*Response cut off — this model reached its context or output limit before finishing. Start a new chat, or switch to a model with a larger context window, to get the rest of the answer.*';
      session.updateBlock(answerBlock.id, [
        { op: 'replace', path: '/data', value: answerBlock.data },
      ]);
    }

    if (input.config.usageMeter) {
      const summary = input.config.usageMeter.summarize();
      session.emitBlock({
        id: crypto.randomUUID(),
        type: 'usage',
        data: summary,
      });
    }

    session.emit('end', {});

    if (!incognito) {
      await db
        .update(messages)
        .set({
          status: input.config.signal?.aborted ? 'cancelled' : 'completed',
          responseBlocks: session.getAllBlocks(),
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    }
  }
}

export default SearchAgent;
