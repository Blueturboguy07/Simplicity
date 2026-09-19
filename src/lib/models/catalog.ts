import { MinimalProvider } from './types';

/* The model catalog, shaped like Perplexity's picker (2026-07): a flat list
 * of frontier models plus a local option, NOT the raw per-provider API dumps.
 *
 * Those dumps are unusable as a picker: they are unordered and unfiltered, so
 * the first entry — which is what gets selected by default — can be a Whisper
 * transcription model, a TTS voice, or Groq's `llama-prompt-guard`, a safety
 * classifier that cannot hold a conversation at all.
 *
 * Rows use REAL model names (owner decision): the label is what actually
 * answers, not a rebranded SKU. A row appears only when one of its candidate
 * backings is reachable through a connected provider; candidates are listed
 * in preference order — free paths (local Ollama, the user's own Claude
 * plan) before metered API keys.
 */

export type CatalogCandidate = {
  /* Provider `type`, not id — ids are per-connection. */
  providerType: string;
  key: string;
  /* No per-query cost to the user (local model or subscription plan). */
  free?: boolean;
};

export type CatalogRow = {
  id: string;
  name: string;
  badge?: 'New';
  /* Shows the nested "Thinking" toggle when this row is selected. */
  thinking?: boolean;
  /* Provider-type string for the row's logo. */
  icon: string;
  /* Rows below the divider: connected models worth listing that Perplexity's
     picker doesn't carry. */
  extra?: boolean;
  candidates: CatalogCandidate[];
};

export const CATALOG_ROWS: CatalogRow[] = [
  /* publik API tiers. These are aliases, not real model names — the one
     deliberate exception to the rule above, because the alias IS the swap
     seam: the served model can change under it without a release. The
     served slug is a fact about a given answer, not a promise, so it lives
     in the usage line (x-publik-model), not the picker. Only listed when
     the packaged build has provisioned a publik connection. */
  {
    id: 'publik-balanced',
    name: 'Balanced · publik',
    icon: 'publik',
    candidates: [{ providerType: 'publik', key: 'publik-balanced' }],
  },
  {
    id: 'publik-fast',
    name: 'Fast · publik',
    icon: 'publik',
    candidates: [{ providerType: 'publik', key: 'publik-fast' }],
  },
  {
    id: 'publik-smart',
    name: 'Smart · publik',
    icon: 'publik',
    candidates: [{ providerType: 'publik', key: 'publik-smart' }],
  },
  {
    id: 'local',
    name: 'Local (Ollama)',
    icon: 'ollama',
    candidates: [
      { providerType: 'ollama', key: 'qwen2.5:7b', free: true },
      { providerType: 'ollama', key: 'qwen2.5:3b', free: true },
      { providerType: 'ollama', key: 'qwen2.5:14b', free: true },
    ],
  },
  {
    id: 'gpt-5.1',
    name: 'GPT-5.1',
    badge: 'New',
    thinking: true,
    icon: 'openai',
    candidates: [{ providerType: 'openai', key: 'gpt-5.1' }],
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 mini',
    icon: 'openai',
    candidates: [{ providerType: 'openai', key: 'gpt-5-mini' }],
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    icon: 'gemini',
    candidates: [{ providerType: 'gemini', key: 'models/gemini-2.5-pro' }],
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    icon: 'claudecode',
    candidates: [
      { providerType: 'claudecode', key: 'sonnet', free: true },
      { providerType: 'anthropic', key: 'claude-sonnet-5' },
    ],
  },
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    icon: 'claudecode',
    candidates: [
      { providerType: 'claudecode', key: 'opus', free: true },
      { providerType: 'anthropic', key: 'claude-opus-4-8' },
    ],
  },
  {
    id: 'grok-4',
    name: 'Grok 4',
    badge: 'New',
    icon: 'xai',
    candidates: [
      { providerType: 'xai', key: 'grok-4.1' },
      { providerType: 'xai', key: 'grok-4' },
    ],
  },

  /* Connected-but-not-in-Perplexity's-picker: shown under a divider so a
     Groq-only setup still has usable rows. Verified fast + json_schema-safe. */
  {
    id: 'gpt-oss-120b',
    name: 'GPT-OSS 120B',
    icon: 'groq',
    extra: true,
    candidates: [{ providerType: 'groq', key: 'openai/gpt-oss-120b' }],
  },
  {
    id: 'gpt-oss-20b',
    name: 'GPT-OSS 20B',
    icon: 'groq',
    extra: true,
    candidates: [{ providerType: 'groq', key: 'openai/gpt-oss-20b' }],
  },
];

export type ResolvedRow = {
  row: CatalogRow;
  providerId: string;
  key: string;
  free: boolean;
};

/* A row resolves to the first candidate whose provider is connected AND
   actually lists the model. */
export const resolveRow = (
  providers: MinimalProvider[],
  row: CatalogRow,
): ResolvedRow | null => {
  for (const candidate of row.candidates) {
    const provider = providers.find(
      (p) =>
        p.type === candidate.providerType &&
        p.chatModels.some((m) => m.key === candidate.key),
    );
    if (provider) {
      return {
        row,
        providerId: provider.id,
        key: candidate.key,
        free: candidate.free ?? false,
      };
    }
  }
  return null;
};

export const availableRows = (providers: MinimalProvider[]): ResolvedRow[] =>
  CATALOG_ROWS.map((row) => resolveRow(providers, row)).filter(
    (r): r is ResolvedRow => r !== null,
  );

/* The sentinel for automatic selection. */
export const BEST_KEY = '__best__';

/* What "Best" resolves to, in order of preference.
 *
 * Ordered by measured end-to-end latency against answer quality, preferring
 * options that cost the user nothing: their own Claude plan and local models
 * rank above metered APIs at comparable quality. */
/* Exported (beyond resolveBest's own use) so Model Council's auto-pick
   (src/lib/agents/council/select.ts) can rank its distinct-vendor candidates
   by the exact same quality/cost preference order "Best" uses — one source
   of truth for "what's good" instead of a second hand-maintained list. */
export const BEST_ORDER: Array<{ providerType: string; key: string }> = [
  { providerType: 'claudecode', key: 'sonnet' },
  { providerType: 'groq', key: 'openai/gpt-oss-120b' },
  { providerType: 'openai', key: 'gpt-5.1' },
  { providerType: 'openai', key: 'gpt-4o' },
  { providerType: 'anthropic', key: 'claude-sonnet-5' },
  { providerType: 'gemini', key: 'models/gemini-2.5-pro' },
  { providerType: 'xai', key: 'grok-4' },
  /* After every key the user entered themselves (a user-entered key always
     wins), before the local Ollama rows: on the packaged first run only
     publik is connected, so "Best" resolves here. A pasted BYO key moves
     "Best" without touching the publik connection. */
  { providerType: 'publik', key: 'publik-balanced' },
  { providerType: 'ollama', key: 'qwen2.5:7b' },
  { providerType: 'ollama', key: 'qwen2.5:3b' },
];

/* Resolve "Best" against what's connected. Returns null when nothing in the
   preference list is reachable, so the caller can fall back. */
export const resolveBest = (
  providers: MinimalProvider[],
): { providerId: string; key: string } | null => {
  for (const candidate of BEST_ORDER) {
    const provider = providers.find(
      (p) =>
        p.type === candidate.providerType &&
        p.chatModels.some((m) => m.key === candidate.key),
    );
    if (provider) return { providerId: provider.id, key: candidate.key };
  }
  return null;
};

/* The default for a fresh install: whatever "Best" resolves to, else the
   first catalog row available, else — only if the catalog matches nothing —
   the provider's own first model. That last resort is what used to run
   always, and is why a safety classifier could end up answering questions. */
export const pickDefaultModel = (
  providers: MinimalProvider[],
): { providerId: string; key: string } | null => {
  const best = resolveBest(providers);
  if (best) return best;

  const [first] = availableRows(providers);
  if (first) return { providerId: first.providerId, key: first.key };

  const fallback = providers.find((p) => p.chatModels.length > 0);
  return fallback
    ? { providerId: fallback.id, key: fallback.chatModels[0].key }
    : null;
};
