import { z } from 'zod';
import ModelRegistry from '@/lib/models/registry';
import { CATALOG_ROWS, availableRows, ResolvedRow } from '@/lib/models/catalog';
import { ModelWithProvider, MinimalProvider } from '@/lib/models/types';
import SearchAgent from '@/lib/agents/search';
import CouncilAgent from '@/lib/agents/council';
import {
  autoPickCouncil,
  canRunCouncil,
  pickChair,
} from '@/lib/agents/council/select';
import SessionManager from '@/lib/session';
import { ChatTurnMessage } from '@/lib/types';
import { CouncilMemberSpec, SearchSources } from '@/lib/agents/search/types';
import db from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { chats, messages as messagesSchema } from '@/lib/db/schema';
import UploadManager from '@/lib/uploads/manager';
import { UsageMeter, LLMUsage } from '@/lib/pricing/meter';
import { PublikCreditError, PublikRevokedError } from '@/lib/publik/errors';
import { handleKeyRevoked, readState } from '@/lib/publik/provision';
import { PUBLIK_ACCOUNT_URL } from '@/lib/publik/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const messageSchema = z.object({
  messageId: z.string().min(1, 'Message ID is required'),
  chatId: z.string().min(1, 'Chat ID is required'),
  content: z.string().min(1, 'Message content is required'),
});

const chatModelSchema: z.ZodType<ModelWithProvider> = z.object({
  providerId: z.string({ message: 'Chat model provider id must be provided' }),
  key: z.string({ message: 'Chat model key must be provided' }),
});

const embeddingModelSchema: z.ZodType<ModelWithProvider> = z.object({
  providerId: z.string({
    message: 'Embedding model provider id must be provided',
  }),
  key: z.string({ message: 'Embedding model key must be provided' }),
});

const bodySchema = z.object({
  message: messageSchema,
  optimizationMode: z.enum(['speed', 'balanced', 'quality'], {
    message: 'Optimization mode must be one of: speed, balanced, quality',
  }),
  /* Composer's Search/Deep research/Model council pill — orthogonal to
     optimizationMode. Deep research runs its own extended researcher loop
     regardless of which speed/balanced/quality tier is selected; Model
     council (SPEC 2) fans the writer out to up to 3 connected models in
     parallel over one shared search — see CouncilAgent. */
  searchMode: z
    .enum(['search', 'deepResearch', 'council'])
    .optional()
    .default('search'),
  sources: z.array(z.string()).optional().default([]),
  history: z
    .array(z.tuple([z.string(), z.string()]))
    .optional()
    .default([]),
  files: z.array(z.string()).optional().default([]),
  chatModel: chatModelSchema,
  embeddingModel: embeddingModelSchema,
  systemInstructions: z.string().nullable().optional().default(''),
  writingMode: z.boolean().optional().default(false),
  thinking: z.boolean().optional().default(true),
  /* Incognito (privacy positioning): the thread is never written to the
     chats/messages tables — see ensureChatExists guard below and
     SearchAgent.searchAsync's own guard. */
  incognito: z.boolean().optional().default(false),
});

type Body = z.infer<typeof bodySchema>;

const safeValidateBody = (data: unknown) => {
  const result = bodySchema.safeParse(data);

  if (!result.success) {
    return {
      success: false,
      error: result.error.issues.map((e: any) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    };
  }

  return {
    success: true,
    data: result.data,
  };
};

/* The two gateway answers that need more than a message (CONTRACT §1):
     402 → the message plus exactly ONE link, top_up_url
     401 key_revoked → reprovision:true re-mints silently and asks for a
                       retry; reprovision:false says "disconnected" */
const describeError = async (
  err: any,
): Promise<
  string | { message: string; action?: { label: string; href: string } }
> => {
  if (err instanceof PublikCreditError) {
    const state = readState();
    const href = err.topUpUrl ?? state?.claimUrl ?? PUBLIK_ACCOUNT_URL;
    const claimed = state?.claimState === 'claimed';
    return {
      message:
        err.errorType === 'model_requires_claim'
          ? `${err.message} Link this computer to your publik account to use this tier, or pick Balanced or Fast.`
          : claimed
            ? `publik API needs credit. ${err.message} Add credit to keep searching, or use your own key in Settings.`
            : `publik API needs credit. Your free balance is used up. Link this computer to your publik account to add credit, or use your own key in Settings.`,
      action: {
        label: claimed ? 'Add credit' : 'Link this computer',
        href,
      },
    };
  }
  if (err instanceof PublikRevokedError) {
    const result = await handleKeyRevoked(err.reprovision);
    if (result === 'active') {
      return 'publik API reconnected this computer. Ask again to continue.';
    }
    return {
      message:
        'publik API is disconnected. This computer was removed from your publik account. Reconnect it from Settings → Models, or use your own key.',
      action: { label: 'Open publikhq.com', href: PUBLIK_ACCOUNT_URL },
    };
  }
  return err?.message ?? 'That model failed to answer. Try a different one.';
};

/* Pipeline internals (classification, query planning, refinement,
   extraction) run on a cheap local model when one is installed — the
   user-selected model only writes the answer. Falls back to the selected
   model when no local model exists, so this can only reduce cost, never
   capability.

   Returns `{ providerId, key }` alongside the loaded model — not just the
   BaseLLM — so the caller can attribute its usage to the exact Ollama
   provider/model for the cost meter (SPEC 1) instead of guessing. */
const resolveUtilityLLM = async (
  registry: ModelRegistry,
  providers: MinimalProvider[],
  selected: ModelWithProvider,
) => {
  try {
    const ollama = providers.find(
      (p) => p.type === 'ollama' && p.chatModels.length > 0,
    );

    if (!ollama) return null;
    if (ollama.id === selected.providerId) return null;

    const preferred =
      ollama.chatModels.find((m) => /qwen2\.5:(3b|7b)/.test(m.key)) ??
      ollama.chatModels[0];

    const llm = await registry.loadChatModel(ollama.id, preferred.key);
    return { llm, providerId: ollama.id, key: preferred.key };
  } catch {
    return null;
  }
};

/* Friendly name for a council pick (member or chair): prefer the already
   auto-picked rows (avoids a second catalog walk), else fall back to a
   fresh catalog lookup (covers the chair when it isn't one of the members),
   else the bare model key. */
const nameForPick = (
  pickedRows: ResolvedRow[],
  catalogRows: ResolvedRow[],
  pick: { providerId: string; key: string },
): string => {
  const fromPicked = pickedRows.find(
    (r) => r.providerId === pick.providerId && r.key === pick.key,
  );
  if (fromPicked) return fromPicked.row.name;

  const fromCatalog = catalogRows.find(
    (r) => r.providerId === pick.providerId && r.key === pick.key,
  );
  return fromCatalog?.row.name ?? pick.key;
};

const ensureChatExists = async (input: {
  id: string;
  sources: SearchSources[];
  query: string;
  fileIds: string[];
}) => {
  try {
    const exists = await db.query.chats
      .findFirst({
        where: eq(chats.id, input.id),
      })
      .execute();

    if (!exists) {
      await db.insert(chats).values({
        id: input.id,
        createdAt: new Date().toISOString(),
        sources: input.sources,
        title: input.query,
        files: input.fileIds.map((id) => {
          return {
            fileId: id,
            name: UploadManager.getFile(id)?.name || 'Uploaded File',
          };
        }),
      });
    }
  } catch (err) {
    console.error('Failed to check/save chat:', err);
  }
};

export const POST = async (req: Request) => {
  try {
    const reqBody = (await req.json()) as Body;

    const parseBody = safeValidateBody(reqBody);

    if (!parseBody.success) {
      return Response.json(
        { message: 'Invalid request body', error: parseBody.error },
        { status: 400 },
      );
    }

    const body = parseBody.data as Body;
    const { message } = body;

    if (message.content === '') {
      return Response.json(
        {
          message: 'Please provide a message to process',
        },
        { status: 400 },
      );
    }

    const registry = new ModelRegistry();
    const providers = await registry.getActiveProviders();

    const isCouncil = body.searchMode === 'council';

    /* Defensive backstop for a stale client (the composer's mode entry is
       already disabled below this threshold — see ModeSelector.tsx) rather
       than the primary UX guard. A plain non-2xx response here is read by
       useChat.tsx's res.ok check and surfaced as a toast. */
    if (isCouncil && !canRunCouncil(providers)) {
      return Response.json(
        {
          message:
            'Model council needs at least 2 connected models from different providers. Connect another model in Settings.',
        },
        { status: 400 },
      );
    }

    const catalogRows = availableRows(providers);
    const typeOf = (id: string) =>
      providers.find((p) => p.id === id)?.type ?? 'unknown';

    /* Council member/chair picks are resolved up front (pure, synchronous)
       so the model-loading Promise.all below can fan out evenly across both
       modes. */
    const pickedRows = isCouncil ? autoPickCouncil(providers) : [];
    const chairPick = isCouncil
      ? (pickChair(providers) ??
        (pickedRows[0]
          ? { providerId: pickedRows[0].providerId, key: pickedRows[0].key }
          : null))
      : null;

    /* One meter per turn, attached to every LLM instance the turn touches
       (below) so cost aggregates across the classifier, query planner,
       refiner and writer/council members/chair without plumbing usage
       through any return value (SPEC 1). Council mode needs distinct
       "Council: <name>" / "Chair: <name>" labels instead of the plain
       catalog-row name a single-model turn uses (SPEC 2 §5) — resolved here
       rather than in UsageMeter itself, which stays exactly as SPEC 1 left
       it. */
    const usageMeter = new UsageMeter((u: LLMUsage) => {
      if (isCouncil) {
        const member = pickedRows.find(
          (r) => r.providerId === u.providerId && r.key === u.model,
        );
        if (member) return `Council: ${member.row.name}`;

        if (
          chairPick &&
          chairPick.providerId === u.providerId &&
          chairPick.key === u.model
        ) {
          return `Chair: ${nameForPick(pickedRows, catalogRows, chairPick)}`;
        }
      }

      const row = catalogRows.find(
        (r) => r.providerId === u.providerId && r.key === u.model,
      );
      return row?.row.name ?? u.model;
    });

    let llm: Awaited<ReturnType<ModelRegistry['loadChatModel']>>;
    let embedding: Awaited<ReturnType<ModelRegistry['loadEmbeddingModel']>>;
    let utilityLLM: Awaited<ReturnType<typeof resolveUtilityLLM>>;
    let councilMembers: CouncilMemberSpec[] = [];

    if (isCouncil && chairPick) {
      const [memberLLMs, chairLLM, embeddingModel, utility] = await Promise.all(
        [
          Promise.all(
            pickedRows.map((r) => registry.loadChatModel(r.providerId, r.key)),
          ),
          registry.loadChatModel(chairPick.providerId, chairPick.key),
          registry.loadEmbeddingModel(
            body.embeddingModel.providerId,
            body.embeddingModel.key,
          ),
          resolveUtilityLLM(registry, providers, chairPick),
        ],
      );

      councilMembers = pickedRows.map((r, i) => {
        const providerType = typeOf(r.providerId);
        memberLLMs[i].setMeter(usageMeter, {
          providerType,
          providerId: r.providerId,
          model: r.key,
        });
        return {
          providerId: r.providerId,
          key: r.key,
          providerType,
          name: r.row.name,
          llm: memberLLMs[i],
        };
      });

      llm = chairLLM;
      embedding = embeddingModel;
      utilityLLM = utility;
    } else {
      const [chatLLM, embeddingModel, utility] = await Promise.all([
        registry.loadChatModel(body.chatModel.providerId, body.chatModel.key),
        registry.loadEmbeddingModel(
          body.embeddingModel.providerId,
          body.embeddingModel.key,
        ),
        resolveUtilityLLM(registry, providers, body.chatModel),
      ]);

      llm = chatLLM;
      embedding = embeddingModel;
      utilityLLM = utility;
    }

    llm.setMeter(
      usageMeter,
      isCouncil && chairPick
        ? {
            providerType: typeOf(chairPick.providerId),
            providerId: chairPick.providerId,
            model: chairPick.key,
          }
        : {
            providerType: typeOf(body.chatModel.providerId),
            providerId: body.chatModel.providerId,
            model: body.chatModel.key,
          },
    );

    if (utilityLLM) {
      utilityLLM.llm.setMeter(usageMeter, {
        providerType: 'ollama',
        providerId: utilityLLM.providerId,
        model: utilityLLM.key,
      });
    }

    const history: ChatTurnMessage[] = body.history.map((msg) => {
      if (msg[0] === 'human') {
        return {
          role: 'user',
          content: msg[1],
        };
      } else {
        return {
          role: 'assistant',
          content: msg[1],
        };
      }
    });

    const session = SessionManager.createSession();

    const responseStream = new TransformStream();
    const writer = responseStream.writable.getWriter();
    const encoder = new TextEncoder();

    /* Writes race the client disconnect handler closing the writer — a write
       to a closed stream must not throw into the session emitter. */
    const safeWrite = (payload: Record<string, any>) => {
      try {
        writer.write(encoder.encode(JSON.stringify(payload) + '\n'));
      } catch {}
    };

    const safeClose = () => {
      try {
        writer.close();
      } catch {}
    };

    const disconnect = session.subscribe((event: string, data: any) => {
      if (event === 'data') {
        if (data.type === 'block') {
          safeWrite({ type: 'block', block: data.block });
        } else if (data.type === 'updateBlock') {
          safeWrite({
            type: 'updateBlock',
            blockId: data.blockId,
            patch: data.patch,
          });
        } else if (data.type === 'researchComplete') {
          safeWrite({ type: 'researchComplete' });
        }
      } else if (event === 'end') {
        safeWrite({ type: 'messageEnd' });
        safeClose();
        session.removeAllListeners();
      } else if (event === 'error') {
        safeWrite({ type: 'error', data: data.data });
        safeClose();
        session.removeAllListeners();
      }
    });

    const reasoningEffort =
      !isCouncil &&
      body.thinking &&
      CATALOG_ROWS.some(
        (row) =>
          row.thinking &&
          row.candidates.some((c) => c.key === body.chatModel.key),
      )
        ? ('medium' as const)
        : undefined;

    const sharedConfig = {
      llm,
      utilityLLM: utilityLLM?.llm ?? undefined,
      embedding,
      sources: body.sources as SearchSources[],
      mode: body.optimizationMode,
      fileIds: body.files,
      systemInstructions: body.systemInstructions || 'None',
      writingMode: body.writingMode,
      reasoningEffort,
      signal: req.signal,
      usageMeter,
      incognito: body.incognito,
    };

    /* This promise is deliberately not awaited — the response streams while it
       runs. But it must still be caught: an unhandled rejection here (a model
       that rejects the request, an exhausted quota) leaves the writer open
       forever, so the client sees an endless spinner instead of an error. Any
       failure gets reported and the stream closed. Shared between both agents
       — everything past this point (streaming transport, error/DB handling)
       is identical for a council turn and a normal one. */
    const agentPromise =
      isCouncil && chairPick
        ? new CouncilAgent().run(session, {
            chatHistory: history,
            followUp: message.content,
            chatId: body.message.chatId,
            messageId: body.message.messageId,
            config: {
              ...sharedConfig,
              searchMode: 'council',
              members: councilMembers,
              chairName: nameForPick(pickedRows, catalogRows, chairPick),
              chairProviderId: chairPick.providerId,
              chairProviderType: typeOf(chairPick.providerId),
              chairKey: chairPick.key,
            },
          })
        : new SearchAgent().searchAsync(session, {
            chatHistory: history,
            followUp: message.content,
            chatId: body.message.chatId,
            messageId: body.message.messageId,
            config: {
              ...sharedConfig,
              searchMode: body.searchMode,
            },
          });

    agentPromise.catch(async (err: any) => {
      console.error('Search failed:', err);
      safeWrite({
        type: 'error',
        data: await describeError(err),
      });
      safeClose();
      session.removeAllListeners();

      /* Incognito: no row for this thread/message was ever written, so
         there's nothing to mark as errored either. */
      if (body.incognito) return;

      /* Without this the row stays 'answering' forever and the Library
         shows a ghost thread that never finishes. */
      try {
        await db
          .update(messagesSchema)
          .set({ status: 'error', responseBlocks: session.getAllBlocks() })
          .where(
            and(
              eq(messagesSchema.chatId, body.message.chatId),
              eq(messagesSchema.messageId, body.message.messageId),
            ),
          )
          .execute();
      } catch {}
    });

    /* Incognito: the thread must never appear in the Library, so skip
       creating (or touching) its chats row entirely. */
    if (!body.incognito) {
      ensureChatExists({
        id: body.message.chatId,
        sources: body.sources as SearchSources[],
        fileIds: body.files,
        query: body.message.content,
      });
    }

    req.signal.addEventListener('abort', () => {
      disconnect();
      safeClose();
    });

    return new Response(responseStream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  } catch (err) {
    console.error('An error occurred while processing chat request:', err);
    return Response.json(
      { message: 'An error occurred while processing chat request' },
      { status: 500 },
    );
  }
};
