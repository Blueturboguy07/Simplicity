import { ToolCall } from './models/types';
import { UsageBreakdownEntry } from './pricing/meter';

export type SystemMessage = {
  role: 'system';
  content: string;
};

export type AssistantMessage = {
  role: 'assistant';
  content: string;
  tool_calls?: ToolCall[];
};

export type UserMessage = {
  role: 'user';
  content: string;
};

export type ToolMessage = {
  role: 'tool';
  id: string;
  name: string;
  content: string;
};

export type ChatTurnMessage = UserMessage | AssistantMessage;

export type Message =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ToolMessage;

export type Chunk = {
  content: string;
  metadata: Record<string, any>;
};

export type TextBlock = {
  id: string;
  type: 'text';
  data: string;
};

export type SourceBlock = {
  id: string;
  type: 'source';
  data: Chunk[];
};

export type SuggestionBlock = {
  id: string;
  type: 'suggestion';
  data: string[];
};

export type WidgetBlock = {
  id: string;
  type: 'widget';
  data: {
    widgetType: string;
    params: Record<string, any>;
  };
};

export type ReasoningResearchBlock = {
  id: string;
  type: 'reasoning';
  reasoning: string;
};

export type SearchingResearchBlock = {
  id: string;
  type: 'searching';
  searching: string[];
};

export type SearchResultsResearchBlock = {
  id: string;
  type: 'search_results';
  reading: Chunk[];
};

export type ReadingResearchBlock = {
  id: string;
  type: 'reading';
  reading: Chunk[];
};

export type UploadSearchingResearchBlock = {
  id: string;
  type: 'upload_searching';
  queries: string[];
};

export type UploadSearchResultsResearchBlock = {
  id: string;
  type: 'upload_search_results';
  results: Chunk[];
};

export type ResearchBlockSubStep =
  | ReasoningResearchBlock
  | SearchingResearchBlock
  | SearchResultsResearchBlock
  | ReadingResearchBlock
  | UploadSearchingResearchBlock
  | UploadSearchResultsResearchBlock;

export type ResearchBlock = {
  id: string;
  type: 'research';
  data: {
    subSteps: ResearchBlockSubStep[];
  };
};

export type UsageBlock = {
  id: string;
  type: 'usage';
  data: {
    totalCost: number;
    breakdown: UsageBreakdownEntry[];
    free: boolean;
  };
};

/* Model Council (SPEC 2). One core divergence from Perplexity's fixed/opaque
   multi-model mode: retrieval runs ONCE (see CouncilAgent) and every member
   below writes from that identical shared context — members differ only by
   generation model, which is what makes them directly comparable and keeps
   cost at N writer calls instead of N full pipelines. */
export type CouncilMember = {
  /* `${providerId}:${model}` — stable react key + patch target, not a catalog
     row id (a row can resolve to different providerIds across installs). */
  rowId: string;
  name: string;
  providerId: string;
  /* Not in the original spec sketch — added (same precedent as
     UsageBreakdownEntry.providerType in pricing/meter.ts) so the renderer can
     resolve a ProviderLogo without re-deriving provider type from providerId. */
  providerType: string;
  model: string;
  answer: string;
  status: 'pending' | 'streaming' | 'done' | 'error' | 'cancelled';
  error?: string;
  /* Filled in from the shared UsageMeter's breakdown once the turn's usage
     block is computed (matched by providerId+model) — null while running,
     and null-forever when the model is unpriced. */
  cost?: number | null;
  free?: boolean;
  inputTokens?: number;
  outputTokens?: number;
};

export type CouncilBlock = {
  id: string;
  type: 'council';
  data: {
    members: CouncilMember[];
    chairName: string;
    chairProviderType?: string;
    /* The chair's synthesized verdict is ALSO streamed into a normal 'text'
       block (see CouncilAgent) so the existing citation/AnswerTabs pipeline
       renders it — this field just mirrors that text for the council card's
       own bookkeeping/status display, it is not re-rendered as the primary
       answer surface. */
    chairAnswer: string;
    chairStatus: 'pending' | 'streaming' | 'done' | 'skipped' | 'error';
    chairSkippedReason?: string;
    convergence: string[];
    divergence: {
      point: string;
      positions: { model: string; stance: string }[];
    }[];
    unique: { model: string; insight: string }[];
    /* Pre-run rough estimate (prompt tokens x per-model rate + a heuristic
       completion length) so the UI can show cost BEFORE the meter has real
       usage to report — see estimateCouncilCost in agents/council/select.ts. */
    costEstimate?: {
      totalUSD: number | null;
      free: boolean;
      perMember: { rowId: string; usd: number | null; free: boolean }[];
    };
  };
};

/* Client-side only: appended to a turn's blocks when the stream reports an
   error, so the failure stays visible after the toast is gone. Never emitted
   by the server or persisted. */
export type ErrorBlock = {
  id: string;
  type: 'error';
  /* Plain text, or a message with exactly one action link — the publik
     402 ("add credit") shape. Never more than one link. */
  data: string | ErrorBlockData;
};

export type ErrorBlockData = {
  message: string;
  action?: { label: string; href: string };
};

export type Block =
  | TextBlock
  | SourceBlock
  | SuggestionBlock
  | WidgetBlock
  | ResearchBlock
  | UsageBlock
  | CouncilBlock
  | ErrorBlock;
